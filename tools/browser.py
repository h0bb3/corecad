"""A headless Chrome driven over the DevTools protocol: for the tests, for
screenshots, and for scripts that use the page the way a person would.
Standard library only (there is no Node on the machine this grew up on).

    from browser import Browser
    with Browser(size=(1400, 900)) as b:
        p = b.page
        p.goto('index.html')
        p.wait('window.corecadReady')
        p.click(400, 300)
        p.screenshot('out.png')

Several of these can run at the same time: each takes a free port for its
server, lets Chrome choose its own debugging port, and claims a profile
folder of its own from a small pool (so the browser cache is kept between
runs, which matters for the 6 MB geometry kernel).

Set CHROME to the browser to use if it is not in a usual place.
"""
import base64, ctypes, json, os, select, socket, struct, subprocess, sys, tempfile, threading, time, urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POOL = Path(tempfile.gettempdir()) / 'corecad-chrome'
CANDIDATES = [
    os.environ.get('CHROME', ''),
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]


def chrome_path():
    for c in CANDIDATES:
        if c and Path(c).exists():
            return c
    raise RuntimeError('Chrome not found: set the CHROME environment variable')


class Quiet(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.html': 'text/html'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        if self.path == '/favicon.ico':     # nobody has one, and a 404 would count as an error of the page
            self.send_response(204)
            self.end_headers()
            return
        super().do_GET()

    def log_message(self, *a):
        pass


class Server(ThreadingHTTPServer):
    # A page asks for some fifty modules at once; the usual queue of five waiting connections refuses some.
    request_queue_size = 128
    daemon_threads = True


def alive(pid):
    if os.name == 'nt':
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if h:
            ctypes.windll.kernel32.CloseHandle(h)
        return bool(h)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def claim_profile():
    """A profile folder nobody else is using, and the lock that says so."""
    POOL.mkdir(parents=True, exist_ok=True)
    for attempt in range(2):
        for i in range(32):
            d = POOL / f'p{i}'
            d.mkdir(exist_ok=True)
            lock = d / 'corecad.lock'
            try:
                fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                return d, lock
            except FileExistsError:
                try:
                    if not alive(int(lock.read_text() or 0)):
                        lock.unlink()
                except (OSError, ValueError):
                    pass
    raise RuntimeError('no free browser profile')


class Socket:
    """Just enough WebSocket to talk to Chrome."""

    def __init__(self, url):
        host, rest = url[5:].split('/', 1)
        name, port = host.split(':')
        self.s = socket.create_connection((name, int(port)))
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f'GET /{rest} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                        f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            buf += self.s.recv(4096)
        assert b' 101 ' in buf.split(b'\r\n')[0], buf
        self.rest = buf.split(b'\r\n\r\n', 1)[1]

    def pending(self):
        return bool(self.rest) or bool(select.select([self.s], [], [], 0)[0])

    def read(self, n):
        while len(self.rest) < n:
            chunk = self.s.recv(1 << 20)
            if not chunk:
                raise ConnectionError('the browser closed the connection')
            self.rest += chunk
        out, self.rest = self.rest[:n], self.rest[n:]
        return out

    def send(self, text, op=1):
        data = text.encode() if isinstance(text, str) else text
        mask, n = os.urandom(4), len(data)
        if n < 126:
            head = bytes([0x80 | op, 0x80 | n])
        elif n < 65536:
            head = bytes([0x80 | op, 0x80 | 126]) + struct.pack('>H', n)
        else:
            head = bytes([0x80 | op, 0x80 | 127]) + struct.pack('>Q', n)
        body = bytearray(data)
        for i in range(n):
            body[i] ^= mask[i & 3]
        self.s.sendall(head + mask + bytes(body))

    def recv(self):
        whole = b''
        while True:
            a, b = self.read(2)
            n = b & 127
            if n == 126:
                n = struct.unpack('>H', self.read(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', self.read(8))[0]
            data = self.read(n)
            op = a & 15
            if op == 9:
                self.send(data, 10)
                continue
            if op == 8:
                raise ConnectionError('the browser closed the connection')
            whole += data
            if a & 0x80:
                return whole.decode('utf-8', 'replace')


class JsError(RuntimeError):
    pass


class Page:
    """One tab. Coordinates are CSS pixels from the top left of the page."""

    def __init__(self, ws, base):
        self.ws, self.base, self.n = ws, base, 0
        self.console = []          # (kind, text): console calls, uncaught exceptions, failed requests
        self.x = self.y = 0
        for domain in ('Runtime', 'Page', 'Log', 'Network'):
            self.call(f'{domain}.enable')

    # ---- protocol
    def _event(self, m):
        method, p = m.get('method'), m.get('params', {})
        if method == 'Runtime.consoleAPICalled':
            text = ' '.join(str(a.get('value', a.get('description', a.get('type')))) for a in p.get('args', []))
            self.console.append((p.get('type', 'log'), text))
        elif method == 'Runtime.exceptionThrown':
            d = p.get('exceptionDetails', {})
            self.console.append(('exception', d.get('exception', {}).get('description') or d.get('text', '?')))
        elif method == 'Log.entryAdded':
            e = p.get('entry', {})
            if e.get('level') in ('error', 'warning'):
                self.console.append((e.get('level'), f"{e.get('text', '')} {e.get('url', '')}".strip()))
        elif method == 'Network.loadingFailed' and not p.get('canceled'):
            self.console.append(('network', f"{p.get('errorText', 'failed')} ({p.get('type', '')})"))

    def call(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({'id': self.n, 'method': method, 'params': params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get('id') == self.n:
                if 'error' in m:
                    raise RuntimeError(f'{method}: {m["error"]}')
                return m['result']
            self._event(m)

    def pump(self):
        """Take in whatever the browser has said in the meantime."""
        while self.ws.pending():
            self._event(json.loads(self.ws.recv()))

    def errors(self):
        self.pump()
        return [f'{k}: {t}' for k, t in self.console if k in ('error', 'exception', 'network', 'assert')]

    # ---- the page
    def url(self, path):
        # An address of its own, or a path of the project (which may carry an address in its query).
        return path if path.split('?')[0].split('#')[0].count('://') else f'{self.base}/{path.lstrip("/")}'

    def goto(self, path, timeout=30):
        url = self.url(path)
        if not url.startswith(self.base):
            # A site somewhere else (the published one): the profile's cache may hold files from a run a few
            # minutes ago that the site still lets a browser reuse. Test what is published now.
            self.call('Network.enable')
            self.call('Network.setCacheDisabled', cacheDisabled=True)
        self.call('Page.navigate', url=url)
        end = time.time() + timeout
        while time.time() < end:
            try:
                if self.js("document.readyState") == 'complete':
                    return
            except (RuntimeError, JsError):
                pass
            time.sleep(0.05)
        raise TimeoutError(f'{path} did not finish loading')

    def js(self, expression, wait=True):
        """The value of a JavaScript expression in the page (a promise is awaited)."""
        r = self.call('Runtime.evaluate', expression=expression, awaitPromise=wait, returnByValue=True, userGesture=True)
        if 'exceptionDetails' in r:
            d = r['exceptionDetails']
            raise JsError(d.get('exception', {}).get('description') or d.get('text', str(d)))
        return r['result'].get('value')

    def wait(self, expression, timeout=30, poll=0.1):
        """Waits until the expression is truthy, and returns its value."""
        end = time.time() + timeout
        while True:
            try:
                v = self.js(expression)
                if v:
                    return v
            except JsError:
                pass
            if time.time() > end:
                tail = '\n  '.join(f'{k}: {t}' for k, t in self.console[-12:])
                raise TimeoutError(f'waited {timeout} s for: {expression}\n  {tail}')
            self.pump()
            time.sleep(poll)

    def screenshot(self, path, clip=None):
        """A PNG of the page (or of clip = (x, y, width, height))."""
        more = {'clip': dict(zip(('x', 'y', 'width', 'height'), clip), scale=1)} if clip else {}
        data = self.call('Page.captureScreenshot', format='png', **more)['data']
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(base64.b64decode(data))
        return str(path)

    def rect(self, selector):
        """(x, y, width, height) of the first element that matches."""
        r = self.js(f'(() => {{ const e = document.querySelector({json.dumps(selector)}); if (!e) return null;'
                    ' const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()')
        if not r:
            raise JsError(f'no element matches {selector}')
        return tuple(r)

    def centre(self, selector):
        x, y, w, h = self.rect(selector)
        return x + w / 2, y + h / 2

    # ---- the mouse and the keys: real, trusted events
    def _mouse(self, kind, **more):
        self.call('Input.dispatchMouseEvent', type=kind, x=self.x, y=self.y, **more)

    def move(self, x, y, steps=1, buttons=0, modifiers=0):
        x0, y0 = self.x, self.y
        for i in range(1, steps + 1):
            self.x, self.y = x0 + (x - x0) * i / steps, y0 + (y - y0) * i / steps
            self._mouse('mouseMoved', buttons=buttons, modifiers=modifiers,
                        **({'button': {1: 'left', 2: 'right', 4: 'middle'}.get(buttons, 'none')} if buttons else {}))

    def down(self, button='left', modifiers=0, count=1):
        self._mouse('mousePressed', button=button, buttons={'left': 1, 'right': 2, 'middle': 4}[button],
                    clickCount=count, modifiers=modifiers)

    def up(self, button='left', modifiers=0, count=1):
        self._mouse('mouseReleased', button=button, clickCount=count, modifiers=modifiers)

    def click(self, x, y=None, button='left', modifiers=0, count=1):
        """Clicks a point, or the middle of the element a selector names."""
        if isinstance(x, str):
            x, y = self.centre(x)
        self.move(x, y, modifiers=modifiers)
        for c in range(1, count + 1):
            self.down(button, modifiers, c)
            self.up(button, modifiers, c)

    def drag(self, x0, y0, x1, y1, steps=12, button='left', modifiers=0):
        self.move(x0, y0, modifiers=modifiers)
        self.down(button, modifiers)
        self.move(x1, y1, steps=steps, buttons={'left': 1, 'right': 2, 'middle': 4}[button], modifiers=modifiers)
        self.up(button, modifiers)

    def wheel(self, x, y, delta_y, modifiers=0):
        self.move(x, y)
        self._mouse('mouseWheel', deltaX=0, deltaY=delta_y, modifiers=modifiers)

    def key(self, key, modifiers=0):
        """One key: a character ('a', '5'), or a name (Enter, Escape, Delete, Backspace, Tab, ArrowLeft …).
        Modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift (add them up)."""
        names = {'Enter': 13, 'Escape': 27, 'Delete': 46, 'Backspace': 8, 'Tab': 9, ' ': 32,
                 'ArrowLeft': 37, 'ArrowUp': 38, 'ArrowRight': 39, 'ArrowDown': 40, 'Shift': 16, 'Control': 17}
        code = names.get(key, ord(key.upper()) if len(key) == 1 else 0)
        text = {'Enter': '\r', ' ': ' '}.get(key, key if len(key) == 1 else None)
        more = {'key': key, 'windowsVirtualKeyCode': code, 'nativeVirtualKeyCode': code, 'modifiers': modifiers,
                'code': ('Key' + key.upper() if key.isalpha() else 'Digit' + key if key.isdigit() else key) if len(key) == 1 else key}
        if text and not modifiers & 6:
            self.call('Input.dispatchKeyEvent', type='keyDown', text=text, unmodifiedText=text, **more)
        else:
            self.call('Input.dispatchKeyEvent', type='rawKeyDown', **more)
        self.call('Input.dispatchKeyEvent', type='keyUp', **more)

    def type(self, text):
        """Types into whatever has the focus."""
        self.call('Input.insertText', text=text)


class Browser:
    """A server for the project folder and a headless Chrome looking at it."""

    def __init__(self, root=ROOT, size=(1280, 800), scale=1, dark=False):
        self.root, self.size, self.scale, self.dark = Path(root), size, scale, dark
        self.server = self.chrome = self.lock = self.page = None

    def __enter__(self):
        self.server = Server(('127.0.0.1', 0), partial(Quiet, directory=str(self.root)))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        profile, self.lock = claim_profile()
        port_file = profile / 'DevToolsActivePort'
        port_file.unlink(missing_ok=True)
        w, h = self.size
        self.chrome = subprocess.Popen(
            [chrome_path(), '--headless=new', '--remote-debugging-port=0', f'--user-data-dir={profile}',
             f'--window-size={w},{h}', '--hide-scrollbars', '--no-first-run', '--mute-audio', '--disable-extensions',
             '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            end = time.time() + 30
            port = None
            while port is None:
                try:    # Chrome may be in the middle of writing the file
                    port = int(port_file.read_text().split()[0])
                except (OSError, IndexError, ValueError):
                    if time.time() > end:
                        raise TimeoutError('Chrome did not start')
                    time.sleep(0.1)
            tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json'))
            tab = next(t for t in tabs if t['type'] == 'page')
            self.page = Page(Socket(tab['webSocketDebuggerUrl']), f'http://127.0.0.1:{self.server.server_address[1]}')
            self.page.call('Emulation.setDeviceMetricsOverride', width=w, height=h, deviceScaleFactor=self.scale, mobile=False)
            if self.dark:
                self.page.call('Emulation.setEmulatedMedia', features=[{'name': 'prefers-color-scheme', 'value': 'dark'}])
            self.page.call('Browser.setDownloadBehavior', behavior='deny')
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def __exit__(self, *exc):
        if self.chrome:
            if os.name == 'nt':
                subprocess.run(['taskkill', '/F', '/T', '/PID', str(self.chrome.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                self.chrome.terminate()
            try:
                self.chrome.wait(10)
            except subprocess.TimeoutExpired:
                self.chrome.kill()
        if self.server:
            self.server.shutdown()
        if self.lock:
            for _ in range(20):
                try:
                    self.lock.unlink(missing_ok=True)
                    break
                except OSError:
                    time.sleep(0.1)
        return False

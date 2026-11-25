"""The whole chain: an MCP client -> the bridge relay (bridge/server.js, Node) -> a CoreCAD tab -> the kernel.

Run with: python tools/e2e_bridge.py. It starts the relay on a free port, opens the page
with ?bridge= pointing at it, connects through the page's own Connect dialog, and then
speaks MCP over HTTP to the address the dialog shows, the way Claude's connector does.

Needs Node (the relay): on the PATH, or its path in the NODE environment variable.
With --port N it uses a relay that is already listening on 127.0.0.1:N instead (it must
allow pages on localhost). With --live it uses the public page and the public relay:
the deployed chain, through whatever stands in front of it.
"""
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from browser import Browser, ROOT  # noqa: E402



def node_path():
    for c in (os.environ.get('NODE'), shutil.which('node')):
        if c and Path(c).exists():
            return c
    return None


class Mcp:
    """Just enough of an MCP client over Streamable HTTP: JSON-RPC by POST, answers as JSON or as an event stream."""

    def __init__(self, address):
        self.address, self.n = address, 0

    def post(self, message):
        req = urllib.request.Request(self.address, data=json.dumps(message).encode(), method='POST', headers={
            'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
            'User-Agent': 'corecad-e2e/1'})   # a front such as Cloudflare refuses Python's default one
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                body, kind, status = r.read().decode(), r.headers.get('Content-Type', ''), r.status
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode() or 'null')
        if not body:
            return status, None
        if 'text/event-stream' in kind:
            data = [line[5:].strip() for line in body.splitlines() if line.startswith('data:')]
            return status, json.loads(data[-1])
        return status, json.loads(body)

    def request(self, method, params=None):
        self.n += 1
        status, answer = self.post({'jsonrpc': '2.0', 'id': self.n, 'method': method, **({'params': params} if params is not None else {})})
        assert status == 200 and answer.get('id') == self.n, (status, answer)
        assert 'error' not in answer, answer
        return answer['result']

    def start(self):
        hello = self.request('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'e2e', 'version': '1'}})
        status, _ = self.post({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        assert status == 202, status
        return hello

    def call(self, name, **arguments):
        return self.request('tools/call', {'name': name, 'arguments': arguments})


LIVE_PAGE = 'https://h0bb3.github.io/corecad/?test=1&connect'
LIVE_PREFIX = 'https://vibedit.app/CoreCAD/mcp/'


def run(p, relay_port=None):
    """relay_port: a relay on this machine; None: the public page and relay."""
    def step(text):
        print('PASS ' + text)

    def ok(result):
        assert not result.get('isError'), result
        return json.loads(result['content'][-1]['text'])

    local = relay_port is not None
    page = f'index.html?test=1&bridge=ws://127.0.0.1:{relay_port}/CoreCAD/ws' if local else LIVE_PAGE
    prefix = f'http://127.0.0.1:{relay_port}/CoreCAD/mcp/' if local else LIVE_PREFIX
    p.goto(page)
    p.wait('window.corecadReady && window.corecad && !corecad.busy', timeout=120)
    if p.js('corecad.bridge.status') != 'off':      # left on by an earlier run in this browser profile
        p.js('document.getElementById("connect-button").click()')
        p.wait('!!document.querySelector("[data-modal=toggle]")')
        p.click('[data-modal="toggle"]')
        p.wait('corecad.bridge.status === "off"')
        p.click('[data-modal="close"]')
    p.js('corecad.run("new_document", {})')
    assert p.js('corecad.bridge.status') == 'off', 'nothing connects until the person says so'

    # ---- the person connects through the dialog
    p.click('#connect-button')
    p.wait('!!document.getElementById("bridge-address")')
    assert 'Not connected' in p.js('document.getElementById("bridge-status").textContent')
    p.click('[data-modal="toggle"]')
    p.wait('corecad.bridge.status === "on"', timeout=20)
    address = p.js('document.getElementById("bridge-address").value')
    assert address.startswith(prefix) and len(address.rsplit('/', 1)[1]) == 24, address
    assert p.js('document.getElementById("connect-button").textContent.trim()') == 'Connected'
    assert all(p.js('[...document.querySelectorAll("#modal-root button, #modal-root input")].map(e => !!e.title)')), 'every control explains itself'
    step('Connect dialog: connected, address shown')

    # ---- an MCP client with that address
    mcp = Mcp(address)
    hello = mcp.start()
    assert hello['serverInfo']['name'] == 'corecad' and 'get_state' in hello['instructions'], hello
    tools = mcp.request('tools/list')['tools']
    names = [t['name'] for t in tools]
    assert names[0] == 'corecad_status' and {'get_state', 'add_sketch', 'extrude', 'fillet', 'screenshot', 'add_part', 'combine', 'move_part'} <= set(names) and not {'add_box', 'hole'} & set(names) and len(names) == 1 + p.js('corecad.tools.length'), names
    assert all(t['inputSchema']['type'] == 'object' and len(t['description']) > 20 for t in tools)
    step('initialize and tools/list: %d tools' % len(names))

    assert ok(mcp.call('add_part'))['part']['kind'] == 'empty'
    assert ok(mcp.call('add_sketch', plane='XY'))['sketch']['entities'] == []
    s = ok(mcp.call('add_to_sketch', shapes=[{'type': 'rectangle', 'corner': [0, 0], 'width': 60, 'height': 40}]))
    assert s['sketch']['degrees_of_freedom'] == 0
    r = ok(mcp.call('extrude', distance=10))
    assert abs(r['bodies'][0]['volume'] - 24000) < 0.01, r
    ok(mcp.call('add_sketch', plane='top'))
    ok(mcp.call('add_to_sketch', shapes=[{'type': 'circle', 'center': [20, 20], 'diameter': 8}]))
    ok(mcp.call('extrude', operation='cut', through_all=True))
    r = ok(mcp.call('fillet', edges={'parallel': 'z'}, radius=4))
    assert abs(r['bodies'][0]['volume'] - 23360) < 0.01, r
    assert p.js('document.getElementById("metrics").textContent').startswith('1 body'), 'the person sees it'
    step('a plate with a hole and four fillets, built over MCP: 23,360 mm3')

    bad = mcp.call('fillet', edges={'parallel': 'z'}, radius=500)
    assert bad['isError'] and 'cannot be built' in bad['content'][0]['text'], bad
    assert abs(ok(mcp.call('get_state'))['bodies'][0]['volume'] - 23360) < 0.01
    wrong = mcp.call('extrude', distanse=3)
    assert wrong['isError'] and 'no argument "distanse"' in wrong['content'][0]['text'], wrong
    gone = mcp.call('add_box', size=[1, 2, 3])
    assert gone['isError'] and 'has no tool "add_box"' in gone['content'][0]['text'], 'a client that still holds an older list of tools is told that the tool is not there: %s' % gone
    shot = mcp.call('screenshot', max=600)
    assert shot['content'][0]['type'] == 'image' and shot['content'][0]['mimeType'] == 'image/png'
    png = base64.b64decode(shot['content'][0]['data'])
    assert png[:8] == b'\x89PNG\r\n\x1a\n' and json.loads(shot['content'][1]['text'])['width'] <= 600
    (ROOT / '.scratch').mkdir(exist_ok=True)
    (ROOT / '.scratch' / 'e2e_bridge.png').write_bytes(png)
    step('refusals come back as errors, a screenshot as a picture')
    assert 'Last command: screenshot' in p.js('document.getElementById("bridge-status").textContent'), 'the dialog shows what was asked'

    # ---- "this": the client is told what the person clicked, and can use it
    import math
    import time
    p.click('[data-modal="close"]')
    p.click(*p.js('corecad.screen([45, 20, 10])'))
    sel = ok(mcp.call('get_selection'))
    face = sel['selected'][0]
    assert face['side'] == 'top' and abs(face['at'][0] - 45) < .5 and abs(face['at'][1] - 20) < .5 and face['made_by'][0]['type'] == 'extrude', face
    ok(mcp.call('add_sketch', plane='this'))
    ok(mcp.call('add_to_sketch', shapes=[{'type': 'circle', 'center': face['at'], 'diameter': 3}]))
    r = ok(mcp.call('extrude', operation='cut', distance=4))
    assert abs(r['bodies'][0]['volume'] - (23360 - math.pi * 2.25 * 4)) < 0.01, r
    time.sleep(.45)
    assert p.js('corecad.pointed && corecad.pointed.type') in ('face', 'edge'), 'the mouse rests on the new hole: that is what it points at now'
    p.screenshot(ROOT / '.scratch' / 'e2e_bridge_pointing.png')
    deeper = ok(mcp.call('edit_feature', id='pointed', distance=6))
    assert deeper['type'] == 'extrude' and abs(deeper['bodies'][0]['volume'] - (23360 - math.pi * 2.25 * 6)) < 0.01, deeper
    ok(mcp.call('undo'))
    assert abs(ok(mcp.call('undo'))['bodies'][0]['volume'] - 23360) < 0.01, 'both are undo steps'
    p.click('#connect-button')
    p.wait('!!document.getElementById("bridge-address")')
    step('"a hole here" over MCP: a circle on the face that was clicked, where it was clicked, cut; then "this hole" deeper, by pointing at it')

    # ---- the agent reloads the tab itself
    volume_before = ok(mcp.call('get_state'))['bodies'][0]['volume']
    p.js('window.__old = true')
    out = ok(mcp.call('reload_app'))
    assert out['reloading'] is True and out['was'] == p.js('corecad.version'), out
    p.wait('!window.__old && window.corecadReady && window.corecad && corecad.bridge.status === "on" && !corecad.busy', timeout=120)
    assert p.js('corecad.bridge.address') == address, 'the same address after the reload'
    assert abs(ok(mcp.call('get_state'))['bodies'][0]['volume'] - volume_before) < 1e-9
    assert [t['name'] for t in mcp.request('tools/list')['tools']] == names
    p.click('#connect-button')
    p.wait('!!document.getElementById("bridge-address")')
    step('reload_app over MCP: the tab comes back by itself, connected, with its project')

    # ---- the person is in charge: disconnect, a new address
    p.click('[data-modal="toggle"]')
    p.wait('corecad.bridge.status === "off"')
    gone = mcp.call('get_state')
    assert gone['isError'] and 'No CoreCAD tab is connected' in gone['content'][0]['text'], gone
    assert 'No CoreCAD tab' in mcp.call('corecad_status')['content'][0]['text']
    p.click('[data-modal="toggle"]')
    p.wait('corecad.bridge.status === "on"', timeout=20)
    assert abs(ok(mcp.call('get_state'))['bodies'][0]['volume'] - 23360) < 0.01
    p.click('[data-modal="renew"]')
    p.wait(f'corecad.bridge.status === "on" && corecad.bridge.address !== {json.dumps(address)}', timeout=20)
    fresh = p.js('corecad.bridge.address')
    assert mcp.call('get_state')['isError'], 'the old address is dead'
    assert abs(ok(Mcp(fresh).call('get_state'))['bodies'][0]['volume'] - 23360) < 0.01
    step('disconnect cuts the client off; a new address kills the old one')

    # ---- it stays connected over a reload, because the person left it on
    p.click('[data-modal="close"]')
    p.goto(page)
    p.wait('window.corecad && corecad.bridge.status === "on"', timeout=120)
    p.wait('!corecad.busy', timeout=120)
    assert p.js('corecad.bridge.address') == fresh
    assert abs(ok(Mcp(fresh).call('get_state'))['bodies'][0]['volume'] - 23360) < 0.01, 'the autosaved model, over the same address'
    p.click('#connect-button')
    p.wait('!!document.querySelector("[data-modal=toggle]")')
    p.click('[data-modal="toggle"]')
    p.wait('corecad.bridge.status === "off"')
    p.goto(page)
    p.wait('!!(window.corecadReady && window.corecad)')
    time.sleep(0.5)
    assert p.js('corecad.bridge.status') == 'off', 'and stays off once switched off'
    step('left on: reconnects after a reload; switched off: stays off')

    if local:
        # ---- an address for another host is never taken from the page's address
        p.goto('index.html?test=1&bridge=wss://example.com/x/ws')
        p.wait('!!(window.corecad && corecad.bridge)')
        assert p.js('corecad.bridge.address').startswith(LIVE_PREFIX), p.js('corecad.bridge.address')
        step('?bridge= is honoured for localhost only')

    errors = [e for e in p.errors() if 'WebSocket' not in e]
    assert not errors, errors
    print('ALL BRIDGE CHECKS PASSED')


def main():
    if '--port' in sys.argv or '--live' in sys.argv:    # a relay that is already running, here or in public
        with Browser(size=(1400, 900)) as b:
            try:
                run(b.page, None if '--live' in sys.argv else int(sys.argv[sys.argv.index('--port') + 1]))
            except Exception as e:
                b.page.screenshot(ROOT / '.scratch' / 'e2e_bridge_failure.png')
                print('FAILED:', e)
                return 1
        return 0
    node = node_path()
    if not node:
        print('This test needs Node for the relay: put it on the PATH or set NODE.')
        return 2
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    relay = subprocess.Popen([node, str(ROOT / 'bridge' / 'server.js')], env={**os.environ, 'PORT': str(port), 'ALLOW_LOCAL': '1'},
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        line = relay.stdout.readline()
        assert 'listening' in line, 'the relay did not start: ' + line + relay.stdout.read()
        with Browser(size=(1400, 900)) as b:
            try:
                run(b.page, port)
            except Exception as e:
                b.page.screenshot(ROOT / '.scratch' / 'e2e_bridge_failure.png')
                print('FAILED:', e)
                for line in b.page.errors():
                    print('  ', line)
                return 1
        return 0
    finally:
        relay.terminate()


if __name__ == '__main__':
    sys.exit(main())

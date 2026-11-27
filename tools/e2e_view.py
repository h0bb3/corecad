"""A second seat: a page that watches a CoreCAD tab (view.html), as a headset or a phone opens it.

Run with: python tools/e2e_view.py. It starts the relay (bridge/server.js, Node) on a free port,
opens CoreCAD in one tab and connects it, opens the watching page in a second tab from the address
the Connect dialog gives, and checks that the second shows what the first shows, that what is
pointed at and clicked there is "this" in the tab, and that a cut made there is the tab's cut.

The headset itself (WebXR) is not here: a headless Chrome has none. What the hands of a headset do
goes the same way as what this test does: a camera and a pixel to the tab (src/view/xr.js).

Needs Node: on the PATH, or its path in the NODE environment variable.
"""
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from browser import Browser, ROOT  # noqa: E402
from e2e_bridge import node_path  # noqa: E402


def run(b, port):
    p = b.page

    def step(text):
        print('PASS ' + text)

    def call(command, /, **args):
        r = p.js(f'corecad.run({json.dumps(command)}, {json.dumps(args)})')
        assert r['ok'], f'{command}{args}: {r.get("error")}'
        return r['result']

    bridge = f'ws://127.0.0.1:{port}/CoreCAD/ws'
    p.goto(f'index.html?test=1&bridge={bridge}')
    p.wait('window.corecadReady && window.corecad && !corecad.busy', timeout=120)
    if p.js('corecad.bridge.status') != 'off':      # left on by an earlier run in this browser profile
        p.js('document.getElementById("connect-button").click()')
        p.wait('!!document.querySelector("[data-modal=toggle]")')
        p.click('[data-modal="toggle"]')
        p.wait('corecad.bridge.status === "off"')
        p.click('[data-modal="close"]')
    call('new_document', name='Plate to look at')
    pid = call('add_part')['part']['id']
    s = call('add_sketch', part=pid)
    call('add_to_sketch', sketch=s['id'], shapes=[{'type': 'rectangle', 'center': [0, 0], 'width': 60, 'height': 40}])
    call('extrude', sketch=s['id'], distance=10)
    assert p.js('document.getElementById("xr").hidden'), 'no headset here: the Headset button is not offered'

    # ---- the Connect dialog offers the second seat once the tab is connected: an address and its QR code
    p.click('#connect-button')
    p.wait('!!document.getElementById("bridge-address")')
    assert not p.js('!!document.getElementById("bridge-second")'), 'not before the tab is connected'
    p.click('[data-modal="toggle"]')
    p.wait('corecad.bridge.status === "on" && !!document.getElementById("bridge-second")', timeout=20)
    address = p.js('document.getElementById("bridge-second").value')
    code = p.js('corecad.bridge.code')
    assert address.endswith('/view.html?bridge=' + bridge.replace(':', '%3A').replace('/', '%2F') + '#' + code), address
    p.wait('document.getElementById("bridge-qr").width > 20', timeout=30)
    qr = p.js('(() => { const c = document.getElementById("bridge-qr"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let dark = 0; for (let i = 0; i < d.length; i += 4) dark += d[i] < 128; return { n: c.width, dark, text: c.dataset.text }; })()')
    assert qr['text'] == address and 25 <= qr['n'] <= 80 and 0.2 < qr['dark'] / qr['n'] ** 2 < 0.6, qr
    assert 'Nobody is watching' in p.js('document.getElementById("bridge-viewers").textContent')
    assert all(p.js('[...document.querySelectorAll("#modal-root button, #modal-root input, #modal-root canvas")].map(e => !!e.title)')), 'every control explains itself'
    p.click('#bridge-qr')
    p.wait('!!document.getElementById("qr-big")')
    big = p.js('(() => { const r = document.querySelector("#qr-big canvas").getBoundingClientRect(); return [r.width, r.height]; })()')
    assert min(big) > 600, f'big enough for a headset\'s camera: {big}'
    p.click('#qr-big')
    p.wait('!document.getElementById("qr-big")')
    p.screenshot(ROOT / '.scratch' / 'e2e_view_dialog.png')
    step('the Connect dialog gives the address of the watching page and its QR code, once the tab is connected')

    # ---- the watching page: it shows the model of the tab
    v = b.new_page()
    v.goto(address.split('/', 3)[3])
    v.wait('window.corecadView && corecadView.on && corecadView.bodies === 1 && corecadView.view.pickBodies.length === 1', timeout=40)
    assert v.js('document.getElementById("status").textContent') == 'Live from the CoreCAD tab'
    assert v.js('document.getElementById("name").textContent') == 'Plate to look at' and 'Plate to look at' in v.js('document.title')
    body = v.js('(() => { const b = corecadView.view.pickBodies[0]; return { bbox: b.bbox, triangles: b.mesh.indices.length / 3, positions: b.mesh.positions.constructor.name, edges: b.mesh.edgeSegs.length / 2 }; })()')
    assert body['bbox'] == [[-30, -20, 0], [30, 20, 10]] and body['triangles'] == 12 and body['positions'] == 'Float32Array' and body['edges'] == 12, body
    p.wait('document.getElementById("bridge-viewers").textContent.includes("1 device is watching")')
    p.click('[data-modal="close"]')
    assert v.js('document.getElementById("xr").hidden'), 'no headset here either'
    v.screenshot(ROOT / '.scratch' / 'e2e_view_first.png')
    step('the watching page shows the tab\'s model: the same triangles, its name, live')

    # ---- what is clicked there is selected in the tab, and is "this" to an agent
    def at(point):
        return v.js(f'corecadView.view.project({json.dumps(point)}).slice(0, 2)')

    v.click(*at([10, 5, 10]))
    p.wait('corecad.selection.length === 1')
    sel = call('get_selection')
    face = sel['selected'][0]
    assert len(sel['selected']) == 1 and face['kind'] == 'face' and face['part'] == pid and abs(face['point'][2] - 10) < 1e-6, sel
    v.wait('corecadView.seen.select.length === 1 && corecadView.seen.labels.some(l => l.text)')
    texts = [l['text'] for l in v.js('corecadView.seen.labels') if l.get('text')]
    assert any('60' in t and '40' in t for t in texts) or ('60' in ' '.join(texts) and '40' in ' '.join(texts)), texts
    assert all(len(l['at']) == 3 for l in v.js('corecadView.seen.labels') if l.get('text')), 'each number stands at a point of space'
    # Shift and a second face: the distance between them comes back as a number in space
    v.click(*at([30, 0, 5]), modifiers=8)
    p.wait('corecad.selection.length === 2')
    v.wait('corecadView.seen.select.length === 2')
    v.wait('corecadView.seen.labels.some(l => l.line)')
    v.screenshot(ROOT / '.scratch' / 'e2e_view_selected.png')
    # a click on nothing lets go, there and here
    v.click(40, 780)
    p.wait('corecad.selection.length === 0')
    v.wait('corecadView.seen.select.length === 0')
    step('a face clicked on the watching page is selected in the tab and is "this" to an agent; its size and a distance come back as numbers in space')

    # ---- where the pointer rests there is what is pointed at here
    v.move(*at([-10, -5, 10]))
    v.move(*[c + 1 for c in at([-10, -5, 10])])
    p.wait('!!corecad.pointed', timeout=10)
    pointed = call('get_selection')['pointed']
    assert pointed and pointed['kind'] == 'face' and abs(pointed['point'][2] - 10) < 1e-6 and abs(pointed['point'][0] + 10) < 1.5, pointed
    step('what the pointer rests on there is what the person points at, for an agent')

    # ---- a cut and see-through, asked for there, are the tab's own
    v.js('corecadView.send({ kind: "section", section: { plane: "XZ", at: 5, flip: true } })')
    p.wait('corecad.looking.section && corecad.looking.section.at === 5')
    assert p.js('corecad.looking.section') == {'plane': 'XZ', 'at': 5, 'flip': True, 'text': p.js('corecad.looking.section.text')}
    v.wait('corecadView.seen.half && corecadView.seen.half.d === -5')
    assert v.js('corecadView.seen.half.n') == [0, -1, 0]
    v.screenshot(ROOT / '.scratch' / 'e2e_view_cut.png')
    v.click('#whole')
    p.wait('corecad.looking.section === null')
    v.wait('corecadView.seen.half === null')
    v.click('#xray')
    p.wait('corecad.looking.xray === true')
    v.wait('corecadView.seen.xray === true && document.getElementById("xray").classList.contains("active")')
    v.click('#xray')
    p.wait('corecad.looking.xray === false')
    step('a cut and see-through asked for on the watching page are the tab\'s: the same cut on both, and an agent knows of it')

    # ---- what is not understood is left alone
    before = call('get_document')
    for bad in ['{ kind: "click", cam: { view: {} } }', '{ kind: "section", section: { plane: "ZZ", at: 1 } }', '{ kind: "run", command: "new_document" }', 'null', '{ kind: "click", cam: { view: { target: [0, 0, "x"], quat: [0, 0, 0, 1], dist: 1, fov: 20 }, vp: { w: 1, h: 1 }, p: [0, 0] } }']:
        v.js(f'corecadView.send({bad})')
    time.sleep(0.5)
    assert call('get_document') == before and p.js('corecad.selection.length') == 0 and not p.errors(), p.errors()
    step('what a watching page sends that is not pointing, choosing, a cut or see-through does nothing')

    # ---- the model changes in the tab: the watching page follows
    call('edit_feature', id=call('get_state')['features'][-1]['id'], distance=25)
    v.wait('corecadView.view.pickBodies[0] && corecadView.view.pickBodies[0].bbox[1][2] === 25', timeout=20)
    hole = call('add_sketch', plane='top')
    call('add_to_sketch', sketch=hole['id'], shapes=[{'type': 'circle', 'center': [0, 0], 'diameter': 12}])
    call('extrude', sketch=hole['id'], operation='cut', through_all=True)
    v.wait('corecadView.view.pickBodies[0] && corecadView.view.pickBodies[0].mesh.indices.length / 3 > 12', timeout=20)
    assert v.js('corecadView.meshes') == 1, 'the old triangles are let go'
    call('set_color', part=pid, color='orange')
    v.wait('corecadView.view.pickBodies[0].color && corecadView.view.pickBodies[0].color.toLowerCase() !== "#bac8ca"', timeout=10)
    step('the model changes in the tab, by an agent or by hand: the watching page follows, shape and colour')

    # ---- the watching page comes back after a reload; the tab going away is said, and its coming back seen
    v.goto(address.split('/', 3)[3].replace('view.html?', 'view.html?again=1&'))             # another address: the page is loaded afresh
    v.wait('window.corecadView && corecadView.on && corecadView.bodies === 1 && corecadView.view.pickBodies.length === 1', timeout=40)
    p.click('#connect-button')
    p.wait('!!document.querySelector("[data-modal=toggle]")')
    p.click('[data-modal="toggle"]')
    p.wait('corecad.bridge.status === "off"')
    v.wait('!corecadView.on')
    assert 'Waiting for the CoreCAD tab' in v.js('document.getElementById("status").textContent')
    p.click('[data-modal="toggle"]')
    p.wait('corecad.bridge.status === "on"', timeout=20)
    v.wait('corecadView.on && corecadView.bodies === 1', timeout=20)
    assert v.js('document.getElementById("status").textContent') == 'Live from the CoreCAD tab'
    p.click('[data-modal="close"]')
    step('a watching page that is opened again, or whose tab goes away and comes back, shows the model again')

    # ---- which tab, without an address: the one watched last; else the page asks, and reads the code itself
    w = b.new_page()
    plain = 'view.html?bridge=' + bridge
    w.goto(plain)
    w.wait('window.corecadView && corecadView.on && corecadView.bodies === 1', timeout=40)
    assert w.js('location.hash') == '#' + code, 'opened without a code, it watches the tab it watched last'
    w.js('localStorage.removeItem("corecad.view.code")')
    w.goto(plain + '&fresh=1')
    w.wait('window.corecadView && !document.getElementById("ask").hidden')
    assert 'Which CoreCAD tab' in w.js('document.getElementById("status").textContent') and not w.js('corecadView.on')
    # a camera that sees nothing a page may use says so, and the page still asks
    w.js('navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("no", "NotAllowedError"); }')
    w.click('#scan-first')
    w.wait('document.getElementById("scan-says").textContent.includes("did not let this page use a camera")')
    assert 'Headset cameras' in w.js('document.getElementById("scan-says").textContent') and not w.js('document.getElementById("scan-again").hidden')
    w.click('#scan-stop')
    assert w.js('document.getElementById("scanning").hidden') and not w.js('corecadView.scanner.running')
    # a browser that has no camera for a page: what it said, what it lists, and what to allow in a headset
    w.js('window.asked = []; navigator.mediaDevices.getUserMedia = async (c) => { asked.push(JSON.stringify(c.video)); throw new DOMException("none", "NotFoundError"); }; navigator.mediaDevices.enumerateDevices = async () => []')
    w.click('#scan-first')
    w.wait('document.getElementById("scan-says").textContent.includes("gave the page no camera (NotFoundError)")')
    said = w.js('document.getElementById("scan-says").textContent')
    assert 'lists no camera at all' in said and 'lock at the left of the address bar' in said and 'Headset cameras' in said, said
    assert w.js('asked.length') == 2 and w.js('asked[1]') == 'true', 'asked for a camera that looks outward, then for any camera'
    w.click('#scan-stop')
    # a camera that looks at the code, a little turned and not very big: the page reads it and watches that tab
    w.js("""(async () => {
      const { default: qrcode } = await import('https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm');
      const qr = qrcode(0, 'L'); qr.addData(%s); qr.make();
      const n = qr.getModuleCount(), c = document.createElement('canvas'), g = c.getContext('2d'), k = 6;
      c.width = 1280; c.height = 960;
      const draw = () => {
        g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#5a6b70'; g.fillRect(0, 0, c.width, c.height);
        g.translate(640, 480); g.rotate(0.12); g.fillStyle = '#f4f4f4'; g.fillRect(-(n + 8) * k / 2, -(n + 8) * k / 2, (n + 8) * k, (n + 8) * k);
        g.fillStyle = '#1b1b1b';
        for (let r = 0; r < n; r++) for (let q = 0; q < n; q++) if (qr.isDark(r, q)) g.fillRect((q - n / 2) * k, (r - n / 2) * k, k, k);
      };
      draw(); setInterval(draw, 100);
      // as a headset's browser is: a plain request is refused, any camera gives the avatar (a blank picture),
      // and the camera that sees the room has to be asked for by name
      const blank = document.createElement('canvas'); blank.width = 640; blank.height = 480; blank.getContext('2d').fillRect(0, 0, 640, 480);
      setInterval(() => blank.getContext('2d').fillRect(0, 0, 1, 1), 100);
      const room = c.captureStream(15), avatar = blank.captureStream(15);
      window.asked = [];
      navigator.mediaDevices.getUserMedia = async (o) => {
        asked.push(JSON.stringify(o.video));
        if (o.video?.facingMode) throw new DOMException('cannot', 'OverconstrainedError');
        return o.video?.deviceId?.exact === 'b' ? room : avatar;
      };
      navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: 'a', label: 'Avatar camera' }, { kind: 'videoinput', deviceId: 'b', label: 'Passthrough camera left' }];
      return n;
    })()""" % json.dumps(address))
    w.click('#scan-first')
    w.wait('window.corecadView.on && corecadView.bodies === 1', timeout=40)
    assert w.js('location.hash') == '#' + code and w.js('document.getElementById("scanning").hidden') and w.js('document.getElementById("ask").hidden')
    asked = w.js('asked')
    assert len(asked) == 3 and 'facingMode' in asked[0] and asked[1] == 'true' and '"exact":"b"' in asked[2], f'refused, then any camera, then the one that sees the room: {asked}'
    assert not w.js('corecadView.scanner.running') and w.js('localStorage.getItem("corecad.view.code")') == code
    # the address pasted instead: the one of the watching page, or the one for Claude
    w.js('localStorage.removeItem("corecad.view.code")')
    w.goto(plain + '&fresh=2')
    w.wait('window.corecadView && !document.getElementById("ask").hidden')
    w.js('(() => { const i = document.getElementById("paste"); i.value = "not an address"; i.dispatchEvent(new Event("change")); })()')
    assert 'not the address of a CoreCAD tab' in w.js('document.getElementById("status").textContent')
    w.js(f'(() => {{ const i = document.getElementById("paste"); i.value = {json.dumps(p.js("corecad.bridge.address"))}; i.dispatchEvent(new Event("change")); }})()')
    w.wait('window.corecadView.on && corecadView.bodies === 1', timeout=40)
    step('without an address the page watches the tab it watched last, or asks: it reads the QR code through a camera, or takes a pasted address; a refused camera is said')
    errors = [e for e in w.errors() if 'favicon' not in e]
    assert not errors, errors

    errors = [e for e in p.errors() + v.errors() if 'favicon' not in e]
    assert not errors, errors
    print('ALL VIEW CHECKS PASSED')


def main():
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
                run(b, port)
            except Exception as e:
                b.page.screenshot(ROOT / '.scratch' / 'e2e_view_failure.png')
                print('FAILED:', e)
                for line in b.page.errors():
                    print('  ', line)
                return 1
        return 0
    finally:
        relay.terminate()


if __name__ == '__main__':
    sys.exit(main())

"""The command set (window.corecad.run, src/api/commands.js) against the real kernel.

Run with: python tools/e2e_api.py. Every edit here goes through commands, the way a
script or an agent would drive the page; tools/e2e.py covers the mouse and the keys.
"""
import base64
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from browser import Browser, ROOT  # noqa: E402


def run(p, url='index.html?test=1'):
    p.goto(url)
    p.wait('window.corecadReady && window.corecad && !corecad.busy', timeout=120)

    def call(command, /, **args):
        r = p.js(f'corecad.run({json.dumps(command)}, {json.dumps(args)})')
        if not r['ok']:
            raise AssertionError(f'{command}{args}: {r["error"]}')
        return r['result']

    def fails(command, pattern, /, **args):
        r = p.js(f'corecad.run({json.dumps(command)}, {json.dumps(args)})')
        assert not r['ok'], f'{command}{args} should have failed, gave {str(r)[:200]}'
        assert pattern.lower() in r['error'].lower(), f'{command}: expected "{pattern}" in "{r["error"]}"'
        return r['error']

    def volume(result=None):
        bodies = (result or call('get_state'))['bodies']
        return sum(b['volume'] for b in bodies)

    def near(a, b, tol=0.02, what=''):
        assert abs(a - b) <= tol, f'{what}: {a} is not {b}'

    def step(text):
        print('PASS ' + text)

    # ---- a plate, from a rectangle with its dimensions
    call('new_document', name='Command test')
    s = call('add_sketch', plane='XY', shapes=[{'type': 'rectangle', 'corner': [0, 0], 'width': 60, 'height': 40}])
    assert s['sketch']['degrees_of_freedom'] == 0 and len(s['sketch']['regions']) == 1, s['sketch']
    sketch1 = s['id']
    r = call('extrude', distance=10)
    assert r['status'] == 'ok' and r['type'] == 'extrude', r
    near(volume(r), 24000, what='plate')
    body = r['bodies'][0]['id']
    assert r['bodies'][0]['box'] == [[0, 0, 0], [60, 40, 10]], r['bodies']
    step('sketch with dimensions and a 10 mm extrusion: 24,000 mm3')

    # ---- faces and edges by description
    faces = call('list_faces')[0]['faces']
    top = next(f for f in faces if f.get('side') == 'top')
    assert top['normal'] == [0, 0, 1] and top['center'] == [30, 20, 10] and len(faces) == 6, faces
    edges = call('list_edges', edges={'parallel': 'z'})[0]['edges']
    assert len(edges) == 4 and all(e['length'] == 10 for e in edges), edges
    assert len(call('list_edges')[0]['edges']) == 12
    step('faces and edges listed and chosen by description')

    # ---- a hole through, from a circle sketched on the top face
    s = call('add_sketch', plane='top', shapes=[{'type': 'circle', 'center': [20, 20], 'diameter': 8}])
    assert s['sketch']['plane'] == {'face_of_body': body} and s['sketch']['degrees_of_freedom'] == 0, s['sketch']
    r = call('extrude', operation='cut', through_all=True)
    near(volume(r), 24000 - math.pi * 16 * 10, what='through cut')
    assert not r['problems'], r['problems']
    step('circle on the top face, cut through: %.2f mm3' % volume(r))

    # ---- four real fillets on the vertical edges
    r = call('fillet', edges={'parallel': 'z'}, radius=4)
    near(volume(r), (2400 - math.pi * 16 - 4 * (16 - 4 * math.pi)) * 10, what='fillets')   # 23,360
    fillet = r['id']
    step('four R4 fillets chosen as "parallel to z": %.2f mm3' % volume(r))

    # ---- parametric: the width dimension drives everything after it
    sk = call('get_sketch', sketch=sketch1)
    width = next(d for d in sk['dimensions'] if d['value'] == 60)
    r = call('set_dimension', sketch=sketch1, dimension=width['id'], value=80)
    wide = (3200 - math.pi * 16 - 4 * (16 - 4 * math.pi)) * 10   # 31,360
    near(volume(r), wide, what='wider plate')
    assert not r['problems'], r['problems']
    step('width 60 -> 80 rebuilds hole and fillets with their references')

    # ---- a blind hole and a chamfer
    r = call('hole', face='top', at=[60, 20], diameter=6, depth=5)
    near(volume(r), wide - math.pi * 9 * 5, what='blind hole')
    before = volume(r)
    r = call('chamfer', edges={'on': 'bottom', 'kind': 'line'}, distance=1)
    assert r['status'] == 'ok' and volume(r) < before - 1, (r['status'], volume(r), before)
    step('blind hole by position and a chamfer on the bottom edges')

    # ---- a command that cannot be built changes nothing
    doc_before = p.js('JSON.stringify(corecad.doc.features)')
    after_chamfer = volume()
    err = fails('edit_feature', '', id=fillet, radius=500)
    assert p.js('JSON.stringify(corecad.doc.features)') == doc_before
    near(volume(), after_chamfer, what='after the refused edit')
    loose = call('add_sketch', plane='XY', shapes=[{'type': 'line', 'from': [100, 0], 'to': [120, 0]}])['id']
    fails('extrude', 'no closed region', sketch=loose, distance=5)
    call('undo')
    fails('fillet', 'No edge', edges={'parallel': 'x', 'length': 123}, radius=1)
    fails('add_sketch', 'unknown type', shapes=[{'type': 'hexagon'}])
    fails('extrude', 'no argument "distanse"', distanse=5)
    fails('nonsense', 'Unknown command')
    fails('delete_feature', 'built on', id=sketch1)
    fails('edit_feature', 'it has no radius', id=sketch1, radius=3)
    assert p.js('JSON.stringify(corecad.doc.features)') == doc_before
    step('refused commands leave the document as it was ("%s")' % err[:70])

    # ---- editing, undo and redo
    r = call('edit_feature', id=fillet, radius=2)
    assert volume(r) > after_chamfer, 'smaller fillets leave more material'
    u = call('undo')
    near(volume(u), after_chamfer, what='undo')
    d = call('redo')
    near(volume(d), volume(r), what='redo')
    r = call('edit_feature', id=fillet, suppressed=True)
    assert r['status'] == 'suppressed', r
    call('edit_feature', id=fillet, suppressed=False, name='Round corners')
    assert next(f for f in call('get_state')['features'] if f['id'] == fillet)['name'] == 'Round corners'
    step('edit, suppress, rename, undo and redo')

    # ---- a dialog open in the page: the commands wait their turn, and can close it
    p.key('e')
    p.wait('corecad.editing')
    assert call('get_state')['editing'] is True
    fails('fillet', 'is open in the page', edges='all', radius=1)
    assert call('cancel_edit') == {'cancelled': True}
    assert p.js('corecad.editing') is False and call('cancel_edit') == {'cancelled': False}
    step('an open dialog blocks changes until it is closed or cancel_edit is called')

    # ---- files and a picture
    final = volume()
    step_file = call('export', format='step')
    assert step_file['text'].startswith('ISO-10303-21') and step_file['bytes'] > 5000, step_file['text'][:40]
    stl = base64.b64decode(call('export', format='stl')['base64'])
    assert len(stl) == 84 + 50 * int.from_bytes(stl[80:84], 'little') and len(stl) > 5000
    project = json.loads(call('export', format='corecad')['text'])
    assert project['format'] == 'corecad' and len(project['features']) == len(call('get_state')['features'])
    shot = call('screenshot', view='home', max=900)
    png = base64.b64decode(shot['png'].split(',', 1)[1])
    assert png[:8] == b'\x89PNG\r\n\x1a\n' and max(shot['width'], shot['height']) <= 900
    out = ROOT / '.scratch' / 'e2e_api.png'
    out.parent.mkdir(exist_ok=True)
    out.write_bytes(png)
    step('STEP, STL, project and a %dx%d screenshot' % (shot['width'], shot['height']))

    # ---- the document round trip, and the page shows what the commands did
    call('new_document')
    assert call('get_state')['bodies'] == []
    back = call('load_document', document=project)
    near(volume(back), final, what='reloaded project')
    assert p.js('document.getElementById("metrics").textContent').startswith('1 body'), 'the page shows the body'
    tools = p.js('corecad.tools.map(t => t.name)')
    assert set(tools) == set(p.js('Object.keys(corecad.commands)')) and len(tools) >= 20
    assert p.js('corecad.tools.every(t => t.description.length > 20 && t.input.type === "object")')
    step('project reloaded to the same volume; %d tools described' % len(tools))

    errors = p.errors()
    assert not errors, errors
    print('ALL COMMAND CHECKS PASSED')


if __name__ == '__main__':
    with Browser(size=(1400, 900)) as b:
        try:
            run(b.page, sys.argv[1] if len(sys.argv) > 1 else 'index.html?test=1')
        except Exception as e:
            b.page.screenshot(ROOT / '.scratch' / 'e2e_api_failure.png')
            print('FAILED:', e)
            for line in b.page.errors():
                print('  ', line)
            sys.exit(1)

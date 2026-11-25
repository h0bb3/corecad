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

    # ---- parts: primitives without sketches, each a part with its own history and place
    def vol(result, part):
        return sum(b['volume'] for b in result['bodies'] if b['part'] == part)

    def row(result_or_state, name):
        return next(x for x in result_or_state['parts'] if x['name'] == name)

    def stl_box():
        data = base64.b64decode(call('export', format='stl')['base64'])
        n = int.from_bytes(data[80:84], 'little')
        import struct
        pts = [struct.unpack_from('<3f', data, 84 + t * 50 + 12 + c * 12) for t in range(n) for c in range(3)]
        return [[round(min(q[i] for q in pts), 2) for i in range(3)], [round(max(q[i] for q in pts), 2) for i in range(3)]]

    call('new_document', name='Parts')
    plate = call('add_box', size=[60, 40, 12], name='Plate')
    assert plate['part']['id'] == 'o1' and plate['part']['kind'] == 'part' and plate['part']['box'] == [[-30, -20, 0], [30, 20, 12]], plate['part']
    near(vol(plate, 'o1'), 28800, what='the box')
    pin = call('add_cylinder', diameter=10, height=30, position=[15, 0, -5], name='Pin')
    assert pin['part']['box'] == [[10, -5, -5], [20, 5, 25]] and pin['part']['position'] == [15, 0, -5], pin['part']
    st = call('get_state')
    assert st['current_part'] == 'o2' and [x['name'] for x in st['parts']] == ['Plate', 'Pin'] and [f['part'] for f in st['features']] == ['o1', 'o2'], st
    fails('add_box', 'three numbers', size=[60, 40])
    fails('add_cylinder', 'positive', diameter=0, height=5)
    fails('add_sphere', 'origin', diameter=5, origin='corner')
    step('a box and a cylinder as parts, each placed and with a history of its own')

    # ---- combine: where the parts stand; the tool is kept under the part it changed
    cut = call('combine', part='Plate', operation='cut', **{'with': ['Pin']})
    near(vol(cut, 'o1'), 28800 - math.pi * 25 * 12, what='plate with a hole')
    assert row(cut, 'Pin')['tool_of'] == 'o1' and row(cut, 'Pin')['parent'] == 'o1' and cut['type'] == 'combine' and cut['part'] == 'o1', cut
    assert [b.get('shown', True) for b in cut['bodies']] == [True, False]
    assert [f['part'] for f in call('list_faces')] == ['o1'], 'a tool that was used up is not listed unless asked for'
    assert len(call('list_faces', part='Pin')[0]['faces']) == 3
    moved = call('move_part', part='Pin', by=[-20, 0, 0])
    assert moved['part']['position'] == [-5, 0, -5]
    near(vol(moved, 'o1'), 28800 - math.pi * 25 * 12, what='the hole moved')
    wall = next(f for f in call('list_faces', part='Plate')[0]['faces'] if f['kind'] == 'cylinder')
    near(wall['center'][0], -5, 1e-4, 'the hole is where the tool is')
    step('combine cuts one part out of another; moving the tool moves the hole')

    # ---- a part turned on the spot: its tools turn with it, and it is described where it stands
    turned = call('move_part', part='Plate', turn={'axis': 'z', 'angle': 90})
    assert turned['part']['rotation'] == [0, 0, 90] and turned['part']['position'] == [0, 0, 0] and turned['part']['box'] == [[-20, -30, 0], [20, 30, 12]], turned['part']
    near(vol(turned, 'o1'), 28800 - math.pi * 25 * 12, what='turned plate')
    faces = call('list_faces', part='Plate')[0]['faces']
    wall = next(f for f in faces if f['kind'] == 'cylinder')
    assert [round(v, 4) for v in wall['center']] == [0, -5, 6], wall
    right = next(f for f in faces if f.get('side') == 'right')
    assert right['center'] == [20, 0, 6] and right['normal'] == [1, 0, 0], right
    assert len(call('list_edges', part='Plate', edges={'parallel': 'x'})[0]['edges']) == 4, 'directions are those of space'
    # a hole given by a point in space, a sketch given in the part's own coordinates
    hole = call('hole', face={'part': 'Plate', 'side': 'top'}, position=[10, 20, 50], diameter=4, depth=5)
    assert call('get_state')['features'][-1]['at'] == [20, -10], call('get_state')['features'][-1]
    near(vol(hole, 'o1'), 28800 - math.pi * 25 * 12 - math.pi * 4 * 5, what='blind hole on the turned plate')
    sk = call('add_sketch', plane={'part': 'Plate', 'side': 'top'}, shapes=[{'type': 'circle', 'center': [-20, 10], 'diameter': 6}])
    assert sk['part'] == 'o1' and sk['sketch']['part'] == 'o1'
    through = call('extrude', operation='cut', through_all=True)
    solid = 28800 - math.pi * 25 * 12 - math.pi * 4 * 5 - math.pi * 9 * 12
    near(vol(through, 'o1'), solid, what='a second hole from a sketch')
    step('a turned part: faces and edges in space, a hole by a point in space, a sketch in its own frame')

    # ---- a copy of its own and a linked copy
    copy = call('copy_part', part='Plate', by=[0, 80, 0])
    assert copy['part']['id'] == 'o3' and copy['part']['kind'] == 'part' and copy['copy_of'] == 'o1' and copy['part']['box'] == [[-20, 50, 0], [20, 110, 12]], copy['part']
    near(vol(copy, 'o3'), solid, what='the copy builds the same')
    twin = call('copy_part', part='Plate', linked=True, position=[0, 0, 40], name='Twin')
    assert twin['part']['kind'] == 'linked copy' and twin['part']['copy_of'] == 'o1' and twin['part']['box'] == [[-20, -30, 40], [20, 30, 52]] and twin['part']['bodies'] == [], twin['part']
    call('edit_feature', id='f1', size=[60, 40, 20])
    st = call('get_state')
    assert row(st, 'Twin')['box'][1][2] == 60 and row(st, 'Plate copy')['box'][1][2] == 12, (row(st, 'Twin'), row(st, 'Plate copy'))
    assert st['current_part'] == 'o1'
    fails('add_sketch', 'linked copy', part='Twin')
    fails('delete_part', 'with_dependents', part='Plate')
    step('a copy of its own keeps its shape; a linked copy follows the original')

    # ---- what is refused changes nothing
    call('add_box', size=[10, 10, 10], name='Block')
    call('add_sphere', diameter=20, origin='center', name='Ball')
    both = call('combine', part='Block', operation='intersect', **{'with': ['Ball']})
    assert 0 < vol(both, row(both, 'Block')['id']) < 1000
    before = call('get_document')
    assert 'would break' in fails('move_part', 'Combine', part='Ball', position=[100, 0, 0])
    fails('combine', 'with itself', part='Block', operation='cut', **{'with': ['Block']})
    fails('combine', 'stands under', part='Ball', operation='cut', **{'with': ['Block']})
    fails('move_part', 'no part', part='Nobody', by=[1, 0, 0])
    fails('move_part', 'not both', part='Block', position=[0, 0, 0], by=[1, 0, 0])
    fails('move_part', 'under itself', part='Block', parent='Ball')
    assert call('get_document') == before
    step('a move that would empty an intersection, and other mistakes, are refused and change nothing')

    # ---- a group moves and hides what is under it; export has what is to be seen, where it stands
    group = call('add_part', name='Group')
    assert group['part']['kind'] == 'empty'
    call('move_part', part='Block', parent='Group')
    lifted = call('move_part', part='Group', by=[0, 0, 100])
    assert lifted['part']['kind'] == 'group' and row(call('get_state'), 'Block')['box'] == [[-5, -5, 100], [5, 5, 110]]
    assert stl_box() == [[-20, -30, 0], [20, 110, 110]]
    hidden = call('edit_part', part='Group', hidden=True)
    assert [b.get('shown', True) for b in hidden['bodies'] if b['part'] == row(call('get_state'), 'Block')['id']] == [False]
    assert stl_box() == [[-20, -30, 0], [20, 110, 60]], stl_box()
    gone = call('delete_part', part='Plate', with_dependents=True)
    assert set(gone['deleted']['parts']) == {'o1', 'o2', twin['part']['id']} and 'Twin' not in [x['name'] for x in gone['parts']], gone['deleted']
    call('undo')
    own = call('unlink_part', part='Twin')
    assert own['part']['kind'] == 'part' and own['part']['name'] == 'Twin' and len(own['part']['features']) == 5 and own['part']['box'] == [[-20, -30, 40], [20, 30, 60]], own['part']
    assert p.js('document.querySelectorAll("[data-part]").length') == len(call('get_state')['parts']), 'the page lists every part'
    step('groups, hiding, export in place, delete with dependents, undo, unlink')

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

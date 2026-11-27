"""The command set (window.corecad.run, src/api/commands.js) against the real kernel.

Run with: python tools/e2e_api.py. Every edit here goes through commands, the way a
script or an agent would drive the page; tools/e2e.py covers the mouse and the keys.

There is one way to do each thing, so what a test needs often takes several commands:
`sketch`, `block`, `rod` and `ball` below put them together, as an agent would.
"""
import base64
import json
import math
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from browser import Browser, ROOT  # noqa: E402

COMMANDS = ('get_state get_selection measure get_document load_document new_document get_sketch list_faces list_edges '
            'add_sketch add_to_sketch set_dimension add_dimension add_constraint remove_from_sketch '
            'extrude revolve import fillet chamfer edit_feature '
            'add_part add_group combine move_part copy_part set_color edit_part unlink_part delete_part delete_feature '
            'undo redo reload_app cancel_edit export screenshot set_view set_section set_xray').split()
GONE = ['add_box', 'add_cylinder', 'add_sphere', 'hole', 'ungroup', 'list_dimensions']


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

    # ---- what a solid takes: a part, a sketch, shapes in it, an extrusion or a turn
    def sketch(shapes, plane='XY', part=None):
        """A sketch with shapes in it: add_sketch makes it, add_to_sketch fills it."""
        s = call('add_sketch', plane=plane, **({'part': part} if part else {}))
        return call('add_to_sketch', sketch=s['id'], shapes=shapes)

    def part(name):
        pid = call('add_part')['part']['id']
        call('edit_part', part=pid, name=name)
        return pid

    def block(name, size, position=None):
        """A box that stands on the ground with its middle over the part's origin."""
        pid = part(name)
        s = sketch([{'type': 'rectangle', 'center': [0, 0], 'width': size[0], 'height': size[1]}], part=pid)
        call('extrude', sketch=s['id'], distance=size[2])
        if position:
            call('move_part', part=pid, position=position)
        return pid

    def rod(name, diameter, height, position=None):
        """A cylinder along Z, standing on the part's origin."""
        pid = part(name)
        s = sketch([{'type': 'circle', 'center': [0, 0], 'diameter': diameter}], part=pid)
        call('extrude', sketch=s['id'], distance=height)
        if position:
            call('move_part', part=pid, position=position)
        return pid

    def ball(name, diameter):
        """A sphere round the part's origin: a half disc on XZ, turned about its straight side."""
        r = diameter / 2
        pid = part(name)
        s = sketch([{'type': 'arc', 'center': [0, 0], 'from': [0, -r], 'to': [0, r]}, {'type': 'line', 'from': [0, r], 'to': [0, -r]}], plane='XZ', part=pid)
        call('revolve', sketch=s['id'], axis=next(e['id'] for e in s['sketch']['entities'] if e['type'] == 'line'))
        return pid

    def feature(fid):
        return next(f for f in call('get_state')['features'] if f['id'] == fid)

    content = lambda d: {k: v for k, v in d.items() if k not in ('seq', 'pseq', 'meta')}     # undo keeps the counters: ids are never used twice

    def undo_to(doc, most=80):
        for _ in range(most):
            if content(call('get_document')) == content(doc):
                return
            call('undo')
        assert content(call('get_document')) == content(doc), 'undo did not come back to where it started'

    # ---- a plate: a part, an empty sketch, a rectangle with its dimensions, an extrusion
    call('new_document', name='Command test')
    fails('add_sketch', 'make one with add_part')
    first = call('add_part')['part']
    assert first == {'id': 'o1', 'name': 'Part 1', 'kind': 'empty', 'parent': None, 'position': [0, 0, 0], 'rotation': [0, 0, 0], 'features': [], 'bodies': []}, first
    s = call('add_sketch', plane='XY')
    assert s['status'] == 'ok' and s['part'] == 'o1' and s['sketch']['entities'] == [] and s['sketch']['regions'] == [], s
    fails('extrude', 'no closed region', distance=5)
    s = call('add_to_sketch', shapes=[{'type': 'rectangle', 'corner': [0, 0], 'width': 60, 'height': 40}])
    assert s['sketch']['degrees_of_freedom'] == 0 and len(s['sketch']['regions']) == 1, s['sketch']
    sketch1 = s['id']
    r = call('extrude', distance=10)
    assert r['status'] == 'ok' and r['type'] == 'extrude', r
    near(volume(r), 24000, what='plate')
    body = r['bodies'][0]['id']
    assert r['bodies'][0]['box'] == [[0, 0, 0], [60, 40, 10]], r['bodies']
    step('a part, a sketch, a rectangle with its dimensions and a 10 mm extrusion: 24,000 mm3')

    # ---- faces and edges by description
    faces = call('list_faces')[0]['faces']
    top = next(f for f in faces if f.get('side') == 'top')
    assert top['normal'] == [0, 0, 1] and top['center'] == [30, 20, 10] and len(faces) == 6, faces
    edges = call('list_edges', edges={'parallel': 'z'})[0]['edges']
    assert len(edges) == 4 and all(e['length'] == 10 for e in edges), edges
    assert len(call('list_edges')[0]['edges']) == 12
    step('faces and edges listed and chosen by description')

    # ---- a hole through: a circle sketched on the top face, cut
    s = sketch([{'type': 'circle', 'center': [20, 20], 'diameter': 8}], plane='top')
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

    # ---- a blind hole (a cut on a face goes into the body) and a chamfer
    sketch([{'type': 'circle', 'center': [60, 20], 'diameter': 6}], plane='top')
    r = call('extrude', operation='cut', distance=5)
    near(volume(r), wide - math.pi * 9 * 5, what='blind hole')
    before = volume(r)
    r = call('chamfer', edges={'on': 'bottom', 'kind': 'line'}, distance=1)
    assert r['status'] == 'ok' and volume(r) < before - 1, (r['status'], volume(r), before)
    step('a blind hole as a circle cut 5 deep, and a chamfer on the bottom edges')

    # ---- a command that cannot be built changes nothing
    doc_before = p.js('JSON.stringify(corecad.doc.features)')
    after_chamfer = volume()
    err = fails('edit_feature', '', id=fillet, radius=500)
    assert p.js('JSON.stringify(corecad.doc.features)') == doc_before
    near(volume(), after_chamfer, what='after the refused edit')
    loose = sketch([{'type': 'line', 'from': [100, 0], 'to': [120, 0]}])['id']
    fails('extrude', 'no closed region', sketch=loose, distance=5)
    call('undo')
    call('undo')
    fails('fillet', 'No edge', edges={'parallel': 'x', 'length': 123}, radius=1)
    fails('add_to_sketch', 'unknown type', shapes=[{'type': 'hexagon'}])
    fails('extrude', 'no argument "distanse"', distanse=5)
    fails('extrude', '"flip" reverses', sketch=sketch1, distance=-5)
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
    assert feature(fillet)['name'] == 'Round corners'
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
    project = call('get_document')
    assert project['format'] == 'corecad' and len(project['features']) == len(call('get_state')['features'])
    fails('export', 'get_document', format='corecad')
    assert call('set_view', view='home') == {'view': 'home', 'fitted': True} and call('set_view') == {'fitted': True}
    fails('set_view', 'nothing to do', fit=False)
    shot = call('screenshot', max=900)
    png = base64.b64decode(shot['png'].split(',', 1)[1])
    assert png[:8] == b'\x89PNG\r\n\x1a\n' and max(shot['width'], shot['height']) <= 900
    fails('screenshot', 'no argument "view"', view='home')
    out = ROOT / '.scratch' / 'e2e_api.png'
    out.parent.mkdir(exist_ok=True)
    out.write_bytes(png)
    step('STEP, STL, the project and a %dx%d picture of the view as set_view left it' % (shot['width'], shot['height']))

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

    # ---- parts: each with a history and a place of its own
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
    assert block('Plate', [60, 40, 12]) == 'o1'
    st = call('get_state')
    assert row(st, 'Plate')['kind'] == 'part' and row(st, 'Plate')['box'] == [[-30, -20, 0], [30, 20, 12]], row(st, 'Plate')
    near(vol(st, 'o1'), 28800, what='the block')
    assert rod('Pin', 10, 30, position=[15, 0, -5]) == 'o2'
    st = call('get_state')
    assert row(st, 'Pin')['box'] == [[10, -5, -5], [20, 5, 25]] and row(st, 'Pin')['position'] == [15, 0, -5], row(st, 'Pin')
    assert st['current_part'] == 'o2' and [x['name'] for x in st['parts']] == ['Plate', 'Pin'] and [f['part'] for f in st['features']] == ['o1', 'o1', 'o2', 'o2'], st
    fails('add_part', 'no argument "name"', name='Plate')
    fails('add_part', 'no argument "position"', position=[1, 2, 3])
    step('a block and a rod as parts: each made empty, named, drawn, extruded and placed by a command of its own')

    # ---- combine: where the parts stand; the tool is kept under the part it changed
    cut = call('combine', part='Plate', operation='cut', **{'with': ['Pin']})
    near(vol(cut, 'o1'), 28800 - math.pi * 25 * 12, what='plate with a hole')
    assert row(cut, 'Pin')['tool_of'] == 'o1' and row(cut, 'Pin')['parent'] == 'o1' and cut['type'] == 'combine' and cut['part'] == 'o1', cut
    assert [b.get('shown', True) for b in cut['bodies']] == [True, False]
    assert [f['part'] for f in call('list_faces')] == ['o1'], 'a tool that was used up is not listed unless asked for'
    assert len(call('list_faces', part='Pin')[0]['faces']) == 3
    moved = call('move_part', part='Pin', position=[-5, 0, -5])
    assert moved['part']['position'] == [-5, 0, -5]
    near(vol(moved, 'o1'), 28800 - math.pi * 25 * 12, what='the hole moved')
    wall = next(f for f in call('list_faces', part='Plate')[0]['faces'] if f['kind'] == 'cylinder')
    near(wall['center'][0], -5, 1e-4, 'the hole is where the tool is')
    step('combine cuts one part out of another; moving the tool moves the hole')

    # ---- a part turned: its tools turn with it, and it is described where it stands
    turned = call('move_part', part='Plate', rotation=[0, 0, 90])
    assert turned['part']['rotation'] == [0, 0, 90] and turned['part']['position'] == [0, 0, 0] and turned['part']['box'] == [[-20, -30, 0], [20, 30, 12]], turned['part']
    near(vol(turned, 'o1'), 28800 - math.pi * 25 * 12, what='turned plate')
    faces = call('list_faces', part='Plate')[0]['faces']
    wall = next(f for f in faces if f['kind'] == 'cylinder')
    assert [round(v, 4) for v in wall['center']] == [0, -5, 6], wall
    right = next(f for f in faces if f.get('side') == 'right')
    assert right['center'] == [20, 0, 6] and right['normal'] == [1, 0, 0], right
    assert len(call('list_edges', part='Plate', edges={'parallel': 'x'})[0]['edges']) == 4, 'directions are those of space'
    # a sketch on its top face is drawn in the part's own coordinates: (20, -10) there is (10, 20) in space
    blind = sketch([{'type': 'circle', 'center': [20, -10], 'diameter': 4}], plane={'part': 'Plate', 'side': 'top'})
    assert blind['part'] == 'o1' and blind['sketch']['part'] == 'o1'
    hole = call('extrude', sketch=blind['id'], operation='cut', distance=5)
    near(vol(hole, 'o1'), 28800 - math.pi * 25 * 12 - math.pi * 4 * 5, what='blind hole on the turned plate')
    bore = next(f for f in call('list_faces', part='Plate')[0]['faces'] if f['kind'] == 'cylinder' and f.get('radius') == 2)
    assert [round(v, 4) for v in bore['center']] == [10, 20, 9.5], bore
    sk = sketch([{'type': 'circle', 'center': [-20, 10], 'diameter': 6}], plane={'part': 'Plate', 'side': 'top'})
    through = call('extrude', sketch=sk['id'], operation='cut', through_all=True)
    solid = 28800 - math.pi * 25 * 12 - math.pi * 4 * 5 - math.pi * 9 * 12
    near(vol(through, 'o1'), solid, what='a second hole from a sketch')
    step('a turned part: faces and edges in space, sketches on it in its own frame')

    # ---- a copy of its own and a linked copy: made where the original stands, then placed
    copy = call('copy_part', part='Plate')
    assert copy['part']['id'] == 'o3' and copy['part']['kind'] == 'part' and copy['copy_of'] == 'o1' and copy['part']['name'] == 'Plate copy' and copy['part']['box'] == [[-20, -30, 0], [20, 30, 12]], copy['part']
    copy = call('move_part', part='o3', position=[0, 80, 0])
    assert copy['part']['box'] == [[-20, 50, 0], [20, 110, 12]], copy['part']
    near(vol(copy, 'o3'), solid, what='the copy builds the same')
    twin = call('copy_part', part='Plate', linked=True)
    tid = twin['part']['id']
    assert twin['part']['kind'] == 'linked copy' and twin['part']['copy_of'] == 'o1' and twin['part']['bodies'] == [] and twin['part']['box'] == [[-20, -30, 0], [20, 30, 12]], twin['part']
    call('edit_part', part=tid, name='Twin')
    twin = call('move_part', part=tid, position=[0, 0, 40])
    assert twin['part']['name'] == 'Twin' and twin['part']['box'] == [[-20, -30, 40], [20, 30, 52]], twin['part']
    call('edit_feature', id='f2', distance=20)
    st = call('get_state')
    assert row(st, 'Twin')['box'][1][2] == 60 and row(st, 'Plate copy')['box'][1][2] == 12, (row(st, 'Twin'), row(st, 'Plate copy'))
    assert st['current_part'] == 'o1'
    fails('add_sketch', 'linked copy', part='Twin')
    fails('delete_part', 'with_dependents', part='Plate')
    fails('copy_part', 'no argument "position"', part='Plate', position=[0, 0, 1])
    step('a copy of its own keeps its shape; a linked copy follows the original')

    # ---- what is refused changes nothing
    block('Block', [10, 10, 10])
    ball('Ball', 20)
    assert row(call('get_state'), 'Ball')['box'] == [[-10, -10, -10], [10, 10, 10]], row(call('get_state'), 'Ball')
    both = call('combine', part='Block', operation='intersect', **{'with': ['Ball']})
    assert 0 < vol(both, row(both, 'Block')['id']) < 1000
    before = call('get_document')
    assert 'would break' in fails('move_part', 'Combine', part='Ball', position=[100, 0, 0])
    fails('combine', 'with itself', part='Block', operation='cut', **{'with': ['Block']})
    fails('combine', 'stands under', part='Ball', operation='cut', **{'with': ['Block']})
    fails('move_part', 'no part', part='Nobody', position=[1, 0, 0])
    fails('move_part', 'Say where', part='Block')
    fails('move_part', 'no argument "by"', part='Block', by=[1, 0, 0])
    fails('move_part', 'no argument "turn"', part='Block', turn={'axis': 'z', 'angle': 90})
    fails('move_part', 'under itself', part='Block', parent='Ball')
    assert call('get_document') == before
    step('a move that would empty an intersection, and other mistakes, are refused and change nothing')

    # ---- a group moves and hides what is in it; export has what is to be seen, where it stands
    group = call('add_group')['part']
    assert group['kind'] == 'group' and group['name'] == 'Group 1' and group['contains'] == [] and group['parent'] is None and 'box' not in group, group
    fails('add_group', 'no argument "parts"', parts=['Block'])
    call('edit_part', part=group['id'], name='Group')
    call('move_part', part='Block', parent='Group')
    lifted = call('move_part', part='Group', position=[0, 0, 100])
    assert lifted['part']['kind'] == 'group' and lifted['part']['contains'] == [row(lifted_state := call('get_state'), 'Block')['id']], lifted['part']
    assert row(lifted_state, 'Block')['box'] == [[-5, -5, 100], [5, 5, 110]] and lifted['part']['box'] == [[-5, -5, 100], [5, 5, 110]]
    assert stl_box() == [[-20, -30, 0], [20, 110, 110]]
    hidden = call('edit_part', part='Group', hidden=True)
    assert [b.get('shown', True) for b in hidden['bodies'] if b['part'] == row(call('get_state'), 'Block')['id']] == [False]
    assert stl_box() == [[-20, -30, 0], [20, 110, 60]], stl_box()
    gone = call('delete_part', part='Plate', with_dependents=True)
    assert set(gone['deleted']['parts']) == {'o1', 'o2', tid} and 'Twin' not in [x['name'] for x in gone['parts']], gone['deleted']
    call('undo')
    own = call('unlink_part', part='Twin')
    assert own['part']['kind'] == 'part' and own['part']['name'] == 'Twin' and len(own['part']['features']) == 7 and own['part']['box'] == [[-20, -30, 40], [20, 30, 60]], own['part']
    assert p.js('document.querySelectorAll("[data-part]").length') == len(call('get_state')['parts']), 'the page lists every part'
    step('a group, hiding, export in place, delete with dependents, undo, unlink')

    # ---- groups: parts are put in and taken out with move_part, and stay where they are; combine takes a group whole
    untouched = call('get_document')
    a = block('Foot A', [10, 10, 10], position=[200, 0, 0])
    b = block('Foot B', [10, 10, 10], position=[230, 0, 0])
    fid = call('add_group')['part']['id']
    call('edit_part', part=fid, name='Feet')
    call('move_part', part=fid, position=[200, 0, 0])
    call('move_part', part='Foot A', parent='Feet')
    inside = call('move_part', part='Foot B', parent='Feet')['part']
    assert inside['parent'] == fid and inside['position'] == [30, 0, 0] and inside['box'] == [[225, -5, 0], [235, 5, 10]], 'put into a group, a part stays where it is in space: %s' % inside
    state = call('get_state')
    feet = row(state, 'Feet')
    assert feet['kind'] == 'group' and feet['contains'] == [a, b] and feet['position'] == [200, 0, 0] and feet['box'] == [[195, -5, 0], [235, 5, 10]] and feet['features'] == [] and feet['bodies'] == [], feet
    assert state['current_part'] == b, 'the part that was moved is the current one, and it stands in the group'
    fresh = call('add_part')['part']
    assert fresh['parent'] is None and fresh['position'] == [0, 0, 0], 'a new part stands at the origin under nothing, whatever is current: %s' % fresh
    call('undo')
    c = block('Foot C', [10, 10, 10])
    third = call('move_part', part='Foot C', parent='Feet', position=[60, 0, 0])['part']
    assert third['parent'] == fid and third['box'] == [[255, -5, 0], [265, 5, 10]], 'with a parent and a position: there, in the parent\'s frame: %s' % third
    loose = block('Loose', [10, 10, 10], position=[0, 300, 0])
    fails('add_sketch', 'is a group', part='Feet')
    call('edit_part', part='Feet', hidden=False)        # the group is the current part now
    fails('add_sketch', 'current part is a group')
    assert len(call('list_faces', part='Feet')) == 3, 'a listing of a group is of everything in it'
    fails('combine', 'is a group', part='Feet', operation='join', **{'with': ['Loose']})
    fails('move_part', 'under itself', part='Feet', parent='Foot A')
    slab = block('Slab', [100, 20, 4], position=[230, 0, 3])
    cut = call('combine', part='Slab', operation='cut', **{'with': ['Feet']})
    near(vol(cut, slab), 100 * 20 * 4 - 3 * 10 * 10 * 4, 1e-6, 'a group as a tool: everything in it is cut out')
    assert row(cut, 'Feet')['tool_of'] == slab and row(cut, 'Feet')['parent'] == slab
    fails('delete_part', 'with_dependents', part='Feet')
    call('undo')
    blue = call('set_color', part='Feet', color='blue')
    assert blue['part']['color'] == '#2f6fd0' and 'color' not in row(call('get_state'), 'Foot A')
    assert set(p.js('corecad.scene.filter(b => ["Foot A", "Foot B", "Foot C"].includes(corecad.parts.find(x => x.id === b.part).name)).map(b => b.color)')) == {'#2f6fd0'}, 'the colour of the group is the colour of what is in it'
    turned = call('move_part', part='Feet', rotation=[0, 0, 90])
    assert turned['part']['rotation'] == [0, 0, 90] and turned['part']['box'] == [[195, -5, 0], [205, 65, 10]], turned['part']
    whole = call('copy_part', part='Feet')
    assert whole['part']['kind'] == 'group' and whole['part']['name'] == 'Feet copy' and len(whole['part']['contains']) == 3 and whole['part']['box'] == [[195, -5, 0], [205, 65, 10]], whole['part']
    call('undo')
    # a group is taken away by moving out what is in it and deleting what is left
    for child in row(call('get_state'), 'Feet')['contains']:
        call('move_part', part=child, parent=None)
    freed = row(call('get_state'), 'Foot B')
    assert freed['parent'] is None and freed['rotation'] == [0, 0, 90] and freed['box'] == [[195, 25, 0], [205, 35, 10]], freed
    gone = call('delete_part', part='Feet')
    assert gone['deleted'] == {'parts': [fid], 'features': []} and 'Feet' not in [x['name'] for x in gone['parts']], gone['deleted']
    assert {x['name'] for x in gone['parts']} >= {'Foot A', 'Foot B', 'Foot C'}, 'what was in it is still there'
    assert p.js('document.querySelectorAll("[data-part]").length') == len(gone['parts'])
    undo_to(untouched)
    step('add_group makes a container; move_part fills and empties it; a group as a tool; colour, turn, copy')

    # ---- "this": what the person has clicked, and what their mouse rests on
    def page(point):
        return p.js('corecad.screen(' + json.dumps(point) + ')')

    def close(a, b, tol=0.35):
        return len(a) == len(b) and all(abs(x - y) <= tol for x, y in zip(a, b))

    def rest(point):
        """Moves the mouse onto a point of the model and leaves it there: that is pointing."""
        p.move(*page(point), steps=4)
        time.sleep(.45)

    call('new_document', name='Pointing')
    block('Plate', [60, 40, 12])                             # o1: its sketch f1, its body f2
    rod('Pin', 10, 30, position=[15, 0, -5])
    call('combine', part='Plate', operation='cut', **{'with': ['Pin']})
    block('Block', [20, 20, 20], position=[60, 0, 0])        # o3
    twin = call('copy_part', part='Block', linked=True)['part']['id']
    call('edit_part', part=twin, name='Twin')
    call('move_part', part=twin, position=[60, 40, 0])
    call('set_view', view='top')
    none = call('get_selection')
    assert none['selected'] == [] and none['pointed'] is None and none['part']['id'] == twin, none
    assert 'click or point' in fails('add_sketch', 'No face is selected', plane='this')
    fails('fillet', 'No edge is selected', edges='selected', radius=1)
    fails('edit_feature', 'No feature is selected', id='this', name='x')
    fails('move_part', 'has not come to rest', part='pointed', position=[1, 0, 0])

    p.click(*page([-20, 10, 12]))
    sel = call('get_selection')
    face = sel['selected'][0]
    assert len(sel['selected']) == 1 and face['kind'] == 'face' and face['part'] == 'o1' and face['part_name'] == 'Plate' and face['body'] == 'f2', face
    assert face['surface'] == 'plane' and face['side'] == 'top' and face['normal'] == [0, 0, 1] and close(face['point'], [-20, 10, 12]) and close(face['at'], [-20, 10]), face
    assert [(m['id'], m['type'], m['as']) for m in face['made_by']] == [('f2', 'extrude', 'end')] and sel['part'] == {'id': 'o1', 'name': 'Plate'}, sel
    assert 'selection' not in call('get_state') and 'between' not in sel, 'what is selected is asked for in one place'
    here = call('add_sketch', plane='this')
    assert here['part'] == 'o1' and here['sketch']['plane'] == {'face_of_body': 'f2'}, here
    call('add_to_sketch', sketch=here['id'], shapes=[{'type': 'circle', 'center': face['at'], 'diameter': 4}])
    cut = call('extrude', sketch=here['id'], operation='cut', distance=5)
    made = feature(cut['id'])
    assert made['type'] == 'extrude' and made['sketch'] == here['id'] and made['distance'] == 5, made
    solid = 28800 - math.pi * 25 * 12 - math.pi * 4 * 5
    near(vol(cut, 'o1'), solid, what='a hole where the person clicked')
    assert call('get_selection')['selected'] == [], 'what was selected is used up by the change'
    step('"a hole here": a sketch on the face that was clicked, a circle at the point that was clicked, cut')

    # the mouse resting on something is pointing at it; the next "this" is that
    rest([20, -12, 12])
    at = call('get_selection')['pointed']
    assert at and at['kind'] == 'face' and at['side'] == 'top' and close(at['at'], [20, -12]) and at['mouse_in_view'] and at['seconds_ago'] < 5, at
    there = call('add_sketch', plane='pointed')
    call('add_to_sketch', sketch=there['id'], shapes=[{'type': 'circle', 'center': [25, 15], 'diameter': 3}])
    call('extrude', sketch=there['id'], operation='cut', distance=2)
    time.sleep(.45)
    still = call('get_selection')['pointed']
    assert still and still['side'] == 'top' and close(still['at'], [20, -12]), 'the mouse has not moved: it still points there, on the rebuilt body: %s' % still
    again = call('add_sketch', plane='this')        # nothing is selected: "this" is what is pointed at
    call('add_to_sketch', sketch=again['id'], shapes=[{'type': 'circle', 'center': still['at'], 'diameter': 3}])
    again = call('extrude', sketch=again['id'], operation='cut', distance=2)
    solid -= 2 * math.pi * 2.25 * 2
    near(vol(again, 'o1'), solid, what='holes by pointing')
    step('holding the mouse on a face is pointing at it, and it still is after the model is rebuilt')

    # "make this hole deeper, and wider": the feature that made the face, and the sketch behind it
    p.click(*page([-20, 10, 7]))
    floor = call('get_selection')['selected'][0]
    assert [(m['id'], m['type']) for m in floor['made_by']] == [(made['id'], 'extrude')] and abs(floor['center'][2] - 7) < 1e-6, floor
    drawn = call('get_sketch', sketch='this')
    assert drawn['id'] == here['id'], 'the sketch behind the cut that was clicked'
    deeper = call('edit_feature', id='this', distance=6)
    assert deeper['id'] == made['id'] and deeper['type'] == 'extrude'
    solid += math.pi * 4 * 5 - math.pi * 4 * 6
    near(vol(deeper, 'o1'), solid, what='the hole that was clicked, made deeper')
    across = next(d for d in drawn['dimensions'] if d['type'] == 'diameter')
    wider = call('set_dimension', sketch=drawn['id'], dimension=across['id'], value=6)
    solid += math.pi * 4 * 6 - math.pi * 9 * 6
    near(vol(wider, 'o1'), solid, what='and wider, by the dimension of its circle')
    step('"this" as a feature and as a sketch: the ones that made the face that was clicked')

    # edges that were clicked, and a part that was clicked
    call('set_view', view='home')
    picked = 0
    for edge in [[60, -10, 20], [70, 0, 20]]:
        xy = page(edge)
        hit = p.js('corecad.pick(' + json.dumps(xy) + ', "edge")')
        assert hit and hit['type'] == 'edge', (edge, hit)
        p.click(*xy, modifiers=8 if picked else 0)
        picked += 1
    edges = call('get_selection')['selected']
    assert [(e['kind'], e['curve'], e['length'], e['part']) for e in edges] == [('edge', 'line', 20, 'o3')] * 2, edges
    rounded = call('fillet', edges='this', radius=3)
    # two R3 fillets 20 long that meet at a corner: what both would remove there is removed once
    near(vol(rounded, 'o3'), 8000 - 2 * (1 - math.pi / 4) * 9 * 20 + 27 * (5 / 3 - math.pi / 2), what='the two edges that were clicked, rounded')
    call('set_view', view='top')
    p.click(*page([60, 45, 20]))
    chosen = call('get_selection')
    assert chosen['part'] == {'id': twin, 'name': 'Twin'} and chosen['selected'][0]['linked_copy'] and chosen['selected'][0]['part'] == twin, chosen
    assert close(chosen['selected'][0]['point'], [60, 45, 20]), chosen['selected'][0]
    fails('add_sketch', 'linked copy', plane='this')
    moved = call('move_part', part='this', position=[60, 50, 0])
    assert moved['part']['id'] == twin and moved['part']['position'] == [60, 50, 0], moved['part']
    time.sleep(.45)
    assert call('get_selection')['pointed']['part'] == twin, 'the mouse still rests on the copy, where it now stands'
    assert call('move_part', part='pointed', position=[60, 40, 0])['part']['position'] == [60, 40, 0]
    p.key('Escape')
    assert call('get_selection')['pointed'] is None and p.js('corecad.pointed') is None
    step('edges and parts that were clicked or pointed at; a linked copy says what it is; Escape lets go')

    # ---- measuring, and the numbers that drive the model
    call('new_document', name='Measuring')
    call('add_part')
    sketch([{'type': 'rectangle', 'corner': [0, 0], 'width': 60, 'height': 40},
            {'type': 'circle', 'center': [15, 20], 'diameter': 8},
            {'type': 'circle', 'center': [45, 20], 'diameter': 8}])                   # f1
    call('extrude', distance=12)                                                        # f2
    call('fillet', edges={'parallel': 'z', 'kind': 'line'}, radius=4)                   # f3
    sketch([{'type': 'circle', 'center': [30, 32], 'diameter': 5}], plane='top')        # f4
    call('extrude', operation='cut', distance=6)                                        # f5
    faces = call('list_faces')[0]['faces']
    walls = [f['face'] for f in faces if f.get('hole') and f.get('radius') == 4]
    assert len(walls) == 2 and sum(1 for f in faces if f.get('radius') == 4 and not f.get('hole')) == 4, 'holes and fillets are told apart'
    m = call('measure', **{'from': 'top', 'to': 'bottom'})
    assert m['between']['distance'] == 12 and m['between']['what'] == 'between parallel faces' and m['of'][0]['size'] == [60, 40], m
    m = call('measure', **{'from': {'face': walls[0]}, 'to': {'face': walls[1]}})
    assert m['between']['distance'] == 30 and m['between']['what'] == 'between centres' and m['of'][0]['measures'] == 'Hole ⌀ 8 × 12 mm', m
    m = call('measure', **{'from': {'face': walls[0]}, 'to': 'left'})
    assert m['between']['distance'] in (15, 45) and m['between']['what'] == 'hole axis to face', m
    one = call('measure', **{'from': 'front'})
    assert one['of'][0]['size'] == [52, 12] and 'between' not in one, one
    fails('measure', 'Nothing is selected')
    fails('measure', 'from', to='top')
    step('measure: thickness, hole spacing, a hole from a side, the size of a face')

    # what the person sees and clicks: the size where the mouse rests, the distance between two clicked things
    call('set_view', view='home')
    rest([30, 6, 12])
    shown = p.js('corecad.numbers')
    assert [n['text'] for n in shown if n['kind'] == 'pointed'] == ['60', '40'], 'each number along its own side of the face: %s' % shown
    p.click(*page([30, 0, 12]))
    edge = p.js('corecad.selection')
    assert [h['type'] for h in edge] == ['edge'] and [n['text'] for n in p.js('corecad.numbers') if n['kind'] == 'measure'] == ['52'], (edge, p.js('corecad.numbers'))
    p.key('Escape')
    p.click(*page([15, 24, 12]))
    p.click(*page([45, 24, 12]), modifiers=8)
    time.sleep(.2)
    sel = call('get_selection')
    assert [e['kind'] for e in sel['selected']] == ['edge', 'edge'] and sel['selected'][0]['diameter'] == 8 and 'between' not in sel, sel['selected']
    m = call('measure')
    assert m['between']['distance'] == 30 and m['between']['what'] == 'between centres' and [abs(v) for v in m['between']['delta']] == [30, 0, 0], m['between']
    assert p.js('corecad.measured').startswith('Between them: 30 mm (between centres)')
    shown = [n['text'] for n in p.js('corecad.numbers') if n['kind'] == 'measure']
    assert '30 mm' in shown and shown.count('⌀ 8 mm') == 2, shown
    p.key('Escape')
    step('the size where the mouse rests; 30 mm between two clicked holes, for the person and (measure) for the agent')

    # the driving numbers: those of the features in get_state, those of a sketch in get_sketch
    numbers = {f['id']: f for f in call('get_state')['features']}
    assert numbers['f2']['distance'] == 12 and numbers['f3']['radius'] == 4 and numbers['f5']['distance'] == 6, numbers
    drawn = call('get_sketch', sketch='f1')
    width = next(d for d in drawn['dimensions'] if d['type'] == 'horizontal distance' and d['value'] == 60)
    wider = call('set_dimension', sketch='f1', dimension=width['id'], value=80)
    assert wider['bodies'][0]['box'][1][0] == 80, wider['bodies']
    step('the driving numbers: read in get_state and get_sketch, changed with edit_feature and set_dimension')

    # the same numbers on the model: Dimensions (D), click one, type
    p.click('[data-part="o1"]')
    p.key('d')
    labels = p.js('corecad.dimensions')
    assert sorted(l['text'] for l in labels if l['feature'] != 'f1') == sorted(['12', 'R 4', 'Ø 5', '30', '32', '6']) and all(l['editable'] for l in labels), [l['text'] for l in labels]
    overall = [n['text'] for n in p.js('corecad.numbers') if n['kind'] == 'reference']
    assert overall == ['X 80', 'Y 40', 'Z 12'], overall
    thick = next(l for l in labels if l['feature'] == 'f2')
    p.move(thick['x'], thick['y'], steps=3)
    assert [n['text'] for n in p.js('corecad.numbers') if n['kind'] == 'caption'] == ['extrusion distance · Extrude1'], 'the number under the mouse says what it is'
    p.click(thick['x'], thick['y'])
    p.wait('!!document.getElementById("dim-input")')
    assert p.js('document.getElementById("dim-input").value') == '12' and p.js('!!document.getElementById("dim-input").title'), p.js('document.getElementById("dim-input").value')
    p.key('a', modifiers=2)
    p.type('10+5')
    p.key('Enter')
    p.wait('!corecad.busy && !document.getElementById("dim-input") && corecad.build.bodies[0].bbox[1][2] === 15', timeout=30)
    assert p.js('corecad.doc.features[1].extent.distance') == 15, p.js('corecad.doc.features[1].extent')
    # a number that cannot be built is refused, and the box stays open with the old model
    rad = next(l for l in p.js('corecad.dimensions') if l['text'] == 'R 4')
    p.click(rad['x'], rad['y'])
    p.wait('!!document.getElementById("dim-input")')
    p.key('a', modifiers=2)
    p.type('500')
    p.key('Enter')
    p.wait('!corecad.busy && document.getElementById("toast").textContent.includes("cannot be built")', timeout=30)
    assert p.js('!!document.getElementById("dim-input")') and p.js('corecad.doc.features[2].radius') == 4, 'the refused number changed nothing, and can be typed again'
    # the clicked number is "this" for the agent
    chosen = call('get_selection')['dimension']
    assert chosen['is'] == 'fillet radius' and chosen['change_with'] == 'edit_feature' and chosen['arguments'] == {'id': 'f3', 'radius': 4}, chosen
    fails('set_dimension', 'not a sketch dimension', dimension='this', value=2)
    assert call('edit_feature', id='this', radius=2)['id'] == 'f3', 'the feature of the number that was clicked'
    high = next(l for l in p.js('corecad.dimensions') if l['text'] == '40')
    p.click(high['x'], high['y'])
    p.wait('!!document.getElementById("dim-input")')
    assert call('get_selection')['dimension']['is'] == 'vertical distance', call('get_selection')
    taller = call('set_dimension', dimension='this', value=50)
    assert taller['bodies'][0]['box'][1][1] == 50, taller['bodies']
    p.key('Escape')
    shot = call('screenshot', dimensions=False, max=500)
    assert shot['width'] <= 500 and p.js('document.getElementById("dimensions").classList.contains("on")'), 'a picture without the numbers leaves the view as the person had it'
    p.key('d')
    assert not p.js('document.getElementById("dimensions").classList.contains("on")')
    assert p.js('corecad.dimensions') == [], 'a feature that a command selected does not put its numbers over the model'
    p.click('[data-feature="f2"]')
    assert {l['feature'] for l in p.js('corecad.dimensions')} == {'f1', 'f2'}, 'a feature clicked in the history shows its own numbers (an extrusion with its sketch)'
    p.click('[data-part="o1"]')
    assert p.js('corecad.dimensions') == [], p.js('corecad.dimensions')
    step('Dimensions: click a number and type; a number that cannot be built is refused; the clicked number is "this"')

    # ---- what a person makes with the page's own Box and Hole tools is changed with edit_feature
    def fill(selector, value):
        p.click(selector)
        p.key('a', modifiers=2)
        p.type(str(value))

    def accept():
        p.wait('!document.getElementById("apply-feature").disabled')
        p.click('#apply-feature')
        p.wait('!corecad.busy && !corecad.draft', timeout=30)

    call('new_document', name='By hand')
    p.key('b')
    p.wait('corecad.draft && corecad.draft.type === "box"')
    fill('#box-x', 60)
    fill('#box-y', 40)
    fill('#box-z', 12)
    accept()
    box = call('get_state')['features'][0]
    assert box['type'] == 'box' and box['size'] == [60, 40, 12] and box['part'] == 'o1', box
    taller = call('edit_feature', id=box['id'], size=[60, 40, 20])
    assert taller['bodies'][0]['box'] == [[-30, -20, 0], [30, 20, 20]], taller['bodies']
    call('set_view', view='top')
    p.click(*page([20, 10, 20]))
    p.key('h')
    p.wait('corecad.draft && corecad.draft.type === "hole"')
    fill('#hole-diameter', 6)
    accept()
    drilled = call('get_state')['features'][-1]
    assert drilled['type'] == 'hole' and drilled['through_all'] is True and drilled['diameter'] == 6 and close(drilled['at'], [20, 10]), drilled
    blind = call('edit_feature', id=drilled['id'], diameter=8, depth=5)
    near(volume(blind), 48000 - math.pi * 16 * 5, what='the hole a person drilled, made wider and blind by command')
    assert call('edit_feature', id=box['id'], origin='corner')['bodies'][0]['box'] == [[0, 0, 0], [60, 40, 20]]
    # an extrusion: the other way too, and not; half to each side is something a person chooses in the page
    pid = call('add_part')['part']['id']
    s = sketch([{'type': 'rectangle', 'corner': [100, 0], 'width': 10, 'height': 10}], part=pid)
    e = call('extrude', sketch=s['id'], distance=10)['id']
    zs = lambda result: [next(b for b in result['bodies'] if b['part'] == pid)['box'][i][2] for i in (0, 1)]
    assert zs(call('edit_feature', id=e, distance2=4)) == [-4, 10] and feature(e)['distance2'] == 4
    assert zs(call('edit_feature', id=e, distance2=0)) == [0, 10] and 'distance2' not in feature(e)
    fails('edit_feature', 'no argument "symmetric"', id=e, symmetric=True)
    fails('extrude', 'no argument "symmetric"', sketch=s['id'], distance=5, symmetric=True)
    by_hand = call('get_document')
    next(f for f in by_hand['features'] if f['id'] == e)['extent'] = {'type': 'symmetric', 'distance': 10}
    call('load_document', document=by_hand)
    assert feature(e).get('symmetric') is True
    assert zs(call('edit_feature', id=e, distance=20)) == [-10, 10], 'it stays half to each side when its distance is changed'
    assert zs(call('edit_feature', id=e, distance2=5)) == [-5, 20] and 'symmetric' not in feature(e), 'until it is given a second distance'
    step('a box and a hole made in the page are changed with edit_feature; an extrusion goes two ways, or one')

    # ---- revolve: closed regions of a sketch turned about one of its lines
    untouched = call('get_document')
    pid = call('add_part')['part']['id']
    s = sketch([{'type': 'rectangle', 'corner': [8, 0], 'width': 6, 'height': 10},
                {'type': 'line', 'from': [0, 0], 'to': [0, 5], 'construction': True}], plane='XZ', part=pid)
    lines = [e for e in s['sketch']['entities'] if e['type'] == 'line']
    axis = next(e['id'] for e in lines if e.get('construction'))
    ring = call('revolve', axis=axis)
    rid = ring['id']
    assert ring['type'] == 'revolve' and ring['status'] == 'ok' and ring['name'] == 'Revolve1' and ring['part'] == pid == s['part'], ring
    near(vol(ring, pid), math.pi * (14 ** 2 - 8 ** 2) * 10, 1e-2, 'a ring')
    assert next(b for b in ring['bodies'] if b['part'] == pid)['box'] == [[-14, -14, 0], [14, 14, 10]], 'drawn on XZ about its upright line: it stands on Z'
    assert {k: feature(rid)[k] for k in ('sketch', 'axis', 'angle', 'operation', 'profiles')} == {'sketch': s['id'], 'axis': axis, 'angle': 360, 'operation': 'new', 'profiles': 1}
    quarter = call('edit_feature', id=rid, angle=90)
    near(vol(quarter, pid), math.pi * 132 * 10 / 4, 1e-2, 'a quarter of it')
    assert next(b for b in quarter['bodies'] if b['part'] == pid)['box'] == [[0, -14, 0], [14, 0, 10]], 'XZ faces -Y: the turn goes that way'
    other = call('edit_feature', id=rid, flip=True)
    assert next(b for b in other['bodies'] if b['part'] == pid)['box'] == [[0, 0, 0], [14, 14, 10]]
    # about a side of its own outline: the line at x = 14
    side = next(e['id'] for e in lines if e['from'][0] == 14 and e['to'][0] == 14)
    solid = call('edit_feature', id=rid, axis=side, angle=360)
    near(vol(solid, pid), math.pi * 36 * 10, 1e-2, 'a cylinder of radius 6 about x = 14')
    # a groove cut into it, in the same part: the default is to join, a cut is said
    g = sketch([{'type': 'rectangle', 'corner': [18, 4], 'width': 4, 'height': 2},
                {'type': 'line', 'from': [14, 0], 'to': [14, 3], 'construction': True}], plane='XZ', part=pid)
    gaxis = next(e['id'] for e in g['sketch']['entities'] if e.get('construction'))
    cut = call('revolve', axis=gaxis, operation='cut')
    near(vol(cut, pid), math.pi * 36 * 10 - math.pi * (36 - 16) * 2, 1e-2, 'a groove 2 deep and 2 high')
    assert len([b for b in cut['bodies'] if b['part'] == pid]) == 1
    # what is refused, and why
    before = call('get_document')
    fails('revolve', 'is the id of a line', sketch=s['id'], axis='e1')
    fails('revolve', 'needs "axis"', sketch=s['id'])
    fails('revolve', 'at most 360', sketch=s['id'], axis=axis, angle=400)
    fails('revolve', 'more than 0', sketch=s['id'], axis=axis, angle=0)
    fails('revolve', 'no argument "name"', sketch=s['id'], axis=axis, name='Ring')
    fails('edit_feature', 'at most 360', id=rid, angle=-90)
    fails('edit_feature', 'it has no distance', id=rid, distance=5)
    assert call('get_document') == before
    # in the page: a row in the history, its number on the model, typed over there; no dialog
    p.click(f'[data-feature="{rid}"]')
    label = next(l for l in p.js('corecad.dimensions') if l['feature'] == rid)
    assert label['key'] == 'angle' and label['text'] == '360°' and label['editable'], label
    p.click(label['x'], label['y'])
    p.wait('!!document.querySelector(".dim-input")')
    p.key('a', modifiers=2)
    p.type('180')
    p.key('Enter')
    p.wait('!corecad.busy && corecad.doc.features.find(f => f.id === ' + json.dumps(rid) + ').angle === 180')
    near(vol(call('get_state'), pid), (math.pi * 36 * 10 - math.pi * 20 * 2) / 2, 1e-2, 'half of it, by the number on the model')
    p.js('document.querySelector(' + json.dumps(f'[data-feature="{rid}"]') + ').dispatchEvent(new MouseEvent("dblclick", {bubbles: true}))')
    assert 'has no dialog' in p.js('document.getElementById("toast").textContent') and not p.js('!!corecad.draft')
    p.screenshot(ROOT / '.scratch' / 'e2e_api_revolve.png')
    undo_to(untouched)
    step('revolve: a ring, part of a turn and the other way, about a side of the outline, a groove cut; its angle on the model')

    # ---- revolve with a rise: a thread is one feature, a tooth that climbs its axis as it turns
    call('new_document', name='Thread')

    def moment(pts):
        """The first moment of an outline about the line x = 0: times the angle it turns through, its volume."""
        return abs(sum((x0 + x1) * (x0 * y1 - x1 * y0) for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]))) / 6

    P, k0 = 3.5, 1.3 / 2.7                                                              # the rise in a turn; how a flank leans
    bolt = rod('Bolt', 25.2, 30)                                                        # radius 12.6, z 0..30
    tooth = [[12.3, 1.0], [15, 2.3], [15, 2.7], [12.3, 4.0]]                             # reaches 0.3 into the rod: its flanks cross the wall
    outside = [[12.6, 1.0 + 0.3 * k0], [15, 2.3], [15, 2.7], [12.6, 4.0 - 0.3 * k0]]
    t = sketch([{'type': 'polyline', 'points': tooth, 'closed': True},
                {'type': 'line', 'from': [0, 0], 'to': [0, 10], 'construction': True}], plane='XZ', part=bolt)
    axis = next(e['id'] for e in t['sketch']['entities'] if e.get('construction'))
    before = call('get_document')
    fails('revolve', 'More than a turn needs a rise', sketch=t['id'], axis=axis, angle=720)
    fails('revolve', 'Only a turn with a rise', sketch=t['id'], axis=axis, left_handed=True)
    fails('revolve', '36000', sketch=t['id'], axis=axis, rise=P, angle=36001)
    fails('revolve', 'one turn would run into the next', sketch=t['id'], axis=axis, rise=2.5, angle=720)
    assert call('get_document') == before, 'a thread that is refused leaves nothing behind'
    thread = call('revolve', sketch=t['id'], axis=axis, rise=P, angle=360 * 7)          # seven turns, joined: the part has a body
    tid = thread['id']
    assert thread['status'] == 'ok' and len([b for b in thread['bodies'] if b['part'] == bolt]) == 1, thread
    core = math.pi * 12.6 ** 2 * 30
    near(vol(thread, bolt), core + moment(outside) * 2 * math.pi * 7, 0.2, 'the rod and what of the tooth is outside it')
    box = next(b for b in thread['bodies'] if b['part'] == bolt)['box']
    assert [[round(v, 2) for v in c] for c in box] == [[-15, -15, 0], [15, 15, 30]], box
    assert {k: feature(tid).get(k) for k in ('angle', 'rise', 'left_handed', 'operation')} == {'angle': 2520, 'rise': 3.5, 'left_handed': None, 'operation': 'join'}, feature(tid)
    near(vol(call('edit_feature', id=tid, angle=1800), bolt), core + moment(outside) * 2 * math.pi * 5, 0.2, 'five turns')
    near(vol(call('edit_feature', id=tid, left_handed=True), bolt), core + moment(outside) * 2 * math.pi * 5, 0.2, 'left-handed: as much of it')
    assert feature(tid)['left_handed'] is True
    fails('edit_feature', 'More than a turn needs a rise', id=tid, rise=0)
    fails('edit_feature', 'one turn would run into the next', id=tid, rise=3)
    call('edit_feature', id=tid, left_handed=False, angle=360 * 7)
    # the numbers on the model: the angle, and the rise drawn on the axis; the rise is typed over there
    p.click(f'[data-feature="{tid}"]')
    labels = {l['key']: l for l in p.js('corecad.dimensions') if l['feature'] == tid}
    assert labels['angle']['text'] == '2520°' and labels['rise']['text'] == '3.5' and labels['rise']['editable'], labels
    p.click(labels['rise']['x'], labels['rise']['y'])
    p.wait('!!document.querySelector(".dim-input")')
    p.key('a', modifiers=2)
    p.type('3.6')
    p.key('Enter')
    p.wait('!corecad.busy && corecad.doc.features.find(f => f.id === ' + json.dumps(tid) + ').rise === 3.6')
    near(vol(call('get_state'), bolt), core + moment(outside) * 2 * math.pi * 7, 0.2, 'the same thread at another rise, by the number on the model')
    call('edit_feature', id=tid, rise=P)
    # the nut: a block with a hole as anyone makes one, and the same tooth 0.3 bigger cut out of it. The groove
    # runs out through both faces. (The kernel loses this cut made one way; the page then makes it the other way.)
    nut = block('Nut', [40, 40, 10])
    h = sketch([{'type': 'circle', 'center': [0, 0], 'diameter': 25.8}], part=nut)
    call('extrude', sketch=h['id'], operation='cut', through_all=True)
    groove = [[12.6, -4.65], [15.3, -3.35], [15.3, -2.65], [12.6, -1.35]]
    gout = [[12.9, -4.65 + 0.3 * k0], [15.3, -3.35], [15.3, -2.65], [12.9, -1.35 - 0.3 * k0]]
    g = sketch([{'type': 'polyline', 'points': groove, 'closed': True},
                {'type': 'line', 'from': [0, 0], 'to': [0, 10], 'construction': True}], plane='XZ', part=nut)
    gaxis = next(e['id'] for e in g['sketch']['entities'] if e.get('construction'))
    cut = call('revolve', sketch=g['id'], axis=gaxis, rise=P, angle=1620, operation='cut')
    assert cut['status'] == 'ok', cut
    near(vol(cut, nut), 16000 - 10 * (math.pi * 12.9 ** 2 + 2 * math.pi * moment(gout) / P), 1, 'the thread is the same in every slice of the nut')
    # a tooth that only stands on the rod is not joined, and the answer says what helps
    stand = sketch([{'type': 'polyline', 'points': [[12.6, 1.0], [15, 2.3], [15, 2.7], [12.6, 4.0]], 'closed': True},
                    {'type': 'line', 'from': [0, 0], 'to': [0, 10], 'construction': True}], plane='XZ', part=part('Stands'))
    rod_only = sketch([{'type': 'circle', 'center': [0, 0], 'diameter': 25.2}], part=stand['part'])
    call('extrude', sketch=rod_only['id'], distance=30)
    stood = call('revolve', sketch=stand['id'], axis=next(e['id'] for e in stand['sketch']['entities'] if e.get('construction')), rise=P, angle=720)
    assert 'must cross the surface of the body' in json.dumps(stood), stood
    call('delete_part', part=stand['part'])
    # the nut on the bolt, cut open: the picture a person looks at
    call('move_part', part=nut, position=[0, 0, 12.5])                                  # where its grooves lie round the bolt's teeth
    call('set_color', part=nut, color='orange')
    call('set_view', view='front')
    call('set_section', plane='XZ', flip=True)                                          # the front half away: the cut faces the eye
    time.sleep(.3)
    p.screenshot(ROOT / '.scratch' / 'e2e_api_thread_section.png')
    call('set_section', plane=None)
    call('set_view', view='home')
    p.screenshot(ROOT / '.scratch' / 'e2e_api_thread.png')
    step('revolve with a rise: a bolt and its nut, each thread one feature; turns, rise and hand changed; what is refused; the rise on the model')

    # ---- import: a STEP file as a part, the parts of another project
    call('new_document', name='Bracket')
    block('Plate', [60, 40, 10])                                                        # o1: x -30..30, y -20..20, z 0..10
    h = sketch([{'type': 'circle', 'center': [10, 5], 'diameter': 8}], plane='top')
    call('extrude', sketch=h['id'], operation='cut', through_all=True)
    rod('Peg', 6, 30, position=[-20, 0, 0])
    bracket = call('get_document')
    plate_volume = 24000 - math.pi * 16 * 10
    step_text = call('export', format='step', part='Plate')['text']
    # into another project, beside what is there
    call('new_document', name='Bench')
    block('Table', [100, 80, 5])
    table = call('get_state')['parts'][0]['id']
    before = call('get_document')
    fails('import', 'needs "format"', content=step_text)
    fails('import', 'not the text of a STEP file', format='step', content='solid ascii')
    fails('import', 'STEP file', format='step', content='ISO-10303-21;\nHEADER;\nnot much of a file')
    fails('import', 'not JSON', format='corecad', content='{ not json')
    fails('import', 'Not a valid CoreCAD project', format='corecad', content={'format': 'something else'})
    fails('import', 'nothing to bring in', format='corecad', content=json.dumps({**bracket, 'parts': [], 'features': [], 'bodies': {}}))
    assert call('get_document') == before, 'what is refused brings nothing in'
    fails('import', 'no argument "name"', format='step', content=step_text, name='Bought plate')
    got = call('import', format='step', content=step_text)
    fid = got['id']
    assert got['type'] == 'import' and got['status'] == 'ok' and got['name'] == 'Import1', got
    bought = got['part']
    row = next(r for r in call('get_state')['parts'] if r['id'] == bought)
    assert row['name'] == 'Imported 1' and bought != table, row
    call('edit_part', part=bought, name='Bought plate')                                 # a name is given where names are given
    near(vol(got, bought), plate_volume, 1e-2, 'the solid of the STEP file')
    assert next(b for b in got['bodies'] if b['part'] == bought)['box'] == [[-30, -20, 0], [30, 20, 10]], 'where it stood in its file'
    assert feature(fid)['format'] == 'step' and feature(fid)['bytes'] == len(step_text), feature(fid)
    assert 'gzip' in next(f for f in call('get_document')['features'] if f['id'] == fid)['data'] and len(json.dumps(call('get_document'))) < len(step_text) / 2 + len(json.dumps(before)), 'kept small in the project'
    # it is a part like any other: moved, built on, an edge of it rounded; it has no numbers to change
    call('move_part', part=bought, position=[0, 0, 5])
    top = sketch([{'type': 'rectangle', 'center': [-20, 0], 'width': 10, 'height': 10}], plane={'part': 'Bought plate', 'side': 'top'})
    boss = call('extrude', sketch=top['id'], distance=4)
    near(vol(boss, bought), plate_volume + 400, 1e-2, 'a boss on a face of what was imported')
    near(vol(call('fillet', edges={'part': 'Bought plate', 'parallel': 'z', 'kind': 'line', 'on': 'right'}, radius=3), bought), plate_volume + 400 - 2 * (9 - math.pi * 2.25) * 10, 0.05, 'two of its corners rounded')
    fails('edit_feature', 'it has no distance', id=fid, distance=5)
    assert call('edit_feature', id=fid, name='The bought plate')['name'] == 'The bought plate'
    stands = call('measure', **{'from': {'part': 'Bought plate', 'side': 'bottom'}, 'to': {'part': 'Table', 'side': 'top'}})
    assert abs(stands['between']['distance']) < 1e-6, stands
    # the parts of another project: with their histories, in a group, and still to be changed
    parts_before = len(call('get_state')['parts'])
    came = call('import', format='corecad', content=bracket)
    assert came['group'] and len(came['parts']) == 2 and came['part']['name'] == 'Bracket' and came['part']['id'] == came['group'], came
    state = call('get_state')
    assert len(state['parts']) == parts_before + 3, 'two parts and their group'
    names = {r['id']: r['name'] for r in state['parts']}
    plate2 = next(i for i in came['parts'] if names[i].startswith('Plate'))
    assert sorted(names[i] for i in came['parts']) == ['Peg', 'Plate'] and all(next(r for r in state['parts'] if r['id'] == i)['parent'] == came['group'] for i in came['parts']), names
    near(vol(came, plate2), plate_volume, 1e-2, 'the plate that came in')
    ext = next(f for f in state['features'] if f['part'] == plate2 and f['type'] == 'extrude' and f.get('distance') == 10)
    near(vol(call('edit_feature', id=ext['id'], distance=20), plate2), 2 * plate_volume, 1e-2, 'its history came with it: its height is changed')
    call('move_part', part=came['group'], position=[0, 60, 0])
    assert next(b for b in call('get_state')['bodies'] if b['part'] == plate2)['box'] == [[-30, 40, 0], [30, 80, 20]], 'the group moves what came in'
    again = call('import', format='corecad', content=json.dumps(bracket))
    assert again['part']['name'] == 'Bracket (2)' and {'Plate (2)', 'Peg (2)'} <= {r['name'] for r in call('get_state')['parts']}, again['part']
    one = call('import', format='corecad', content={**bracket, 'parts': bracket['parts'][:1], 'features': [f for f in bracket['features'] if f['part'] == bracket['parts'][0]['id']]})
    assert one['group'] is None and one['part']['name'] == 'Plate (3)', 'a project of one part comes without a group'
    call('undo')
    assert 'Plate (3)' not in {r['name'] for r in call('get_state')['parts']}, 'an import is one undo step'
    # the Import button: a STEP file and a project from the disk
    files = ROOT / '.scratch' / 'import-files'
    files.mkdir(parents=True, exist_ok=True)
    (files / 'bought.step').write_text(step_text, encoding='utf-8')
    (files / 'bracket.corecad').write_text(json.dumps(bracket), encoding='utf-8')
    (files / 'notes.step').write_text('just some notes', encoding='utf-8')
    root = p.call('DOM.getDocument')['root']['nodeId']
    node = p.call('DOM.querySelector', nodeId=root, selector='#import-input')['nodeId']
    count = len(call('get_state')['parts'])
    p.call('DOM.setFileInputFiles', nodeId=node, files=[str(files / 'bought.step')])
    p.wait(f'!corecad.busy && corecad.doc.parts.length === {count + 1} && corecad.doc.parts.at(-1).name === "bought"', timeout=30)
    assert 'Imported bought.step' in p.js('document.getElementById("toast").textContent')
    assert p.js('!!document.querySelector(\'[data-feature="\' + corecad.doc.features.at(-1).id + \'"]\')'), 'its row in the history'
    p.call('DOM.setFileInputFiles', nodeId=node, files=[str(files / 'bracket.corecad')])
    p.wait(f'!corecad.busy && corecad.doc.parts.length === {count + 4}', timeout=30)
    p.call('DOM.setFileInputFiles', nodeId=node, files=[str(files / 'notes.step')])
    p.wait('document.getElementById("toast").textContent.includes("could not be imported")', timeout=30)
    assert p.js('corecad.doc.parts.length') == count + 4
    p.screenshot(ROOT / '.scratch' / 'e2e_api_import.png')
    step('import: a STEP file as a part that is moved, built on and rounded; another project\'s parts with their histories, in a group; the Import button; what is refused')

    # ---- looking inside: the model cut open along a plane, and see-through
    call('new_document', name='Inside')
    block('Housing', [60, 40, 30])                                                      # o1: f1, f2; x -30..30, y -20..20, z 0..30
    sketch([{'type': 'rectangle', 'center': [0, 0], 'width': 40, 'height': 20}], plane='top')
    call('extrude', operation='cut', distance=20)                                       # a pocket: x -20..20, y -10..10, down to z = 10
    rod('Pin', 8, 22, position=[10, 0, 10])                                             # o2 stands in it
    call('set_color', part='Pin', color='orange')
    call('set_view', view='home')
    housing, pin = [b['id'] for b in call('get_state')['bodies']]
    look = call('get_selection')['looking']
    assert look == {'camera': {'view': 'home', 'towards': [-0.5774, 0.5774, -0.5774], 'up': [-0.4082, 0.4082, 0.8165], 'projection': 'orthographic'}, 'section': None, 'xray': False}, look
    assert p.js('document.getElementById("sectionbar").hidden')

    def colour_at(point):
        """The colour of the picture where a point of space is seen: [r, g, b]."""
        shot = call('screenshot', max=4000)
        return p.js("""(async () => {
            const img = new Image(); img.src = %s; await img.decode();
            const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
            const g = c.getContext('2d'); g.drawImage(img, 0, 0);
            const r = document.querySelector('canvas.overlay').getBoundingClientRect(), at = corecad.screen(%s), k = img.width / r.width;
            return [...g.getImageData(Math.round((at[0] - r.left) * k), Math.round((at[1] - r.top) * k), 1, 1).data].slice(0, 3);
        })()""" % (json.dumps(shot['png']), json.dumps(point)))

    # the person cuts it open: Section takes the upright plane across the view and takes away the half nearer the eye
    wall_whole = colour_at([-25, 0, 15])
    p.click('#section')
    time.sleep(.2)
    look = call('get_selection')['looking']
    assert look['section'] == {'plane': 'XZ', 'at': 0, 'flip': True, 'text': 'cut along XZ at y = 0 mm: everything with y below that is taken away'}, look
    assert not p.js('document.getElementById("sectionbar").hidden') and p.js('document.getElementById("section").classList.contains("on")')
    assert p.js('document.getElementById("section-at").value') == '0' and p.js('document.querySelector("#sectionbar .on").textContent') == 'XZ'
    # the cut through each solid is filled in, in its own colour, darker
    cut_wall, cut_pin, air = colour_at([-25, 0, 15]), colour_at([10, 0, 20]), colour_at([-10, 0, 20])
    assert all(105 < v < 180 for v in cut_wall) and max(cut_wall) - min(cut_wall) < 30 and cut_wall != wall_whole, 'the cut through the housing is its grey, darker: %s (whole: %s)' % (cut_wall, wall_whole)
    assert cut_pin[0] > cut_pin[1] + 40 > cut_pin[2] + 60, 'the cut through the pin is its orange, darker: %s' % cut_pin
    assert air != cut_wall and air != cut_pin, 'where the cut passes through the pocket nothing is filled in: %s' % air
    step('Section in the view bar: the model is cut open towards the eye, the cuts are filled in each part\'s colour, get_selection says how')

    # what the cut shows can be pointed at and measured; the cut itself is the part
    assert p.js('corecad.cutAt(%s)' % json.dumps(page([-25, 0, 15]))) == housing and p.js('corecad.cutAt(%s)' % json.dumps(page([10, 0, 20]))) == pin
    assert p.js('corecad.pick(%s)' % json.dumps(page([-25, 0, 15]))) is None, 'the cut is not a face'
    rest([-10, 10, 15])                                                                 # the far wall of the pocket, seen through the cut
    shown = [n['text'] for n in p.js('corecad.numbers') if n['kind'] == 'pointed']
    assert shown == ['40', '20'], 'the wall inside says how big it is: %s' % shown
    inside = call('get_selection')['pointed']
    assert inside['kind'] == 'face' and inside['part'] == 'o1' and close(inside['point'], [-10, 10, 15]), inside
    p.click(*page([-10, 5, 10]))                                                        # the floor of the pocket
    p.click(*page([-25, 15, 30]), modifiers=8)                                          # and the top of the housing
    time.sleep(.2)
    m = call('measure')
    assert m['between']['distance'] == 20 and m['between']['what'] == 'between parallel faces', m
    assert p.js('corecad.measured').startswith('Between them: 20 mm (between parallel faces)')
    p.click(*page([10, 0, 20]))                                                         # the cut through the pin
    assert p.js('corecad.selection') == [] and p.js('corecad.selectedPart') == 'o2', (p.js('corecad.selection'), p.js('corecad.selectedPart'))
    assert p.js('document.getElementById("context-note").textContent').startswith('The cut through Pin')
    step('inside: a wall seen through the cut says its size, the depth of the pocket is measured between two clicked faces, a click on a cut is the part')

    # the cut is moved by its arrow, by the number, and to another plane
    arrow = p.js('corecad.sectionArrow')
    along = [arrow['b'][0] - arrow['a'][0], arrow['b'][1] - arrow['a'][1]]
    grip = [arrow['a'][0] + along[0] * .7, arrow['a'][1] + along[1] * .7]
    p.drag(grip[0], grip[1], grip[0] + along[0] * .5, grip[1] + along[1] * .5, steps=8)
    at = call('get_selection')['looking']['section']['at']
    assert at < -2 and at == round(at), 'dragged along its arrow, the cut moves towards the eye in whole millimetres: %s' % at
    assert float(p.js('document.getElementById("section-slider").value')) == at and float(p.js('document.getElementById("section-at").value')) == at, 'the slider and the number follow the arrow'
    p.click('#section-at')
    p.key('a', modifiers=2)
    p.type('10/2')
    p.key('Enter')
    assert call('get_selection')['looking']['section']['at'] == 5 and float(p.js('document.getElementById("section-slider").value')) == 5, 'a typed place, arithmetic and all: %s' % call('get_selection')['looking']['section']
    p.click('[data-action="section-XY"]')
    look = call('get_selection')['looking']['section']
    assert look == {'plane': 'XY', 'at': 16, 'flip': False, 'text': 'cut along XY at z = 16 mm: everything with z above that is taken away'}, look
    rest([-10, 5, 10])                                                                  # the floor, from above now
    shown = [n['text'] for n in p.js('corecad.numbers') if n['kind'] == 'pointed']
    assert shown == ['40', '20'], 'the floor of the pocket, seen from above through the cut: %s' % shown
    p.click('[data-action="section-flip"]')
    assert call('get_selection')['looking']['section']['flip'] is True, 'Flip shows the other half'
    assert p.js('corecad.pick(%s).world[2]' % json.dumps(page([-10, 5, 10]))) > 15.9, 'the other half: the floor is gone, the top is what is met'
    p.click('[data-action="section-off"]')
    assert call('get_selection')['looking']['section'] is None and p.js('document.getElementById("sectionbar").hidden') and not p.js('document.getElementById("section").classList.contains("on")'), 'Whole puts the model back'
    assert colour_at([-25, 0, 15]) == wall_whole, 'whole again, the picture is what it was'
    step('the cut follows its arrow in whole millimetres, takes a typed place, changes plane and side, and is taken away again')

    # see-through: every edge shows, and a hidden one can be clicked
    rim = page([14, 0, 10])                                                             # the rim of the pin's foot, behind the right wall of the housing
    front = colour_at([-10, -20, 15])
    p.click(*rim)
    assert [h['type'] for h in p.js('corecad.selection')] == ['face'], 'solid, the click takes the face in front: %s' % p.js('corecad.selection')
    p.click('#xray')
    time.sleep(.2)
    assert call('get_selection')['looking']['xray'] is True and p.js('document.getElementById("xray").classList.contains("on")'), 'X-ray is on'
    p.click(*rim)
    sel = call('get_selection')['selected']
    assert [e['kind'] for e in sel] == ['edge'] and sel[0]['part'] == 'o2' and sel[0]['diameter'] == 8, 'see-through, the edge behind is taken: %s' % sel
    assert colour_at([-10, -20, 15]) != front, 'the front of the housing is drawn see-through'
    p.click('#xray')
    assert call('get_selection')['looking']['xray'] is False and colour_at([-10, -20, 15]) == front, 'solid again'
    p.key('Escape')
    step('X-ray: the solids are see-through and an edge that was hidden is clicked and measured')

    # the same for an agent: set_section and set_xray change the picture, not the model
    before = call('get_document')
    cut = call('set_section', plane='YZ', at=10)
    assert cut == {'section': {'plane': 'YZ', 'at': 10, 'flip': False, 'text': 'cut along YZ at x = 10 mm: everything with x above that is taken away'}}, cut
    assert call('get_selection')['looking']['section'] == cut['section'] and not p.js('document.getElementById("sectionbar").hidden')
    assert p.js('document.querySelector("#sectionbar .on").textContent') == 'YZ' and p.js('document.getElementById("section-at").value') == '10'
    orange = colour_at([10, 0, 20])
    assert orange[0] > orange[1] + 40, 'the picture an agent takes shows the cut through the pin: %s' % orange
    assert call('set_section', plane='xz')['section'] == {'plane': 'XZ', 'at': 0, 'flip': False, 'text': 'cut along XZ at y = 0 mm: everything with y above that is taken away'}, 'left out, "at" is the middle of the model'
    fails('set_section', '"XY", "XZ" or "YZ"', plane='top')
    fails('set_section', '"at" is a number', plane='XY', at='high')
    fails('set_section', 'needs "plane"')
    # while a sketch is drawn the model is whole: there the plane of the sketch is what is looked at
    cut = call('set_section', plane='XY', at=16)['section']
    p.click('[data-plane="XY"]')
    p.wait('corecad.editing')
    assert call('get_selection')['looking']['section'] is None, 'no cut while a sketch is drawn'
    call('cancel_edit')
    assert call('get_selection')['looking']['section'] == cut, 'and cut open again when the sketch is closed'
    assert call('set_section', plane=None) == {'section': None}
    assert call('set_xray', on=True) == {'xray': True} and call('get_selection')['looking']['xray'] is True
    fails('set_xray', 'true or false', on='yes')
    assert call('set_xray', on=False) == {'xray': False}
    assert content(call('get_document')) == content(before), 'looking inside changes nothing in the model'
    step('set_section and set_xray: the cut and the see-through for an agent; the model is untouched')

    # ---- one way to do each thing: these commands and no others; making takes neither a name, a place nor contents
    names = p.js('corecad.tools.map(t => t.name)')
    assert names == COMMANDS, sorted(set(names) ^ set(COMMANDS))
    takes = p.js('Object.fromEntries(corecad.tools.map(t => [t.name, Object.keys(t.input.properties)]))')
    assert takes['add_part'] == [] and takes['add_group'] == [] and takes['copy_part'] == ['part', 'linked'] and takes['add_sketch'] == ['plane', 'part'], takes
    assert takes['move_part'] == ['part', 'position', 'rotation', 'parent'] and takes['screenshot'] == ['max', 'dimensions'] and takes['export'] == ['format', 'part', 'per_part', 'download'], takes
    assert [t for t in names if 'name' in takes[t]] == ['new_document', 'edit_feature', 'edit_part'], 'a name is given in one place'
    assert [t for t in names if 'position' in takes[t]] == ['move_part'] and [t for t in names if 'shapes' in takes[t]] == ['add_to_sketch']
    for gone in GONE:
        fails(gone, 'Unknown command "%s"' % gone)
    st = call('get_state')
    build = st['app']['build']
    assert re.fullmatch(r'[0-9a-f]{10}', build) and st['app'] == {'build': build, 'update_available': False} and p.js('corecad.version') == build, st['app']
    step('%d commands, each the only way to do what it does' % len(names))

    # ---- a tab older than what is published: it says so, and a command (or the person) reloads it
    update = 'document.getElementById("update-button")'
    assert p.js(update + '.hidden') is True and p.js(update + '.getClientRects().length') == 0
    newer = "export const BUILD = '0123456789';"
    assert p.js('corecad.checkUpdate(async () => ' + json.dumps(newer) + ')') == '0123456789'
    assert p.js(update + '.hidden') is False and p.js('!!' + update + '.title') and p.js(update + '.getClientRects().length') == 1
    assert call('get_state')['app'] == {'build': build, 'update_available': True, 'newest': '0123456789', 'how': 'reload_app loads it'}
    p.click('[data-part="o1"]')
    p.key('b')
    p.wait('corecad.draft && corecad.draft.type === "box"')
    fails('reload_app', 'reloading would lose it')
    p.click('#update-button')
    assert 'Finish or cancel' in p.js('document.getElementById("toast").textContent') and p.js('!!corecad.draft'), 'nor does the button reload over an open dialog'
    call('cancel_edit')
    doc = call('get_document')
    p.js('window.__old = true')
    out = call('reload_app')
    assert out['reloading'] is True and out['was'] == build and out['loading'] == '0123456789', out
    p.wait('!window.__old && window.corecadReady && window.corecad && !corecad.busy', timeout=60)
    assert call('get_document') == doc, 'the project is the same after the reload'
    assert call('get_state')['app'] == {'build': build, 'update_available': False} and p.js(update + '.hidden') is True
    p.js('corecad.checkUpdate(async () => ' + json.dumps(newer) + ')')
    p.js('window.__old = true')
    p.click('#update-button')
    p.wait('!window.__old && window.corecadReady && window.corecad && !corecad.busy', timeout=60)
    assert call('get_document') == doc and p.js(update + '.hidden') is True
    step('a newer build is seen and said; reload_app and the Update button reload the tab and keep the project')

    errors = p.errors()
    assert not errors, errors
    print('ALL COMMAND CHECKS PASSED')


if __name__ == '__main__':
    with Browser(size=(1400, 900)) as b:
        try:
            run(b.page, sys.argv[1] if len(sys.argv) > 1 else 'index.html?test=1')
        except Exception as e:
            b.page.screenshot(ROOT / '.scratch' / 'e2e_api_failure.png')
            import traceback
            where = traceback.extract_tb(e.__traceback__)[-1]
            print('FAILED:', e or f'line {where.lineno}: {where.line}')
            for line in b.page.errors():
                print('  ', line)
            sys.exit(1)

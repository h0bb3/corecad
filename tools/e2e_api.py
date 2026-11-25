"""The command set (window.corecad.run, src/api/commands.js) against the real kernel.

Run with: python tools/e2e_api.py. Every edit here goes through commands, the way a
script or an agent would drive the page; tools/e2e.py covers the mouse and the keys.
"""
import base64
import json
import math
import sys
import time
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
    assert call('add_part', name='Empty')['part']['kind'] == 'empty'
    call('undo')
    group = call('add_group', name='Group', parent=None)
    assert group['part']['kind'] == 'group' and group['part']['contains'] == [] and 'box' not in group['part'], group['part']
    call('move_part', part='Block', parent='Group')
    lifted = call('move_part', part='Group', by=[0, 0, 100])
    assert lifted['part']['kind'] == 'group' and lifted['part']['contains'] == [row(lifted_state := call('get_state'), 'Block')['id']], lifted['part']
    assert row(lifted_state, 'Block')['box'] == [[-5, -5, 100], [5, 5, 110]] and lifted['part']['box'] == [[-5, -5, 100], [5, 5, 110]]
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

    # ---- groups: parts gathered where they stand; what is made next goes into the group; combine takes a group whole
    untouched = call('get_document')
    a = call('add_box', size=[10, 10, 10], position=[200, 0, 0], name='Foot A', parent=None)
    b = call('add_box', size=[10, 10, 10], position=[230, 0, 0], name='Foot B', parent=None)
    feet = call('add_group', name='Feet', parts=['Foot A', 'Foot B'], position=[200, 0, 0])
    fid = feet['part']['id']
    assert feet['part']['kind'] == 'group' and feet['part']['contains'] == [a['part']['id'], b['part']['id']] and feet['part']['position'] == [200, 0, 0], feet['part']
    assert feet['part']['box'] == [[195, -5, 0], [235, 5, 10]] and feet['part']['features'] == [] and feet['part']['bodies'] == []
    state = call('get_state')
    assert state['current_part'] == fid
    assert row(state, 'Foot B')['parent'] == fid and row(state, 'Foot B')['position'] == [30, 0, 0] and row(state, 'Foot B')['box'] == [[225, -5, 0], [235, 5, 10]], row(state, 'Foot B')
    names = [x['name'] for x in state['parts']]
    assert names.index('Feet') < names.index('Foot A') < names.index('Foot B'), 'in the list the group stands where its first part stood'
    c = call('add_box', size=[10, 10, 10], position=[60, 0, 0], name='Foot C')      # no parent given: into the group that is current
    assert c['part']['parent'] == fid and c['part']['box'] == [[255, -5, 0], [265, 5, 10]], c['part']
    d = call('add_box', size=[10, 10, 10], position=[90, 0, 0], name='Foot D')      # the current part stands in the group: so does the next
    assert d['part']['parent'] == fid
    call('undo')
    loose = call('add_box', size=[10, 10, 10], position=[0, 300, 0], name='Loose', parent=None)
    assert loose['part']['parent'] is None
    sk = call('add_sketch', plane='XY', part='Feet', shapes=[{'type': 'rectangle', 'corner': [0, 20], 'width': 5, 'height': 5}])
    made = next(x for x in call('get_state')['parts'] if x['id'] == sk['part'])
    assert made['parent'] == fid and made['kind'] == 'part' and sk['part'] not in (fid, loose['part']['id']), 'a sketch "in" a group starts a part of its own there: %s' % made
    assert len(call('list_faces', part='Feet')) == 3, 'a listing of a group is of everything in it'
    fails('combine', 'is a group', part='Feet', operation='join', **{'with': ['Loose']})
    fails('add_group', 'already stands under', parts=['Feet', 'Foot A'])
    fails('add_group', 'under one of the parts', parts=['Feet'], parent='Foot A')
    slab = call('add_box', size=[100, 20, 4], position=[230, 0, 3], name='Slab', parent=None)
    cut = call('combine', part='Slab', operation='cut', **{'with': ['Feet']})
    near(vol(cut, slab['part']['id']), 100 * 20 * 4 - 3 * 10 * 10 * 4, 1e-6, 'a group as a tool: everything in it is cut out')
    assert row(cut, 'Feet')['tool_of'] == slab['part']['id'] and row(cut, 'Feet')['parent'] == slab['part']['id']
    fails('ungroup', 'as a whole', part='Feet')
    fails('ungroup', 'not a group', part='Loose')
    call('undo')
    blue = call('set_color', part='Feet', color='blue')
    assert blue['part']['color'] == '#2f6fd0' and 'color' not in row(call('get_state'), 'Foot A')
    assert set(p.js('corecad.scene.filter(b => ["Foot A", "Foot B", "Foot C"].includes(corecad.parts.find(x => x.id === b.part).name)).map(b => b.color)')) == {'#2f6fd0'}, 'the colour of the group is the colour of what is in it'
    turned = call('move_part', part='Feet', turn={'axis': 'z', 'angle': 90})
    assert turned['part']['rotation'] == [0, 0, 90] and turned['part']['box'] == [[225, -35, 0], [235, 35, 10]], turned['part']
    whole = call('copy_part', part='Feet', by=[0, 100, 0])
    assert whole['part']['kind'] == 'group' and whole['part']['name'] == 'Feet copy' and len(whole['part']['contains']) == 4 and whole['part']['box'] == [[225, 65, 0], [235, 135, 10]], whole['part']
    call('undo')
    out = call('ungroup', part='Feet')
    assert out['ungrouped'] == fid and len(out['freed']) == 4 and 'Feet' not in [x['name'] for x in out['parts']], out
    assert row(out, 'Foot B')['parent'] is None and row(out, 'Foot B')['rotation'] == [0, 0, 90] and row(out, 'Foot B')['box'] == [[225, -5, 0], [235, 5, 10]], row(out, 'Foot B')
    assert p.js('document.querySelectorAll("[data-part]").length') == len(out['parts'])
    content = lambda d: {k: v for k, v in d.items() if k not in ('seq', 'pseq', 'meta')}     # undo keeps the counters: ids are never used twice
    for _ in range(20):
        if content(call('get_document')) == content(untouched):
            break
        call('undo')
    assert content(call('get_document')) == content(untouched)
    step('add_group gathers parts where they stand; new parts go into the current group; a group as a tool; colour, turn, copy, ungroup')

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
    call('add_box', size=[60, 40, 12], name='Plate')
    call('add_cylinder', diameter=10, height=30, position=[15, 0, -5], name='Pin')
    call('combine', part='Plate', operation='cut', **{'with': ['Pin']})
    call('add_box', size=[20, 20, 20], position=[60, 0, 0], name='Block')
    twin = call('copy_part', part='Block', linked=True, by=[0, 40, 0], name='Twin')['part']['id']
    call('set_view', view='top')
    none = call('get_selection')
    assert none['selected'] == [] and none['pointed'] is None and none['part']['id'] == twin, none
    assert 'click or point' in fails('hole', 'No face is selected', face='this', diameter=3)
    fails('fillet', 'No edge is selected', edges='selected', radius=1)
    fails('edit_feature', 'No feature is selected', id='this', name='x')
    fails('move_part', 'has not come to rest', part='pointed', by=[1, 0, 0])

    p.click(*page([-20, 10, 12]))
    sel = call('get_selection')
    face = sel['selected'][0]
    assert len(sel['selected']) == 1 and face['kind'] == 'face' and face['part'] == 'o1' and face['part_name'] == 'Plate' and face['body'] == 'f1', face
    assert face['surface'] == 'plane' and face['side'] == 'top' and face['normal'] == [0, 0, 1] and close(face['point'], [-20, 10, 12]) and close(face['at'], [-20, 10]), face
    assert [(m['id'], m['type'], m['as']) for m in face['made_by']] == [('f1', 'box', 'top')] and sel['part'] == {'id': 'o1', 'name': 'Plate'}, sel
    assert call('get_state')['selection']['selected'] == sel['selected']
    here = call('hole', face='this', diameter=4, depth=5)
    made = call('get_state')['features'][-1]
    assert made['type'] == 'hole' and close(made['at'], [-20, 10]), made
    solid = 28800 - math.pi * 25 * 12 - math.pi * 4 * 5
    near(vol(here, 'o1'), solid, what='a hole where the person clicked')
    assert call('get_selection')['selected'] == [], 'what was selected is used up by the change'
    step('"a hole on this face": the face that was clicked, at the point that was clicked')

    # the mouse resting on something is pointing at it; the next "this" is that
    rest([20, -12, 12])
    at = call('get_selection')['pointed']
    assert at and at['kind'] == 'face' and at['side'] == 'top' and close(at['at'], [20, -12]) and at['mouse_in_view'] and at['seconds_ago'] < 5, at
    mid = call('hole', face='pointed', at='center', diameter=3, depth=2)
    # the middle of a face is the middle of its area: the two holes already in it pull it a little
    area = 2400 - 25 * math.pi - 4 * math.pi
    centre = [(-15 * 25 * math.pi + 20 * 4 * math.pi) / area, -10 * 4 * math.pi / area]
    assert close(call('get_state')['features'][-1]['at'], centre, 1e-3), (call('get_state')['features'][-1], centre)
    again = call('hole', face='this', diameter=3, depth=2)       # the mouse has not moved: it still points there, on the rebuilt body
    assert close(call('get_state')['features'][-1]['at'], [20, -12]), call('get_state')['features'][-1]
    solid -= 2 * math.pi * 2.25 * 2
    near(vol(again, 'o1'), solid, what='holes by pointing')
    step('holding the mouse on a face is pointing at it, and it still is after the model is rebuilt')

    # "make this hole bigger": the feature that made the face
    p.click(*page([-20, 10, 7]))
    floor = call('get_selection')['selected'][0]
    assert [(m['id'], m['type']) for m in floor['made_by']] == [(made['id'], 'hole')] and abs(floor['center'][2] - 7) < 1e-6, floor
    fails('get_sketch', 'not made from a sketch', sketch='this')
    bigger = call('edit_feature', id='this', diameter=6)
    assert bigger['id'] == made['id'] and bigger['type'] == 'hole'
    solid += math.pi * 4 * 5 - math.pi * 9 * 5
    near(vol(bigger, 'o1'), solid, what='the hole that was clicked, made wider')
    step('"this" as a feature: the one that made the face that was clicked')

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
    fails('hole', 'linked copy', face='this', diameter=2)
    fails('add_sketch', 'linked copy', plane='this')
    moved = call('move_part', part='this', by=[0, 10, 0])
    assert moved['part']['id'] == twin and moved['part']['position'] == [60, 50, 0], moved['part']
    time.sleep(.45)
    assert call('get_selection')['pointed']['part'] == twin, 'the mouse still rests on the copy, where it now stands'
    assert call('move_part', part='pointed', by=[0, -10, 0])['part']['position'] == [60, 40, 0]
    p.key('Escape')
    assert call('get_selection')['pointed'] is None and p.js('corecad.pointed') is None
    step('edges and parts that were clicked or pointed at; a linked copy says what it is; Escape lets go')

    # ---- measuring, and the numbers that drive the model
    call('new_document', name='Measuring')
    call('add_sketch', plane='XY', shapes=[{'type': 'rectangle', 'corner': [0, 0], 'width': 60, 'height': 40},
                                           {'type': 'circle', 'center': [15, 20], 'diameter': 8},
                                           {'type': 'circle', 'center': [45, 20], 'diameter': 8}])
    call('extrude', distance=12)
    call('fillet', edges={'parallel': 'z', 'kind': 'line'}, radius=4)
    call('hole', face='top', at=[30, 32], diameter=5, depth=6)
    faces = call('list_faces')[0]['faces']
    walls = [f['face'] for f in faces if f.get('hole') and f.get('radius') == 4]
    assert len(walls) == 2 and sum(1 for f in faces if f.get('radius') == 4 and not f.get('hole')) == 4, 'holes and fillets are told apart'
    m = call('measure', **{'from': 'top', 'to': 'bottom'})
    assert m['between']['distance'] == 12 and m['between']['what'] == 'between parallel faces' and m['of'][0]['size'] == [60, 40], m
    m = call('measure', **{'from': {'face': walls[0]}, 'to': {'face': walls[1]}})
    assert m['between']['distance'] == 30 and m['between']['what'] == 'between centres' and m['of'][0]['measures'] == 'Hole \u2300 8 \u00d7 12 mm', m
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
    assert [e['kind'] for e in sel['selected']] == ['edge', 'edge'] and sel['selected'][0]['diameter'] == 8, sel['selected']
    assert sel['between']['distance'] == 30 and sel['between']['what'] == 'between centres' and [abs(v) for v in sel['between']['delta']] == [30, 0, 0], sel['between']
    assert call('measure')['between'] == sel['between']
    assert p.js('corecad.measured').startswith('Between them: 30 mm (between centres)')
    shown = [n['text'] for n in p.js('corecad.numbers') if n['kind'] == 'measure']
    assert '30 mm' in shown and shown.count('\u2300 8 mm') == 2, shown
    p.key('Escape')
    step('the size where the mouse rests; 30 mm between two clicked holes, for the person and for the agent')

    # every driving number, with the command that changes it
    dims = call('list_dimensions')
    width = next(d for d in dims if d['is'] == 'horizontal distance' and d['value'] == 60)
    assert width['change_with'] == 'set_dimension' and width['arguments']['sketch'] == 'f1' and width['feature_name'] == 'Sketch1', width
    assert sorted(d['shown_as'] for d in dims if d['feature'] != 'f1') == ['12', '6', 'R 4', '\u00d8 5'], [d['shown_as'] for d in dims]
    depth = next(d for d in dims if d['is'] == 'extrusion distance')
    assert depth['change_with'] == 'edit_feature' and depth['arguments'] == {'id': 'f2', 'distance': 12} and depth['at'] == [0, 0, 6], 'along the edge at the first corner of the outline: %s' % depth
    wider = call(width['change_with'], **{**width['arguments'], 'value': 80})
    assert wider['bodies'][0]['box'][1][0] == 80, wider['bodies']
    step('list_dimensions: %d driving numbers, each with the command that changes it' % len(dims))

    # the same numbers on the model: Dimensions (D), click one, type
    p.click('[data-part="o1"]')
    p.key('d')
    labels = p.js('corecad.dimensions')
    assert sorted(l['text'] for l in labels if l['feature'] != 'f1') == ['12', '6', 'R 4', '\u00d8 5'] and all(l['editable'] for l in labels), labels
    overall = [n['text'] for n in p.js('corecad.numbers') if n['kind'] == 'reference']
    assert overall == ['X 80', 'Y 40', 'Z 12'], overall
    thick = next(l for l in labels if l['feature'] == 'f2')
    p.move(thick['x'], thick['y'], steps=3)
    assert [n['text'] for n in p.js('corecad.numbers') if n['kind'] == 'caption'] == ['extrusion distance \u00b7 Extrude1'], 'the number under the mouse says what it is'
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

    # ---- revolve: closed regions of a sketch turned about one of its lines
    untouched = call('get_document')
    s = call('add_sketch', plane='XZ', part='new', shapes=[{'type': 'rectangle', 'corner': [8, 0], 'width': 6, 'height': 10},
                                                           {'type': 'line', 'from': [0, 0], 'to': [0, 5], 'construction': True}])
    lines = [e for e in s['sketch']['entities'] if e['type'] == 'line']
    axis = next(e['id'] for e in lines if e.get('construction'))
    ring = call('revolve', axis=axis)
    rid, pid = ring['id'], ring['part']
    assert ring['type'] == 'revolve' and ring['status'] == 'ok' and ring['name'] == 'Revolve1' and pid == s['part'], ring
    near(vol(ring, pid), math.pi * (14 ** 2 - 8 ** 2) * 10, 1e-2, 'a ring')
    assert next(b for b in ring['bodies'] if b['part'] == pid)['box'] == [[-14, -14, 0], [14, 14, 10]], 'drawn on XZ about its upright line: it stands on Z'
    row_of = lambda r: next(f for f in call('get_state')['features'] if f['id'] == r)
    assert {k: row_of(rid)[k] for k in ('sketch', 'axis', 'angle', 'operation', 'profiles')} == {'sketch': s['id'], 'axis': axis, 'angle': 360, 'operation': 'new', 'profiles': 1}
    angle = next(x for x in call('list_dimensions', part=pid) if x['feature'] == rid)
    assert angle['value'] == 360 and angle['unit'] == '\u00b0' and angle['change_with'] == 'edit_feature' and angle['arguments'] == {'id': rid, 'angle': 360}, angle
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
    g = call('add_sketch', plane='XZ', part=pid, shapes=[{'type': 'rectangle', 'corner': [18, 4], 'width': 4, 'height': 2},
                                                         {'type': 'line', 'from': [14, 0], 'to': [14, 3], 'construction': True}])
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
    assert label['key'] == 'angle' and label['text'] == '360\u00b0' and label['editable'], label
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
    for _ in range(20):
        if content(call('get_document')) == content(untouched):
            break
        call('undo')
    assert content(call('get_document')) == content(untouched)
    step('revolve: a ring, part of a turn and the other way, about a side of the outline, a groove cut; its angle on the model')

    # ---- one command, one tool: nothing that lists or runs the others by name
    import re
    st = call('get_state')
    build = st['app']['build']
    assert re.fullmatch(r'[0-9a-f]{10}', build) and st['app'] == {'build': build, 'update_available': False} and p.js('corecad.version') == build, st['app']
    assert not {'list_commands', 'run_command'} & set(p.js('corecad.tools.map(t => t.name)'))

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
            print('FAILED:', e)
            for line in b.page.errors():
                print('  ', line)
            sys.exit(1)

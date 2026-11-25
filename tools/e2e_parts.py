"""Parts with real pointer and key events: primitives, combining, placing, copies.

Run with: python tools/e2e_parts.py. Inspection reads state and projects coordinates;
every change is made the way a person makes it.
"""
import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from browser import Browser, ROOT  # noqa: E402

PI = math.pi


def run(p, url='index.html?test=1'):
    def wait(expr='!corecad.busy', timeout=30):
        return p.wait('window.corecad && (' + expr + ')', timeout=timeout)

    def at(point, **kwargs):
        p.click(*p.js('corecad.screen(' + json.dumps(point) + ')'), **kwargs)

    def fill(selector, value):
        p.click(selector)
        p.key('a', modifiers=2)
        p.type(str(value))

    def choose(selector, index):
        p.click(selector)
        p.key('Home')
        for _ in range(index):
            p.key('ArrowDown')
        p.key('Enter')
        p.key('Tab')

    def apply():
        wait('!document.getElementById("apply-feature").disabled')
        p.click('#apply-feature')
        wait('!corecad.busy && !corecad.editing')

    def apply_move():
        wait('!corecad.busy && !document.getElementById("apply-move").disabled')
        p.click('#apply-move')
        wait('!corecad.busy && !corecad.editing')

    def parts():
        return p.js('corecad.parts')

    def part(pid):
        return next(x for x in parts() if x['id'] == pid)

    def body_of(pid):
        """The one body the kernel built for a part: {id, volume, bbox}."""
        bodies = p.js('corecad.build.bodies.filter(b=>b.part===' + json.dumps(pid) + ').map(b=>({id:b.id,volume:b.volume,bbox:b.bbox}))')
        assert len(bodies) == 1, f'{pid} has {len(bodies)} bodies'
        return bodies[0]

    def scene():
        return p.js('corecad.scene.map(b=>({id:b.id,part:b.part,instance:!!b.instance,bbox:b.bbox,at:[b.matrix[3],b.matrix[7],b.matrix[11]]}))')

    def near(a, b, tol=0.02, what=''):
        assert abs(a - b) <= tol, f'{what}: {a} is not {b}'

    def drag_arrow(axis, mm):
        """Takes hold of an arrow of the part being placed and drags it `mm` along its axis."""
        arrow = next(a for a in p.js('corecad.arrows') if a['axis'] == axis)
        x0 = arrow['a'][0] + 0.7 * (arrow['b'][0] - arrow['a'][0])
        y0 = arrow['a'][1] + 0.7 * (arrow['b'][1] - arrow['a'][1])
        unit = [0, 0, 0]
        unit[axis] = 1
        o, u = p.js('corecad.screen([0,0,0])'), p.js('corecad.screen(' + json.dumps(unit) + ')')
        p.drag(x0, y0, x0 + (u[0] - o[0]) * mm, y0 + (u[1] - o[1]) * mm, steps=14)

    def to_segment(q, a, b):
        ux, uy = b[0] - a[0], b[1] - a[1]
        uu = ux * ux + uy * uy
        k = max(0, min(1, ((q[0] - a[0]) * ux + (q[1] - a[1]) * uy) / uu)) if uu else 0
        return math.hypot(a[0] + ux * k - q[0], a[1] + uy * k - q[1])

    def ring_points(axis, free=lambda q, centre: True):
        """The points of a ring, and where on it it can be taken hold of: away from the arrows and the other rings."""
        rings, arrows = p.js('corecad.rings'), p.js('corecad.arrows')
        pts = next(r for r in rings if r['axis'] == axis)['points']
        centre = arrows[0]['a']
        others = [r['points'] for r in rings if r['axis'] != axis]
        def clear(q):
            return (all(to_segment(q, a['a'], a['b']) > 22 for a in arrows) and free(q, centre)
                    and all(min(to_segment(q, o[i], o[i + 1]) for i in range(len(o) - 1)) > 14 for o in others))
        return pts, clear

    def turn_ring(axis, count, modifiers=0):
        """Takes hold of a ring and follows it round by `count` of its points: 5 degrees each."""
        pts, clear = ring_points(axis)
        n = len(pts) - 1
        i0 = next(i for i in range(n) if clear(pts[i]))
        p.move(*pts[i0][:2])
        p.down()
        for k in range(1, count + 1):
            p.move(*pts[(i0 + k) % n][:2], buttons=1, modifiers=modifiers)
        p.up()

    def rot_matrix(rot):
        """The rotation of a placement: degrees about X, then Y, then Z."""
        (cx, sx), (cy, sy), (cz, sz) = [(math.cos(math.radians(a)), math.sin(math.radians(a))) for a in rot]
        return [[cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx], [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx], [-sy, cy * sx, cy * cx]]

    def same(a, b):
        return all(abs(a[i][j] - b[i][j]) < 1e-6 for i in range(3) for j in range(3))

    def times(a, b):
        return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]

    def untitled_now():
        return p.js('[...document.querySelectorAll("button,input,select,a")].filter(e=>e.getClientRects().length&&!e.closest("[title]")).map(e=>e.outerHTML)')

    def step(text):
        print('PASS ' + text)

    p.goto(url)
    wait('window.corecadReady && !corecad.busy', 60)
    p.click('[data-action="new"]')
    p.click('[data-modal="new"]')
    wait()

    # ---- a box and a cylinder: parts of their own, without sketches
    p.key('b')
    wait('corecad.draft && corecad.draft.type === "box"')
    fill('#box-x', 60)
    fill('#box-y', 40)
    fill('#box-z', 12)
    apply()
    assert [x['name'] for x in parts()] == ['Box 1'] and p.js('corecad.selectedPart') == 'o1'
    box = body_of('o1')
    near(box['volume'], 28800, .01, 'box')
    assert box['bbox'] == [[-30, -20, 0], [30, 20, 12]], box
    p.click('[data-action="cylinder"]')
    fill('#cyl-d', 10)
    fill('#cyl-h', 30)
    fill('#prim-px', 15)
    fill('#prim-pz', -5)
    apply()
    assert [(x['name'], x['pos']) for x in parts()] == [('Box 1', [0, 0, 0]), ('Cylinder 1', [15, 0, -5])]
    near(body_of('o2')['volume'], PI * 25 * 30, .01, 'cylinder')
    assert [(b['part'], b['at']) for b in scene()] == [('o1', [0, 0, 0]), ('o2', [15, 0, -5])]
    assert p.js('[...document.querySelectorAll("[data-feature] .tree-name")].map(e=>e.textContent)') == ['Box1', 'Cylinder1']
    step('a box and a cylinder are parts of their own, each with its own history')

    # ---- combine: the cylinder is cut out of the box, and becomes its tool
    p.click('[data-part="o1"]')
    assert p.js('corecad.selectedPart') == 'o1'
    p.click('[data-action="combine"]')
    wait('corecad.draft && corecad.draft.type === "combine"')
    choose('#combine-op', 1)
    p.click('#tool-o2')
    wait('corecad.draft.tools.length === 1 && corecad.draft.operation === "cut"')
    apply()
    near(body_of('o1')['volume'], 28800 - PI * 25 * 12, .02, 'box with a hole')
    assert p.js('corecad.build.used') == {'o2': 'o1'} and part('o2')['parent'] == 'o1' and part('o2')['pos'] == [15, 0, -5]
    assert [b['part'] for b in scene()] == ['o1'], 'the tool is out of the picture'
    row = p.js('(()=>{const r=document.querySelector(\'[data-part="o2"]\');return {used:r.classList.contains("used"),text:r.textContent}})()')
    title = p.js('document.querySelector("[data-part=o2]").title')
    assert row['used'] and 'tool' in row['text'] and 'tool of Box 1' in title, (row, title)
    p.screenshot('.scratch/e2e-parts-01-combine.png')
    step('combine cuts one part out of another; the tool is kept under it')

    # ---- placing the tool with the mouse: the hole follows
    p.click('[data-part="o2"]')
    p.key('m')
    wait('!!corecad.moving')
    assert p.js('document.querySelector("#panel h3").textContent') == 'POSITION IN BOX 1'
    drag_arrow(0, -20)
    assert p.js('corecad.moving.pos') == [-5, 0, -5], p.js('corecad.moving.pos')
    assert p.js('document.getElementById("move-x").value') == '-5'
    p.screenshot('.scratch/e2e-parts-02-move.png')
    apply_move()
    assert part('o2')['pos'] == [-5, 0, -5]
    near(body_of('o1')['volume'], 28800 - PI * 25 * 12, .02, 'the hole moved, the volume stayed')
    wall = p.js('corecad.build.bodies.find(b=>b.part==="o1").mesh.faces.find(f=>f.kind==="cylinder").center')
    near(wall[0], -5, 1e-6, 'the hole is where the tool is')
    p.key('z', modifiers=2)
    wait('!corecad.busy && corecad.parts[1].pos[0] === 15')
    p.key('y', modifiers=2)
    wait('!corecad.busy && corecad.parts[1].pos[0] === -5')
    step('dragging an arrow moves the part in 1 mm steps; the cut follows; undo and redo')

    # ---- typing a place, a quarter turn, a parent; Escape puts it back
    p.click('[data-part="o2"]')
    p.click('[data-action="move-part"]')
    wait('!!corecad.moving')
    fill('#move-y', '10+2.5')
    assert p.js('corecad.moving.pos') == [-5, 12.5, -5]
    p.click('[data-turn="0"]')
    moving = p.js('corecad.moving')
    assert moving['rot'] == [90, 0, 0], moving
    # a quarter about X round the middle of the cylinder (which is at z = 10): its origin swings to y + 15, z = 10
    assert [round(v, 6) for v in moving['pos']] == [-5, 27.5, 10], moving
    choose('#move-parent', 0)
    assert p.js('corecad.moving.parent') is None and p.js('document.querySelector("#panel h3").textContent') == 'POSITION'
    wait('!corecad.busy')
    p.key('Escape')
    wait('!corecad.busy && !corecad.editing')
    assert part('o2') == {'id': 'o2', 'name': 'Cylinder 1', 'parent': 'o1', 'pos': [-5, 0, -5], 'rot': [0, 0, 0]}
    near(body_of('o1')['volume'], 28800 - PI * 25 * 12, .02)
    step('typed placement with arithmetic, a quarter turn on the spot, a new parent; Escape restores')

    # ---- rings: a turn about one axis, in steps, whatever way the part already stands
    p.click('[data-part="o1"]')
    p.key('m')
    wait('!!corecad.moving')
    assert p.js('document.getElementById("move-rot").textContent') == 'Not turned' and not p.js('!!document.getElementById("move-rx")')
    turn_ring(2, 9)
    assert p.js('corecad.moving.rot') == [0, 0, 45], p.js('corecad.moving')
    assert [round(v, 6) for v in p.js('corecad.moving.pos')] == [0, 0, 0], 'the box turns about its middle, which is over its origin'
    assert p.js('document.getElementById("move-rot").textContent') == 'Turned X 0° · Y 0° · Z 45°'
    turn_ring(2, 1)
    assert p.js('corecad.moving.rot') == [0, 0, 45], 'five degrees is not yet a step of fifteen'
    turn_ring(2, 1, modifiers=8)
    assert p.js('corecad.moving.rot') == [0, 0, 50], 'with Shift it turns by single degrees'
    p.screenshot('.scratch/e2e-parts-rings.png')
    p.click('[data-action="upright"]')
    assert p.js('corecad.moving.rot') == [0, 0, 0] and p.js('document.getElementById("move-rot").textContent') == 'Not turned'
    # a ring seen edge-on is dragged along: from above, the X ring is a line
    p.click('[data-view="top"]')
    pts, clear = ring_points(0, lambda q, centre: 35 < q[1] - centre[1] < 70)
    grab = next(q for q in pts if clear(q))
    p.move(*grab[:2])
    p.down()
    for k in range(1, 9):
        p.move(grab[0], grab[1] + k * 98 * math.pi / 6 / 8, buttons=1)
    p.up()
    edge_on = p.js('corecad.moving.rot')
    assert abs(edge_on[0]) == 30 and edge_on[1:] == [0, 0], edge_on
    p.click('[data-action="upright"]')
    p.click('[data-view="home"]')
    # no gimbal lock: with the part a quarter about Y, X and Z are still two different turns
    p.click('[data-turn="1"]')
    assert p.js('corecad.moving.rot') == [0, 90, 0]
    fill('#move-angle', 30)
    quarter = rot_matrix([0, 90, 0])
    p.click('[data-turn="0"]')
    about_x = rot_matrix(p.js('corecad.moving.rot'))
    assert same(about_x, times(rot_matrix([30, 0, 0]), quarter)), p.js('corecad.moving.rot')
    fill('#move-angle', -30)
    p.click('[data-turn="0"]')
    assert same(rot_matrix(p.js('corecad.moving.rot')), quarter), 'and back'
    fill('#move-angle', 30)
    p.click('[data-turn="2"]')
    about_z = rot_matrix(p.js('corecad.moving.rot'))
    assert same(about_z, times(rot_matrix([0, 0, 30]), quarter)) and not same(about_z, about_x), p.js('corecad.moving.rot')
    turn_ring(0, 3)
    assert same(rot_matrix(p.js('corecad.moving.rot')), times(rot_matrix([15, 0, 0]), about_z)), 'the X ring turns about X from there too'
    assert not untitled_now(), untitled_now()
    p.key('Escape')
    wait('!corecad.busy && !corecad.editing')
    assert part('o1')['rot'] == [0, 0, 0]
    step('rings turn about their own axis in steps of 15 (Shift: 1); edge-on too; X and Z stay apart at a quarter about Y')

    # ---- a copy of its own, and a linked copy
    p.click('[data-part="o1"]')
    p.key('m')
    wait('!!corecad.moving')
    middle_arrows = p.js('corecad.arrows')  # where the arrows of the original stand
    p.key('Escape')
    wait('!corecad.busy && !corecad.editing')
    p.click('[data-action="copy-part"]')
    wait('!!corecad.moving && corecad.moving.id === "o3"')
    early = p.js('corecad.arrows')          # the copy may not be built yet: the arrows already stand at its middle
    wait('!corecad.busy')
    assert p.js('corecad.arrows') == early and early == middle_arrows, 'the gizmo does not jump when the copy arrives'
    drag_arrow(1, 60)
    assert p.js('corecad.moving.pos') == [0, 60, 0]
    apply_move()
    names = [(x['id'], x['name'], x['parent']) for x in parts()]
    assert names == [('o1', 'Box 1', None), ('o2', 'Cylinder 1', 'o1'), ('o3', 'Box 1 copy', None), ('o4', 'Cylinder 1', 'o3')], names
    assert p.js('corecad.doc.features.map(f=>[f.id,f.part,f.type])') == [
        ['f1', 'o1', 'box'], ['f2', 'o2', 'cylinder'], ['f3', 'o1', 'combine'],
        ['f4', 'o3', 'box'], ['f5', 'o4', 'cylinder'], ['f6', 'o3', 'combine']]
    assert p.js('corecad.doc.features[5].tools') == ['o4'], 'the copy is cut by its own copy of the tool'
    near(body_of('o3')['volume'], 28800 - PI * 25 * 12, .02, 'the copy')
    p.click('[data-part="o1"]')
    p.click('[data-action="link-part"]')
    wait('!!corecad.moving && corecad.moving.id === "o5"')
    fill('#move-z', 40)
    apply_move()
    assert part('o5')['link'] == 'o1' and part('o5')['pos'] == [0, 0, 40]
    assert [(b['part'], b['instance'], b['at']) for b in scene()] == [('o1', False, [0, 0, 0]), ('o3', False, [0, 60, 0]), ('o5', True, [0, 0, 40])]
    assert p.js('corecad.build.bodies.length') == 4, 'a linked copy builds nothing of its own'
    # the original grows: the link follows, the copy of its own does not
    p.click('[data-feature="f1"]', count=2)
    wait('corecad.draft && corecad.draft.id === "f1"')
    fill('#box-z', 20)
    apply()
    s = scene()
    assert [b['bbox'][1][2] for b in s] == [20, 12, 20], s
    p.click('[data-view="home"]')
    p.click('[data-action="fit"]')
    p.screenshot('.scratch/e2e-parts-03-copies.png')
    step('a copy of its own keeps its own history; a linked copy follows the original')

    # ---- a click in the view selects the part; a sketch on a face of a moved part
    p.click('[data-view="top"]')
    p.click('[data-action="fit"]')
    at([15, 70, 12])
    assert p.js('corecad.selection[0]?.type') == 'face' and p.js('corecad.selectedPart') == 'o3'
    p.key('s')
    wait('!!corecad.sketch')
    assert p.js('corecad.sketch.part') == 'o3'
    p.key('c')
    at([20, 10])
    p.move(*p.js('corecad.screen([24,10])'))
    p.key('4')
    p.key('Enter')
    p.key('Escape')
    p.key('Enter', modifiers=2)
    wait('!corecad.busy && !corecad.editing')
    p.key('e')
    wait('corecad.draft && corecad.draft.type === "extrude"')
    assert p.js('corecad.draft.part') == 'o3' and p.js('corecad.draft.operation') == 'join'
    choose('#feature-operation', 2)
    p.click('#feature-all')
    p.click('#feature-flip')
    apply()
    near(body_of('o3')['volume'], 28800 - PI * 25 * 12 - PI * 16 * 12, .03, 'the copy with a second hole')
    holes = p.js('corecad.build.bodies.find(b=>b.part==="o3").mesh.faces.filter(f=>f.kind==="cylinder").map(f=>f.center)')
    assert any(abs(h[0] - 20) < 1e-3 and abs(h[1] - 10) < 1e-3 for h in holes), f'the hole is at (20, 10) of the part, 60 further in space: {holes}'
    near(body_of('o1')['volume'], 48000 - PI * 25 * 20, .03, 'the original is untouched')
    assert p.js('[...document.querySelectorAll(\'[data-part="o3"] ~ [data-feature]\')].length') >= 4
    step('a sketch on a face of a moved part lands on that face and joins that part\'s history')

    # ---- a new part takes the next sketch
    p.click('[data-view="home"]')
    p.click('[data-action="new-part"]')
    wait('!corecad.busy && corecad.parts.length === 6')
    new = parts()[-1]
    assert new['name'] == 'Part 1' and p.js('corecad.selectedPart') == new['id']
    p.click('#browser-content [data-plane="XY"]')
    wait('!!corecad.sketch')
    assert p.js('corecad.sketch.part') == new['id']
    p.key('r')
    at([0, 0])
    at([20, 15])
    p.key('Escape')
    p.key('Enter', modifiers=2)
    wait('!corecad.busy && !corecad.editing')
    p.key('e')
    wait('corecad.draft && corecad.draft.type === "extrude"')
    assert p.js('corecad.draft.operation') == 'new', 'the first solid of a part is a new body, whatever other parts hold'
    apply()
    made = body_of(new['id'])
    near(made['volume'], 20 * 15 * 10, 60, 'the plate of the new part')
    assert p.js('corecad.doc.features.slice(-2).map(f=>f.part)') == [new['id'], new['id']]
    step('a new part takes the next sketch; its first extrusion is a body of its own')

    # ---- hiding, and what Delete says about what hangs on a part
    p.click('[data-part-eye="o3"]')
    wait('!corecad.busy && corecad.parts[2].hidden')
    assert 'o3' not in [b['part'] for b in scene()]
    p.click('[data-part-eye="o3"]')
    wait('!corecad.busy && !corecad.parts[2].hidden')
    p.click('[data-part="o1"]')
    p.click('[data-action="delete-part"]')
    text = p.js('document.querySelector("#modal-root .panel-body").textContent')
    assert 'the 1 part under it' in text and '1 linked copy elsewhere uses it' in text, text
    p.click('[data-modal="all"]')
    wait('!corecad.busy && corecad.parts.length === 3')
    assert [x['id'] for x in parts()] == ['o3', 'o4', new['id']]
    p.key('z', modifiers=2)
    wait('!corecad.busy && corecad.parts.length === 6')
    assert len(scene()) == 4
    step('hide and show; delete names the linked copy and takes it too; undo brings all back')

    # ---- the list arranges the hierarchy: a part dragged onto another goes under it, and stays where it is
    def centre(selector):
        r = p.rect(selector)
        return r[0] + r[2] / 2, r[1] + r[3] / 2

    def drag_row(source, target):
        """A drag at a person's pace. The browser allows a drop only where it has shown the dragged row
        hovering, and the emulated mouse outruns that: so hover until the page has seen it there."""
        (x0, y0), (x1, y1) = centre(source), centre(target)
        p.js('window.__over = null; window.__watch ??= document.addEventListener("dragover", e => (window.__over = [e.clientX, e.clientY]), true)')
        p.move(x0, y0)
        p.down()
        for i in range(1, 11):
            p.move(x0 + (x1 - x0) * i / 10, y0 + (y1 - y0) * i / 10, buttons=1)
            time.sleep(.04)
        for i in range(40):
            p.move(x1 + i % 2, y1, buttons=1)
            time.sleep(.05)
            over = p.js('window.__over')
            if over and abs(over[0] - x1) < 3 and abs(over[1] - y1) < 3:
                break
        p.up()

    def scroll_to(selector, block='start'):
        p.js('document.querySelector(' + json.dumps(selector) + ').scrollIntoView({block:' + json.dumps(block) + '})')

    nid = new['id']
    scroll_to('[data-part="o3"]')
    drag_row(f'[data-part="{nid}"] .tree-name', '[data-part="o3"] .tree-name')
    wait('!corecad.busy && corecad.parts.find(x=>x.id===' + json.dumps(nid) + ').parent === "o3"')
    assert part(nid)['pos'] == [0, -60, 0], part(nid)
    assert next(b['at'] for b in scene() if b['part'] == nid) == [0, 0, 0], 'it has not moved in space'
    scroll_to('[data-part="o3"]')
    drag_row('[data-part="o3"] .tree-name', f'[data-part="{nid}"] .tree-name')
    wait('!corecad.busy')
    assert part('o3')['parent'] is None, 'a part cannot be put under what stands under it'
    scroll_to('#browser-content > .group-title')
    drag_row(f'[data-part="{nid}"] .tree-name', '#browser-content > .group-title')
    wait('!corecad.busy && corecad.parts.find(x=>x.id===' + json.dumps(nid) + ').parent === null')
    assert part(nid)['pos'] == [0, 0, 0]
    step('dragging a part onto another in the list puts it under that; onto the heading takes it out')

    # ---- a turned part: what is drawn, what is picked and where a sketch lies agree
    scroll_to(f'[data-part="{nid}"]', 'center')
    p.click(f'[data-part="{nid}"]')
    p.key('m')
    wait('!!corecad.moving')
    fill('#move-x', 80)
    p.click('[data-turn="2"]')
    apply_move()
    assert part(nid)['rot'] == [0, 0, 90], part(nid)
    p.click('[data-view="top"]')
    p.click('[data-action="fit"]')
    lo, hi = made['bbox']
    mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2]
    at([80 + mid[0], mid[1], 10])       # the middle of its top face: it turned about its own middle, which stayed
    assert p.js('corecad.selection[0]?.type') == 'face' and p.js('corecad.selectedPart') == nid
    p.key('s')
    wait('!!corecad.sketch')
    hit = p.js('corecad.pick(corecad.screen(' + json.dumps(mid) + '), "face")')
    assert hit and hit['body'] == made['id'], hit
    assert all(abs(a - b) < 1e-3 for a, b in zip(hit['point'], [mid[0], mid[1], 10])), hit
    assert all(abs(a - b) < 1e-3 for a, b in zip(hit['world'], [80 + mid[0], mid[1], 10])), hit
    p.click('[data-action="discard-sketch"]')
    wait('!corecad.busy && !corecad.editing')
    p.click('[data-view="home"]')
    p.click('[data-action="fit"]')
    step('on a turned part the view, the picking and the sketch plane agree')

    # ---- every control explains itself, in the panels too
    def untitled():
        return p.js('[...document.querySelectorAll("button,input,select,a")].filter(e=>e.getClientRects().length&&!e.closest("[title]")).map(e=>e.outerHTML)')
    assert not untitled(), untitled()
    p.click('[data-part="o3"]')
    p.key('m')
    wait('!!corecad.moving')
    assert not untitled(), untitled()
    p.key('Escape')
    wait('!corecad.busy && !corecad.editing')
    p.click('[data-part="o3"]')
    p.click('[data-action="combine"]')
    wait('corecad.draft && corecad.draft.type === "combine"')
    assert not untitled(), untitled()
    assert p.js('[...document.querySelectorAll("#tool-list input")].map(e=>e.id)') == ['tool-o1', 'tool-o5', 'tool-' + new['id']], 'tools of other parts and its own are not offered'
    p.key('Escape')
    wait('!corecad.busy && !corecad.editing')
    step('hover help on every control, also while placing and combining')

    # ---- it is all in the autosave, and in the exported solids
    p.click('[data-action="export-menu"]')
    p.click('[data-modal="stl"]')
    p.wait('window.__lastExport?.format==="stl"', timeout=30)
    assert p.js('window.__lastExport.size') > 5000
    count = len(parts())
    p.goto(url)
    wait('window.corecadReady && !corecad.busy', 60)
    assert len(parts()) == count and len(scene()) == 4 and p.js('corecad.doc.version') == 2
    step('export, and the parts come back after a reload')

    # ---- a project in the old format opens as one part
    old = {'format': 'corecad', 'version': 1, 'meta': {'id': 'old', 'name': 'Old plate', 'created': '', 'modified': '', 'app': '0.1.0'}, 'seq': 2, 'bodies': {},
           'features': [
               {'id': 'f1', 'type': 'sketch', 'name': 'Sketch1', 'plane': {'kind': 'base', 'base': 'XY'}, 'seq': 8,
                'points': [{'id': 'p1', 'x': 0, 'y': 0}, {'id': 'p2', 'x': 60, 'y': 0}, {'id': 'p3', 'x': 60, 'y': 0}, {'id': 'p4', 'x': 60, 'y': 40},
                           {'id': 'p5', 'x': 60, 'y': 40}, {'id': 'p6', 'x': 0, 'y': 40}, {'id': 'p7', 'x': 0, 'y': 40}, {'id': 'p8', 'x': 0, 'y': 0}],
                'entities': [{'id': 'e1', 'type': 'line', 'a': 'p1', 'b': 'p2'}, {'id': 'e2', 'type': 'line', 'a': 'p3', 'b': 'p4'},
                             {'id': 'e3', 'type': 'line', 'a': 'p5', 'b': 'p6'}, {'id': 'e4', 'type': 'line', 'a': 'p7', 'b': 'p8'}],
                'constraints': [{'id': 'c1', 'type': 'coincident', 'refs': ['p2', 'p3']}, {'id': 'c2', 'type': 'coincident', 'refs': ['p4', 'p5']},
                                {'id': 'c3', 'type': 'coincident', 'refs': ['p6', 'p7']}, {'id': 'c4', 'type': 'coincident', 'refs': ['p8', 'p1']}]},
               {'id': 'f2', 'type': 'extrude', 'name': 'Extrude1', 'sketch': 'f1', 'profiles': [{'loop': ['e1', 'e2', 'e3', 'e4'], 'at': [30, 20]}],
                'operation': 'new', 'extent': {'type': 'oneSide', 'distance': 10}, 'flip': False, 'targets': None}]}
    file = ROOT / '.scratch' / 'old-format.corecad'
    file.parent.mkdir(exist_ok=True)
    file.write_text(json.dumps(old), encoding='utf-8')
    root = p.call('DOM.getDocument')['root']['nodeId']
    node = p.call('DOM.querySelector', nodeId=root, selector='#file-input')['nodeId']
    p.call('DOM.setFileInputFiles', nodeId=node, files=[str(file)])
    wait('!corecad.busy && corecad.doc.meta.name === "Old plate"')
    assert p.js('corecad.doc.version') == 2 and parts() == [{'id': 'o1', 'name': 'Part 1', 'parent': None, 'pos': [0, 0, 0], 'rot': [0, 0, 0]}]
    assert p.js('corecad.doc.features.map(f=>f.part)') == ['o1', 'o1']
    near(body_of('o1')['volume'], 24000, .01, 'the old plate')
    step('a project in the old format opens as one part')

    # ---- a group: a container with a place and no shape, for keeping parts together
    def placed():
        return {b['part']: b['at'] for b in scene() if not b['instance']}

    def colour_of(pid):
        return p.js('corecad.scene.filter(b => b.part === ' + json.dumps(pid) + ').map(b => b.color)')

    def shown(selector):
        return p.js('!!document.querySelector(' + json.dumps(selector) + ')')

    p.click('[data-view="home"]')
    p.key('b')
    wait('corecad.draft && corecad.draft.type === "box"')
    fill('#box-x', 12)
    fill('#box-y', 12)
    fill('#box-z', 45)
    apply()
    assert [x['id'] for x in parts()] == ['o1', 'o2']
    p.click('[data-action="new-group"]')
    wait('!corecad.busy && corecad.parts.length === 3')
    g = parts()[-1]
    gid, row = g['id'], f'[data-part="{g["id"]}"]'
    assert g['name'] == 'Group 1' and g['group'] is True and g['parent'] is None and p.js('corecad.selectedPart') == gid, g
    assert p.js('document.querySelector(' + json.dumps(row) + ').classList.contains("group-row")')
    assert p.js('document.querySelector(' + json.dumps(row + ' .part-note') + ').textContent') == 'empty'
    before = placed()
    for pid in ('o1', 'o2'):
        scroll_to(f'[data-part="{pid}"]', 'center')
        drag_row(f'[data-part="{pid}"] .tree-name', row + ' .tree-name')
        wait('!corecad.busy && corecad.parts.find(x=>x.id===' + json.dumps(pid) + ').parent === ' + json.dumps(gid))
    assert placed() == before, 'nothing moved in space'
    assert p.js('document.querySelector(' + json.dumps(row + ' .part-note') + ').textContent') == '2 parts'
    # the group folds away what is in it
    p.click(f'[data-twist="{gid}"]')
    assert not shown('[data-part="o1"]') and not shown('[data-part="o2"]') and shown(row)
    p.click(f'[data-twist="{gid}"]')
    assert shown('[data-part="o1"]') and shown('[data-part="o2"]')
    # it moves what is in it
    p.click(row)
    assert p.js('corecad.selectedPart') == gid and p.js('document.getElementById("context-note").textContent').startswith('A group')
    p.key('m')
    wait('!!corecad.moving')
    assert len(p.js('corecad.rings')) == 3, 'a group is placed like a part: arrows and rings round the middle of what is in it'
    fill('#move-z', 50)
    apply_move()
    assert part(gid)['pos'] == [0, 0, 50] and placed() == {k: [v[0], v[1], v[2] + 50] for k, v in before.items()}, placed()
    # what is made while the group is selected goes into it: a box, and a sketch (which lies on the group's plane)
    p.click(row)
    p.key('b')
    wait('corecad.draft && corecad.draft.type === "box"')
    apply()
    box = parts()[-1]
    assert box['parent'] == gid and box['pos'] == [0, 0, 0] and placed()[box['id']] == [0, 0, 50], box
    p.click(row)
    p.click('#browser-content [data-plane="XY"]')
    wait('!!corecad.sketch')
    sid = p.js('corecad.sketch.part')
    assert sid not in [x['id'] for x in parts()], 'a group has no history: the sketch starts a part of its own'
    p.key('r')
    at([70, 0])
    at([90, 15])
    p.key('Escape')
    p.key('Enter', modifiers=2)
    wait('!corecad.busy && !corecad.editing')
    assert part(sid)['parent'] == gid and part(sid)['pos'] == [0, 0, 0], part(sid)
    p.key('e')
    wait('corecad.draft && corecad.draft.type === "extrude"')
    apply()
    assert placed()[sid] == [0, 0, 50] and body_of(sid)['bbox'][0][2] == 0, 'the sketch lay on the plane of the group, 50 up'
    assert p.js('corecad.doc.features.every(f => f.part !== ' + json.dumps(gid) + ')'), 'nothing was added to the group itself'
    inside = [x['id'] for x in parts() if x['parent'] == gid]
    assert inside == ['o1', 'o2', box['id'], sid], inside
    # a colour for the group is the colour of what is in it that has none of its own
    p.click(row)
    p.click('[data-action="colour"]')
    p.wait('!!document.getElementById("colour-target")')
    assert 'everything in Group 1' in p.js('document.getElementById("colour-target").textContent')
    p.click('[data-colour="#d43f3a"]')
    wait('!corecad.busy && corecad.parts.find(x=>x.id===' + json.dumps(gid) + ').color === "#d43f3a"')
    assert all(colour_of(pid) == ['#d43f3a'] for pid in inside), [colour_of(pid) for pid in inside]
    p.click('[data-part="o2"]')
    p.click('[data-action="colour"]')
    p.wait('!!document.getElementById("colour-target")')
    p.click('[data-colour="#2f6fd0"]')
    wait('!corecad.busy && corecad.parts[1].color === "#2f6fd0"')
    assert colour_of('o2') == ['#2f6fd0'] and colour_of('o1') == ['#d43f3a']
    p.key('Escape')
    # hiding it hides what is in it
    p.click(f'[data-part-eye="{gid}"]')
    wait('!corecad.busy && corecad.scene.length === 0')
    p.click(f'[data-part-eye="{gid}"]')
    wait('!corecad.busy && corecad.scene.length === 4')
    # a copy of a group is a group with copies of what is in it
    p.click(row)
    p.screenshot('.scratch/e2e-parts-group.png')
    p.click('[data-action="copy-part"]')
    wait('!!corecad.moving && corecad.parts.length === 10')
    twin = part(p.js('corecad.moving.id'))
    assert twin['group'] is True and twin['name'] == 'Group 1 copy' and len([x for x in parts() if x['parent'] == twin['id']]) == 4, twin
    assert not untitled_now(), untitled_now()
    p.key('Escape')
    wait('!corecad.busy && !corecad.editing')
    p.key('z', modifiers=2)
    wait('!corecad.busy && corecad.parts.length === 5')
    # taking the group away leaves what was in it where it is
    there = placed()
    p.click(row)
    assert shown('[data-action="ungroup"]')
    assert not untitled_now(), untitled_now()
    p.click('[data-action="ungroup"]')
    wait('!corecad.busy && corecad.parts.length === 4')
    assert all(x['parent'] is None for x in parts()) and placed() == there, parts()
    assert colour_of('o1') == [None] and colour_of('o2') == ['#2f6fd0'], 'the colour was the group\'s'
    p.click('[data-part="o1"]')
    assert not shown('[data-action="ungroup"]')
    p.key('z', modifiers=2)
    wait('!corecad.busy && corecad.parts.length === 5')
    assert [x['id'] for x in parts() if x['parent'] == gid] == inside and placed() == there
    step('a group holds parts: dragged in, made in it, moved, coloured, hidden and copied with it; ungroup leaves them where they are')
    assert not p.errors(), p.errors()


if __name__ == '__main__':
    with Browser(size=(1440, 960)) as browser:
        try:
            run(browser.page, sys.argv[1] if len(sys.argv) > 1 else 'index.html?test=1')
        except Exception:
            p = browser.page
            print('State:', p.js('({parts:window.corecad?.parts,features:window.corecad?.doc?.features.map(f=>[f.id,f.part,f.type]),draft:window.corecad?.draft,moving:window.corecad?.moving,build:window.corecad?.build?.features,toast:document.getElementById("toast")?.textContent})'))
            print('Console:', p.errors())
            p.screenshot('.scratch/e2e-parts-failure.png')
            raise
    print('ALL PARTS E2E CHECKS PASSED')

"""Colours, and what a slicer gets: 3MF with an object for each part, STL for each part, STEP.

Run with: python tools/e2e_export.py. Colours are given with the mouse and through commands; the
exported files are read back with Python's own zip and XML readers, not with the page's.
"""
import base64
import io
import json
import math
import struct
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from browser import Browser, ROOT  # noqa: E402

NS = {'m': 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02'}


def read_3mf(data):
    """The objects of a 3MF: name, colour, vertices, triangles and the colour of each painted triangle."""
    z = zipfile.ZipFile(io.BytesIO(data))
    assert z.testzip() is None, 'every file of the package has the checksum it says'
    assert z.namelist() == ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model'], z.namelist()
    assert '3D/3dmodel.model' in z.read('_rels/.rels').decode() and 'Extension="model"' in z.read('[Content_Types].xml').decode()
    root = ET.fromstring(z.read('3D/3dmodel.model'))
    assert root.get('unit') == 'millimeter'
    colors = [b.get('displaycolor') for b in root.findall('m:resources/m:basematerials/m:base', NS)]
    objects = []
    for o in root.findall('m:resources/m:object', NS):
        tris = o.findall('m:mesh/m:triangles/m:triangle', NS)
        objects.append({
            'id': o.get('id'), 'name': o.get('name'),
            'color': colors[int(o.get('pindex'))] if o.get('pindex') is not None else None,
            'vertices': [(float(v.get('x')), float(v.get('y')), float(v.get('z'))) for v in o.findall('m:mesh/m:vertices/m:vertex', NS)],
            'triangles': [(int(t.get('v1')), int(t.get('v2')), int(t.get('v3'))) for t in tris],
            'painted': [colors[int(t.get('p1'))] if t.get('p1') is not None else None for t in tris],
        })
    items = [i.get('objectid') for i in root.findall('m:build/m:item', NS)]
    assert items == [o['id'] for o in objects], 'every object is put on the plate once'
    return objects


def closed(triangles):
    """Every edge used by exactly two triangles, once each way."""
    edges = {}
    for t in triangles:
        for k in range(3):
            e = (t[k], t[(k + 1) % 3])
            edges[e] = edges.get(e, 0) + 1
    return all(n == 1 and edges.get((b, a)) == 1 for (a, b), n in edges.items())


def volume(o):
    v = 0
    for a, b, c in o['triangles']:
        p, q, r = o['vertices'][a], o['vertices'][b], o['vertices'][c]
        v += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6
    return v


def box(points):
    return [[round(min(p[i] for p in points), 2) for i in range(3)], [round(max(p[i] for p in points), 2) for i in range(3)]]


def read_stl(data):
    n = struct.unpack_from('<I', data, 80)[0]
    assert len(data) == 84 + 50 * n, 'a whole binary STL'
    return n, box([struct.unpack_from('<3f', data, 84 + t * 50 + 12 + c * 12) for t in range(n) for c in range(3)])


def run(p, url='index.html?test=1'):
    def wait(expr='!corecad.busy', timeout=30):
        return p.wait('window.corecad && (' + expr + ')', timeout=timeout)

    def call(command, /, **args):
        r = p.js(f'corecad.run({json.dumps(command)}, {json.dumps(args)})')
        if not r['ok']:
            raise AssertionError(f'{command}{args}: {r["error"]}')
        return r['result']

    def fails(command, pattern, /, **args):
        r = p.js(f'corecad.run({json.dumps(command)}, {json.dumps(args)})')
        assert not r['ok'] and pattern.lower() in r['error'].lower(), f'{command}: expected "{pattern}", got {str(r)[:200]}'

    def page(point):
        return p.js('corecad.screen(' + json.dumps(point) + ')')

    def part(name):
        return next(x for x in p.js('corecad.parts') if x['name'] == name)

    def looks(pid):
        """How the bodies of a part are drawn: its colour and its painted faces."""
        return p.js('corecad.scene.filter(b => b.part === ' + json.dumps(pid) + ').map(b => ({ color: b.color, faces: b.colors }))')

    def step(text):
        print('PASS ' + text)

    p.goto(url)
    wait('window.corecadReady && !corecad.busy', 60)
    call('new_document', name='Fixture')
    call('add_box', size=[60, 40, 12], name='Plate')
    call('add_cylinder', diameter=10, height=30, position=[15, 0, -5], name='Bore')
    call('combine', part='Plate', operation='cut', **{'with': ['Bore']})
    call('add_box', size=[20, 20, 30], position=[60, 0, 0], name='Post')
    twin = call('copy_part', part='Post', linked=True, by=[0, 40, 0], name='Post')['part']['id']
    ball = call('add_sphere', diameter=20, position=[0, 100, 0], name='Ball')['part']['id']
    call('edit_part', part='Ball', hidden=True)
    call('set_view', view='home')

    # ---- a colour for a part: the tool, a swatch
    p.click('[data-part="o3"]')
    p.click('[data-action="colour"]')
    p.wait('!!document.getElementById("colour-target")')
    assert 'the whole of Post' in p.js('document.getElementById("colour-target").textContent')
    p.click('[data-colour="#d43f3a"]')
    wait('!corecad.busy && corecad.parts[2].color === "#d43f3a"')
    assert looks('o3') == [{'color': '#d43f3a', 'faces': []}] and looks(twin) == [{'color': '#d43f3a', 'faces': []}], 'the linked copy shows the colour of its original'
    assert p.js('document.querySelector(\'[data-colour="#d43f3a"]\').classList.contains("on")') and p.js('getComputedStyle(document.querySelector(\'[data-part-colour="o3"]\')).backgroundColor') == 'rgb(212, 63, 58)'
    # a face of its own colour: click it, then a swatch
    p.click(*page([-20, 10, 12]))
    assert 'the selected face of Plate' in p.js('document.getElementById("colour-target").textContent')
    p.click('[data-colour="#2f6fd0"]')
    wait('!corecad.busy && (corecad.parts[0].paint ?? []).length === 1')
    top = looks('o1')[0]
    assert top['color'] is None and len(top['faces']) == 1 and top['faces'][0][1] == '#2f6fd0', top
    assert p.js('corecad.selection.length') == 1, 'the face stays selected, to try another colour'
    p.click('[data-colour=""]')
    wait('!corecad.busy && !corecad.parts[0].paint')
    p.key('z', modifiers=2)
    wait('!corecad.busy && (corecad.parts[0].paint ?? []).length === 1')
    # the dot in the list opens the same panel for that part
    p.click('[data-action="close-panel"]')
    p.click(f'[data-part-colour="{twin}"]')
    p.wait('!!document.getElementById("colour-target")')
    assert p.js('corecad.selectedPart') == twin and 'the whole of Post' in p.js('document.getElementById("colour-target").textContent')
    p.click('[data-colour="#58a84a"]')
    wait(f'!corecad.busy && corecad.parts.find(x => x.id === {json.dumps(twin)}).color === "#58a84a"')
    assert looks(twin)[0]['color'] == '#58a84a' and looks('o3')[0]['color'] == '#d43f3a', 'a linked copy can have a colour of its own'
    missing = p.js('[...document.querySelectorAll("button,input,select,a")].filter(e=>e.getClientRects().length&&!e.closest("[title]")).map(e=>e.outerHTML)')
    assert not missing, missing
    p.click('[data-action="close-panel"]')
    p.screenshot(ROOT / '.scratch' / 'e2e-export-colours.png')
    step('Colour: a part by a swatch, a clicked face, a linked copy of its own colour, undo')

    # ---- the same through commands
    green = call('set_color', part='Plate', color='yellow')
    assert green['part']['color'] == '#f2c230' and green['part']['painted_faces'] == 1, green['part']
    faces = call('list_faces', part='Plate')[0]
    wall = next(f['face'] for f in faces['faces'] if f['kind'] == 'cylinder')
    assert faces['color'] == '#f2c230' and [f.get('color') for f in faces['faces'] if f.get('side') == 'top'] == ['#2f6fd0'], faces
    done = call('set_color', faces=[{'face': wall}, 'bottom'], part='Plate', color='#2B2B2B')
    assert done['color'] == '#2b2b2b' and len(done['painted']) == 2 and done['part']['painted_faces'] == 3, done
    p.click(*page([60, 0, 30]))        # the top of the post
    this = call('set_color', faces='this', color='white')
    assert this['painted'][0]['part'] == 'o3' and this['part']['painted_faces'] == 1, this
    fails('set_color', 'not a colour', part='Plate', color='plaid')
    fails('set_color', 'no part', part='Nobody', color='red')
    assert call('set_color', part='Ball', color=None)['part'].get('color') is None
    step('set_color: a part, faces by description and "this", names and #rrggbb, refusals')

    # ---- 3MF: what a slicer gets
    out = call('export', format='3mf')
    assert out['filename'] == 'Fixture.3mf' and out['bytes'] > 2000
    objects = read_3mf(base64.b64decode(out['base64']))
    assert [o['name'] for o in objects] == ['Plate', 'Post', 'Post 2'], 'an object for each part that is to be seen; the tool and the hidden part are not: %s' % [o['name'] for o in objects]
    assert [o['color'] for o in objects] == ['#F2C230', '#D43F3A', '#58A84A'], [o['color'] for o in objects]
    for o in objects:
        assert closed(o['triangles']), o['name'] + ' is a closed surface'
    plate, post, post2 = objects
    assert abs(volume(plate) - (28800 - math.pi * 25 * 12)) < 2 and abs(volume(post) - 12000) < 1e-3 and abs(volume(post2) - 12000) < 1e-3
    assert box(plate['vertices']) == [[-30, -20, 0], [30, 20, 12]] and box(post['vertices']) == [[50, -10, 0], [70, 10, 30]] and box(post2['vertices']) == [[50, 30, 0], [70, 50, 30]]
    paint = lambda o: {c: o['painted'].count(c) for c in set(o['painted']) if c}
    assert set(paint(plate)) == {'#2F6FD0', '#2B2B2B'} and paint(plate)['#2B2B2B'] > paint(plate)['#2F6FD0'] >= 2, paint(plate)
    assert paint(post) == {'#F2F2EE': 2} and paint(post2) == {'#F2F2EE': 2}, 'the painted top of the post, on the original and on its linked copy: %s %s' % (paint(post), paint(post2))
    step('3MF: %d objects, named and coloured, closed, where they stand; %d painted triangles' % (len(objects), sum(sum(paint(o).values()) for o in objects)))

    # ---- STL: one file for each part; STEP
    z = call('export', format='stl', per_part=True)
    assert z['zip'] and z['filename'] == 'Fixture STL.zip'
    archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(z['base64'])))
    assert archive.testzip() is None and archive.namelist() == ['Plate.stl', 'Post.stl', 'Post 2.stl'], archive.namelist()
    meshes = [read_stl(archive.read(n)) for n in archive.namelist()]
    assert [m[1] for m in meshes] == [[[-30, -20, 0], [30, 20, 12]], [[50, -10, 0], [70, 10, 30]], [[50, 30, 0], [70, 50, 30]]], meshes
    whole = call('export', format='stl')
    assert 'zip' not in whole and read_stl(base64.b64decode(whole['base64']))[0] == sum(m[0] for m in meshes), 'without per_part: one mesh of everything'
    text = call('export', format='step')['text']
    assert "'Plate'" in text and "'Post'" in text and "'Post 2'" in text and text.count('COLOUR_RGB') >= 3
    step('STL: a zip of one file for each part, or one mesh; STEP with names and colours')

    # ---- only the selected part
    one = call('export', format='3mf', part='Plate')
    assert one['filename'] == 'Fixture - Plate.3mf' and [o['name'] for o in read_3mf(base64.b64decode(one['base64']))] == ['Plate']
    p.click(f'[data-part="{twin}"]')
    this = read_3mf(base64.b64decode(call('export', format='3mf', part='this')['base64']))
    assert [(o['name'], o['color'], box(o['vertices'])) for o in this] == [('Post', '#58A84A', [[50, 30, 0], [70, 50, 30]])], this
    fails('export', 'use the id', format='stl', part='Post')      # two parts have that name
    solo = call('export', format='stl', part='o3', per_part=True)
    assert 'zip' not in solo and solo['filename'] == 'Fixture - Post.stl' and read_stl(base64.b64decode(solo['base64']))[1] == [[50, -10, 0], [70, 10, 30]]
    fails('export', 'shows no solid', format='stl', part='Bore')
    fails('export', 'shows no solid', format='3mf', part='Ball')
    # in the dialog: a tick for the selected part; the part's own Export button comes with it ticked
    p.click('[data-part="o3"]')
    p.js('window.__lastExport = null')
    p.click('[data-action="export-menu"]')
    assert p.js('document.getElementById("export-only").checked') is False and 'Only the selected part: Post' in p.js('document.querySelector("#modal-root .panel-body").textContent')
    p.click('#export-only')
    p.click('[data-modal="3mf"]')
    p.wait('window.__lastExport?.format === "3mf"', timeout=60)
    assert p.js('window.__lastExport.name') == 'Fixture - Post.3mf', p.js('window.__lastExport')
    p.js('window.__lastExport = null')
    p.click('[data-action="export-part"]')
    assert p.js('document.getElementById("export-only").checked') is True
    assert all(p.js('[...document.querySelectorAll("#modal-root button, #modal-root input")].map(e => !!e.closest("[title]"))'))
    p.click('[data-modal="stl"]')
    p.wait('window.__lastExport?.format === "stl"', timeout=60)
    assert p.js('window.__lastExport.name') == 'Fixture - Post.stl', p.js('window.__lastExport')
    step('only the selected part: by command, by the tick in the dialog, by the part\'s own Export button')

    # ---- the Export dialog
    def export(kind):
        p.js('window.__lastExport = null')
        p.click('[data-action="export-menu"]')
        assert all(p.js('[...document.querySelectorAll("#modal-root button")].map(e => !!e.title)'))
        p.click(f'[data-modal="{kind}"]')
        p.wait(f'window.__lastExport?.format === {json.dumps(kind)}', timeout=60)
        return p.js('window.__lastExport')

    assert export('3mf')['name'] == 'Fixture.3mf'
    assert export('stl')['name'] == 'Fixture STL.zip'
    assert export('step')['name'] == 'Fixture.step'
    for name in ('Post', ):
        call('edit_part', part='o3', hidden=True)
        call('edit_part', part=twin, hidden=True)
    assert export('stl')['name'] == 'Fixture.stl', 'a single part is a plain STL file'
    step('Export: 3MF, STL for each part in a zip, a plain STL for one part, STEP')

    # ---- colours are part of the project
    p.goto(url)
    wait('window.corecadReady && !corecad.busy', 60)
    assert part('Plate')['color'] == '#f2c230' and len(part('Plate')['paint']) == 3 and looks('o1')[0]['color'] == '#f2c230' and len(looks('o1')[0]['faces']) == 3
    step('colours come back with the project after a reload')
    assert not p.errors(), p.errors()


if __name__ == '__main__':
    with Browser(size=(1440, 960)) as browser:
        try:
            run(browser.page, sys.argv[1] if len(sys.argv) > 1 else 'index.html?test=1')
        except Exception:
            p = browser.page
            print('State:', p.js('({parts:window.corecad?.parts,toast:document.getElementById("toast")?.textContent,last:window.__lastExport})'))
            print('Console:', p.errors())
            p.screenshot('.scratch/e2e-export-failure.png')
            raise
    print('ALL EXPORT E2E CHECKS PASSED')

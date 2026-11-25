"""CoreCAD's modelling acceptance path. All edits use real pointer/key events.

Run with: python tools/e2e.py. Inspection reads state and projects coordinates;
it never inserts geometry or edits the document through JavaScript.
"""
import json
import sys
from browser import Browser


def run(p, url='index.html?test=1'):
    def wait(expr='!corecad.busy', timeout=30):
        return p.wait('window.corecad && (' + expr + ')', timeout=timeout)

    def at(point, **kwargs):
        xy = p.js('corecad.screen(' + json.dumps(point) + ')')
        p.click(*xy, **kwargs)

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

    def dimension(point, value):
        at(point)
        p.key('d')
        p.wait('!!document.getElementById("dim-value")')
        fill('#dim-value', value)
        p.key('Enter')

    p.goto(url)
    wait('window.corecadReady && !corecad.busy', 45)
    p.click('[data-plane="XY"]')
    p.key('r')
    at([0, 0])
    at([57, 37])
    p.key('Escape')
    dimension([28.5, 0], 60)
    dimension([60, 18.5], 40)
    assert p.js('corecad.dof') == 0, 'Plate should be fully constrained'
    p.screenshot('.scratch/e2e-01-sketch.png')
    p.key('Enter', modifiers=2)
    wait('!corecad.busy && !corecad.editing')
    p.key('e')
    apply()
    assert abs(p.js('corecad.build.bodies[0].volume') - 24000) < .01
    print('PASS dimensioned plate and 10 mm extrusion')

    p.click('[data-view="top"]')
    at([45, 20, 10])
    assert p.js('corecad.selection[0]?.type') == 'face'
    p.key('s')
    wait('!!corecad.sketch')
    p.key('c')
    at([45, 20])
    xy = p.js('corecad.screen([49,20])')
    p.move(*xy)
    p.key('4')
    p.key('Enter')
    p.key('Escape')
    p.key('Enter', modifiers=2)
    wait('!corecad.busy && !corecad.editing')
    p.key('e')
    choose('#feature-operation', 2)
    p.click('#feature-all')
    p.click('#feature-flip')
    apply()
    assert abs(p.js('corecad.build.bodies[0].volume') - (24000 - 160 * 3.141592653589793)) < .02
    print('PASS face sketch and 8 mm through cut')
    p.screenshot('.scratch/e2e-02-cut.png')

    # The four vertical edges can be selected from two standard diagonal views.
    # Orbit using pointer input, and verify each projected point hits its intended edge.
    p.key('f')
    edges = wait('corecad.pickBodies[0].mesh.edges.map((e,i)=>({e,i})).filter(x=>x.e.kind==="line" && Math.abs(x.e.a[2]-x.e.b[2])>9 && !x.e.seam)')
    assert len(edges) == 4
    chosen = set()
    for turn in range(8):
        for item in edges:
            if item['i'] in chosen:
                continue
            xy = p.js('corecad.screen(' + json.dumps(item['e']['mid']) + ')')
            rect = p.rect('#panel')
            if rect[0] <= xy[0] <= rect[0] + rect[2] and rect[1] <= xy[1] <= rect[1] + rect[3]:
                continue
            hit = p.js('corecad.pick(' + json.dumps(xy) + ',"edge")')
            if hit and hit['edge'] == item['i']:
                p.click(*xy)
                wait('!corecad.busy && corecad.build.tag === JSON.stringify(corecad.draft) && corecad.draft.edges.length === ' + str(len(chosen) + 1))
                chosen.add(item['i'])
        if len(chosen) == 4:
            break
        r = p.rect('#viewport')
        p.drag(r[0] + 350, r[1] + 300, r[0] + 260, r[1] + 300, button='right')
    assert len(chosen) == 4, f'Only selected {len(chosen)} edges'
    fill('#blend-size', 4)
    apply()
    assert abs(p.js('corecad.build.bodies[0].volume') - 23360) < .03
    p.click('[data-view="home"]')
    p.click('[data-action="fit"]')
    p.screenshot('.scratch/e2e-03-fillet.png')
    print('PASS four real edge fillets')

    p.click('[data-feature="f2"]')
    p.click('[data-action="edit-feature"]')
    fill('#feature-distance', 20)
    apply()
    assert abs(p.js('corecad.build.bodies[0].volume') - 46720) < .05
    assert p.js('corecad.build.features.every(f=>f.status==="ok")')
    assert abs(p.js('corecad.build.features[2].frame.o[2]') - 20) < 1e-6
    p.key('z', modifiers=2)
    wait('!corecad.busy && Math.abs(corecad.build.bodies[0].volume-23360)<.03')
    p.key('y', modifiers=2)
    wait('!corecad.busy && Math.abs(corecad.build.bodies[0].volume-46720)<.05')
    print('PASS upstream height edit, references, undo and redo')

    for fmt in ['stl', 'step']:
        p.click('[data-action="export-menu"]')
        p.click('[data-modal="' + fmt + '"]')
        p.wait('window.__lastExport?.format===' + json.dumps(fmt), timeout=30)
        assert p.js('window.__lastExport.size') > 1000
    p.key('s', modifiers=2)
    count = p.js('corecad.doc.features.length')
    p.goto(url)
    wait('window.corecadReady && !corecad.busy', 40)
    assert p.js('corecad.doc.features.length') == count
    assert abs(p.js('corecad.build.bodies[0].volume') - 46720) < .05
    print('PASS exports and autosave reload')
    assert not p.errors(), p.errors()


if __name__ == '__main__':
    with Browser(size=(1440, 960)) as browser:
        try:
            run(browser.page, sys.argv[1] if len(sys.argv) > 1 else 'index.html?test=1')
        except Exception:
            p = browser.page
            print('State:', p.js('({doc:window.corecad?.doc,sketch:window.corecad?.sketch,draft:window.corecad?.draft,build:window.corecad?.build?.features})'))
            print('Console:', p.errors())
            p.screenshot('.scratch/e2e-failure.png')
            raise
    print('ALL E2E CHECKS PASSED')

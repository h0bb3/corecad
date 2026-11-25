"""Secondary mouse/keyboard flows: dragging, arcs, holes, chamfers and files."""
import json
import math
import time
from pathlib import Path
from browser import Browser, ROOT


def run(p):
    def wait(expr='!corecad.busy', timeout=25):
        return p.wait('window.corecad && (' + expr + ')', timeout=timeout)

    def at(point, **kwargs):
        p.click(*p.js('corecad.screen(' + json.dumps(point) + ')'), **kwargs)

    def fill(selector, value):
        p.click(selector); p.key('a', modifiers=2); p.type(str(value))

    def apply():
        wait('!document.getElementById("apply-feature").disabled')
        p.click('#apply-feature'); wait('!corecad.busy && !corecad.editing')

    def fresh():
        p.click('[data-action="new"]'); p.click('[data-modal="new"]'); wait()

    p.goto('index.html?test=1')
    wait('window.corecadReady && !corecad.busy', 40)
    fresh()
    p.click('[data-plane="XZ"]')
    p.key('l'); at([0, 0]); at([20, 0]); p.key('Escape'); p.key('Escape')
    start = p.js('corecad.screen([20,0])'); end = p.js('corecad.screen([30,8])')
    p.drag(*start, *end, steps=20)
    points = p.js('corecad.sketch.points')
    assert abs(points[1]['x'] - 30) < .001 and abs(points[1]['y']) < 1e-6
    at([15, 0]); p.key('d'); fill('#dim-value', 30); p.key('Enter')
    assert p.js('corecad.dof') == 0
    p.key('h')
    assert 'Already' in p.js('document.getElementById("toast").textContent')
    p.key('z', modifiers=2); assert p.js('corecad.dof') == 1
    p.key('y', modifiers=2); assert p.js('corecad.dof') == 0
    p.key('a'); at([40, 10]); at([50, 10]); at([40, 20]); p.key('Escape')
    at([47.0710678, 17.0710678]); p.click('[data-constraint="fix"]')
    assert p.js('corecad.dof') == 0, 'Fixed arc must not be reported redundant'
    p.key('p'); at([60, 10]); p.key('Escape'); at([60, 10]); p.click('[data-constraint="fix"]')
    assert p.js('corecad.dof') == 0
    p.key('Enter', modifiers=2); wait('!corecad.busy && !corecad.editing')
    # Double-click should edit history even though selection changes on first click.
    p.click('[data-feature="f1"]', count=2)
    wait('!!corecad.sketch')
    p.click('[data-action="discard-sketch"]'); wait('!corecad.busy && !corecad.editing')
    print('PASS XZ sketch, constrained drag, redundancy, arc/point fix, undo, history double-click')
    fresh()

    p.click('[data-plane="XY"]'); p.key('r'); at([0, 0])
    p.move(*p.js('corecad.screen([60,40])'))
    fill('#draw-a', '120/2'); fill('#draw-b', '40'); p.key('Enter'); p.key('Escape')
    assert p.js('corecad.dof') == 0
    # A dimension label opens with a double click and changes the constrained sketch.
    at([30, -8], count=2)
    p.wait('!!document.getElementById("dim-value")')
    fill('#dim-value', 65); p.key('Enter'); assert p.js('corecad.sketch.points[1].x') == 65
    p.key('z', modifiers=2); assert p.js('corecad.sketch.points[1].x') == 60
    p.key('Enter', modifiers=2); wait('!corecad.busy && !corecad.editing')
    p.key('e'); apply()
    p.click('[data-view="top"]'); at([20, 20, 10]); p.key('h')
    fill('#hole-diameter', '6'); p.click('#hole-all'); fill('#hole-depth', '6'); apply()
    expected = 24000 - 54 * math.pi
    assert abs(p.js('corecad.build.bodies[0].volume') - expected) < .02
    p.click('[data-view="top"]'); at([23, 20, 10])
    assert p.js('corecad.selection[0]?.type') == 'edge'
    p.key('f', modifiers=8); apply()
    expected -= 10 * math.pi / 3
    assert abs(p.js('corecad.build.bodies[0].volume') - expected) < .02
    p.screenshot('.scratch/e2e-more-hole-chamfer.png')
    print('PASS typed rectangle, editable dimensions, blind hole and rim chamfer')

    # Suppression causes an explicit lost reference; enabling the hole repairs it.
    p.click('[data-feature="f3"]'); p.click('[data-action="suppress"]'); wait()
    assert p.js('corecad.build.features[3].status') == 'error'
    p.click('[data-action="suppress"]'); wait()
    assert p.js('corecad.build.features.every(f=>f.status==="ok")')
    p.click('[data-feature="f4"]'); p.click('[data-action="edit-feature"]')
    fill('#blend-size', 30)
    wait('!corecad.busy && corecad.build.tag===JSON.stringify(corecad.draft)')
    assert p.js('document.getElementById("apply-feature").disabled')
    assert p.js('!document.getElementById("preview-error").hidden')
    p.key('Escape'); wait('!corecad.busy && !corecad.editing')
    assert abs(p.js('corecad.build.bodies[0].volume') - expected) < .02
    print('PASS lost-reference warnings and failed blend cancellation')

    # Actual download and file-input reopen, separate from autosave.
    directory = ROOT / '.scratch' / 'e2e-downloads'
    directory.mkdir(exist_ok=True)
    p.call('Browser.setDownloadBehavior', behavior='allow', downloadPath=str(directory))
    name = 'CoreCAD-file-test-' + str(time.time_ns())
    p.click('[data-action="rename-project"]'); fill('#name-value', name); p.key('Enter'); wait()
    p.key('s', modifiers=2)
    file = directory / (name + '.corecad')
    deadline = time.monotonic() + 10
    while not file.exists() and time.monotonic() < deadline:
        time.sleep(.1)
    assert file.exists(), 'Project download missing'
    saved = json.loads(file.read_text(encoding='utf-8'))
    assert len(saved['features']) == 4
    fresh()
    root = p.call('DOM.getDocument')['root']['nodeId']
    node = p.call('DOM.querySelector', nodeId=root, selector='#file-input')['nodeId']
    p.call('DOM.setFileInputFiles', nodeId=node, files=[str(file)])
    wait('!corecad.busy && corecad.doc.features.length===4')
    assert abs(p.js('corecad.build.bodies[0].volume') - expected) < .02
    print('PASS .corecad download and file-input reopen')

    p.click('[data-feature="f1"]'); p.click('[data-action="replane"]'); wait()
    p.click('#panel [data-plane="YZ"]'); wait()
    assert p.js('corecad.build.features.every(f=>f.status==="ok")')
    bounds = p.js('corecad.build.bodies[0].bbox')
    assert abs(bounds[1][0]-10) < .001 and abs(bounds[1][1]-60) < .001 and abs(bounds[1][2]-40) < .001
    assert abs(p.js('corecad.build.bodies[0].volume') - expected) < .02
    p.key('z', modifiers=2); wait()
    p.click('[data-part-eye="o1"]'); wait()
    assert p.js('corecad.doc.parts[0].hidden') and p.js('corecad.scene.length') == 0
    p.click('[data-part-eye="o1"]'); wait()
    assert p.js('corecad.scene.length') == 1
    p.click('[data-feature="f2"]'); p.click('[data-action="rollback"]'); wait()
    assert abs(p.js('corecad.build.bodies[0].volume')-24000) < .01
    p.click('[data-action="end-history"]'); wait()
    assert abs(p.js('corecad.build.bodies[0].volume') - expected) < .02
    print('PASS plane redefinition, part visibility and history rollback')

    # Hover help is attached to every visible, enabled control in the final shell.
    missing = p.js('[...document.querySelectorAll("button,input,select,a")].filter(e=>e.getClientRects().length&&!e.closest("[title]")).map(e=>e.outerHTML)')
    assert not missing, missing
    assert not p.errors(), p.errors()


if __name__ == '__main__':
    with Browser(size=(1440, 960)) as browser:
        try:
            run(browser.page)
        except Exception:
            p = browser.page
            print('State:', p.js('({doc:window.corecad?.doc,sketch:window.corecad?.sketch,draft:window.corecad?.draft,build:window.corecad?.build?.features,toast:document.getElementById("toast")?.textContent})'))
            print('Console:', p.errors())
            p.screenshot('.scratch/e2e-more-failure.png')
            raise
    print('ALL SECONDARY E2E CHECKS PASSED')

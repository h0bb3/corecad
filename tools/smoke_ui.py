"""Fast application boot / sketch smoke check using real browser input."""
from browser import Browser

with Browser(size=(1440, 960)) as b:
    p = b.page
    p.goto('index.html?test=1')
    try:
        p.wait('window.corecad && !corecad.busy && window.corecadReady', timeout=40)
        p.click('[data-plane="XY"]')
        p.wait('!!corecad.sketch')
        p.key('r')
        xy = p.js('corecad.screen([0,0])')
        p.click(*xy)
        xy = p.js('corecad.screen([60,40])')
        p.move(*xy)
        p.click(*xy)
        p.key('Escape')
        p.screenshot('.scratch/ui-sketch.png')
        print(p.js('({sketch:corecad.sketch,dof:corecad.dof})'))
        print('ERRORS', p.errors())
    except Exception:
        print(p.errors())
        p.screenshot('.scratch/ui-failure.png')
        raise

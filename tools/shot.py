"""A screenshot of a page of the project, after optional waiting and scripting.

    python tools/shot.py index.html out.png [--size 1400x900] [--wait JS] [--js JS] [--delay 0.5] [--dark]

--wait: a JavaScript expression to wait for (truthy) before anything else.
--js:   JavaScript to run before the picture (may be given several times;
        each is awaited). Its value is printed.
Console errors are printed too. For clicking and dragging, write a small
script with tools/browser.py instead.
"""
import sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from browser import Browser  # noqa: E402


def main():
    a = sys.argv[1:]
    def opt(name, default=None, many=False):
        out = []
        while name in a:
            i = a.index(name); out.append(a[i + 1]); del a[i:i + 2]
        return out if many else (out[-1] if out else default)
    size = tuple(int(v) for v in opt('--size', '1400x900').split('x'))
    wait, scripts, delay = opt('--wait'), opt('--js', many=True), float(opt('--delay', '0.3'))
    dark = '--dark' in a
    if dark:
        a.remove('--dark')
    page, out = a[0], a[1]
    with Browser(size=size, dark=dark) as b:
        p = b.page
        p.goto(page)
        if wait:
            p.wait(wait, timeout=90)
        for s in scripts:
            print('js:', p.js(s))
        time.sleep(delay)
        print(p.screenshot(out))
        for e in p.errors():
            print('[console]', e)


if __name__ == '__main__':
    main()

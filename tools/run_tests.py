"""Runs test pages in a headless Chrome and prints what they report.

    python tools/run_tests.py                       every test/*.test.html
    python tools/run_tests.py test/solver.test.html [more pages] [--timeout 120] [--only text]

A test page uses test/harness.js: it sets window.__tests = {done, passed,
failed, lines} when it has finished. The exit code is 0 when every page
passed and nothing went wrong in the console.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from browser import Browser, ROOT  # noqa: E402


def main():
    args = sys.argv[1:]
    timeout, only = 120, None
    if '--timeout' in args:
        i = args.index('--timeout'); timeout = float(args[i + 1]); del args[i:i + 2]
    if '--only' in args:
        i = args.index('--only'); only = args[i + 1]; del args[i:i + 2]
    pages = args or sorted(str(p.relative_to(ROOT)).replace('\\', '/') for p in (ROOT / 'test').glob('*.test.html'))
    if not pages:
        print('no test pages'); return 1
    bad = 0
    with Browser() as b:
        p = b.page
        for page in pages:
            p.console.clear()
            url = page + (('&' if '?' in page else '?') + 'only=' + only if only else '')
            print(f'== {page}')
            try:
                p.goto(url)
                r = p.wait('window.__tests && window.__tests.done && window.__tests', timeout=timeout)
            except Exception as e:  # a page that never reports is a failure with its console
                print(f'   DID NOT FINISH: {e}')
                for k, t in p.console[-20:]:
                    print(f'   [{k}] {t}')
                bad += 1
                continue
            for line in r['lines']:
                print('   ' + line)
            errors = p.errors()
            for e in errors:
                print(f'   [console] {e}')
            print(f"   {r['passed']} passed, {r['failed']} failed")
            if r['failed'] or errors:
                bad += 1
    print('ALL PASSED' if not bad else f'{bad} PAGE(S) FAILED')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())

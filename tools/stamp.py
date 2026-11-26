"""Stamps the build: writes src/version.js with a name for exactly this set of files, and their list.

    python tools/stamp.py           write src/version.js
    python tools/stamp.py --check   exit 1 when src/version.js is not the stamp of the files as they are

The page compares its own stamp with the one that is published, to say when a newer CoreCAD is there,
and fetches the listed files afresh when it reloads to get it (src/update.js). There is no build step:
this is run before a commit, and tools/run_tests.py refuses to pass when it was forgotten.
"""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / 'src' / 'version.js'


def files():
    """What the page is made of, as paths from the site's root."""
    found = [ROOT / 'index.html', ROOT / 'view.html', ROOT / 'style.css']
    found += sorted(p for p in (ROOT / 'assets').rglob('*') if p.is_file())
    found += sorted(p for p in (ROOT / 'src').rglob('*.js') if p != TARGET)
    return [p.relative_to(ROOT).as_posix() for p in found]


def stamp():
    names = files()
    h = hashlib.sha256()
    for name in names:
        h.update(name.encode() + b'\0' + (ROOT / name).read_bytes().replace(b'\r\n', b'\n') + b'\0')
    return (
        '// Written by tools/stamp.py: do not edit. BUILD names exactly this set of files;\n'
        '// FILES is what the page is made of (src/update.js reads both from the published copy).\n'
        f"export const BUILD = '{h.hexdigest()[:10]}';\n"
        f'export const FILES = {json.dumps(names + ["src/version.js"], indent=2)};\n'
    )


def current():
    return TARGET.exists() and TARGET.read_text(encoding='utf-8').replace('\r\n', '\n') == stamp()


if __name__ == '__main__':
    if '--check' in sys.argv:
        if not current():
            print('src/version.js is not current: run  python tools/stamp.py')
            sys.exit(1)
        print('src/version.js is current')
    else:
        TARGET.write_text(stamp(), encoding='utf-8', newline='')
        print('stamped', stamp().split("'")[1])

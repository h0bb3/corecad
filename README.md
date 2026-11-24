# CoreCAD

A simple, constraint-based CAD program for 3D modelling, in the browser:
sketch on a plane, constrain and dimension the sketch, extrude it, cut holes
and pockets, round and bevel the edges, export for printing. Inspired by the
way Fusion 360 works.

**Status: under construction.** The foundations are proven (see
`docs/KERNEL_NOTES.md`); the program itself is being built. What it is meant
to be is in `docs/BRIEF.md`.

## How it is made

- A static site: plain HTML, CSS and JavaScript modules, no build step.
- Geometry kernel: [OpenCascade](https://dev.opencascade.org) through
  [replicad](https://replicad.xyz), in a worker. Real B-rep: exact booleans,
  real fillets and chamfers, STEP export.
- 3D view: [three.js](https://threejs.org).
- The constraint solver is CoreCAD's own.

## Development

There is no build step and nothing to install. Serve the folder
(`python -m http.server`) and open it. Tests run in a browser:

    python tools/run_tests.py

needs Python 3 and Chrome; `tools/browser.py` drives a headless Chrome for
tests, screenshots and end-to-end scripts.

## Licence

MIT: see [LICENSE](LICENSE). The libraries are loaded from a CDN at pinned
versions and are not part of this repository: three.js (MIT), replicad (MIT)
and its build of OpenCascade (LGPL 2.1).

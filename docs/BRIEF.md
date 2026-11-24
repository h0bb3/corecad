# CoreCAD: the brief

## The request, in the owner's words

> CoreCAD: a simple cad program for 3d modeling. Constraint based inspired by
> fusion 360 in browser, think the 2d blueprints and extruding doing
> holes/cuts. Bevels and rounded corners.

The owner is one person who needs this tool for himself: to model parts in
the browser the way Fusion 360 does it, without Fusion 360. He makes games
and 3D-printable things, uses the mouse a lot, and judges tools by how few
steps the common case takes. He liked that the last tool he was given
explained every control on hover.

## What the workflow must be

The Fusion 360 loop, and nothing that gets in its way:

1. **Sketch** on a plane (XY, XZ, YZ) or on a flat face of the part.
2. Draw lines, rectangles, circles, arcs. The sketch is **constraint based**:
   geometric constraints (coincident, horizontal, vertical, parallel,
   perpendicular, tangent, equal, concentric, midpoint, …) and **dimensions**
   that drive the geometry. Change a dimension and the sketch follows.
   Drag a point and the rest keeps its constraints. It is shown whether the
   sketch is fully constrained.
3. **Extrude** a closed profile into a solid: new body, join, or **cut**.
4. Sketch on a face of the result and cut **holes** and pockets.
5. **Fillet** (rounded) and **chamfer** (bevelled) edges.
6. Everything is **parametric**: a history of features that can be edited
   afterwards, and the part rebuilds.
7. **Export** for printing and for other CAD (STL, STEP); save and reopen
   the project.

## Fixed decisions

- **A static site.** Plain HTML, CSS and JavaScript modules; no build step,
  no bundler, no framework, no TypeScript. It must run from any static
  server (GitHub Pages). There is **no Node.js on the development machine**:
  nothing may depend on npm, and tests run in a browser.
- **Geometry kernel: OpenCascade through replicad**, in a module Web Worker,
  loaded from the CDN at pinned versions. It is proven to work this way; see
  `docs/KERNEL_NOTES.md` for what it does and for its traps. Real B-rep:
  exact booleans, real fillets and chamfers, STEP export.
- **three.js** (0.187.0, from the CDN through an import map) for the 3D view.
- **Our own constraint solver** in plain JavaScript: it is the heart of the
  program, it must be testable without the kernel, and it has no dependency.
- **Units are millimetres. Z is up**; the XY plane is the ground.
- The kernel never blocks the page: rebuilding happens in the worker and the
  page shows that it is working.
- Dependencies come from `cdn.jsdelivr.net` at exact versions:
  `three@0.187.0`, `replicad@1.2.1`, `replicad-opencascadejs@1.2.1`.
  Nothing else without a good reason.
- Licence of our code: MIT. (three and replicad are MIT; OpenCascade is
  LGPL 2.1 and is loaded, not copied.)

## Scope of the first version

**Must** (the request, read plainly):

- Sketch on the three origin planes and on planar faces.
- Sketch entities: point, line (chained), rectangle, circle, arc;
  construction geometry (does not make profiles).
- Constraints: coincident, point on line/circle, horizontal, vertical,
  parallel, perpendicular, tangent, equal (length, radius), concentric,
  midpoint, fix. Dimensions: distance (point–point, point–line, line
  length; horizontal/vertical/aligned), radius, diameter, angle.
- Constraints inferred while drawing (snap to points, horizontal/vertical,
  on-curve), the way Fusion does it.
- Solving on every change; dragging; degrees of freedom shown (free geometry
  one colour, fully constrained another); conflicts and redundant
  constraints reported, never a silent wrong result.
- Closed-profile detection with holes (nested loops); choosing which
  profiles to extrude.
- Extrude: distance, both directions/symmetric, through-all for cuts;
  operations new body, join, cut, intersect; live preview.
- Hole: a quick way to a round hole of a given diameter and depth (or
  through) at a chosen place on a flat face.
- Fillet and chamfer on chosen edges of a body, with preview and with a
  clear message when the kernel cannot build it.
- A feature history (timeline/browser): edit a feature's sketch or
  parameters, delete, suppress, rename; the part rebuilds; a feature that
  fails says why and the rest still shows.
- References to faces and edges that survive a rebuild in the ordinary
  cases (a sketch on the top face stays on the top face when the height
  changes; filleted edges stay chosen), and a visible warning when a
  reference is lost.
- Undo and redo.
- Save and open a project file; autosave in the browser; export STL and
  STEP.
- A 3D view to live in: orbit, pan, zoom, fit, standard views, selection
  highlighting of faces and edges, the origin planes.
- Every control explains itself on hover.

**Should** (if it does not endanger the above):

- Rounded and bevelled corners in the sketch itself (2D fillet/chamfer of a
  corner).
- Trim and offset in the sketch; mirror; symmetric constraint; collinear.
- Named parameters and expressions in dimensions (`width / 2`).
- Projecting edges of the body into the sketch as reference geometry.
- Measure tool; section view; several bodies shown/hidden.

**Not in the first version:** revolve, sweep, loft, shell, patterns,
assemblies, splines, drawings, text, imports.

## Quality bar

- The solver, the profile finder and the document model are pure modules
  with tests; the kernel worker has tests that run the real kernel.
- There is an end-to-end script that uses the page like a person (mouse and
  keys through `tools/browser.py`): sketch a plate, dimension it, extrude it,
  cut a hole on its top face, fillet edges, export. It is the proof that the
  program works, and it is how a change is checked.
- Honest errors over silent garbage, everywhere.

## How to work in this repository

- Folder: `E:\projects\new_coding\github\corecad` (Windows; Git Bash and
  PowerShell are available; Python 3 is available; Node is not).
- Run tests: `python tools/run_tests.py` (every `test/*.test.html`) or with
  page names. A test page imports `test/harness.js` (`test`, `eq`, `ok`,
  `near`, `throws`, `run`) and is a plain HTML file with a module script.
- Look at the page: `python tools/shot.py index.html out.png --wait "JS
  expression"`, and read the PNG. For clicking and dragging, write a small
  Python script with `tools/browser.py` (`Browser`, `page.goto`, `page.wait`,
  `page.click`, `page.drag`, `page.key`, `page.js`, `page.screenshot`,
  `page.errors()`); its docstrings are the manual. Several can run at once.
- Screenshots and other scratch output go under `.scratch/` in the
  repository (it is ignored by git), never elsewhere.
- Do not commit; the lead commits. Do not touch any other repository.
- Code style: modern plain JavaScript modules, small files with one job,
  logic kept apart from the DOM so that it can be tested, comments that say
  why. JSDoc typedefs where a shape of data is shared between modules.

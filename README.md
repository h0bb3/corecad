# CoreCAD

A simple, constraint-based CAD program for 3D modelling, in the browser:
sketch on a plane, constrain and dimension the sketch, extrude it, cut holes
and pockets, round and bevel the edges, export for printing. Inspired by the
way Fusion 360 works.

**[Open CoreCAD](https://h0bb3.github.io/corecad/)** — the first working version.
No account or installation. Projects stay in your browser or in files you download.
The geometry libraries load from a CDN, so the first visit needs internet access.

## Make a first part

1. Choose the **XY** plane and press **R** for a rectangle. Click the origin,
   then the opposite corner. You can type width and height before placing it.
2. Press **Esc** to select. Click a line and press **D** to dimension it.
   Blue geometry can move; green geometry is constrained. Shift-click selects
   several points or curves for geometric constraints.
3. **Finish sketch**, then **Extrude**. Choose closed areas, an operation and
   a depth. Apply accepts the preview.
4. Select a flat face and **Sketch** again, or use **Hole**. A face sketch can
   be extruded as a cut; **Reverse direction** points it into the part.
5. Select solid edges and use **Fillet** or **Chamfer**. Add more edges in the
   preview. Invalid sizes explain the failure and keep the earlier solid.
6. Double-click a feature in the history to edit it. Dimensions can also be
   edited by double-clicking their labels inside a sketch.
7. **Save** downloads an editable `.corecad` project. **Export** produces STL
   for printing or STEP with exact solid geometry.

Autosave keeps the last committed project in this browser. Download a project
file for a portable copy; clearing browser storage removes the autosave.
The **?** button lists shortcuts. Every control has hover help.

| Action | Shortcut / mouse |
| --- | --- |
| Sketch / Extrude / Hole | S / E / H |
| Line / Rectangle / Circle / Arc / Point | L / R / C / A / P, in a sketch |
| Dimension / Construction | D / X, in a sketch |
| Fillet / Chamfer | F / Shift+F |
| Finish sketch | Ctrl+Enter |
| Undo / Redo | Ctrl+Z / Ctrl+Y |
| Save / Open | Ctrl+S / Ctrl+O |
| Orbit | Right drag, in model mode |
| Pan | Middle drag or Shift+right drag |
| Zoom / Fit / Isometric | Scroll / F6 / Home |

The first version includes the required sketch constraints, dimensions, profiles
with holes, all four extrusion operations, quick holes, edge treatments, editable
history, undo/redo, body visibility and exports. See [STATUS](docs/STATUS.md) for
validation and remaining limits, [SPEC](docs/SPEC.md) for the implementation contract,
and [BRIEF](docs/BRIEF.md) for the original scope.

## Scripts and agents

Everything the controls do can also be asked for by name, with JSON in and
out, from the browser console or by an agent that can run JavaScript in the
tab:

```js
await corecad.run('add_sketch', { plane: 'XY', shapes: [{ type: 'rectangle', corner: [0, 0], width: 60, height: 40 }] });
await corecad.run('extrude', { distance: 10 });
await corecad.run('fillet', { edges: { parallel: 'z' }, radius: 4 });
```

A command is one undo step, is shown in the history and the view, and
changes nothing if the kernel cannot build what was asked. `corecad.tools`
lists the commands with their arguments; [docs/COMMANDS.md](docs/COMMANDS.md)
explains them. There is no MCP server yet; this list is what one will expose.

## How it is made

- A static site: plain HTML, CSS and JavaScript modules, no build step.
- Geometry kernel: [OpenCascade](https://dev.opencascade.org) through
  [replicad](https://replicad.xyz), in a worker. Real B-rep: exact booleans,
  real fillets and chamfers, STEP export.
- 3D view: [three.js](https://threejs.org).
- The constraint solver is CoreCAD's own.

## Development

There is no build step or npm dependency. Serve the folder with
`python -m http.server` and open `http://localhost:8000/` (ES modules and workers
need HTTP, not `file://`). Tests run in a real browser:

```sh
python tools/run_tests.py
python tools/e2e.py
python tools/e2e_more.py
```

These need Python 3 and Chrome; `tools/browser.py` uses only Python's standard
library to drive headless Chrome. Set `CHROME` if Chrome is in a nonstandard
location. The end-to-end scripts edit with actual mouse and keyboard events.
Their test autosave is separate from normal projects; screenshots and downloads
go under ignored `.scratch/`. Tests do not import any scratch prototypes.

Core modules are in `src/core`, `src/sketch`, `src/doc`, `src/kernel` and
`src/view`. `src/app.js` connects the editor, forms and document store. Kernel
operations run in a module worker with a bounded prefix cache and stable face
labels; the sketch solver has no external dependency.

## Licence

MIT: see [LICENSE](LICENSE). The libraries are loaded from a CDN at pinned
versions and are not part of this repository: three.js (MIT), replicad (MIT)
and its build of OpenCascade (LGPL 2.1).

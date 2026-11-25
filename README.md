# CoreCAD

A simple, constraint-based CAD program for 3D modelling, in the browser:
sketch on a plane, constrain and dimension the sketch, extrude it, cut holes
and pockets, round and bevel the edges, export for printing. Build a scene
from several parts: place them, copy them, start them from a box, a cylinder
or a sphere, and join or cut them with each other. Inspired by the way
Fusion 360 works.

**[Open CoreCAD](https://h0bb3.github.io/corecad/)**. No account or installation. Projects stay in your browser or in files you download.
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
7. **Save** downloads an editable `.corecad` project. **Export** produces
   3MF for printing (every part an object of its own in the slicer, with its
   name and colours), STL, or STEP with exact solid geometry.

## Several parts

A project is made of parts. Each part has its own history, listed under it,
and its own place.

- **Box**, **Cylinder** and **Sphere** start a part without a sketch.
  **Part** starts an empty one: the next sketch goes into it.
- Select a part in the list or by clicking it in the view. **Move** (or a
  double-click on it in the list) places it: drag an arrow to move it in
  steps of 1 mm, drag a ring to turn it in steps of 15° (Shift: single
  degrees, Ctrl: freely), or type a position, or an angle to turn by about X,
  Y or Z. Each ring and button always turns about its own axis, round the
  middle of the part. Its parent is chosen there too, or by dragging the part
  onto another in the list; a part moves with its parent.
- **Revolve** (by command, for now without a dialog in the page) turns closed
  areas of a sketch about a line of that sketch: anything that is turned on
  a lathe. It has a row in the history, and its angle stands on the model
  where it can be clicked and typed over.
- **Group** makes a container for parts: a name and a place, and no shape
  of its own. Drag parts onto it in the list, or make them while it is
  selected. Moving, turning, hiding, copying or exporting a group does that
  to everything in it, and its colour is the colour of the parts in it that
  have none of their own. A group can hold groups. **Ungroup** takes it away
  and leaves the parts where they are.
- **Copy** makes a part with its own history. **Linked copy** shows the
  original in another place and changes with it.
- **Combine** joins other parts to the selected part, cuts them out of it, or
  keeps what they share. The others become its tools: hidden, listed under
  it, and still there to move or edit, with the result following.

## Colours, and printing several parts

- **Colour** gives the selected part a colour, or the faces you clicked a
  colour of their own. The dot beside a part in the list does the same.
- For printing, export **3MF**: each part arrives in the slicer as its own
  object, named, coloured and where you placed it. An STL file is only one
  mesh, so several parts as STL come as a .zip with one file for each.
- To export one part alone, select it and use its **Export** button (under
  the list), or tick "Only the selected part" in the Export dialog.

## Sizes at a glance

- Rest the mouse on a face or an edge: its sizes are drawn on it, each
  number along the side or edge it measures.
- Click one thing and Shift-click another: the distance between them is
  drawn (hole to hole, face to face, a hole from a side), or their angle.
- **Dimensions** (D) shows the numbers that drive the selected part, each
  on the line it measures, with its overall size in grey. A number says what
  it is when the mouse is on it. Click a number, type, Enter.
- Click a feature in the history and its own numbers are shown the same way.

Autosave keeps the last committed project in this browser. Download a project
file for a portable copy; clearing browser storage removes the autosave.
The **?** button lists shortcuts. Every control has hover help.

| Action | Shortcut / mouse |
| --- | --- |
| Sketch / Extrude / Hole | S / E / H |
| Line / Rectangle / Circle / Arc / Point | L / R / C / A / P, in a sketch |
| Dimension / Construction | D / X, in a sketch |
| Fillet / Chamfer | F / Shift+F |
| Box / Move the selected part | B / M |
| Dimensions on the model | D |
| Finish sketch | Ctrl+Enter |
| Undo / Redo | Ctrl+Z / Ctrl+Y |
| Save / Open | Ctrl+S / Ctrl+O |
| Orbit | Right drag, in model mode |
| Pan | Middle drag or Shift+right drag |
| Zoom / Fit / Isometric | Scroll / F6 / Home |

The first version includes the required sketch constraints, dimensions, profiles
with holes, all four extrusion operations, quick holes, edge treatments, editable
history, undo/redo and exports; 0.2 adds parts with their own histories, placement,
copies, primitives and combining; since then groups, colours, sizes on the model,
3MF export, revolve and the commands for agents.

Where to read:

| Page | What is in it |
| --- | --- |
| [STATUS](docs/STATUS.md) | Where the project stands, what is decided, what is open, what comes next, and the log of the work. Start here to continue. |
| [COMMANDS](docs/COMMANDS.md) | The commands for scripts and agents, and the rule they follow. |
| [bridge/README](bridge/README.md) | The MCP bridge: how a client reaches a tab, and what the code protects. |
| [SPEC](docs/SPEC.md) | The implementation contract: document, parts, sketches, solids, references. |
| [KERNEL_NOTES](docs/KERNEL_NOTES.md) | What was tried with the geometry kernel, and what it did. |
| [BRIEF](docs/BRIEF.md) | The original scope. |

## Scripts and agents

Everything the controls do can also be asked for by name, with JSON in and
out, from the browser console or by an agent that can run JavaScript in the
tab:

```js
await corecad.run('add_part');
await corecad.run('add_sketch', { plane: 'XY' });
await corecad.run('add_to_sketch', { shapes: [{ type: 'rectangle', corner: [0, 0], width: 60, height: 40 }] });
await corecad.run('extrude', { distance: 10 });
await corecad.run('fillet', { edges: { parallel: 'z' }, radius: 4 });
```

A command is one undo step, is shown in the history and the view, and
changes nothing if the kernel cannot build what was asked. The commands are
a toolbox of primitives with one way to do each thing: a box is a part, a
sketch, a rectangle and an extrusion, and there is no command that does the
four at once. `corecad.tools` lists the commands with their arguments;
[docs/COMMANDS.md](docs/COMMANDS.md) explains them.

**With Claude, over MCP.** The **Connect** dialog pairs the tab with a small
relay: the tab names a code, you give Claude the address that ends in that
code as a custom connector, and Claude can then build and change the model in
your open tab while you watch. You can say "this" and "here": Claude is told
what you have clicked and what your mouse last rested on (a ring marks it),
so "a hole on this face" or "make this hole bigger" works by pointing. How it
works and what the code protects: [bridge/README.md](bridge/README.md).

CoreCAD is updated often. A tab that has been open for a while shows an
**Update** button when a newer version is published (the agent can do the
same with `reload_app`); your project is kept. If the agent does not see a
new command after that, reconnect CoreCAD in the client so that it reads the
list of tools again.

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
python tools/stamp.py        # after any change to the page: names the build (src/version.js)
python tools/run_tests.py
python tools/e2e.py
python tools/e2e_more.py
python tools/e2e_parts.py
python tools/e2e_api.py
python tools/e2e_export.py
python tools/e2e_bridge.py   # the MCP bridge; this one needs Node
```

These need Python 3 and Chrome; `tools/browser.py` uses only Python's standard
library to drive headless Chrome. Set `CHROME` if Chrome is in a nonstandard
location. The end-to-end scripts edit with actual mouse and keyboard events.
Their test autosave is separate from normal projects; screenshots and downloads
go under ignored `.scratch/`. Tests do not import any scratch prototypes.

- `tools/run_tests.py` runs every `test/*.test.html` and fails with "NOT
  CURRENT" if `tools/stamp.py` was not run after the last change to the page.
- `tools/e2e_bridge.py` starts the relay in `bridge/` with Node: have `node`
  on the PATH or give its path in `NODE`. The relay's own tests are `npm
  test` in `bridge/`.
- `main` is the published site (GitHub Pages), about a minute after a push:
  the new build is there when `src/version.js` on the site names it. Then
  the same scripts check the public page: `python tools/e2e_api.py
  "https://h0bb3.github.io/corecad/?test=1"`, and `python tools/e2e_bridge.py
  --live` through the public relay.
- A change to the commands needs its line in the `COMMANDS` list of
  `tools/e2e_api.py`, which is compared with what the page has.

Core modules are in `src/core`, `src/sketch`, `src/doc`, `src/kernel` and
`src/view`. `src/app.js` connects the editor, forms and document store. Kernel
operations run in a module worker with a bounded prefix cache and stable face
labels; the sketch solver has no external dependency. Parts (hierarchy,
placement, copies) are in `src/doc/parts.js` and `src/core/mat.js`; the kernel
builds each part's history on its own, tools before the parts that use them.

## Licence

MIT: see [LICENSE](LICENSE). The libraries are loaded from a CDN at pinned
versions and are not part of this repository: three.js (MIT), replicad (MIT)
and its build of OpenCascade (LGPL 2.1).

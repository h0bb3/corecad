# CoreCAD status — 2026-11-26

This page begins with where the project stands, what is decided, what is
open and what comes next. [The log](#the-log) under that is how it got there,
in the order the work was done.

## Where it stands

CoreCAD is live at [h0bb3.github.io/corecad](https://h0bb3.github.io/corecad/):
`main` is what is published. The page is build `e8bec3e081`
(`src/version.js` names the build).

What it does:

- **Sketches** on origin planes and flat faces, with constraints and driving
  dimensions, solved by CoreCAD's own solver.
- **Solids**: extrude and revolve (new body, join, cut, intersect), fillet
  and chamfer, in an editable history with undo and redo.
- **Parts**: each with its own history and its own place; groups; copies and
  linked copies; combine (join, cut, intersect) of parts where they stand;
  arrows and rings to move and turn them.
- **Sizes on the model**: where the mouse rests, between two clicked things,
  and the Dimensions view, where a number is clicked and typed over.
- **Looking inside**: Section cuts the model open along a plane, with the
  cuts filled in, and X-ray draws it see-through; what is inside is pointed
  at and measured like the outside.
- **Colours** for parts and for single faces. **Export** as 3MF (an object
  for each part), STL and STEP, of everything or of one part. Project files,
  and an autosave in the browser.
- **For an agent**: 39 commands behind `window.corecad.run`
  ([COMMANDS.md](COMMANDS.md)), and the same list over MCP through a relay
  ([bridge/README.md](../bridge/README.md)): 40 tools with the relay's own.
  "This", "selected" and "pointed" mean what the person has clicked or rests
  the mouse on, and `get_selection` says how they are looking at the model.
  While an agent is at work the page says so: a frame round the view, a line
  with what it does, the Connect button.
- A tab notices a newer published build and reloads into it (the **Update**
  button, `reload_app`).

Verified on this build, 2026-11-26:

- `python tools/run_tests.py`: 124 tests in 16 pages; the kernel pages run
  the real OpenCascade worker.
- The end-to-end scripts in headless Chrome, all passing: `tools/e2e.py`,
  `e2e_more.py`, `e2e_parts.py` and `e2e_export.py` (real mouse and key
  events), `e2e_api.py` (every command with expected volumes; the list of
  commands is asserted exactly) and `e2e_bridge.py` (MCP over HTTP through a
  local relay into the page).
- On the public site: `e2e_api.py` against the published page, and
  `e2e_bridge.py --live` through the public relay.

Not verified:

- **By hand.** What the owner has reported from use is in the log (turning
  parts, which led to the rings; a 3MF opened in Bambu Studio). Everything
  else rests on the scripts.
- **A slicer.** Bambu Studio opened a 3MF from CoreCAD with the message "The
  3mf file has invalid config, load geometry data only"; the geometry was
  right. What causes the message was not found, and whether the parts arrive
  as separate named objects with their colours is not confirmed.
- **Claude's own connector.** The relay has been used by the test clients
  and by an agent of the owner's. Adding it in Claude as a custom connector
  has not been reported.
- **Other browsers.** Chrome on a Windows desktop only.

## Decided

- **One way to do each thing; primitives, not conveniences** (the owner,
  2026-11-25). How the rule is applied is in
  [COMMANDS.md](COMMANDS.md#one-way-to-do-each-thing). Before a command or an
  argument is added: if what is there can already do it, it is not added.
- **The shapes of a sketch stay** (`rectangle`, `circle` and `polyline`
  beside `line`): saving calls is worth something too, and a rectangle and a
  circle bring the dimensions a person changes them by (the owner,
  2026-11-25). This settles the shapes that are there. It does not open the
  door to new shortcuts: ask first.
- **An agent is the main user; a person inspects and directs.** A new
  operation needs a command, a row in the history and readable numbers on
  the model. A dialog and a toolbar button are not required (revolve has
  neither).
- **Groups are not scaled.** Placements are rigid everywhere.
- **Nothing to install for a user.** The bridge is a hosted relay, not a
  helper program on the user's machine.
- **A static site with no build step**, tested in a real browser.

## Open, for the owner

1. **The page's own shortcuts.** Box, Cylinder, Sphere, Hole, Ungroup, the
   symmetric tick of the extrude dialog and making things inside the selected
   group are still in the page for a person, and the document still has the
   features `box`, `cylinder`, `sphere` and `hole`. Take them out as well, or
   leave them?
2. **Bambu Studio.** Do the parts of a 3MF arrive as separate objects, named
   and coloured? A file that shows the message above would help to find its
   cause.
3. **Sizes where the mouse rests** are on from the start (Measure turns them
   off). They cost nothing to see, but they appear every time the mouse
   stops. Right as the default?
4. **In the Dimensions view a number takes the click**, not the model under
   it. Right, or should the model win unless the number is hit exactly?
5. **The Dimensions view shows the selected part** (and its tools), not
   everything at once. Right?
6. **The rings turn about the parent's axes.** Is a way to turn about the
   part's own axes wanted?
7. **A client is not told when the list of tools changes**: it reconnects to
   read it again. Telling it needs a new version of the relay on its host.
   Worth doing?

## Next

Operations that the others cannot make up, none started: **shell**,
**mirror**, **sweep**, **loft**, in that order unless the owner says
otherwise. The kernel build has the classes for all four
(`docs/kernel-classes.txt`: `BRepOffsetAPI_MakeThickSolid`,
`BRepBuilderAPI_Transform`, `BRepOffsetAPI_MakePipe`,
`BRepOffsetAPI_ThruSections`), but none of them has been run here: try each
in `test/spike.test.html` first and write down what it did in
[KERNEL_NOTES.md](KERNEL_NOTES.md), as was done for the others.

To settle for each before it is built, with one way to say each thing:

- **Shell**: which faces are opened (by description, as edges are for a
  fillet) and one thickness. What the new inner faces are called, so that a
  later feature can refer to them.
- **Mirror**: a feature of a part, which mirrors its bodies in an origin
  plane or a flat face. It cannot be a placement: placements are rigid, so
  no way of standing a copy makes it a mirror image.
- **Sweep**: an area of one sketch along a path from another. It is the
  first operation that takes two sketches.
- **Loft**: areas of two or more sketches, in order.

What a new operation touches (revolve, commit `65a526a`, is the pattern):

- `src/kernel/shapes.js` (the solid, with a label on every face) and
  `src/kernel/features.js` (building the feature in a history).
- `src/doc/model.js`, `src/doc/features.js`, `src/types.js` (the feature, its
  defaults and what makes it valid).
- `src/api/commands.js` (the command and its schema, what `edit_feature` may
  change, its numbers in `get_state`), `src/api/bridge.js` (the instructions
  an MCP client reads).
- `src/api/dimensions.js` (its numbers on the model) and `src/app.js` (its
  row in the history).
- Tests: a `test/kernel-<name>.test.html` with exact volumes, and
  `tools/e2e_api.py`, whose `COMMANDS` list must name the new command.
- `docs/COMMANDS.md`, `docs/SPEC.md`, `docs/KERNEL_NOTES.md`, this page.
- `python tools/stamp.py`, then every test (see Development in the README).

## The log

Each section from here on was written when its work was done and is left as
it was. Counts of commands and of tests are those of that day, and some
commands that are named no longer exist: `add_box`, `add_cylinder`,
`add_sphere`, `hole`, `ungroup`, `list_dimensions`, `list_commands` and
`run_command`. The present is the top of this page and
[COMMANDS.md](COMMANDS.md).

## v0.1

The takeover implementation is complete. The required first-version workflow is
implemented in the existing static site: constrained sketches on origin planes
and planar faces; dimensions and dragging; closed profiles with holes; new/join/
cut/intersect extrusions; quick holes; fillets and chamfers; editable history,
suppression/deletion/rename/rollback; undo/redo; project files, autosave and STL/STEP.
Plane redefinition and body visibility are included. Controls have hover help.

The specification is in `docs/SPEC.md`. Tested foundations and prototype algorithms
were promoted into `src/`; runtime and tests have no dependency on `.scratch/`.
Work was committed and pushed in stages to the existing `main` branch. The existing
Claude/psmux session was not touched. No repositories or releases were created.
The live site is [h0bb3.github.io/corecad](https://h0bb3.github.io/corecad/).
The verified application revision is `5afb7b3`.

## Verification

- `python tools/run_tests.py`: **57 tests passed**, including the real OpenCascade
  worker, all constraint derivatives and solve/drag cases, randomized analytic
  profile arrangements, document validation, safe rendering of imported names and undo id watermarks.
- `python tools/e2e.py`: passed using actual mouse/key events. A fully constrained
  60 × 40 plate is extruded 10 mm, cut by an 8 mm face circle, and given four
  R4 vertical fillets. Expected volume: 23,360 mm³. Changing upstream height to
  20 mm preserves references and gives 46,720 mm³. Undo/redo, exports and autosave
  reload also pass.
- `python tools/e2e_more.py`: passed. Covers XZ sketches, constrained dragging,
  redundant-constraint rejection, fixed arcs/points, typed sizes, dimension and
  history double-click editing, blind holes, chamfers, lost references, invalid
  preview cancellation, actual project download/reopen, YZ plane redefinition,
  body visibility, rollback and hover-help coverage.
- Kernel tests also check joins, intersections, nested and arc profiles, symmetric
  and two-sided extents, atomic failures, binary STL/STEP output, superseded requests,
  Stop/Retry recovery and ownership bounds after 125 parameter edits.
- Screenshots were visually reviewed. Validation used desktop Chrome on Windows;
  Firefox, Safari, mobile interaction and very large models are not certified.
- The deployed JavaScript was checked against the local source, and the primary
  end-to-end workflow passed again against the public GitHub Pages URL.

## Remaining limits

This is a small desktop modeller. Topological references use feature labels and
geometric hints; major topology changes can still lose a reference and are reported
in history. Sketches can be moved to another plane; edge selections can be re-picked.
Kernel operation failures keep the prior valid solid. Stop restarts the worker and
skips the stopped operation until its parameters change or Retry is used.

CDN access is needed for the geometry/view libraries. Autosave is one committed
project in localStorage, subject to browser quota and clearing; Save downloads the
portable copy. Number expressions are evaluated once, not retained as named formulas.

Deferred as specified: 2D fillet/chamfer, trim, offset, mirror, extra constraints,
named parameters, projected geometry, dedicated measurement/section tools, imports,
revolve, sweep, loft, shell, patterns and assemblies. No required work is blocked.

## After v0.1: commands for scripts and agents (2026-11-25)

`window.corecad.run(name, args)` exposes 25 commands (`docs/COMMANDS.md`):
reading the model, making and editing sketches from shapes, extrude, hole,
fillet, chamfer, editing and deleting features, undo/redo, export and a
screenshot. They go through the same store as the controls; solid features
are previewed before they are committed, so a refused command leaves the
document unchanged. `corecad.tools` describes each command with a JSON Schema,
ready to be exposed by an MCP server, which does not exist yet.

Verification: `test/api-shapes.test.html` (16 tests of the pure shape,
selection and bridge helpers; 73 tests in all) and `python tools/e2e_api.py`, which runs
every command against the real kernel with expected volumes (plate 24,000;
through hole 23,497.35; four R4 fillets 23,360; width 60 to 80 gives 31,360
with references kept), refused commands, an open dialog blocking changes,
exports, a screenshot and a project round trip. `tools/e2e.py` and
`tools/e2e_more.py` still pass unchanged.

Limits: commands are reached from inside the page only. Sketch shapes are
rectangle, circle, line, polyline, arc and point; lines, polylines and arcs
are pinned with `fix` rather than dimensioned. Edges are chosen within one
body per command.

## The MCP bridge (2026-11-25)

`bridge/relay.js` relays MCP tool calls between an MCP client and a CoreCAD tab
that named the same code; `src/api/bridge.js` and the Connect dialog are the
tab's end. Verified locally: `npm test` in `bridge/` (9 tests with the MCP
SDK's own client) and `python tools/e2e_bridge.py` (the Connect dialog, then
MCP over HTTP through the relay into the real page and kernel: a plate with a
hole and four fillets at 23,360 mm3, refusals, a screenshot as a picture,
disconnect, new address, reload). The same chain also passed through the relay
as mounted in the vibedit server, run locally.

The relay was deployed at vibedit.app/CoreCAD on 2026-11-25 and the Connect
button is shown to everyone. `python tools/e2e_bridge.py --live` runs the same
chain against the public page and the public relay, through Cloudflare, and
passed that day.

Not yet verified: Claude's own connector. Only the MCP SDK's client and the
test's hand-written one have spoken to it. One thing seen on the way:
Cloudflare refused requests with Python's default user agent (error 1010), so
if a client cannot reach `/CoreCAD/mcp`, the zone's bot rules are the first
place to look.

## 0.2: parts (2026-11-25)

A project is now made of parts. Each part has its own feature history and its
own place, may stand under another part, and can be copied or linked.

- **Per-part history.** The browser lists the parts as a tree with each
  part's features under it. A sketch goes into the selected part (or the part
  of the face it is drawn on); Roll here looks back in one part only.
- **Placing.** Move (M, or double-click a part): drag one of three arrows in
  1 mm steps, type position and rotation, turn a quarter on the spot, choose a
  parent. Dragging a part onto another in the list puts it under that.
  Placements are not geometry: moving rebuilds nothing unless a combine
  depends on it.
- **Copies.** Copy makes a part with its own history; Linked copy shows the
  original in another place and follows it; Unlink makes a link independent.
- **Primitives.** Box, Cylinder and Sphere start a part without a sketch.
- **Combine.** Join, cut or intersect a part with other parts where they
  stand. The others become tools under it and stay editable.
- Files are format 2; format 1 files and autosaves open as one part.
- The command set has ten more commands (35 in all): `add_box`,
  `add_cylinder`, `add_sphere`, `add_part`, `combine`, `move_part`,
  `copy_part`, `edit_part`, `unlink_part`, `delete_part`. Faces, edges and
  boxes are reported where the part stands.

Verification, all run on this state:

- `python tools/run_tests.py`: 92 tests passed. New: `test/parts.test.html`
  (11: placements, format upgrade, hierarchy, copies, what is shown) and
  `test/kernel-parts.test.html` (8, real kernel: primitive volumes and face
  names, a cut by a placed and turned tool with a chamfer on the hole it
  made, join and intersect, linked and grouped tools, cycles, looking back
  per part, STL bounds of placed, linked and hidden parts).
- `python tools/e2e_parts.py`: passed, with real mouse and key events: box
  and cylinder, combine, dragging a move arrow, typed placement, quarter
  turn, copy and linked copy, a face sketch on a moved part, a new part,
  hide, delete with dependents, drag and drop in the list, a turned part
  (view, picking and sketch plane agree), reload, opening a format 1 file.
- `python tools/e2e_api.py`: passed, including the new commands with
  expected volumes and boxes in space.
- `tools/e2e.py`, `tools/e2e_more.py` and `tools/e2e_bridge.py` pass (the
  second with body visibility replaced by part visibility; the third with
  the tool count taken from the page). The first two now begin with a new
  project instead of assuming an empty browser.
- On the public site, after the deploy of `4736b29`: `tools/e2e_parts.py`
  and `tools/e2e.py` passed against <https://h0bb3.github.io/corecad/>, and
  `tools/e2e_bridge.py --live` passed through the relay at vibedit.app with
  the 36 tools.

Limits of this version:

- Parts are placed by numbers and arrows. There are no joints, mates or
  snapping of one part to another's faces.
- The move arrows translate; rotation is typed or by quarter turns.
- A linked copy is the whole original: it cannot have features of its own.
- Sketches do not show or snap to other parts' geometry.
- A combine that has nothing to cut is kept with a warning, and its tools
  are still hidden; a tool that is used by two combines is hidden by both.
- Primitives always start a part; to add one to an existing part, combine it.
- Not tried by a person yet: everything above was driven by scripts.

## Pointing: "this" for an agent (2026-11-25)

So that someone can say "a hole on this face" to Claude: the page tracks what
is selected (clicked faces and edges, the part, the feature) and what the
mouse last rested on, and the commands take the words `"this"`, `"selected"`
and `"pointed"` for a face, edges, a part, a feature or a sketch
(`docs/COMMANDS.md`). A hole on a face that was chosen this way goes where it
was clicked. `get_selection` (command 36) reports it all, with the features
that made each face. While an MCP client is connected, a ring marks where the
mouse last rested.

Verification: `python tools/e2e_api.py` clicks and rests the real mouse on
faces, edges and a linked copy and checks what the commands then do (a hole at
the clicked point, a hole after pointing, the same again after a rebuild
without moving the mouse, the clicked hole made wider through
`edit_feature id: "this"`, two clicked edges filleted, a clicked part moved,
refusals when nothing is chosen). `python tools/e2e_bridge.py` does the first
of these over MCP through the relay.

Limits: only faces and edges of solids are pointed at, not sketch geometry or
empty space. Resting takes a third of a second; a mouse that is moved away
quickly keeps the earlier thing. Nothing tells the agent when the selection
changes: it asks. Not tried with Claude itself.

## Measurements and dimensions on the model (2026-11-25)

A first proposal for seeing sizes quickly; it is there to be discussed.

- **Where the mouse rests**: the sizes of the face or edge are drawn on it,
  each number along the side it is the length of: on a flat face one along
  its longer side and one along its shorter (of each pair of sides the one
  nearer to the eye); on a hole or a boss the diameter across the rim and the
  length along the wall; on a fillet its radius and its length; on an edge
  its length. The Measure button in the view bar turns it off. A clicked
  thing shows the same and keeps it.
- **Between two**: click one thing and Shift-click another. A line with the
  value is drawn between them and the note under the view bar gives the
  distance, what it is (between centres, between parallel faces, hole axis to
  face) and the differences along X, Y and Z. Faces that are not parallel
  give their angle. Three or more give the total length and area.
- **Dimensions (D)**: the numbers that drive the selected part are drawn
  where they are: sketch dimensions in their planes, extrusion distances,
  hole diameters and depths, fillet radii, box and cylinder sizes; and in
  grey the overall size along X, Y and Z. Click a number, type, Enter: it
  goes through the command set, so a value that cannot be built is refused
  and nothing changes. Labels that would overlap are moved apart. Each number
  has the line it is the length of (an extrusion's runs up an edge it made,
  from a corner of its outline); with the mouse on a number its line is
  drawn heavier and it says what it is (`extrusion distance · Extrude1`).
- With Dimensions off, a feature clicked in the history shows its own
  numbers the same way (an extrusion with those of its sketch). A feature
  that was just made does not: its numbers would lie over what is clicked
  next.
- For an agent: `measure`, `list_dimensions`, sizes in `get_selection`, the
  clicked number as `"this"`, and `screenshot { dimensions: true }` (38
  commands now).
- The kernel reports the axis and radius of cylindrical faces (and whether
  one is a hole or a boss), the centre and radius of spheres, and the circle
  of arcs as well as of full circles.

Verification: `test/measure.test.html` (7 tests on a model built by the real
kernel: sizes of flat and round faces, edges, where each number lies, thirteen
cases of what lies between two, placed parts); `python tools/e2e_api.py` (measure by
description; the label where the mouse rests; two clicked holes 30 mm apart
for the person and for the agent; `list_dimensions` and changing one through
its command; in the Dimensions view clicking a number and typing, a refused
value, the clicked number as "this"). 99 page tests in all.

Limits: points cannot be picked, only faces and edges, so a distance is
between those (round ones by their axis). Dimension labels are placed by
simple rules and can still crowd on a busy part. The numbers of a sketch are
drawn in the sketch's plane, which may be under the solid. Overall sizes
follow the axes of space, not of a turned part. Not tried by a person yet.

## Objects in the slicer, and colours (2026-11-25)

An exported STL arrived in Bambu Studio as one object, because an STL file is
one mesh: it has no objects in it. Three changes:

- **3MF export.** Every part that is to be seen is an object of its own, with
  the part's name, where it stands. Meshes are welded into closed surfaces.
  This is the format to print from.
- **STL.** With several parts the Export dialog gives a .zip with one STL for
  each part, named after it; one part is a plain .stl as before. The command
  keeps one mesh unless `per_part` is asked for.
- **Colours.** A part can have a colour and single faces a colour of their
  own: the Colour tool (swatches, any colour, none), the dot beside a part in
  the list, and `set_color`. They are shown in the view, kept in the project,
  and written to 3MF (the object's colour, and painted triangles) and to STEP
  (per part).

Verification: `test/export.test.html` (5 tests: the zip writer against a known
checksum; welding and the closed-surface check; colours in the document; a 3MF
from the real kernel read back, with names, colours, closed meshes, volumes,
boxes and the painted triangles of a plate and of its linked copy; STL for
each part; STEP names and the colour that was chosen). `python
tools/e2e_export.py`: colours by mouse and by command, then the exported files
read with Python's own zip and XML readers (checksums, three named and
coloured objects, each closed, right volumes and places, painted triangles),
the STL zip, STEP, the Export dialog, a reload. 104 page tests in all.

**Not verified: any slicer.** None is installed on the machine this was built
on. How Bambu Studio reads a 3MF that is not its own was taken from its source
(`bbs_3mf.cpp`: object names, one object for each build item, `basematerials`
colours on objects and triangles); recent versions ask "Standard 3MF Import
color" when such a file is opened. Whether an older version shows the colours
is not known; the objects and their names do not depend on it.

Limits: colours are plain, one for a part or a face; no textures, no
transparency. A part with several bodies is one object. In STEP only the
part's colour is written, not painted faces. The kernel writes STEP colours
after converting them, so the conversion is undone first; a colour comes back
within about 1/255 of what was chosen.

**One part alone.** The selected part can be exported by itself, with what
stands under it: its own Export button under the list, a tick in the Export
dialog, or `export { part }`. The file is named after the project and the
part. A part that shows nothing (empty, hidden, or used up as a tool) is
refused with that reason. Verified in `test/export.test.html` (6 tests now)
and `tools/e2e_export.py`.

## Turning a part: rings (2026-11-25)

The Move panel had three fields for the angles about X, Y and Z. Those are
applied one after another, so with the middle one at 90° the first and the
last turn about the same line (gimbal lock): X and Z did the same thing.

- The gizmo now has three **rings** besides the arrows. Dragging a ring turns
  the part about that axis of its parent, round the middle of the part, from
  where it stood when the ring was taken hold of. Steps of 15°; Shift single
  degrees; Ctrl freely. A ring that is seen squarely is followed round with
  the mouse; one seen edge-on is dragged along. The angle is shown while
  dragging.
- The panel has **Turn by** an angle **about X / Y / Z** (the same turn, by a
  typed amount; negative turns back) and **Upright** (no turn at all, the
  middle staying where it is). The three angle fields are gone; how the part
  is turned is shown as text.
- The placement is still stored as three angles: any way a part can stand can
  be written so. It was only editing them one by one that was the trouble.

Verification: `python tools/e2e_parts.py` drags the Z ring with the mouse (45°
in steps, 5° not yet a step, a degree at a time with Shift), a ring seen
edge-on from above, Upright, and checks that at a quarter turn about Y a turn
about X and a turn about Z are two different turns, each the one asked for.

Limits: the rings turn about the parent's axes (the axes of space for a part
that stands on its own), not about the part's own axes once it is turned.

## Groups (2026-11-25)

Asked for: something in the tree that only organises, a container that can be
moved and turned, so that not everything has to be a part with a shape.

- A **group** is a part marked `group: true`: a name, a place, children, and
  never a history. The toolbar has **Group**; `add_group` is the command.
- Parts go into it by dragging them onto it in the list, by `add_group` with
  `parts` (they stay where they are in space; the group takes the place of
  the first of them in the list), or by being made while the group, or a
  part in it, is selected: Box, Cylinder, Sphere, Part, and a sketch on an
  origin plane, which then lies on that plane of the group.
- What a group does to what is in it: Move (arrows and rings round the middle
  of everything in it), hide and show, Copy (a group with copies), Linked
  copy, Export of it alone, and colour (the colour of the parts in it that
  have none of their own). It folds away in the list and says how many parts
  it holds. Combine takes a group as a tool (everything in it) but never as
  the part that is changed.
- **Ungroup** takes the group away and leaves its parts where they are. It is
  refused while a linked copy or a combine uses the group as a whole.
- Not done, on purpose: scaling a group. Placements are rigid everywhere, and
  a scaled group would make every measure in it mean two things.

Verification: `test/parts.test.html` (the model: grouping keeps places, no
features on a group, the colour rules, ungroup, groups in groups, copies);
`tools/e2e_parts.py` with the mouse (the toolbar button, dragging parts in,
folding, moving, a box and a sketch made in it, colour, hide, copy, Ungroup,
undo); `tools/e2e_api.py` (`add_group`, `ungroup`, new parts in the current
group, a group as a combine tool, refusals); `tools/e2e_export.py` (a group
exported as its parts, with its colour where they have none).

Limits: a group is selected in the list, not in the view (a click in the view
selects the part that was hit). Parts cannot be reordered in the list by
dragging, only put under one another.

Also fixed here: after Copy, the arrows and rings stood at the copy's origin
until the kernel had built it and then jumped to its middle, so a quick press
could take hold of the wrong arrow. Until the copy is built the gizmo uses the
shape of the original. `tools/e2e_parts.py` checks that it does not move.

## Updates, and tools a client does not see (2026-11-25)

Reported: after the group commands were published, an agent connected through
the bridge did not see them.

What was checked: a fresh tab and a fresh client see every tool
(`python tools/e2e_bridge.py --live`). So the list was an old one, and there
are two places it can be old: the tab (it runs the files it loaded and names
the commands of that version) and the client (it keeps the list of tools it
read when it connected).

- `src/version.js`, written by `tools/stamp.py`, names the build and lists
  its files. `tools/run_tests.py` fails when it is not current.
- The page compares its build with the published one (four seconds after
  loading, every three minutes while visible, when the tab is shown again,
  and when `get_state` is asked, at most once a minute). A newer one shows an
  **Update** button and `app.update_available` in `get_state`.
- **Update** and the command `reload_app` fetch every file of the published
  version past the browser's cache and then reload. The project comes back
  from the browser's save; the bridge connects again under the same address.
  Both are refused while a sketch or a dialog is open.
- `list_commands` and `run_command` reach every command of the tab from a
  client whose list of tools is older.

Verification: `test/update.test.html`; `tools/e2e_api.py` (a newer build
seen, the button, the refusal, the reload by command and by button, the
project the same after it); `tools/e2e_bridge.py` (`reload_app` over MCP: the
tab is back under the same address, `tools/list` complete).

Not done: the relay telling a client that the list changed. It answers each
request on its own and holds no connection to the client; announcing a change
needs a stream that stays open (and a client that listens to it), and a new
version of the relay on its host.

Limits: a tab that loaded a mix of old and new files whose `version.js` is the
new one does not know it is mixed; `reload_app` and **Update** still fix it,
because they fetch everything.

## One way to do each thing (2026-11-25)

A rule for the command set, from its owner: there is only one way to do a
thing; an agent is given primitives, not conveniences.

- Removed the same day they were added: `list_commands` and `run_command`.
  They were a second way to list and to call every command. A client whose
  list of tools is old reads it again (reconnect the server); `reload_app`
  and `get_state` under `app` stay, as the only way to see and to load a
  newer CoreCAD from a command.
- The older overlaps were listed here for a decision. The decision was to
  take out everything that can go: see "The command set, cut down" below.

## Revolve (2026-11-25)

The first of the operations that the others cannot make up: closed areas of
a sketch turned about a line of that sketch.

- Kernel: `revolved` in `src/kernel/shapes.js`; feature `revolve` (see
  `docs/SPEC.md`). One way to say each thing: the axis is a line of the
  sketch, by its id; the angle is positive and at most 360; `flip` is the
  only way to turn the other way; a name is given with `edit_feature`.
- Command: `revolve`; `edit_feature` changes angle, axis, operation, flip;
  `get_state` shows it.
- Page: a row in the history; its angle on the model (click it and type). No
  dialog and no toolbar button: it is made by command.

Verification: `test/kernel-revolve.test.html` (a ring with exact volume and a
named face for each line; a quarter and a half turn, to the side the sketch
faces and the other way, whichever way the axis was drawn; a ball from a half
disc on its axis; a groove cut and a collar joined on a cylinder; a profile
across the axis, a lost axis and bad angles refused); `tools/e2e_api.py` (the
command, its refusals, the angle typed over on the model).

Limits: the axis is a straight line of the same sketch (not an edge of a
body, not an axis of the part). Cones and tori that a revolve makes are
measured as plain faces: `measure` does not give their radii.

Next of the same kind, not started: shell, mirror, sweep, loft.

## The command set, cut down (2026-11-25)

The owner's answer to the list of overlaps: trim everything that can go.
43 commands became 37, and what is left takes fewer arguments. The rule, as
it is now written at the top of `src/api/commands.js` and in
`docs/COMMANDS.md`: a command does one thing, and nothing that another
command does is also an argument of it; making something takes only what the
thing cannot be without.

Commands taken out, and what does their work:

- `add_box`, `add_cylinder`, `add_sphere`: `add_part`, `add_sketch`,
  `add_to_sketch`, then `extrude` or `revolve`.
- `hole`: a circle in a sketch on the face, `extrude` as a cut.
- `ungroup`: `move_part` with a parent for each part, then `delete_part`.
- `list_dimensions`: `get_state` has the numbers of the features,
  `get_sketch` those of a sketch.

Arguments taken out:

- `name` wherever something is made (`extrude`, `fillet`, `chamfer`,
  `combine`, `add_sketch`, `add_part`, `add_group`, `copy_part`): a name is
  given with `edit_part` or `edit_feature`. (`new_document` keeps its name:
  nothing else names a project.)
- `position`, `rotation`, `parent` of `add_part`, `add_group`, `copy_part`,
  and `by`: a part is placed with `move_part`. A new part or group stands at
  the origin under nothing, whatever is selected in the page; a copy stands
  where its original stands.
- `by` and `turn` of `move_part`: it takes `position`, `rotation`, `parent`.
- `parts` of `add_group`: `move_part` with a parent.
- `shapes` of `add_sketch`, and its `part: "new"`: `add_sketch` makes an
  empty sketch in a part that is there; `add_to_sketch` fills it; `add_part`
  makes a part. A first part is no longer made by the way.
- `symmetric` of `extrude` and `edit_feature`, and a negative `distance`:
  `distance2` is the other way (0 for none), `flip` reverses.
- `view` and `fit` of `screenshot`: `set_view` (whose `view` may now be left
  out, to fit only).
- The format `corecad` of `export`: `get_document`.
- `selection` in what `get_state` answers, and `between` in what
  `get_selection` answers: `get_selection` and `measure`.

What was left, and why:

- The page. Box, Cylinder, Sphere, Hole, Ungroup, the symmetric tick of the
  extrude dialog and making things inside the selected group are a person's
  tools, and the document still has the features `box`, `cylinder`, `sphere`
  and `hole`: files that have them open as before, and `edit_feature`
  changes them (test: a box and a hole made in the page, changed by
  command).
- Ways of saying which thing is meant: a part by id or by name, a face by
  side, index or "this", edges by index or by description, regions as
  "outer", "all", indices or points. They are how something is pointed at,
  not ways of doing something.
- The shapes of `add_to_sketch`: `rectangle` and `polyline` are made of
  lines, and a `line` is a polyline of two points. A rectangle and a circle
  come with the dimensions a person changes them by, which lines would need
  about eight more commands for. Decided the same day: they stay, because
  saving calls is worth something too.
- `add_dimension` keeps `value` (it is what the dimension is), and
  `list_edges` its `edges` (what a description means, before it is used).

A note for a client that still holds the older list of tools: the relay
answers for a tool it was not told of (`CoreCAD has no tool "add_box"`)
before the tab is asked, so a sentence in the tab about what replaced a
command would not reach it; none is kept. The client reads the list again
when the server is reconnected in it.

Verification: `tools/e2e_api.py` was rewritten for the smaller set (the list
of commands is asserted exactly, and that only `new_document`,
`edit_feature` and `edit_part` take a name, only `move_part` a position,
only `add_to_sketch` shapes); `tools/e2e_export.py` and `tools/e2e_bridge.py`
build their models from the primitives.

## Looking inside: Section and X-ray (2026-11-26)

Asked for: a way to inspect the inside of a model that is complicated
inside, an X-ray or a cross section along the axis planes; to mark and
measure things there; and for an agent to know what the owner is looking at.

- **Section** (view bar). The model is cut open along a plane square to an
  axis: XY, XZ or YZ, at a place along that axis. What lies beyond the plane
  is not drawn; the cut through each solid is filled in with the part's
  colour, darker, and outlined. Turned on, it takes the upright plane across
  the view and takes away the half nearer the eye. A bar under the view bar
  has the plane, a slider over the reach of the model, the number, Flip and
  Whole; an arrow on the cut drags it in steps of 1 mm (Shift: 0.1 mm).
- **X-ray** (view bar). The solids are drawn see-through with every edge
  showing, and every edge can then be clicked.
- **Measuring inside.** Pointing is exact about what is drawn: a ray is cut
  to the half that is left, a ray that comes into it inside a solid meets
  the cut (which is not a face: a click on it means the part), and an edge
  in the half that is gone cannot be taken. So the faces that a cut shows
  are rested on, clicked and measured as the outside is.
- **For an agent.** `get_selection` has `looking`: the camera (the standard
  view it stands in, the way it looks), the section and whether the model is
  see-through. `set_section` and `set_xray` do what the two buttons do, so an
  agent can look inside by `screenshot`. 39 commands.
- Neither is part of the model: no undo step, nothing saved, whole again in
  a tab that is opened. While a sketch is drawn the model is shown whole.

How: three.js clipping planes; the cut surfaces by the stencil buffer (for
each closed solid, the faces turned away from the eye are counted up and
those turned towards it down, and a sheet in the plane is drawn where the
count is not nothing); the outline from the triangles that cross the plane.
`src/view/section.js` is the pure part (the half of space that stays, the
stretch of a ray in it, the outline); `countHits` in `src/view/pick3d.js`
tells whether a ray comes in inside a solid.

Verification: `test/section.test.html` (8 tests of the pure part);
`tools/e2e_api.py` with the real mouse: the Section button, the colours of
the cuts in the picture, a wall inside saying its size, the depth of a pocket
between two clicked faces, a click on a cut, the arrow dragged, a typed
place, the other planes, Flip, Whole; X-ray and a hidden edge clicked; the
two commands and their refusals; a sketch suspending the cut; the model
unchanged by all of it.

Limits:

- The cut is square to an axis of space, not to a face or to a turned part.
- One cut at a time, through every part alike.
- The outline of a cut is drawn but cannot be clicked: sizes are taken from
  the faces the cut shows, not from the cut itself.
- A cut surface has one plain colour, without hatching.
- In X-ray a click takes the nearest edge, or else the face in front: faces
  behind are reached by cutting the model open.
- Not tried by a person yet.

## An agent at work is seen (2026-11-26)

Asked for: a status or indicator that an agent is working in the model.

- The bridge (`src/api/bridge.js`) now knows what is asked of the tab and not
  answered yet (`busy`, `running`) and keeps the last dozen commands
  (`recent`: name, refused or not, when, how long).
- `activity()` there turns that into what the person is told: while a
  command runs, "An agent is changing the model · extrude" (or "is looking at
  the model" for the commands in `READS` of `src/api/commands.js`, which
  never change it); after it, "An agent is at work · last: extrude", with
  "(refused)" when it was; nothing once twenty seconds have passed without a
  command, or when the tab is not connected.
- The page shows it three ways: an orange frame round the view, a line at
  the lower left of the view (a button: it opens the Connect dialog), and the
  Connect button reading "Agent working". The Connect dialog lists the last
  eight commands, newest first.

Verification: `test/api-shapes.test.html` (the sentences and their timing; a
bridge on a stand-in socket: two commands asked at once, the first being
done, then the list; a tool that was not announced). `tools/e2e_bridge.py`
with a real relay and MCP client: the line and the frame after commands,
"(refused)", the sentence caught while the whole model is built again by
`load_document`, the list in the dialog, the line opening the dialog, gone
after twenty seconds, gone at once on Disconnect.

Limits: only commands that come through the bridge count. A script in the
tab that calls `corecad.run` itself, or an agent that drives the page with
mouse and keys, is not seen as one. The page does not stop the person from
working while an agent does.

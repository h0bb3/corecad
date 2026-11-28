# Commands: CoreCAD for scripts and agents

Everything an agent does to a model is asked for by name, with plain JSON in
and out. This is what an agent (or the browser console) uses, and it is the
list the MCP bridge exposes.

```js
// A plate with a hole and rounded corners.
await corecad.run('add_part');
await corecad.run('add_sketch', { plane: 'XY' });
await corecad.run('add_to_sketch', { shapes: [{ type: 'rectangle', corner: [0, 0], width: 60, height: 40 }] });
await corecad.run('extrude', { distance: 10 });
await corecad.run('add_sketch', { plane: 'top' });
await corecad.run('add_to_sketch', { shapes: [{ type: 'circle', center: [20, 20], diameter: 8 }] });
await corecad.run('extrude', { operation: 'cut', through_all: true });
await corecad.run('fillet', { edges: { parallel: 'z' }, radius: 4 });
// { ok: true, result: { id: 'f5', status: 'ok', bodies: [{ id: 'f2', volume: 23360, ... }], problems: [] } }

// A pin as a second part, named, placed, and cut out of the plate.
const pin = (await corecad.run('add_part')).result.part.id;
await corecad.run('edit_part', { part: pin, name: 'Pin' });
await corecad.run('add_sketch', { part: pin });
await corecad.run('add_to_sketch', { shapes: [{ type: 'circle', center: [0, 0], diameter: 10 }] });
await corecad.run('extrude', { distance: 30 });
await corecad.run('move_part', { part: pin, position: [45, 20, -5] });
await corecad.run('combine', { part: 'o1', with: [pin], operation: 'cut' });
```

- `corecad.run(name, args)` never throws: it answers `{ ok: true, result }`
  or `{ ok: false, error }` with a sentence that says what was wrong.
- `corecad.commands.<name>(args)` is the same as a function that throws.
- `corecad.tools` is the list itself: for each command its name, a
  description and the JSON Schema of its arguments. It is the authority;
  the table below is a summary of it.

## One way to do each thing

The command set is a toolbox of primitives. It has no shortcuts:

- **A command does one thing, and nothing that another command does is also
  an argument of it.** Making something takes only what the thing cannot be
  without. Its name is given with `edit_part` or `edit_feature`, its place
  with `move_part`, what goes into it with the command for that.
- **There is one way to say a thing.** A direction is reversed with `flip`,
  not with a negative number; a part is placed by `position` and `rotation`,
  not by an offset from where it is.
- **What can be made from other commands is not a command.**

| For | The way |
|---|---|
| a box | `add_part`, `add_sketch`, `add_to_sketch` with a rectangle, `extrude` |
| a cylinder | the same with a circle |
| a ball | `add_sketch` on XZ, `add_to_sketch` with a half disc (an arc and the line that closes it), `revolve` about that line |
| a hole | `add_sketch` on the face, `add_to_sketch` with a circle, `extrude` with `operation: "cut"` (a cut on a face goes into the body) |
| a part that was made elsewhere | `import` with the text of its STEP file |
| the parts of another project | `import` with that project (`get_document` gives one) |
| a thread, a spring | `add_sketch` on a plane the axis lies in, `add_to_sketch` with one tooth (or the wire's outline) and the axis line, `revolve` with a `rise`: one feature for all the turns ([Threads](#threads-revolve-with-a-rise)) |
| a part in a group | `move_part` with `parent` |
| taking a group away | `move_part` with `parent` for each part in it, then `delete_part` |
| moving by an offset | `get_state` for where it is, `move_part` with the new `position` |
| the project as a file | `get_document` |
| a drawing for the workshop | `add_drawing`, `add_view` for each view, `add_drawing_dimension` for each size, `export` with `format: "pdf"` |

The page has buttons for a person that do several of these in one go (Box,
Cylinder, Sphere, Hole, Ungroup). What they make is in the model like
anything else, and `edit_feature` changes it.

Where the rule stops: the shapes of `add_to_sketch`. A `rectangle` is four
lines and a `polyline` is lines, and they stay beside `line`. One call does
the work of about eight, and a rectangle and a circle come with the
dimensions a person changes them by. That settles the shapes that are there;
it is not a reason to add shortcuts.

## How they behave

- **They are the page's own actions.** A command changes the model through
  the same store as the buttons: it is one undo step, it is autosaved, it
  appears in the history, and the view shows it.
- **A failed command changes nothing.** A solid feature is tried as a
  preview first, as the dialogs do; if the kernel cannot build it (a fillet
  too large, a cut that misses) the answer is the reason and the document is
  as it was.
- **One at a time.** Commands run in the order they were asked.
- **They do not fight the person at the page.** While a sketch or a feature
  dialog is open in the page, commands that change the model are refused
  until it is closed (`cancel_edit` closes it, discarding).
- **Sketches made by commands are real sketches.** A rectangle gets its
  width and height dimensions and is located from the origin; a circle gets
  its diameter. They are fully constrained, and a person can change them by
  their numbers afterwards. Lines, polylines and arcs are pinned where they
  were given; ends that meet are joined.
- **Faces and edges are chosen by description**: a side (`"top"`), an index
  from `list_faces` / `list_edges`, or conditions such as
  `{ parallel: 'z' }` or `{ on: 'top', kind: 'circle' }`. The command turns
  the choice into the same kind of reference a click makes, so it survives
  rebuilds the same way.
- Units are millimetres (degrees for angles). Sketch coordinates are in the
  sketch's plane; on XY and on top faces they are the part's x and y (the
  world's, as long as the part has not been moved or turned).

## Parts

A project is made of **parts**. Each part has its own history of features,
its own place, and may stand under another part and move with it.

- **Starting one**: `add_part` makes an empty part at the origin, under
  nothing. `add_sketch` puts an empty sketch into a part, `add_to_sketch`
  shapes into the sketch, and `extrude` or `revolve` makes the solid.
- **Groups**: `add_group` makes an empty container for parts: a name and a
  place, and no shape of its own. `move_part` with `parent` puts a part into
  it or takes one out (the part stays where it is in space). What is in a
  group moves, turns and hides with it, takes its colour where it has none
  of its own, and is exported with it; `copy_part` copies it whole. A group
  can hold groups. `delete_part` deletes it with everything in it. A group
  can be a tool of `combine` (everything in it), never the part changed.
- **The current part** is the one the last command worked on; `get_state`
  names it. Commands that leave `part`, `body` or a face's owner out mean
  it. A part is named by its id (`"o2"`) or its name.
- **A part's history only changes that part.** `extrude` and `revolve` join
  to or cut the bodies of their sketch's own part. Other parts meet through
  `combine`.
- **Place**: `move_part` gives `position` and `rotation` (degrees about the
  fixed X, then Y, then Z axis, round the part's origin), and `parent`.
  Positions are in the parent's frame. Moving rebuilds nothing unless a
  combine depends on it.
- **Combine** joins other parts to a part, cuts them out of it, or keeps
  what they share, where they stand. It is a feature of the part that is
  changed. The others become its tools: hidden, placed under it, still there.
  Move or edit a tool and the result follows.
- **Copies**: `copy_part` makes a copy with its own history; with
  `linked: true` a copy that shows the original in another place and changes
  with it. A copy is made where the original stands; `move_part` places it.
  `unlink_part` turns a linked copy into a part of its own.
- **Where things are reported**: `get_state`, `list_faces` and `list_edges`
  give boxes, centres, normals and sides (`"top"`) in space, where the part
  stands. A sketch's shapes are in its plane's own coordinates, which turn
  with the part.

## "This": what the person has clicked or points at

Someone talking to an agent says "a hole here" or "make that deeper". The
page keeps track of what they mean, and the commands can use it.

- **Selected**: the faces and edges they have clicked (Shift-click adds), the
  part they clicked in the list or in the view, the feature they clicked in
  the history.
- **Pointed**: the face or edge their mouse last came to rest on (about a
  third of a second without moving). It stays that after the mouse has left
  for another window, until they rest on something else, click empty space,
  click a part or a feature in the list, or press Esc. While an MCP client is connected it is marked with a ring.
  What the mouse only passed over on its way out is not it.
- `get_selection` tells both: for each face or edge its part, where it is in
  space, the `point` that was clicked and, on a flat face, the same point as
  `at` in the face's own coordinates (what a sketch on it uses), and
  `made_by`: the features whose work it is.
- **The words** `"this"`, `"selected"` and `"pointed"` can be given wherever
  a command takes a face, edges, a part, a feature id or a sketch. `"this"`
  is what is selected, or else what is pointed at.
  - "A hole here": `add_sketch { plane: "this" }`, then a circle at the
    `at` that `get_selection` gave, then `extrude` as a cut.
  - `fillet { edges: "this", radius: 2 }`, `move_part { part: "this", position: [0, 0, 10] }`.
  - `edit_feature { id: "this", distance: 8 }` changes the feature that made
    the face or edge: point at the floor or the rim of a hole and it is the
    cut that made it. `get_sketch { sketch: "this" }` is the sketch behind
    it, where the circle's diameter is.
- A change uses the selection up. If the mouse has not moved, what it rests
  on after the rebuild is pointed at again, so "and another one here" works.
- When there is nothing to go by, the command says so in a sentence to pass
  on ("ask the person to click or point at a face"), and changes nothing.

## Measuring, and the numbers that drive the model

The person sees sizes on the model (see the README: where the mouse rests,
between two clicked things, and the Dimensions view). An agent gets the same:

- `measure` tells how big a face or an edge is and what lies between two:
  `measure { from: "top", to: "bottom" }` is the thickness; two holes give
  the distance between their centres; a hole and a flat side the distance
  from the hole's centre to that side; faces that are not parallel give
  their angle. With nothing given it measures what the person has selected.
  `from` and `to` take `"this"`, a side name, or `{ face: index }` /
  `{ edge: index }`.
- The numbers that drive the model are where the things they belong to are:
  `get_state` has those of each feature (an extrusion's distance, a fillet's
  radius), changed with `edit_feature`; `get_sketch` has a sketch's
  dimensions, changed with `set_dimension`.
- A number the person clicked in the Dimensions view is in `get_selection`
  as `dimension`, with the command that changes it, and is what
  `set_dimension { dimension: "this" }` and `edit_feature { id: "this" }`
  mean.
- `screenshot { dimensions: true }` draws the driving numbers on the picture.

## Threads: revolve with a rise

`revolve` with a `rise` moves the outline along the axis as it turns:
`rise` millimetres in each full turn. One feature makes all the turns of a
thread, a spring or a screw conveyor; do not stack slices.

```js
// a bolt: a rod of radius 12.6, and a tooth that climbs it for seven turns
run('add_to_sketch', { sketch, shapes: [                     // a sketch on XZ of the rod's part
  { type: 'polyline', closed: true, points: [[12.3, 1], [15, 2.3], [15, 2.7], [12.3, 4]] },
  { type: 'line', from: [0, 0], to: [0, 10], construction: true } ] });
run('revolve', { sketch, axis, rise: 3.5, angle: 360 * 7 });   // axis: the id of that construction line
```

- **Which way.** The outline goes along the axis the way the axis line runs
  from its first point to its second, and turns about it as a right-handed
  screw does. `flip` sends it the other way along the axis; `left_handed`
  makes it a left-handed screw. `angle` is 360 for each turn, up to 36000.
- **The tooth must cross the surface** of the body it is joined to or cut
  from. Draw it reaching a little past that surface (0.2 mm is enough): into
  the rod for a bolt, into the air of the hole for a nut. A tooth that
  stands on the surface, with a side lying in it or a corner on it, is not
  joined, and the answer says so.
- **The turns must not meet.** The outline has to be shorter along the axis
  than the `rise`, or one turn would run into the next; that is refused with
  both numbers. A real thread has a flat between its teeth.
- **The ends are blunt**: flat, where the outline starts (in the sketch
  plane) and where it stops. Let a thread run out past the end of its rod or
  through the faces of its nut, or stop it inside.
- **A fit needs clearance.** The thread of a nut is its own tooth, drawn a
  little bigger than the bolt's (0.2 to 0.4 mm for a printed thread).
- The outline may touch the axis at a corner, not along a side. It may have
  a hole in it (a hollow coil) and may be round (a spring).
- It takes a second or two for a few turns and longer for many: 17 turns
  joined to a rod about 4 s, 30 turns about 9 s.

## Bringing things in

`import` adds to the open project; it replaces nothing (`load_document`
does that).

- `import { format: "step", content }`: `content` is the text of a STEP
  file. Its solids become one new part, called "Imported 1" until
  `edit_part` names it. The part has one feature, the import, and no
  history behind it: there are no numbers to change. Everything else works
  on it as on any part: `move_part`, `measure`, a sketch on a flat face of
  it and an extrusion from there, `fillet` and `chamfer` on its edges,
  `combine` with other parts, colours, export. Surfaces and curves that
  stand alone in the file are left out; a file with no solid is refused.
- `import { format: "corecad", content }`: `content` is a project, as
  `get_document` gives it (an object, or its JSON text). Its parts are added
  with their histories and can be changed like those that were here. Every
  part and feature of it gets a new id; a name that is taken gets a number
  after it ("Plate (2)"). When it has more than one part standing on its
  own, they come in a new group named after that project, so that what came
  in can be moved, hidden or deleted as one; a single part comes as it is.
  The answer names the group and the parts.
- What comes in stands where it stood in its file. An import is one undo
  step.

The person has the same as the **Import** button, which takes a `.step`,
`.stp` or `.corecad` file.

## Looking inside

A model can be complicated inside. Two ways of looking in, for the person in
the page (Section and X-ray in the view bar) and for an agent:

- `set_section { plane: "XZ", at: 12 }` cuts the model open along a plane
  square to an axis: `"XY"` (the cut moves along z), `"XZ"` (along y) or
  `"YZ"` (along x). What lies above `at` along that axis is not drawn
  (`flip: true`: what lies below it); the cut through each solid is filled in
  with the part's own colour, darker. `at` left out is the middle of the
  model; `plane: null` puts the model back whole.
- `set_xray { on: true }` draws the solids see-through, with every edge
  showing.
- Both change how the model is shown, in the page and in `screenshot`. They
  never change the model, and they are not saved with it. While a sketch is
  drawn the model is shown whole.
- What a cut shows is as real as the outside: the faces inside can be pointed
  at, clicked and measured (`"this"`, `measure`), and in X-ray an edge that
  was hidden can be clicked. A click on the cut itself means the part.
- `get_selection` says how the person is looking, under `looking`:

```json
"looking": {
  "camera": { "view": "home", "towards": [-0.5774, 0.5774, -0.5774], "up": [-0.4082, 0.4082, 0.8165], "projection": "orthographic" },
  "section": { "plane": "XZ", "at": 0, "flip": true, "text": "cut along XZ at y = 0 mm: everything with y below that is taken away" },
  "xray": false
}
```

  `camera.view` is the name of a standard view when the camera stands in one
  (else null); `towards` is the way it looks, in space. When the person says
  "here" with the model cut open, what they point at is likely inside.

## Drawings for the workshop

A drawing is a sheet of paper with views of one part, its sizes on them, and
a title block: what is printed and taken to the bench. It is kept in the
project and follows the model: change the part and the drawing shows it as it
is now, numbers and all.

```js
// a plate on A4 at 2:1: the front view with the top view below it (first angle), two sizes and a hole
await corecad.run('add_drawing', { part: 'Plate' });                   // d1: A4, 1:1, empty
await corecad.run('edit_drawing', { scale: 2 });
await corecad.run('add_view', { look: 'front', at: [110, 150] });     // v2; answers its box on the paper
await corecad.run('add_view', { look: 'top', at: [110, 80] });        // v3, below it
await corecad.run('add_drawing_dimension', { view: 'v2', from: 'left', to: 'right' });   // 60
await corecad.run('add_drawing_dimension', { view: 'v3', from: { edge: 13 } });          // Ø8 (a rim)
await corecad.run('add_drawing_dimension', { view: 'v3', from: 'left', to: { face: 6 } });  // 40, to the hole's centre
await corecad.run('screenshot', { drawing: 'd1' });                   // a picture of the sheet, to check it
await corecad.run('export', { format: 'pdf', download: true });       // to print at 100 %
```

- **The paper.** `add_drawing` makes an empty A4 sheet (landscape) at 1:1
  with a frame and a title block: part, project, drawing, scale, sheet,
  units, date and the symbol of first angle projection. `edit_drawing`
  changes its name, the part, the paper (A4 to A0, or A4 upright) and the
  one scale of all its views. Places on the paper are millimetres from its
  lower left corner; `get_drawing` says where the frame and the title block
  are.
- **Views.** `add_view` puts the part as seen from one side where its middle
  is to stand: `front` (from -y, z up), `back`, `left`, `right`, `top` (from
  +z), `bottom`, or `iso` (a picture from the front, the right and above).
  The edges and outlines are those OpenCascade's hidden-line removal finds;
  edges behind the solid are dashed (not in `iso`), where faces meet without
  a corner a thin line, and what is round has its centre lines. Views are
  placed by **first angle projection** (ISO, as in Europe): the top view
  below the front view, the view from the left to its right, the view from
  the right to its left, each lined up with the front view. The answer gives
  the view's box on the paper, so the next one can be placed beside it;
  `move_view` moves it with its dimensions.
- **Dimensions.** `add_drawing_dimension` draws a size in a view with
  extension lines, arrows and its number, measured from the model the way
  `measure` measures: between two parallel faces, two holes (centre to
  centre), a hole and a face (to its centre), two edges; or of one thing: a
  hole or a round edge (its diameter), an arc (its radius), a straight edge
  (its length). The page places it outside the view, each new one on that
  side further out than the last: give the small ones first. It must lie
  flat in its view, as a length that is not seen shortened: the width of a
  plate in the front or the top view, the diameter of a hole in the view that
  looks into it (a leader with Ø) or from its side (across it). Anything else
  is refused with the reason. `along: "horizontal"` or `"vertical"` draws
  only that part of a distance that runs at a slant. What it measures is kept
  as a fillet keeps its edges, so it is found again after a rebuild; when it
  is gone, `get_drawing` says so and the sheet leaves it out.
- `remove_from_drawing` takes views and dimensions off by id (a view takes its
  dimensions); `delete_drawing` deletes one; deleting the part deletes its
  drawings.
- **Seeing it.** `screenshot { drawing }` is a picture of the sheet;
  `export { format: "pdf" }` the drawing as one page at its true size (lines
  and text, not a picture): printed at 100 % it measures what its scale
  says. In the page the list has **Drawings** under the parts; a click shows
  the sheet over the model with **PDF** and **Close** (Esc), and a command
  that changes a drawing shows it.
- Not drawn (yet): section views, angles, notes, tolerances, threads in the
  standard way (a thread is drawn as the edges it has), more than one sheet
  to a drawing.

## Colours and export

- `set_color { part, color }` colours a part; `set_color { faces, color }`
  gives single faces a colour of their own (`"this"`, a side, `{ face:
  index }`, or a list). A colour is `#rrggbb` or a name (red, orange, yellow,
  green, teal, blue, purple, pink, brown, black, white, grey); `null` takes
  it away. A linked copy shows its original's colours unless it is given one
  of its own.
- `export { format: "3mf" }` is the file for a slicer: every part that is to
  be seen is an object of its own, with the part's name and colour, where it
  stands; painted faces are painted triangles. Tools that were used up and
  hidden parts are left out.
- `export { format: "stl" }` is one mesh of everything, because an STL file
  cannot tell objects apart; `per_part: true` gives a zip with one STL for
  each part instead.
- `export { format: "step" }` has exact solids, named and coloured.
- `export { format: "pdf", drawing }` is a drawing ([Drawings](#drawings-for-the-workshop)).
- `export { part: "Plate" }` (with any of these formats) exports only that
  part and what stands under it; `part: "this"` the part the person has
  selected.
- The project itself is `get_document`.

## The commands

Arguments in brackets are optional.

| Command | Arguments | What it does |
|---|---|---|
| `get_state` | - | The model at a glance: parts with their place, parent and history; features with status and main numbers; bodies with volume and bounding box in space; the current part. Start here. |
| `get_selection` | - | What the person has clicked and what their mouse rests on: faces, edges, part, feature and number, with where they are and what made them; and how they are looking at the model (camera, cut, see-through). |
| `measure` | [from], [to] | How big a face or an edge is; how far apart or at what angle two are. |
| `get_document` | - | The whole project as JSON, as Save writes it. |
| `load_document` | document | Replaces the open project. |
| `new_document` | [name] | Starts an empty project. |
| `get_sketch` | [sketch] | One sketch in full: entities with coordinates, dimensions and constraints with ids, degrees of freedom, closed regions. |
| `list_faces` | [body], [part] | The faces of a body: index, kind, centre, area, normal, and which side a flat face is. |
| `list_edges` | [body], [part], [edges] | The edges that can be filleted or chamfered, optionally only those matching a description. |
| `add_sketch` | [plane], [part] | An empty sketch on an origin plane of a part or on a flat face. |
| `add_to_sketch` | [sketch], shapes | Adds shapes to a sketch. |
| `set_dimension` | [sketch], dimension, value | Changes a driving dimension; everything built on the sketch is rebuilt. |
| `add_dimension` | [sketch], refs, [value], [mode] | Adds a driving dimension. |
| `add_constraint` | [sketch], type, refs | Adds a geometric constraint; refused with the reason if it conflicts or repeats. |
| `remove_from_sketch` | [sketch], ids | Removes entities, dimensions or constraints. |
| `extrude` | [sketch], [profiles], [distance], [through_all], [operation], [distance2], [flip] | Extrudes regions of a sketch: new body, join, cut or intersect. |
| `revolve` | [sketch], [profiles], axis, [angle], [rise], [left_handed], [operation], [flip] | Turns regions of a sketch about a line of that sketch: new body, join, cut or intersect. With a `rise` they also move along the line as they turn: a thread. |
| `import` | format, content | Brings a STEP file in as a part of fixed geometry, or the parts of another CoreCAD project with their histories. |
| `fillet` | edges, radius | Rounds edges. |
| `chamfer` | edges, distance | Bevels edges. |
| `edit_feature` | id, and what to change | Changes a feature's parameters, name or suppression. |
| `delete_feature` | id, [with_dependents] | Deletes a feature (and, if asked, what is built on it). |
| `add_part` | - | An empty part at the origin, for sketches. |
| `add_group` | - | An empty group at the origin: a container that keeps parts together. |
| `combine` | [part], with, operation, [keep] | Joins other parts to a part, cuts them out of it, or keeps what they share. |
| `move_part` | [part], [position], [rotation], [parent] | Places a part: where it stands, how it is turned, what it stands under. |
| `copy_part` | [part], [linked] | A copy of its own, or a linked copy that follows the original, where the original stands. |
| `set_color` | color, [part], [faces] | A colour for a part, or for single faces. |
| `edit_part` | [part], [name], [hidden] | Renames a part, hides or shows it. |
| `unlink_part` | [part] | Turns a linked copy into a part of its own. |
| `delete_part` | [part], [with_dependents] | Deletes a part with its history and what is under it. |
| `undo`, `redo` | - | As the buttons. |
| `cancel_edit` | - | Closes a sketch or dialog that is open in the page, discarding. |
| `export` | [format], [drawing], [part], [per_part], [download] | 3MF (an object for each part, named and coloured), STL or STEP; a drawing as PDF. |
| `screenshot` | [max], [dimensions], [drawing] | The 3D view as it stands, as a PNG data URL, with the driving numbers on it if asked; or the sheet of a drawing. |
| `set_view` | [view], [fit] | Turns the camera to a standard view and fits the model. |
| `set_section` | plane, [at], [flip] | Cuts the model open along a plane to look inside, or (plane null) shows it whole again. |
| `set_xray` | on | Draws the solids see-through, or solid again. |
| `add_drawing` | [part] | An empty sheet (A4, 1:1, frame and title block) for views of a part. |
| `edit_drawing` | [drawing], [name], [part], [sheet], [scale] | Its name, part, paper or scale. |
| `delete_drawing` | drawing | Deletes a drawing. |
| `add_view` | [drawing], look, at | A view of the part from one side (or iso) with its middle at a place on the paper. |
| `move_view` | view, at | Moves a view with its dimensions. |
| `add_drawing_dimension` | view, from, [to], [along] | A size in a view, measured from the model; refused where it would be seen shortened. |
| `remove_from_drawing` | ids | Takes views and dimensions off. |
| `get_drawing` | [drawing] | The sheet: paper, scale, frame, title block, views with their boxes, dimensions with their numbers. |
| `reload_app` | - | Reloads the tab so that it runs the newest CoreCAD; the project is kept. |

`edit_feature` takes, for an extrusion: `distance`, `through_all`,
`distance2` (0 for none), `operation`, `flip`; for a revolve: `angle`,
`rise`, `left_handed`, `axis`, `operation`, `flip`; for a fillet: `radius`; for a chamfer:
`distance`; for a combine: `operation`, `with`, `keep`. For what a person
made with the page's own tools: a hole `diameter`, `depth`, `through_all`,
`at`; a box `size`, `origin`; a cylinder `diameter`, `height`, `origin`; a
sphere `diameter`, `origin`. An extrusion that a person made symmetric in the
page stays half to each side until it is given a `distance2`.

## Where the code is

- `src/api/commands.js`: the commands and the `tools` list.
- `src/api/shapes.js`: shapes into constrained sketch geometry (pure).
- `src/api/select.js`: faces and edges by description, where the part
  stands (pure).
- `src/doc/parts.js`: parts, their hierarchy, copies and what is shown (pure).
- `src/api/measure3d.js`: sizes of faces and edges, and what lies between two (pure).
- `src/api/dimensions.js`: the driving numbers of a feature and where they
  are on the model, for the page's Dimensions view (pure).
- `src/drawing/`: drawings. `model.js` what a drawing is in the project and
  its changes, `layout.js` the sheet (views at the scale, dimensions, centre
  lines, frame, title block), `pdf.js` and `svg.js` the sheet written out,
  `font.js` the widths of Helvetica, all pure; `make.js` the lines of the
  views from the kernel (`views` in `src/kernel/engine.js`: HLRBRep_Algo).
- `test/api-shapes.test.html`: tests of the pure modules;
  `test/drawing.test.html` of drawings, with the kernel.
- `tools/e2e_api.py`: every command against the real kernel, with expected
  volumes and boxes, and the list of commands itself; run it with
  `python tools/e2e_api.py`.

## Over MCP

The same list is what an MCP client sees through the bridge
([bridge/README.md](../bridge/README.md)): the tab connects to a relay and
names a code, Claude is given the address that ends in that code, and each
tool call runs here as `corecad.run(name, args)`. A screenshot arrives as a
picture; every other answer as JSON text; a refused command as an error with
its sentence.

### When the tools a client sees are not the tools the tab has

Two things are kept longer than an update of CoreCAD:

- **The tab runs the files it loaded.** A tab that stays open, or that was
  reloaded while the browser still kept some files, runs an older CoreCAD and
  tells the bridge the commands of that one. `get_state` says so under `app`
  (`update_available`, with the build that is published), the page shows an
  **Update** button, and `reload_app` reloads the tab: every file of the
  published version is fetched past the browser's cache first, the project
  comes back from the browser's own save, and the tab connects again under
  the same address. Undo history does not survive it.
- **An MCP client keeps the list of tools it read when it connected.** The
  relay answers `tools/list` afresh every time, but it cannot tell a client
  that the list has changed (it holds no connection to it), so a client sees
  new commands, and stops seeing ones that were taken out, when it reads the
  list again: reconnect the server in the client, or start a new
  conversation. A call to a tool that is no longer there is answered with
  `CoreCAD has no tool "…"`.

WebMCP registration (the page declaring these tools to the browser's own
agent) is not done.

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
| a part in a group | `move_part` with `parent` |
| taking a group away | `move_part` with `parent` for each part in it, then `delete_part` |
| moving by an offset | `get_state` for where it is, `move_part` with the new `position` |
| the project as a file | `get_document` |

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
| `revolve` | [sketch], [profiles], axis, [angle], [operation], [flip] | Turns regions of a sketch about a line of that sketch: new body, join, cut or intersect. |
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
| `export` | [format], [part], [per_part], [download] | 3MF (an object for each part, named and coloured), STL or STEP. |
| `screenshot` | [max], [dimensions] | The 3D view as it stands, as a PNG data URL, with the driving numbers on it if asked. |
| `set_view` | [view], [fit] | Turns the camera to a standard view and fits the model. |
| `set_section` | plane, [at], [flip] | Cuts the model open along a plane to look inside, or (plane null) shows it whole again. |
| `set_xray` | on | Draws the solids see-through, or solid again. |
| `reload_app` | - | Reloads the tab so that it runs the newest CoreCAD; the project is kept. |

`edit_feature` takes, for an extrusion: `distance`, `through_all`,
`distance2` (0 for none), `operation`, `flip`; for a revolve: `angle`,
`axis`, `operation`, `flip`; for a fillet: `radius`; for a chamfer:
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
- `test/api-shapes.test.html`: tests of the pure modules.
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

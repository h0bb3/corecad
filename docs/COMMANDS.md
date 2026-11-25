# Commands: CoreCAD for scripts and agents

Everything the page can do to a model can also be asked for by name, with
plain JSON in and out. This is what an agent (or the browser console) uses,
and it is the list a CoreCAD MCP server will expose.

```js
await corecad.run('add_sketch', { plane: 'XY', shapes: [{ type: 'rectangle', corner: [0, 0], width: 60, height: 40 }] });
await corecad.run('extrude', { distance: 10 });
await corecad.run('add_sketch', { plane: 'top', shapes: [{ type: 'circle', center: [20, 20], diameter: 8 }] });
await corecad.run('extrude', { operation: 'cut', through_all: true });
await corecad.run('fillet', { edges: { parallel: 'z' }, radius: 4 });
// { ok: true, result: { id: 'f5', status: 'ok', bodies: [{ id: 'f2', volume: 23360, ... }], problems: [] } }

// Several parts: a box, a cylinder placed in it, cut out of it, and a linked copy beside it.
await corecad.run('add_box', { size: [60, 40, 12], name: 'Plate' });
await corecad.run('add_cylinder', { diameter: 10, height: 30, position: [15, 0, -5], name: 'Pin' });
await corecad.run('combine', { part: 'Plate', with: ['Pin'], operation: 'cut' });
await corecad.run('copy_part', { part: 'Plate', linked: true, by: [0, 60, 0] });
```

- `corecad.run(name, args)` never throws: it answers `{ ok: true, result }`
  or `{ ok: false, error }` with a sentence that says what was wrong.
- `corecad.commands.<name>(args)` is the same as a function that throws.
- `corecad.tools` is the list itself: for each command its name, a
  description and the JSON Schema of its arguments. It is the authority;
  the table below is a summary of it.

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

- **Starting one**: `add_box`, `add_cylinder` and `add_sphere` make a part
  from a solid without a sketch; `add_sketch` puts a sketch into a part (a
  first part is made when there is none; `part: "new"` starts another);
  `add_part` makes an empty one, for sketches or as a group.
- **The current part** is the one the last command worked on; `get_state`
  names it. Commands that leave `part`, `body` or a face's owner out mean
  it. A part is named by its id (`"o2"`) or its name.
- **A part's history only changes that part.** `extrude` joins to or cuts
  the bodies of its sketch's own part. Other parts meet through `combine`.
- **Place**: `move_part` gives `position` and `rotation` (degrees about the
  fixed X, then Y, then Z axis, round the part's origin), or moves `by` an
  offset, or makes a `turn` about the middle of the part. Positions are in
  the parent's frame. Moving rebuilds nothing unless a combine depends on it.
- **Combine** joins other parts to a part, cuts them out of it, or keeps
  what they share, where they stand. It is a feature of the part that is
  changed. The others become its tools: hidden, placed under it, still there.
  Move or edit a tool and the result follows.
- **Copies**: `copy_part` makes a copy with its own history; with
  `linked: true` a copy that shows the original in another place and changes
  with it. `unlink_part` turns a linked copy into a part of its own.
- **Where things are reported**: `get_state`, `list_faces` and `list_edges`
  give boxes, centres, normals and sides (`"top"`) in space, where the part
  stands. A hole's `position` is a point in space; its `at` and a sketch's
  shapes are in the face's own coordinates, which turn with the part.

## "This": what the person has clicked or points at

Someone talking to an agent says "a hole on this face" or "make that
bigger". The page keeps track of what they mean, and the commands can use it.

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
  `at` in the face's own coordinates (what a sketch on it or a hole uses),
  and `made_by`: the features whose work it is.
- **The words** `"this"`, `"selected"` and `"pointed"` can be given wherever
  a command takes a face, edges, a part, a feature id or a sketch. `"this"`
  is what is selected, or else what is pointed at.
  - `hole { face: "this", diameter: 5 }` drills where they clicked or point.
    `at: "center"` puts it in the middle of the face instead.
  - `add_sketch { plane: "this" }`, `fillet { edges: "this", radius: 2 }`,
    `move_part { part: "this", by: [0, 0, 10] }`.
  - `edit_feature { id: "this", diameter: 8 }` changes the feature that made
    the face or edge: point at the wall or the rim of a hole and it is that
    hole (or, for a hole cut with a part, that part's cylinder).
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
- `get_selection` carries the same sizes for what is selected or pointed at,
  and `between` when two things are selected.
- `list_dimensions` lists every number that drives the model: sketch
  dimensions, extrusion distances, hole diameters and depths, fillet radii,
  box and cylinder sizes. Each row says what it is, where it is in space,
  and `change_with` and `arguments`: the command that changes it, with the
  value it has now.
- A number the person clicked in the Dimensions view is in `get_selection`
  as `dimension`, and is what `set_dimension { dimension: "this" }` and
  `edit_feature { id: "this" }` mean.
- `screenshot { dimensions: true }` draws the driving numbers on the picture.

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

## The commands

Arguments in brackets are optional.

| Command | Arguments | What it does |
|---|---|---|
| `get_state` | - | The model at a glance: parts with their place, parent and history; features with status and main numbers; bodies with volume and bounding box in space; the current part. Start here. |
| `get_selection` | - | What the person has clicked and what their mouse rests on: faces, edges, part and feature, with where they are and what made them. |
| `measure` | [from], [to] | How big a face or an edge is; how far apart or at what angle two are. |
| `list_dimensions` | [part] | Every number that drives the model, with where it is and the command that changes it. |
| `get_document` | - | The whole project as JSON, as Save writes it. |
| `load_document` | document | Replaces the open project. |
| `new_document` | [name] | Starts an empty project. |
| `get_sketch` | [sketch] | One sketch in full: entities with coordinates, dimensions and constraints with ids, degrees of freedom, closed regions. |
| `list_faces` | [body], [part] | The faces of a body: index, kind, centre, area, normal, and which side a flat face is. |
| `list_edges` | [body], [part], [edges] | The edges that can be filleted or chamfered, optionally only those matching a description. |
| `add_sketch` | [plane], [part], [shapes], [name] | A sketch on an origin plane of a part or on a flat face, optionally with shapes in it. |
| `add_to_sketch` | [sketch], shapes | Adds shapes to an existing sketch. |
| `set_dimension` | [sketch], dimension, value | Changes a driving dimension; everything built on the sketch is rebuilt. |
| `add_dimension` | [sketch], refs, [value], [mode] | Adds a driving dimension. |
| `add_constraint` | [sketch], type, refs | Adds a geometric constraint; refused with the reason if it conflicts or repeats. |
| `remove_from_sketch` | [sketch], ids | Removes entities, dimensions or constraints. |
| `extrude` | [sketch], [profiles], [distance], [through_all], [operation], [symmetric], [distance2], [flip], [name] | Extrudes regions of a sketch: new body, join, cut or intersect. |
| `hole` | [face], [at], [position], diameter, [depth], [name] | A round hole into a flat face. |
| `fillet` | edges, radius, [name] | Rounds edges. |
| `chamfer` | edges, distance, [name] | Bevels edges. |
| `edit_feature` | id, and what to change | Changes a feature's parameters, name or suppression. |
| `delete_feature` | id, [with_dependents] | Deletes a feature (and, if asked, what is built on it). |
| `add_box` | size, [origin], [position], [rotation], [parent], [name] | A box as a new part, without a sketch. |
| `add_cylinder` | diameter, height, [origin], [position], [rotation], [parent], [name] | A cylinder along Z as a new part. |
| `add_sphere` | diameter, [origin], [position], [rotation], [parent], [name] | A sphere as a new part. |
| `add_part` | [name], [position], [rotation], [parent] | An empty part: for sketches, or a group to put parts under. |
| `combine` | [part], with, operation, [keep], [name] | Joins other parts to a part, cuts them out of it, or keeps what they share. |
| `move_part` | [part], [position], [rotation], [by], [turn], [parent] | Places a part: where it stands, how it is turned, what it stands under. |
| `copy_part` | [part], [linked], [position], [rotation], [by], [parent], [name] | A copy of its own, or a linked copy that follows the original. |
| `set_color` | color, [part], [faces] | A colour for a part, or for single faces. |
| `edit_part` | [part], [name], [hidden] | Renames a part, hides or shows it. |
| `unlink_part` | [part] | Turns a linked copy into a part of its own. |
| `delete_part` | [part], [with_dependents] | Deletes a part with its history and what is under it. |
| `undo`, `redo` | - | As the buttons. |
| `cancel_edit` | - | Closes a sketch or dialog that is open in the page, discarding. |
| `export` | [format], [part], [per_part], [download] | 3MF (an object for each part, named and coloured), STL, STEP or the project. |
| `screenshot` | [view], [fit], [max], [dimensions] | The 3D view as a PNG data URL, with the driving numbers on it if asked. |
| `set_view` | view, [fit] | Turns the camera to a standard view. |

## Where the code is

- `src/api/commands.js`: the commands and the `tools` list.
- `src/api/shapes.js`: shapes into constrained sketch geometry (pure).
- `src/api/select.js`: faces and edges by description, where the part
  stands (pure).
- `src/doc/parts.js`: parts, their hierarchy, copies and what is shown (pure).
- `src/api/measure3d.js`: sizes of faces and edges, and what lies between two (pure).
- `src/api/dimensions.js`: the driving numbers of a feature and where they are (pure).
- `test/api-shapes.test.html`: tests of the pure modules.
- `tools/e2e_api.py`: every command against the real kernel, with expected
  volumes and boxes; run it with `python tools/e2e_api.py`.

## Over MCP

The same list is what an MCP client sees through the bridge
([bridge/README.md](../bridge/README.md)): the tab connects to a relay and
names a code, Claude is given the address that ends in that code, and each
tool call runs here as `corecad.run(name, args)`. A screenshot arrives as a
picture; every other answer as JSON text; a refused command as an error with
its sentence.

WebMCP registration (the page declaring these tools to the browser's own
agent) is not done.

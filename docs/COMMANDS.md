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
  sketch's plane; on XY and on top faces they are the world's x and y.

## The commands

Arguments in brackets are optional.

| Command | Arguments | What it does |
|---|---|---|
| `get_state` | - | The model at a glance: features with status and main numbers, bodies with volume and bounding box. Start here. |
| `get_document` | - | The whole project as JSON, as Save writes it. |
| `load_document` | document | Replaces the open project. |
| `new_document` | [name] | Starts an empty project. |
| `get_sketch` | [sketch] | One sketch in full: entities with coordinates, dimensions and constraints with ids, degrees of freedom, closed regions. |
| `list_faces` | [body] | The faces of a body: index, kind, centre, area, normal, and which side a flat face is. |
| `list_edges` | [body], [edges] | The edges that can be filleted or chamfered, optionally only those matching a description. |
| `add_sketch` | [plane], [shapes], [name] | A sketch on an origin plane or a flat face, optionally with shapes in it. |
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
| `undo`, `redo` | - | As the buttons. |
| `cancel_edit` | - | Closes a sketch or dialog that is open in the page, discarding. |
| `export` | [format], [download] | STEP or the project as text, STL as base64, or a browser download. |
| `screenshot` | [view], [fit], [max] | The 3D view as a PNG data URL. |
| `set_view` | view, [fit] | Turns the camera to a standard view. |

## Where the code is

- `src/api/commands.js`: the commands and the `tools` list.
- `src/api/shapes.js`: shapes into constrained sketch geometry (pure).
- `src/api/select.js`: faces and edges by description (pure).
- `test/api-shapes.test.html`: tests of the two pure modules.
- `tools/e2e_api.py`: every command against the real kernel, with expected
  volumes; run it with `python tools/e2e_api.py`.

## Not yet

There is no MCP server yet: these commands are reached from inside the page
(the console, or a browser agent that can run JavaScript in the tab). The
relay that lets Claude connect by address, and WebMCP registration, will
expose this same list.

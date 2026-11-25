# CoreCAD v0.1

This is the implementation specification for the first version in [BRIEF.md](BRIEF.md).
It consolidates the three scratch designs and the unfinished lead specification.
The takeover brief authorizes this implementation, staged commits and pushes to the
existing repository. The existing Claude session is not part of this work.

## Architecture

One static page, plain ES modules, no build, npm or server backend. Dependencies are
loaded from jsDelivr at the versions in the brief: three 0.187.0, replicad 1.2.1,
replicad-opencascadejs 1.2.1. All dimensions are millimetres; Z is up.
The stylesheet optionally loads DM Sans and Manrope from Google Fonts for the
workspace typography, with local system-font fallbacks. No additional runtime
JavaScript library or build dependency is used.

* `core/`: vectors, canonical plane frames, tolerances, numbers and errors.
* `sketch/`: pure data operations, constraint solver, snapping and profile detection.
* `doc/`: pure immutable documents, validation, history and topology references.
* `kernel/`: OpenCascade ownership, labelled operations, feature evaluation, worker
  scheduling, meshing and export. No DOM and no sketch solving in the worker.
* `store.js`, `persist.js`: document store, autosave and file handling.
* `view/`: camera mathematics, picking and three.js rendering.
* `app.js`, `ui.js`: controls, feature dialogs and application orchestration.
* `sketch/editor.js`: canvas sketch editor, snapping and tool state machines.

The tested L0 files are installed from `.scratch/lead/wave0`. Prototypes are a source
of tested algorithms, not an obligation to reproduce their proposed file count.
Related functions may share a module. Numerical solver internals may use a private
adapter; the saved sketch format is always the L0 `points/entities/constraints` format.

## Document and history

A `.corecad` project is JSON `{format:'corecad', version:1, meta, seq, features, bodies}`.
Features have stable `fN` ids, a name, type, optional suppression and UI visibility.
Only user decisions and solved sketch coordinates are stored. Bodies, meshes,
profiles, sketch frames and build statuses are derived. Unknown fields survive edits;
unsupported feature types report an error. Malformed or newer files are refused
without replacing the open document.

Each edit replaces the document. Undo/redo retains up to 200 document states. A drag,
dimension entry or confirmed feature dialog is one step. Preview documents are
separate from committed documents. Editing an earlier feature shows the model at
that point; accepting rebuilds the remainder. History supports edit, rename,
suppress, delete and roll back. Deleting dependencies requires an explicit choice.
Feature and entity counters never reuse ids within a live document, including
after undo followed by a new edit.

Autosave uses browser storage independently of explicit file saves. Save/open and
STL/STEP downloads work on ordinary static hosting. Export uses the committed
document and visible bodies, never an unconfirmed preview.

## Parts (0.2)

A project is made of parts. This section replaces the single project-wide
history of 0.1; everything else in this document holds per part.

The file is format 2: `{format:'corecad', version:2, meta, seq, pseq, parts,
features, bodies}`. A part is `{id:'oN', name, parent, pos, rot, hidden?,
link?, group?}`. Every feature has `part`: a part's history is the features with its
id, in document order, built from nothing. Feature ids stay unique in the
whole project, so face labels are too. A format 1 file is read as one part
(`doc/schema.js`, `upgrade`); files are always written in format 2.

A placement is `pos` in millimetres and `rot` in degrees about the fixed X,
then Y, then Z axis, relative to the parent. Placements are rigid and are not
part of the geometry: bodies are built and referenced in their part's own
frame, and the view, the picking, the sketch plane and the export apply the
placement (`core/mat.js`, `doc/parts.js`). Moving a part rebuilds nothing.
A sketch on an origin plane lies on that plane of its part.

Features `box`, `cylinder` and `sphere` make a solid without a sketch, with
named faces. They begin a part of their own.

`combine` is a feature of the part that is changed: `{operation: join | cut |
intersect, tools: [part ids], keep?}`. The tools are taken where they stand
relative to that part. A tool's solids are its own bodies and those of the
parts under it that were not themselves used up as tools; a linked copy stands
for what it links to. Unless `keep`, the tools are used up: out of the picture
and the export, placed under the part (so they move with it), still editable.
Parts are built in an order that puts tools first; a part that would be built
from itself is an error of the feature, not of the file.

A part with `link` has no history. It shows the solids of another part (and
of what stands under that) in its own place and changes with it. A copy of
its own duplicates the part, what stands under it and all their features with
new ids, references included.

A part with `group: true` is a group: a container. It has a name, a
placement and children, and never features (a file in which a feature names a
group is refused). It is not a new kind of node: everything that walks the
tree (placement, visibility, what a combine or a linked copy takes, export of
one part, copies) treats it as a part that happens to have no solids. What it
adds is in the page and the command set: what is made while it is selected is
made in it, it folds away in the list, and it can be taken away again
(`ungroup`) with its children left where they stand. Groups are not scaled:
placements stay rigid.

A part may have `color` ('#rrggbb') and `paint`: faces with a colour of their
own, each named by its body and the labels it carried when it was painted, and
found again by those labels after a rebuild (a face that was split is painted
in all its pieces). Colours are not geometry. A linked copy shows its
original's colours unless it has a colour of its own. A part without a colour
takes the colour of the nearest part it stands under that has one: that is how
a group's colour reaches what is in it.

Export writes one object for every part that shows something, where it
stands, under the part's name: 3MF (the meshes welded so that each is one
closed surface, colours as `basematerials` with `pid`/`pindex` on an object
and `pid`/`p1` on a painted triangle), STL (one mesh, or a zip of one file for
each part: the format has no objects), STEP (exact, named, coloured).

Looking back in history is per part: `roll: {part, count}` builds the first
`count` features of that part and every other part in full.

## Sketches and constraints

A sketch contains `points`, `entities`, `constraints`, `seq` and a plane reference.
Each curve owns its points; coincidence relates endpoints. The implicit `origin`
is fixed at (0,0). Shared points in imported JSON are supported. Entity types:
point, line (`a,b`), circle (`c,r`), counter-clockwise arc (`c,a,b`). Construction
geometry participates in solving but contributes no profile.

Constraints use `{id,type,refs,...}`: coincident, pointOnLine, pointOnCircle,
horizontal, vertical, parallel, perpendicular, tangent, equal, concentric, midpoint,
fix. Dimensions: aligned/horizontal/vertical point distance, line length,
point-line distance, radius, diameter and directed angle. Dimensions drive the
geometry; reference dimensions only measure it. Angles are degrees in the file.

The solver retains the prototype's weighted union-find reduction, exact derivatives,
minimum-movement Levenberg-Marquardt, continuation and QR rank analysis. It reports
degrees of freedom, determined entities and redundant/conflicting constraints.
An unsuccessful edit leaves the prior sketch intact and identifies the reason.
Degenerate lines, circles and arcs are refused. Dragging uses a temporary handle,
small motion steps and the same equations, committing only on release.

Drawing supports chained lines, two-corner rectangles, centre/rim circles,
centre/start/end arcs and points. Nearby points/origin, horizontal/vertical directions,
midpoints and curves snap with constraints; Ctrl disables inference. Typed rectangle
width/height, line length and circle/arc radius create dimensions in the same action.
Selection, construction toggle, deleting geometry/constraints and editing dimension
labels are available. Free geometry is blue; fully determined geometry is green;
explicitly fixed geometry is purple. The sketch status shows remaining degrees of freedom.

## Profiles

Analytic line/circle intersections split curves into a planar half-edge arrangement.
Endpoints weld at the shared tolerance. Half-edges sort by tangent and curvature;
clockwise successor walks find bounded faces. Bridges and dangling edges bound no
region. Disconnected nested loops form holes. Curves remain exact lines/arcs/circles
in the result; tessellation is only for display. Containment uses analytic ray crossings.

Every region has a counter-clockwise outer loop, clockwise holes, exact signed area,
an interior point, entity-id key and orientation signature. Profile selection stores
these identifiers, with the pick position as a fallback that produces a warning if
the outline was replaced. The kernel checks face validity and area independently;
it never trusts the wire builder to catch an open or incorrectly oriented hole.

## Solids and references

Extrude supports selected regions, one side, two sides and symmetric total length;
new body, join, cut, intersect; reversed direction; through-all cuts/intersections.
Through-all is recomputed from current body bounds. Quick Hole is a planar face,
position, diameter and blind/through depth. Fillet/chamfer use picked edges and
positive radius/distance. Every feature has a live worker preview; failed previews
show the preceding valid geometry and a useful error, with confirmation disabled.

Raw OpenCascade builders carry face labels through prism, boolean and blend history:
`feature/start`, `feature/end`, `feature/side/entity`, and `feature/edge-key`.
Edges are referenced by the labels of their adjacent faces. References never silently
fall back to unrelated geometry. Splits/merges resolve by shared labels; ambiguous
faces and partially lost edge sets produce visible warnings. A face sketch uses a
canonical frame of the plane alone, so changing a plate height moves the sketch
with the top face without moving its in-plane coordinates.

A body retains the id of its creating feature and may contain several solid lumps.
Joins retain the oldest participating body; a disconnected join creates a body with
a warning. Cuts that remove an entire target and empty intersections are rejected.
Features are atomic: failure preserves preceding state, and later features still
attempt to build. Kernel allocations have explicit owners and are deleted when
cache entries expire. A bounded prefix cache avoids repeating unchanged operations.
Worker requests have sequence numbers; superseded results never replace the view.
Stop/retry can restart a stuck worker without losing the document.

## Interaction

One screen with Model and Sketch modes, a feature browser, contextual toolbar,
viewport, floating forms and status line. Every control has hover help, including
disabled controls and form fields. The model stays usable while the worker builds.
Faces and edges highlight on hover/selection. Origin planes, standard views, fit,
orbit, pan and zoom are provided. Sketch mode is orthographic with a registered
canvas overlay (CSS pixel coordinates; no extra DOM per curve). Middle drag or
Shift+right drag pans; right drag orbits in model mode and pans in sketch mode;
wheel zooms at the cursor. Autosave uses localStorage with visible quota failures;
downloaded `.corecad` files are the durable, portable copy.

Shortcuts: S sketch, L line, R rectangle, C circle, A arc, D dimension, X construction,
E extrude, H hole (H/V in sketch), F fillet, Shift+F chamfer, F6 fit, Home home view,
Ctrl+Enter finish sketch, Ctrl+Z/Y undo/redo, Ctrl+S/O save/open. Escape cancels the
innermost action and never exits a sketch. Forms also work with mouse and keyboard.

## Verification and scope

Browser tests use the existing Python/Chrome harness. Pure tests cover document
validation/history, solver invariants and profiles (including nested and intersecting
curves). Real-worker tests verify measured volumes, label survival, failures and
STL/STEP. End-to-end tests use actual mouse/key events to sketch/dimension a plate,
extrude, cut on its top face, blend edges, edit history and export. Additional flows
exercise dragging, quick holes, planes, undo and persistence. Screenshots go in
`.scratch/`; no required source or test may depend on that ignored directory.

Deferred: the brief's “should” tools (2D corner operations, trim, offset, mirror,
named expressions, projected geometry, measure and section tools), plus imports,
revolve, sweep, loft, shell, patterns, and joints or mates between parts (parts are
placed by position and rotation). Arithmetic in number fields
is evaluated once, not retained as a parametric expression. Desktop mouse/keyboard
is the primary target. Any remaining limitations belong in `docs/STATUS.md`.

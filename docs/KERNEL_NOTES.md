# Kernel notes: what was tried, and what it did

The geometry kernel is OpenCascade, through
[replicad](https://replicad.xyz) 1.2.1 and its build of the kernel,
`replicad-opencascadejs` 1.2.1. Everything below was run in a module worker in
Chrome (`test/spike.html`, `test/spike-worker.js`); none of it is from memory.
Read the type definitions rather than guessing an API:
<https://cdn.jsdelivr.net/npm/replicad@1.2.1/dist/replicad.d.ts>. The classes
of the raw kernel that this build exposes are listed in
`docs/kernel-classes.txt` (475 of them; anything else of OpenCascade is *not
there*), replicad's exports in `docs/replicad-exports.txt`.

## Loading

```js
import opencascade from 'https://cdn.jsdelivr.net/npm/replicad-opencascadejs@1.2.1/dist/replicad_single.js';
import * as r from 'https://cdn.jsdelivr.net/npm/replicad@1.2.1/dist/replicad.js';
const OC = await opencascade();   // finds its .wasm next to itself (5.7 MB over the wire, 23 MB unpacked)
r.setOC(OC);
```

- Works in a `new Worker(url, { type: 'module' })`. Import maps do **not**
  apply inside workers: a worker must import full URLs.
- `replicad.js` imports only a sibling chunk; it needs no import map.
- Start-up is about 0.3 s once the browser has the files cached.
- three.js 0.187.0 loads on the main thread through an import map
  (`three`, `three/addons/`) and draws in headless Chrome.

## Building solids from loose edges (what a sketch gives)

```js
const wire = r.assembleWire([r.makeLine(p0, p1), r.makeThreePointArc(a, mid, b), ...]);   // 3D points [x, y, z]
const face = r.makeFace(outerWire, [holeWire, ...]);
const solid = r.basicFaceExtrusion(face, new r.Vector([dx, dy, dz]));
```

- `r.makeCircle(radius, centre, normal)` is a closed edge; a wire of that one
  edge is a circle profile.
- **A hole wire must run the opposite way to the outer wire.** With the outer
  wire counter-clockwise (seen against the plane's normal), a hole must be
  clockwise: for polygons reverse the point order, for a circle flip its
  normal. A hole that runs the same way as the outer wire is *silently added*
  to the area (2400 + 78.5 instead of 2400 - 78.5). Nothing throws.
- A lone outer wire may run either way; the extrusion has positive volume in
  both directions of the vector.
- Faces on any plane work the same; build the 3D points from the plane.

## Booleans

- `a.cut(b)`, `a.fuse(b)`, `a.intersect(b)` **leave `a` and `b` alive** and
  return a new shape. Volumes are exact (`r.measureVolume(shape)`).
- The result's class is `Compound` even when it is one solid: use
  `result.solids` (an array of `Solid`). A cut that splits a part gives two
  solids; a cut that removes everything gives a shape with no faces.
- Fusing solids that touch on a face gives one solid; coplanar faces are
  merged (two boxes side by side: 6 faces).
- 10 to 40 ms each on simple parts.

## Who owns what (objects must be deleted, and some calls do it for you)

- `shape.translate(...)` (and the other transformations) **delete the
  original** and return the moved shape. `shape.clone()` keeps the source.
- **`face.outerWire()` deletes the face it is called on.** Call
  `face.clone().outerWire()` if the face is needed afterwards (after
  `outerWire()`, `innerWires()` on the same object throws "This object has
  been deleted").
- Using a deleted object throws `Error: This object has been deleted`.
- replicad frees objects through a FinalizationRegistry when they are
  garbage-collected, but a long session should `delete()` what it replaces.

## Faces and edges of a shape

- `shape.faces` and `shape.edges` are arrays in a stable order for one shape;
  each element has a `hashCode` that is unique within the shape.
- Face: `geomType` (`'PLANE'`, `'CYLINDRE'` (sic), `'CONE'`, `'SPHERE'`,
  `'TORUS'`, …), `center` (a `Vector`: `.x .y .z .toTuple()`), `normalAt()`
  (outward for a solid's face; **not unit length** on a cylinder: normalise
  it), `orientation`, `UVBounds`, `r.measureArea(face)`.
- Edge: `geomType` (`'LINE'`, `'CIRCLE'`, …), `startPoint`, `endPoint`,
  `length`, `pointAt(t)` with t from 0 to 1, `isClosed`. A full circle has
  equal start and end points; its radius is `length / (2 * Math.PI)` and its
  centre is the midpoint of `pointAt(0)` and `pointAt(0.5)`.
- Raw kernel classes are constructed without the `_1`, `_2` suffixes of
  older opencascade.js builds (`OC.BRepAdaptor_Surface_2` does not exist;
  `OC.BRepAdaptor_Surface` does). Look at how replicad's own source calls
  them before using one.
- `new r.Plane(origin, xDir, normal)`: `toWorldCoords([x, y, 0])` and
  `toLocalCoords(new r.Vector([x, y, z]))` return Vectors; `yDir` is
  normal × xDir.

## Fillet and chamfer

```js
const out = shape.fillet(edge => (wanted(edge) ? radius : null));   // a radius per edge, null to skip
const out = shape.chamfer(edge => (wanted(edge) ? distance : null));
```

- The function is called with each `Edge` of the shape; choose by geometry
  (end points, type) or by index. The source shape stays alive.
- Exact: four R4 corners on a 60 x 40 x 10 plate gave the expected volume.
- A fillet that cannot be built (radius too large) **throws a
  `WebAssembly.Exception`** whose text is only available through
  `OC.getExceptionMessage(e)` (it gave `StdFail_NotDone BRep_API: command
  not done`). Catch it and report the feature as failed.
- Choosing no edge throws a plain `Error: Could not fillet, no edge was
  selected`.

## Meshes for the view

```js
const m = shape.mesh({ tolerance: 0.05, angularTolerance: 0.3 });
// m.vertices, m.normals: flat xyz; m.triangles: flat indices
// m.faceGroups[i] = { start, count, faceId }: start and count are positions in m.triangles
//   (a rectangle is count 6); group i belongs to shape.faces[i]; faceId is that face's hashCode
const e = shape.meshEdges({ tolerance: 0.05, angularTolerance: 0.3 });
// e.lines: flat xyz of segment end points, in pairs (THREE.LineSegments)
// e.edgeGroups[i] = { start, count, edgeId }: in points, for shape.edges[i]
```

- Meshing a small part takes about 5 ms.

## Export

- `shape.blobSTEP()` and `shape.blobSTL({ binary: true })` return Blobs.
- `r.exportSTEP([{ shape, name }, ...])` writes several named shapes to one
  STEP file.

## Errors

```js
const message = e => (e instanceof WebAssembly.Exception ? 'OCCT: ' + OC.getExceptionMessage(e).join(' ') : String(e?.message ?? e));
```

## Placing a shape, and primitives (for parts)

```js
const t = new OC.gp_Trsf();
t.SetValues(r00, r01, r02, tx, r10, r11, r12, ty, r20, r21, r22, tz);   // row order
const loc = new OC.TopLoc_Location(t);
const moved = r.cast(shape.wrapped.Moved(loc, false));                   // the source stays alive
```

- `moved.faces[i]` is `shape.faces[i]` in its new place: same count, same
  order. Labels kept per face index carry over unchanged.
- A moved shape works as a boolean tool, and a fillet or chamfer on an edge
  the tool made works afterwards (also with a turned tool).
- A hole that is tangent to a wall cannot take a chamfer on its rim
  (`Standard_ProgramError TopOpeBRepDS_DataStructure::Point`): that is the
  geometry, not the placement.
- `r.makeBox(corner1, corner2)`, `r.makeCylinder(radius, height, location,
  direction)` and `r.makeSphere(radius)` give a `Solid` with 6, 3 and 1
  faces. A box's faces are told apart by `normalAt()`.
- A sphere has three edges: a seam and two of zero length at the poles. All
  belong to one face only, so none can be picked; reading their points and
  length does not throw.

## Revolve

```js
const ax = r.makeAx1(origin, direction);                       // a gp_Ax1; delete it
const b = new OC.BRepPrimAPI_MakeRevol(face.wrapped, ax, radians, false);
const shape = r.cast(b.Shape());
```

- The turn is right-handed about the axis direction. `2 * Math.PI` closes it.
- Volumes are exact (a 10 x 20 rectangle at radius 5 to 15: 4000 pi).
- `b.FirstShape()` and `b.LastShape()` are the two flat ends of a turn that
  is not closed; `b.Generated(edge.wrapped)` lists the face each edge of the
  profile swept, and nothing for an edge that lies on the axis.
- **On a closed turn `Generated()` is not enough**: the faces it names for
  the lines that sweep flat rings (lines square to the axis) are not the
  faces of the result, so those rings come out unnamed, while cylinders and
  spheres are named. Such a face is found by its content instead: the middle
  of the line that swept it lies on it (`new r.DistanceQuery(r.makeVertex(p))`
  then `.distanceTo(face) < 1e-6`; delete both).
- A profile that reaches across the axis is not refused by the kernel; check
  it in the sketch plane before building.

## A profile turned about an axis while it rises along it (a thread)

First tried in `test/spike-helix.test.html`; it is what `revolve` with a
`rise` does (`screwed` in `src/kernel/shapes.js`, tested in
`test/kernel-revolve.test.html`). **Read the dangers before changing it: the
kernel gets this wrong in several ways without saying so.**

```js
const b = new OC.BRepOffsetAPI_MakePipeShell(spine.wrapped);         // spine: the axis, as a wire
b.SetMode(guide.wrapped, false, OC.BRepFill_TypeOfContact.BRepFill_NoContact); // guide: a helix about the axis
b.Add(profileWire.wrapped, false, false);
b.Build();
b.MakeSolid();                                                       // false, or it throws, when it cannot
const shape = r.cast(b.Shape());
```

- The axis carries the outline and the helix says how far it has turned.
  The same solid comes from the helix as the spine with `SetMode(true)`
  (its own frame). The names have no suffix in this build (`SetMode`, `Add`,
  `Build()` without a progress).
- The result is a valid `Solid`. Each edge of the outline makes one
  `BSPLINE_SURFACE` for each edge of the spine; there are two flat ends.
  `b.Generated(edge.wrapped)` lists the faces an edge of the outline made
  (one for each piece of the spine), `b.FirstShape()` and `b.LastShape()`
  are the flat ends.
- **The volume is exact, and there is a formula for it**: the first moment
  of the outline about the axis, times the angle in radians. That is the
  volume of an ordinary revolve by the same angle; the rise adds nothing,
  because along the axis the outline moves within its own plane. `screwed`
  checks every solid against it.
- Fast by itself: a tenth of a second for a few turns, half a second for thirty.

The dangers, each seen here with a valid shape and no error:

- **More than about thirty turns in one piece: the solid is wrong.** 40
  turns had 13.5 % too little volume, 60 turns half. With the axis and the
  helix both cut into pieces it is exact to 100 turns. Pieces of the axis
  alone do not help.
- **A face that goes more than half a turn round is cut and joined
  wrongly.** With pieces of one turn or more, of 7 to 12 turns joined to a
  rod: 51 mm3 missing of 17180; an extra solid; no faces at all; the rod
  gone. A groove cut through a block with a hole: nothing removed at all
  when the hole's cylinder had been made one way up, right when it had been
  made the other way up, and the reverse when the groove was made from its
  far end. Pieces of one turn: the joins right, most of the cuts 0.1 to
  0.6 mm3 off. **Pieces of half a turn: all 28 cases right to 0.006**
  (joins and cuts, made from either end, right- and left-handed, the seam
  of the rod or the hole at 0, 77, 133 and 200 degrees), and a quarter turn
  the same but slower. So `screwed` makes half turns.
- **Pieces of uneven length are refused** now and then
  (`StdFail_NotDone Uncompatible wires`: a turn and a quarter as 0.5, 0.5,
  0.25): the pieces are all made the same length.
- replicad's `makeHelix` always starts at the same angle, so its pieces
  must be whole turns. `helixArc` in `shapes.js` makes any piece: a segment
  of a `Geom2d_Line` on one `Geom_CylindricalSurface`, as `makeHelix` does.
- **A tooth that stands on the body** (its base in the body's wall, or a
  corner on it) is not joined: two solids, or `StdFail_NotDone`. Its flanks
  must cross the wall. `revolve` says so.
- **Turns that run into each other** (an outline as long along the axis as
  the rise, or longer) give a valid solid with the volume of the formula:
  it overlaps itself. Checked before building.
- **A side of the outline on the axis**: not valid. A corner on the axis is
  fine.
- replicad's own `a.fuse(b)` does not ask for errors: for a tooth with a
  corner in the wall it gave back the ridge alone, valid, the rod gone.
- `revolve` still makes the solid a second time, from its far end, when a
  cut or a join did nothing: that put right the lost cuts when the pieces
  were longer. With half turns no case is known that needs it.

Times, with CoreCAD's own boolean and half turns: joined to a rod, 7 turns
1.7 s, 17 turns 3.8 s, 30 turns 8.3 s (the sweep itself 0.1 to 0.6 s of
that, the mesh 0.1 to 0.3 s); a groove of 4.5 turns cut in a block 1 s. An
outline with a hole is the outer one made solid and the hole's cut out of it
(1.8 s for 2.5 turns).

## Reading STEP

```js
OC.FS.writeFile('/in.step', bytes);                 // the kernel reads files of its own little disk
const reader = new OC.STEPControl_Reader();
reader.ReadFile('in.step');                         // what it answers is an object whatever happened
reader.TransferRoots();
const shape = r.cast(reader.OneShape());            // throws "This shape has not type, it is null" when nothing was read
OC.FS.unlink('/in.step');
```

- This is what replicad's `importSTEP(blob)` does, without waiting for the
  blob: features are built without waiting for anything.
- A solid written with `blobSTEP()` and read back has the same volume to the
  last digit, the same number of faces and edges, and is valid. Two solids
  written with `exportSTEP([...])` come back as a `Compound` of two.
- **The faces come in the same order every time** the same text is read,
  also in a kernel that has just started: they can be named by their number.
- Text that is not STEP, or half a file: `OneShape()` is null and `cast`
  throws. There is no better word from the kernel about what was wrong.
- Fast: a plate with a hole and round corners (35 KB of STEP) in 0.1 s.
- Not tried: a file from another CAD program, an assembly with parts placed
  inside each other, a file in inches, a file of megabytes.


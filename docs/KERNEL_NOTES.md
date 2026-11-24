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

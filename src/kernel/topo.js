import { kernel, scope } from './occ.js';
import { edgesOf, bounds, volume, countSolids } from './shapes.js';
import { dot, unit, sub, add, mul, cross } from '../core/vec.js';
const tuple = (v) => {
  const t = v.toTuple();
  v.delete();
  return t;
};
const xyz = (p) => [p.X(), p.Y(), p.Z()];
/** What a round face is round about: for a cylinder its axis and radius, and whether the material
 *  is inside it (a boss, a fillet) or outside (the wall of a hole); for a sphere its centre and radius. */
function roundness(f, kind) {
  const { OC } = kernel(),
    own = scope();
  try {
    const a = own(new OC.BRepAdaptor_Surface(f.wrapped, true));
    if (kind === 'sphere') {
      const s = own(a.Sphere());
      return { sphere: { c: xyz(own(s.Location())), r: s.Radius() } };
    }
    const c = own(a.Cylinder()),
      axis = own(c.Axis()),
      p = xyz(own(axis.Location())),
      dir = xyz(own(axis.Direction()));
    // The outward normal at a point of the face, against the direction from the axis to that point.
    const on = own(f.pointOnSurface(0.5, 0.5)),
      at = on.toTuple(),
      n = tuple(f.normalAt(on)),
      out = sub(at, add(p, mul(dir, dot(sub(at, p), dir))));
    return { cyl: { p, dir, r: c.Radius(), convex: dot(n, out) > 0 } };
  } catch {
    return {}; // a face the kernel will not describe is still a face
  } finally {
    own.end();
  }
}
/** The circle an edge is (part of): centre, radius and the direction of its axis. */
function circleOf(e) {
  const { OC } = kernel(),
    own = scope();
  try {
    const c = own(own(new OC.BRepAdaptor_Curve(e.wrapped)).Circle());
    return { c: xyz(own(c.Location())), r: c.Radius(), n: xyz(own(own(c.Axis()).Direction())) };
  } catch {
    return null;
  } finally {
    own.end();
  }
}
export function topoOf(body) {
  if (body.topo) return body.topo;
  const { r } = kernel();
  const faces = body.faces.map((f, i) => {
    const center = tuple(f.center),
      kind =
        { PLANE: 'plane', CYLINDRE: 'cylinder', CONE: 'cone', SPHERE: 'sphere', TORUS: 'torus' }[
          f.geomType
        ] ?? 'other';
    const info = { kind, center, area: r.measureArea(f), labels: body.labels[i] };
    if (kind === 'plane') {
      const n = unit(tuple(f.normalAt()));
      info.plane = { n, d: dot(n, center) };
    }
    if (kind === 'cylinder' || kind === 'sphere') Object.assign(info, roundness(f, kind));
    return info;
  });
  const edges = edgesOf(body).map(({ e, faces, seam }) => {
    const kind = { LINE: 'line', CIRCLE: 'circle' }[e.geomType] ?? 'other';
    const a = tuple(e.startPoint),
      b = tuple(e.endPoint),
      mid = tuple(e.pointAt(0.5));
    const info = { kind, a, b, mid, faces, seam, closed: e.isClosed, length: e.length };
    if (kind === 'circle') {
      // Arcs too: the rim of a fillet has a radius as much as the rim of a hole has.
      const circle = circleOf(e);
      if (circle) info.circle = circle;
      else if (info.closed) {
        const c = mul(add(a, mid), 0.5),
          q = tuple(e.pointAt(0.25));
        info.circle = { c, r: info.length / (2 * Math.PI), n: unit(cross(sub(a, c), sub(q, c))) };
      }
    }
    return info;
  });
  body.topo = { id: body.id, faces, edges };
  return body.topo;
}
export function describe(body) {
  body.measures ??= {
    volume: volume(body.shape),
    bbox: bounds(body.shape),
    lumps: countSolids(body.shape),
  };
  return { id: body.id, key: body.key, ...body.measures };
}
export function packBody(body) {
  const topo = topoOf(body),
    data = describe(body);
  if (!body.mesh) {
    const m = body.shape.mesh({ tolerance: 0.025, angularTolerance: 0.25 }),
      e = body.shape.meshEdges({ tolerance: 0.025, angularTolerance: 0.25 });
    const fg = new Map(m.faceGroups.map((g) => [g.faceId, g])),
      eg = new Map(e.edgeGroups.map((g) => [g.edgeId, g]));
    const faceTris = body.faces.flatMap((f) => {
      const g = fg.get(f.hashCode);
      return g ? [g.start, g.count] : [0, 0];
    });
    const edgeSegs = edgesOf(body).flatMap(({ e, seam }) => {
      const g = eg.get(e.hashCode);
      return g && !seam ? [g.start, g.count] : [0, 0];
    });
    body.mesh = {
      positions: new Float32Array(m.vertices),
      normals: new Float32Array(m.normals),
      indices: new Uint32Array(m.triangles),
      faceTris: new Uint32Array(faceTris),
      edgeLines: new Float32Array(e.lines),
      edgeSegs: new Uint32Array(edgeSegs),
      faces: topo.faces,
      edges: topo.edges,
    };
  }
  // The worker retains its cached mesh; sending a cloned buffer avoids detached cache entries.
  return { ...data, mesh: structuredClone(body.mesh) };
}

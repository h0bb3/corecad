import { kernel, scope, hashOf, listToArray } from './occ.js';
import { FeatureError } from '../core/errors.js';
import { add, sub, mul, len, dot, unit } from '../core/vec.js';
import { toWorld } from '../core/plane.js';
import { loopArea, pieceMid } from '../sketch/geom2d.js';
import { sortLabels } from '../doc/refs.js';

export function indexShape(shape) {
  const faces = shape.faces,
    byHash = new Map();
  faces.forEach((f, i) => {
    const h = f.hashCode;
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(i);
  });
  return {
    faces,
    find: (s) => (byHash.get(hashOf(s)) ?? []).find((i) => faces[i].wrapped.IsSame(s)) ?? -1,
  };
}
export function dispose(body) {
  if (body.disposed) return;
  body.disposed = true;
  body.edgeTable?.forEach((e) => e.e.delete());
  body.faces.forEach((f) => f.delete());
  body.shape.delete();
}
export function isValid(shape) {
  const { OC } = kernel(),
    analyzer = new OC.BRepCheck_Analyzer(shape.wrapped, true, false, false);
  try {
    return analyzer.IsValid();
  } finally {
    analyzer.delete();
  }
}
export function countSolids(shape) {
  const solids = shape.solids;
  const n = solids.length;
  solids.forEach((s) => s.delete());
  return n;
}
export function bounds(shape) {
  const b = shape.boundingBox;
  try {
    return b.bounds;
  } finally {
    b.delete();
  }
}
export const volume = (shape) => kernel().r.measureVolume(shape);

function edgeLine(a, b) {
  const { OC, r } = kernel(),
    own = scope();
  try {
    const p = own(new OC.gp_Pnt(...a)),
      q = own(new OC.gp_Pnt(...b));
    return new r.Edge(own(new OC.BRepBuilderAPI_MakeEdge(p, q)).Edge());
  } finally {
    own.end();
  }
}
function edgeArc(a, m, b) {
  const { OC, r } = kernel(),
    own = scope();
  try {
    const pts = [a, m, b].map((p) => own(new OC.gp_Pnt(...p)));
    const curve = own(own(new OC.GC_MakeArcOfCircle(...pts)).Value());
    return new r.Edge(own(new OC.BRepBuilderAPI_MakeEdge(curve)).Edge());
  } finally {
    own.end();
  }
}
const reversed = (loop) =>
  loop
    .slice()
    .reverse()
    .map((p) => ({ ...p, a: p.b, b: p.a, ccw: p.kind === 'line' ? undefined : !p.ccw }));
export function profileFace(frame, region, t = 0) {
  const { r } = kernel(),
    own = scope(),
    origins = [];
  const P = (p) => toWorld(frame, p, t);
  function wire(loop, positive) {
    const ordered = loopArea(loop) > 0 === positive ? loop : reversed(loop);
    const edges = ordered.map((p) => {
      if (p.kind === 'circle') {
        origins.push({ entity: p.entity, circle: true, c: P(p.c) });
        return own(r.makeCircle(p.r, P(p.c), p.ccw === false ? mul(frame.n, -1) : frame.n));
      }
      const m = pieceMid(p);
      origins.push({ entity: p.entity, mid: P(m) });
      return own(p.kind === 'line' ? edgeLine(P(p.a), P(p.b)) : edgeArc(P(p.a), P(m), P(p.b)));
    });
    return own(r.assembleWire(edges));
  }
  let face;
  try {
    face = r.makeFace(
      wire(region.outer, true),
      region.holes.map((h) => wire(h, false))
    );
    const expected =
      Math.abs(loopArea(region.outer)) -
      region.holes.reduce((sum, h) => sum + Math.abs(loopArea(h)), 0);
    if (
      !(expected > 1e-9) ||
      Math.abs(r.measureArea(face) - expected) > 1e-6 * Math.max(1, expected) ||
      !isValid(face)
    )
      throw new FeatureError(
        'profile-invalid',
        'The profile could not be made into a valid face. Check for crossing or touching outlines.'
      );
    return { face, origins };
  } catch (e) {
    face?.delete();
    throw e;
  } finally {
    own.end();
  }
}
function originOf(edge, origins) {
  const p0 = edge.pointAt(0),
    p5 = edge.pointAt(0.5),
    a = p0.toTuple(),
    m = p5.toTuple();
  p0.delete();
  p5.delete();
  return origins.find((k) =>
    k.circle
      ? edge.isClosed && len(sub(mul(add(a, m), 0.5), k.c)) < 1e-6
      : len(sub(m, k.mid)) < 1e-6
  )?.entity;
}
export function prism(fid, frame, region, a, b, roles = ['start', 'end']) {
  const { OC, r } = kernel(),
    own = scope(),
    { face, origins } = profileFace(frame, region, a);
  own(face);
  let shape, faces;
  try {
    const vec = own(new r.Vector(mul(frame.n, b - a))),
      builder = own(new OC.BRepPrimAPI_MakePrism(face.wrapped, vec.wrapped, false, true));
    shape = r.cast(builder.Shape());
    const indexed = indexShape(shape);
    faces = indexed.faces;
    const labels = faces.map(() => []);
    const put = (raw, label) => {
      try {
        const i = indexed.find(raw);
        if (i >= 0) labels[i].push(label);
      } finally {
        raw.delete();
      }
    };
    put(builder.FirstShape(), `${fid}/${roles[0]}`);
    put(builder.LastShape(), `${fid}/${roles[1]}`);
    for (const edge of face.edges) {
      try {
        const id = originOf(edge, origins);
        if (!id)
          throw new FeatureError(
            'profile-invalid',
            'The kernel could not identify a profile edge.'
          );
        for (const g of listToArray(builder.Generated(edge.wrapped))) put(g, `${fid}/side/${id}`);
      } finally {
        edge.delete();
      }
    }
    if (labels.some((l) => !l.length) || !isValid(shape))
      throw new FeatureError(
        'invalid-result',
        'The extrusion did not produce a valid labelled solid.'
      );
    return { shape, faces, labels };
  } catch (e) {
    faces?.forEach((f) => f.delete());
    shape?.delete();
    throw e;
  } finally {
    own.end();
  }
}
function carry(builder, inputs, shape, fresh, fid) {
  const { faces, find } = indexShape(shape),
    sets = faces.map(() => new Set());
  try {
    for (const input of inputs)
      input.faces.forEach((face, i) => {
        if (builder.IsDeleted(face.wrapped)) return;
        const modified = listToArray(builder.Modified(face.wrapped));
        if (modified.length)
          for (const raw of modified) {
            const k = find(raw);
            if (k >= 0) input.labels[i].forEach((l) => sets[k].add(l));
            raw.delete();
          }
        else {
          const k = find(face.wrapped);
          if (k >= 0) input.labels[i].forEach((l) => sets[k].add(l));
        }
      });
    fresh?.(sets, find);
    for (const s of sets) if (!s.size) s.add(`${fid}/x`);
    return { shape, faces, labels: sets.map((s) => sortLabels([...s])) };
  } catch (e) {
    faces.forEach((f) => f.delete());
    shape.delete();
    throw e;
  }
}
export function boolean(op, a, b, fid) {
  const { OC, r } = kernel(),
    Builder = { cut: OC.BRepAlgoAPI_Cut, fuse: OC.BRepAlgoAPI_Fuse, common: OC.BRepAlgoAPI_Common }[
      op
    ],
    builder = new Builder(a.shape.wrapped, b.shape.wrapped);
  try {
    builder.Build();
    if (builder.HasErrors()) throw new FeatureError('kernel', 'The boolean operation failed.');
    builder.SimplifyResult(true, true, 1e-3);
    const out = carry(builder, [a, b], r.cast(builder.Shape()), null, fid);
    if (!isValid(out.shape)) {
      dispose(out);
      throw new FeatureError('invalid-result', 'The boolean operation produced invalid geometry.');
    }
    return out;
  } finally {
    builder.delete();
  }
}
export function cylinder(fid, center, dir, radius, height) {
  const { r } = kernel(),
    shape = r.makeCylinder(radius, height, center, dir),
    faces = shape.faces;
  const labels = faces.map((f) => {
    if (f.geomType === 'CYLINDRE') return [`${fid}/wall`];
    const p = f.center,
      t = dot(sub(p.toTuple(), center), dir);
    p.delete();
    return [`${fid}/${Math.abs(t) < 1e-6 ? 'top' : 'bottom'}`];
  });
  return { shape, faces, labels };
}
export function edgesOf(body) {
  if (body.edgeTable) return body.edgeTable;
  const edges = body.shape.edges,
    byHash = new Map();
  edges.forEach((e, i) => {
    if (!byHash.has(e.hashCode)) byHash.set(e.hashCode, []);
    byHash.get(e.hashCode).push(i);
  });
  const adj = edges.map(() => new Set());
  body.faces.forEach((f, i) => {
    for (const e of f.edges) {
      for (const j of byHash.get(e.hashCode) ?? [])
        if (edges[j].wrapped.IsSame(e.wrapped)) {
          adj[j].add(i);
          break;
        }
      e.delete();
    }
  });
  body.edgeTable = edges.map((e, i) => ({ e, i, faces: [...adj[i]], seam: adj[i].size < 2 }));
  return body.edgeTable;
}
export function blend(kind, fid, body, picks, size) {
  const { OC, r } = kernel(),
    b =
      kind === 'fillet'
        ? new OC.BRepFilletAPI_MakeFillet(body.shape.wrapped, OC.ChFi3d_FilletShape.ChFi3d_Rational)
        : new OC.BRepFilletAPI_MakeChamfer(body.shape.wrapped);
  try {
    for (const p of picks) b.Add(size, p.e.wrapped);
    b.Build();
    if (!b.IsDone())
      throw new FeatureError(
        'blend-failed',
        `The ${kind} cannot be built with ${
          kind === 'fillet' ? 'radius' : 'distance'
        } ${size} mm. Try a smaller size or fewer edges.`
      );
    const out = carry(
      b,
      [body],
      r.cast(b.Shape()),
      (sets, find) => {
        const keys = new Map();
        picks.forEach((p) => {
          const c = b.Contour(p.e.wrapped);
          if (c > 0 && !keys.has(c)) keys.set(c, p.k);
        });
        for (let c = 1; c <= b.NbContours(); c++)
          for (let j = 1; j <= b.NbEdges(c); j++) {
            const edge = b.Edge(c, j);
            for (const raw of listToArray(b.Generated(edge))) {
              const i = find(raw);
              if (i >= 0) sets[i].add(`${fid}/${keys.get(c) ?? 'x'}`);
              raw.delete();
            }
            edge.delete();
          }
      },
      fid
    );
    if (!countSolids(out.shape) || !isValid(out.shape)) {
      dispose(out);
      throw new FeatureError(
        'blend-failed',
        `The ${kind} is invalid at ${size} mm. Try a smaller size.`
      );
    }
    return out;
  } finally {
    b.delete();
  }
}

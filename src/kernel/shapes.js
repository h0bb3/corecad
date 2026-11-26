import { kernel, scope, hashOf, listToArray, errorText, isFatal } from './occ.js';
import { FeatureError } from '../core/errors.js';
import { add, sub, mul, len, dot, unit } from '../core/vec.js';
import { toWorld } from '../core/plane.js';
import { loopArea, pieceMid, polygonOf } from '../sketch/geom2d.js';
import { sortLabels } from '../doc/refs.js';
import { formatNumber } from '../core/num.js';

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
/** A loop of a sketch as a wire in space, at `t` along the plane's normal: counter-clockwise about the normal
 *  when `positive`. `origins` is told which entity each edge is; `own` is given what must be deleted. */
function loopWire(frame, loop, positive, t, origins, own) {
  const { r } = kernel(),
    P = (p) => toWorld(frame, p, t),
    ordered = loopArea(loop) > 0 === positive ? loop : reversed(loop);
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
export function profileFace(frame, region, t = 0) {
  const { r } = kernel(),
    own = scope(),
    origins = [];
  const wire = (loop, positive) => loopWire(frame, loop, positive, t, origins, own);
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
/**
 * A profile turned about a line of its sketch plane.
 * @param {{ p: number[], d: number[] }} axis  a point and a unit direction, in the plane's own coordinates
 * @param {number} angle  degrees, up to 360. Less than all the way round, the turn starts in the sketch
 *   plane and goes to the side the sketch faces; `flip` turns it the other way.
 * Faces: `fid/side/<entity>` for what each line or arc of the outline sweeps, and `fid/start`, `fid/end`
 * for the two flat ends of a turn that is not closed.
 */
export function revolved(fid, frame, region, axis, angle, flip = false) {
  const { OC, r } = kernel(),
    own = scope(),
    off = ([x, y]) => axis.d[0] * (y - axis.p[1]) - axis.d[1] * (x - axis.p[0]), // to the left of the axis: positive
    reach = [region.outer, ...region.holes].flatMap((loop) => polygonOf(loop, 1e-4).map(off)),
    lo = Math.min(...reach),
    hi = Math.max(...reach),
    eps = 1e-6 * Math.max(1, hi - lo);
  if (lo < -eps && hi > eps)
    throw new FeatureError('axis-crosses', 'The profile lies on both sides of the axis. Keep it on one side; it may touch the axis.');
  const { face, origins } = profileFace(frame, region, 0);
  own(face);
  let shape, faces;
  try {
    const o = toWorld(frame, axis.p),
      along = unit(sub(toWorld(frame, [axis.p[0] + axis.d[0], axis.p[1] + axis.d[1]]), o)),
      // A point to the left of the axis turns, right-handed about it, towards the plane's normal.
      dir = hi > eps !== flip ? along : mul(along, -1),
      full = angle > 360 - 1e-9;
    const ax = own(r.makeAx1(o, dir)),
      builder = own(new OC.BRepPrimAPI_MakeRevol(face.wrapped, ax, full ? 2 * Math.PI : (angle * Math.PI) / 180, false));
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
    if (!full) {
      put(builder.FirstShape(), `${fid}/start`);
      put(builder.LastShape(), `${fid}/end`);
    }
    const swept = []; // each line or arc of the outline, with its middle in space
    for (const edge of face.edges) {
      try {
        const id = originOf(edge, origins);
        if (!id) throw new FeatureError('profile-invalid', 'The kernel could not identify a profile edge.');
        for (const g of listToArray(builder.Generated(edge.wrapped))) put(g, `${fid}/side/${id}`); // none for an edge on the axis
        const m = edge.pointAt(0.5);
        swept.push({ id, mid: m.toTuple() });
        m.delete();
      } finally {
        edge.delete();
      }
    }
    // On a closed turn the kernel rebuilds the flat rings and no longer says which line made them
    // (observed: the faces that Generated() names are not in the result). A face holds the middle of
    // the line that swept it, and of no other.
    const blank = labels.flatMap((l, i) => (l.length ? [] : [i]));
    if (blank.length)
      for (const { id, mid } of swept) {
        const probe = own(new r.DistanceQuery(own(r.makeVertex(mid))));
        for (const i of blank) if (probe.distanceTo(faces[i]) < 1e-6) labels[i].push(`${fid}/side/${id}`);
      }
    if (labels.some((l) => !l.length) || !isValid(shape) || !(volume(shape) > 0))
      throw new FeatureError('invalid-result', 'The revolve did not produce a valid labelled solid.');
    return { shape, faces, labels };
  } catch (e) {
    faces?.forEach((f) => f.delete());
    shape?.delete();
    throw e;
  } finally {
    own.end();
  }
}
/** How much of a turn the kernel is given in one piece: half a turn. A face that goes further round is cut
 *  and joined wrongly by the kernel, which says nothing: bodies come back as they were, or a little short,
 *  or without a part of themselves. With half turns every case that was tried came out right (KERNEL_NOTES,
 *  "A profile turned about an axis while it rises along it"). */
const TURNS_A_PIECE = 0.5;
/** A piece of a helix of radius 1 about the axis through `o` along `dir`: from turn t0 to turn t1 of it, as
 *  a wire. The pieces of one helix lie on one cylinder, so each begins where the one before it ended. */
function helixArc(o, dir, rise, t0, t1, left) {
  const { OC, r } = kernel(),
    own = scope();
  try {
    const length = Math.hypot(2 * Math.PI, rise),
      line = own(new OC.Geom2d_Line(own(new OC.gp_Pnt2d(0, 0)), own(new OC.gp_Dir2d(left ? -2 * Math.PI : 2 * Math.PI, rise)))),
      segment = own(new OC.GC_MakeSegment2d(own(line.Value(t0 * length)), own(line.Value(t1 * length)))),
      surface = own(new OC.Geom_CylindricalSurface(own(r.makeAx3(o, dir)), 1)),
      edge = own(new OC.BRepBuilderAPI_MakeEdge(own(segment.Value()), surface)).Edge(),
      wire = own(new OC.BRepBuilderAPI_MakeWire(edge)).Wire();
    OC.BRepLib.BuildCurves3d(wire);
    return new r.Wire(wire);
  } finally {
    own.end();
  }
}
/**
 * A profile turned about a line of its sketch plane while it moves along that line: `rise` for each full turn.
 * @param {{ p: number[], d: number[] }} axis  a point and a unit direction, in the plane's own coordinates. The
 *   profile goes along the axis in that direction (`flip`: against it), and turns about it as a right-handed
 *   screw does (`left`: as a left-handed one).
 * @param {number} angle  degrees; every 360 is a turn, and there may be many
 * @param {boolean} backwards  make the same solid from its far end back to the sketch plane. The kernel
 *   loses a cut or a join of this solid with some bodies, without saying so, when it is made one way, and
 *   does it rightly when it is made the other way (KERNEL_NOTES): the caller tries both.
 * Faces: `fid/side/<entity>` for what each line or arc of the outline sweeps, `fid/start` for the flat end in
 * the sketch plane and `fid/end` for the other.
 */
export function screwed(fid, frame, region, axis, angle, rise, flip = false, left = false, backwards = false) {
  const { OC, r } = kernel(),
    own = scope(),
    off = ([x, y]) => axis.d[0] * (y - axis.p[1]) - axis.d[1] * (x - axis.p[0]), // from the axis, to its left: positive
    up = ([x, y]) => axis.d[0] * (x - axis.p[0]) + axis.d[1] * (y - axis.p[1]), // along the axis
    loops = [region.outer, ...region.holes],
    polygons = loops.map((loop) => polygonOf(loop, 1e-4)),
    reach = polygons.flat().map(off),
    lo = Math.min(...reach),
    hi = Math.max(...reach),
    eps = 1e-6 * Math.max(1, hi - lo);
  if (lo < -eps && hi > eps)
    throw new FeatureError('axis-crosses', 'The profile lies on both sides of the axis. Keep it on one side.');
  if (loops.some((loop) => loop.some((p) => p.kind === 'line' && Math.abs(off(p.a)) < eps && Math.abs(off(p.b)) < eps)))
    throw new FeatureError('axis-touches', 'A side of the profile lies on the axis. With a rise the profile may touch the axis at a corner, not along a side.');
  const heights = polygons[0].map(up),
    tall = Math.max(...heights) - Math.min(...heights);
  if (angle > 360 + 1e-9 && !(tall < rise - 1e-7))
    throw new FeatureError(
      'turns-meet',
      `The profile is ${formatNumber(tall)} long along the axis and rises ${formatNumber(rise)} in a turn: one turn would run into the next. Give it a rise of more than ${formatNumber(tall)}, or make the profile shorter along the axis.`
    );
  // What a loop holds when it has turned: its first moment about the axis, times the angle. The rise adds
  // nothing, for along the axis the profile moves within its own plane.
  const radians = (angle * Math.PI) / 180,
    holds = (poly) =>
      (Math.abs(
        poly.reduce((m, p, i) => {
          const q = poly[(i + 1) % poly.length];
          return m + (off(p) + off(q)) * (off(p) * up(q) - off(q) * up(p));
        }, 0)
      ) /
        6) *
      radians;
  const o = toWorld(frame, axis.p),
    dir = mul(unit(sub(toWorld(frame, [axis.p[0] + axis.d[0], axis.p[1] + axis.d[1]]), o)), flip ? -1 : 1),
    turns = angle / 360,
    count = Math.max(1, Math.ceil(turns / TURNS_A_PIECE - 1e-9)),
    cuts = Array.from({ length: count + 1 }, (_, i) => (turns * i) / count); // pieces of one length: the kernel refuses some uneven ones ("Uncompatible wires")
  const at = (t) => add(o, mul(dir, (backwards ? turns - t : t) * rise)), // t turns from where the kernel begins
    way = backwards ? mul(dir, -1) : dir,
    ends = backwards ? ['end', 'start'] : ['start', 'end'];
  let done = null;
  try {
    own(profileFace(frame, region, 0).face); // refuses an outline that is not a valid face
    // The axis carries the outline, and a helix about it says how far it has turned.
    const spine = own(r.assembleWire(cuts.slice(1).map((t, i) => own(edgeLine(at(cuts[i]), at(t)))))),
      guide = own(r.assembleWire(cuts.slice(1).map((t, i) => own(helixArc(at(0), way, rise, cuts[i], t, left)))));
    const turned = (loop, poly) => {
      const origins = [],
        drawn = loopWire(frame, loop, true, 0, origins, own),
        ids = drawn.edges.map((edge) => {
          try {
            return originOf(edge, origins);
          } finally {
            edge.delete();
          }
        }),
        // backwards: the outline where it ends up, its edges in the same order
        wire = backwards ? own(drawn.clone().rotate(left ? -angle : angle, o, dir).translate(mul(dir, turns * rise))) : drawn,
        builder = own(new OC.BRepOffsetAPI_MakePipeShell(spine.wrapped));
      if (ids.some((id) => !id)) throw new FeatureError('profile-invalid', 'The kernel could not identify a profile edge.');
      let shape;
      try {
        builder.SetMode(guide.wrapped, false, OC.BRepFill_TypeOfContact.BRepFill_NoContact);
        builder.Add(wire.wrapped, false, false);
        builder.Build();
        if (!builder.MakeSolid()) throw new Error('not closed');
        shape = r.cast(builder.Shape());
      } catch (e) {
        if (e instanceof FeatureError || isFatal(e)) throw e;
        throw new FeatureError('invalid-result', 'The kernel could not turn this profile into a solid.', { detail: errorText(e) });
      }
      const indexed = indexShape(shape),
        faces = indexed.faces,
        labels = faces.map(() => []);
      try {
        const put = (raw, label) => {
          try {
            const i = indexed.find(raw);
            if (i >= 0) labels[i].push(label);
          } finally {
            raw.delete();
          }
        };
        put(builder.FirstShape(), `${fid}/${ends[0]}`);
        put(builder.LastShape(), `${fid}/${ends[1]}`);
        wire.edges.forEach((edge, i) => {
          try {
            for (const g of listToArray(builder.Generated(edge.wrapped))) put(g, `${fid}/side/${ids[i]}`);
          } finally {
            edge.delete();
          }
        });
        const want = holds(poly);
        if (labels.some((l) => !l.length) || !isValid(shape) || !(Math.abs(volume(shape) - want) <= 0.005 * want + 1e-6))
          throw new FeatureError('invalid-result', 'The turn with a rise did not produce a valid labelled solid.');
        return { shape, faces, labels };
      } catch (e) {
        faces.forEach((f) => f.delete());
        shape.delete();
        throw e;
      }
    };
    done = turned(loops[0], polygons[0]);
    for (let i = 1; i < loops.length; i++) {
      const hole = turned(loops[i], polygons[i]);
      try {
        const next = boolean('cut', done, hole, fid);
        dispose(done);
        done = next;
      } finally {
        dispose(hole);
      }
    }
    return { shape: done.shape, faces: done.faces, labels: done.labels };
  } catch (e) {
    if (done) dispose(done);
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
const SIDES = [
  ['top', [0, 0, 1]],
  ['bottom', [0, 0, -1]],
  ['right', [1, 0, 0]],
  ['left', [-1, 0, 0]],
  ['back', [0, 1, 0]],
  ['front', [0, -1, 0]],
];
/** A box with its faces named by the side they are on. origin: 'base' (the middle of its
 *  bottom face), 'center' or 'corner' (its lowest corner) is at the part's origin. */
export function boxSolid(fid, size, origin = 'base') {
  const { r } = kernel(),
    [x, y, z] = size,
    lo = origin === 'corner' ? [0, 0, 0] : [-x / 2, -y / 2, origin === 'center' ? -z / 2 : 0];
  const shape = r.makeBox(lo, add(lo, size)),
    faces = shape.faces;
  const labels = faces.map((f) => {
    const v = f.normalAt(),
      n = v.toTuple();
    v.delete();
    return [`${fid}/${SIDES.find(([, d]) => dot(d, n) > 0.5)?.[0] ?? 'x'}`];
  });
  return { shape, faces, labels };
}
/** A cylinder along Z. origin: 'base' (the middle of its bottom face) or 'center'. */
export function cylinderSolid(fid, radius, height, origin = 'base') {
  const { r } = kernel(),
    z0 = origin === 'center' ? -height / 2 : 0,
    shape = r.makeCylinder(radius, height, [0, 0, z0], [0, 0, 1]),
    faces = shape.faces;
  const labels = faces.map((f) => {
    if (f.geomType === 'CYLINDRE') return [`${fid}/wall`];
    const p = f.center,
      top = p.toTuple()[2] > z0 + height / 2;
    p.delete();
    return [`${fid}/${top ? 'top' : 'bottom'}`];
  });
  return { shape, faces, labels };
}
/** A sphere. origin: 'base' (its lowest point) or 'center'. */
export function sphereSolid(fid, radius, origin = 'base') {
  const { r } = kernel();
  let shape = r.makeSphere(radius);
  if (origin !== 'center') shape = shape.translate([0, 0, radius]); // deletes the unmoved one
  const faces = shape.faces;
  return { shape, faces, labels: faces.map(() => [`${fid}/surface`]) };
}
/** The raw shape moved by a placement (twelve numbers, core/mat.js). The source stays alive. */
export function movedShape(shape, m) {
  const { OC, r } = kernel(),
    own = scope();
  try {
    const t = own(new OC.gp_Trsf());
    t.SetValues(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11]);
    const loc = own(new OC.TopLoc_Location(t));
    return r.cast(shape.wrapped.Moved(loc, false));
  } finally {
    own.end();
  }
}
/** A labelled body in another place: the same faces in the same order, with the same labels. */
export function placed(body, m) {
  const shape = movedShape(body.shape, m),
    faces = shape.faces;
  if (faces.length !== body.faces.length) {
    faces.forEach((f) => f.delete());
    shape.delete();
    throw new FeatureError('kernel', 'A part could not be placed for the operation.');
  }
  return { shape, faces, labels: body.labels.map((l) => [...l]) };
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

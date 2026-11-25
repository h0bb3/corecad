// Measuring the model: how big a face or an edge is, and how far apart or at what angle two of
// them are. Pure: works on what the kernel reports for a body (its mesh and the tables of its
// faces and edges). A body may have `matrix` (where its part stands): everything here is given
// in space, where the body is seen.
import { placedTopo } from './select.js';
import * as Mat from '../core/mat.js';
import { add, sub, mul, dot, cross, len, unit, dist } from '../core/vec.js';
import { formatNumber } from '../core/num.js';

const EPS = 1e-6;
const fmt = (v) => formatNumber(v, Math.abs(v) >= 100 ? 1 : 2);
const perpendicular = (v) => (Math.abs(v[2]) < 0.9 ? unit(cross(v, [0, 0, 1])) : [1, 0, 0]);

/** The corners of a face: the vertices of its triangles, where the body stands. */
export function facePoints(body, face) {
  const m = body.mesh,
    P = m.positions,
    I = m.indices,
    start = m.faceTris[2 * face],
    end = start + m.faceTris[2 * face + 1],
    seen = new Set(),
    out = [];
  for (let k = start; k < end; k++) {
    const v = I[k];
    if (seen.has(v)) continue;
    seen.add(v);
    const p = [P[3 * v], P[3 * v + 1], P[3 * v + 2]];
    out.push(body.matrix ? Mat.point(body.matrix, p) : p);
  }
  return out;
}

/** The smallest rectangle round points of a plane, trying the given directions: [longer, shorter]. */
function rectangle(points, n, directions) {
  let best = null;
  for (const d of directions) {
    const u = unit(sub(d, mul(n, dot(d, n))));
    if (!Number.isFinite(u[0])) continue;
    const v = cross(n, u);
    let u0 = Infinity,
      u1 = -Infinity,
      v0 = Infinity,
      v1 = -Infinity;
    for (const p of points) {
      const a = dot(p, u),
        b = dot(p, v);
      if (a < u0) u0 = a;
      if (a > u1) u1 = a;
      if (b < v0) v0 = b;
      if (b > v1) v1 = b;
    }
    const w = u1 - u0,
      h = v1 - v0;
    if (!best || w * h < best[0] * best[1] - 1e-9) best = [w, h];
  }
  return best ? [Math.max(...best), Math.min(...best)] : [0, 0];
}

/**
 * How big a face or an edge is.
 * @param {object} body  a built body (BodyOut), with `matrix` when its part is placed
 * @param {'face'|'edge'} kind
 * @param {number} index
 * @returns {object}  `text`: the short answer ("60 × 40 mm", "Hole ⌀ 8 × 12 mm", "R 3", "20 mm"), and the
 *   numbers behind it: a face has `shape` and `area`, with `size` [longer, shorter] for a flat one,
 *   `diameter`, `radius`, `length` and `hole` for a round one; an edge has `curve`, `length`, and
 *   `diameter` or `radius` for a circle or an arc.
 */
export function sizeOf(body, kind, index) {
  const topo = placedTopo(body);
  if (kind === 'edge') {
    const e = topo.edges[index],
      out = { curve: e.kind, length: e.length };
    if (e.circle && e.closed) return { ...out, diameter: 2 * e.circle.r, text: `⌀ ${fmt(2 * e.circle.r)} mm` };
    if (e.circle) return { ...out, radius: e.circle.r, text: `R ${fmt(e.circle.r)} · ${fmt(e.length)} mm long` };
    return { ...out, text: `${fmt(e.length)} mm` };
  }
  const f = topo.faces[index],
    out = { shape: f.kind, area: f.area },
    edges = topo.edges.filter((e) => e.faces.includes(index)),
    points = facePoints(body, index);
  if (f.plane) {
    const round = edges.filter((e) => e.circle && e.closed);
    if (edges.length === 1 && round.length === 1) return { ...out, diameter: 2 * round[0].circle.r, text: `⌀ ${fmt(2 * round[0].circle.r)} mm` };
    const lines = edges.filter((e) => e.kind === 'line').map((e) => sub(e.b, e.a)),
      size = rectangle(points, f.plane.n, [...lines, perpendicular(f.plane.n)]),
      whole = Math.abs(size[0] * size[1] - f.area) <= 0.005 * f.area;
    return { ...out, size, text: `${fmt(size[0])} × ${fmt(size[1])} mm` + (whole ? '' : ` · ${fmt(f.area)} mm²`) };
  }
  if (f.cyl) {
    const along = points.map((p) => dot(p, f.cyl.dir)),
      length = points.length ? Math.max(...along) - Math.min(...along) : 0,
      full = edges.some((e) => e.circle && e.closed),
      r = f.cyl.r;
    if (!full) return { ...out, radius: r, length, text: `R ${fmt(r)} × ${fmt(length)} mm` };
    return { ...out, diameter: 2 * r, length, hole: !f.cyl.convex, text: `${f.cyl.convex ? '' : 'Hole '}⌀ ${fmt(2 * r)} × ${fmt(length)} mm` };
  }
  if (f.sphere) return { ...out, diameter: 2 * f.sphere.r, text: `⌀ ${fmt(2 * f.sphere.r)} mm` };
  return { ...out, text: `${fmt(f.area)} mm²` };
}

/** What a face or an edge is for measuring to: a plane, a line (an edge, or the axis of something round) or a point. */
function primitive(body, kind, index, point) {
  const topo = placedTopo(body);
  if (kind === 'edge') {
    const e = topo.edges[index];
    if (e.circle) return { kind: 'line', p: e.circle.c, dir: unit(e.circle.n), axis: true, at: e.circle.c, name: e.closed ? 'circle' : 'arc' };
    if (e.kind === 'line') return { kind: 'line', p: e.a, dir: unit(sub(e.b, e.a)), at: e.mid, name: 'edge' };
    return { kind: 'point', p: point ?? e.mid, name: 'edge' };
  }
  const f = topo.faces[index];
  if (f.plane) return { kind: 'plane', n: f.plane.n, d: f.plane.d, at: point ?? f.center, name: 'face' };
  if (f.cyl) {
    const p = f.cyl.p,
      dir = unit(f.cyl.dir),
      mid = add(p, mul(dir, dot(sub(f.center, p), dir)));
    return { kind: 'line', p, dir, axis: true, at: mid, name: f.cyl.convex ? 'cylinder' : 'hole' };
  }
  if (f.sphere) return { kind: 'point', p: f.sphere.c, name: 'sphere' };
  return { kind: 'point', p: point ?? f.center, name: 'face' };
}

const degrees = (cosine) => (Math.acos(Math.min(1, Math.max(-1, cosine))) * 180) / Math.PI;
const onLine = (l, q) => add(l.p, mul(l.dir, dot(sub(q, l.p), l.dir)));
const onPlane = (pl, q) => sub(q, mul(pl.n, dot(pl.n, q) - pl.d));

/**
 * Between two picks: how far apart, and at what angle.
 * Each pick is { body, kind: 'face' | 'edge', index, point? } (`point`: where it was clicked, in space).
 * Round things are measured from their axis: two holes give the distance between their centres.
 * @returns {{ distance?: number, angle?: number, from: number[], to: number[], delta: number[], what: string, text: string }}
 *   distance in mm between `from` and `to` (points in space); angle in degrees, 0 to 90, when they are not parallel.
 */
export function between(first, second) {
  let a = primitive(first.body, first.kind, first.index, first.point),
    b = primitive(second.body, second.kind, second.index, second.point);
  const order = { plane: 0, line: 1, point: 2 };
  let swapped = false;
  if (order[a.kind] > order[b.kind]) {
    [a, b] = [b, a];
    swapped = true;
  }
  let from,
    to,
    angle,
    what = `${a.name} to ${b.name}`;
  if (a.kind === 'plane' && b.kind === 'plane') {
    const c = Math.abs(dot(a.n, b.n));
    if (c > 1 - EPS) {
      from = a.at;
      to = onPlane(b, from);
      what = 'between parallel faces';
    } else {
      angle = degrees(c);
      what = 'angle between faces';
    }
  } else if (a.kind === 'plane' && b.kind === 'line') {
    const s = Math.abs(dot(a.n, b.dir));
    if (s < EPS) {
      to = onLine(b, a.at); // the line runs along the face: how far off it
      from = onPlane(a, to);
      what = b.axis ? `${b.name} axis to face` : 'edge to face';
    } else if (s > 1 - EPS && ['hole', 'cylinder'].includes(b.name)) {
      // a hole or a boss standing square on the face: there is no distance to speak of
      angle = 90;
      what = `${b.name} square to face`;
    } else {
      // it meets the face: how far its own place (the centre of a circle, the middle of an edge) is from it
      to = b.at;
      from = onPlane(a, to);
      if (s < 1 - EPS) angle = 90 - degrees(s);
      what = b.axis ? `${b.name} centre to face` : 'edge to face';
    }
  } else if (a.kind === 'plane') {
    to = b.p;
    from = onPlane(a, to);
  } else if (a.kind === 'line' && b.kind === 'line') {
    const c = Math.abs(dot(a.dir, b.dir));
    if (c > 1 - EPS) {
      from = a.at;
      to = onLine(b, from);
      what = a.axis && b.axis ? 'between centres' : a.axis || b.axis ? 'centre to edge' : 'between parallel edges';
    } else {
      // the nearest points of the two lines
      const w = sub(a.p, b.p),
        ab = dot(a.dir, b.dir),
        den = 1 - ab * ab,
        s = (ab * dot(b.dir, w) - dot(a.dir, w)) / den,
        t = (dot(b.dir, w) - ab * dot(a.dir, w)) / den;
      from = add(a.p, mul(a.dir, s));
      to = add(b.p, mul(b.dir, t));
      angle = degrees(c);
      what = a.axis && b.axis ? 'between axes' : a.axis || b.axis ? 'centre to edge' : 'between edges';
    }
  } else if (a.kind === 'line') {
    to = b.p;
    from = onLine(a, to);
  } else {
    from = a.p;
    to = b.p;
  }
  if (swapped && from) [from, to] = [to, from];
  const out = { what };
  if (from) {
    out.distance = dist(from, to);
    out.from = from;
    out.to = to;
    out.delta = sub(to, from);
  }
  if (angle !== undefined) out.angle = angle;
  out.text = [out.distance !== undefined && (out.distance > 1e-7 || angle === undefined) ? `${fmt(out.distance)} mm` : '', angle !== undefined ? `${fmt(angle)}°` : '']
    .filter(Boolean)
    .join(' · ');
  return out;
}

/** Several picks together: the length of the edges and the area of the faces among them. */
export function total(picks) {
  let length = 0,
    area = 0,
    edges = 0,
    faces = 0;
  for (const p of picks) {
    const s = sizeOf(p.body, p.kind, p.index);
    if (p.kind === 'edge') {
      edges++;
      length += s.length;
    } else {
      faces++;
      area += s.area;
    }
  }
  const parts = [];
  if (edges) parts.push(`${edges} ${edges === 1 ? 'edge' : 'edges'} · ${fmt(length)} mm`);
  if (faces) parts.push(`${faces} ${faces === 1 ? 'face' : 'faces'} · ${fmt(area)} mm²`);
  return { edges, faces, length, area, text: parts.join(' · ') };
}

/** The box round bodies where they stand: [[x0, y0, z0], [x1, y1, z1]], or null when there are none. */
export function boxOf(bodies) {
  if (!bodies.length) return null;
  const boxes = bodies.map((b) => (b.matrix ? Mat.box(b.matrix, b.bbox) : b.bbox));
  return [[0, 1, 2].map((i) => Math.min(...boxes.map((b) => b[0][i]))), [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b[1][i])))];
}

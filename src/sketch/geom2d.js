import { at } from './model.js';
export { add2 as add, sub2 as sub, mul2 as mul, dot2 as dot, cross2 as cross, len2 as len, dist2 as dist, unit2 as unit } from '../core/vec.js';
export const TAU = 2 * Math.PI;
export const mod = a => (a % TAU + TAU) % TAU;
export const sweepCCW = (a, b) => mod(b - a) || TAU;
export const angle = (c, p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export function footOnLine(p, a, b, clamp = false) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  if (clamp) t = Math.max(0, Math.min(1, t));
  return { p: [a[0] + t * dx, a[1] + t * dy], t };
}
export function signedDistance(p, a, b) { return ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / (distance(a, b) || 1); }
export function circumcentre(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - a[0], c[1] - a[1]], d = 2 * (u[0] * v[1] - u[1] * v[0]);
  if (Math.abs(d) < 1e-10) return null;
  const u2 = u[0] ** 2 + u[1] ** 2, v2 = v[0] ** 2 + v[1] ** 2;
  return [a[0] + (v[1] * u2 - u[1] * v2) / d, a[1] + (u[0] * v2 - v[0] * u2) / d];
}
export function curvesOf(s, construction = false) {
  return s.entities.filter(e => e.type !== 'point' && (construction || !e.construction)).map(e => {
    if (e.type === 'line') return { entity: e.id, kind: 'line', a: at(s, e.a), b: at(s, e.b) };
    const c = at(s, e.c), a = e.type === 'arc' ? at(s, e.a) : [c[0] + e.r, c[1]], b = e.type === 'arc' ? at(s, e.b) : a;
    return { entity: e.id, kind: e.type, a, b, c, r: distance(c, a), a0: angle(c, a), sweep: e.type === 'circle' ? TAU : sweepCCW(angle(c, a), angle(c, b)) };
  });
}
export function curvePoint(c, t) {
  if (c.kind === 'line') return [c.a[0] + t * (c.b[0] - c.a[0]), c.a[1] + t * (c.b[1] - c.a[1])];
  return [c.c[0] + c.r * Math.cos(c.a0 + c.sweep * t), c.c[1] + c.r * Math.sin(c.a0 + c.sweep * t)];
}
export function parameter(c, p, tol = 1e-6) {
  if (c.kind === 'line') { const f = footOnLine(p, c.a, c.b); return distance(p, f.p) <= tol && f.t >= -tol / distance(c.a, c.b) && f.t <= 1 + tol / distance(c.a, c.b) ? Math.max(0, Math.min(1, f.t)) : null; }
  if (Math.abs(distance(p, c.c) - c.r) > tol) return null;
  let a = mod(angle(c.c, p) - c.a0);
  if (TAU - a < tol / c.r) a = 0;
  return a <= c.sweep + tol / c.r ? Math.min(1, a / c.sweep) : null;
}
export function nearestOnCurve(c, p) {
  if (c.kind === 'line') return footOnLine(p, c.a, c.b, true).p;
  const a = angle(c.c, p), q = [c.c[0] + c.r * Math.cos(a), c.c[1] + c.r * Math.sin(a)];
  if (parameter(c, q) !== null) return q;
  return distance(c.a, p) < distance(c.b, p) ? c.a : c.b;
}
export function intersections(a, b, tol = 1e-6) {
  const out = [];
  if (a.kind === 'line' && b.kind === 'line') {
    const u = [a.b[0] - a.a[0], a.b[1] - a.a[1]], v = [b.b[0] - b.a[0], b.b[1] - b.a[1]], w = [b.a[0] - a.a[0], b.a[1] - a.a[1]], den = u[0] * v[1] - u[1] * v[0];
    if (Math.abs(den) > 1e-12) out.push(curvePoint(a, (w[0] * v[1] - w[1] * v[0]) / den));
  } else if (a.kind === 'line' || b.kind === 'line') {
    const l = a.kind === 'line' ? a : b, c = a.kind === 'line' ? b : a;
    const foot = footOnLine(c.c, l.a, l.b), h2 = c.r ** 2 - distance(foot.p, c.c) ** 2;
    if (h2 >= -tol * c.r) { const dt = Math.sqrt(Math.max(0, h2)) / distance(l.a, l.b); out.push(curvePoint(l, foot.t + dt)); if (dt > 1e-12) out.push(curvePoint(l, foot.t - dt)); }
  } else {
    const d = distance(a.c, b.c);
    if (d > tol && d <= a.r + b.r + tol && d >= Math.abs(a.r - b.r) - tol) {
      const x = (d * d + a.r * a.r - b.r * b.r) / (2 * d), h = Math.sqrt(Math.max(0, a.r * a.r - x * x)), ux = (b.c[0] - a.c[0]) / d, uy = (b.c[1] - a.c[1]) / d;
      out.push([a.c[0] + x * ux - h * uy, a.c[1] + x * uy + h * ux]);
      if (h > tol) out.push([a.c[0] + x * ux + h * uy, a.c[1] + x * uy - h * ux]);
    }
  }
  // Collinear overlap, co-circular arcs and T junctions need endpoint cuts too.
  out.push(a.a, a.b, b.a, b.b);
  return out.filter(p => parameter(a, p, tol) !== null && parameter(b, p, tol) !== null);
}
export function pieceSweep(p) { return p.kind === 'circle' ? (p.ccw === false ? -TAU : TAU) : p.ccw ? sweepCCW(angle(p.c, p.a), angle(p.c, p.b)) : -sweepCCW(angle(p.c, p.b), angle(p.c, p.a)); }
export function pieceMid(p) {
  if (p.kind === 'line') return [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2];
  if (p.kind === 'circle') return [p.c[0] - p.r, p.c[1]];
  const a = angle(p.c, p.a) + pieceSweep(p) / 2, r = distance(p.c, p.a); return [p.c[0] + r * Math.cos(a), p.c[1] + r * Math.sin(a)];
}
export function loopArea(loop) {
  const o = loop[0].a ?? loop[0].c; let sum = 0;
  for (const p of loop) {
    if (p.kind === 'circle') { sum += (p.ccw === false ? -1 : 1) * Math.PI * p.r ** 2; continue; }
    sum += ((p.a[0] - o[0]) * (p.b[1] - o[1]) - (p.b[0] - o[0]) * (p.a[1] - o[1])) / 2;
    if (p.kind === 'arc') { const t = pieceSweep(p); sum += distance(p.c, p.a) ** 2 * (t - Math.sin(t)) / 2; }
  }
  return sum;
}
export function polygonOf(loop, tolerance = .025) {
  const out = [];
  for (const p of loop) {
    if (p.kind === 'line') { out.push(p.a); continue; }
    const r = p.r ?? distance(p.c, p.a), sw = pieceSweep(p), a0 = p.a ? angle(p.c, p.a) : 0;
    const count = Math.max(2, Math.min(4096, Math.ceil(Math.abs(sw) / (2 * Math.acos(Math.max(-1, 1 - tolerance / r))))));
    for (let i = 0; i < count; i++) { const a = a0 + sw * i / count; out.push([p.c[0] + r * Math.cos(a), p.c[1] + r * Math.sin(a)]); }
  }
  return out;
}
/** Exact horizontal-ray winding for circular arcs as well as straight edges. */
export function pointInLoop(q, loop) {
  let winding = 0;
  for (const p of loop) {
    if (p.kind === 'circle') { if (distance(q, p.c) < p.r) winding += p.ccw === false ? -1 : 1; continue; }
    if (p.kind === 'line') {
      const [a, b] = [p.a, p.b];
      if ((a[1] > q[1]) !== (b[1] > q[1]) && a[0] + (q[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]) > q[0]) winding += b[1] > a[1] ? 1 : -1;
      continue;
    }
    const r = distance(p.c, p.a), yy = (q[1] - p.c[1]) / r;
    if (Math.abs(yy) >= 1) continue;
    const sw = pieceSweep(p), a0 = angle(p.c, p.a);
    for (const root of [Math.asin(yy), Math.PI - Math.asin(yy)]) {
      const travel = sw > 0 ? mod(root - a0) : mod(a0 - root), extent = Math.abs(sw), derivative = Math.cos(root) * Math.sign(sw);
      if (p.c[0] + r * Math.cos(root) <= q[0]) continue;
      if (travel > 1e-10 && travel < extent - 1e-10) winding += derivative > 0 ? 1 : -1;
      else if ((travel < 1e-10 || TAU - travel < 1e-10) && derivative > 0) winding++;
      else if (Math.abs(travel - extent) < 1e-10 && derivative < 0) winding--;
    }
  }
  return winding !== 0;
}

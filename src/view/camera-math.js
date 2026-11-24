// Scratch prototype of the pure view maths proposed in .scratch/design/ux-frontend.md (view/camera-math.js).
// ViewState = { target: [x,y,z], quat: [x,y,z,w], dist, fov (degrees, vertical), ortho }
// The camera looks along its own -Z; +X is right, +Y is up (the three.js convention).

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = a => Math.hypot(a[0], a[1], a[2]);
export const unit = a => mul(a, 1 / len(a));

export function qmul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
export function qaxis(axis, angle) { const s = Math.sin(angle / 2); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]; }
export function qrot(q, v) {
  const [x, y, z, w] = q, u = [x, y, z];
  const t = mul(cross(u, v), 2);
  return add(add(v, mul(t, w)), cross(u, t));
}
export function qnorm(q) { const n = Math.hypot(...q); return q.map(v => v / n); }
/** The quaternion of a camera with these right/up/back axes (an orthonormal, right-handed set). */
export function qFromBasis(r, u, b) {
  const m00 = r[0], m10 = r[1], m20 = r[2], m01 = u[0], m11 = u[1], m21 = u[2], m02 = b[0], m12 = b[1], m22 = b[2];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]; }
  return qnorm(q);
}
export const basis = v => ({ right: qrot(v.quat, [1, 0, 0]), up: qrot(v.quat, [0, 1, 0]), back: qrot(v.quat, [0, 0, 1]) });
export const tanHalf = v => Math.tan(v.fov * Math.PI / 360);
export const mmPerPx = (v, vp) => 2 * v.dist * tanHalf(v) / vp.h;
export const eye = v => add(v.target, mul(basis(v).back, v.dist));

/** World point -> [sx, sy, depth]: CSS pixels from the top left of the viewport, depth = distance in front of the eye plane. */
export function project(v, vp, p) {
  const { right, up, back } = basis(v);
  const rel = sub(p, eye(v));
  const z = -dot(rel, back);
  const k = v.ortho ? 1 / mmPerPx(v, vp) : (vp.h / 2) / tanHalf(v) / z;
  return [vp.w / 2 + dot(rel, right) * k, vp.h / 2 - dot(rel, up) * k, z];
}
/** The ray under a pixel: { o, d } with d of unit length. */
export function ray(v, vp, sx, sy) {
  const { right, up, back } = basis(v);
  const e = eye(v);
  if (v.ortho) {
    const m = mmPerPx(v, vp);
    return { o: add(e, add(mul(right, (sx - vp.w / 2) * m), mul(up, -(sy - vp.h / 2) * m))), d: mul(back, -1) };
  }
  const k = tanHalf(v) / (vp.h / 2);
  return { o: e, d: unit(add(mul(back, -1), add(mul(right, (sx - vp.w / 2) * k), mul(up, -(sy - vp.h / 2) * k)))) };
}
/** Turntable orbit about `pivot`: yaw about world Z, pitch about the camera's right axis; the elevation is clamped to +-90 degrees. */
export function orbit(v, dxPx, dyPx, pivot = v.target, radPerPx = Math.PI / 360) {
  const { back } = basis(v);
  const elev = Math.asin(Math.max(-1, Math.min(1, back[2])));          // +90: looking straight down
  let pitch = dyPx * radPerPx;                                          // dragging down raises the camera
  pitch = Math.max(-Math.PI / 2 - elev, Math.min(Math.PI / 2 - elev, pitch));
  const yaw = qaxis([0, 0, 1], -dxPx * radPerPx);
  const q1 = qmul(yaw, v.quat);
  const right1 = qrot(q1, [1, 0, 0]);
  const pq = qaxis(right1, -pitch);
  const quat = qnorm(qmul(pq, q1));
  const turn = p => add(pivot, qrot(pq, qrot(yaw, sub(p, pivot))));
  return { ...v, quat, target: turn(v.target) };
}
export function pan(v, vp, dxPx, dyPx) {
  const { right, up } = basis(v), m = mmPerPx(v, vp);
  return { ...v, target: add(v.target, add(mul(right, -dxPx * m), mul(up, dyPx * m))) };
}
/** Zoom by `factor` (< 1 comes closer) keeping the point of the target plane under (sx, sy) where it is. */
export function zoomAt(v, vp, sx, sy, factor) {
  const { right, up } = basis(v), m = mmPerPx(v, vp);
  const w = add(mul(right, (sx - vp.w / 2) * m), mul(up, -(sy - vp.h / 2) * m));
  return { ...v, dist: v.dist * factor, target: add(v.target, mul(w, 1 - factor)) };
}
/** The affine map of a sketch frame onto the screen, as the six numbers of an SVG matrix(a b c d e f). Orthographic only. */
export function sketchMatrix(v, vp, frame) {
  const { right, up } = basis(v), m = mmPerPx(v, vp);
  const rel = sub(frame.o, v.target);
  return [dot(frame.x, right) / m, -dot(frame.x, up) / m, dot(frame.y, right) / m, -dot(frame.y, up) / m, vp.w / 2 + dot(rel, right) / m, vp.h / 2 - dot(rel, up) / m];
}
export const applyM = (M, [u, w]) => [M[0] * u + M[2] * w + M[4], M[1] * u + M[3] * w + M[5]];
export function invertM(M) {
  const det = M[0] * M[3] - M[1] * M[2];
  const a = M[3] / det, b = -M[1] / det, c = -M[2] / det, d = M[0] / det;
  return [a, b, c, d, -(a * M[4] + c * M[5]), -(b * M[4] + d * M[5])];
}
export const STANDARD = {            // [back (from the target to the eye), up]
  top: [[0, 0, 1], [0, 1, 0]], bottom: [[0, 0, -1], [0, -1, 0]],
  front: [[0, -1, 0], [0, 0, 1]], back: [[0, 1, 0], [0, 0, 1]],
  right: [[1, 0, 0], [0, 0, 1]], left: [[-1, 0, 0], [0, 0, 1]],
  home: [unit([1, -1, 1]), null],
};
export function quatLooking(back, up) {
  const b = unit(back);
  let r = up ? cross(up, b) : cross([0, 0, 1], b);
  r = unit(r);
  return qFromBasis(r, cross(b, r), b);
}

// ---- added for the numbers of the design's test list (10.1)
export function fitSphere(v, vp, centre, radius, margin = 1.15) {
  const th = Math.min(v.fov * Math.PI / 360, Math.atan(tanHalf(v) * vp.w / vp.h));
  return { ...v, target: centre, dist: radius * margin / Math.sin(th) };
}
export function fitInPlane(v, vp, frame, box, margin = 1.25) {
  const [[u0, v0], [u1, v1]] = box;
  const H = Math.max(v1 - v0, (u1 - u0) / (vp.w / vp.h)) * margin;
  const c = [(u0 + u1) / 2, (v0 + v1) / 2];
  return { ...v, dist: H / (2 * tanHalf(v)), target: add(frame.o, add(mul(frame.x, c[0]), mul(frame.y, c[1]))) };
}
export const lookAtFrame = (v, frame) => ({ ...v, quat: qFromBasis(frame.x, frame.y, frame.n) });
export const tiltOf = (M, v, vp) => Math.abs(M[0] * M[3] - M[1] * M[2]) * mmPerPx(v, vp) ** 2;
export function planePoint(v, vp, sx, sy, frame) {
  const r = ray(v, vp, sx, sy), dn = dot(r.d, frame.n);
  if (Math.abs(dn) < Math.sin(3 * Math.PI / 180)) return null;
  const t = dot(sub(frame.o, r.o), frame.n) / dn, p = sub(add(r.o, mul(r.d, t)), frame.o);
  return [dot(p, frame.x), dot(p, frame.y)];
}
export function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = b.map(x => -x); d = -d; }
  if (d > 0.9995) return qnorm(a.map((x, i) => x + (b[i] - x) * t));
  const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((x, i) => x * wa + b[i] * wb);
}
export function tween(a, b, t) {
  return { ...b, target: add(a.target, mul(sub(b.target, a.target), t)), quat: slerp(a.quat, b.quat, t), dist: a.dist * Math.pow(b.dist / a.dist, t) };
}

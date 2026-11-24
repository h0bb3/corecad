// Small vector helpers. Pure; no allocation tricks: these are for clarity, not for inner loops.
// 3D vectors are [x, y, z], 2D vectors [x, y], quaternions [x, y, z, w], Mat23 is [a, b, c, d, e, f]
// with the meaning of SVG's matrix(a b c d e f): sx = a u + c v + e, sy = b u + d v + f.

// ---- 3D
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = a => Math.hypot(a[0], a[1], a[2]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Unit length; a zero vector stays zero (no NaN). */
export const unit = a => { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---- 2D
export const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const mul2 = (a, s) => [a[0] * s, a[1] * s];
export const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
/** The z of the 3D cross product: positive when b is counter-clockwise of a. */
export const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0];
export const len2 = a => Math.hypot(a[0], a[1]);
export const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const unit2 = a => { const l = len2(a); return l > 0 ? [a[0] / l, a[1] / l] : [0, 0]; };
/** a turned a quarter turn counter-clockwise. */
export const perp2 = a => [-a[1], a[0]];
export const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// ---- quaternions [x, y, z, w]
export function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
/** The rotation by `angle` (radians, right-handed) about the unit vector `axis`. */
export function qaxis(axis, angle) {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}
/** The vector v turned by the unit quaternion q. */
export function qrot(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
export function qnorm(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

// ---- Mat23
export const applyM = (M, p) => [M[0] * p[0] + M[2] * p[1] + M[4], M[1] * p[0] + M[3] * p[1] + M[5]];
/** The inverse map; throws when the matrix is singular (a plane seen exactly edge-on). */
export function invertM(M) {
  const det = M[0] * M[3] - M[1] * M[2];
  if (!(Math.abs(det) > 1e-300)) throw new Error('invertM: the matrix is singular');
  const a = M[3] / det, b = -M[1] / det, c = -M[2] / det, d = M[0] / det;
  return [a, b, c, d, -(a * M[4] + c * M[5]), -(b * M[4] + d * M[5])];
}

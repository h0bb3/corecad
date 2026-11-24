// The frame of a sketch plane. One rule for the three origin planes and for faces: the frame is a
// function of the plane alone (never of a face's outline), so a sketch cannot jump when the face
// it lies on changes shape.
//   origin o = the world origin dropped perpendicularly onto the plane
//   x      = Z x n, horizontal (world X when the plane itself is horizontal)
//   y      = n x x, pointing up as far as the plane allows
import { add, mul, dot, cross, len, unit, sub } from './vec.js';

/** @typedef {import('../types.js').Frame} Frame */

/** The frame of the plane { p : n . p = d }. n need not be unit length; d is taken for the unit normal.
 *  @param {number[]} n @param {number} d @returns {Frame} */
export function canonicalFrame(n, d) {
  n = unit(n);
  let x = cross([0, 0, 1], n);
  x = len(x) < 1e-6 ? [1, 0, 0] : unit(x);
  return { o: mul(n, d), x, y: cross(n, x), n };
}

/** The plane of an origin plane: 'XY' (top), 'XZ' (front, normal -Y), 'YZ' (right, normal +X).
 *  @param {'XY'|'XZ'|'YZ'} name @returns {{ n: number[], d: number }} */
export function basePlane(name) {
  const n = { XY: [0, 0, 1], XZ: [0, -1, 0], YZ: [1, 0, 0] }[name];
  if (!n) throw new Error(`basePlane: unknown plane "${name}"`);
  return { n, d: 0 };
}

/** Plane coordinates (u, v) and a height t above the plane, to world. */
export const toWorld = (frame, uv, t = 0) =>
  add(add(frame.o, add(mul(frame.x, uv[0]), mul(frame.y, uv[1]))), mul(frame.n, t));

/** World to [u, v, t]. */
export function toLocal(frame, p) {
  const r = sub(p, frame.o);
  return [dot(r, frame.x), dot(r, frame.y), dot(r, frame.n)];
}

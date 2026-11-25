// Where a part stands: a rigid placement (a rotation and a translation, never a scale or a
// mirror), as twelve numbers in row order:
//   [ r00 r01 r02 tx   r10 r11 r12 ty   r20 r21 r22 tz ]
// A point p of the part is at  R p + t  in the frame the placement is given in.
//
// In the document a placement is { pos: [x, y, z], rot: [rx, ry, rz] }: millimetres, and degrees
// about the fixed X, then Y, then Z axis (R = Rz Ry Rx). That is what a person types; the
// matrices here are what is computed with.

/** @typedef {number[]} Mat  twelve numbers, as above */

export const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);

const RAD = Math.PI / 180;
/** Cosine and sine of an angle in degrees, exact at the quarter turns. */
function cosSin(deg) {
  const a = ((deg % 360) + 360) % 360;
  if (a === 0) return [1, 0];
  if (a === 90) return [0, 1];
  if (a === 180) return [-1, 0];
  if (a === 270) return [0, -1];
  return [Math.cos(a * RAD), Math.sin(a * RAD)];
}

/** The matrix of { pos, rot }. @returns {Mat} */
export function fromPlacement(pos = [0, 0, 0], rot = [0, 0, 0]) {
  const [cx, sx] = cosSin(rot[0]),
    [cy, sy] = cosSin(rot[1]),
    [cz, sz] = cosSin(rot[2]);
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, pos[0],
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, pos[1],
    -sy, cy * sx, cy * cx, pos[2],
  ];
}

const tidy = (v, digits = 9) => {
  const r = +v.toFixed(digits);
  return r === 0 ? 0 : r; // never -0
};

/** { pos, rot } of a matrix, rounded to what a file should hold. At ry = ±90° (where rx and rz
 *  turn about the same axis) rz is given as 0. */
export function toPlacement(m) {
  const sy = -m[8];
  let rx, ry, rz;
  if (Math.abs(sy) < 1 - 1e-12) {
    ry = Math.asin(sy);
    rx = Math.atan2(m[9], m[10]);
    rz = Math.atan2(m[4], m[0]);
  } else {
    ry = sy > 0 ? Math.PI / 2 : -Math.PI / 2;
    rz = 0;
    rx = Math.atan2(-m[6], m[5]);
  }
  return {
    pos: [tidy(m[3]), tidy(m[7]), tidy(m[11])],
    rot: [tidy(rx / RAD, 7), tidy(ry / RAD, 7), tidy(rz / RAD, 7)],
  };
}

/** a after b: the placement that does b first. */
export function mul(a, b) {
  const out = new Array(12);
  for (let i = 0; i < 3; i++) {
    const r = i * 4;
    for (let j = 0; j < 3; j++) out[r + j] = a[r] * b[j] + a[r + 1] * b[4 + j] + a[r + 2] * b[8 + j];
    out[r + 3] = a[r] * b[3] + a[r + 1] * b[7] + a[r + 2] * b[11] + a[r + 3];
  }
  return out;
}

/** The placement that undoes m. */
export function invert(m) {
  const t = [m[3], m[7], m[11]];
  const out = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0];
  for (let i = 0; i < 3; i++) out[i * 4 + 3] = -(out[i * 4] * t[0] + out[i * 4 + 1] * t[1] + out[i * 4 + 2] * t[2]);
  return out;
}

/** A point moved by m. */
export const point = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];

/** A direction turned by m. */
export const dir = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
  m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
];

/** A plane frame { o, x, y, n } moved by m. */
export const frame = (m, f) => ({ o: point(m, f.o), x: dir(m, f.x), y: dir(m, f.y), n: dir(m, f.n) });

export const isIdentity = (m, eps = 1e-12) => m.every((v, i) => Math.abs(v - IDENTITY[i]) <= eps);

/** A turn of `deg` degrees about the axis through `pivot` along the unit vector `axis`. */
export function turn(axis, deg, pivot = [0, 0, 0]) {
  const [c, s] = cosSin(deg),
    [x, y, z] = axis,
    t = 1 - c;
  const r = [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0,
  ];
  const moved = dir(r, pivot);
  r[3] = pivot[0] - moved[0];
  r[7] = pivot[1] - moved[1];
  r[11] = pivot[2] - moved[2];
  return r;
}

/** A move by v. */
export const shift = (v) => [1, 0, 0, v[0], 0, 1, 0, v[1], 0, 0, 1, v[2]];

/** The box [[x0, y0, z0], [x1, y1, z1]] round a box moved by m. */
export function box(m, b) {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = point(m, [b[i & 1][0], b[(i >> 1) & 1][1], b[(i >> 2) & 1][2]]);
    for (let k = 0; k < 3; k++) {
      if (p[k] < lo[k]) lo[k] = p[k];
      if (p[k] > hi[k]) hi[k] = p[k];
    }
  }
  return [lo, hi];
}

/** The sixteen numbers three.js wants for Matrix4.fromArray (column order). */
export const toColumns16 = (m) => [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, m[3], m[7], m[11], 1];

/** Text that is the same for placements that are the same to within what matters to the kernel. */
export const key = (m) => m.map((v) => tidy(v, 9)).join(',');

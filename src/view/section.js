// Looking inside: the model cut open along a plane square to an axis. It changes what is drawn and
// what can be pointed at, never the model. Pure: numbers in, numbers out.
import { dot } from './camera-math.js';

/** The planes a section can lie along, with the axis each is square to (0 x, 1 y, 2 z). */
export const SECTION_PLANES = { XY: 2, XZ: 1, YZ: 0 };
const AXES = 'xyz';
const tidy = (v) => Math.round(v * 1000) / 1000;

/**
 * A section as it is given: { plane: 'XY' | 'XZ' | 'YZ', at: number, flip: boolean }.
 * `at` is where the plane is along its axis (z for XY). Without `flip` what lies beyond it (above
 * z = at) is taken away; with it, what lies before it.
 * @returns the section with its three members, or throws what is wrong with it
 */
export function checkSection(s) {
  const plane = typeof s?.plane === 'string' ? s.plane.toUpperCase() : s?.plane;
  if (!(plane in SECTION_PLANES)) throw Error('"plane" is "XY", "XZ" or "YZ".');
  if (!Number.isFinite(s.at)) throw Error('"at" is a number of millimetres along the axis of the plane.');
  return { plane, at: tidy(s.at), flip: !!s.flip };
}

/** The axis a section's plane is square to: 'x', 'y' or 'z'. */
export const sectionAxis = (section) => AXES[SECTION_PLANES[section.plane]];

/** The half of space that stays: every point p with dot(n, p) <= d. */
export function halfSpace(section) {
  const n = [0, 0, 0];
  n[SECTION_PLANES[section.plane]] = section.flip ? -1 : 1;
  return { n, d: section.flip ? -section.at : section.at };
}

/** A section in words, for a person and for an agent. */
export const sectionText = (section) =>
  `cut along ${section.plane} at ${sectionAxis(section)} = ${tidy(section.at)} mm: everything with ${sectionAxis(section)} ${section.flip ? 'below' : 'above'} that is taken away`;

/** The half space in the frame of something that stands at m (twelve numbers, row order; a rigid placement). */
export function halfSpaceIn(half, m) {
  if (!m) return half;
  // A point q of the frame is at R q + t: n.(R q + t) <= d is (R' n).q <= d - n.t.
  const n = half.n;
  return {
    n: [m[0] * n[0] + m[4] * n[1] + m[8] * n[2], m[1] * n[0] + m[5] * n[1] + m[9] * n[2], m[2] * n[0] + m[6] * n[1] + m[10] * n[2]],
    d: half.d - (n[0] * m[3] + n[1] * m[7] + n[2] * m[11]),
  };
}

/** The stretch of a ray (o + t d, t >= 0) that lies in the half that stays: [t0, t1], t1 maybe Infinity; null when none of it does. */
export function rayRange(half, ray) {
  const a = dot(half.n, ray.d),
    b = half.d - dot(half.n, ray.o); // stays where a t <= b
  if (Math.abs(a) < 1e-12) return b >= 0 ? [0, Infinity] : null;
  const t = b / a;
  if (a > 0) return t > 0 ? [0, t] : null;
  return [Math.max(0, t), Infinity];
}

/**
 * Where the triangles of a mesh cross the plane of a half space given in the mesh's own frame: the
 * outline of the cut, as line segments (six numbers each).
 * @returns {Float32Array}
 */
export function cutOutline(mesh, half) {
  const P = mesh.positions,
    I = mesh.indices,
    [nx, ny, nz] = half.n,
    out = [];
  const side = (v) => nx * P[v] + ny * P[v + 1] + nz * P[v + 2] - half.d;
  for (let k = 0; k < I.length; k += 3) {
    const v = [I[k] * 3, I[k + 1] * 3, I[k + 2] * 3],
      s = v.map(side),
      above = s.map((x) => x > 0);
    if (above[0] === above[1] && above[1] === above[2]) continue;
    for (let e = 0; e < 3; e++) {
      const a = e,
        b = (e + 1) % 3;
      if (above[a] === above[b]) continue;
      const t = s[a] / (s[a] - s[b]);
      out.push(P[v[a]] + (P[v[b]] - P[v[a]]) * t, P[v[a] + 1] + (P[v[b] + 1] - P[v[a] + 1]) * t, P[v[a] + 2] + (P[v[b] + 2] - P[v[a] + 2]) * t);
    }
  }
  return new Float32Array(out);
}

/** How far a set of boxes reaches along the axis of a plane: [lowest, highest], or null when there are none. */
export function reachAlong(plane, boxes) {
  const axis = SECTION_PLANES[plane];
  if (!boxes.length) return null;
  return [Math.min(...boxes.map((b) => b[0][axis])), Math.max(...boxes.map((b) => b[1][axis]))];
}

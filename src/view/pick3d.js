// Pure mesh pickers. No three.js or DOM dependency.
import { project } from './camera-math.js';

/** Built once per mesh: which face a triangle belongs to, and a box round every face. */
export function buildPickData(mesh) {
  const nTri = mesh.indices.length / 3,
    nFace = mesh.faceTris.length / 2;
  const triFace = new Uint32Array(nTri),
    box = new Float32Array(nFace * 6);
  const P = mesh.positions,
    I = mesh.indices;
  for (let f = 0; f < nFace; f++) {
    const start = mesh.faceTris[2 * f],
      count = mesh.faceTris[2 * f + 1];
    let x0 = Infinity,
      y0 = Infinity,
      z0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity,
      z1 = -Infinity;
    for (let k = start; k < start + count; k++) {
      if (k % 3 === 0) triFace[k / 3] = f;
      const v = I[k] * 3,
        x = P[v],
        y = P[v + 1],
        z = P[v + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    box.set([x0, y0, z0, x1, y1, z1], f * 6);
  }
  return { triFace, box };
}

/** The first face a ray meets: { face, t, point } or null. Both sides of a triangle count. */
export function pickFace(mesh, pd, ray, tMax = Infinity) {
  const P = mesh.positions,
    I = mesh.indices,
    B = pd.box;
  const ox = ray.o[0],
    oy = ray.o[1],
    oz = ray.o[2],
    dx = ray.d[0],
    dy = ray.d[1],
    dz = ray.d[2];
  const ix = 1 / dx,
    iy = 1 / dy,
    iz = 1 / dz,
    PAD = 1e-6;
  let best = tMax,
    bestFace = -1;
  const nFace = mesh.faceTris.length / 2;
  for (let f = 0; f < nFace; f++) {
    const b = f * 6; // slab test against the face's box
    let t0 = (B[b] - PAD - ox) * ix,
      t1 = (B[b + 3] + PAD - ox) * ix;
    if (t0 > t1) {
      const s = t0;
      t0 = t1;
      t1 = s;
    }
    let u0 = (B[b + 1] - PAD - oy) * iy,
      u1 = (B[b + 4] + PAD - oy) * iy;
    if (u0 > u1) {
      const s = u0;
      u0 = u1;
      u1 = s;
    }
    let w0 = (B[b + 2] - PAD - oz) * iz,
      w1 = (B[b + 5] + PAD - oz) * iz;
    if (w0 > w1) {
      const s = w0;
      w0 = w1;
      w1 = s;
    }
    const near = Math.max(t0, u0, w0),
      far = Math.min(t1, u1, w1);
    if (!(near <= far) || far < 0 || near > best) continue; // also false when NaN (a ray inside a slab plane): then test the triangles
    const start = mesh.faceTris[2 * f],
      end = start + mesh.faceTris[2 * f + 1];
    for (let k = start; k < end; k += 3) {
      const a = I[k] * 3,
        bb = I[k + 1] * 3,
        c = I[k + 2] * 3;
      const e1x = P[bb] - P[a],
        e1y = P[bb + 1] - P[a + 1],
        e1z = P[bb + 2] - P[a + 2];
      const e2x = P[c] - P[a],
        e2y = P[c + 1] - P[a + 1],
        e2z = P[c + 2] - P[a + 2];
      const px = dy * e2z - dz * e2y,
        py = dz * e2x - dx * e2z,
        pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-12 && det < 1e-12) continue;
      const inv = 1 / det,
        tx = ox - P[a],
        ty = oy - P[a + 1],
        tz = oz - P[a + 2];
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y,
        qy = tz * e1x - tx * e1z,
        qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > 1e-9 && t < best) {
        best = t;
        bestFace = f;
      }
    }
  }
  return bestFace < 0
    ? null
    : { face: bestFace, t: best, point: [ox + dx * best, oy + dy * best, oz + dz * best] };
}

/** Every point of the edge lines on the screen: [sx, sy, depth] each. Made again when the camera or the mesh changes.
 *  m: where the mesh stands (twelve numbers, core/mat.js), or nothing when it stands at the origin. */
export function projectEdges(mesh, view, vp, m = null) {
  const L = mesh.edgeLines,
    out = new Float32Array(L.length);
  for (let i = 0; i < L.length; i += 3) {
    const x = L[i],
      y = L[i + 1],
      z = L[i + 2];
    const s = project(
      view,
      vp,
      m ? [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]] : [x, y, z]
    );
    out[i] = s[0];
    out[i + 1] = s[1];
    out[i + 2] = s[2];
  }
  return out;
}

/** The edge nearest to a pixel within tolPx: { edge, distPx, point: [x,y,z], depth } or null. No occlusion test here.
 *  half: a half space in the mesh's frame ({ n, d }, see section.js); what is outside it cannot be taken. */
export function pickEdge(mesh, proj, sx, sy, tolPx, half = null) {
  let best = tolPx * tolPx,
    hit = null;
  const nEdge = mesh.edgeSegs.length / 2,
    L = mesh.edgeLines;
  for (let e = 0; e < nEdge; e++) {
    const start = mesh.edgeSegs[2 * e],
      count = mesh.edgeSegs[2 * e + 1];
    for (let p = start; p < start + count; p += 2) {
      const a = p * 3,
        b = a + 3;
      const ax = proj[a],
        ay = proj[a + 1],
        ux = proj[b] - ax,
        uy = proj[b + 1] - ay;
      const uu = ux * ux + uy * uy;
      let t = uu > 0 ? ((sx - ax) * ux + (sy - ay) * uy) / uu : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + ux * t - sx,
        ey = ay + uy * t - sy,
        d2 = ex * ex + ey * ey;
      if (d2 < best) {
        if (half) {
          const x = L[a] + (L[b] - L[a]) * t,
            y = L[a + 1] + (L[b + 1] - L[a + 1]) * t,
            z = L[a + 2] + (L[b + 2] - L[a + 2]) * t;
          if (half.n[0] * x + half.n[1] * y + half.n[2] * z > half.d + 1e-6) continue;
        }
        best = d2;
        hit = {
          edge: e,
          distPx: Math.sqrt(d2),
          depth: proj[a + 2] + (proj[b + 2] - proj[a + 2]) * t,
          point: [
            L[a] + (L[b] - L[a]) * t,
            L[a + 1] + (L[b + 1] - L[a + 1]) * t,
            L[a + 2] + (L[b + 2] - L[a + 2]) * t,
          ],
        };
      }
    }
  }
  return hit;
}

/** How many times a ray passes through the surface of a mesh between t0 and t1. A closed solid is
 *  passed an odd number of times from a point inside it. */
export function countHits(mesh, pd, ray, t0 = 0, t1 = Infinity) {
  const P = mesh.positions,
    I = mesh.indices,
    B = pd.box;
  const ox = ray.o[0],
    oy = ray.o[1],
    oz = ray.o[2],
    dx = ray.d[0],
    dy = ray.d[1],
    dz = ray.d[2];
  const ix = 1 / dx,
    iy = 1 / dy,
    iz = 1 / dz,
    PAD = 1e-6;
  let count = 0;
  const nFace = mesh.faceTris.length / 2;
  for (let f = 0; f < nFace; f++) {
    const b = f * 6; // slab test against the face's box, as in pickFace
    let a0 = (B[b] - PAD - ox) * ix,
      a1 = (B[b + 3] + PAD - ox) * ix;
    if (a0 > a1) [a0, a1] = [a1, a0];
    let u0 = (B[b + 1] - PAD - oy) * iy,
      u1 = (B[b + 4] + PAD - oy) * iy;
    if (u0 > u1) [u0, u1] = [u1, u0];
    let w0 = (B[b + 2] - PAD - oz) * iz,
      w1 = (B[b + 5] + PAD - oz) * iz;
    if (w0 > w1) [w0, w1] = [w1, w0];
    const near = Math.max(a0, u0, w0),
      far = Math.min(a1, u1, w1);
    if (!(near <= far) || far < t0 || near > t1) continue;
    const start = mesh.faceTris[2 * f],
      end = start + mesh.faceTris[2 * f + 1];
    for (let k = start; k < end; k += 3) {
      const a = I[k] * 3,
        bb = I[k + 1] * 3,
        c = I[k + 2] * 3;
      const e1x = P[bb] - P[a],
        e1y = P[bb + 1] - P[a + 1],
        e1z = P[bb + 2] - P[a + 2];
      const e2x = P[c] - P[a],
        e2y = P[c + 1] - P[a + 1],
        e2z = P[c + 2] - P[a + 2];
      const px = dy * e2z - dz * e2y,
        py = dz * e2x - dx * e2z,
        pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-12 && det < 1e-12) continue;
      const inv = 1 / det,
        tx = ox - P[a],
        ty = oy - P[a + 1],
        tz = oz - P[a + 2];
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y,
        qy = tz * e1x - tx * e1z,
        qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > t0 && t < t1) count++;
    }
  }
  return count;
}

// What a person clicks in a view of a drawing: the faces and edges of the part as lines and circles on the
// paper, and the one nearest the pointer. Pure. A flat face seen from its side is a line, as a round face
// seen along its axis is a circle; an edge is a line or a circle where it lies flat in the view. Faces are
// preferred to the edges that lie along them (two parallel faces are what a size is usually between), and
// of two things in the same place on the paper the one nearer the eye.
import { placedTopo } from '../api/select.js';
import { facePoints } from '../api/measure3d.js';
import { add, sub, mul, dot, cross, unit } from '../core/vec.js';

const E = 1e-6;

/**
 * The things of the bodies that can be clicked in a view.
 * @param {object[]} bodies  shown bodies of the part, each with `matrix`
 * @param {{ x: number[], y: number[], n: number[] }} ax  the directions of the view (viewAxes)
 * @param {(p: number[]) => number[]} toPaper  a point in space to the paper
 * @param {{ n: number[], c: number } | null} [cut]  of a section: what lies on the eye's side of its plane is not there
 * @returns {{ body: string, kind: 'face' | 'edge', index: number, rank: number, depth: number, pts?: number[][], circle?: { c: number[], r: number } }[]}
 */
export function clickables(bodies, ax, toPaper, cut = null) {
  const N = ax.n,
    all = [],
    out = { push: (t) => (!cut || (t.low ?? t.depth) <= cut.c + 1e-6 ? all.push(t) : 0) };
  for (const body of bodies) {
    if (body.instance || String(body.id).includes('~')) continue; // a linked copy is measured on its original
    const topo = placedTopo(body);
    topo.faces.forEach((f, index) => {
      const base = { body: body.id, kind: 'face', index, rank: 0, depth: dot(f.center, N), low: Math.min(...facePoints(body, index).map((p) => dot(p, N))) };
      if (f.plane && Math.abs(dot(f.plane.n, N)) < E) {
        const e = unit(cross(N, f.plane.n)),
          pts = facePoints(body, index);
        if (!pts.length) return;
        let lo = pts[0],
          hi = pts[0];
        for (const p of pts) {
          if (dot(p, e) < dot(lo, e)) lo = p;
          if (dot(p, e) > dot(hi, e)) hi = p;
        }
        out.push({ ...base, pts: [toPaper(lo), toPaper(hi)] });
      } else if (f.cyl && topo.edges.some((x) => x.faces.includes(index) && x.circle && x.closed)) {
        const dir = unit(f.cyl.dir),
          along = facePoints(body, index).map((p) => dot(p, dir)),
          on = (t) => add(f.cyl.p, mul(dir, t - dot(f.cyl.p, dir)));
        if (!along.length) return;
        const t0 = Math.min(...along),
          t1 = Math.max(...along);
        if (Math.abs(dot(dir, N)) > 1 - E) {
          const c = toPaper(on((t0 + t1) / 2)),
            rim = toPaper(add(on(t0), mul(ax.x, f.cyl.r)));
          out.push({ ...base, circle: { c, r: Math.hypot(rim[0] - c[0], rim[1] - c[1]) } });
        } else if (Math.abs(dot(dir, N)) < E) {
          // its outline from the side: two lines along the axis
          const s = mul(unit(cross(dir, N)), f.cyl.r);
          for (const side of [s, mul(s, -1)]) out.push({ ...base, pts: [toPaper(add(on(t0), side)), toPaper(add(on(t1), side))] });
        }
      }
    });
    topo.edges.forEach((e, index) => {
      if (e.seam || e.faces.length !== 2) return;
      const base = { body: body.id, kind: 'edge', index, rank: 1, depth: dot(e.mid, N), low: e.circle ? dot(e.circle.c, N) - e.circle.r : Math.min(dot(e.a, N), dot(e.b, N)) };
      if (e.circle) {
        const n = unit(e.circle.n);
        if (Math.abs(dot(n, N)) > 1 - E) {
          const c = toPaper(e.circle.c),
            rim = toPaper(add(e.circle.c, mul(ax.x, e.circle.r)));
          out.push({ ...base, circle: { c, r: Math.hypot(rim[0] - c[0], rim[1] - c[1]) } });
        } else if (Math.abs(dot(n, N)) < E && e.closed) {
          const s = mul(unit(cross(n, N)), e.circle.r);
          out.push({ ...base, pts: [toPaper(sub(e.circle.c, s)), toPaper(add(e.circle.c, s))] });
        }
      } else if (e.kind === 'line' && Math.abs(dot(unit(sub(e.b, e.a)), N)) < E) out.push({ ...base, pts: [toPaper(e.a), toPaper(e.b)] });
    });
  }
  return all;
}

/** How far a point of the paper is from a clickable thing. */
export function distanceTo(thing, q) {
  if (thing.circle) return Math.abs(Math.hypot(q[0] - thing.circle.c[0], q[1] - thing.circle.c[1]) - thing.circle.r);
  const [a, b] = thing.pts,
    d = [b[0] - a[0], b[1] - a[1]],
    l2 = d[0] * d[0] + d[1] * d[1],
    t = l2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1]) / l2)) : 0;
  return Math.hypot(q[0] - a[0] - t * d[0], q[1] - a[1] - t * d[1]);
}

/** The thing at a point of the paper, within `tolerance` mm: or null. */
export function thingAt(things, q, tolerance) {
  const near = things.map((t) => ({ t, d: distanceTo(t, q) })).filter((x) => x.d <= tolerance);
  if (!near.length) return null;
  const best = Math.min(...near.map((x) => x.d)),
    close = near.filter((x) => x.d <= best + Math.min(0.3, tolerance / 3));
  close.sort((a, b) => a.t.rank - b.t.rank || b.t.depth - a.t.depth);
  return close[0].t;
}

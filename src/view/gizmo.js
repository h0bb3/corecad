// What a part is placed by in the view: three arrows to drag it along, three rings to turn it by.
// Pure: camera mathematics in, numbers and canvas strokes out.
import { project, ray, mmPerPx, basis, add, sub, mul, dot, cross, len, unit } from './camera-math.js';

export const AXIS_COLORS = ['#c56462', '#469477', '#4c8ec1'];
const NAMES = 'XYZ';

/** Where the arrows are on the screen. anchor: a point in space; axes: three unit vectors.
 *  @returns {{ axis: number, a: number[], b: number[], dir: number[] }[]}  a, b in CSS pixels */
export function gizmoArrows(view, vp, anchor, axes, lengthPx = 76) {
  const length = lengthPx * mmPerPx(view, vp),
    a = project(view, vp, anchor);
  return axes.map((dir, axis) => ({ axis, dir, a, b: project(view, vp, add(anchor, mul(dir, length))) }));
}

/** The arrow under a pixel (its axis number), or -1. An arrow seen end-on cannot be taken hold of. */
export function hitArrow(arrows, x, y, tol = 10) {
  let best = tol,
    hit = -1;
  for (const { axis, a, b } of arrows) {
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uu = ux * ux + uy * uy;
    if (uu < 15 * 15) continue;
    // the outer three quarters: the middle belongs to all three
    const t = Math.max(0.25, Math.min(1.08, ((x - a[0]) * ux + (y - a[1]) * uy) / uu)),
      d = Math.hypot(a[0] + ux * t - x, a[1] + uy * t - y);
    if (d < best) {
      best = d;
      hit = axis;
    }
  }
  return hit;
}

/** How far along the line anchor + s * dir the pixel points: the s of the point of that line
 *  nearest to the ray through the pixel. null when the line runs straight at the eye. */
export function alongAxis(view, vp, anchor, dir, x, y) {
  const r = ray(view, vp, x, y),
    w = sub(anchor, r.o),
    b = dot(dir, r.d),
    den = 1 - b * b;
  if (den < 1e-6) return null;
  return (b * dot(r.d, w) - dot(dir, w)) / den;
}

/**
 * The rings: a circle round the anchor square to each axis. Turning about an axis is dragging its ring.
 * @returns {{ axis: number, dir: number[], e1: number[], e2: number[], radius: number, facing: number,
 *             points: number[][] }[]}
 *   e1, e2: unit vectors of the ring's plane with e1 x e2 = dir, so that the point at angle t is
 *   anchor + radius (cos t e1 + sin t e2) and a turn about dir by t moves the point at 0 there.
 *   radius in mm. facing: how squarely the ring is seen, 0 (edge-on) to 1. points: [sx, sy, t] round it.
 */
export function gizmoRings(view, vp, anchor, axes, radiusPx = 98, n = 72) {
  const radius = radiusPx * mmPerPx(view, vp),
    back = basis(view).back;
  return axes.map((dir, axis) => {
    let e1 = cross(dir, Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]);
    e1 = unit(e1);
    const e2 = cross(dir, e1),
      points = [];
    for (let i = 0; i <= n; i++) {
      const t = (2 * Math.PI * i) / n,
        s = project(view, vp, add(anchor, add(mul(e1, radius * Math.cos(t)), mul(e2, radius * Math.sin(t)))));
      points.push([s[0], s[1], t]);
    }
    return { axis, dir, e1, e2, radius, facing: Math.abs(dot(dir, back)), points };
  });
}

/** The ring under a pixel: { axis, t } with t the angle of the nearest point of it, or null. */
export function hitRing(rings, x, y, tol = 8) {
  let best = tol,
    hit = null;
  for (const r of rings)
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i],
        b = r.points[i + 1],
        ux = b[0] - a[0],
        uy = b[1] - a[1],
        uu = ux * ux + uy * uy,
        k = uu > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ux + (y - a[1]) * uy) / uu)) : 0,
        d = Math.hypot(a[0] + ux * k - x, a[1] + uy * k - y);
      if (d < best) {
        best = d;
        hit = { axis: r.axis, t: a[2] + (b[2] - a[2]) * k };
      }
    }
  return hit;
}

/**
 * The angle (radians) a pixel points at on a ring's plane, measured as the ring's points are; null
 * when the ring is seen too nearly edge-on for that to mean anything.
 */
export function ringAngle(view, vp, ring, anchor, x, y) {
  const r = ray(view, vp, x, y),
    along = dot(r.d, ring.dir);
  if (Math.abs(along) < 0.3) return null;
  const hit = add(r.o, mul(r.d, dot(sub(anchor, r.o), ring.dir) / along)),
    v = sub(hit, anchor);
  return Math.atan2(dot(v, ring.e2), dot(v, ring.e1));
}

/** Which way on the screen the ring runs at angle t (a unit vector in pixels), for a ring seen edge-on:
 *  dragging along it by the ring's radius in pixels is a turn of one radian. */
export function ringTangent(view, vp, ring, anchor, t) {
  const at = (u) => project(view, vp, add(anchor, add(mul(ring.e1, ring.radius * Math.cos(u)), mul(ring.e2, ring.radius * Math.sin(u))))),
    a = at(t - 0.02),
    b = at(t + 0.02),
    l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
}

/** The rings as strokes; `hot`: the axis of the one the mouse is on or that is being dragged, or -1.
 *  `sweep`: { axis, from, to } in radians: the part of a ring a drag has gone through. */
export function drawRings(ctx, rings, hot = -1, sweep = null) {
  for (const r of rings) {
    ctx.strokeStyle = AXIS_COLORS[r.axis];
    ctx.globalAlpha = r.axis === hot ? 1 : 0.7;
    ctx.lineWidth = r.axis === hot ? 3.5 : 1.8;
    ctx.beginPath();
    r.points.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (sweep) {
    const r = rings.find((x) => x.axis === sweep.axis),
      c = r && [(r.points[0][0] + r.points[Math.floor(r.points.length / 2)][0]) / 2, (r.points[0][1] + r.points[Math.floor(r.points.length / 2)][1]) / 2];
    if (!r) return;
    // from the middle out to where the drag began and to where it is now
    const at = (t) => {
      const n = r.points.length - 1,
        u = (((t / (2 * Math.PI)) % 1) + 1) % 1,
        i = Math.floor(u * n),
        k = u * n - i,
        a = r.points[i],
        b = r.points[Math.min(n, i + 1)];
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    };
    ctx.strokeStyle = AXIS_COLORS[r.axis];
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    for (const t of [sweep.from, sweep.to]) {
      const p = at(t);
      ctx.beginPath();
      ctx.moveTo(c[0], c[1]);
      ctx.lineTo(p[0], p[1]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

export function drawArrows(ctx, arrows, hot = -1) {
  for (const { axis, a, b } of arrows) {
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      l = Math.hypot(ux, uy);
    if (l < 15) continue;
    const nx = ux / l,
      ny = uy / l,
      color = AXIS_COLORS[axis];
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = axis === hot ? 4 : 2.5;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0] - nx * 9, b[1] - ny * 9);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(b[0], b[1]);
    ctx.lineTo(b[0] - nx * 13 - ny * 5.5, b[1] - ny * 13 + nx * 5.5);
    ctx.lineTo(b[0] - nx * 13 + ny * 5.5, b[1] - ny * 13 - nx * 5.5);
    ctx.closePath();
    ctx.fill();
    ctx.font = 'bold 11px system-ui';
    ctx.fillText(NAMES[axis], b[0] + nx * 7 - 3, b[1] + ny * 7 + 4);
  }
  if (arrows.length) {
    const a = arrows[0].a;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#41585d';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(a[0], a[1], 4, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
  }
}

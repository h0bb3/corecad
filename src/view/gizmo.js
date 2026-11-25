// The three arrows a part is dragged by. Pure: camera mathematics in, numbers and canvas strokes out.
import { project, ray, mmPerPx, add, sub, mul, dot } from './camera-math.js';

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

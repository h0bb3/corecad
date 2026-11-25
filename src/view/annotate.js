// Numbers drawn over the 3D view: a value in a small pill, a dimension line with its ticks.
// Canvas strokes only; everything is in CSS pixels of the overlay.

export const INK = {
  driving: { ink: '#25646b', paper: '#f0f4f4' }, // a number that drives the model: click to change it
  reference: { ink: '#7e8891', paper: '#f0f4f4' }, // a number that follows the model
  measure: { ink: '#0e6b5c', paper: '#ffffff' }, // what the person measured
  pointed: { ink: '#a35d1c', paper: '#fff6ea' }, // where the mouse rests
  chosen: { ink: '#ffffff', paper: '#0e7b68' }, // the number being changed
};
const FONT = '12px "SFMono-Regular", Consolas, monospace';

/** How wide the plate of a value is. */
export function pillWidth(ctx, text) {
  ctx.font = FONT;
  return ctx.measureText(text).width + 12;
}

/** A value on a small rounded plate, centred on (x, y). @returns {{ x, y, w, h }} the plate's box */
export function pill(ctx, text, x, y, style = INK.driving) {
  ctx.font = FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 12,
    h = 18,
    box = { x: x - w / 2, y: y - h / 2, w, h };
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, w, h, 4);
  ctx.fillStyle = style.paper;
  ctx.fill();
  if (style.paper === '#ffffff' || style === INK.pointed) {
    ctx.strokeStyle = style.ink + '55';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.fillStyle = style.ink;
  ctx.fillText(text, x, y + 0.5);
  return box;
}

/** A thin line through points, with a short tick across each of the ends named in `ticks`. */
export function line(ctx, points, style = INK.driving, { width = 0.9, ticks = [], dash = [] } = {}) {
  if (points.length < 2) return;
  ctx.strokeStyle = style.ink;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.stroke();
  ctx.setLineDash([]);
  for (const i of ticks) {
    const p = points[i],
      q = points[i ? i - 1 : 1],
      l = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1,
      nx = (-(p[1] - q[1]) / l) * 4,
      ny = ((p[0] - q[0]) / l) * 4;
    ctx.beginPath();
    ctx.moveTo(p[0] - nx, p[1] - ny);
    ctx.lineTo(p[0] + nx, p[1] + ny);
    ctx.stroke();
  }
}

/** True when a point is on a box (as pill returns), with a little room round it. */
export const inBox = (box, p, room = 2) => p[0] >= box.x - room && p[0] <= box.x + box.w + room && p[1] >= box.y - room && p[1] <= box.y + box.h + room;

// A drawing laid out on its sheet: the frame and the title block, each view where it stands at the scale
// of the drawing, centre lines, and the dimensions with their lines, arrows and numbers. Pure: it is given
// the lines of each view (from the kernel's hidden-line removal) and the built bodies of the part, and
// gives back what to draw, in mm on the paper with y up from the lower left corner (drawing/svg.js and
// drawing/pdf.js draw it).
//
// What is drawn:
//   { t: 'path', pts: [x0, y0, x1, y1, ...], w: width, dash?: [on, off, ...], fill?: true, closed?: true }
//   { t: 'text', x, y, text, size, anchor: 'start' | 'middle' | 'end', angle: degrees }
import { SHEETS, axesOf, scaleText } from './model.js';
import { textWidth } from './font.js';
import { between } from '../api/measure3d.js';
import { placedTopo } from '../api/select.js';
import { facePoints } from '../api/measure3d.js';
import { add, sub, mul, dot, cross, len, unit } from '../core/vec.js';
import { formatNumber } from '../core/num.js';

/** The frame: a wider margin on the left, for filing. */
export const MARGIN = Object.freeze({ left: 20, right: 10, top: 10, bottom: 10 });
const WIDTH = { outline: 0.5, hidden: 0.35, thin: 0.25, smooth: 0.18 };
const DASH = { hidden: [2.5, 1.2], centre: [8, 1.5, 1, 1.5] };
const TEXT = 3.5, // the numbers of dimensions
  GAP = 1, // between the part and an extension line
  OVER = 2, // how far an extension line goes past its dimension line
  FIRST = 10, // the first dimension line from the view
  STEP = 7, // between dimension lines
  ARROW = 3,
  ARROW_W = 1;
export const TITLE_BLOCK = Object.freeze({ width: 180, height: 43 });

const fmt = (v) => formatNumber(v, 2);
const E = 1e-6;

/**
 * What a dimension measures and how it is drawn, in space. Throws a sentence when it cannot be drawn in
 * that view: it is seen shortened, or it is not a length.
 * @param {{ along: null | 'horizontal' | 'vertical' }} dim
 * @param {{ body: object, kind: 'face' | 'edge', index: number }[]} picks  one or two, on bodies with `matrix`
 * @param {string} look
 * @returns {{ kind: 'linear', a: number[], b: number[], dir: 'horizontal' | 'vertical' | 'aligned', value: number, prefix: string }
 *         | { kind: 'leader', c: number[], r: number, value: number, prefix: string }}
 */
export function measureOf(dim, picks, look) {
  const ax = axesOf(look);
  if (picks.length === 2) {
    const m = between(picks[0], picks[1]);
    if (m.angle !== undefined)
      throw Error(`Those two are at ${fmt(m.angle)}° to each other: a dimension is a distance between things that are parallel (two faces, two holes, a hole and a face). Angles are not drawn.`);
    if (!(m.distance > E)) throw Error('Those two lie in one place: there is no distance between them to draw.');
    return linear(m.from, m.to, m.distance, '', dim.along, ax, look);
  }
  const p = picks[0],
    topo = placedTopo(p.body);
  if (p.kind === 'edge') {
    const e = topo.edges[p.index];
    if (e.circle) return round(e.circle.c, unit(e.circle.n), e.circle.r, !!e.closed, ax, look, dim.along);
    if (e.kind === 'line') return linear(e.a, e.b, e.length, '', dim.along, ax, look);
    throw Error('That edge is neither straight nor round: give two things to measure between.');
  }
  const f = topo.faces[p.index];
  if (f.cyl) {
    const dir = unit(f.cyl.dir),
      full = topo.edges.some((e) => e.faces.includes(p.index) && e.circle && e.closed),
      c = add(f.cyl.p, mul(dir, dot(sub(f.center, f.cyl.p), dir)));
    return round(c, dir, f.cyl.r, full, ax, look, dim.along);
  }
  if (f.sphere) return { kind: 'leader', c: f.sphere.c, r: f.sphere.r, value: 2 * f.sphere.r, prefix: 'SØ' };
  if (f.plane) throw Error('A flat face has a size each way: give "to" as well (the face across from it), or measure one of its edges.');
  throw Error('That face is neither flat nor round: give two things to measure between.');
}
function round(c, n, r, full, ax, look, along) {
  const facing = Math.abs(dot(n, ax.n));
  if (facing > 1 - E) {
    if (along) throw Error(`In the ${look} view that ${full ? 'circle' : 'arc'} is seen round: its ${full ? 'diameter' : 'radius'} is drawn as it is, without "along".`);
    return { kind: 'leader', c, r, value: full ? 2 * r : r, prefix: full ? 'Ø' : 'R' };
  }
  if (facing < E && full) {
    const e = unit(cross(n, ax.n));
    return linear(sub(c, mul(e, r)), add(c, mul(e, r)), 2 * r, 'Ø', along, ax, look);
  }
  throw Error(`In the ${look} view that ${full ? 'circle' : 'arc'} is seen ${facing < E ? 'from its side' : 'at a slant'}: its ${full ? 'diameter' : 'radius'} is drawn in a view that looks along its axis${full ? ', or from its side' : ''}.`);
}
function linear(a, b, value, prefix, along, ax, look) {
  const d = sub(b, a),
    dx = dot(d, ax.x),
    dy = dot(d, ax.y);
  if (along) {
    const part = Math.abs(along === 'horizontal' ? dx : dy);
    if (part < E) throw Error(`Those two are at the same place ${along === 'horizontal' ? 'across' : 'up'} the ${look} view: there is no ${along} distance between them.`);
    return { kind: 'linear', a, b, dir: along, value: part, prefix };
  }
  if (Math.abs(dot(d, ax.n)) > E * Math.max(1, len(d)))
    throw Error(`That distance does not lie flat in the ${look} view, so it would be seen shortened there: measure it in a view it lies flat in, or give "along" for its horizontal or its vertical part.`);
  const dir = Math.abs(dy) <= E * len(d) ? 'horizontal' : Math.abs(dx) <= E * len(d) ? 'vertical' : 'aligned';
  return { kind: 'linear', a, b, dir, value, prefix };
}

/** The box round the lines of a view, in the view's own mm: [x0, y0, x1, y1], or null when it has none. */
export function boundsOf(lines) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const kind of ['visible', 'smooth', 'hidden'])
    for (const pl of lines?.[kind] ?? [])
      for (let i = 0; i < pl.length; i += 2) {
        x0 = Math.min(x0, pl[i]);
        x1 = Math.max(x1, pl[i]);
        y0 = Math.min(y0, pl[i + 1]);
        y1 = Math.max(y1, pl[i + 1]);
      }
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}

/**
 * The sheet of a drawing.
 * @param {object} o
 * @param {object} o.drawing   as in doc.drawings
 * @param {{ part: string, project: string, date: string }} o.names  for the title block
 * @param {Map<string, { visible: Float32Array[], smooth: Float32Array[], hidden: Float32Array[] }>} o.lines  of each view, by its id
 * @param {object[]} o.bodies  the built bodies of the part (with `matrix`), for centre lines
 * @param {Map<string, object[] | null>} o.picks  of each dimension, by its id: what it measures, or null when that is lost
 * @returns {{ size: number[], items: object[], views: { id: string, look: string, box: number[] | null }[], dims: object[] }}
 */
export function composeSheet({ drawing, names, lines, bodies, picks }) {
  const size = SHEETS[drawing.sheet],
    s = drawing.scale,
    items = [],
    path = (pts, w, more = {}) => items.push({ t: 'path', pts, w, ...more }),
    text = (x, y, t, size = TEXT, anchor = 'middle', angle = 0) => items.push({ t: 'text', x, y, text: t, size, anchor, angle });
  frame(size, drawing, names, path, text);
  const views = [],
    dims = [];
  for (const v of drawing.views) {
    const own = lines.get(v.id),
      b = boundsOf(own),
      c = b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0],
      ax = axesOf(v.look),
      S = (p) => [v.at[0] + s * (dot(p, ax.x) - c[0]), v.at[1] + s * (dot(p, ax.y) - c[1])],
      box = b ? [v.at[0] + s * (b[0] - c[0]), v.at[1] + s * (b[1] - c[1]), v.at[0] + s * (b[2] - c[0]), v.at[1] + s * (b[3] - c[1])] : null;
    views.push({ id: v.id, look: v.look, box, centre: c, scale: s });
    if (!b) continue;
    const place = (pl) => {
      const out = new Array(pl.length);
      for (let i = 0; i < pl.length; i += 2) {
        out[i] = v.at[0] + s * (pl[i] - c[0]);
        out[i + 1] = v.at[1] + s * (pl[i + 1] - c[1]);
      }
      return out;
    };
    for (const pl of own.hidden ?? []) path(place(pl), WIDTH.hidden, { dash: DASH.hidden });
    for (const pl of own.smooth ?? []) path(place(pl), WIDTH.smooth);
    for (const pl of own.visible ?? []) path(place(pl), WIDTH.outline);
    centreLines(bodies, ax, S, s, path);
    // the dimensions of this view, each further out than the one before it on its side
    const levels = { top: 0, bottom: 0, left: 0, right: 0, aligned: 0 },
      mid = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    for (const m of drawing.dims.filter((m) => m.view === v.id)) {
      const ps = picks.get(m.id);
      if (!ps) {
        dims.push({ id: m.id, view: v.id, problem: 'What it measured is no longer in the model.' });
        continue;
      }
      let g;
      try {
        g = measureOf(m, ps, v.look);
      } catch (e) {
        dims.push({ id: m.id, view: v.id, problem: String(e.message) });
        continue;
      }
      const label = withTolerance(g.prefix + fmt(g.value), m.tolerance),
        at = g.kind === 'leader' ? leader(S(g.c), g.r * s, mid, label, path, text) : linearDim(S(g.a), S(g.b), g.dir, box, mid, levels, label, path, text);
      dims.push({ id: m.id, view: v.id, value: +g.value.toFixed(4), text: label, at: at.map((x) => +x.toFixed(3)), angle: at.angle, width: +textWidth(label, TEXT).toFixed(3) });
    }
  }
  return { size, items, views, dims };
}

/** A number with its tolerance: a fit (H7) right after it, a deviation (±0.1, +0.2/-0) after a space. */
export const withTolerance = (label, tolerance) => (!tolerance ? label : /^[A-Za-z]/.test(tolerance) ? label + tolerance : `${label} ${tolerance}`);

/** A filled arrow head with its tip at p, pointing along d. */
function arrow(p, d, path) {
  const n = [-d[1], d[0]],
    back = [p[0] - d[0] * ARROW, p[1] - d[1] * ARROW];
  path([p[0], p[1], back[0] + (n[0] * ARROW_W) / 2, back[1] + (n[1] * ARROW_W) / 2, back[0] - (n[0] * ARROW_W) / 2, back[1] - (n[1] * ARROW_W) / 2], WIDTH.thin, { fill: true, closed: true });
}
const u2 = (a, b) => {
  const d = [b[0] - a[0], b[1] - a[1]],
    l = Math.hypot(d[0], d[1]) || 1;
  return [d[0] / l, d[1] / l];
};
/** A dimension line between A and B (on the paper), out from the view, with its extension lines. */
function linearDim(A, B, dir, box, mid, levels, label, path, text) {
  let P, Q, nrm;
  if (dir === 'horizontal') {
    if (A[0] > B[0]) [A, B] = [B, A];
    const side = (A[1] + B[1]) / 2 >= mid[1] ? 'top' : 'bottom',
      k = levels[side]++,
      y = side === 'top' ? box[3] + FIRST + STEP * k : box[1] - FIRST - STEP * k;
    P = [A[0], y];
    Q = [B[0], y];
    nrm = [0, side === 'top' ? 1 : -1];
  } else if (dir === 'vertical') {
    if (A[1] > B[1]) [A, B] = [B, A];
    const side = (A[0] + B[0]) / 2 >= mid[0] ? 'right' : 'left',
      k = levels[side]++,
      x = side === 'right' ? box[2] + FIRST + STEP * k : box[0] - FIRST - STEP * k;
    P = [x, A[1]];
    Q = [x, B[1]];
    nrm = [side === 'right' ? 1 : -1, 0];
  } else {
    const u = u2(A, B);
    nrm = [-u[1], u[0]];
    const m = [(A[0] + B[0]) / 2 - mid[0], (A[1] + B[1]) / 2 - mid[1]];
    if (nrm[0] * m[0] + nrm[1] * m[1] < 0) nrm = [-nrm[0], -nrm[1]];
    const o = FIRST + STEP * levels.aligned++;
    P = [A[0] + nrm[0] * o, A[1] + nrm[1] * o];
    Q = [B[0] + nrm[0] * o, B[1] + nrm[1] * o];
  }
  // extension lines: from just off the part to just past the dimension line
  for (const [from, to] of [
    [A, P],
    [B, Q],
  ]) {
    const along = [to[0] - from[0], to[1] - from[1]],
      l = Math.hypot(along[0], along[1]);
    if (l < GAP + 0.1) continue;
    const e = [along[0] / l, along[1] / l];
    path([from[0] + e[0] * GAP, from[1] + e[1] * GAP, to[0] + e[0] * OVER, to[1] + e[1] * OVER], WIDTH.thin);
  }
  const u = u2(P, Q),
    length = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
  if (length >= 2 * ARROW + 1) {
    path([P[0], P[1], Q[0], Q[1]], WIDTH.thin);
    arrow(P, [-u[0], -u[1]], path);
    arrow(Q, u, path);
  } else {
    // too short for the arrows between: they point in from outside
    path([P[0] - u[0] * (ARROW + 3), P[1] - u[1] * (ARROW + 3), Q[0] + u[0] * (ARROW + 3), Q[1] + u[1] * (ARROW + 3)], WIDTH.thin);
    arrow(P, u, path);
    arrow(Q, [-u[0], -u[1]], path);
  }
  // the number above the line, read from below or from the right
  let angle = (Math.atan2(u[1], u[0]) * 180) / Math.PI;
  if (angle > 90.001) angle -= 180;
  if (angle <= -90.001) angle += 180;
  const up = [-Math.sin((angle * Math.PI) / 180), Math.cos((angle * Math.PI) / 180)],
    w = textWidth(label, TEXT);
  let at = [(P[0] + Q[0]) / 2 + up[0] * 1, (P[1] + Q[1]) / 2 + up[1] * 1];
  if (w > length - 2) {
    // it does not fit between the arrows: beside the end of the line
    const far = (Q[0] - P[0]) * Math.cos((angle * Math.PI) / 180) + (Q[1] - P[1]) * Math.sin((angle * Math.PI) / 180) >= 0 ? Q : P,
      r = [Math.cos((angle * Math.PI) / 180), Math.sin((angle * Math.PI) / 180)];
    at = [far[0] + r[0] * (ARROW + 4 + w / 2) + up[0], far[1] + r[1] * (ARROW + 4 + w / 2) + up[1]];
  }
  text(at[0], at[1], label, TEXT, 'middle', angle);
  return Object.assign(at, { angle });
}
/** A diameter or radius seen round: a leader from the circle out to the number. */
function leader(C, r, mid, label, path, text) {
  const d = [C[0] - mid[0], C[1] - mid[1]],
    sx = d[0] < -E ? -1 : 1,
    sy = d[1] < -E ? -1 : 1,
    u = [sx / Math.SQRT2, sy / Math.SQRT2],
    tip = [C[0] + u[0] * r, C[1] + u[1] * r],
    knee = [C[0] + u[0] * (r + 7), C[1] + u[1] * (r + 7)],
    w = textWidth(label, TEXT),
    end = [knee[0] + sx * (w + 2), knee[1]];
  path([tip[0], tip[1], knee[0], knee[1], end[0], end[1]], WIDTH.thin);
  arrow(tip, [-u[0], -u[1]], path);
  text(knee[0] + sx * (1 + w / 2), knee[1] + 1, label, TEXT, 'middle', 0);
  return Object.assign([knee[0] + sx * (1 + w / 2), knee[1] + 1], { angle: 0 });
}

/** Chain lines through the middle of what is round: a cross on a circle seen round, the axis of a hole or a pin seen from its side. */
function centreLines(bodies, ax, S, s, path) {
  const seen = new Set(),
    key = (...v) => v.map((x) => Math.round(x * 100)).join(',');
  for (const body of bodies) {
    const topo = placedTopo(body);
    for (const e of topo.edges) {
      if (!e.circle || !e.closed || Math.abs(dot(unit(e.circle.n), ax.n)) < 1 - E) continue;
      const C = S(e.circle.c),
        r = e.circle.r * s,
        k = key(C[0], C[1]);
      if (r < 0.75 || seen.has(k)) continue;
      seen.add(k);
      const o = r + 2;
      path([C[0] - o, C[1], C[0] + o, C[1]], WIDTH.smooth, { dash: DASH.centre });
      path([C[0], C[1] - o, C[0], C[1] + o], WIDTH.smooth, { dash: DASH.centre });
    }
    topo.faces.forEach((f, i) => {
      if (!f.cyl || Math.abs(dot(unit(f.cyl.dir), ax.n)) > E) return;
      if (!topo.edges.some((e) => e.faces.includes(i) && e.circle && e.closed)) return; // a fillet has no axis to draw
      const dir = unit(f.cyl.dir),
        along = facePoints(body, i).map((p) => dot(p, dir));
      if (!along.length) return;
      const t0 = Math.min(...along),
        t1 = Math.max(...along),
        on = (t) => add(f.cyl.p, mul(dir, t - dot(f.cyl.p, dir))),
        A = S(on(t0)),
        B = S(on(t1)),
        k = key(...A, ...B);
      if (seen.has(k) || Math.hypot(B[0] - A[0], B[1] - A[1]) < 1) return;
      seen.add(k);
      const e = u2(A, B);
      path([A[0] - e[0] * 2, A[1] - e[1] * 2, B[0] + e[0] * 2, B[1] + e[1] * 2], WIDTH.smooth, { dash: DASH.centre });
    });
  }
}

/** The frame round the paper, the title block in its lower right corner (the fields of ISO 7200), and the
 *  notes above it. */
function frame([w, h], drawing, names, path, text) {
  const x0 = MARGIN.left,
    y0 = MARGIN.bottom,
    x1 = w - MARGIN.right,
    y1 = h - MARGIN.top,
    f = drawing.fields ?? {};
  path([x0, y0, x1, y0, x1, y1, x0, y1], 0.7, { closed: true });
  const W = Math.min(TITLE_BLOCK.width, x1 - x0),
    bx = x1 - W,
    heights = [8, 8, 11, 8, 8],
    rows = heights.reduce((r, hh) => [...r, r.at(-1) + hh], [y0]);
  path([bx, y0, bx, rows.at(-1), x1, rows.at(-1)], 0.5);
  for (const y of rows.slice(1, -1)) path([bx, y, x1, y], WIDTH.thin);
  const at = (k) => bx + k * W,
    cell = (a, b, row, label, value, size = 3) => {
      const xa = at(a),
        xb = at(b);
      if (a > 0) path([xa, rows[row], xa, rows[row + 1]], WIDTH.thin);
      text(xa + 1, rows[row + 1] - 2, label, 1.8, 'start');
      if (value) text(xa + 1, rows[row] + 1.3, fitted(value, xb - xa - 2, size), size, 'start');
    };
  // from the bottom up
  cell(0, 0.15, 0, 'SCALE', scaleText(drawing.scale));
  cell(0.15, 0.3, 0, 'SIZE', drawing.sheet.replace(' portrait', ''));
  cell(0.3, 0.4, 0, 'UNITS', 'mm');
  cell(0.4, 0.55, 0, 'PROJECTION', '');
  firstAngle(at(0.475), rows[0] + 3, path);
  cell(0.55, 0.68, 0, 'SHEET', '1/1');
  cell(0.68, 1, 0, 'MADE WITH', 'CoreCAD');
  cell(0, 0.4, 1, 'DRAWING NO.', f.number);
  cell(0.4, 0.5, 1, 'REV', f.revision);
  cell(0.5, 0.68, 1, 'DATE OF ISSUE', f.date ?? names.date);
  cell(0.68, 1, 1, 'PROJECT', names.project);
  cell(0, 1, 2, 'TITLE', names.part, 5);
  cell(0, 0.4, 3, 'OWNER', f.owner);
  cell(0.4, 0.7, 3, 'DRAWN BY', f.drawn_by);
  cell(0.7, 1, 3, 'APPROVED BY', f.approved_by);
  cell(0, 0.4, 4, 'MATERIAL', f.material);
  cell(0.4, 0.7, 4, 'GENERAL TOLERANCES', f.tolerances);
  cell(0.7, 1, 4, 'SURFACE', f.finish);
  // the notes, above the title block, numbered
  const notes = (f.notes ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l, i) => wrapped(`${i + 1}. ${l}`, W - 2, 3));
  if (notes.length) {
    let y = rows.at(-1) + 3;
    for (const line of [...notes].reverse()) {
      text(bx + 1, y, line, 3, 'start');
      y += 4.5;
    }
    text(bx + 1, y, 'NOTES', 2.5, 'start');
  }
}
/** A text in lines no wider than a width, broken between words. */
function wrapped(t, width, size) {
  const out = [];
  let line = '';
  for (const word of t.split(/\s+/)) {
    const next = line ? line + ' ' + word : word;
    if (line && textWidth(next, size) > width) {
      out.push(line);
      line = '   ' + word;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}
/** A text cut short, with an ellipsis, so that it fits a width. */
function fitted(t, width, size) {
  if (textWidth(t, size) <= width) return t;
  let out = t;
  while (out.length > 1 && textWidth(out + '...', size) > width) out = out.slice(0, -1);
  return out + '...';
}
/** The symbol of first angle projection (ISO 5456-2): a cone, narrow end to the left, and to its right what is seen from that end. */
function firstAngle(cx, cy, path) {
  const ring = (x, y, r) => {
    const pts = [];
    for (let i = 0; i < 32; i++) pts.push(x + r * Math.cos((i / 32) * 2 * Math.PI), y + r * Math.sin((i / 32) * 2 * Math.PI));
    path(pts, WIDTH.thin, { closed: true });
  };
  path([cx - 6, cy - 1, cx - 1, cy - 2, cx - 1, cy + 2, cx - 6, cy + 1], WIDTH.thin, { closed: true });
  ring(cx + 3, cy, 2);
  ring(cx + 3, cy, 1);
}

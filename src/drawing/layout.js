// A drawing laid out on its sheet: the frame and the title block, each view where it stands at the scale
// of the drawing, centre lines, and the dimensions with their lines, arrows and numbers. Pure: it is given
// the lines of each view (from the kernel's hidden-line removal) and the built bodies of the part, and
// gives back what to draw, in mm on the paper with y up from the lower left corner (drawing/svg.js and
// drawing/pdf.js draw it).
//
// What is drawn:
//   { t: 'path', pts: [x0, y0, x1, y1, ...], w: width, dash?: [on, off, ...], fill?: true, closed?: true }
//   { t: 'text', x, y, text, size, anchor: 'start' | 'middle' | 'end', angle: degrees }
import { SHEETS, viewAxes, viewName, planeOf, sourceOf, scaleText } from './model.js';
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
 * @param {{ x: number[], y: number[], n: number[] }} ax  the directions of the view (viewAxes)
 * @param {string} look  what the view is called, for the sentences
 * @returns {{ kind: 'linear', a: number[], b: number[], dir: 'horizontal' | 'vertical' | 'aligned', value: number, prefix: string }
 *         | { kind: 'leader', c: number[], r: number, value: number, prefix: string }}
 */
export function measureOf(dim, picks, ax, look) {
  if (picks.length === 2) {
    const m = between(picks[0], picks[1]);
    if (m.angle !== undefined) return angleOf(picks, ax, look);
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
    dims = [],
    symbols = [];
  for (const v of drawing.views) {
    const own = lines.get(v.id),
      detail = v.look === 'detail' ? v.detail : null,
      sv = detail ? detail.scale : s, // a detail has a scale of its own
      b = boundsOf(own),
      c = detail ? detail.centre : b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0],
      ax = viewAxes(drawing, v),
      S = (p) => [v.at[0] + sv * (dot(p, ax.x) - c[0]), v.at[1] + sv * (dot(p, ax.y) - c[1])],
      S2 = (q) => [v.at[0] + sv * (q[0] - c[0]), v.at[1] + sv * (q[1] - c[1])],
      R = detail ? detail.radius * sv : 0,
      box = detail
        ? [v.at[0] - R, v.at[1] - R, v.at[0] + R, v.at[1] + R]
        : b
        ? [v.at[0] + sv * (b[0] - c[0]), v.at[1] + sv * (b[1] - c[1]), v.at[0] + sv * (b[2] - c[0]), v.at[1] + sv * (b[3] - c[1])]
        : null;
    views.push({ id: v.id, look: v.look, box, centre: c, scale: sv, ...((v.section ?? v.detail) ? { letter: (v.section ?? v.detail).letter } : {}) });
    if (!b) continue;
    const place = (pl) => {
        const out = new Array(pl.length);
        for (let i = 0; i < pl.length; i += 2) {
          out[i] = v.at[0] + sv * (pl[i] - c[0]);
          out[i + 1] = v.at[1] + sv * (pl[i + 1] - c[1]);
        }
        return out;
      },
      // a detail shows only what lies in its circle
      pieces = (pl) => (detail ? clipped(pl, c, detail.radius) : [pl]);
    for (const pl of own.hidden ?? []) for (const q of pieces(pl)) path(place(q), WIDTH.hidden, { dash: DASH.hidden });
    for (const pl of own.smooth ?? []) for (const q of pieces(pl)) path(place(q), WIDTH.smooth);
    for (const pl of own.visible ?? []) for (const q of pieces(pl)) path(place(q), WIDTH.outline);
    const source = sourceOf(drawing, v);
    if (source.look === 'section') {
      // what the plane cuts, hatched at 45°
      let segs = hatched((own.cut ?? []).map(place), 2.5);
      if (detail) segs = segs.flatMap((g) => clipped(g, v.at, R));
      for (const g of segs) path(g, WIDTH.smooth);
    }
    if (v.look === 'section') text((box[0] + box[2]) / 2, box[1] - 9, `SECTION ${v.section.letter}-${v.section.letter}`, 5);
    if (detail) {
      path(circlePts(v.at, R), WIDTH.thin, { closed: true });
      text(v.at[0], box[1] - 9, `DETAIL ${detail.letter} (${scaleText(sv)})`, 5);
    } else {
      centreLines(bodies, ax, S, sv, path, source.look === 'section' ? planeOf(drawing, source) : null);
      for (const t of own.threads ?? []) threadLines(t, ax, S, sv, path);
    }
    // where the sections cut from this view lie: a chain line with thick ends, arrows the way they look, and the letter
    for (const x of drawing.views.filter((x) => x.look === 'section' && x.section.of === v.id)) cuttingLine(planeOf(drawing, x), x.section, ax, c, v, sv, box, path, text);
    // what the details of this view enlarge: a thin circle with the letter
    for (const x of drawing.views.filter((x) => x.look === 'detail' && x.detail.of === v.id)) {
      const C = S2(x.detail.centre),
        r = x.detail.radius * sv;
      path(circlePts(C, r), WIDTH.thin, { closed: true });
      text(C[0] + (r + 2) * Math.SQRT1_2 + 1.5, C[1] + (r + 2) * Math.SQRT1_2, x.detail.letter, 5);
    }
    // the dimensions of this view, each further out than the one before it on its side
    const levels = { top: 0, bottom: 0, left: 0, right: 0, aligned: 0, angle: 0 },
      mid = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    for (const m of drawing.dims.filter((m) => m.view === v.id)) {
      const ps = picks.get(m.id);
      if (!ps) {
        dims.push({ id: m.id, view: v.id, problem: 'What it measured is no longer in the model.' });
        continue;
      }
      let g;
      try {
        g = measureOf(m, ps, ax, viewName(v));
      } catch (e) {
        dims.push({ id: m.id, view: v.id, problem: String(e.message) });
        continue;
      }
      const label = withTolerance(g.kind === 'angle' ? fmt(g.value) + '°' : g.prefix + fmt(g.value), m.tolerance),
        at =
          g.kind === 'leader'
            ? leader(S(g.c), g.r * sv, mid, label, path, text)
            : g.kind === 'angle'
            ? angleDim(S2(g.vertex), g.u1, g.u2, g.reach * sv, levels.angle++, label, path, text)
            : linearDim(S(g.a), S(g.b), g.dir, box, mid, levels, label, path, text);
      dims.push({ id: m.id, view: v.id, value: +g.value.toFixed(4), text: label, at: at.map((x) => +x.toFixed(3)), angle: at.angle, width: +textWidth(label, TEXT).toFixed(3) });
    }
    // surface symbols on the faces of this view
    for (const sym of (drawing.symbols ?? []).filter((x) => x.view === v.id)) {
      const ps = picks.get(sym.id);
      let seg;
      try {
        if (!ps) throw Error('The face it was on is no longer in the model.');
        seg = faceLine(ps[0], ax, viewName(v));
      } catch (e) {
        symbols.push({ id: sym.id, view: v.id, problem: String(e.message) });
        continue;
      }
      const A = S(seg.a),
        B = S(seg.b),
        n2 = [dot(seg.n, ax.x), dot(seg.n, ax.y)],
        at = surfaceSymbol([(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], n2, sym.value, sym.process, path, text);
      symbols.push({ id: sym.id, view: v.id, text: sym.value, at: at.map((x) => +x.toFixed(3)) });
    }
  }
  return { size, items, views, dims, symbols };
}

/**
 * A thread as ISO 6410 draws it: the crests as the solid shows them (thick), the roots thin. From the side,
 * two thin lines along it at the root (on a bolt the minor diameter, in a nut the major); along its axis, three
 * quarters of a thin circle at the root, open at the upper right.
 */
function threadLines(t, ax, S, s, path) {
  const a = sub(t.p1, t.p0),
    L = len(a);
  if (!(L > E)) return;
  const u = mul(a, 1 / L),
    r = t.internal ? t.major : t.minor,
    facing = Math.abs(dot(u, ax.n));
  if (facing > 1 - E) {
    const C = S(t.p0),
      pts = [];
    for (let i = 0; i <= 54; i++) {
      const q = Math.PI / 2 + (i / 54) * 1.5 * Math.PI;
      pts.push(C[0] + r * s * Math.cos(q), C[1] + r * s * Math.sin(q));
    }
    path(pts, WIDTH.thin);
  } else if (facing < E) {
    const e = mul(unit(cross(u, ax.n)), r);
    for (const side of [e, mul(e, -1)]) path([...S(add(t.p0, side)), ...S(add(t.p1, side))], WIDTH.thin);
  }
}
/** The pieces of a polyline [x0, y0, ...] that lie inside a circle. */
export function clipped(pl, c, r) {
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.length >= 4) out.push(cur);
    cur = null;
  };
  for (let i = 2; i < pl.length; i += 2) {
    const p = [pl[i - 2] - c[0], pl[i - 1] - c[1]],
      d = [pl[i] - pl[i - 2], pl[i + 1] - pl[i - 1]],
      A = d[0] * d[0] + d[1] * d[1],
      Bq = 2 * (p[0] * d[0] + p[1] * d[1]),
      C = p[0] * p[0] + p[1] * p[1] - r * r,
      disc = Bq * Bq - 4 * A * C;
    if (!A || disc <= 0) {
      flush();
      continue;
    }
    const t0 = Math.max(0, (-Bq - Math.sqrt(disc)) / (2 * A)),
      t1 = Math.min(1, (-Bq + Math.sqrt(disc)) / (2 * A));
    if (t0 >= t1) {
      flush();
      continue;
    }
    const at = (t) => [pl[i - 2] + d[0] * t, pl[i - 1] + d[1] * t];
    if (t0 > 0) flush();
    if (!cur) cur = [...at(t0)];
    cur.push(...at(t1));
    if (t1 < 1) flush();
  }
  flush();
  return out;
}
function circlePts(c, r, n = 72) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(c[0] + r * Math.cos((i / n) * 2 * Math.PI), c[1] + r * Math.sin((i / n) * 2 * Math.PI));
  return pts;
}

/** A flat face seen from its side in a view, as the line it is there: its two ends in space and its outward normal. */
function faceLine(pick, ax, look) {
  const topo = placedTopo(pick.body);
  if (pick.kind === 'edge') {
    const e = topo.edges[pick.index];
    if (e.kind === 'line' && Math.abs(dot(unit(sub(e.b, e.a)), ax.n)) < E) return { a: e.a, b: e.b, n: null };
    throw Error(`That edge is not a straight line lying flat in the ${look} view.`);
  }
  const f = topo.faces[pick.index];
  if (!f.plane || Math.abs(dot(f.plane.n, ax.n)) > E) throw Error(`That face is not seen from its side in the ${look} view, as a line: choose a flat face that is.`);
  const e = unit(cross(ax.n, f.plane.n)),
    pts = facePoints(pick.body, pick.index);
  let lo = pts[0],
    hi = pts[0];
  for (const p of pts) {
    if (dot(p, e) < dot(lo, e)) lo = p;
    if (dot(p, e) > dot(hi, e)) hi = p;
  }
  return { a: lo, b: hi, n: f.plane.n };
}
/** The angle between two lines of a view (flat faces seen from their side, straight edges lying flat in it). */
function angleOf(picks, ax, look) {
  const segs = picks.map((p) => {
      try {
        return faceLine(p, ax, look);
      } catch {
        throw Error(`An angle is drawn between two things seen as lines in the ${look} view: flat faces seen from their side, or straight edges lying flat in it.`);
      }
    }),
    P2 = (p) => [dot(p, ax.x), dot(p, ax.y)],
    [a1, b1] = [P2(segs[0].a), P2(segs[0].b)],
    [a2, b2] = [P2(segs[1].a), P2(segs[1].b)],
    d1 = [b1[0] - a1[0], b1[1] - a1[1]],
    d2 = [b2[0] - a2[0], b2[1] - a2[1]],
    den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-9 * Math.hypot(...d1) * Math.hypot(...d2)) throw Error(`Those two are parallel in the ${look} view: there is no angle between them to draw.`);
  const t = ((a2[0] - a1[0]) * d2[1] - (a2[1] - a1[1]) * d2[0]) / den,
    vertex = [a1[0] + d1[0] * t, a1[1] + d1[1] * t],
    toward = (a, b, d) => {
      // from the corner towards the line's far side
      const m = [(a[0] + b[0]) / 2 - vertex[0], (a[1] + b[1]) / 2 - vertex[1]],
        l = Math.hypot(...m),
        dir = l > 1e-6 ? m : d,
        k = Math.hypot(...dir);
      return { u: [dir[0] / k, dir[1] / k], far: Math.max(Math.hypot(a[0] - vertex[0], a[1] - vertex[1]), Math.hypot(b[0] - vertex[0], b[1] - vertex[1])) };
    },
    w1 = toward(a1, b1, d1),
    w2 = toward(a2, b2, d2),
    value = (Math.acos(Math.max(-1, Math.min(1, w1.u[0] * w2.u[0] + w1.u[1] * w2.u[1]))) * 180) / Math.PI;
  return { kind: 'angle', vertex, u1: w1.u, u2: w2.u, reach: Math.min(w1.far, w2.far), value, prefix: '' };
}
/** An angle: an arc round the corner between the two lines, arrows at its ends, the degrees outside it. */
function angleDim(V, u1, u2, reach, level, label, path, text) {
  const r = Math.max(10, 0.6 * reach) + STEP * level,
    a1 = Math.atan2(u1[1], u1[0]);
  let da = Math.atan2(u2[1], u2[0]) - a1;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  const pts = [];
  for (let i = 0; i <= 32; i++) pts.push(V[0] + r * Math.cos(a1 + (da * i) / 32), V[1] + r * Math.sin(a1 + (da * i) / 32));
  path(pts, WIDTH.thin);
  // extension lines where the arc reaches past a line
  for (const u of [u1, u2]) if (r > reach - 0.5) path([V[0] + u[0] * (reach + GAP), V[1] + u[1] * (reach + GAP), V[0] + u[0] * (r + OVER), V[1] + u[1] * (r + OVER)], WIDTH.thin);
  const sg = Math.sign(da) || 1,
    end = (a, s) => arrow([V[0] + r * Math.cos(a), V[1] + r * Math.sin(a)], [-Math.sin(a) * s, Math.cos(a) * s], path);
  end(a1, -sg);
  end(a1 + da, sg);
  const am = a1 + da / 2,
    at = [V[0] + (r + 3) * Math.cos(am), V[1] + (r + 3) * Math.sin(am) - 1.2];
  text(at[0], at[1], label, TEXT, 'middle', 0);
  return Object.assign(at, { angle: 0 });
}
/**
 * A surface symbol (ISO 1302) on a face seen as a line: standing on it from outside where the face looks up,
 * else at the end of a leader out from it. The text (Ra 1.6) under its long bar. Returns where the text is.
 */
function surfaceSymbol(M, n2, value, process, path, text) {
  const h = 4,
    l = Math.hypot(n2[0], n2[1]) || 1,
    n = [n2[0] / l, n2[1] / l];
  let T;
  if (n[1] > 0.7) T = [M[0], M[1] + 0.3];
  else {
    // a leader out from the face, and a short line for the symbol to stand on
    const Q = [M[0] + n[0] * 9, M[1] + n[1] * 9],
      side = n[0] < -0.3 ? -1 : 1;
    path([M[0], M[1], Q[0], Q[1], Q[0] + side * 10, Q[1]], WIDTH.thin);
    arrow(M, [-n[0], -n[1]], path);
    T = [Q[0] + side * 5, Q[1]];
  }
  const L = [T[0] - h / Math.sqrt(3), T[1] + h],
    Rr = [T[0] + (2 * h) / Math.sqrt(3), T[1] + 2 * h],
    w = textWidth(value, 3);
  path([L[0], L[1], T[0], T[1], Rr[0], Rr[1], Rr[0] + w + 2, Rr[1]], WIDTH.thin);
  if (process === 'removal') path([L[0], L[1], T[0] + h / Math.sqrt(3), T[1] + h], WIDTH.thin);
  if (process === 'no_removal') path(circlePts([T[0] + 0.2, T[1] + h * 0.62], h * 0.36, 24), WIDTH.thin, { closed: true });
  const at = [Rr[0] + 1 + w / 2, Rr[1] - 3.2];
  if (value) text(Rr[0] + 1, Rr[1] - 3.2, value, 3, 'start');
  return Object.assign(at, { angle: 0 });
}

/**
 * Lines at 45° inside closed outlines (each a polyline on the paper), `gap` mm apart: the hatching of a cut.
 * Inside is decided by crossings (even-odd), so the outlines need not be in order or joined.
 */
export function hatched(loops, gap) {
  const segs = [];
  for (const pl of loops) for (let i = 2; i < pl.length; i += 2) segs.push([pl[i - 2], pl[i - 1], pl[i], pl[i + 1]]);
  if (!segs.length) return [];
  // turned by -45°: the hatch lines are then the lines of constant v
  const k = Math.SQRT1_2,
    T = (x, y) => [k * (x + y), k * (y - x)],
    back = (u, v) => [k * (u - v), k * (u + v)],
    turned = segs.map(([a, b, c, d]) => [...T(a, b), ...T(c, d)]),
    vs = turned.flatMap((t) => [t[1], t[3]]),
    out = [];
  for (let v = Math.ceil(Math.min(...vs) / gap) * gap + gap / 2; v < Math.max(...vs); v += gap) {
    const us = [];
    for (const [u0, v0, u1, v1] of turned) if (v0 <= v !== v1 <= v) us.push(u0 + ((v - v0) / (v1 - v0)) * (u1 - u0));
    us.sort((a, b) => a - b);
    for (let i = 0; i + 1 < us.length; i += 2) if (us[i + 1] - us[i] > 1e-6) out.push([...back(us[i], v), ...back(us[i + 1], v)]);
  }
  return out;
}
/** On a view, where a section of it is cut: a thin chain line across, thick at its ends, arrows the way the section looks, its letter. */
function cuttingLine(plane, section, ax, c, v, s, box, path, text) {
  // where the plane crosses this view: a line across it (a horizontal cut) or up it
  const point = [0, 0, 0];
  point[plane.axis] = section.through;
  const along = section.cut === 'horizontal' ? 0 : 1,
    at = [v.at[0] + s * (dot(point, ax.x) - c[0]), v.at[1] + s * (dot(point, ax.y) - c[1])],
    lo = along === 0 ? [box[0] - 6, at[1]] : [at[0], box[1] - 6],
    hi = along === 0 ? [box[2] + 6, at[1]] : [at[0], box[3] + 6],
    e = along === 0 ? [1, 0] : [0, 1],
    // the way the section looks, on this view: from the eye, towards the part that is kept
    look = [-dot(plane.n, ax.x), -dot(plane.n, ax.y)];
  path([...lo, ...hi], WIDTH.smooth, { dash: DASH.centre });
  for (const [end, out] of [
    [lo, -1],
    [hi, 1],
  ]) {
    const inner = [end[0] - e[0] * out * 6, end[1] - e[1] * out * 6];
    path([...inner, ...end], 0.7);
    const tip = [end[0] + look[0] * 8, end[1] + look[1] * 8];
    path([...end, ...tip], WIDTH.thin);
    arrow(tip, look, path);
    text(tip[0] + e[0] * out * 3 + look[0] * 2, tip[1] + e[1] * out * 3 + look[1] * 2 - 2, section.letter, 5);
  }
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
function centreLines(bodies, ax, S, s, path, cut = null) {
  const kept = (depth) => !cut || depth <= cut.c + 1e-6; // in a section: not what the cut took away
  const seen = new Set(),
    key = (...v) => v.map((x) => Math.round(x * 100)).join(',');
  for (const body of bodies) {
    const topo = placedTopo(body);
    for (const e of topo.edges) {
      if (!e.circle || !e.closed || Math.abs(dot(unit(e.circle.n), ax.n)) < 1 - E || !kept(dot(e.circle.c, ax.n))) continue;
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
  const revisions = drawing.revisions ?? [];
  cell(0.4, 0.5, 1, 'REV', revisions.at(-1)?.rev ?? f.revision);
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
  // the revision table on the title block: its heads at the bottom, the newest row at the top
  let top = rows.at(-1);
  if (revisions.length) {
    const cols = [0, 0.08, 0.66, 0.84, 1],
      row = (y, values, size) => {
        path([bx, y + 5, x1, y + 5], WIDTH.thin);
        values.forEach((v, i) => {
          if (i) path([at(cols[i]), y, at(cols[i]), y + 5], WIDTH.thin);
          if (v) text(at(cols[i]) + 1, y + 1.4, fitted(v, (cols[i + 1] - cols[i]) * W - 2, size), size, 'start');
        });
      };
    path([bx, top, bx, top + 5 * (revisions.length + 1), x1, top + 5 * (revisions.length + 1), x1, top], WIDTH.thin);
    row(top, ['REV', 'DESCRIPTION', 'DATE', 'BY'], 1.8);
    revisions.forEach((r, i) => row(top + 5 * (i + 1), [r.rev, r.description, r.date, r.by ?? ''], 2.5));
    top += 5 * (revisions.length + 1);
  }
  if (notes.length) {
    let y = top + 3;
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

// Drawings: sheets of paper with views of a part, for the workshop. Pure: what a drawing is in the project
// and the changes made to it. What a view shows is made from the model when the sheet is drawn
// (drawing/make.js); a drawing keeps only what was chosen: the part, the paper, the scale, where each view
// stands and what each dimension measures.
//
//   doc.drawings = [{ id: 'd1', name: 'Drawing 1', part: 'o1', sheet: 'A4', scale: 1,
//                     fields: { number: 'B-102', date: '2026-11-28', material: 'PETG', ... },   (FIELDS)
//                     views: [{ id: 'v2', look: 'front', at: [x, y] },
//                             { id: 'v4', look: 'section', at: [x, y],
//                               section: { of: 'v2', cut: 'horizontal' | 'vertical', through: z, flip: false, letter: 'A' } },
//                             { id: 'v5', look: 'detail', at: [x, y],
//                               detail: { of: 'v2', centre: [x, y], radius: r, scale: 5, letter: 'B' } }],   (centre, radius: the parent view's own mm)
//                     revisions: [{ id: 'r6', rev: 'A', description: 'First issue', date: '2026-11-28', by: 'TO' }],
//                     symbols: [{ id: 's7', view: 'v2', face: pick, value: 'Ra 1.6', process: 'any' | 'removal' | 'no_removal' }],
//                     dims:  [{ id: 'm3', view: 'v2', from: pick, to: pick | null, along: null | 'horizontal' | 'vertical',
//                               tolerance?: '±0.1' }] }]
//   doc.dseq: the counter of their ids (d, v and m share it)
//
// A pick is a face or an edge of a body, kept the way a fillet keeps its edges: by the labels of the
// faces, so that it is found again after the model is rebuilt.
import { topoOfBody, edgeRefFrom, resolveEdgeRef } from '../doc/refs.js';
import { dist } from '../core/vec.js';

/** Paper sizes in mm, across and up. Landscape unless named otherwise. */
export const SHEETS = Object.freeze({
  A4: [297, 210],
  'A4 portrait': [210, 297],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
});

/**
 * The directions a view looks from. `dir` points from the part to the eye; `x` is across the paper to
 * the right, `y` up it (dir × x). As a person stands to look: front from -y, right from +x, top from +z.
 */
export const LOOKS = Object.freeze({
  front: { dir: [0, -1, 0], x: [1, 0, 0] },
  back: { dir: [0, 1, 0], x: [-1, 0, 0] },
  right: { dir: [1, 0, 0], x: [0, 1, 0] },
  left: { dir: [-1, 0, 0], x: [0, -1, 0] },
  top: { dir: [0, 0, 1], x: [1, 0, 0] },
  bottom: { dir: [0, 0, -1], x: [1, 0, 0] },
  iso: { dir: [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)], x: [1 / Math.SQRT2, 1 / Math.SQRT2, 0] },
});
export const LOOK_NAMES = Object.keys(LOOKS);

/**
 * What the title block and the notes of a drawing say besides the part, the scale and the paper: the
 * fields of a title block by ISO 7200, and what a workshop drawing states for the whole part. Each is
 * text; one left empty is printed empty, for a pen.
 */
export const FIELDS = Object.freeze({
  number: 'Drawing number',
  revision: 'Revision',
  date: 'Date of issue',
  owner: 'Owner (company)',
  drawn_by: 'Drawn by',
  approved_by: 'Approved by',
  material: 'Material',
  tolerances: 'General tolerances (such as ISO 2768-m)',
  finish: 'Surface finish (such as Ra 3.2)',
  notes: 'Notes, one to a line (such as: Break sharp edges 0.5 × 45°)',
});
export const FIELD_NAMES = Object.keys(FIELDS);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/**
 * The three directions of a view of a drawing, a section view too: x across, y up, n towards the eye.
 * A section looks square onto its plane, from the side `flip` does not name: the plane of a horizontal cut
 * through the front view is seen from above (as the top view sees it), of a vertical cut from the right.
 */
export function viewAxes(drawing, view) {
  if (view.look === 'detail') {
    const of = drawing.views.find((v) => v.id === view.detail.of);
    return of && of.look !== 'detail' ? viewAxes(drawing, of) : axesOf('front');
  }
  if (view.look !== 'section') return axesOf(view.look);
  const { parent, m } = planeOf(drawing, view),
    n = view.section.flip ? m.map((v) => -v) : m;
  if (view.section.cut === 'horizontal') return { x: parent.x, y: cross(n, parent.x), n };
  return { x: cross(parent.y, n), y: parent.y, n };
}
/** What a view is called in a sentence: "front", "section A-A". */
export const viewName = (view) =>
  view.look === 'section' ? `section ${view.section.letter}-${view.section.letter}` : view.look === 'detail' ? `detail ${view.detail.letter}` : view.look;
/** The view whose lines a view shows: a detail shows those of the view it enlarges. */
export const sourceOf = (drawing, view) => (view.look === 'detail' ? drawing.views.find((v) => v.id === view.detail.of) ?? view : view);
/**
 * The plane of a section view: it runs square to `m` (an axis of space, either way: the parent view's up
 * for a horizontal cut, its across for a vertical one) through the coordinate `through` along that axis.
 * The part on the eye's side of it is taken away: where dot(p, n) > c.
 */
export function planeOf(drawing, view) {
  const of = drawing.views.find((v) => v.id === view.section.of),
    parent = axesOf(of?.look ?? 'front'),
    m = view.section.cut === 'horizontal' ? parent.y : parent.x,
    axis = m.findIndex((v) => Math.abs(v) > 0.5),
    point = [0, 0, 0];
  point[axis] = view.section.through;
  const n = view.section.flip ? m.map((v) => -v) : m;
  return { parent, parentView: of, m, axis, n, c: n[0] * point[0] + n[1] * point[1] + n[2] * point[2] };
}
/** The three directions of a view that looks from a side (not a section): x across, y up, n towards the eye. */
export function axesOf(look) {
  const l = LOOKS[look];
  return { x: l.x, y: cross(l.dir, l.x), n: l.dir };
}

/** A scale as it is written on a drawing: 1:2, 1:1, 5:1. */
export function scaleText(s) {
  const t = (v) => String(+v.toFixed(3));
  return s >= 1 ? `${t(s)}:1` : `1:${t(1 / s)}`;
}

export const drawingsOf = (doc) => doc.drawings ?? [];
export const drawingById = (doc, id) => drawingsOf(doc).find((d) => d.id === id) ?? null;
/** The drawing a view or a dimension is in, with it. */
export function itemById(doc, id) {
  for (const d of drawingsOf(doc)) {
    const view = d.views.find((v) => v.id === id);
    if (view) return { drawing: d, view };
    const dim = d.dims.find((m) => m.id === id);
    if (dim) return { drawing: d, dim };
    const revision = (d.revisions ?? []).find((r) => r.id === id);
    if (revision) return { drawing: d, revision };
    const symbol = (d.symbols ?? []).find((s) => s.id === id);
    if (symbol) return { drawing: d, symbol };
  }
  return null;
}

function nextId(doc, letter) {
  const n = (doc.dseq ?? 0) + 1;
  return { id: letter + n, doc: { ...doc, dseq: n } };
}
const withDrawing = (doc, id, fn) => ({ ...doc, drawings: drawingsOf(doc).map((d) => (d.id === id ? fn(d) : d)) });

/** A new drawing of a part, on A4 at 1:1 with nothing on it, issued on `date` (YYYY-MM-DD). */
export function addDrawing(doc, part, date = null) {
  const { id, doc: next } = nextId(doc, 'd'),
    taken = new Set(drawingsOf(doc).map((d) => d.name));
  let n = 1;
  while (taken.has(`Drawing ${n}`)) n++;
  const drawing = { id, name: `Drawing ${n}`, part, sheet: 'A4', scale: 1, fields: date ? { date } : {}, views: [], dims: [] };
  return { doc: { ...next, drawings: [...drawingsOf(next), drawing] }, drawing };
}
/** Changes name, part, sheet or scale (what is given); `fields` are merged, and an empty one is taken out. */
export const editDrawing = (doc, id, patch) =>
  withDrawing(doc, id, (d) => {
    const { fields, ...rest } = patch,
      merged = { ...(d.fields ?? {}) };
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (v === null || v === '') delete merged[k];
      else merged[k] = v;
    }
    return { ...d, ...rest, fields: merged, id: d.id, views: d.views, dims: d.dims };
  });
/** Gives a dimension a tolerance (text such as "±0.1", "+0.2/-0", "H7"), or with null takes it away. */
export const editDim = (doc, dimId, tolerance) => ({
  ...doc,
  drawings: drawingsOf(doc).map((d) => ({
    ...d,
    dims: d.dims.map((m) => {
      if (m.id !== dimId) return m;
      const { tolerance: _, ...rest } = m;
      return tolerance ? { ...rest, tolerance } : rest;
    }),
  })),
});
export const deleteDrawing = (doc, id) => ({ ...doc, drawings: drawingsOf(doc).filter((d) => d.id !== id) });

export function addView(doc, drawingId, look, at) {
  const { id, doc: next } = nextId(doc, 'v'),
    view = { id, look, at: [...at] };
  return { doc: withDrawing(next, drawingId, (d) => ({ ...d, views: [...d.views, view] })), view };
}
/** The letters of sections, as ISO 128-50 has them: I, O and Q are left out (they read as 1 and 0). */
const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';
/** The next letter for a section or a detail of a drawing: they share the alphabet. */
const nextLetter = (d) => {
  const used = new Set(d.views.map((v) => v.section?.letter ?? v.detail?.letter).filter(Boolean));
  return [...LETTERS].find((l) => !used.has(l)) ?? 'Z';
};
/** A section view: the part cut along a line of view `of` and seen square onto the cut. */
export function addSectionView(doc, drawingId, { of, cut, through, flip = false, at }) {
  const d = drawingById(doc, drawingId),
    letter = nextLetter(d),
    { id, doc: next } = nextId(doc, 'v'),
    view = { id, look: 'section', at: [...at], section: { of, cut, through, flip: !!flip, letter } };
  return { doc: withDrawing(next, drawingId, (x) => ({ ...x, views: [...x.views, view] })), view };
}
/** A detail view: a round piece of view `of` (centre and radius in that view's own mm), at a scale of its own. */
export function addDetailView(doc, drawingId, { of, centre, radius, scale, at }) {
  const d = drawingById(doc, drawingId),
    letter = nextLetter(d),
    { id, doc: next } = nextId(doc, 'v'),
    view = { id, look: 'detail', at: [...at], detail: { of, centre: [...centre], radius, scale, letter } };
  return { doc: withDrawing(next, drawingId, (x) => ({ ...x, views: [...x.views, view] })), view };
}
/** A row of the revision table: the next letter after the last row's, today, what changed and by whom. */
export function addRevision(doc, drawingId, { description, date, by = '' }) {
  const d = drawingById(doc, drawingId),
    last = (d.revisions ?? []).at(-1)?.rev,
    rev = last ? LETTERS[Math.min(LETTERS.length - 1, LETTERS.indexOf(last) + 1)] : 'A',
    { id, doc: next } = nextId(doc, 'r'),
    row = { id, rev, description, date, ...(by ? { by } : {}) };
  return { doc: withDrawing(next, drawingId, (x) => ({ ...x, revisions: [...(x.revisions ?? []), row] })), revision: row };
}
/** A surface symbol (ISO 1302) on a flat face, in a view where the face is seen from its side. */
export function addSymbol(doc, drawingId, { view, face, value, process = 'any' }) {
  const { id, doc: next } = nextId(doc, 's'),
    symbol = { id, view, face, value, process };
  return { doc: withDrawing(next, drawingId, (x) => ({ ...x, symbols: [...(x.symbols ?? []), symbol] })), symbol };
}
export const moveView = (doc, viewId, at) => ({
  ...doc,
  drawings: drawingsOf(doc).map((d) => ({ ...d, views: d.views.map((v) => (v.id === viewId ? { ...v, at: [...at] } : v)) })),
});
export function addDim(doc, drawingId, data) {
  const { id, doc: next } = nextId(doc, 'm'),
    dim = { id, view: data.view, from: data.from, to: data.to ?? null, along: data.along ?? null };
  return { doc: withDrawing(next, drawingId, (d) => ({ ...d, dims: [...d.dims, dim] })), dim };
}
/** Takes views and dimensions off a drawing; a view goes with the dimensions in it and the sections cut from it. */
export function removeItems(doc, drawingId, ids) {
  const gone = new Set(ids),
    d0 = drawingById(doc, drawingId);
  for (let more = true; more; ) {
    more = false;
    for (const v of d0?.views ?? []) if (gone.has((v.section ?? v.detail)?.of) && !gone.has(v.id)) more = !!gone.add(v.id);
  }
  return withDrawing(doc, drawingId, (d) => ({
    ...d,
    views: d.views.filter((v) => !gone.has(v.id)),
    dims: d.dims.filter((m) => !gone.has(m.id) && !gone.has(m.view)),
    ...(d.revisions ? { revisions: d.revisions.filter((r) => !gone.has(r.id)) } : {}),
    ...(d.symbols ? { symbols: d.symbols.filter((s) => !gone.has(s.id) && !gone.has(s.view)) } : {}),
  }));
}
// ------------------------------------------------------------------ picks
const overlap = (a, b) => {
  const n = a.filter((x) => b.includes(x)).length;
  return n / (a.length + b.length - n || 1);
};
/** A face or an edge of a built body, kept so that it is found again after a rebuild. */
export function pickRefFrom(body, kind, index) {
  const topo = topoOfBody(body);
  if (kind === 'edge') {
    const { body: b, faces, of, hint } = edgeRefFrom(body, index);
    return { kind: 'edge', body: b, faces, of, hint };
  }
  const f = topo.faces[index];
  if (!f) throw Error(`Body ${body.id} has no face ${index}.`);
  return { kind: 'face', body: topo.id, labels: [...f.labels], hint: { center: f.center, area: f.area } };
}
/** The face or edge a pick means among built bodies: { body, kind, index }, or null when it is lost. */
export function resolvePick(ref, bodies) {
  if (ref.kind === 'edge') {
    const r = resolveEdgeRef({ ...ref, k: 'k1' }, bodies);
    if (!r.hits.length) return null;
    const h = r.hits[0];
    return { body: bodies.find((b) => b.id === h.body.id), kind: 'edge', index: h.edge };
  }
  const own = bodies.filter((b) => b.id === ref.body),
    rest = bodies.filter((b) => b.id !== ref.body);
  for (const group of [own, rest]) {
    let best = null;
    for (const body of group)
      topoOfBody(body).faces.forEach((f, index) => {
        const score = overlap(ref.labels, f.labels);
        if (!score) return;
        const far = dist(f.center, ref.hint.center);
        if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && far < best.far)) best = { body, index, score, far };
      });
    if (best) return { body: best.body, kind: 'face', index: best.index };
  }
  return null;
}

// ------------------------------------------------------------------ checking
const ID = (letter) => new RegExp(`^${letter}[1-9][0-9]*$`);
const pickOk = (p) =>
  p &&
  typeof p.body === 'string' &&
  ((p.kind === 'face' && Array.isArray(p.labels) && p.labels.every((l) => typeof l === 'string') && p.hint && Array.isArray(p.hint.center)) ||
    (p.kind === 'edge' && Array.isArray(p.faces) && p.faces.length === 2 && p.hint && Array.isArray(p.hint.mid)));
/** What is wrong with the drawings of a project, as sentences; none when they are right. */
export function validateDrawings(doc) {
  if (doc.drawings === undefined) return [];
  if (!Array.isArray(doc.drawings) || !Number.isSafeInteger(doc.dseq) || doc.dseq < 0) return ['Invalid drawings list or drawing counter.'];
  const errors = [],
    ids = new Set(),
    fresh = (id, letter) => {
      if (typeof id !== 'string' || !ID(letter).test(id) || Number(id.slice(1)) > doc.dseq || ids.has(id)) return false;
      ids.add(id);
      return true;
    };
  for (const d of doc.drawings) {
    if (!d || !fresh(d.id, 'd')) {
      errors.push('Invalid or duplicate drawing id.');
      continue;
    }
    const name = typeof d.name === 'string' && d.name.trim() ? d.name : d.id;
    if (name === d.id) errors.push(`${d.id}: a drawing needs a name.`);
    if (!doc.parts.some((p) => p.id === d.part)) errors.push(`${name}: the part it shows does not exist.`);
    if (!SHEETS[d.sheet]) errors.push(`${name}: the sheet is one of ${Object.keys(SHEETS).join(', ')}.`);
    if (!(Number.isFinite(d.scale) && d.scale > 0)) errors.push(`${name}: the scale is a positive number.`);
    if (d.fields !== undefined && (!d.fields || typeof d.fields !== 'object' || Object.entries(d.fields).some(([k, v]) => !FIELDS[k] || typeof v !== 'string')))
      errors.push(`${name}: the fields of its title block are texts named ${FIELD_NAMES.join(', ')}.`);
    if (!Array.isArray(d.views) || !Array.isArray(d.dims)) {
      errors.push(`${name}: views and dimensions are lists.`);
      continue;
    }
    for (const v of d.views) {
      if (!v || !fresh(v.id, 'v')) errors.push(`${name}: invalid or duplicate view id.`);
      else if ((!LOOKS[v.look] && v.look !== 'section' && v.look !== 'detail') || !Array.isArray(v.at) || v.at.length !== 2 || !v.at.every(Number.isFinite)) errors.push(`${name}, ${v.id}: a view looks from one of ${LOOK_NAMES.join(', ')}, or is a section, and stands at two numbers.`);
      else if (v.look === 'section') {
        const s = v.section,
          of = d.views.find((x) => x.id === s?.of);
        if (!s || !of || !LOOKS[of.look] || of.look === 'iso' || !['horizontal', 'vertical'].includes(s.cut) || !Number.isFinite(s.through) || typeof s.flip !== 'boolean' || !/^[A-Z]$/.test(s.letter ?? ''))
          errors.push(`${name}, ${v.id}: a section is cut along a horizontal or vertical line of a view from a side, through a coordinate, with a letter.`);
      } else if (v.look === 'detail') {
        const t = v.detail,
          of = d.views.find((x) => x.id === t?.of);
        const pair = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
        if (!t || !of || of.look === 'detail' || !pair(t.centre) || !(t.radius > 0) || !(t.scale > 0) || !/^[A-Z]$/.test(t.letter ?? ''))
          errors.push(`${name}, ${v.id}: a detail is a round piece of another view (not a detail), with a centre, a radius, a scale and a letter.`);
      }
    }
    for (const m of d.dims) {
      if (!m || !fresh(m.id, 'm')) errors.push(`${name}: invalid or duplicate dimension id.`);
      else if (!d.views.some((v) => v.id === m.view)) errors.push(`${name}, ${m.id}: its view is not on the drawing.`);
      else if (!pickOk(m.from) || !(m.to === null || pickOk(m.to))) errors.push(`${name}, ${m.id}: it measures a face or an edge, or between two.`);
      else if (![null, 'horizontal', 'vertical'].includes(m.along)) errors.push(`${name}, ${m.id}: "along" is horizontal, vertical or null.`);
      else if (m.tolerance !== undefined && (typeof m.tolerance !== 'string' || !m.tolerance)) errors.push(`${name}, ${m.id}: a tolerance is a text.`);
    }
    for (const r of d.revisions ?? [])
      if (!r || !fresh(r.id, 'r') || !/^[A-Z]$/.test(r.rev ?? '') || typeof r.description !== 'string' || typeof r.date !== 'string' || !(r.by === undefined || typeof r.by === 'string'))
        errors.push(`${name}: a revision has an id, a letter, what changed and a date.`);
    for (const s of d.symbols ?? [])
      if (!s || !fresh(s.id, 's') || !d.views.some((v) => v.id === s.view) || !pickOk(s.face) || typeof s.value !== 'string' || !['any', 'removal', 'no_removal'].includes(s.process))
        errors.push(`${name}: a surface symbol is on a face in a view, with its text and how the surface is made (any, removal, no_removal).`);
  }
  return errors;
}

// Drawings: sheets of paper with views of a part, for the workshop. Pure: what a drawing is in the project
// and the changes made to it. What a view shows is made from the model when the sheet is drawn
// (drawing/make.js); a drawing keeps only what was chosen: the part, the paper, the scale, where each view
// stands and what each dimension measures.
//
//   doc.drawings = [{ id: 'd1', name: 'Drawing 1', part: 'o1', sheet: 'A4', scale: 1,
//                     fields: { number: 'B-102', date: '2026-11-28', material: 'PETG', ... },   (FIELDS)
//                     views: [{ id: 'v2', look: 'front', at: [x, y] }],
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
/** The three directions of a view: x across, y up, n towards the eye. */
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
export const moveView = (doc, viewId, at) => ({
  ...doc,
  drawings: drawingsOf(doc).map((d) => ({ ...d, views: d.views.map((v) => (v.id === viewId ? { ...v, at: [...at] } : v)) })),
});
export function addDim(doc, drawingId, data) {
  const { id, doc: next } = nextId(doc, 'm'),
    dim = { id, view: data.view, from: data.from, to: data.to ?? null, along: data.along ?? null };
  return { doc: withDrawing(next, drawingId, (d) => ({ ...d, dims: [...d.dims, dim] })), dim };
}
/** Takes views and dimensions off a drawing; a view goes with the dimensions in it. */
export function removeItems(doc, drawingId, ids) {
  const gone = new Set(ids);
  return withDrawing(doc, drawingId, (d) => ({
    ...d,
    views: d.views.filter((v) => !gone.has(v.id)),
    dims: d.dims.filter((m) => !gone.has(m.id) && !gone.has(m.view)),
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
      else if (!LOOKS[v.look] || !Array.isArray(v.at) || v.at.length !== 2 || !v.at.every(Number.isFinite)) errors.push(`${name}, ${v.id}: a view looks from one of ${LOOK_NAMES.join(', ')} and stands at two numbers.`);
    }
    for (const m of d.dims) {
      if (!m || !fresh(m.id, 'm')) errors.push(`${name}: invalid or duplicate dimension id.`);
      else if (!d.views.some((v) => v.id === m.view)) errors.push(`${name}, ${m.id}: its view is not on the drawing.`);
      else if (!pickOk(m.from) || !(m.to === null || pickOk(m.to))) errors.push(`${name}, ${m.id}: it measures a face or an edge, or between two.`);
      else if (![null, 'horizontal', 'vertical'].includes(m.along)) errors.push(`${name}, ${m.id}: "along" is horizontal, vertical or null.`);
      else if (m.tolerance !== undefined && (typeof m.tolerance !== 'string' || !m.tolerance)) errors.push(`${name}, ${m.id}: a tolerance is a text.`);
    }
  }
  return errors;
}

import { createSketch } from '../sketch/model.js';
export const FORMAT_VERSION = 1;
export function createDocument(name = 'Untitled') {
  const now = new Date().toISOString();
  return {
    format: 'corecad',
    version: FORMAT_VERSION,
    meta: { id: crypto.randomUUID(), name, created: now, modified: now, app: '0.1.0' },
    seq: 0,
    features: [],
    bodies: {},
  };
}
export const featureById = (doc, id) => doc.features.find((f) => f.id === id);
export const updateFeature = (doc, id, patch) => ({
  ...doc,
  features: doc.features.map((f) =>
    f.id === id ? (typeof patch === 'function' ? patch(f) : { ...f, ...patch, id: f.id }) : f
  ),
});
export const addFeature = (doc, f) => {
  if (featureById(doc, f.id)) throw Error('Feature id already exists.');
  return { ...doc, seq: Math.max(doc.seq, Number(f.id.slice(1))), features: [...doc.features, f] };
};
export const removeFeature = (doc, id) => {
  const bodies = { ...doc.bodies };
  delete bodies[id];
  return { ...doc, features: doc.features.filter((f) => f.id !== id), bodies };
};
export const setBodyProps = (doc, id, patch) => ({
  ...doc,
  bodies: { ...doc.bodies, [id]: { ...doc.bodies[id], ...patch } },
});
export function makeFeature(doc, type, data = {}) {
  const title = type[0].toUpperCase() + type.slice(1),
    n =
      1 +
      Math.max(
        0,
        ...doc.features
          .filter((f) => f.type === type)
          .map((f) => Number(f.name.match(/(\d+)$/)?.[1] ?? 0))
      );
  const id = 'f' + (doc.seq + 1);
  const defaults = {
    sketch: { ...createSketch(), plane: { kind: 'base', base: 'XY' } },
    extrude: {
      sketch: '',
      profiles: [],
      operation: 'new',
      extent: { type: 'oneSide', distance: 10 },
      flip: false,
      targets: null,
    },
    hole: { face: null, at: [0, 0], diameter: 5, depth: 'all' },
    fillet: { edges: [], radius: 2, kseq: 0 },
    chamfer: { edges: [], distance: 1, kseq: 0 },
  };
  return {
    feature: { id, type, name: title + n, ...defaults[type], ...data },
    doc: { ...doc, seq: doc.seq + 1 },
  };
}
export function dependsOn(f) {
  const out = new Set(f.sketch ? [f.sketch] : []);
  const refs = [f.plane?.ref, f.face, ...(f.edges ?? [])].filter(Boolean);
  refs.forEach((r) => {
    if (r.body) out.add(r.body);
    for (const label of r.labels ?? r.faces?.flat() ?? []) out.add(label.split('/')[0]);
  });
  (f.targets ?? []).forEach((id) => out.add(id));
  out.delete(f.id);
  return [...out];
}
export function dependents(doc, id) {
  const all = new Set([id]);
  let changed;
  do {
    changed = false;
    for (const f of doc.features)
      if (!all.has(f.id) && dependsOn(f).some((x) => all.has(x))) {
        all.add(f.id);
        changed = true;
      }
  } while (changed);
  all.delete(id);
  return [...all];
}

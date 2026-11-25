// Parts: the objects of a project. Each part has its own feature history (the features whose
// `part` is its id, in document order), a placement relative to its parent, and may have
// children that move with it. A part with `link` has no history: it shows what another part
// shows, in its own place (a linked copy). A part without features is a group.
//
// Pure functions of the document, used by the page and by the kernel worker alike.
import * as Mat from '../core/mat.js';

/** @typedef {{ id: string, name: string, parent: string | null, pos: number[], rot: number[],
 *              hidden?: boolean, link?: string }} Part */

export const PART_ID = /^o[1-9][0-9]*$/;
export const partById = (doc, id) => doc.parts.find((p) => p.id === id);
export const featuresOf = (doc, id) => doc.features.filter((f) => f.part === id);
export const childrenOf = (doc, id) => doc.parts.filter((p) => (p.parent ?? null) === id);
export const localOf = (part) => Mat.fromPlacement(part.pos, part.rot);

/** The ids of a part's parent, grandparent, ... (stops at a loop, which validation refuses). */
export function ancestorsOf(doc, id) {
  const out = [];
  for (let p = partById(doc, id)?.parent; p && !out.includes(p) && p !== id; p = partById(doc, p)?.parent) out.push(p);
  return out;
}

/** The ids of everything under a part, nearest first. */
export function descendantsOf(doc, id) {
  const out = [];
  for (let i = -1; i < out.length; i++)
    for (const c of childrenOf(doc, i < 0 ? id : out[i])) if (c.id !== id && !out.includes(c.id)) out.push(c.id);
  return out;
}

/** Parents before children, siblings in document order: the order of the browser's tree. */
export function treeOrder(doc) {
  const out = [],
    walk = (parent, depth) => {
      for (const p of childrenOf(doc, parent))
        if (!out.some((x) => x.part === p)) {
          out.push({ part: p, depth });
          walk(p.id, depth + 1);
        }
    };
  walk(null, 0);
  // Parts whose parent is missing are shown at the top level rather than lost.
  for (const p of doc.parts) if (!out.some((x) => x.part === p)) out.push({ part: p, depth: 0 });
  return out;
}

const worlds = new WeakMap();
/** Where every part stands in the world: Map id -> matrix. */
export function worldOf(doc) {
  let map = worlds.get(doc);
  if (map) return map;
  map = new Map();
  const visit = (p, seen) => {
    if (map.has(p.id)) return map.get(p.id);
    const parent = p.parent && !seen.includes(p.parent) ? partById(doc, p.parent) : null;
    const m = parent ? Mat.mul(visit(parent, [...seen, p.id]), localOf(p)) : localOf(p);
    map.set(p.id, m);
    return m;
  };
  for (const p of doc.parts) visit(p, []);
  worlds.set(doc, map);
  return map;
}

/** A new part and the document with its counter advanced (the part is not yet in it). */
export function makePart(doc, data = {}) {
  const id = 'o' + ((doc.pseq ?? 0) + 1),
    base = data.base ?? 'Part';
  const n = 1 + Math.max(0, ...doc.parts.map((p) => (p.name.startsWith(base + ' ') ? Number(p.name.slice(base.length + 1).match(/^(\d+)$/)?.[1] ?? 0) : 0)));
  const { base: _, ...rest } = data;
  return {
    part: { id, name: `${base} ${n}`, parent: null, pos: [0, 0, 0], rot: [0, 0, 0], ...rest },
    doc: { ...doc, pseq: (doc.pseq ?? 0) + 1 },
  };
}

export function addPart(doc, part) {
  if (partById(doc, part.id)) throw Error('Part id already exists.');
  return { ...doc, pseq: Math.max(doc.pseq ?? 0, Number(part.id.slice(1))), parts: [...doc.parts, part] };
}

export const updatePart = (doc, id, patch) => ({
  ...doc,
  parts: doc.parts.map((p) => (p.id === id ? (typeof patch === 'function' ? patch(p) : { ...p, ...patch, id: p.id }) : p)),
});

/** Removes a part, everything under it, and their features. */
export function removePart(doc, id) {
  const gone = new Set([id, ...descendantsOf(doc, id)]),
    features = doc.features.filter((f) => !gone.has(f.part)),
    bodies = { ...doc.bodies };
  for (const f of doc.features) if (gone.has(f.part)) delete bodies[f.id];
  return { ...doc, parts: doc.parts.filter((p) => !gone.has(p.id)), features, bodies };
}

/** What would be left hanging if a part were removed: linked copies of it (or of anything under
 *  it) elsewhere, and combine features elsewhere that use it. */
export function partDependents(doc, id) {
  const gone = new Set([id, ...descendantsOf(doc, id)]);
  return {
    links: doc.parts.filter((p) => p.link && gone.has(p.link) && !gone.has(p.id)).map((p) => p.id),
    features: doc.features.filter((f) => f.type === 'combine' && !gone.has(f.part) && (f.tools ?? []).some((t) => gone.has(t))).map((f) => f.id),
  };
}

/** Moves a part under another (or to the top with null). keepWorld: it stays where it is in space. */
export function setParent(doc, id, parent, keepWorld = true) {
  const part = partById(doc, id);
  if (!part) throw Error(`There is no part "${id}".`);
  parent = parent ?? null;
  if (parent !== null) {
    if (!partById(doc, parent)) throw Error(`There is no part "${parent}".`);
    if (parent === id || descendantsOf(doc, id).includes(parent)) throw Error('A part cannot be placed under itself.');
  }
  if ((part.parent ?? null) === parent) return doc;
  let placement = {};
  if (keepWorld) {
    const world = worldOf(doc),
      local = parent ? Mat.mul(Mat.invert(world.get(parent)), world.get(id)) : world.get(id);
    placement = Mat.toPlacement(local);
  }
  return updatePart(doc, id, { parent, ...placement });
}

/** Gives a part the world placement `m`, whatever its parent. */
export function setWorld(doc, id, m) {
  const part = partById(doc, id),
    world = worldOf(doc),
    local = part.parent ? Mat.mul(Mat.invert(world.get(part.parent)), m) : m;
  return updatePart(doc, id, Mat.toPlacement(local));
}

/** Parts that a combine feature (not suppressed, not keeping its tools) uses up: Map tool -> the part using it. */
export function consumedIn(doc) {
  const out = new Map();
  for (const f of doc.features)
    if (f.type === 'combine' && !f.suppressed && !f.keep) for (const t of f.tools ?? []) if (!out.has(t)) out.set(t, f.part);
  return out;
}

/**
 * What a part contains, as solids: its own bodies and those of everything under it that has
 * not been used up as a tool, a linked copy standing for what it links to.
 * @returns {{ from: string, rel: number[] }[]}  the bodies of part `from`, placed by `rel` in this part's frame
 */
export function contentOf(doc, id, consumed = consumedIn(doc), stack = []) {
  const part = partById(doc, id);
  if (!part || stack.includes(id)) return [];
  const next = [...stack, id],
    out = part.link ? contentOf(doc, part.link, consumed, next) : [{ from: id, rel: Mat.IDENTITY }];
  for (const child of childrenOf(doc, id)) {
    if (consumed.has(child.id)) continue;
    const local = localOf(child);
    for (const item of contentOf(doc, child.id, consumed, next)) out.push({ from: item.from, rel: Mat.mul(local, item.rel) });
  }
  return out;
}

/** The parts whose finished bodies a part's combine features need. */
export function toolSources(doc, id, consumed = consumedIn(doc)) {
  const out = new Set();
  for (const f of doc.features)
    if (f.part === id && f.type === 'combine' && !f.suppressed)
      for (const t of f.tools ?? []) for (const item of contentOf(doc, t, consumed)) out.add(item.from);
  return out;
}

/** The parts with a history, each after the parts it takes tools from. `cyclic`: parts that
 *  would be built from themselves. */
export function buildOrder(doc) {
  const consumed = consumedIn(doc),
    state = new Map(),
    order = [],
    cyclic = new Set();
  const visit = (id, path) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      for (const x of path.slice(path.indexOf(id))) cyclic.add(x);
      return;
    }
    state.set(id, 1);
    for (const d of toolSources(doc, id, consumed)) if (partById(doc, d)) visit(d, [...path, id]);
    state.set(id, 2);
    order.push(id);
  };
  for (const p of doc.parts) if (!p.link) visit(p.id, []);
  return { order, cyclic };
}

/**
 * What is to be seen (and exported): one item per body per place it appears.
 * @param {{ id: string, part: string }[]} bodies  the bodies the kernel built, each with its part
 * @param {Map<string, string>} used  parts used up by a combine that was built (from the build)
 * @returns {object[]}  each body, with `matrix` (where it stands in the world); the bodies of a
 *   linked copy also with `instance: true`, their own `id`, `source` (the body's id) and `from`
 */
export function sceneOf(doc, bodies, used = new Map()) {
  const world = worldOf(doc),
    consumed = consumedIn(doc),
    byPart = new Map();
  for (const b of bodies) {
    if (!byPart.has(b.part)) byPart.set(b.part, []);
    byPart.get(b.part).push(b);
  }
  const shown = (part) => [part.id, ...ancestorsOf(doc, part.id)].every((id) => !partById(doc, id)?.hidden && !used.has(id));
  const items = [];
  for (const part of doc.parts) {
    if (!shown(part)) continue;
    const W = world.get(part.id);
    if (part.link)
      contentOf(doc, part.link, consumed).forEach((item, i) => {
        for (const b of byPart.get(item.from) ?? [])
          items.push({ ...b, id: `${part.id}~${i}~${b.id}`, part: part.id, source: b.id, from: item.from, instance: true, matrix: Mat.mul(W, item.rel) });
      });
    else for (const b of byPart.get(part.id) ?? []) if (!doc.bodies?.[b.id]?.hidden) items.push({ ...b, matrix: W });
  }
  return items;
}

// ------------------------------------------------------------------ copies
const FEATURE_REF = /^(f[1-9][0-9]*)(\/.*)?$/;
/** Every string in `value` that names a feature of `features` (an id, or a face label that starts
 *  with one) or a part of `parts` is renamed. Names given by people are left alone. */
function renamed(value, features, parts, key = '') {
  if (typeof value === 'string') {
    if (key === 'name') return value;
    const m = FEATURE_REF.exec(value);
    if (m && features.has(m[1])) return features.get(m[1]) + (m[2] ?? '');
    return parts.get(value) ?? value;
  }
  if (Array.isArray(value)) return value.map((v) => renamed(v, features, parts, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renamed(v, features, parts, k)]));
  return value;
}

const copyName = (doc, name) => {
  const base = name.replace(/ copy( \d+)?$/, '');
  for (let n = 1; ; n++) {
    const candidate = base + ' copy' + (n > 1 ? ' ' + n : '');
    if (!doc.parts.some((p) => p.name === candidate)) return candidate;
  }
};

/**
 * A copy of a part. linked: a part that shows the original wherever it is placed and changes
 * with it. Otherwise a copy of its own: the part, everything under it and all their features,
 * with new ids, free to change. The copy stands where the original stands.
 * @returns {{ doc: object, id: string }}
 */
export function copyPart(doc, id, { linked = false } = {}) {
  const source = partById(doc, id);
  if (!source) throw Error(`There is no part "${id}".`);
  if (linked || source.link) {
    const made = makePart(doc, { name: copyName(doc, source.name), parent: source.parent ?? null, pos: [...source.pos], rot: [...source.rot], link: source.link ?? source.id });
    return { doc: addPart(made.doc, made.part), id: made.part.id };
  }
  const ids = [id, ...descendantsOf(doc, id)],
    parts = new Map(),
    features = new Map();
  let pseq = doc.pseq ?? 0,
    seq = doc.seq;
  for (const p of ids) parts.set(p, 'o' + ++pseq);
  for (const f of doc.features) if (parts.has(f.part)) features.set(f.id, 'f' + ++seq);
  const newParts = ids.map((p) => {
    const old = partById(doc, p),
      copy = renamed(old, features, parts);
    return p === id ? { ...copy, name: copyName(doc, old.name), parent: old.parent ?? null } : copy;
  });
  const newFeatures = doc.features.filter((f) => parts.has(f.part)).map((f) => renamed(f, features, parts));
  const bodies = { ...doc.bodies };
  for (const [from, to] of features) if (doc.bodies?.[from]) bodies[to] = structuredClone(doc.bodies[from]);
  return {
    doc: { ...doc, seq, pseq, parts: [...doc.parts, ...newParts], features: [...doc.features, ...newFeatures], bodies },
    id: parts.get(id),
  };
}

/** Turns a linked copy into a copy of its own, in the same place and under the same name. */
export function unlinkPart(doc, id) {
  const link = partById(doc, id);
  if (!link?.link) throw Error('This part is not a linked copy.');
  if (!partById(doc, link.link)) throw Error('The part this copy is linked to no longer exists.');
  const copied = copyPart(doc, link.link);
  let next = updatePart(copied.doc, copied.id, (p) => {
    const { hidden, ...rest } = p;
    return { ...rest, name: link.name, parent: link.parent ?? null, pos: [...link.pos], rot: [...link.rot], ...(link.hidden ? { hidden: true } : {}) };
  });
  // What stood under the link now stands under the copy; other links to the link's source are untouched.
  next = { ...next, parts: next.parts.filter((p) => p.id !== id).map((p) => (p.parent === id ? { ...p, parent: copied.id } : p)) };
  next = { ...next, features: next.features.map((f) => (f.type === 'combine' && f.tools?.includes(id) ? { ...f, tools: f.tools.map((t) => (t === id ? copied.id : t)) } : f)) };
  return { doc: next, id: copied.id };
}

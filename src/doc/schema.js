import { DocError } from '../core/errors.js';
import { validateFeature } from './features.js';
import { PART_ID } from './parts.js';

const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

/**
 * A document in the current format. Format 1 had one history for the whole project: its
 * features become the history of one part. A feature without a part (a document put together
 * by hand) is given to the first part with a history, which is made if there is none.
 * Returns the same object when there is nothing to do.
 */
export function upgrade(doc) {
  if (!doc || typeof doc !== 'object' || doc.format !== 'corecad' || ![1, 2].includes(doc.version)) return doc;
  if (!Array.isArray(doc.features)) return doc;
  const parts = Array.isArray(doc.parts) ? doc.parts : [];
  if (doc.version === 2 && Array.isArray(doc.parts) && Number.isSafeInteger(doc.pseq) && doc.features.every((f) => !f || typeof f.part === 'string')) return doc;
  let pseq = Number.isSafeInteger(doc.pseq) ? doc.pseq : 0;
  for (const p of parts) if (PART_ID.test(p?.id ?? '')) pseq = Math.max(pseq, Number(p.id.slice(1)));
  let home = parts.find((p) => p && !p.link)?.id;
  const made = [];
  if (!home && doc.features.some((f) => f && typeof f.part !== 'string')) {
    home = 'o' + ++pseq;
    made.push({ id: home, name: 'Part 1', parent: null, pos: [0, 0, 0], rot: [0, 0, 0] });
  }
  return {
    ...doc,
    version: 2,
    pseq,
    parts: [...parts, ...made],
    features: doc.features.map((f) => (f && typeof f.part !== 'string' ? { ...f, part: home } : f)),
  };
}

export function validateDocument(doc) {
  if (!doc || typeof doc !== 'object' || doc.format !== 'corecad')
    return ['This is not a CoreCAD project.'];
  if (![1, 2].includes(doc.version))
    return [`Unsupported project format ${doc.version}. This CoreCAD reads formats 1 and 2.`];
  doc = upgrade(doc);
  if (!Array.isArray(doc.features) || !Number.isSafeInteger(doc.seq) || doc.seq < 0)
    return ['Invalid features list or sequence counter.'];
  if (
    !doc.meta ||
    typeof doc.meta.id !== 'string' ||
    typeof doc.meta.name !== 'string' ||
    !doc.meta.name.trim()
  )
    return ['The project needs an id and name.'];
  if (!doc.bodies || typeof doc.bodies !== 'object' || Array.isArray(doc.bodies))
    return ['Invalid body settings.'];
  if (!Array.isArray(doc.parts) || !Number.isSafeInteger(doc.pseq) || doc.pseq < 0)
    return ['Invalid parts list or part counter.'];
  const errors = [],
    parts = new Map();
  for (const p of doc.parts) {
    if (!p || !PART_ID.test(p.id ?? '') || Number(p.id.slice(1)) > doc.pseq || parts.has(p.id)) {
      errors.push('Invalid or duplicate part id.');
      continue;
    }
    parts.set(p.id, p);
    const name = typeof p.name === 'string' && p.name.trim() ? p.name : p.id;
    if (name === p.id) errors.push(`${p.id}: a part needs a name.`);
    if (!vec3(p.pos) || !vec3(p.rot)) errors.push(`${name}: the placement needs a position and a rotation of three numbers each.`);
    if (!(p.parent === null || p.parent === undefined || typeof p.parent === 'string')) errors.push(`${name}: invalid parent.`);
    if (!(p.link === undefined || (typeof p.link === 'string' && PART_ID.test(p.link)))) errors.push(`${name}: invalid link.`);
    if (!(p.hidden === undefined || typeof p.hidden === 'boolean')) errors.push(`${name}: hidden must be true or false.`);
  }
  for (const p of parts.values()) {
    const name = p.name || p.id;
    if (p.parent && !parts.has(p.parent)) errors.push(`${name}: its parent does not exist.`);
    const seen = new Set([p.id]);
    for (let q = p.parent; q && parts.has(q); q = parts.get(q).parent) {
      if (seen.has(q)) {
        errors.push(`${name}: a part cannot be placed under itself.`);
        break;
      }
      seen.add(q);
    }
    if (p.link === p.id) errors.push(`${name}: a linked copy cannot link to itself.`);
    if (p.link && parts.get(p.link)?.link) errors.push(`${name}: a linked copy links to a part with a history, not to another copy.`);
  }
  const ids = new Set();
  for (const f of doc.features) {
    if (!f || !/^f[1-9][0-9]*$/.test(f.id) || Number(f.id.slice(1)) > doc.seq || ids.has(f.id)) {
      errors.push('Invalid or duplicate feature id.');
      continue;
    }
    ids.add(f.id);
    errors.push(...validateFeature(f).map((msg) => `${f.name || f.id}: ${msg}`));
    const part = parts.get(f.part);
    if (!part) errors.push(`${f.name || f.id}: it belongs to no part.`);
    else if (part.link) errors.push(`${f.name || f.id}: a linked copy has no features of its own.`);
    const sketch = f.sketch ? doc.features.find((x) => x.id === f.sketch) : null;
    if (sketch && doc.features.indexOf(sketch) > doc.features.indexOf(f))
      errors.push(`${f.name}: the sketch must come before its extrusion.`);
    if (sketch && sketch.part !== f.part) errors.push(`${f.name}: the sketch must be in the same part as its extrusion.`);
  }
  return errors;
}

/** Reads a project file's text. A format 1 file comes back in format 2. */
export function parse(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new DocError('The project is not valid JSON.');
  }
  let errors;
  try {
    errors = validateDocument(doc);
  } catch {
    throw new DocError('The project contains malformed feature data.');
  }
  if (errors.length) throw new DocError(errors.join('\n'));
  return upgrade(doc);
}

export function serialize(doc) {
  const errors = validateDocument(doc);
  if (errors.length) throw new DocError(errors.join('\n'));
  return JSON.stringify(upgrade(doc), null, 1);
}

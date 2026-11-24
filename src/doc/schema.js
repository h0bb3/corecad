import { DocError } from '../core/errors.js';
import { validateFeature } from './features.js';
export function validateDocument(doc) {
  if (!doc || typeof doc !== 'object' || doc.format !== 'corecad') return ['This is not a CoreCAD project.'];
  if (doc.version !== 1) return [`Unsupported project format ${doc.version}. This CoreCAD reads format 1.`];
  if (!Array.isArray(doc.features) || !Number.isSafeInteger(doc.seq) || doc.seq < 0) return ['Invalid features list or sequence counter.'];
  if (!doc.meta || typeof doc.meta.id !== 'string' || typeof doc.meta.name !== 'string' || !doc.meta.name.trim()) return ['The project needs an id and name.'];
  if (!doc.bodies || typeof doc.bodies !== 'object' || Array.isArray(doc.bodies)) return ['Invalid body settings.'];
  const ids = new Set(), errors = [];
  for (const f of doc.features) {
    if (!f || !/^f[1-9][0-9]*$/.test(f.id) || Number(f.id.slice(1)) > doc.seq || ids.has(f.id)) { errors.push('Invalid or duplicate feature id.'); continue; }
    ids.add(f.id);
    errors.push(...validateFeature(f).map(msg => `${f.name || f.id}: ${msg}`));
    if (f.sketch && doc.features.findIndex(x => x.id === f.sketch) > doc.features.indexOf(f)) errors.push(`${f.name}: the sketch must come before its extrusion.`);
  }
  return errors;
}
export function parse(text) {
  let doc; try { doc = JSON.parse(text); } catch { throw new DocError('The project is not valid JSON.'); }
  let errors; try { errors = validateDocument(doc); } catch { throw new DocError('The project contains malformed feature data.'); }
  if (errors.length) throw new DocError(errors.join('\n')); return doc;
}
export function serialize(doc) { const errors = validateDocument(doc); if (errors.length) throw new DocError(errors.join('\n')); return JSON.stringify(doc, null, 1); }

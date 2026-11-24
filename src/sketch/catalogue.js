import { indexSketch, pointsOf } from './model.js';
export const DIMENSIONS = ['distance', 'distancePL', 'radius', 'diameter', 'angle'];
export const CONSTRAINTS = ['coincident', 'pointOnLine', 'pointOnCircle', 'horizontal', 'vertical', 'parallel', 'perpendicular', 'tangent', 'equal', 'concentric', 'midpoint', 'fix', ...DIMENSIONS];
export function validateConstraint(s, c) {
  if (!CONSTRAINTS.includes(c.type)) return `Unknown constraint ${c.type}.`;
  if (!Array.isArray(c.refs)) return 'Constraint references must be an array.';
  const ix = indexSketch(s), refs = c.refs, P = id => !!ix.point(id), E = id => ix.entity(id), L = id => E(id)?.type === 'line', C = id => ['circle', 'arc'].includes(E(id)?.type);
  if (new Set(refs).size !== refs.length) return 'Pick two different things.';
  const [a, b] = refs;
  let valid = false;
  switch (c.type) {
    case 'coincident': case 'distance': valid = refs.length === 2 && P(a) && P(b); break;
    case 'horizontal': case 'vertical': valid = refs.length === 1 ? L(a) : refs.length === 2 && P(a) && P(b); break;
    case 'pointOnLine': case 'distancePL': case 'midpoint': valid = refs.length === 2 && P(a) && L(b); break;
    case 'pointOnCircle': valid = refs.length === 2 && P(a) && C(b); break;
    case 'parallel': case 'perpendicular': case 'angle': valid = refs.length === 2 && L(a) && L(b); break;
    case 'tangent': valid = refs.length === 2 && ((L(a) && C(b)) || (C(a) && L(b)) || (C(a) && C(b))); break;
    case 'equal': valid = refs.length === 2 && ((L(a) && L(b)) || (C(a) && C(b))); break;
    case 'concentric': valid = refs.length === 2 && C(a) && C(b); break;
    case 'radius': case 'diameter': valid = refs.length === 1 && C(a); break;
    case 'fix': valid = refs.length === 1 && (P(a) || E(a)); break;
  }
  if (!valid) return `The selected geometry cannot be used for ${c.type}.`;
  if (['pointOnLine', 'pointOnCircle', 'midpoint'].includes(c.type) && pointsOf(E(b)).includes(a)) return 'This point already belongs to that curve.';
  if (DIMENSIONS.includes(c.type) && (!Number.isFinite(c.value) || c.value <= 1e-6 || (c.type === 'angle' && c.value >= 360))) return 'Enter a positive finite size (angles must be between 0 and 360 degrees).';
  if (c.mode !== undefined && !['h', 'v', 'aligned'].includes(c.mode)) return 'Unknown distance mode.';
  if (c.dir !== undefined && ![1, -1].includes(c.dir)) return 'Dimension direction must be 1 or -1.';
  if (c.side !== undefined && ![1, -1].includes(c.side)) return 'Constraint side must be 1 or -1.';
  return null;
}
export function validateSketch(s) {
  if (!s || !['points', 'entities', 'constraints'].every(k => Array.isArray(s[k])) || !Number.isSafeInteger(s.seq) || s.seq < 0) return ['Invalid sketch arrays or sequence counter.'];
  const errors = [], ids = new Set(['origin']);
  for (const [kind, list] of [['p', s.points], ['e', s.entities], ['c', s.constraints]]) for (const x of list) {
    if (!x || !new RegExp(`^${kind}[1-9][0-9]*$`).test(x.id) || Number(x.id.slice(1)) > s.seq || ids.has(x.id)) errors.push('Invalid or duplicate sketch id.');
    ids.add(x?.id);
  }
  if (errors.length) return errors;
  for (const p of s.points) if (![p.x, p.y].every(Number.isFinite)) errors.push(`Point ${p.id} has invalid coordinates.`);
  const ix = indexSketch(s);
  for (const e of s.entities) {
    if (!['point', 'line', 'circle', 'arc'].includes(e.type) || pointsOf(e).some(id => !ix.point(id))) errors.push(`Entity ${e.id} has invalid points or type.`);
    if (e.type === 'circle' && !(Number.isFinite(e.r) && e.r > 0)) errors.push(`Circle ${e.id} has invalid radius.`);
  }
  if (!errors.length) for (const c of s.constraints) { const msg = validateConstraint(s, c); if (msg) errors.push(`${c.id}: ${msg}`); }
  return errors;
}

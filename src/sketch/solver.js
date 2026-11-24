import * as N from './solver/numerics.js';
import { cloneSketch, addConstraint, indexSketch, pointsOf } from './model.js';
import { validateSketch, validateConstraint } from './catalogue.js';

// The numerical engine uses a flat variable table. Only this adapter knows that
// representation; files, editing operations and kernel profiles use the public model.
export function numericalSketch(s) {
  const ix = indexSketch(s), pointRef = id => ix.entity(id)?.type === 'point' ? ix.entity(id).p : id;
  return { nextId: s.seq + 1, entities: [{ id: 'origin', type: 'point', x: 0, y: 0, fixed: true },
    ...s.points.map(p => ({ ...p, type: 'point' })),
    ...s.entities.filter(e => e.type !== 'point').map(e => e.type === 'line' ? { ...e, p1: e.a, p2: e.b } : e.type === 'arc' ? { ...e, s: e.a, e: e.b } : { ...e })],
    constraints: s.constraints.filter(c => !c.off && !c.driven).map(c => {
      let [a, b] = c.refs.map(pointRef); const out = { ...c, a, b, dir: c.dir ?? 1, side: c.side ?? 1 };
      if (['horizontal', 'vertical'].includes(c.type) && c.refs.length === 1) out.l = a;
      if (['midpoint', 'pointOnLine', 'distancePL'].includes(c.type)) { out.p = a; out.l = b; }
      if (c.type === 'pointOnCircle') { out.p = a; out.c = b; }
      if (['radius', 'diameter'].includes(c.type)) out.c = a;
      if (c.type === 'fix') out.e = a;
      if (c.type === 'tangent') { if (ix.entity(b)?.type === 'line') { out.a = b; out.b = a; } out.mode = c.inside ? 'int' : 'ext'; }
      return out;
    }) };
}
function written(source, numeric) {
  const values = new Map(numeric.entities.map(e => [e.id, e]));
  return { ...source, points: source.points.map(p => ({ ...p, x: values.get(p.id).x, y: values.get(p.id).y })),
    entities: source.entities.map(e => e.type === 'circle' ? { ...e, r: values.get(e.id).r } : { ...e }) };
}
export function analyseSketch(s) {
  const n = N.analyseSketch(numericalSketch(s));
  const states = { ...n.states, origin: 'fixed' };
  for (const e of s.entities) if (e.type === 'point') states[e.id] = states[e.p];
  for (const c of s.constraints) if (c.type === 'fix' && !c.off) for (const id of c.refs) {
    states[id] = 'fixed'; const e = indexSketch(s).entity(id); if (e) pointsOf(e).forEach(p => { states[p] = 'fixed'; });
  }
  return { dof: n.dof, states, redundant: [...n.issues.filter(i => i.kind === 'redundant'), ...n.dependent], issues: n.issues, n: n.n, m: n.m };
}
export function solveSketch(s) {
  const errors = validateSketch(s); if (errors.length) return failure(s, 'invalid', [], errors[0]);
  const r = N.solveSketch(numericalSketch(s));
  if (!r.ok) return failure(s, r.reason, r.blame, undefined, r.reached);
  const sketch = written(s, r.sketch), analysis = analyseSketch(sketch);
  if (analysis.redundant.length) return failure(s, 'redundant', analysis.redundant.flatMap(d => [d.id, ...d.blame]));
  return { ok: true, sketch, analysis, steps: r.steps };
}
function failure(s, reason, blame = [], message, reached) {
  const names = [...new Set(blame)].filter(id => !id.startsWith('_')).join(', ');
  return { ok: false, sketch: s, reason, blame, reached, message: message ?? ({ redundant: 'Already determined by the existing constraints.', conflict: 'These constraints cannot be satisfied together.', degenerate: 'That change would collapse geometry to a point.', invalid: 'Invalid constraint.' }[reason] + (names ? ` Check ${names}.` : '')) };
}
export function tryAddConstraint(s, constraint) {
  const error = validateConstraint(s, constraint); if (error) return failure(s, 'invalid', [], error);
  const t = cloneSketch(s), id = addConstraint(t, constraint), r = solveSketch(t);
  return r.ok ? { ...r, id } : { ...r, sketch: s };
}
export function setDimensions(s, changes) {
  const t = cloneSketch(s);
  for (const { id, value } of changes) { const c = t.constraints.find(c => c.id === id); if (!c || c.driven) return failure(s, 'invalid', [], 'Reference dimensions are measured, not edited.'); c.value = value; }
  const r = solveSketch(t); return r.ok ? r : { ...r, sketch: s };
}
export function beginDrag(s, grab, { pxPerMm = 4 } = {}) {
  const ix = indexSketch(s), entity = ix.entity(grab.id), id = entity?.type === 'point' ? entity.p : grab.id;
  const an = analyseSketch(s), locked = an.states[grab.id] !== 'free';
  let current = s, cancelled = false;
  const distances = s.points.map(p => Math.hypot(p.x - grab.at[0], p.y - grab.at[1])).filter(d => d > 1e-6);
  const step = Math.max(4 / pxPerMm, .25 * Math.min(20, ...distances));
  const drag = locked ? null : N.beginDrag(numericalSketch(s), { ...grab, id }, { maxStep: step });
  return { locked,
    move(pos) {
      if (locked || cancelled) return { arrived: true, stuck: true };
      const result = drag.move(pos), next = written(s, drag.sketch());
      // Never publish a collapsed or unsolved frame, even at a singular drag position.
      const verified = N.solveSketch(numericalSketch(next), { plain: true });
      if (verified.ok) current = written(s, verified.sketch);
      return result;
    }, sketch: () => current,
    end: () => cancelled || JSON.stringify(current) === JSON.stringify(s) ? null : current,
    cancel: () => { cancelled = true; current = s; } };
}

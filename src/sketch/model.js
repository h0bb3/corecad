export const createSketch = () => ({ points: [], entities: [], constraints: [], seq: 0 });
export const cloneSketch = s => structuredClone(s);
export const nextId = (s, kind) => kind + (++s.seq);
export function addPoint(s, x, y) { const id = nextId(s, 'p'); s.points.push({ id, x, y }); return id; }
function entity(s, data, opts = {}) { const id = nextId(s, 'e'); s.entities.push({ id, ...data, ...opts }); return { id, ...data }; }
export function addLine(s, x1, y1, x2, y2, opts) { return entity(s, { type: 'line', a: addPoint(s, x1, y1), b: addPoint(s, x2, y2) }, opts); }
export function addCircle(s, x, y, r, opts) { return entity(s, { type: 'circle', c: addPoint(s, x, y), r }, opts); }
export function addArc(s, cx, cy, ax, ay, bx, by, opts) { return entity(s, { type: 'arc', c: addPoint(s, cx, cy), a: addPoint(s, ax, ay), b: addPoint(s, bx, by) }, opts); }
export function addPointEntity(s, x, y) { return entity(s, { type: 'point', p: addPoint(s, x, y) }); }
export function addConstraint(s, c) { const id = nextId(s, 'c'); s.constraints.push({ ...c, refs: [...c.refs], id }); return id; }
export const pointsOf = e => e.type === 'line' ? [e.a, e.b] : e.type === 'circle' ? [e.c] : e.type === 'arc' ? [e.c, e.a, e.b] : [e.p];
export function indexSketch(s) {
  const ps = new Map(s.points.map(p => [p.id, p])), es = new Map(s.entities.map(e => [e.id, e]));
  ps.set('origin', { id: 'origin', x: 0, y: 0 });
  return { point: id => ps.get(id), entity: id => es.get(id), constraint: id => s.constraints.find(c => c.id === id),
    ownerOf: id => s.entities.find(e => pointsOf(e).includes(id)), pointsOf,
    constraintsOn: id => s.constraints.filter(c => c.refs.includes(id)) };
}
export function at(s, id) { const p = indexSketch(s).point(id); if (!p) throw Error(`Unknown point ${id}`); return [p.x, p.y]; }
export function addRectangle(s, a, b) {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  const ls = [addLine(s, x0, y0, x1, y0), addLine(s, x1, y0, x1, y1), addLine(s, x1, y1, x0, y1), addLine(s, x0, y1, x0, y0)];
  ls.forEach((l, i) => addConstraint(s, { type: 'coincident', refs: [l.b, ls[(i + 1) % 4].a] }));
  ls.forEach((l, i) => addConstraint(s, { type: i % 2 ? 'vertical' : 'horizontal', refs: [l.id] }));
  return ls;
}
export function normalizeSketch(s) {
  const t = cloneSketch(s), used = new Set();
  for (const e of t.entities) for (const key of ['a', 'b', 'c', 'p']) if (e[key]) {
    const id = e[key];
    if (used.has(id)) { const p = indexSketch(t).point(id); e[key] = addPoint(t, p.x, p.y); addConstraint(t, { type: 'coincident', refs: [id, e[key]] }); }
    used.add(e[key]);
  }
  return t;
}
/** Remove geometry and all dangling references. Keep coordinates of surviving geometry. */
export function removeItems(s, ids) {
  const t = cloneSketch(s), gone = new Set(ids), ix = indexSketch(t);
  for (const id of ids) { const e = ix.entity(id); if (e) pointsOf(e).forEach(p => gone.add(p)); }
  // Shared points in imported documents must survive their remaining owner.
  for (const e of t.entities) if (!gone.has(e.id)) for (const p of pointsOf(e)) gone.delete(p);
  t.entities = t.entities.filter(e => !gone.has(e.id));
  t.points = t.points.filter(p => !gone.has(p.id));
  t.constraints = t.constraints.filter(c => !gone.has(c.id) && !c.refs.some(id => gone.has(id)));
  return t;
}

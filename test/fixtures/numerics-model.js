// Prototype of the sketch data model (scratch; see .scratch/design/sketch-solver.md).
export function createSketch() {
  return { v: 1, nextId: 1, entities: [{ id: 'origin', type: 'point', x: 0, y: 0, fixed: true }], constraints: [] };
}
const nid = (s, p) => p + (s.nextId++);
export const clone = s => JSON.parse(JSON.stringify(s));
export function addPoint(s, x, y, o = {}) { const id = nid(s, 'p'); s.entities.push({ id, type: 'point', x, y, ...o }); return id; }
export function addLine(s, x1, y1, x2, y2, o = {}) {
  const p1 = addPoint(s, x1, y1), p2 = addPoint(s, x2, y2), id = nid(s, 'l');
  s.entities.push({ id, type: 'line', p1, p2, ...o });
  return { id, p1, p2 };
}
export function addCircle(s, cx, cy, r, o = {}) {
  const c = addPoint(s, cx, cy), id = nid(s, 'c');
  s.entities.push({ id, type: 'circle', c, r, ...o });
  return { id, c };
}
/** Counter-clockwise from (sx, sy) to (ex, ey). */
export function addArc(s, cx, cy, sx, sy, ex, ey, o = {}) {
  const c = addPoint(s, cx, cy), st = addPoint(s, sx, sy), en = addPoint(s, ex, ey), id = nid(s, 'a');
  s.entities.push({ id, type: 'arc', c, s: st, e: en, ...o });
  return { id, c, s: st, e: en };
}
export function addConstraint(s, c) { const id = nid(s, 'k'); s.constraints.push({ id, ...c }); return id; }
/** Four lines, corners joined, bottom and top horizontal, sides vertical. Returns the lines [bottom, right, top, left]. */
export function addRect(s, x0, y0, x1, y1) {
  const L = [addLine(s, x0, y0, x1, y0), addLine(s, x1, y0, x1, y1), addLine(s, x1, y1, x0, y1), addLine(s, x0, y1, x0, y0)];
  for (let i = 0; i < 4; i++) addConstraint(s, { type: 'coincident', a: L[i].p2, b: L[(i + 1) % 4].p1 });
  addConstraint(s, { type: 'horizontal', l: L[0].id }); addConstraint(s, { type: 'vertical', l: L[1].id });
  addConstraint(s, { type: 'horizontal', l: L[2].id }); addConstraint(s, { type: 'vertical', l: L[3].id });
  return L;
}
export const ent = (s, id) => s.entities.find(e => e.id === id);
export const pt = (s, id) => { const e = ent(s, id); return [e.x, e.y]; };

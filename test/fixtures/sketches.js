// Builders for test sketches. No imports: a sketch is plain data (docs/SPEC.md, section 4.2), and
// these write it directly, so every package can use them before any other package exists.
// They mutate the sketch they are given. Ids come from the sketch's one counter, `seq`.

/** An empty sketch. */
export const sk = () => ({ points: [], entities: [], constraints: [], seq: 0 });

const pt = (s, x, y) => { const id = 'p' + (++s.seq); s.points.push({ id, x, y }); return id; };
const ent = (s, e, opts) => {
  const id = 'e' + (++s.seq);
  s.entities.push({ id, ...e, ...(opts?.construction ? { construction: true } : {}) });
  return id;
};

/** A line. @returns {{ id: string, a: string, b: string }} */
export function line(s, x1, y1, x2, y2, opts) {
  const a = pt(s, x1, y1), b = pt(s, x2, y2);
  return { id: ent(s, { type: 'line', a, b }, opts), a, b };
}

/** A circle. @returns {{ id: string, c: string }} */
export function circle(s, cx, cy, r, opts) {
  const c = pt(s, cx, cy);
  return { id: ent(s, { type: 'circle', c, r }, opts), c };
}

/** An arc, counter-clockwise from (ax, ay) to (bx, by). @returns {{ id: string, c: string, a: string, b: string }} */
export function arc(s, cx, cy, ax, ay, bx, by, opts) {
  const c = pt(s, cx, cy), a = pt(s, ax, ay), b = pt(s, bx, by);
  return { id: ent(s, { type: 'arc', c, a, b }, opts), c, a, b };
}

/** A point entity. @returns {{ id: string, p: string }} */
export function point(s, x, y) {
  const p = pt(s, x, y);
  return { id: ent(s, { type: 'point', p }), p };
}

/** A constraint, written as it is: no validation and no solving. @returns {string} its id */
export function con(s, type, refs, params = {}) {
  const id = 'c' + (++s.seq);
  s.constraints.push({ id, type, refs: [...refs], ...params });
  return id;
}

/** A rectangle as the rectangle tool makes it: four lines counter-clockwise (bottom, right, top, left), the four
 *  corners coincident, bottom and top horizontal, right and left vertical. The corners are sorted, so the
 *  arguments may be any two opposite corners.
 *  @returns {{ id: string, a: string, b: string }[]} [bottom, right, top, left] */
export function rect(s, xa, ya, xb, yb) {
  const x0 = Math.min(xa, xb), x1 = Math.max(xa, xb), y0 = Math.min(ya, yb), y1 = Math.max(ya, yb);
  const L = [line(s, x0, y0, x1, y0), line(s, x1, y0, x1, y1), line(s, x1, y1, x0, y1), line(s, x0, y1, x0, y0)];
  for (let i = 0; i < 4; i++) con(s, 'coincident', [L[i].b, L[(i + 1) % 4].a]);
  con(s, 'horizontal', [L[0].id]);
  con(s, 'vertical', [L[1].id]);
  con(s, 'horizontal', [L[2].id]);
  con(s, 'vertical', [L[3].id]);
  return L;
}

/** The coordinates of a point ('origin' is [0, 0]). */
export function at(s, pointId) {
  if (pointId === 'origin') return [0, 0];
  const p = s.points.find(q => q.id === pointId);
  if (!p) throw new Error('no point ' + pointId);
  return [p.x, p.y];
}

/** An entity or a constraint by id. */
export const byId = (s, id) => s.entities.find(e => e.id === id) ?? s.constraints.find(c => c.id === id);

/** The fully constrained 60 x 40 plate sketch of SPEC 4.2 (rectangle tied to the origin, width and height). */
export function plateSketch() {
  const s = sk();
  const [bottom, right] = rect(s, 0, 0, 60, 40);
  con(s, 'coincident', [bottom.a, 'origin']);
  con(s, 'distance', [bottom.a, bottom.b], { mode: 'h', dir: 1, value: 60, label: [0, -8] });
  con(s, 'distance', [right.a, right.b], { mode: 'v', dir: 1, value: 40, label: [8, 0] });
  return s;
}

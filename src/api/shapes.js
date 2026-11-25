// Shapes for scripts and agents: "a 60 x 40 rectangle at the origin", "a circle of
// diameter 8 at (20, 10)" turned into sketch geometry WITH the constraints and
// dimensions a person would have given it, so that the sketch a script made is as
// editable as one that was drawn. Pure: no DOM, no kernel.
import {
  cloneSketch,
  addLine,
  addCircle,
  addArc,
  addPointEntity,
  addConstraint,
  addRectangle,
  indexSketch,
  pointsOf,
} from '../sketch/model.js';
import { solveSketch, tryAddConstraint } from '../sketch/solver.js';
import { dimensionFrom } from '../sketch/measure.js';

const TIE = 1e-6; // ends closer than this are meant to be one corner

const pair = (v, what) => {
  if (!Array.isArray(v) || v.length !== 2 || !v.every(Number.isFinite))
    throw Error(`${what} must be [x, y] in millimetres.`);
  return v;
};
const size = (v, what) => {
  if (!Number.isFinite(v) || v <= 1e-6) throw Error(`${what} must be a positive number of millimetres.`);
  return v;
};

/** Ties point `p` to the origin so that it sits at exactly (x, y): the two dimensions a person would place. */
function locate(s, p, [x, y]) {
  if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) {
    addConstraint(s, { type: 'coincident', refs: ['origin', p] });
    return;
  }
  for (const [mode, v] of [
    ['h', x],
    ['v', y],
  ]) {
    // No offset along an axis: "straight above the origin" is a constraint, not a dimension of zero.
    if (Math.abs(v) < 1e-9)
      addConstraint(s, { type: mode === 'h' ? 'vertical' : 'horizontal', refs: ['origin', p] });
    else
      addConstraint(s, {
        type: 'distance',
        refs: ['origin', p],
        mode,
        dir: v > 0 ? 1 : -1,
        value: Math.abs(v),
        label: mode === 'v' ? [-8, 0] : [0, 8],
      });
  }
}

const builders = {
  /** { type: 'rectangle', corner: [x, y] | center: [x, y], width, height } */
  rectangle(s, shape, made) {
    const w = size(shape.width, 'A rectangle\'s width'),
      h = size(shape.height, 'A rectangle\'s height');
    const centred = shape.center !== undefined,
      at = pair(shape.center ?? shape.corner ?? [0, 0], 'A rectangle\'s corner or center');
    const [x0, y0] = centred ? [at[0] - w / 2, at[1] - h / 2] : at;
    const ls = addRectangle(s, [x0, y0], [x0 + w, y0 + h]); // bottom, right, top, left
    made.entities.push(...ls.map((l) => l.id));
    if (shape.construction) for (const l of ls) indexSketch(s).entity(l.id).construction = true;
    if (shape.dimension === false) return;
    addConstraint(s, dimensionFrom(s, [ls[0].id]));
    addConstraint(s, dimensionFrom(s, [ls[1].id]));
    if (!centred) return locate(s, ls[0].a, [x0, y0]);
    // A centred rectangle stays centred when its size changes: a diagonal whose middle is held.
    const diagonal = addLine(s, x0, y0, x0 + w, y0 + h, { construction: true });
    addConstraint(s, { type: 'coincident', refs: [ls[0].a, diagonal.a] });
    addConstraint(s, { type: 'coincident', refs: [ls[1].b, diagonal.b] });
    if (Math.abs(at[0]) < 1e-9 && Math.abs(at[1]) < 1e-9)
      addConstraint(s, { type: 'midpoint', refs: ['origin', diagonal.id] });
    else {
      const centre = addPointEntity(s, at[0], at[1]);
      addConstraint(s, { type: 'midpoint', refs: [centre.p, diagonal.id] });
      locate(s, centre.p, at);
    }
  },
  /** { type: 'circle', center: [x, y], diameter | radius } */
  circle(s, shape, made) {
    const c = pair(shape.center ?? [0, 0], 'A circle\'s center');
    const byRadius = shape.diameter === undefined,
      r = byRadius ? size(shape.radius, 'A circle\'s radius or diameter') : size(shape.diameter, 'A circle\'s diameter') / 2;
    const e = addCircle(s, c[0], c[1], r, shape.construction ? { construction: true } : undefined);
    made.entities.push(e.id);
    if (shape.dimension === false) return;
    addConstraint(s, {
      type: byRadius ? 'radius' : 'diameter',
      refs: [e.id],
      value: byRadius ? r : 2 * r,
      label: [r + 6, r + 6],
    });
    locate(s, e.c, c);
  },
  /** { type: 'line', from: [x, y], to: [x, y] } */
  line(s, shape, made) {
    const a = pair(shape.from, 'A line\'s from'),
      b = pair(shape.to, 'A line\'s to');
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) throw Error('A line needs two different end points.');
    const e = addLine(s, ...a, ...b, shape.construction ? { construction: true } : undefined);
    made.entities.push(e.id);
    if (shape.fix !== false) made.pin.push(e.id);
  },
  /** { type: 'polyline', points: [[x, y], ...], closed?: true } */
  polyline(s, shape, made) {
    const pts = (Array.isArray(shape.points) ? shape.points : []).map((p, i) => pair(p, `Point ${i + 1} of a polyline`));
    if (pts.length < 2) throw Error('A polyline needs at least two points.');
    const n = shape.closed ? pts.length : pts.length - 1;
    if (shape.closed && pts.length < 3) throw Error('A closed polyline needs at least three points.');
    for (let i = 0; i < n; i++)
      builders.line(s, { from: pts[i], to: pts[(i + 1) % pts.length], construction: shape.construction, fix: shape.fix }, made);
  },
  /** { type: 'arc', center: [x, y], from: [x, y], to: [x, y] }: counter-clockwise from `from` to `to` */
  arc(s, shape, made) {
    const c = pair(shape.center, 'An arc\'s center'),
      a = pair(shape.from, 'An arc\'s from'),
      b = pair(shape.to, 'An arc\'s to');
    const ra = Math.hypot(a[0] - c[0], a[1] - c[1]),
      rb = Math.hypot(b[0] - c[0], b[1] - c[1]);
    if (ra < 1e-6) throw Error('An arc needs a radius.');
    if (Math.abs(ra - rb) > 1e-6 * Math.max(1, ra))
      throw Error(`An arc's two ends must be equally far from its center (they are ${+ra.toFixed(6)} and ${+rb.toFixed(6)} mm).`);
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) throw Error('An arc\'s ends must differ; use a circle for a full turn.');
    const e = addArc(s, ...c, ...a, ...b, shape.construction ? { construction: true } : undefined);
    made.entities.push(e.id);
    if (shape.fix !== false) made.pinWhole.push(e.id);
  },
  /** { type: 'point', at: [x, y] } */
  point(s, shape, made) {
    const p = pair(shape.at, 'A point\'s at');
    const e = addPointEntity(s, ...p);
    made.entities.push(e.id);
    if (shape.fix !== false) locate(s, e.p, p);
  },
};

export const SHAPE_TYPES = Object.keys(builders);

/** Joins ends that lie on each other with `coincident`, as drawing with snapping would have. */
function joinEnds(s, fixedPoints) {
  const group = new Map(); // point id -> representative, through the coincident constraints there are
  const find = (id) => {
    while (group.has(id) && group.get(id) !== id) id = group.get(id);
    return id;
  };
  for (const c of s.constraints) if (c.type === 'coincident') group.set(find(c.refs[0]), find(c.refs[1]));
  const ends = s.entities.flatMap((e) => (e.type === 'line' || e.type === 'arc' ? [e.a, e.b] : []));
  const ix = indexSketch(s);
  for (let i = 0; i < ends.length; i++)
    for (let j = i + 1; j < ends.length; j++) {
      const a = ends[i],
        b = ends[j];
      if (find(a) === find(b)) continue;
      const p = ix.point(a),
        q = ix.point(b);
      if (Math.hypot(p.x - q.x, p.y - q.y) > TIE) continue;
      // Two ends that are both pinned already agree; saying so again would be a redundant constraint.
      if (fixedPoints.has(find(a)) && fixedPoints.has(find(b))) continue;
      const keep = fixedPoints.has(find(a)) || fixedPoints.has(find(b));
      addConstraint(s, { type: 'coincident', refs: [a, b] });
      group.set(find(a), find(b));
      if (keep) fixedPoints.add(find(b));
    }
}

/**
 * Adds shapes to a sketch (any object with points, entities, constraints, seq; it is not changed).
 * Rectangles and circles get their dimensions and are located from the origin, so they are fully
 * constrained and a person can change them by their numbers. Lines, polylines, arcs and points are
 * pinned where they are given (`fix: false` leaves one free; `dimension: false` leaves a rectangle
 * or circle free). Ends that meet are joined.
 * @returns {{ sketch: object, entities: string[], analysis: object }} the solved sketch, the ids of
 *   the entities made, and the solver's analysis (degrees of freedom).
 */
export function addShapes(sketch, shapes) {
  if (!Array.isArray(shapes) || !shapes.length) throw Error('Give at least one shape.');
  const s = cloneSketch(sketch),
    made = { entities: [], pin: [], pinWhole: [] };
  shapes.forEach((shape, i) => {
    const build = builders[shape?.type];
    if (!build) throw Error(`Shape ${i + 1}: unknown type "${shape?.type}". Known: ${SHAPE_TYPES.join(', ')}.`);
    try {
      build(s, shape, made);
    } catch (e) {
      throw Error(`Shape ${i + 1} (${shape.type}): ${e.message}`);
    }
  });
  // Arcs are pinned whole and first: an arc has an equation of its own, which pinning its three
  // points one by one would contradict or repeat.
  const fixed = new Set();
  for (const id of made.pinWhole) {
    addConstraint(s, { type: 'fix', refs: [id] });
    for (const p of pointsOf(indexSketch(s).entity(id))) fixed.add(p);
  }
  joinEnds(s, fixed);
  let solved = solveSketch(s);
  if (!solved.ok) throw Error('These shapes cannot be constrained as given: ' + solved.message);
  // Lines: pin each end that can still move, one at a time, never twice (ends that are joined are one point).
  for (const id of made.pin) {
    const e = indexSketch(solved.sketch).entity(id);
    for (const p of [e.a, e.b]) {
      if (solved.analysis.states[p] !== 'free') continue;
      const next = tryAddConstraint(solved.sketch, { type: 'fix', refs: [p] });
      if (next.ok) solved = next;
    }
  }
  return { sketch: solved.sketch, entities: made.entities, analysis: solved.analysis };
}

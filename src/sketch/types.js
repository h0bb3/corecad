// The shapes of the sketch package, as JSDoc typedefs. There is no code in this file.
// docs/SPEC.md section 3.2 is this file. Everything in src/sketch/ is pure: no DOM, no kernel, no three.js.

/** @typedef {import('../types.js').Vec2} Vec2 */

// ---------------------------------------------------------------------------------------------
// The sketch (docs/SPEC.md 4.2)
// ---------------------------------------------------------------------------------------------

/** @typedef {{ id: string, x: number, y: number }} SkPoint                                        'p7' */

/** @typedef {{ id: string, type: 'line',   a: string, b: string, construction?: true }
 *          | { id: string, type: 'circle', c: string, r: number, construction?: true }
 *          | { id: string, type: 'arc',    c: string, a: string, b: string, construction?: true }
 *          | { id: string, type: 'point',  p: string }} SkEntity                                  'e9'
 *  a, b, c, p are point ids. An arc runs counter-clockwise from a to b about c. */

/** @typedef {{ id: string, type: string, refs: string[],
 *              value?: number, driven?: true, off?: true, label?: Vec2,
 *              mode?: 'aligned'|'h'|'v', dir?: 1|-1, side?: 1|-1, inside?: boolean,
 *              flipA?: boolean, flipB?: boolean }} SkConstraint                                    'c12'
 *  type and refs: the catalogue (docs/SPEC.md 7.2). value: millimetres, or degrees for an angle. */

/** Any object with these four fields is "a sketch"; a SketchFeature is one. Functions of src/sketch/ read
 *  nothing else and return a new object with every other field copied through.
 *  @typedef {{ points: SkPoint[], entities: SkEntity[], constraints: SkConstraint[], seq: number }} Sketch */

/** @typedef {{ point: (id: string) => SkPoint | undefined,
 *              entity: (id: string) => SkEntity | undefined,
 *              constraint: (id: string) => SkConstraint | undefined,
 *              ownerOf: (pointId: string) => SkEntity | undefined,
 *              pointsOf: (entity: SkEntity) => string[],
 *              constraintsOn: (id: string) => SkConstraint[],
 *              classOf: (pointId: string) => string[],
 *              xy: (pointId: string) => Vec2 }} SketchIndex
 *  constraintsOn: the constraints whose refs include the id. classOf: the ids of the points tied to this one by
 *  `coincident` constraints (transitively, itself included, 'origin' included when tied to it), in creation order.
 *  xy: the coordinates of a point; [0, 0] for 'origin'. */

// ---------------------------------------------------------------------------------------------
// Solving (docs/SPEC.md 8)
// ---------------------------------------------------------------------------------------------

/** @typedef {{ dof: number,
 *              states: Object<string, 'free'|'full'|'fixed'>,
 *              redundant: { id: string, blame: string[] }[] }} Analysis
 *  states: by point id and by entity id ('origin' included). redundant is [] for every committed sketch. */

/** @typedef {{ ok: true, sketch: Sketch, analysis: Analysis, steps: number }
 *          | { ok: false, reason: 'redundant'|'conflict'|'degenerate'|'invalid',
 *              blame: string[], entity?: string, reached?: number, message?: string }} SolveResult
 *  blame: ids of the constraints in the way (an arc's own equation is named by the arc's entity id).
 *  entity: for 'degenerate', the entity that would collapse.
 *  reached: for a dimension change that failed, how far it got, 0..1 of the way. */

/** @typedef {{ constraint: SkConstraint, reason: 'redundant'|'conflict'|'degenerate'|'invalid',
 *              blame: string[], entity?: string, message?: string }} Rejection */

/** @typedef {{ ok: boolean, sketch: Sketch, analysis: Analysis | null, message?: string,
 *              blame?: string[], created?: string[], reason?: string, reached?: number }} OpResult
 *  The answer of every operation of sketch/ops.js. ok false: `sketch` is the sketch that was passed in (the same
 *  object), `message` is the sentence for the user, `blame` what to flash. created: ids of what was added. */

/** @typedef {{ id: string, part: 'point'|'body'|'rim', at: Vec2 }} Grab       id: a point id or an entity id */

/** @typedef {{ locked: boolean,
 *              move: (pos: Vec2) => { arrived: boolean, stuck: boolean },
 *              points: () => Float64Array, radii: () => Float64Array,
 *              end: () => Sketch | null, cancel: () => void }} DragSession
 *  points(): x, y of every point in the order of sketch.points. radii(): r of every circle in the order of the
 *  circle entities in sketch.entities. end(): the new sketch, or null when nothing moved. */

// ---- the solver's insides (shared by solver/system.js, lm.js, analyse.js, continuation.js, drag.js)

/** @typedef {{ kind: 'redundant'|'conflict'|'degenerate', id: string, blame: string[] }} Issue
 *  id: the constraint (or, for 'degenerate', the entity) at fault. */

/** @typedef {{ id: string, kind: 'len'|'ang', cols: Int32Array, vals: Float64Array,
 *              slots: Int32Array, consts: Float64Array, fn: (v: Float64Array, g: Float64Array) => number }} Equation
 *  id: the constraint's id, or 'arc:' + the entity id for an arc's own equation.
 *  cols / vals: the sparse gradient row over the unknowns (cols ascending, no duplicates; vals filled by eval).
 *  slots / consts: per local variable its unknown (or -1) and its offset or constant.
 *  fn: fills g (the local gradient, zeroed by the caller) and returns the residual at the local values v. */

/** @typedef {{ eqs: Int32Array, vars: Int32Array, work: any }} Component
 *  A group of equations that share unknowns; eqs and vars ascending. work: scratch space of the numerics, null at first. */

/** @typedef {{ n: number, m: number, X0: Float64Array, eqs: Equation[], comps: Component[],
 *              issues: Issue[], scale: number,
 *              k: Int32Array, c: Float64Array,
 *              evalEq: (i: number, X: Float64Array, wantJ: boolean) => number,
 *              eval: (X: Float64Array, f: Float64Array, wantJ: boolean) => void,
 *              full: (X: Float64Array, out?: Float64Array) => Float64Array,
 *              write: (X: Float64Array, sketch: Sketch) => Sketch,
 *              varsOf: (pointId: string) => [number, number],
 *              radiusVarOf: (circleId: string) => number,
 *              unknownOf: (scalarVar: number) => number,
 *              samePoint: (p: string, q: string) => boolean,
 *              groundBlame: (scalarVar: number) => string[] }} System
 *  n unknowns, m equations. Scalar variables are numbered: for the i-th point of sketch.points 2i (x) and 2i + 1 (y);
 *  then 2P and 2P + 1 for 'origin'; then one per circle entity (r), in entity order; then two per temporary point.
 *  Scalar variable i has the value (k[i] >= 0 ? X[k[i]] : 0) + c[i].  docs/SPEC.md 8.2, 8.6. */

/** @typedef {{ dof: number, rank: number, free: Float64Array,
 *              dependent: { eq: number, blame: number[] }[] }} RankInfo
 *  free[u]: how much unknown u takes part in the free motions (0 = determined). dependent: equations whose
 *  gradient depends on those before them, with the equations they depend on. docs/SPEC.md 8.11. */

// ---------------------------------------------------------------------------------------------
// Profiles (docs/SPEC.md 10)
// ---------------------------------------------------------------------------------------------

/** @typedef {{ entity: string, kind: 'line',   a: Vec2, b: Vec2 }
 *          | { entity: string, kind: 'arc',    a: Vec2, b: Vec2, c: Vec2, ccw: boolean, m: Vec2, r: number }
 *          | { entity: string, kind: 'circle', c: Vec2, r: number, ccw: boolean }} Piece
 *  arc: travelled from a to b, counter-clockwise when ccw; m is the point half way along; r = |a - c|.
 *  circle: a whole circle; ccw true in an outer loop, false in a hole. */
/** @typedef {Piece[]} Loop       closed and in order: piece[i].b and piece[i + 1].a are the same two numbers */
/** @typedef {{ key: string, sides: string, outer: Loop, holes: Loop[], area: number, inside: Vec2 }} Region
 *  outer runs counter-clockwise, holes clockwise. key: the entity ids of the outer loop, each once, in id order,
 *  joined with ','. sides: docs/SPEC.md 10.5. inside: a point strictly inside (not in a hole). */

// ---------------------------------------------------------------------------------------------
// Snapping, tools (docs/SPEC.md 9)
// ---------------------------------------------------------------------------------------------

/** @typedef {{ sketch: Sketch, pxPerMm: number, from?: Vec2,
 *              prev?: { a: Vec2, b: Vec2, id: string }, chainStart?: Vec2,
 *              tangentTo?: { id: string, dir: Vec2 },
 *              exclude?: Set<string>, off?: boolean }} SnapContext
 *  from: the anchor of the rubber band. prev: the previous segment of the chain. tangentTo: the curve the anchor
 *  ends, and its unit direction leaving the anchor. exclude: ids not to snap to. off: Ctrl is held. */
/** @typedef {{ kind: 'point'|'midpoint'|'onLine'|'onCircle'|'horizontal'|'vertical'|'perpendicular'|'tangent'|'align',
 *              target?: string, constraint?: object, glyphAt: Vec2,
 *              guide?: [number, number, number, number] }} SnapHit
 *  constraint: a constraint without id, with '$p' standing for the new point and '$e' for the new line. */
/** @typedef {{ pos: Vec2, hits: SnapHit[] }} Snap */

/** @typedef {{ pos: Vec2, px: Vec2, shift: boolean, ctrl: boolean, alt: boolean,
 *              hit: import('../types.js').Hit2 | null }} PointerInfo
 *  pos: sketch coordinates (mm). px: viewport pixels. hit: what the editor's picker found under the pointer. */

/** @typedef {{ key: string, label: string, value: number, unit: 'mm'|'deg', locked: boolean }} ToolField */

/** @typedef {{ lines: number[][], circles: number[][], arcs: number[][], points: number[][],
 *              dims: object[], box: { a: Vec2, b: Vec2, crossing: boolean } | null,
 *              label: { id: string, label: Vec2 } | null,
 *              snap: Snap | null, highlight: string[], cursor: string }} Overlay
 *  What a tool wants drawn over the sketch, in sketch coordinates: lines [x1, y1, x2, y2]; circles [cx, cy, r];
 *  arcs [cx, cy, r, a0, sweep] (counter-clockwise from angle a0); points [x, y]; dims: constraints without id,
 *  drawn as dimension previews; box: the selection rectangle; label: a dimension whose number is being dragged
 *  (drawn with this label instead of its stored one); highlight: ids to draw as picked; cursor: a CSS cursor. */

/** @typedef {{ sketch: () => Sketch,
 *              commit: (sketch: Sketch, label: string, mergeKey?: string) => void,
 *              say: (text: string, blame?: string[]) => void,
 *              ask: (text: string, action: string) => Promise<boolean>,
 *              askNumber: (at: Vec2, value: number, unit: 'mm'|'deg') => Promise<number | null>,
 *              pxPerMm: () => number,
 *              switchTool: (name: string) => void,
 *              selection: () => import('../types.js').Sel[],
 *              select: (sels: import('../types.js').Sel[], opts?: { add?: boolean, toggle?: boolean }) => void,
 *              pickBox: (a: Vec2, b: Vec2, crossing: boolean) => import('../types.js').Sel[],
 *              beginDrag: (grab: Grab) => { locked: boolean, move: (pos: Vec2) => void, end: () => void, cancel: () => void } }} ToolContext
 *  What a tool may do to the world. docs/SPEC.md 9.3. */

/** @typedef {{ name: string, state: string, hint: string,
 *              move: (p: PointerInfo) => void, down: (p: PointerInfo) => void, up: (p: PointerInfo) => void,
 *              dblclick?: (p: PointerInfo) => void,
 *              key: (key: string, p: PointerInfo | null) => boolean,
 *              instant?: () => boolean,
 *              fields: () => ToolField[], setField: (key: string, value: number | null) => void,
 *              cancel: () => void, overlay: () => Overlay }} Tool
 *  A pure state machine. docs/SPEC.md 9.3. */

/** What sketch/measure.js lays out for one dimension, in sketch coordinates.
 *  @typedef {{ id?: string, kind: 'distance'|'distancePL'|'radius'|'diameter'|'angle', value: number, driven: boolean,
 *              textAt: Vec2, lines: number[][], arcs: number[][], arrows: number[][] }} DimLayout
 *  lines [x1, y1, x2, y2]; arcs [cx, cy, r, a0, sweep]; arrows [x, y, dx, dy]: a tip and the unit direction it points in. */

export {};

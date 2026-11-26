// The shapes of data that cross module boundaries, as JSDoc typedefs. There is no code in this file.
// docs/SPEC.md section 3.1 is this file; the sketch's own shapes are in src/sketch/types.js.
// Use them with:   /** @typedef {import('../types.js').Doc} Doc */

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

/** @typedef {[number, number]} Vec2 */
/** @typedef {[number, number, number]} Vec3 */
/** @typedef {[number, number, number, number]} Quat                x, y, z, w */
/** @typedef {[number, number, number, number, number, number]} Mat23
 *  SVG's matrix(a b c d e f): sx = a u + c v + e, sy = b u + d v + f. */
/** @typedef {{ o: Vec3, x: Vec3, y: Vec3, n: Vec3 }} Frame
 *  A right-handed plane frame: o a point of the plane, x and y unit vectors in it, n = x cross y its unit normal. */

// ---------------------------------------------------------------------------------------------
// The document (the project file is exactly a Doc as JSON)
// ---------------------------------------------------------------------------------------------

/** @typedef {{ format: 'corecad', version: 2, meta: DocMeta, seq: number, pseq: number,
 *              parts: Part[], features: Feature[], bodies: Object<string, BodyProps> }} Doc
 *  seq, pseq: the highest feature and part number ever given out. A version 1 file had no parts:
 *  doc/schema.js `upgrade` makes its features the history of one part. */
/** A part: a history of its own (the features whose `part` is its id, in document order), a place
 *  relative to its parent, and what stands under it. With `link` it has no history and shows another part.
 *  color: '#rrggbb'. paint: faces with a colour of their own, each by its body and the labels it carried.
 *  @typedef {{ id: string, name: string, parent: string | null, pos: Vec3, rot: Vec3,
 *              hidden?: boolean, link?: string, group?: true, color?: string,
 *              paint?: { body: string, labels: string[], color: string }[] }} Part
 *  group: a container with a place and no shape; it never has features.
 *  id: 'o' and a number. pos: millimetres. rot: degrees about the fixed X, then Y, then Z axis (core/mat.js). */
/** @typedef {{ id: string, name: string, created: string, modified: string, app: string }} DocMeta */
/** @typedef {{ name?: string, hidden?: boolean }} BodyProps */

/** Fields every feature has.
 *  @typedef {{ id: string, part: string, type: string, name: string, suppressed?: true, ui?: { hidden?: boolean } }} FeatureBase
 *  part: the part whose history it belongs to. Everything a feature refers to is in that part's own frame. */

/** @typedef {{ kind: 'base', base: 'XY'|'XZ'|'YZ' } | { kind: 'face', ref: FaceRef }} PlaneSpec */

/** @typedef {FeatureBase & { type: 'sketch', plane: PlaneSpec,
 *              points: import('./sketch/types.js').SkPoint[],
 *              entities: import('./sketch/types.js').SkEntity[],
 *              constraints: import('./sketch/types.js').SkConstraint[],
 *              seq: number }} SketchFeature */

/** A length of an extrusion: millimetres (> 0), or 'all' (cut and intersect only).
 *  @typedef {number | 'all'} Reach */
/** @typedef {{ type: 'oneSide', distance: Reach }
 *          | { type: 'symmetric', distance: Reach }
 *          | { type: 'twoSides', distance: Reach, distance2: Reach }} Extent
 *  oneSide: `distance` along the direction. symmetric: `distance` is the total, half each way.
 *  twoSides: `distance` along the direction, `distance2` against it. */

/** @typedef {FeatureBase & { type: 'extrude', sketch: string, profiles: ProfileRef[],
 *              operation: 'new'|'join'|'cut'|'intersect', extent: Extent, flip: boolean,
 *              targets: string[] | null }} ExtrudeFeature
 *  flip false: the direction is the sketch plane's normal; true: against it. targets null: every body the tool reaches. */

/** @typedef {FeatureBase & { type: 'revolve', sketch: string, profiles: ProfileRef[], axis: string, angle: number,
 *              rise?: number, left_handed?: boolean,
 *              flip: boolean, operation: 'new'|'join'|'cut'|'intersect', targets: string[] | null }} RevolveFeature
 *  rise (left out in files from before it: 0): how far the profile moves along the axis in each full turn.
 *  0: an ordinary turn, of at most 360 degrees. More: a screw, of up to 100 turns; it goes along the axis
 *  the way the axis line runs from its first point to its second (flip: the other way) and turns as a
 *  right-handed screw does (left_handed: as a left-handed one).
 *  axis: the id of a line of the sketch. angle: degrees, 0 < angle <= 360. A turn that is not closed starts in the
 *  sketch plane and goes to the side the sketch faces; flip true: the other way. */

/** @typedef {FeatureBase & { type: 'hole', face: FaceRef, at: Vec2, diameter: number, depth: Reach }} HoleFeature
 *  at: [u, v] in the canonical frame of the face's plane. */

/** @typedef {FeatureBase & { type: 'fillet', edges: EdgeRef[], radius: number, kseq: number }} FilletFeature */
/** @typedef {FeatureBase & { type: 'chamfer', edges: EdgeRef[], distance: number, kseq: number }} ChamferFeature
 *  kseq: how many edge keys this feature has ever given out; the next key is 'k' + (kseq + 1). */

/** Solids without a sketch. origin: which point of the solid is at the part's origin: 'base' (the middle of
 *  its bottom; a sphere's lowest point), 'center', or for a box 'corner' (its lowest corner).
 *  @typedef {FeatureBase & { type: 'box', size: Vec3, origin: 'base'|'center'|'corner' }} BoxFeature */
/** @typedef {FeatureBase & { type: 'cylinder', diameter: number, height: number, origin: 'base'|'center' }} CylinderFeature */
/** @typedef {FeatureBase & { type: 'sphere', diameter: number, origin: 'base'|'center' }} SphereFeature */
/** Other parts joined to this part, cut out of it, or intersected with it, where they stand.
 *  @typedef {FeatureBase & { type: 'combine', operation: 'join'|'cut'|'intersect', tools: string[], keep?: boolean }} CombineFeature
 *  tools: part ids. keep: the tools stay in the picture; otherwise they are used up (doc/parts.js). */

/** @typedef {SketchFeature | ExtrudeFeature | HoleFeature | FilletFeature | ChamferFeature
 *          | BoxFeature | CylinderFeature | SphereFeature | CombineFeature} Feature */

// ---------------------------------------------------------------------------------------------
// References (docs/SPEC.md 4.3)
// ---------------------------------------------------------------------------------------------

/** A planar face, by the labels it carried when it was picked.
 *  @typedef {{ labels: string[], of: number, body: string,
 *              hint: { n: Vec3, d: number, center: Vec3, area: number } }} FaceRef
 *  labels: the face's label set, sorted (sortLabels). of: how many faces of that body had exactly this set then.
 *  body: the body it was on (a preference when resolving, not a condition). hint: the plane n . p = d with the
 *  outward normal, the face's centre and area, at the pick. */

/** An edge: where two labelled faces meet.
 *  @typedef {{ k: string, faces: [string[], string[]], of: number, body: string,
 *              hint: { kind: 'line'|'circle'|'other', mid: Vec3, length: number } }} EdgeRef
 *  k: the key within the owning feature ('k1', 'k2', ...), never reused within it.
 *  faces: the label sets of its two faces, ordered so that faces[0].join('+') <= faces[1].join('+') as strings.
 *  of: how many edges of that body had this same pair then. */

/** A closed region of a sketch.
 *  @typedef {{ loop: string[], at: Vec2, sides?: string }} ProfileRef
 *  loop: the entity ids of the region's outer loop, each once, in id order (Region.key split at ',').
 *  at: a point that was inside the region. sides: Region.sides at the pick. */

// ---------------------------------------------------------------------------------------------
// What the kernel worker sends (docs/SPEC.md 6.1, 6.2)
// ---------------------------------------------------------------------------------------------

/** @typedef {{ labels: string[], kind: 'plane'|'cylinder'|'cone'|'sphere'|'torus'|'other',
 *              center: Vec3, area: number,
 *              plane?: { n: Vec3, d: number },
 *              cyl?: { p: Vec3, dir: Vec3, r: number, convex: boolean } }} FaceInfo
 *  plane: for kind 'plane', n . p = d with n the unit OUTWARD normal. cyl: axis point, unit axis direction,
 *  radius; convex true for a boss, false for the wall of a hole. */

/** @typedef {{ faces: number[], kind: 'line'|'circle'|'other', a: Vec3, b: Vec3, mid: Vec3,
 *              length: number, closed: boolean, seam?: true,
 *              circle?: { c: Vec3, r: number, n: Vec3 } }} EdgeInfo
 *  faces: indices into the body's faces (two; one for a seam, which then has seam: true and cannot be picked). */

/** The picture and the tables of one body. The six typed arrays are transferred, not copied.
 *  @typedef {{ positions: Float32Array, normals: Float32Array, indices: Uint32Array,
 *              faceTris: Uint32Array, edgeLines: Float32Array, edgeSegs: Uint32Array,
 *              faces: FaceInfo[], edges: EdgeInfo[] }} BodyMesh
 *  positions, normals: 3 numbers per vertex (vertices are per face: normals are sharp at edges).
 *  indices: 3 per triangle, counter-clockwise seen from outside.
 *  faceTris: 2 per face, [start, count] as POSITIONS IN `indices` (not triangle numbers; a rectangle has count 6).
 *  edgeLines: 3 numbers per point, two points per segment (THREE.LineSegments).
 *  edgeSegs: 2 per edge, [start, count] in POINTS of edgeLines (not numbers, not segments); a seam has count 0. */

/** What doc/refs.js resolves against.
 *  @typedef {{ id: string, faces: FaceInfo[], edges: EdgeInfo[] }} BodyTopo */

/** @typedef {{ positions: Float32Array, normals: Float32Array, indices: Uint32Array, op: 'new'|'join'|'cut'|'intersect', part: string }} ToolMesh
 *  part: the part in whose frame the tool is. */

/** @typedef {{ id: string, key: string, part: string, lumps: number, volume: number, bbox: [Vec3, Vec3], mesh: BodyMesh }} BodyOut
 *  id: the id of the feature that created the body. key: names this exact geometry ('<chain key>:<id>').
 *  part: the part it belongs to. Everything in it is in that part's frame: doc/parts.js `sceneOf` gives
 *  each body its `matrix` (and the bodies a linked copy shows) for the view. */

/** @typedef {{ status: 'ok'|'lost'|'ambiguous'|'guessed', count: number }} RefStatus */

/** @typedef {{ id: string, status: 'ok'|'warning'|'error'|'suppressed'|'rolled',
 *              code?: string, message?: string, detail?: string,
 *              refs?: Object<string, RefStatus>, culprits?: string[],
 *              frame?: Frame, body?: string, changed?: string[], consumed?: string[],
 *              ms: number, cached: boolean }} FeatureResult
 *  refs: by reference name: 'plane', 'face', 'edges.<k>', 'profiles.<index>'.
 *  culprits: the k of the edges a failed blend blames. frame: of a built sketch.
 *  body: the body this feature created. changed / consumed: body ids. detail: the kernel's own text. */

/** @typedef {{ ms: number, recomputed: number, cached: number, heap: number, unlabelled: number }} RebuildStats */

/** @typedef {{ status: 'done'|'superseded', seq: number, count: number,
 *              features: FeatureResult[], bodies: BodyOut[], used: Object<string, string>,
 *              before?: BodyOut[], tool?: ToolMesh, stats: RebuildStats }} RebuildResult
 *  features: in document order. A job with roll: { part, count } builds only the first `count` features
 *  of that part (the rest have status 'rolled') and every other part in full.
 *  bodies: of every part. used: tool part -> the part whose combine used it up (it is out of the picture).
 *  before: the model before the last feature built of the part looked back in (asked for with before: true). */

// ---------------------------------------------------------------------------------------------
// Inside the worker (docs/SPEC.md 6.4 to 6.10)
// ---------------------------------------------------------------------------------------------

/** A kernel shape with a label set per face. faces[i] is shape.faces[i], kept alive with the shape.
 *  @typedef {{ shape: any, faces: any[], labels: string[][] }} Labelled */

/** One body in one state of the model. Reference counted by the cache.
 *  @typedef {{ id: string, key: string, lab: Labelled, refs: number, memo: Object<string, any> }} BodyState
 *  memo: what was computed from `lab` and can be kept as long as the body lives (topology, bounds, volume). */

/** @typedef {{ frame: Frame, regions: import('./sketch/types.js').Region[] } | { error: string }} SketchState */

/** The model after a feature. Immutable; states share the bodies a feature did not change.
 *  @typedef {{ bodies: BodyState[], sketches: Map<string, SketchState> }} ModelState */

/** @typedef {{ key: string, wantTool: boolean, quality: number | null,
 *              newBody: (id: string, lab: Labelled) => BodyState }} EvalContext */

/** @typedef {(feature: Feature, state: ModelState, ctx: EvalContext) =>
 *              { state: ModelState, result: Partial<FeatureResult>, tool?: { mesh: ToolMesh, transfer: ArrayBuffer[] } }} Evaluator
 *  Throws FeatureError to fail. Never changes `state`. */

// ---------------------------------------------------------------------------------------------
// The view and picking (docs/SPEC.md 12)
// ---------------------------------------------------------------------------------------------

/** @typedef {{ target: Vec3, quat: Quat, dist: number, fov: number, ortho: boolean }} ViewState
 *  The camera looks along its own -Z, +X right, +Y up (three.js). eye = target + back * dist.
 *  The visible height at the target is 2 * dist * tan(fov / 2) in BOTH projections. fov in degrees. */
/** @typedef {{ x: number, y: number, w: number, h: number }} Viewport   CSS pixels; x, y: the viewport's top left on the page */

/** What is selected or hovered. `key` is BodyOut.key: the exact geometry the index belongs to.
 *  @typedef {{ kind: 'face', body: string, key: string, face: number }
 *          | { kind: 'edge', body: string, key: string, edge: number }
 *          | { kind: 'plane', base: 'XY'|'XZ'|'YZ' }
 *          | { kind: 'profile', sketch: string, region: string, sides: string, at: Vec2 }
 *          | { kind: 'sketch', sketch: string }
 *          | { kind: 'feature', id: string }
 *          | { kind: 'body', id: string }
 *          | { kind: 'sk-point', id: string }
 *          | { kind: 'sk-entity', id: string }
 *          | { kind: 'sk-constraint', id: string }} Sel
 *  profile.region is Region.key. The three sk- kinds are things of the sketch being edited; a dimension is a constraint. */

/** A pick in the 3D view: a Sel plus where.
 *  @typedef {Sel & { point: Vec3, px: Vec2, distPx?: number, planar?: boolean }} Hit */
/** @typedef {{ face?: boolean | 'planar', edge?: boolean, plane?: boolean, profile?: boolean | string, sketch?: boolean }} PickFilter
 *  profile: true for the regions of every shown sketch, or a sketch id for that sketch's only. */

/** A pick in the sketch being edited (ui/sketch/pick.js).
 *  @typedef {{ kind: 'point', id: string }
 *          | { kind: 'entity', id: string, at: Vec2 }
 *          | { kind: 'dimension', id: string }
 *          | { kind: 'constraint', id: string }
 *          | { kind: 'region', key: string }} Hit2 */

// ---------------------------------------------------------------------------------------------
// Commands and the application object (docs/SPEC.md 11, 16)
// ---------------------------------------------------------------------------------------------

/** A gesture of the pointer in the viewport (view/pointer.js).
 *  @typedef {{ type: 'move'|'down'|'up'|'click'|'dblclick'|'dragstart'|'drag'|'dragend'|'context',
 *              px: Vec2, button: 0|1|2, buttons: number,
 *              mods: { shift: boolean, ctrl: boolean, alt: boolean },
 *              down: Vec2 | null }} PointerEvt
 *  px: CSS pixels from the viewport's top left. down: where the button went down (drag events, click). */

/** @typedef {{ id: string, title: string, icon: string, key?: string, modes: ('model'|'sketch')[],
 *              group: string, tip?: string, instant?: boolean, tool?: string,
 *              enabled?: (app: App) => true | string,
 *              start: (app: App, args?: object) => CommandInstance | null }} CommandDef
 *  key: a shortcut such as 'l', 'shift+f', 'ctrl+enter', 'f6', 'delete' (app/keys.js). tip: a help id (default: id).
 *  enabled: true, or the reason it is not. start returns null when the command has done its work at once. */

/** @typedef {{ pointer: (ev: PointerEvt) => void,
 *              key: (ev: KeyboardEvent) => boolean,
 *              escape: () => 'stepped' | 'ended',
 *              enter: () => void,
 *              end: (reason: 'replaced'|'mode'|'done') => void,
 *              step: () => string, status: () => string, cursor: () => string }} CommandInstance */

/** Everything, by name. Built by src/main.js; handed to commands and widgets. Nothing imports another
 *  package's singletons: it reaches them through this object.
 *  @typedef {{ store: any, ui: any, kernel: any, persist: any, prefs: any, frame: any, commands: any,
 *              view: any, editor: any, help: Object<string, any>,
 *              openDialog: Function, openConfirm: Function, openMenu: Function, numberBox: any }} App
 *  The interfaces behind `any` are specified in docs/SPEC.md: store 11.1, ui 11.3, kernel 6.11, persist 11.2,
 *  prefs 11.7, frame 11.8, commands 11.4, view 12.5, editor 13.8, dialogs 14.4, numberBox 13.6. */

export {};

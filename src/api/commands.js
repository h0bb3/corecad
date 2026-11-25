// The command set: everything a script or an agent can do to the model, by name,
// with plain JSON in and out. It is what window.corecad.run() calls, and its
// `tools` list (name, description, JSON Schema of the arguments) is made to be
// handed to an MCP server or to WebMCP unchanged.
//
// Commands do what the page's own controls do, through the same store: a change
// is one undo step, is autosaved, shows in the history and in the view. A solid
// feature is tried as a preview first, as the dialogs do, and is only made part
// of the document when the kernel could build it: a failed command changes nothing.
import { addShapes, SHAPE_TYPES } from './shapes.js';
import { findBody, findFace, findEdges, describeFaces, describeEdges, SIDE_NAMES } from './select.js';
import { indexSketch, removeItems } from '../sketch/model.js';
import { solveSketch, tryAddConstraint, setDimensions, analyseSketch } from '../sketch/solver.js';
import { dimensionFrom } from '../sketch/measure.js';
import { DIMENSIONS, CONSTRAINTS } from '../sketch/catalogue.js';
import { findRegions, profileRefFrom, regionAt, pointInRegion, pointInLoop } from '../sketch/profiles.js';
import { createDocument, makeFeature, addFeature, updateFeature, removeFeature, featureById, dependents } from '../doc/model.js';
import { validateFeature } from '../doc/features.js';
import { validateDocument, serialize } from '../doc/schema.js';
import { faceRefFrom, edgeRefFrom } from '../doc/refs.js';
import { canonicalFrame, toLocal } from '../core/plane.js';
import { STANDARD } from '../view/camera-math.js';

const round = (v, digits = 4) => (Array.isArray(v) ? v.map((x) => round(x, digits)) : +Number(v).toFixed(digits));
const positive = (v, what) => {
  if (!Number.isFinite(v) || v <= 1e-4) throw Error(`${what} must be a positive number of millimetres.`);
  return v;
};
const GEOMETRIC = CONSTRAINTS.filter((c) => !DIMENSIONS.includes(c));
const PLANES = ['XY', 'XZ', 'YZ'];
const VIEWS = Object.keys(STANDARD);

// ------------------------------------------------------------------ the list of tools
const str = (description, more = {}) => ({ type: 'string', description, ...more });
const numb = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
const SKETCH_ARG = str('The sketch\'s feature id, such as "f1". Left out: the newest sketch.');
const BODY_ARG = str('The body\'s id (the id of the feature that made it). Left out: the only body.');
const FACE_ARG = {
  description: `A flat face: a side name (${SIDE_NAMES.join(', ')}: the flat face furthest out that way), or { "body": id, "face": index } with an index from list_faces, or { "body": id, "side": name }.`,
};
const EDGES_ARG = {
  description: 'Which edges: "all"; or an array of indices from list_edges; or an object whose conditions must all hold: { "body": id, "indices": [..], "kind": "line" | "circle", "parallel": "x" | "y" | "z", "on": a face (as for sketching), "length": mm }. Example: { "parallel": "z" } is every straight vertical edge.',
};
const SHAPES_ARG = {
  type: 'array',
  description:
    'Shapes in sketch coordinates (mm): ' +
    '{ "type": "rectangle", "corner": [x, y] or "center": [x, y], "width", "height" }; ' +
    '{ "type": "circle", "center": [x, y], "diameter" or "radius" }; ' +
    '{ "type": "line", "from": [x, y], "to": [x, y] }; ' +
    '{ "type": "polyline", "points": [[x, y], ...], "closed": true }; ' +
    '{ "type": "arc", "center", "from", "to" } (counter-clockwise from "from" to "to"); ' +
    '{ "type": "point", "at": [x, y] }. ' +
    'Rectangles and circles get driving dimensions and are located from the origin; the others are pinned where given ("fix": false leaves one free). Any shape may have "construction": true. Ends that meet are joined.',
  items: { type: 'object' },
};
const tool = (name, description, properties = {}, required = []) => ({
  name,
  description,
  input: { type: 'object', properties, required, additionalProperties: false },
});

export const TOOLS = [
  tool('get_state', 'The model at a glance: the features in order with their status and main numbers, the bodies with volume (mm³) and bounding box, and whether the page is busy or in the middle of an edit. Start here.'),
  tool('get_document', 'The whole project as JSON: exactly what Save writes to a .corecad file.'),
  tool('load_document', 'Replaces the open project with a document in the .corecad format (as get_document returns). The history of undo steps starts over.', { document: { type: 'object', description: 'The project.' } }, ['document']),
  tool('new_document', 'Starts an empty project. The open one is replaced (it stays in the browser only if it was saved).', { name: str('The project\'s name.') }),
  tool('get_sketch', 'One sketch in full: its lines, circles, arcs and points with coordinates and the ids of their points, its dimensions and constraints with their ids, its degrees of freedom (0 = fully constrained), and its closed regions (what extrude can use).', { sketch: SKETCH_ARG }),
  tool('list_faces', 'The faces of a body (or of every body): index, kind (plane, cylinder, …), centre, area, the outward normal of flat faces, radius of round ones, and which side of the body a flat face is ("top", …).', { body: BODY_ARG }),
  tool('list_edges', 'The edges of a body (or of every body) that can be filleted or chamfered: index, kind, end points, middle, length, the two faces it lies between. Optionally only those matching a description.', { body: BODY_ARG, edges: EDGES_ARG }),
  tool(
    'add_sketch',
    'Makes a sketch on an origin plane or on a flat face of a body, optionally with shapes in it. Sketch coordinates are millimetres in the plane; on XY and on top faces they are the world\'s x and y. Returns the sketch as get_sketch does.',
    { plane: { description: `"XY" (the ground; default), "XZ", "YZ", or a flat face: ${FACE_ARG.description}` }, shapes: SHAPES_ARG, name: str('A name for the history.') }
  ),
  tool('add_to_sketch', 'Adds shapes to an existing sketch. Features built on the sketch are rebuilt.', { sketch: SKETCH_ARG, shapes: SHAPES_ARG }, ['shapes']),
  tool(
    'set_dimension',
    'Changes the value of a driving dimension of a sketch; the sketch follows and everything built on it is rebuilt. Ids are in get_sketch.',
    { sketch: SKETCH_ARG, dimension: str('The dimension\'s id, such as "c9".'), value: numb('Millimetres, or degrees for an angle.') },
    ['dimension', 'value']
  ),
  tool(
    'add_dimension',
    'Adds a driving dimension to a sketch. What it measures follows from what is named: one line (its length), one circle or arc (radius; mode "diameter" for the diameter), two points (their distance), a point and a line (their distance), two lines (their angle).',
    {
      sketch: SKETCH_ARG,
      refs: { type: 'array', items: { type: 'string' }, description: 'One or two ids of entities or points of the sketch.' },
      value: numb('The size to drive it to. Left out: it keeps the size it has.'),
      mode: str('For distances: "h" (horizontal), "v" (vertical) or "aligned"; for a circle "diameter". Left out: the natural one.'),
    },
    ['refs']
  ),
  tool(
    'add_constraint',
    `Adds a geometric constraint to a sketch: ${GEOMETRIC.join(', ')}. It is refused, with the reason, if it conflicts with or merely repeats what is there.`,
    { sketch: SKETCH_ARG, type: str('The kind of constraint.', { enum: GEOMETRIC }), refs: { type: 'array', items: { type: 'string' }, description: 'The ids it relates: points ("p3", or "origin") and entities ("e2"), as the kind needs.' } },
    ['type', 'refs']
  ),
  tool('remove_from_sketch', 'Removes entities, dimensions or constraints from a sketch by id.', { sketch: SKETCH_ARG, ids: { type: 'array', items: { type: 'string' }, description: 'Ids from get_sketch.' } }, ['ids']),
  tool(
    'extrude',
    'Extrudes closed regions of a sketch into a solid: a new body, joined to the bodies it touches, cut out of them, or their intersection.',
    {
      sketch: SKETCH_ARG,
      profiles: { description: 'Which regions: "outer" (default: every outline with its holes left open), "all" (holes filled too), or an array of region indices from get_sketch or of points [x, y] inside the regions meant.' },
      distance: numb('How far, in mm, along the sketch plane\'s normal (a cut on a face goes into the body). Negative: the other way.'),
      through_all: bool('For cut and intersect: through everything, instead of a distance.'),
      operation: str('Default: "new" when there is no body yet, otherwise "join".', { enum: ['new', 'join', 'cut', 'intersect'] }),
      symmetric: bool('The distance is the total, half to each side of the sketch plane.'),
      distance2: numb('A second distance, against the direction (two-sided extrusion).'),
      flip: bool('Reverse the direction.'),
      name: str('A name for the history.'),
    }
  ),
  tool(
    'hole',
    'Drills a round hole into a flat face, straight in.',
    {
      face: FACE_ARG,
      at: { type: 'array', items: { type: 'number' }, description: 'Where, as [x, y] in the face\'s sketch coordinates (on a top face: the world\'s x and y). Left out: the middle of the face.' },
      position: { type: 'array', items: { type: 'number' }, description: 'Instead of "at": a point [x, y, z] in space; the hole goes where it drops onto the face.' },
      diameter: numb('Millimetres.'),
      depth: numb('Millimetres. Left out: through everything.'),
      name: str('A name for the history.'),
    },
    ['diameter']
  ),
  tool('fillet', 'Rounds edges of a body with a radius.', { edges: EDGES_ARG, radius: numb('Millimetres.'), name: str('A name for the history.') }, ['edges', 'radius']),
  tool('chamfer', 'Bevels edges of a body by a distance.', { edges: EDGES_ARG, distance: numb('Millimetres.'), name: str('A name for the history.') }, ['edges', 'distance']),
  tool(
    'edit_feature',
    'Changes a feature\'s parameters, name or suppression; the features after it are rebuilt. Extrude: distance, through_all, symmetric, distance2, operation, flip. Hole: diameter, depth, through_all, at. Fillet: radius. Chamfer: distance. (A sketch is changed with set_dimension, add_to_sketch and remove_from_sketch.)',
    {
      id: str('The feature\'s id, such as "f3".'),
      name: str('A new name.'),
      suppressed: bool('true: leave the feature out of the model without deleting it.'),
      distance: numb('mm'), through_all: bool('through everything'), symmetric: bool('half to each side'), distance2: numb('mm, the other way'),
      operation: str('new, join, cut or intersect', { enum: ['new', 'join', 'cut', 'intersect'] }), flip: bool('reverse the direction'),
      diameter: numb('mm'), depth: numb('mm'), at: { type: 'array', items: { type: 'number' }, description: '[x, y] on the face' }, radius: numb('mm'),
    },
    ['id']
  ),
  tool('delete_feature', 'Deletes a feature. If others are built on it they must go too: say so with with_dependents, or the command lists them and changes nothing.', { id: str('The feature\'s id.'), with_dependents: bool('Also delete what is built on it.') }, ['id']),
  tool('undo', 'Takes back the last change.'),
  tool('redo', 'Does again what undo took back.'),
  tool('cancel_edit', 'Closes a sketch or a feature dialog that is open in the page without keeping its changes. The commands that change the model need this to be closed.'),
  tool(
    'export',
    'The model as a file: "step" (exact geometry, for other CAD), "stl" (a mesh, for printing) or "corecad" (the project). Returned as text (step, corecad) or base64 (stl), or sent to the browser\'s downloads.',
    { format: str('Default "step".', { enum: ['step', 'stl', 'corecad'] }), download: bool('true: save it through the browser instead of returning its content.') }
  ),
  tool(
    'screenshot',
    'A picture of the 3D view as a PNG data URL, to see what the model looks like.',
    { view: str('Turn the camera first.', { enum: VIEWS }), fit: bool('Fit the model in the view first (default true).'), max: numb('The longer side in pixels at most (default 1200).') }
  ),
  tool('set_view', 'Turns the camera to a standard view and fits the model.', { view: str('The view.', { enum: VIEWS }), fit: bool('Fit the model (default true).') }, ['view']),
];

// ------------------------------------------------------------------ the commands
/**
 * @param {object} app
 * @param {object} app.store     the document store (src/store.js)
 * @param {object} app.view      the viewport (src/view/viewport.js)
 * @param {() => boolean} app.editing     a sketch or a feature dialog is open in the page
 * @param {() => void} app.cancelEdit     closes it, discarding
 * @param {() => void} app.ready          called before a change: leave any look-back in the history
 * @param {(featureId: string | null) => void} app.shown   a command made or changed this: select it, fit the view
 * @param {(blob: Blob, name: string) => void} app.download
 * @param {(doc: object) => string} app.filename
 */
export function createCommands(app) {
  const { store, view } = app;
  const doc = () => store.state.doc;
  const bodies = () => store.state.build?.bodies ?? [];

  /** Resolves with the store's state once the kernel has answered the latest request. */
  function settled(timeout = 180000) {
    return new Promise((resolve, reject) => {
      let off = null,
        done = false;
      const timer = setTimeout(() => {
        done = true;
        off?.();
        reject(Error('The geometry kernel did not answer in time.'));
      }, timeout);
      off = store.subscribe((state) => {
        if (done || state.busy) return;
        done = true;
        clearTimeout(timer);
        queueMicrotask(() => off?.());
        resolve(state);
      });
    });
  }
  function free() {
    app.ready();
    if (app.editing())
      throw Error('A sketch or a feature dialog is open in the page. Finish or cancel it there, or call cancel_edit, before changing the model.');
  }
  function sketchOf(id) {
    const f = id === undefined ? [...doc().features].reverse().find((f) => f.type === 'sketch') : featureById(doc(), id);
    if (!f) throw Error(id === undefined ? 'There is no sketch yet: make one with add_sketch.' : `There is no feature "${id}".`);
    if (f.type !== 'sketch') throw Error(`${f.name} (${f.id}) is ${f.type === 'extrude' ? 'an' : 'a'} ${f.type}, not a sketch.`);
    return f;
  }
  const resultOf = (id) => store.state.build?.features.find((r) => r.id === id);
  const problems = () =>
    (store.state.build?.features ?? [])
      .filter((r) => r.status === 'warning' || r.status === 'error')
      .map((r) => ({ id: r.id, name: featureById(doc(), r.id)?.name, status: r.status, message: r.message }));
  const bodyRows = () =>
    bodies().map((b) => ({
      id: b.id,
      name: doc().bodies[b.id]?.name ?? 'Body ' + b.id.slice(1),
      volume: round(b.volume, 3),
      box: [round(b.bbox[0]), round(b.bbox[1])],
      lumps: b.lumps,
      faces: b.mesh.faces.length,
      ...(doc().bodies[b.id]?.hidden ? { hidden: true } : {}),
    }));

  function sketchInfo(f) {
    const ix = indexSketch(f),
      at = (id) => {
        const p = ix.point(id);
        return [round(p.x), round(p.y)];
      };
    let regions = [];
    try {
      regions = findRegions(f);
    } catch {
      /* a sketch that cannot be arranged has no regions */
    }
    return {
      id: f.id,
      name: f.name,
      plane: f.plane.kind === 'base' ? f.plane.base : { face_of_body: f.plane.ref.body },
      degrees_of_freedom: analyseSketch(f).dof,
      entities: f.entities.map((e) => {
        const base = { id: e.id, type: e.type, ...(e.construction ? { construction: true } : {}) };
        if (e.type === 'line') return { ...base, from: at(e.a), to: at(e.b), points: { from: e.a, to: e.b } };
        if (e.type === 'circle') return { ...base, center: at(e.c), radius: round(e.r), points: { center: e.c } };
        if (e.type === 'arc') return { ...base, center: at(e.c), from: at(e.a), to: at(e.b), points: { center: e.c, from: e.a, to: e.b } };
        return { ...base, at: at(e.p), points: { at: e.p } };
      }),
      dimensions: f.constraints
        .filter((c) => DIMENSIONS.includes(c.type))
        .map((c) => ({
          id: c.id,
          type: c.type === 'distance' ? { h: 'horizontal distance', v: 'vertical distance' }[c.mode] ?? 'distance' : c.type,
          refs: c.refs,
          value: round(c.value),
          ...(c.driven ? { reference: true } : {}),
        })),
      constraints: f.constraints.filter((c) => !DIMENSIONS.includes(c.type)).map((c) => ({ id: c.id, type: c.type, refs: c.refs })),
      regions: regions.map((r, i) => ({ region: i, area: round(r.area), inside: round(r.inside), holes: r.holes.length, outline: r.key.split(',') })),
    };
  }

  function summary(f) {
    if (f.type === 'sketch') {
      let regions = 0;
      try {
        regions = findRegions(f).length;
      } catch {
        /* none */
      }
      return {
        plane: f.plane.kind === 'base' ? f.plane.base : { face_of_body: f.plane.ref.body },
        entities: f.entities.length,
        regions,
        degrees_of_freedom: analyseSketch(f).dof,
      };
    }
    if (f.type === 'extrude')
      return {
        sketch: f.sketch,
        operation: f.operation,
        ...(f.extent.distance === 'all' ? { through_all: true } : { distance: f.extent.distance }),
        ...(f.extent.type === 'symmetric' ? { symmetric: true } : {}),
        ...(f.extent.type === 'twoSides' ? { distance2: f.extent.distance2 } : {}),
        ...(f.flip ? { flip: true } : {}),
        profiles: f.profiles.length,
      };
    if (f.type === 'hole') return { diameter: f.diameter, ...(f.depth === 'all' ? { through_all: true } : { depth: f.depth }), at: round(f.at), on_body: f.face?.body };
    if (f.type === 'fillet') return { radius: f.radius, edges: f.edges.length };
    if (f.type === 'chamfer') return { distance: f.distance, edges: f.edges.length };
    return {};
  }

  function stateInfo() {
    const st = store.state;
    return {
      project: st.doc.meta.name,
      units: 'mm',
      features: st.doc.features.map((f) => {
        const r = resultOf(f.id);
        return { id: f.id, type: f.type, name: f.name, status: r?.status ?? 'unknown', ...(r?.message ? { message: r.message } : {}), ...summary(f) };
      }),
      bodies: bodyRows(),
      editing: app.editing(),
      can_undo: store.history.canUndo,
      can_redo: store.history.canRedo,
      ...(st.error ? { error: st.error } : {}),
    };
  }

  /** What a command that changed feature `id` answers. */
  const outcome = (id, more = {}) => {
    const f = featureById(doc(), id),
      r = resultOf(id);
    return {
      id,
      type: f?.type,
      name: f?.name,
      status: r?.status ?? 'unknown',
      ...(r?.message ? { message: r.message } : {}),
      ...more,
      problems: problems(),
      bodies: bodyRows(),
    };
  };

  /** Makes `next` the document. A sketch-only change needs no trial: the solver has accepted it. */
  async function commit(next, label, id) {
    store.commit(next, label);
    const st = await settled();
    if (st.error) throw Error(st.error);
    app.shown(id ?? null);
  }

  /** Tries `next` (in which `feature` is new or changed) as a preview, and commits it only if that feature builds. */
  async function apply(next, feature, label) {
    const errors = validateFeature(feature);
    if (errors.length) throw Error(errors.join(' '));
    store.preview(next);
    const st = await settled();
    const r = st.build?.features.find((x) => x.id === feature.id);
    if (st.error || !r || r.status === 'error') {
      const why = st.error || (r ? [r.message, r.detail].filter(Boolean).join(' ') : 'The feature could not be built.');
      store.cancelPreview();
      await settled();
      throw Error(why);
    }
    await commit(next, label, feature.id);
    return outcome(feature.id);
  }

  async function sketchChange(sk, sketch, label, more = {}) {
    await commit(updateFeature(doc(), sk.id, sketch), label, sk.id);
    return outcome(sk.id, { ...more, sketch: sketchInfo(featureById(doc(), sk.id)) });
  }

  function regionsFor(sk, which = 'outer') {
    const regions = findRegions(sk);
    if (!regions.length) throw Error(`${sk.name} has no closed region to extrude: close its outline first.`);
    if (which === 'all') return regions;
    if (which === 'outer') {
      // Not lying in a hole of another region: the outlines, with their holes left open.
      const outer = regions.filter((r) => !regions.some((o) => o !== r && pointInLoop(r.inside, o.outer) && !pointInRegion(r.inside, o)));
      return outer.length ? outer : regions;
    }
    if (!Array.isArray(which) || !which.length) throw Error('"profiles" is "outer", "all", or a list of region indices or points.');
    return which.map((w) => {
      const r = Number.isInteger(w) ? regions[w] : Array.isArray(w) && w.length === 2 && w.every(Number.isFinite) ? regionAt(regions, w) : undefined;
      if (!r) throw Error(`No region ${JSON.stringify(w)} in ${sk.name} (it has ${regions.length}; see get_sketch).`);
      return r;
    });
  }

  /** The extent the arguments ask for; `base` is the extent being edited (what is not given stays as it is). */
  function extentFrom(a, operation, base = null) {
    const wasAll = base?.distance === 'all';
    if (a.through_all ?? (a.distance === undefined && wasAll)) {
      if (!['cut', 'intersect'].includes(operation)) throw Error('through_all is for cut and intersect; new and join need a distance.');
      // A new cut through everything with no direction asked for goes both ways, so it cannot miss the body.
      if (!base) return { type: a.flip === undefined && !(a.distance < 0) ? 'symmetric' : 'oneSide', distance: 'all' };
      return { type: base.type === 'symmetric' ? 'symmetric' : 'oneSide', distance: 'all' };
    }
    const d = a.distance ?? (wasAll ? undefined : base?.distance);
    if (d === undefined) throw Error('Give a distance.');
    const distance = positive(Math.abs(d), 'The distance');
    const distance2 = a.distance2 ?? (base?.type === 'twoSides' ? base.distance2 : undefined);
    if (a.symmetric ?? base?.type === 'symmetric') return { type: 'symmetric', distance };
    if (distance2 !== undefined) return { type: 'twoSides', distance, distance2: distance2 === 'all' ? 'all' : positive(distance2, 'The second distance') };
    return { type: 'oneSide', distance };
  }

  async function blend(type, a) {
    free();
    await settled();
    const key = type === 'fillet' ? 'radius' : 'distance';
    positive(a[key], type === 'fillet' ? 'The radius' : 'The distance');
    const hits = findEdges(bodies(), a.edges);
    const made = makeFeature(doc(), type, { [key]: a[key], ...(a.name ? { name: String(a.name) } : {}) });
    made.feature.edges = hits.map((h, i) => edgeRefFrom(h.body, h.edge, 'k' + (i + 1)));
    made.feature.kseq = hits.length;
    return apply(addFeature(made.doc, made.feature), made.feature, 'Apply ' + made.feature.name);
  }

  const toBase64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };

  const impl = {
    async get_state() {
      await settled();
      return stateInfo();
    },
    async get_document() {
      return structuredClone(doc());
    },
    async load_document(a) {
      free();
      const errors = validateDocument(a.document);
      if (errors.length) throw Error('Not a valid CoreCAD project: ' + errors.join(' '));
      store.open(structuredClone(a.document));
      await settled();
      app.shown(null);
      return stateInfo();
    },
    async new_document(a) {
      free();
      store.open(createDocument(a.name ? String(a.name) : 'Untitled'));
      await settled();
      app.shown(null);
      return stateInfo();
    },
    async get_sketch(a) {
      return sketchInfo(sketchOf(a.sketch));
    },
    async list_faces(a) {
      await settled();
      return (a.body === undefined ? bodies() : [findBody(bodies(), a.body)]).map((b) => ({ body: b.id, faces: describeFaces(b) }));
    },
    async list_edges(a) {
      await settled();
      if (a.edges !== undefined) {
        const sel = Array.isArray(a.edges) ? { indices: a.edges } : a.edges === 'all' ? {} : a.edges;
        const hits = findEdges(bodies(), a.body !== undefined && sel && typeof sel === 'object' ? { body: a.body, ...sel } : sel);
        const rows = describeEdges(hits[0].body);
        return [{ body: hits[0].body.id, edges: rows.filter((r) => hits.some((h) => h.edge === r.edge)) }];
      }
      return (a.body === undefined ? bodies() : [findBody(bodies(), a.body)]).map((b) => ({ body: b.id, edges: describeEdges(b) }));
    },
    async add_sketch(a) {
      free();
      await settled();
      const where = a.plane ?? 'XY';
      let plane;
      if (typeof where === 'string' && PLANES.includes(where.toUpperCase())) plane = { kind: 'base', base: where.toUpperCase() };
      else {
        const { body, face } = findFace(bodies(), where);
        plane = { kind: 'face', ref: faceRefFrom(body, face) };
      }
      const made = makeFeature(doc(), 'sketch', { plane, ...(a.name ? { name: String(a.name) } : {}) });
      const feature = a.shapes?.length ? addShapes(made.feature, a.shapes).sketch : made.feature;
      await commit(addFeature(made.doc, feature), 'Create ' + feature.name, feature.id);
      return outcome(feature.id, { sketch: sketchInfo(featureById(doc(), feature.id)) });
    },
    async add_to_sketch(a) {
      free();
      await settled();
      const sk = sketchOf(a.sketch),
        r = addShapes(sk, a.shapes);
      return sketchChange(sk, r.sketch, 'Edit ' + sk.name, { added: r.entities });
    },
    async set_dimension(a) {
      free();
      await settled();
      const sk = sketchOf(a.sketch),
        c = sk.constraints.find((c) => c.id === a.dimension);
      if (!c || !DIMENSIONS.includes(c.type)) throw Error(`${sk.name} has no dimension "${a.dimension}". Its dimensions: ${sk.constraints.filter((c) => DIMENSIONS.includes(c.type)).map((c) => `${c.id} = ${round(c.value)}`).join(', ') || 'none'}.`);
      const r = setDimensions(sk, [{ id: c.id, value: a.value }]);
      if (!r.ok) throw Error(r.message + (r.reached ? ` (It could go ${Math.round(r.reached * 100)} % of the way.)` : ''));
      return sketchChange(sk, r.sketch, 'Change dimension');
    },
    async add_dimension(a) {
      free();
      await settled();
      const sk = sketchOf(a.sketch);
      const c = dimensionFrom(sk, a.refs, a.mode ?? 'auto');
      let r = tryAddConstraint(sk, c);
      if (!r.ok) throw Error(r.message);
      const id = r.id;
      if (a.value !== undefined && Math.abs(a.value - c.value) > 1e-9) {
        r = setDimensions(r.sketch, [{ id, value: a.value }]);
        if (!r.ok) throw Error(r.message);
      }
      return sketchChange(sk, r.sketch, 'Add dimension', { dimension: id });
    },
    async add_constraint(a) {
      free();
      await settled();
      if (!GEOMETRIC.includes(a.type)) throw Error(`Unknown constraint "${a.type}". Known: ${GEOMETRIC.join(', ')}. (Sizes are added with add_dimension.)`);
      const sk = sketchOf(a.sketch),
        r = tryAddConstraint(sk, { type: a.type, refs: a.refs });
      if (!r.ok) throw Error(r.message);
      return sketchChange(sk, r.sketch, 'Add constraint', { constraint: r.id });
    },
    async remove_from_sketch(a) {
      free();
      await settled();
      const sk = sketchOf(a.sketch),
        known = new Set([...sk.entities, ...sk.constraints].map((x) => x.id));
      const missing = (a.ids ?? []).filter((id) => !known.has(id));
      if (!a.ids?.length || missing.length) throw Error(missing.length ? `${sk.name} has nothing called ${missing.join(', ')}.` : 'Give the ids to remove.');
      const r = solveSketch(removeItems(sk, a.ids));
      if (!r.ok) throw Error(r.message);
      return sketchChange(sk, r.sketch, 'Edit ' + sk.name);
    },
    async extrude(a) {
      free();
      await settled();
      const sk = sketchOf(a.sketch),
        regions = regionsFor(sk, a.profiles),
        operation = a.operation ?? (bodies().length ? 'join' : 'new');
      if (!a.through_all && a.distance === undefined) throw Error('Give a distance (or through_all for a cut).');
      const extent = extentFrom(a, operation);
      // A cut drawn on a face goes into the body, against the face's outward normal, unless told otherwise.
      let flip = a.flip ?? (operation === 'cut' && sk.plane.kind === 'face');
      if (a.distance < 0) flip = !flip;
      const made = makeFeature(doc(), 'extrude', {
        sketch: sk.id,
        profiles: regions.map(profileRefFrom),
        operation,
        extent,
        flip,
        ...(a.name ? { name: String(a.name) } : {}),
      });
      return apply(addFeature(made.doc, made.feature), made.feature, 'Apply ' + made.feature.name);
    },
    async hole(a) {
      free();
      await settled();
      positive(a.diameter, 'The diameter');
      const { body, face } = findFace(bodies(), a.face ?? 'top'),
        ref = faceRefFrom(body, face),
        frame = canonicalFrame(ref.hint.n, ref.hint.d);
      const at = a.at ?? toLocal(frame, a.position ?? ref.hint.center).slice(0, 2);
      if (!Array.isArray(at) || at.length !== 2 || !at.every(Number.isFinite)) throw Error('"at" must be [x, y] on the face.');
      const made = makeFeature(doc(), 'hole', {
        face: ref,
        at,
        diameter: a.diameter,
        depth: a.depth === undefined ? 'all' : positive(a.depth, 'The depth'),
        ...(a.name ? { name: String(a.name) } : {}),
      });
      return apply(addFeature(made.doc, made.feature), made.feature, 'Apply ' + made.feature.name);
    },
    fillet: (a) => blend('fillet', a),
    chamfer: (a) => blend('chamfer', a),
    async edit_feature(a) {
      free();
      await settled();
      const f = featureById(doc(), a.id);
      if (!f) throw Error(`There is no feature "${a.id}".`);
      const allowed = { sketch: [], extrude: ['distance', 'through_all', 'symmetric', 'distance2', 'operation', 'flip'], hole: ['diameter', 'depth', 'through_all', 'at'], fillet: ['radius'], chamfer: ['distance'] }[f.type] ?? [];
      const given = Object.keys(a).filter((k) => !['id', 'name', 'suppressed'].includes(k));
      const wrong = given.filter((k) => !allowed.includes(k));
      if (wrong.length)
        throw Error(`${f.name} is ${f.type === 'extrude' ? 'an' : 'a'} ${f.type}: it has no ${wrong.join(', ')}. It has: ${['name', 'suppressed', ...allowed].join(', ')}.` + (f.type === 'sketch' ? ' Change a sketch with set_dimension, add_to_sketch or remove_from_sketch.' : ''));
      const next = structuredClone(f);
      if (a.name !== undefined) next.name = String(a.name);
      if (a.suppressed === true) next.suppressed = true;
      if (a.suppressed === false) delete next.suppressed;
      if (f.type === 'extrude') {
        if (a.operation !== undefined) next.operation = a.operation;
        if (a.flip !== undefined) next.flip = !!a.flip;
        if (given.some((k) => ['distance', 'through_all', 'symmetric', 'distance2'].includes(k))) {
          next.extent = extentFrom(a, next.operation, f.extent);
          if (a.distance < 0) next.flip = !next.flip;
        }
      }
      if (f.type === 'hole') {
        if (a.diameter !== undefined) next.diameter = a.diameter;
        if (a.through_all) next.depth = 'all';
        else if (a.depth !== undefined) next.depth = a.depth;
        if (a.at !== undefined) next.at = a.at;
      }
      if (f.type === 'fillet' && a.radius !== undefined) next.radius = a.radius;
      if (f.type === 'chamfer' && a.distance !== undefined) next.distance = a.distance;
      return apply(updateFeature(doc(), f.id, () => next), next, 'Edit ' + next.name);
    },
    async delete_feature(a) {
      free();
      await settled();
      const f = featureById(doc(), a.id);
      if (!f) throw Error(`There is no feature "${a.id}".`);
      const also = dependents(doc(), f.id).map((id) => featureById(doc(), id));
      if (also.length && !a.with_dependents)
        throw Error(`${also.map((x) => `${x.name} (${x.id})`).join(', ')} ${also.length > 1 ? 'are' : 'is'} built on ${f.name}. Say with_dependents: true to delete ${also.length > 1 ? 'them' : 'it'} too.`);
      const ids = [f.id, ...also.map((x) => x.id)];
      await commit(ids.reduce(removeFeature, doc()), 'Delete ' + f.name, null);
      return { deleted: ids, problems: problems(), bodies: bodyRows() };
    },
    async undo() {
      free();
      if (!store.history.canUndo) throw Error('There is nothing to undo.');
      const label = store.history.undoLabel;
      store.undo();
      await settled();
      app.shown(null);
      return { undone: label, ...stateInfo() };
    },
    async redo() {
      free();
      if (!store.history.canRedo) throw Error('There is nothing to redo.');
      const label = store.history.redoLabel;
      store.redo();
      await settled();
      app.shown(null);
      return { redone: label, ...stateInfo() };
    },
    async cancel_edit() {
      const was = app.editing();
      if (was) app.cancelEdit();
      await settled();
      return { cancelled: was };
    },
    async export(a) {
      await settled();
      const format = a.format ?? 'step';
      if (!['step', 'stl', 'corecad'].includes(format)) throw Error('"format" is "step", "stl" or "corecad".');
      const name = app.filename(doc()) + '.' + format;
      if (format !== 'corecad' && !bodies().length) throw Error('There is no body to export yet.');
      const blob = format === 'corecad' ? new Blob([serialize(doc())], { type: 'application/json' }) : await store.kernel.export(doc(), { format });
      if (a.download) {
        app.download(blob, name);
        return { format, filename: name, bytes: blob.size, downloaded: true };
      }
      if (blob.size > 30e6) throw Error(`The file is ${Math.round(blob.size / 1e6)} MB: too large to return; ask for download: true.`);
      return format === 'stl'
        ? { format, filename: name, bytes: blob.size, base64: toBase64(new Uint8Array(await blob.arrayBuffer())) }
        : { format, filename: name, bytes: blob.size, text: await blob.text() };
    },
    async screenshot(a) {
      await settled();
      if (a.view !== undefined) {
        if (!STANDARD[a.view]) throw Error(`Unknown view "${a.view}". Views: ${VIEWS.join(', ')}.`);
        view.standard(a.view);
      }
      if (a.fit !== false) view.fit();
      const shot = view.snapshot(),
        k = Math.min(1, (a.max ?? 1200) / Math.max(shot.width, shot.height));
      let out = shot;
      if (k < 1) {
        out = document.createElement('canvas');
        out.width = Math.round(shot.width * k);
        out.height = Math.round(shot.height * k);
        const g = out.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(shot, 0, 0, out.width, out.height);
      }
      return { png: out.toDataURL('image/png'), width: out.width, height: out.height };
    },
    async set_view(a) {
      if (!STANDARD[a.view]) throw Error(`Unknown view "${a.view}". Views: ${VIEWS.join(', ')}.`);
      view.standard(a.view);
      if (a.fit !== false) view.fit();
      return { view: a.view };
    },
  };

  // One command at a time, in the order they were asked: a preview of one must not meet the commit of another.
  let queue = Promise.resolve();
  function run(name, args = {}) {
    const job = queue.then(async () => {
      const spec = TOOLS.find((t) => t.name === name);
      if (!spec || !impl[name]) return { ok: false, error: `Unknown command "${name}". Commands: ${TOOLS.map((t) => t.name).join(', ')}.` };
      try {
        if (args === null || typeof args !== 'object' || Array.isArray(args)) throw Error('The arguments must be an object.');
        const unknown = Object.keys(args).filter((k) => !(k in spec.input.properties));
        if (unknown.length) throw Error(`${name} has no argument ${unknown.map((k) => `"${k}"`).join(', ')}. It takes: ${Object.keys(spec.input.properties).join(', ') || 'nothing'}.`);
        const lacking = spec.input.required.filter((k) => args[k] === undefined);
        if (lacking.length) throw Error(`${name} needs ${lacking.map((k) => `"${k}"`).join(', ')}.`);
        return { ok: true, result: await impl[name](args) };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    });
    queue = job;
    return job;
  }
  /** The same commands as functions that throw: corecad.commands.extrude({ distance: 10 }). */
  const commands = Object.fromEntries(
    TOOLS.map((t) => [
      t.name,
      async (args) => {
        const r = await run(t.name, args);
        if (!r.ok) throw Error(r.error);
        return r.result;
      },
    ])
  );
  return { tools: TOOLS, run, commands, shapes: SHAPE_TYPES };
}

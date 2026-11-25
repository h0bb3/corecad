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
import { validateDocument, serialize, upgrade } from '../doc/schema.js';
import { partById, featuresOf, worldOf, makePart, addPart, updatePart, removePart, partDependents, setParent, copyPart, unlinkPart, sceneOf, contentOf, descendantsOf, ancestorsOf, childrenOf, groupParts, ungroup, setPartColor, paintFaces, appearanceOf } from '../doc/parts.js';
import { PALETTE, colorFrom } from './colors.js';
import * as Mat from '../core/mat.js';
import { sizeOf, between, total } from './measure3d.js';
import { dimensionsOf } from './dimensions.js';
import { faceRefFrom, edgeRefFrom, topoOfBody } from '../doc/refs.js';
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
const SKETCH_ARG = str('The sketch\'s feature id, such as "f1"; or "this": the sketch the person has selected, or the one behind the extrusion they selected or point at. Left out: the newest sketch.');
const BODY_ARG = str('The body\'s id (the id of the feature that made it). Left out: the body of the current part, or the only body.');
const PART_ARG = str('The part: its id, such as "o2", or its name; or "this": the part the person has selected, or else points at ("selected" and "pointed" say which of the two). Left out: the current part (get_state says which).');
const FACE_ARG = {
  description: `A flat face: "this" (the face the person has selected in the page, or else the one their mouse rests on; "selected" and "pointed" say which of the two); or a side name (${SIDE_NAMES.join(', ')}: the flat face furthest out that way, as the body stands in space); or { "face": index } with an index from list_faces, or { "side": name }, each of which may say whose with "part": id or name, or "body": id (left out: the body of the current part).`,
};
const EDGES_ARG = {
  description: 'Which edges: "this" (the edges the person has selected in the page, or else the one their mouse rests on; also "selected", "pointed"); or "all"; or an array of indices from list_edges; or an object whose conditions must all hold: { "part": id or name, "body": id, "indices": [..], "kind": "line" | "circle", "parallel": "x" | "y" | "z", "on": a face (as for sketching), "length": mm }. Example: { "parallel": "z" } is every straight vertical edge.',
};
const VEC = (description) => ({ type: 'array', items: { type: 'number' }, description });
const POSITION_ARG = VEC('Where the part\'s origin is: [x, y, z] in mm, in its parent\'s frame (in space when it has no parent). Default [0, 0, 0].');
const ROTATION_ARG = VEC('How it is turned: [rx, ry, rz] in degrees, about the fixed X axis first, then Y, then Z, round the part\'s origin. Default [0, 0, 0].');
const PARENT_ARG = { description: 'The part it stands under and moves with: an id or a name; null for none.' };
const ORIGIN_ARG = (kinds) => str(`Which point of the solid is the part's origin (what "position" places): ${kinds}. Default "base".`);
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
  tool('get_state', 'The model at a glance: the parts (each with its place, its parent, and its own history of features), the features with their status and main numbers, the bodies with volume (mm³) and bounding box in space, which part is current, and whether the page is in the middle of an edit. Start here.'),
  tool('get_selection', 'What the person has clicked in the page and what their mouse last rested on: faces and edges with where they are in space, the part each is on, the point that was clicked ("point" in space, "at" in the face\'s own coordinates) and which features made a face. Call it when they say "this", "here" or "that" about the model. The word "this" can then be given wherever a command takes a face, edges, a part or a feature id.'),
  tool(
    'measure',
    'How big a face or an edge is, and how far apart or at what angle two of them are, where the parts stand. Nothing given: what the person has selected (one thing: its size; two: also what lies between them). "from" alone: its size. "from" and "to": between them. Round things are measured from their axis: two holes give the distance between their centres, a hole and a flat side the distance from the hole\'s centre to that side; two parallel faces give the thickness.',
    {
      from: { description: 'A face or an edge: "this", "selected" or "pointed" (the person\'s); a side name such as "top"; or { "face": index } or { "edge": index } from list_faces and list_edges, each of which may say whose with "part" or "body".' },
      to: { description: 'The other one, given the same way.' },
    }
  ),
  tool(
    'list_dimensions',
    'The numbers that drive the model, as the Dimensions view shows them to the person on the model: every dimension of every sketch, how far each extrusion goes, hole diameters and depths, fillet radii, box and cylinder sizes. Each with what it is, where it is in space, and the command and arguments that change it.',
    { part: str('Only those of one part, by id or name. Left out: of every part.') }
  ),
  tool('get_document', 'The whole project as JSON: exactly what Save writes to a .corecad file.'),
  tool('load_document', 'Replaces the open project with a document in the .corecad format (as get_document returns). The history of undo steps starts over.', { document: { type: 'object', description: 'The project.' } }, ['document']),
  tool('new_document', 'Starts an empty project. The open one is replaced (it stays in the browser only if it was saved).', { name: str('The project\'s name.') }),
  tool('get_sketch', 'One sketch in full: its lines, circles, arcs and points with coordinates and the ids of their points, its dimensions and constraints with their ids, its degrees of freedom (0 = fully constrained), and its closed regions (what extrude can use).', { sketch: SKETCH_ARG }),
  tool('list_faces', 'The faces of a body (or of every body): index, kind (plane, cylinder, …), centre, area, the outward normal of flat faces, radius of round ones, and which side of the body a flat face is ("top", …). Coordinates are in space, where the part stands.', { body: BODY_ARG, part: PART_ARG }),
  tool('list_edges', 'The edges of a body (or of every body) that can be filleted or chamfered: index, kind, end points, middle, length, the two faces it lies between. Optionally only those matching a description. Coordinates are in space.', { body: BODY_ARG, part: PART_ARG, edges: EDGES_ARG }),
  tool(
    'add_sketch',
    'Makes a sketch on an origin plane of a part or on a flat face of a body, optionally with shapes in it. It becomes the next step of that part\'s history. Sketch coordinates are millimetres in the plane; on XY and on top faces they are the part\'s x and y (the world\'s, when the part has not been moved or turned). Returns the sketch as get_sketch does.',
    {
      plane: { description: `"XY" (the ground; default), "XZ", "YZ", or a flat face: ${FACE_ARG.description}` },
      part: str('For an origin plane: the part the sketch goes into, by id or name, or "new" to start a new part. Left out: the current part (a first part is made when there is none).'),
      shapes: SHAPES_ARG,
      name: str('A name for the history.'),
    }
  ),
  tool('add_to_sketch', 'Adds shapes to an existing sketch. Features built on the sketch are rebuilt.', { sketch: SKETCH_ARG, shapes: SHAPES_ARG }, ['shapes']),
  tool(
    'set_dimension',
    'Changes the value of a driving dimension of a sketch; the sketch follows and everything built on it is rebuilt. Ids are in get_sketch.',
    { sketch: SKETCH_ARG, dimension: str('The dimension\'s id, such as "c9"; or "this": the number the person has clicked on the model (see get_selection).'), value: numb('Millimetres, or degrees for an angle.') },
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
      operation: str('Default: "new" when the sketch\'s part has no body yet, otherwise "join". Only the bodies of that part are joined or cut: other parts are combined with combine.', { enum: ['new', 'join', 'cut', 'intersect'] }),
      symmetric: bool('The distance is the total, half to each side of the sketch plane.'),
      distance2: numb('A second distance, against the direction (two-sided extrusion).'),
      flip: bool('Reverse the direction.'),
      name: str('A name for the history.'),
    }
  ),
  tool(
    'revolve',
    'Turns closed regions of a sketch about a line of that sketch into a solid: a new body, joined to the bodies it touches, cut out of them, or their intersection. The regions must lie on one side of the line; they may touch it.',
    {
      sketch: SKETCH_ARG,
      profiles: { description: 'Which regions, as for extrude: "outer" (default), "all", or an array of region indices or of points [x, y] inside them.' },
      axis: str('The line to turn about: the id of a line of the sketch (get_sketch lists them). A construction line is the usual choice; a side of the outline will do.'),
      angle: numb('Degrees: more than 0, at most 360. Left out: 360, all the way round. A turn that is not closed starts in the sketch plane and goes to the side the sketch faces.'),
      operation: str('Default: "new" when the sketch\'s part has no body yet, otherwise "join".', { enum: ['new', 'join', 'cut', 'intersect'] }),
      flip: bool('Turn the other way.'),
    },
    ['axis']
  ),
  tool(
    'hole',
    'Drills a round hole into a flat face, straight in.',
    {
      face: FACE_ARG,
      at: { description: 'Where: [x, y] in the face\'s sketch coordinates (on a top face: the part\'s x and y), or "center". Left out: where the person clicked or points when the face is theirs ("this"); otherwise the middle of the face.' },
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
    'Changes a feature\'s parameters, name or suppression; the features after it are rebuilt. Extrude: distance, through_all, symmetric, distance2, operation, flip. Revolve: angle, axis, operation, flip. Hole: diameter, depth, through_all, at. Fillet: radius. Chamfer: distance. Box: size, origin. Cylinder: diameter, height, origin. Sphere: diameter, origin. Combine: operation, with, keep. (A sketch is changed with set_dimension, add_to_sketch and remove_from_sketch; where a part stands with move_part.)',
    {
      id: str('The feature\'s id, such as "f3"; or "this": the feature the person has selected in the history, or the one that made the face or edge they have selected or point at (the wall or the rim of a hole, say).'),
      name: str('A new name.'),
      suppressed: bool('true: leave the feature out of the model without deleting it.'),
      distance: numb('mm'), through_all: bool('through everything'), symmetric: bool('half to each side'), distance2: numb('mm, the other way'),
      operation: str('new, join, cut or intersect', { enum: ['new', 'join', 'cut', 'intersect'] }), flip: bool('reverse the direction'),
      angle: numb('a revolve: degrees, up to 360'), axis: str('a revolve: the id of a line of its sketch'),
      diameter: numb('mm'), depth: numb('mm'), at: { type: 'array', items: { type: 'number' }, description: '[x, y] on the face' }, radius: numb('mm'),
      size: VEC('a box: [x, y, z] in mm'), height: numb('mm'), origin: str('base, center or corner'),
      with: { type: 'array', items: { type: 'string' }, description: 'a combine: the other parts, by id or name' }, keep: bool('a combine: leave the other parts as they are'),
    },
    ['id']
  ),
  tool(
    'add_box',
    'A box as a new part, without a sketch: the first step of that part\'s history. Place it with position and rotation here, or later with move_part; join it to another part or cut it out of one with combine. The new part becomes the current part.',
    { size: VEC('[x, y, z]: width along X, depth along Y, height along Z, in mm.'), origin: ORIGIN_ARG('"base" (the middle of its bottom face), "center", or "corner" (its lowest corner)'), position: POSITION_ARG, rotation: ROTATION_ARG, parent: PARENT_ARG, name: str('A name for the part.') },
    ['size']
  ),
  tool(
    'add_cylinder',
    'A cylinder along Z as a new part, without a sketch. Turn it with rotation ([90, 0, 0] lays it along -Y, [0, 90, 0] along X). The new part becomes the current part.',
    { diameter: numb('Millimetres.'), height: numb('Millimetres.'), origin: ORIGIN_ARG('"base" (the middle of its bottom face) or "center"'), position: POSITION_ARG, rotation: ROTATION_ARG, parent: PARENT_ARG, name: str('A name for the part.') },
    ['diameter', 'height']
  ),
  tool(
    'add_sphere',
    'A sphere as a new part, without a sketch. The new part becomes the current part.',
    { diameter: numb('Millimetres.'), origin: ORIGIN_ARG('"base" (its lowest point) or "center"'), position: POSITION_ARG, rotation: ROTATION_ARG, parent: PARENT_ARG, name: str('A name for the part.') },
    ['diameter']
  ),
  tool(
    'add_part',
    'A new, empty part: a place for sketches (give it to add_sketch as "part", or leave that out: it is now the current part). To keep parts together, use add_group.',
    { name: str('A name for the part.'), position: POSITION_ARG, rotation: ROTATION_ARG, parent: PARENT_ARG }
  ),
  tool(
    'add_group',
    'A group: a container for parts. It has a name and a place and no shape of its own; what is in it moves, turns and hides with it, takes its colour where it has none, and is exported with it. Give "parts" to put parts that are there into it (they stay where they are in space); a group can hold groups. The group becomes the current part: parts made next go into it unless they are given a "parent".',
    {
      name: str('A name for the group, such as what the parts make up together.'),
      parts: { type: 'array', items: { type: 'string' }, description: 'Parts to put into it, by id or name; "this" for the part the person has selected.' },
      position: POSITION_ARG,
      rotation: ROTATION_ARG,
      parent: PARENT_ARG,
    }
  ),
  tool('ungroup', 'Takes a group away and leaves what was in it where it is, under what the group stood under. (delete_part deletes a group with everything in it.)', { part: str('The group, by id or name; or "this". Left out: the current part.') }),
  tool(
    'combine',
    'Joins other parts to a part, cuts them out of it, or keeps only what it shares with them, where they stand. It is a step in the history of the part that is changed. The other parts become its tools: hidden, placed under it, and still there to edit or move (the result follows). A group or a linked copy can be taken too.',
    {
      part: str('The part that is changed, by id or name. Left out: the current part.'),
      with: { type: 'array', items: { type: 'string' }, description: 'The other parts, by id or name.' },
      operation: str('"join" (add them), "cut" (take them away) or "intersect" (keep the common volume).', { enum: ['join', 'cut', 'intersect'] }),
      keep: bool('true: the other parts stay as they are, visible and where they are in the tree.'),
      name: str('A name for the history.'),
    },
    ['with', 'operation']
  ),
  tool(
    'move_part',
    'Places a part: where it stands, how it is turned, what it stands under. Nothing is rebuilt unless a combine depends on it. What is left out stays as it is.',
    {
      part: PART_ARG,
      position: POSITION_ARG,
      rotation: ROTATION_ARG,
      by: VEC('Instead of position: move it by [dx, dy, dz] mm from where it is (along its parent\'s axes).'),
      turn: { type: 'object', description: 'Instead of rotation: turn it from where it is, { "axis": "x" | "y" | "z", "angle": degrees, "about": "center" (the middle of what it shows; default), "origin" (its own origin) or a point [x, y, z] in its parent\'s frame }.' },
      parent: { description: 'Put it under another part (id or name), or null for none. It stays where it is in space unless position or rotation are given too.' },
    }
  ),
  tool(
    'copy_part',
    'Copies a part with everything under it. A copy of its own has its own history, free to change. linked: true makes a linked copy instead: it shows the original in another place and changes with it (make as many as needed; unlink_part makes one independent). The copy stands where the original stands unless told otherwise, and becomes the current part.',
    { part: PART_ARG, linked: bool('A linked copy.'), position: POSITION_ARG, rotation: ROTATION_ARG, by: VEC('Move the copy by [dx, dy, dz] mm from where the original stands.'), parent: PARENT_ARG, name: str('A name for the copy.') }
  ),
  tool(
    'set_color',
    `Gives a part a colour, or single faces a colour of their own. Colours show in the view and go into 3MF files (each part an object with its colour, painted faces as painted triangles) and STEP files. Without "faces" the whole part is coloured.`,
    {
      color: { description: `"#rrggbb", or a name: ${PALETTE.map(([, n]) => n.toLowerCase()).join(', ')}. null takes the colour away.` },
      part: PART_ARG,
      faces: { description: 'The faces to colour instead of the whole part: "this" (the faces the person has selected, or the one they point at); a side name such as "top"; { "face": index } from list_faces (any face, round ones too); or a list of these. Each may say whose with "part" or "body".' },
    },
    ['color']
  ),
  tool('edit_part', 'Renames a part, or hides or shows it (with everything under it). Hidden parts are not exported.', { part: PART_ARG, name: str('A new name.'), hidden: bool('true hides it, false shows it.') }),
  tool('unlink_part', 'Turns a linked copy into a part of its own, with its own history, in the same place.', { part: PART_ARG }),
  tool('delete_part', 'Deletes a part with its history and everything under it. If linked copies or combine features elsewhere use it, say with_dependents to delete those too, or the command lists them and changes nothing.', { part: PART_ARG, with_dependents: bool('Also delete the linked copies and combine features that use it.') }),
  tool('delete_feature', 'Deletes a feature. If others are built on it they must go too: say so with with_dependents, or the command lists them and changes nothing.', { id: str('The feature\'s id; or "this", as for edit_feature.'), with_dependents: bool('Also delete what is built on it.') }, ['id']),
  tool('undo', 'Takes back the last change.'),
  tool('redo', 'Does again what undo took back.'),
  tool(
    'reload_app',
    'Reloads the CoreCAD tab so that it runs the newest CoreCAD (get_state says under "app" when a newer one is published; a tab that has been open for a while may be older). The project is kept: it is saved in the browser. Undo history is not. The tab is back, and connected again, within some seconds. Its commands may then be more than the tools you hold: an MCP client reads the list of tools again when the server is reconnected in it.'
  ),
  tool('cancel_edit', 'Closes a sketch or a feature dialog that is open in the page without keeping its changes. The commands that change the model need this to be closed.'),
  tool(
    'export',
    'The model as a file. "3mf": for slicers (Bambu Studio, OrcaSlicer, PrusaSlicer, Cura): every part an object of its own, with its name, its colour and its painted faces, where it stands. "stl": a plain mesh; an STL file cannot tell objects apart, so everything is one mesh unless per_part is asked for. "step": exact geometry for other CAD, parts named and coloured. "corecad": the project. Hidden parts are left out. Returned as text (step, corecad) or base64 (3mf, stl), or sent to the browser\'s downloads.',
    {
      format: str('Default "step".', { enum: ['3mf', 'step', 'stl', 'corecad'] }),
      part: str('Only this part and what stands under it: an id, a name, or "this" (the part the person has selected). Left out: everything that is to be seen.'),
      per_part: bool('For "stl" with several parts: a .zip with one STL file for each part, named after it.'),
      download: bool('true: save it through the browser instead of returning its content.'),
    }
  ),
  tool(
    'screenshot',
    'A picture of the 3D view as a PNG data URL, to see what the model looks like.',
    { view: str('Turn the camera first.', { enum: VIEWS }), fit: bool('Fit the model in the view first (default true).'), max: numb('The longer side in pixels at most (default 1200).'), dimensions: bool('true: with the numbers that drive the model drawn on it, as the Dimensions view shows them.') }
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
 * @param {(featureId: string | null, partId?: string | null) => void} app.shown   a command made or changed this: select it, fit the view
 * @param {() => string | null} app.currentPart   the part being worked on
 * @param {() => string | null} app.homePart      the part a new sketch goes into (never a linked copy or a group)
 * @param {() => string | null} [app.container]  the group a new part goes into: the one the person has selected, or the one their part is in
 * @param {string} [app.build]                    this tab's build (src/version.js)
 * @param {() => string | null} [app.newest]      the published build, when it is not this one (as last looked)
 * @param {() => Promise<string | null>} [app.checkUpdate]  looks what is published (at most once a minute)
 * @param {() => void} [app.reload]               reloads the page with all of the published version, a moment from now
 * @param {() => { selected: object[], pointed: object | null, part: string | null, feature: string | null }} app.chosen
 *   what the person has clicked and what their mouse last rested on. A pick is { kind: 'face' | 'edge', index,
 *   body, part, instance, matrix, point }: `body` a built body's id, `point` in its part's frame, `matrix` where
 *   it is shown (for a linked copy, where the copy shows it); `pointed` also has `ms` (how long ago) and `over`.
 *   Also `dimension`: the number on the model they clicked, { feature, key, value, text, what, unit, change }.
 * @param {(on: boolean) => boolean} app.showDimensions   draws the driving numbers on the model or not; answers what it was
 * @param {(blob: Blob, name: string) => void} app.download
 * @param {(doc: object) => string} app.filename
 */
export function createCommands(app) {
  const { store, view } = app;
  const doc = () => store.state.doc;
  const usedUp = () => new Map(Object.entries(store.state.build?.used ?? {}));
  /** Every body the kernel built, with where its part stands; `away` when it is not in the picture (hidden, or used up as a tool). */
  function bodies() {
    const d = doc(),
      built = store.state.build?.bodies ?? [],
      world = worldOf(d),
      shown = new Set(sceneOf(d, built, usedUp()).filter((b) => !b.instance).map((b) => b.id));
    return built.map((b) => ({ ...b, matrix: world.get(b.part) ?? Mat.IDENTITY, ...(shown.has(b.id) ? {} : { away: true }) }));
  }
  /** A part by id or by name; nothing given: the current part. */
  function partOf(ref) {
    const d = doc();
    if (ref === undefined || ref === null) {
      const p = partById(d, app.currentPart());
      if (!p) throw Error('There is no part yet: make one with add_sketch, add_box, add_cylinder, add_sphere or add_part.');
      return p;
    }
    const word = theirWord(ref);
    if (word) {
      // The part the person clicked (in the list or in the view), or the one their mouse rests on.
      const c = app.chosen(),
        p = partById(d, word === 'selected' ? c.part : word === 'pointed' ? c.pointed?.part : c.selected.length ? c.part : c.pointed?.part ?? c.part);
      if (!p)
        throw Error(
          word === 'pointed'
            ? 'The mouse has not come to rest on a part: ask the person to hold it on the part, or to click it.'
            : 'No part is selected: ask the person to click one, in the list or in the view.'
        );
      return p;
    }
    const text = String(ref),
      byId = partById(d, text);
    if (byId) return byId;
    const named = d.parts.filter((x) => x.name.toLowerCase() === text.toLowerCase());
    if (named.length === 1) return named[0];
    throw Error(
      named.length
        ? `${named.length} parts are named "${text}" (${named.map((x) => x.id).join(', ')}): use the id.`
        : `There is no part "${text}". Parts: ${d.parts.map((x) => `${x.id} "${x.name}"`).join(', ') || 'none'}.`
    );
  }
  const ctx = () => ({ current: app.currentPart() ?? undefined });

  // ---- what the person has clicked or points at: "selected", "pointed", and "this" for whichever there is
  const theirWord = (v) => (typeof v === 'string' && ['selected', 'pointed', 'this'].includes(v.toLowerCase()) ? v.toLowerCase() : null);
  /** The picks a word stands for; kind: 'face' or 'edge'. Throws a sentence to pass on when there are none. */
  function theirs(word, kind) {
    const c = app.chosen(),
      selected = c.selected.filter((h) => h.kind === kind),
      pointed = c.pointed?.kind === kind ? [c.pointed] : [],
      hits = word === 'selected' ? selected : word === 'pointed' ? pointed : selected.length ? selected : pointed;
    if (hits.length) return hits;
    const a = kind === 'edge' ? 'an edge' : 'a face',
      other = c.selected.length || c.pointed ? ' (get_selection shows what is.)' : '';
    throw Error(
      (word === 'selected'
        ? `No ${kind} is selected in the page: ask the person to click one (Shift-click adds more).`
        : word === 'pointed'
        ? `The mouse has not come to rest on ${a}: ask the person to hold it there, or to click.`
        : `No ${kind} is selected and the mouse has not come to rest on one: ask the person to click or point at ${a}.`) + other
    );
  }
  const LINKED_FACE = (h) =>
    `That is on ${partById(doc(), h.part)?.name ?? 'a linked copy'}, a linked copy with no history of its own: work on the original, or unlink_part first.`;
  /** The face a command means: the person's ("this"), with `hit` (where they clicked), or one described. */
  function faceFrom(sel) {
    const word = theirWord(sel);
    if (!word) return findFace(bodies(), described(sel), ctx());
    const hits = theirs(word, 'face');
    if (hits.length > 1) throw Error(`${hits.length} faces are selected (${hits.map((h) => `face ${h.index} of body ${h.body}`).join(', ')}): say which, as { "body": id, "face": index }.`);
    if (hits[0].instance) throw Error(LINKED_FACE(hits[0]));
    return { body: findBody(bodies(), hits[0].body), face: hits[0].index, hit: hits[0] };
  }
  /** The edges a command means: the person's, or those described. */
  function edgesFrom(sel, whose = {}) {
    const word = theirWord(sel);
    if (!word) return findEdges(bodies(), described(sel && typeof sel === 'object' && !Array.isArray(sel) ? { ...whose, ...sel } : Array.isArray(sel) ? { ...whose, indices: sel } : sel === 'all' ? { ...whose } : sel), ctx());
    const hits = theirs(word, 'edge');
    if (hits.some((h) => h.instance)) throw Error(LINKED_FACE(hits.find((h) => h.instance)));
    if (new Set(hits.map((h) => h.body)).size > 1) throw Error('The selected edges are on several bodies: one fillet or chamfer takes the edges of one body.');
    return findEdges(bodies(), { body: hits[0].body, indices: [...new Set(hits.map((h) => h.index))] });
  }
  /** The features whose work a face is, read from its labels. */
  function makers(labels) {
    const out = new Map();
    for (const label of labels) {
      const [id, ...as] = label.split('/'),
        f = featureById(doc(), id);
      if (f && !out.has(id)) out.set(id, { id, type: f.type, name: f.name, part: f.part, ...(f.sketch ? { sketch: f.sketch } : {}), as: as.join('/') });
    }
    return [...out.values()];
  }
  /** A feature by id, or the person's: the one selected in the history, or the one that made the face they chose. */
  function featureOf(ref) {
    const word = theirWord(ref);
    if (!word) {
      const f = featureById(doc(), ref);
      if (!f) throw Error(`There is no feature "${ref}".`);
      return f;
    }
    const c = app.chosen();
    if (word !== 'pointed' && c.dimension) return featureById(doc(), c.dimension.feature); // the number they clicked on the model
    if (word !== 'pointed' && c.feature) return featureById(doc(), c.feature);
    const pointed = c.pointed ? [c.pointed] : [],
      h = (word === 'selected' ? c.selected : word === 'pointed' ? pointed : c.selected.length ? c.selected : pointed).at(-1);
    if (!h)
      throw Error('No feature is selected in the history, and no face or edge is selected or pointed at to tell which feature is meant: ask the person to click the feature, or something it made.');
    const topo = topoOfBody(findBody(bodies(), h.body));
    let made = makers(h.kind === 'face' ? topo.faces[h.index].labels : topo.edges[h.index].faces.flatMap((i) => topo.faces[i].labels));
    if (h.kind === 'edge' && made.length > 1) {
      // An edge is where the newer of the features behind its two faces met the older one: the rim of a hole is the hole's.
      const order = doc().features.map((f) => f.id);
      made = [made.reduce((a, b) => (order.indexOf(b.id) > order.indexOf(a.id) ? b : a))];
    }
    if (made.length === 1) return featureById(doc(), made[0].id);
    throw Error(
      made.length
        ? `That ${h.kind} is the work of several features: ${made.map((m) => `${m.name} (${m.id})`).join(', ')}. Say which by its id.`
        : `It is not known which feature made that ${h.kind}: say which by its id.`
    );
  }
  /** The numbers behind a size, as a row carries them. */
  function sizeRow(body, kind, index) {
    const s = sizeOf(body, kind, index),
      out = { measures: s.text };
    for (const k of ['size', 'diameter', 'radius', 'length']) if (s[k] !== undefined) out[k] = round(s[k]);
    if (s.hole) out.hole = true;
    return out;
  }
  /** What lies between two picks, as a row. */
  function betweenRow(m) {
    return {
      what: m.what,
      measures: m.text,
      ...(m.distance !== undefined ? { distance: round(m.distance), from: round(m.from), to: round(m.to), delta: round(m.delta) } : {}),
      ...(m.angle !== undefined ? { angle: round(m.angle) } : {}),
    };
  }
  const asPick = (h) => ({ body: { ...findBody(bodies(), h.body), matrix: h.matrix }, kind: h.kind, index: h.index, point: Mat.point(h.matrix, h.point) });
  /** Faces or edges to measure: the person's ("this"), or one described by a side, { face: index } or { edge: index }. */
  function picksFrom(ref) {
    const word = theirWord(ref);
    if (word) {
      const c = app.chosen(),
        pointed = c.pointed ? [c.pointed] : [],
        hits = word === 'selected' ? c.selected : word === 'pointed' ? pointed : c.selected.length ? c.selected : pointed;
      if (!hits.length)
        throw Error(
          word === 'pointed'
            ? 'The mouse has not come to rest on a face or an edge: ask the person to hold it there, or to click.'
            : 'Nothing is selected in the page: ask the person to click a face or an edge (Shift-click a second one to measure between them), or say what to measure with "from" and "to".'
        );
      return hits.map(asPick);
    }
    if (ref && typeof ref === 'object' && !Array.isArray(ref) && ref.edge !== undefined) {
      const sel = described(ref),
        body = findBody(bodies(), sel.body, { ...ctx(), part: sel.part });
      if (!Number.isInteger(ref.edge) || !topoOfBody(body).edges[ref.edge]) throw Error(`Body ${body.id} has no edge ${ref.edge} (see list_edges).`);
      return [{ body, kind: 'edge', index: ref.edge }];
    }
    const { body, face } = findFace(bodies(), described(ref), ctx());
    return [{ body, kind: 'face', index: face }];
  }
  /** A driving number as a row: what it is, where, and how it is changed. */
  function dimensionRow(x) {
    const f = featureById(doc(), x.feature);
    return {
      feature: x.feature,
      feature_name: f?.name,
      part: f?.part,
      is: x.what,
      value: round(x.value),
      unit: x.unit,
      shown_as: x.text,
      ...(x.at ? { at: round(x.at) } : {}),
      ...(x.edit ?? x.change ? { change_with: (x.edit ?? x.change).command, arguments: x.edit ? x.edit.args(x.value) : x.change.args } : { measured: true }),
    };
  }
  /** A pick as a row to read: where it is in space, on what, made by what. */
  function hitRow(h) {
    const body = { ...findBody(bodies(), h.body), matrix: h.matrix },
      base = { kind: h.kind, part: h.part, part_name: partById(doc(), h.part)?.name, body: h.body, ...(h.instance ? { linked_copy: true } : {}) },
      point = round(Mat.point(h.matrix, h.point));
    if (h.kind === 'face') {
      const { face, kind, ...row } = describeFaces(body)[h.index],
        own = topoOfBody(body).faces[h.index];
      return {
        ...base,
        face,
        surface: kind,
        ...row,
        ...sizeRow(body, 'face', h.index),
        point,
        ...(own.plane ? { at: round(toLocal(canonicalFrame(own.plane.n, own.plane.d), h.point).slice(0, 2)) } : {}),
        made_by: makers(own.labels),
      };
    }
    const { edge, kind, ...row } = describeEdges(body).find((r) => r.edge === h.index) ?? { edge: h.index },
      faces = topoOfBody(body).faces;
    return { ...base, edge, curve: kind, ...row, ...sizeRow(body, 'edge', h.index), point, made_by: makers((row.faces ?? []).flatMap((i) => faces[i].labels)) };
  }
  function selectionInfo() {
    const c = app.chosen(),
      part = partById(doc(), c.part),
      f = featureById(doc(), c.feature);
    return {
      selected: c.selected.map(hitRow),
      ...(c.selected.length === 2 ? { between: betweenRow(between(asPick(c.selected[0]), asPick(c.selected[1]))) } : {}),
      pointed: c.pointed ? { ...hitRow(c.pointed), seconds_ago: round(c.pointed.ms / 1000, 1), mouse_in_view: c.pointed.over } : null,
      part: part ? { id: part.id, name: part.name } : null,
      feature: f ? { id: f.id, type: f.type, name: f.name, part: f.part } : null,
      ...(c.dimension ? { dimension: dimensionRow(c.dimension) } : {}),
    };
  }
  /** A face or edge description with its "part" (an id or a name) made an id. */
  const described = (s) => (s && typeof s === 'object' && !Array.isArray(s) && s.part !== undefined ? { ...s, part: partOf(s.part).id } : s);
  /** The bodies a listing is about: one by id, those of a part, or all that are in the picture. */
  function bodiesFor(a) {
    const list = bodies();
    if (a.body !== undefined) return [findBody(list, a.body)];
    if (a.part !== undefined) {
      const p = partOf(a.part),
        inside = p.group ? new Set(descendantsOf(doc(), p.id)) : null,
        own = list.filter((b) => (inside ? inside.has(b.part) && !b.away : b.part === p.id));
      if (!own.length)
        throw Error(`${p.name} (${p.id}) has no body${p.link ? ': it is a linked copy and shows the bodies of ' + p.link : p.group ? ': it is a group with nothing built in it' : ''}.`);
      return own;
    }
    return list.filter((b) => !b.away);
  }
  const vec3 = (v, what, fallback) => {
    if (v === undefined) return fallback;
    if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) throw Error(`"${what}" must be three numbers.`);
    return [...v];
  };
  const parentFrom = (ref) => (ref === undefined || ref === null || ref === '' ? null : partOf(ref).id);

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
    if (theirWord(id)) {
      // The person's sketch: the one they selected, or the one behind the extrusion they selected or point at.
      const own = featureOf(id),
        sk = own.type === 'sketch' ? own : featureById(doc(), own.sketch);
      if (!sk) throw Error(`${own.name} (${own.id}) is ${own.type === 'extrude' ? 'an' : 'a'} ${own.type}: it was not made from a sketch.`);
      return sk;
    }
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
      part: b.part,
      name: doc().bodies[b.id]?.name ?? 'Body ' + b.id.slice(1),
      volume: round(b.volume, 3),
      box: round(Mat.box(b.matrix, b.bbox)),
      lumps: b.lumps,
      faces: b.mesh.faces.length,
      ...(doc().bodies[b.id]?.hidden ? { hidden: true } : {}),
      ...(b.away ? { shown: false } : {}),
    }));
  /** The box in space round what a part shows (its own bodies and those under it), or null. `local`: its placement, when it is being changed. */
  function boxOf(d, pid, list = bodies(), frame = worldOf(d).get(pid)) {
    const boxes = contentOf(d, pid).flatMap((item) => list.filter((b) => b.part === item.from).map((b) => Mat.box(Mat.mul(frame, item.rel), b.bbox)));
    if (!boxes.length) return null;
    return [[0, 1, 2].map((i) => Math.min(...boxes.map((b) => b[0][i]))), [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b[1][i])))];
  }
  function partRows() {
    const d = doc(),
      list = bodies(),
      used = usedUp();
    return d.parts.map((p) => {
      const fs = featuresOf(d, p.id),
        box = boxOf(d, p.id, list);
      return {
        id: p.id,
        name: p.name,
        kind: p.group ? 'group' : p.link ? 'linked copy' : fs.length ? 'part' : 'empty',
        ...(p.link ? { copy_of: p.link } : {}),
        ...(p.group ? { contains: childrenOf(d, p.id).map((x) => x.id) } : {}),
        parent: p.parent ?? null,
        position: round(p.pos),
        rotation: round(p.rot),
        ...(p.hidden ? { hidden: true } : {}),
        ...(p.color ? { color: p.color } : {}),
        ...(p.paint?.length ? { painted_faces: p.paint.length } : {}),
        ...(used.has(p.id) ? { tool_of: used.get(p.id) } : {}),
        features: fs.map((f) => f.id),
        bodies: list.filter((b) => b.part === p.id).map((b) => b.id),
        ...(box ? { box: round(box) } : {}),
      };
    });
  }
  const partOutcome = (pid, more = {}) => ({ part: partRows().find((x) => x.id === pid) ?? null, ...more, problems: problems(), bodies: bodyRows() });

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
      part: f.part,
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
    if (f.type === 'revolve') return { sketch: f.sketch, axis: f.axis, angle: f.angle, operation: f.operation, ...(f.flip ? { flip: true } : {}), profiles: f.profiles.length };
    if (f.type === 'hole') return { diameter: f.diameter, ...(f.depth === 'all' ? { through_all: true } : { depth: f.depth }), at: round(f.at), on_body: f.face?.body };
    if (f.type === 'fillet') return { radius: f.radius, edges: f.edges.length };
    if (f.type === 'chamfer') return { distance: f.distance, edges: f.edges.length };
    if (f.type === 'box') return { size: f.size, origin: f.origin };
    if (f.type === 'cylinder') return { diameter: f.diameter, height: f.height, origin: f.origin };
    if (f.type === 'sphere') return { diameter: f.diameter, origin: f.origin };
    if (f.type === 'combine') return { operation: f.operation, with: f.tools, ...(f.keep ? { keep: true } : {}) };
    return {};
  }

  /** Which CoreCAD this tab runs, and whether a newer one is published (as last looked). */
  const appInfo = () => {
    const newest = app.newest?.() ?? null;
    return { build: app.build ?? null, update_available: !!newest, ...(newest ? { newest, how: 'reload_app loads it' } : {}) };
  };
  function stateInfo() {
    const st = store.state;
    return {
      project: st.doc.meta.name,
      app: appInfo(),
      units: 'mm',
      parts: partRows(),
      current_part: app.currentPart() ?? null,
      selection: selectionInfo(),
      features: st.doc.features.map((f) => {
        const r = resultOf(f.id);
        return { id: f.id, part: f.part, type: f.type, name: f.name, status: r?.status ?? 'unknown', ...(r?.message ? { message: r.message } : {}), ...summary(f) };
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
      part: f?.part,
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
  async function commit(next, label, id, partId = null) {
    store.commit(next, label);
    const st = await settled();
    if (st.error) throw Error(st.error);
    app.shown(id ?? null, partId);
  }

  /** Makes `next` the document unless it breaks a feature that was whole (a move can pull a tool out of what it cuts). */
  async function partChange(next, label, pid, more) {
    if (next.features.some((f) => f.type === 'combine' && !f.suppressed)) {
      const before = new Set(problems().filter((x) => x.status === 'error').map((x) => x.id));
      store.preview(next);
      const st = await settled(),
        broken = (st.build?.features ?? []).filter((r) => r.status === 'error' && !before.has(r.id));
      if (st.error || broken.length) {
        store.cancelPreview();
        await settled();
        throw Error(st.error || 'That would break ' + broken.map((r) => `${featureById(next, r.id)?.name} (${r.id}): ${r.message}`).join(' '));
      }
    }
    await commit(next, label, null, pid);
    return partOutcome(pid, more);
  }

  /** The parts a combine of `target` is given, as ids. */
  function toolsFrom(list, target) {
    if (!Array.isArray(list) || !list.length) throw Error('"with" lists the other parts, by id or name.');
    const no = new Set([target.id, ...ancestorsOf(doc(), target.id)]);
    const ids = list.map((ref) => {
      const p = partOf(ref);
      if (p.id === target.id) throw Error(`${p.name} cannot be combined with itself.`);
      if (no.has(p.id)) throw Error(`${target.name} stands under ${p.name}, so it is part of it: it cannot be combined with it.`);
      return p.id;
    });
    return [...new Set(ids)];
  }
  /** The parts a combine uses up are put under the part it changes (they stay where they are in space). */
  function adopt(next, feature) {
    if (!feature.keep) for (const t of feature.tools) if (!ancestorsOf(next, t).includes(feature.part)) next = setParent(next, t, feature.part);
    return next;
  }
  /** The placement a new part is given. */
  const placementFrom = (a) => ({
    parent: a.parent === undefined ? app.container?.() ?? null : parentFrom(a.parent),
    pos: vec3(a.position, 'position', [0, 0, 0]),
    rot: vec3(a.rotation, 'rotation', [0, 0, 0]),
  });
  async function primitive(type, a, data) {
    free();
    await settled();
    if (a.origin !== undefined && !(type === 'box' ? ['base', 'center', 'corner'] : ['base', 'center']).includes(a.origin))
      throw Error(`"origin" is "base"${type === 'box' ? ', "center" or "corner"' : ' or "center"'}.`);
    const made = makePart(doc(), { base: type[0].toUpperCase() + type.slice(1), ...(a.name ? { name: String(a.name) } : {}), ...placementFrom(a) }),
      f = makeFeature(made.doc, type, { part: made.part.id, ...data, ...(a.origin !== undefined ? { origin: a.origin } : {}) });
    const out = await apply(addFeature(addPart(f.doc, made.part), f.feature), f.feature, 'Add ' + made.part.name);
    return { ...out, part: partRows().find((x) => x.id === made.part.id) };
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

  /** The line of a sketch that a revolve turns about, by its id. */
  function axisFrom(sk, id) {
    const e = indexSketch(sk).entity(String(id));
    if (e?.type !== 'line') throw Error(`"axis" is the id of a line of ${sk.name}${e ? `: ${id} is ${e.type === 'arc' ? 'an' : 'a'} ${e.type}` : `, and it has no "${id}"`}. Its lines: ${sk.entities.filter((x) => x.type === 'line').map((x) => x.id).join(', ') || 'none'}.`);
    return e.id;
  }
  function regionsFor(sk, which = 'outer') {
    const regions = findRegions(sk);
    if (!regions.length) throw Error(`${sk.name} has no closed region: close its outline first.`);
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
    const hits = edgesFrom(a.edges);
    const made = makeFeature(doc(), type, { part: hits[0].body.part, [key]: a[key], ...(a.name ? { name: String(a.name) } : {}) });
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
      await app.checkUpdate?.();
      await settled();
      return stateInfo();
    },
    async get_selection() {
      await settled();
      return {
        ...selectionInfo(),
        how: 'Give "this" (or "selected", "pointed") wherever a command takes a face, edges, a part or a feature id. A hole on "this" face goes to "point" unless told otherwise; to draw there, use "at" as sketch coordinates on that face.',
      };
    },
    async measure(a) {
      await settled();
      if (a.to !== undefined && a.from === undefined) throw Error('Give "from" as well as "to".');
      const picks = a.from === undefined ? picksFrom('selected') : [...picksFrom(a.from), ...(a.to !== undefined ? picksFrom(a.to) : [])];
      if (a.to !== undefined && picks.length !== 2) throw Error('"from" and "to" are one face or edge each.');
      const row = (p) => ({ kind: p.kind, part: p.body.part, body: p.body.id, [p.kind]: p.index, ...sizeRow(p.body, p.kind, p.index) });
      return {
        of: picks.map(row),
        ...(picks.length === 2 ? { between: betweenRow(between(picks[0], picks[1])) } : picks.length > 2 ? { together: total(picks).text } : {}),
      };
    },
    async list_dimensions(a) {
      await settled();
      const d = doc(),
        world = worldOf(d),
        only = a.part !== undefined ? partOf(a.part).id : null;
      return d.features
        .filter((f) => !only || f.part === only)
        .flatMap((f) => {
          const sk = f.type === 'sketch' ? f : ['extrude', 'revolve'].includes(f.type) ? featureById(d, f.sketch) : null;
          return dimensionsOf(f, { frame: sk ? resultOf(sk.id)?.frame ?? null : null, matrix: world.get(f.part) ?? Mat.IDENTITY, sketch: sk }).map(dimensionRow);
        });
    },
    async reload_app() {
      app.ready();
      if (app.editing()) throw Error('A sketch or a feature dialog is open in the page: finish or cancel it there (or cancel_edit) first, or reloading would lose it.');
      await settled();
      if (!app.reload) throw Error('This page cannot be reloaded by command.');
      await app.checkUpdate?.();
      const info = appInfo();
      app.reload();
      return {
        reloading: true,
        was: info.build,
        ...(info.newest ? { loading: info.newest } : {}),
        note: 'The tab reloads now and connects again by itself within some seconds. If it then has commands that are not among your tools, the list of tools has to be read again: ask the person to reconnect CoreCAD in the client.',
      };
    },
    async get_document() {
      return structuredClone(doc());
    },
    async load_document(a) {
      free();
      const errors = validateDocument(a.document);
      if (errors.length) throw Error('Not a valid CoreCAD project: ' + errors.join(' '));
      store.open(upgrade(structuredClone(a.document)));
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
      return bodiesFor(a).map((b) => {
        const look = appearanceOf(doc(), { id: b.id, part: b.part }, b.mesh.faces);
        return { body: b.id, part: b.part, ...(look.color ? { color: look.color } : {}), faces: describeFaces(b).map((f) => (look.faces.has(f.face) ? { ...f, color: look.faces.get(f.face) } : f)) };
      });
    },
    async list_edges(a) {
      await settled();
      if (a.edges !== undefined) {
        const hits = edgesFrom(a.edges, { ...(a.body !== undefined ? { body: a.body } : {}), ...(a.part !== undefined ? { part: a.part } : {}) });
        const rows = describeEdges(hits[0].body);
        return [{ body: hits[0].body.id, part: hits[0].body.part, edges: rows.filter((r) => hits.some((h) => h.edge === r.edge)) }];
      }
      return bodiesFor(a).map((b) => ({ body: b.id, part: b.part, edges: describeEdges(b) }));
    },
    async add_sketch(a) {
      free();
      await settled();
      const where = a.plane ?? 'XY';
      let plane,
        base = doc(),
        partId,
        newPart = null;
      if (typeof where === 'string' && PLANES.includes(where.toUpperCase())) {
        plane = { kind: 'base', base: where.toUpperCase() };
        // The part it goes into: the one named, the current one, or a new one ("new", or when there is none).
        // A group has no history: named, it gets a new part for the sketch; so does the group the person has selected.
        const named = a.part === undefined ? partById(base, app.homePart()) : a.part === 'new' ? null : partOf(a.part),
          home = named?.group ? null : named,
          into = named?.group ? named.id : app.container?.() ?? null;
        if (home?.link) throw Error(`${home.name} is a linked copy and has no history of its own: sketch in the original (${home.link}), or unlink_part first.`);
        if (home) partId = home.id;
        else {
          const made = makePart(base, { parent: into });
          base = made.doc;
          newPart = made.part;
          partId = newPart.id;
        }
      } else {
        const { body, face } = faceFrom(where);
        plane = { kind: 'face', ref: faceRefFrom(body, face) };
        partId = body.part;
        if (a.part !== undefined && a.part !== 'new' && partOf(a.part).id !== partId) throw Error(`That face belongs to part ${partId}: a sketch on a face is part of that part's history.`);
      }
      const made = makeFeature(base, 'sketch', { plane, part: partId, ...(a.name ? { name: String(a.name) } : {}) });
      const feature = a.shapes?.length ? addShapes(made.feature, a.shapes).sketch : made.feature;
      await commit(addFeature(newPart ? addPart(made.doc, newPart) : made.doc, feature), 'Create ' + feature.name, feature.id);
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
      let sk, wanted = a.dimension;
      if (theirWord(a.dimension)) {
        // The number the person clicked on the model, if it is a sketch's.
        const own = app.chosen().dimension;
        if (!own) throw Error('No number is selected on the model: ask the person to turn on Dimensions and click the one they mean.');
        if (own.change?.command !== 'set_dimension')
          throw Error(`The number they clicked is the ${own.what} of ${featureById(doc(), own.feature)?.name} (${own.feature}), not a sketch dimension: change it with ${own.change ? `${own.change.command} ${JSON.stringify(own.change.args)}` : 'the feature that it measures'}.`);
        sk = featureById(doc(), own.feature);
        wanted = own.key;
      } else sk = sketchOf(a.sketch);
      const c = sk.constraints.find((c) => c.id === wanted);
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
        operation = a.operation ?? (bodies().some((b) => b.part === sk.part) ? 'join' : 'new');
      if (!a.through_all && a.distance === undefined) throw Error('Give a distance (or through_all for a cut).');
      const extent = extentFrom(a, operation);
      // A cut drawn on a face goes into the body, against the face's outward normal, unless told otherwise.
      let flip = a.flip ?? (operation === 'cut' && sk.plane.kind === 'face');
      if (a.distance < 0) flip = !flip;
      const made = makeFeature(doc(), 'extrude', {
        part: sk.part,
        sketch: sk.id,
        profiles: regions.map(profileRefFrom),
        operation,
        extent,
        flip,
        ...(a.name ? { name: String(a.name) } : {}),
      });
      return apply(addFeature(made.doc, made.feature), made.feature, 'Apply ' + made.feature.name);
    },
    async revolve(a) {
      free();
      await settled();
      const sk = sketchOf(a.sketch),
        regions = regionsFor(sk, a.profiles),
        operation = a.operation ?? (bodies().some((b) => b.part === sk.part) ? 'join' : 'new');
      const made = makeFeature(doc(), 'revolve', {
        part: sk.part,
        sketch: sk.id,
        profiles: regions.map(profileRefFrom),
        axis: axisFrom(sk, a.axis),
        angle: a.angle ?? 360,
        operation,
        flip: !!a.flip,
      });
      return apply(addFeature(made.doc, made.feature), made.feature, 'Apply ' + made.feature.name);
    },
    async hole(a) {
      free();
      await settled();
      positive(a.diameter, 'The diameter');
      const { body, face, hit } = faceFrom(a.face ?? 'top'),
        ref = faceRefFrom(body, face),
        frame = canonicalFrame(ref.hint.n, ref.hint.d),
        centred = typeof a.at === 'string' && ['center', 'centre'].includes(a.at.toLowerCase());
      // "position" is a point in space; the face's own coordinates are those of its part. On a face
      // the person chose, a hole goes where they clicked or point unless it is told where.
      const at =
        a.at !== undefined && !centred
          ? a.at
          : toLocal(
              frame,
              centred ? ref.hint.center : a.position !== undefined ? Mat.point(Mat.invert(body.matrix), vec3(a.position, 'position')) : hit ? hit.point : ref.hint.center
            ).slice(0, 2);
      if (!Array.isArray(at) || at.length !== 2 || !at.every(Number.isFinite)) throw Error('"at" must be [x, y] on the face.');
      const made = makeFeature(doc(), 'hole', {
        part: body.part,
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
      const f = featureOf(a.id);
      const allowed =
        {
          sketch: [],
          extrude: ['distance', 'through_all', 'symmetric', 'distance2', 'operation', 'flip'],
          revolve: ['angle', 'axis', 'operation', 'flip'],
          hole: ['diameter', 'depth', 'through_all', 'at'],
          fillet: ['radius'],
          chamfer: ['distance'],
          box: ['size', 'origin'],
          cylinder: ['diameter', 'height', 'origin'],
          sphere: ['diameter', 'origin'],
          combine: ['operation', 'with', 'keep'],
        }[f.type] ?? [];
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
      if (f.type === 'revolve') {
        if (a.angle !== undefined) next.angle = a.angle;
        if (a.axis !== undefined) next.axis = axisFrom(featureById(doc(), f.sketch) ?? { name: 'its sketch', entities: [], points: [] }, a.axis);
        if (a.operation !== undefined) next.operation = a.operation;
        if (a.flip !== undefined) next.flip = !!a.flip;
      }
      if (f.type === 'hole') {
        if (a.diameter !== undefined) next.diameter = a.diameter;
        if (a.through_all) next.depth = 'all';
        else if (a.depth !== undefined) next.depth = a.depth;
        if (a.at !== undefined) next.at = a.at;
      }
      if (f.type === 'fillet' && a.radius !== undefined) next.radius = a.radius;
      if (f.type === 'chamfer' && a.distance !== undefined) next.distance = a.distance;
      if (f.type === 'box' && a.size !== undefined) next.size = vec3(a.size, 'size');
      if (['cylinder', 'sphere'].includes(f.type) && a.diameter !== undefined) next.diameter = a.diameter;
      if (f.type === 'cylinder' && a.height !== undefined) next.height = a.height;
      if (['box', 'cylinder', 'sphere'].includes(f.type) && a.origin !== undefined) next.origin = a.origin;
      if (f.type === 'combine') {
        if (a.operation !== undefined) next.operation = a.operation;
        if (a.with !== undefined) next.tools = toolsFrom(a.with, partById(doc(), f.part));
        if (a.keep !== undefined) next.keep = !!a.keep;
        return apply(adopt(updateFeature(doc(), f.id, () => next), next), next, 'Edit ' + next.name);
      }
      return apply(updateFeature(doc(), f.id, () => next), next, 'Edit ' + next.name);
    },
    async add_box(a) {
      const size = vec3(a.size, 'size');
      size.forEach((v, i) => positive(v, ['The width', 'The depth', 'The height'][i]));
      return primitive('box', a, { size });
    },
    async add_cylinder(a) {
      return primitive('cylinder', a, { diameter: positive(a.diameter, 'The diameter'), height: positive(a.height, 'The height') });
    },
    async add_sphere(a) {
      return primitive('sphere', a, { diameter: positive(a.diameter, 'The diameter') });
    },
    async add_part(a) {
      free();
      await settled();
      const made = makePart(doc(), { ...(a.name ? { name: String(a.name) } : {}), ...placementFrom(a) });
      await commit(addPart(made.doc, made.part), 'New part', null, made.part.id);
      return partOutcome(made.part.id);
    },
    async add_group(a) {
      free();
      await settled();
      const members = a.parts === undefined ? [] : Array.isArray(a.parts) ? [...new Set(a.parts.map((ref) => partOf(ref).id))] : null;
      if (!members) throw Error('"parts" lists the parts to put into the group, by id or name.');
      const d = doc(),
        inside = members.filter((id) => ancestorsOf(d, id).some((x) => members.includes(x)));
      if (inside.length) throw Error(`${partById(d, inside[0]).name} already stands under another of these parts: name only the part it stands under.`);
      const data = {
        ...(a.name ? { name: String(a.name) } : {}),
        pos: vec3(a.position, 'position', [0, 0, 0]),
        rot: vec3(a.rotation, 'rotation', [0, 0, 0]),
        // where it stands in the tree: as told; else where the first of its parts stands; else in the group that is selected
        ...(a.parent !== undefined ? { parent: parentFrom(a.parent) } : members.length ? {} : { parent: app.container?.() ?? null }),
      };
      if (data.parent && members.some((id) => id === data.parent || descendantsOf(d, id).includes(data.parent)))
        throw Error('A group cannot stand under one of the parts it is to hold.');
      const made = groupParts(d, members, data);
      return partChange(made.doc, 'New group', made.id);
    },
    async ungroup(a) {
      free();
      await settled();
      const g = partOf(a.part);
      if (!g.group) throw Error(`${g.name} (${g.id}) is not a group.`);
      const d = doc(),
        freed = childrenOf(d, g.id).map((x) => x.id);
      await commit(ungroup(d, g.id), 'Ungroup ' + g.name, null, g.parent ?? null);
      return { ungrouped: g.id, freed, parts: partRows(), problems: problems(), bodies: bodyRows() };
    },
    async combine(a) {
      free();
      await settled();
      const target = partOf(a.part);
      if (target.group) throw Error(`${target.name} is a group and has no shape of its own: name the part that is to be changed. (A group can be given in "with": everything in it is then joined or cut.)`);
      if (target.link) throw Error(`${target.name} is a linked copy: combine changes a part with a history. Use the original (${target.link}), or unlink_part first.`);
      if (!['join', 'cut', 'intersect'].includes(a.operation)) throw Error('"operation" is "join", "cut" or "intersect".');
      const made = makeFeature(doc(), 'combine', { part: target.id, operation: a.operation, tools: toolsFrom(a.with, target), keep: !!a.keep, ...(a.name ? { name: String(a.name) } : {}) });
      const out = await apply(adopt(addFeature(made.doc, made.feature), made.feature), made.feature, 'Apply ' + made.feature.name);
      return { ...out, parts: partRows() };
    },
    async move_part(a) {
      free();
      await settled();
      const p = partOf(a.part);
      let next = doc();
      if (a.parent !== undefined) next = setParent(next, p.id, parentFrom(a.parent));
      const cur = partById(next, p.id),
        rot = vec3(a.rotation, 'rotation', null);
      let pos = vec3(a.position, 'position', null);
      if (a.by !== undefined) {
        if (pos) throw Error('Give "position" or "by", not both.');
        const by = vec3(a.by, 'by');
        pos = cur.pos.map((v, i) => v + by[i]);
      }
      let placed = { pos: pos ?? cur.pos, rot: rot ?? cur.rot };
      if (a.turn !== undefined) {
        if (rot) throw Error('Give "rotation" or "turn", not both.');
        const axis = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[String(a.turn?.axis).toLowerCase()];
        if (!axis || !Number.isFinite(a.turn.angle)) throw Error('"turn" is { "axis": "x", "y" or "z", "angle": degrees, "about": "center", "origin" or [x, y, z] }.');
        const local = Mat.fromPlacement(placed.pos, placed.rot),
          about = a.turn.about ?? 'center';
        let pivot = placed.pos;
        if (Array.isArray(about)) pivot = vec3(about, 'about');
        else if (about === 'center') {
          // the middle of what the part shows, in its parent's frame
          const box = boxOf(next, p.id, bodies(), local);
          if (box) pivot = [0, 1, 2].map((i) => (box[0][i] + box[1][i]) / 2);
        } else if (about !== 'origin') throw Error('"about" is "center", "origin" or a point [x, y, z].');
        placed = Mat.toPlacement(Mat.mul(Mat.turn(axis, a.turn.angle, pivot), local));
      }
      next = updatePart(next, p.id, placed);
      if (a.parent === undefined && pos === null && rot === null && a.turn === undefined) throw Error('Say where: give position, rotation, by, turn or parent.');
      return partChange(next, 'Move ' + p.name, p.id);
    },
    async copy_part(a) {
      free();
      await settled();
      const p = partOf(a.part),
        c = copyPart(doc(), p.id, { linked: !!a.linked });
      let next = c.doc;
      if (a.parent !== undefined) next = setParent(next, c.id, parentFrom(a.parent));
      const cur = partById(next, c.id),
        rot = vec3(a.rotation, 'rotation', null);
      let pos = vec3(a.position, 'position', null);
      if (a.by !== undefined) {
        if (pos) throw Error('Give "position" or "by", not both.');
        const by = vec3(a.by, 'by');
        pos = cur.pos.map((v, i) => v + by[i]);
      }
      next = updatePart(next, c.id, { ...(a.name ? { name: String(a.name) } : {}), pos: pos ?? cur.pos, rot: rot ?? cur.rot });
      return partChange(next, (a.linked ? 'Linked copy of ' : 'Copy of ') + p.name, c.id, { copy_of: p.id });
    },
    async set_color(a) {
      free();
      await settled();
      const color = colorFrom(a.color);
      if (a.faces === undefined) {
        const p = partOf(a.part);
        await commit(setPartColor(doc(), p.id, color), (color ? 'Colour ' : 'Clear the colour of ') + p.name, null, p.id);
        return partOutcome(p.id);
      }
      // Faces: the person's, or described; of any shape. Each is painted on the part it belongs to.
      const refs = Array.isArray(a.faces) ? a.faces : [a.faces],
        whose = a.part !== undefined ? { part: partOf(a.part).id } : {},
        picks = refs.flatMap((ref) => picksFrom(ref && typeof ref === 'object' && !Array.isArray(ref) ? { ...whose, ...ref } : typeof ref === 'string' && !theirWord(ref) && whose.part ? { ...whose, side: ref } : ref));
      const edges = picks.filter((x) => x.kind !== 'face');
      if (edges.length) throw Error('Only faces can be painted: what is selected or was named includes an edge.');
      let next = doc();
      for (const x of picks) next = paintFaces(next, x.body.part, [{ body: x.body.id, labels: topoOfBody(x.body).faces[x.index].labels }], color);
      const parts = [...new Set(picks.map((x) => x.body.part))];
      await commit(next, color ? 'Colour faces' : 'Clear the colour of faces', null, parts[0]);
      return { painted: picks.map((x) => ({ part: x.body.part, body: x.body.id, face: x.index })), color, ...partOutcome(parts[0]) };
    },
    async edit_part(a) {
      free();
      await settled();
      const p = partOf(a.part);
      if (a.name === undefined && a.hidden === undefined) throw Error('Give a name, or hidden: true or false.');
      const next = updatePart(doc(), p.id, (x) => {
        const { hidden, ...rest } = x,
          hide = a.hidden === undefined ? !!hidden : !!a.hidden;
        return { ...rest, ...(a.name !== undefined ? { name: String(a.name) } : {}), ...(hide ? { hidden: true } : {}) };
      });
      if (!partById(next, p.id).name.trim()) throw Error('A part needs a name.');
      await commit(next, 'Edit ' + p.name, null, p.id);
      return partOutcome(p.id);
    },
    async unlink_part(a) {
      free();
      await settled();
      const p = partOf(a.part),
        u = unlinkPart(doc(), p.id);
      return partChange(u.doc, 'Unlink ' + p.name, u.id);
    },
    async delete_part(a) {
      free();
      await settled();
      const d = doc(),
        p = partOf(a.part),
        deps = partDependents(d, p.id),
        under = descendantsOf(d, p.id);
      if ((deps.links.length || deps.features.length) && !a.with_dependents)
        throw Error(
          `${[
            ...deps.links.map((l) => `the linked copy ${partById(d, l).name} (${l})`),
            ...deps.features.map((f) => `${featureById(d, f).name} (${f}) of part ${featureById(d, f).part}`),
          ].join(', ')} ${deps.links.length + deps.features.length > 1 ? 'use' : 'uses'} ${p.name}. Say with_dependents: true to delete ${deps.links.length + deps.features.length > 1 ? 'them' : 'it'} too.`
        );
      let next = removePart(d, p.id);
      for (const l of deps.links) next = removePart(next, l);
      for (const f of deps.features) next = removeFeature(next, f);
      await commit(next, 'Delete ' + p.name, null, null);
      return { deleted: { parts: [p.id, ...under, ...deps.links], features: [...d.features.filter((f) => !featureById(next, f.id)).map((f) => f.id)] }, parts: partRows(), problems: problems(), bodies: bodyRows() };
    },
    async delete_feature(a) {
      free();
      await settled();
      const f = featureOf(a.id);
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
      if (!['3mf', 'step', 'stl', 'corecad'].includes(format)) throw Error('"format" is "3mf", "step", "stl" or "corecad".');
      if (format !== 'corecad' && !bodies().length) throw Error('There is no body to export yet.');
      const only = a.part !== undefined && format !== 'corecad' ? partOf(a.part) : null,
        blob =
          format === 'corecad'
            ? new Blob([serialize(doc())], { type: 'application/json' })
            : await store.kernel.export(doc(), { format, split: !!a.per_part, ...(only ? { parts: [only.id] } : {}) }),
        // several parts as STL, one file each, come as a zip
        zipped = format === 'stl' && !!a.per_part && new Uint8Array(await blob.slice(0, 2).arrayBuffer()).join() === '80,75',
        name = app.filename(only ? { meta: { name: `${doc().meta.name} - ${only.name}` } } : doc()) + (zipped ? ' STL.zip' : '.' + format);
      if (a.download) {
        app.download(blob, name);
        return { format, filename: name, bytes: blob.size, downloaded: true };
      }
      if (blob.size > 30e6) throw Error(`The file is ${Math.round(blob.size / 1e6)} MB: too large to return; ask for download: true.`);
      return format === 'stl' || format === '3mf'
        ? { format, filename: name, bytes: blob.size, ...(zipped ? { zip: true } : {}), base64: toBase64(new Uint8Array(await blob.arrayBuffer())) }
        : { format, filename: name, bytes: blob.size, text: await blob.text() };
    },
    async screenshot(a) {
      await settled();
      if (a.view !== undefined) {
        if (!STANDARD[a.view]) throw Error(`Unknown view "${a.view}". Views: ${VIEWS.join(', ')}.`);
        view.standard(a.view);
      }
      if (a.fit !== false) view.fit();
      const numbers = a.dimensions === undefined ? null : app.showDimensions(a.dimensions),
        shot = view.snapshot();
      if (numbers !== null) app.showDimensions(numbers);
      const k = Math.min(1, (a.max ?? 1200) / Math.max(shot.width, shot.height));
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

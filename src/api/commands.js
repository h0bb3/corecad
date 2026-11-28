// The command set: everything a script or an agent can do to the model, by name,
// with plain JSON in and out. It is what window.corecad.run() calls, and its
// `tools` list (name, description, JSON Schema of the arguments) is made to be
// handed to an MCP server or to WebMCP unchanged.
//
// One way to do each thing: a command does one thing, and nothing that another
// command does is also an argument here. Making takes what the thing cannot be
// without; its name, its place and what goes into it have commands of their own.
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
import { validateDocument, upgrade } from '../doc/schema.js';
import { gzipText } from '../core/pack.js';
import { partById, featuresOf, worldOf, makePart, addPart, updatePart, removePart, partDependents, setParent, copyPart, unlinkPart, importParts, sceneOf, contentOf, descendantsOf, ancestorsOf, childrenOf, setPartColor, paintFaces, appearanceOf } from '../doc/parts.js';
import { PALETTE, colorFrom } from './colors.js';
import * as Mat from '../core/mat.js';
import { sizeOf, between, total } from './measure3d.js';
import { faceRefFrom, edgeRefFrom, topoOfBody } from '../doc/refs.js';
import { canonicalFrame, toLocal } from '../core/plane.js';
import { STANDARD } from '../view/camera-math.js';
import { sectionText } from '../view/section.js';
import * as Drawing from '../drawing/model.js';
import { measureOf, MARGIN, TITLE_BLOCK } from '../drawing/layout.js';
import { createDrawings, today } from '../drawing/make.js';
import { sheetToPDF } from '../drawing/pdf.js';
import { sheetToSVG } from '../drawing/svg.js';

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

/** The commands that look at the model, or change how it is shown, and never change the model itself. */
/** The longest STEP file that is taken, in characters. */
export const MAX_IMPORT = 20e6;
export const READS = new Set(['get_state', 'get_selection', 'measure', 'get_document', 'get_sketch', 'list_faces', 'list_edges', 'get_drawing', 'export', 'screenshot', 'set_view', 'set_section', 'set_xray']);

export const TOOLS = [
  tool('get_state', 'The model at a glance: the parts (each with its place, its parent, and its own history of features), the features with their status and main numbers, the bodies with volume (mm³) and bounding box in space, which part is current, and whether the page is in the middle of an edit. Start here.'),
  tool('get_selection', 'What the person has clicked in the page and what their mouse last rested on: faces and edges with where they are in space, the part each is on, the point that was clicked ("point" in space, "at" in the face\'s own coordinates) and which features made a face. Call it when they say "this", "here" or "that" about the model. The word "this" can then be given wherever a command takes a face, edges, a part or a feature id. It also says how they are looking at the model ("looking"): which way the camera faces, whether the model is cut open and where (set_section), and whether it is drawn see-through (set_xray). What they point at may be inside the model.'),
  tool(
    'measure',
    'How big a face or an edge is, and how far apart or at what angle two of them are, where the parts stand. Nothing given: what the person has selected (one thing: its size; two: also what lies between them). "from" alone: its size. "from" and "to": between them. Round things are measured from their axis: two holes give the distance between their centres, a hole and a flat side the distance from the hole\'s centre to that side; two parallel faces give the thickness.',
    {
      from: { description: 'A face or an edge: "this", "selected" or "pointed" (the person\'s); a side name such as "top"; or { "face": index } or { "edge": index } from list_faces and list_edges, each of which may say whose with "part" or "body".' },
      to: { description: 'The other one, given the same way.' },
    }
  ),
  tool('get_document', 'The whole project as JSON: exactly what Save writes to a .corecad file.'),
  tool('load_document', 'Replaces the open project with a document in the .corecad format (as get_document returns). The history of undo steps starts over.', { document: { type: 'object', description: 'The project.' } }, ['document']),
  tool('new_document', 'Starts an empty project. The open one is replaced (it stays in the browser only if it was saved).', { name: str('The project\'s name.') }),
  tool('get_sketch', 'One sketch in full: its lines, circles, arcs and points with coordinates and the ids of their points, its dimensions and constraints with their ids, its degrees of freedom (0 = fully constrained), and its closed regions (what extrude can use).', { sketch: SKETCH_ARG }),
  tool('list_faces', 'The faces of a body (or of every body): index, kind (plane, cylinder, …), centre, area, the outward normal of flat faces, radius of round ones, and which side of the body a flat face is ("top", …). Coordinates are in space, where the part stands.', { body: BODY_ARG, part: PART_ARG }),
  tool('list_edges', 'The edges of a body (or of every body) that can be filleted or chamfered: index, kind, end points, middle, length, the two faces it lies between. Optionally only those matching a description. Coordinates are in space.', { body: BODY_ARG, part: PART_ARG, edges: EDGES_ARG }),
  tool(
    'add_sketch',
    'Makes an empty sketch on an origin plane of a part or on a flat face of a body; add_to_sketch puts shapes into it. It becomes the next step of that part\'s history. Sketch coordinates are millimetres in the plane; on XY and on top faces they are the part\'s x and y (the world\'s, when the part has not been moved or turned). Returns the sketch as get_sketch does.',
    {
      plane: { description: `"XY" (the ground; default), "XZ", "YZ", or a flat face: ${FACE_ARG.description}` },
      part: str('For an origin plane: the part the sketch goes into, by id or name (add_part makes one). Left out: the current part.'),
    }
  ),
  tool('add_to_sketch', 'Adds shapes to a sketch. Features built on the sketch are rebuilt.', { sketch: SKETCH_ARG, shapes: SHAPES_ARG }, ['shapes']),
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
    'Extrudes closed regions of a sketch into a solid: a new body, joined to the bodies it touches, cut out of them, or their intersection. (A hole is a circle in a sketch on the face, extruded as a cut.)',
    {
      sketch: SKETCH_ARG,
      profiles: { description: 'Which regions: "outer" (default: every outline with its holes left open), "all" (holes filled too), or an array of region indices from get_sketch or of points [x, y] inside the regions meant.' },
      distance: numb('How far, in mm, along the sketch plane\'s normal (a cut on a face goes into the body).'),
      through_all: bool('For cut and intersect: through everything, instead of a distance.'),
      operation: str('Default: "new" when the sketch\'s part has no body yet, otherwise "join". Only the bodies of that part are joined or cut: other parts are combined with combine.', { enum: ['new', 'join', 'cut', 'intersect'] }),
      distance2: numb('A second distance, against the direction (two-sided extrusion).'),
      flip: bool('Reverse the direction.'),
    }
  ),
  tool(
    'revolve',
    'Turns closed regions of a sketch about a line of that sketch into a solid: a new body, joined to the bodies it touches, cut out of them, or their intersection. The regions must lie on one side of the line; they may touch it. With a rise the regions also move along the line as they turn: a thread, a spring, a screw.',
    {
      sketch: SKETCH_ARG,
      profiles: { description: 'Which regions, as for extrude: "outer" (default), "all", or an array of region indices or of points [x, y] inside them.' },
      axis: str('The line to turn about: the id of a line of the sketch (get_sketch lists them). A construction line is the usual choice; a side of the outline will do.'),
      angle: numb('Degrees: more than 0, at most 360; with a rise up to 36000, every 360 a turn. Left out: 360, all the way round. A turn that is not closed starts in the sketch plane and goes to the side the sketch faces.'),
      rise: numb('How far, in mm, the regions move along the axis in each full turn. Left out or 0: none, an ordinary revolve. With a rise they go along the axis the way the axis line runs from its first point to its second, and turn as a right-handed screw does. A thread is a tooth drawn beside the axis, with a rise greater than the tooth is long along the axis, and an angle of 360 for each turn. A tooth that is joined to a body or cut from one must cross that body\'s surface: draw it reaching a little past the surface (0.2 mm will do), with no side lying in the surface and no corner on it.'),
      left_handed: bool('With a rise: turn as a left-handed screw does.'),
      operation: str('Default: "new" when the sketch\'s part has no body yet, otherwise "join".', { enum: ['new', 'join', 'cut', 'intersect'] }),
      flip: bool('Turn the other way. With a rise: go the other way along the axis.'),
    },
    ['axis']
  ),
  tool(
    'import',
    'Brings a file into the open project; nothing that is open is replaced (that is load_document). "step": the solids of a STEP file become a new part of fixed geometry: it has no history, and can be measured, cut, joined, combined and built on like any part (its flat faces take sketches, its edges fillets). "corecad": the parts of another CoreCAD project are added with their histories and stay editable; when it has several parts they come in a group named after it. What comes in stands where it stood in its file: place it with move_part, name it with edit_part.',
    {
      format: str('What the content is.', { enum: ['step', 'corecad'] }),
      content: { description: 'step: the text of the STEP file (it begins with ISO-10303-21;). corecad: the project as get_document gives it, as an object or as its JSON text.' },
    },
    ['format', 'content']
  ),
  tool('fillet', 'Rounds edges of a body with a radius.', { edges: EDGES_ARG, radius: numb('Millimetres.') }, ['edges', 'radius']),
  tool('chamfer', 'Bevels edges of a body by a distance.', { edges: EDGES_ARG, distance: numb('Millimetres.') }, ['edges', 'distance']),
  tool(
    'edit_feature',
    'Changes a feature\'s parameters, name or suppression; the features after it are rebuilt. Extrude: distance, through_all, distance2, operation, flip. Revolve: angle, rise, left_handed, axis, operation, flip. Fillet: radius. Chamfer: distance. Combine: operation, with, keep. What a person made with the page\'s own tools is changed here too: a hole (diameter, depth, through_all, at), a box (size, origin), a cylinder (diameter, height, origin), a sphere (diameter, origin). (A sketch is changed with set_dimension, add_to_sketch and remove_from_sketch; where a part stands with move_part.)',
    {
      id: str('The feature\'s id, such as "f3"; or "this": the feature the person has selected in the history, or the one that made the face or edge they have selected or point at (the wall or the rim of a hole, say).'),
      name: str('A new name.'),
      suppressed: bool('true: leave the feature out of the model without deleting it.'),
      distance: numb('mm'), through_all: bool('through everything'), distance2: numb('mm, the other way; 0: none'),
      operation: str('new, join, cut or intersect', { enum: ['new', 'join', 'cut', 'intersect'] }), flip: bool('reverse the direction'),
      angle: numb('a revolve: degrees, up to 360, or with a rise 360 for each turn'), axis: str('a revolve: the id of a line of its sketch'),
      rise: numb('a revolve: mm along the axis in each turn; 0: none'), left_handed: bool('a revolve with a rise: as a left-handed screw'),
      diameter: numb('mm'), depth: numb('mm'), at: { type: 'array', items: { type: 'number' }, description: '[x, y] on the face' }, radius: numb('mm'),
      size: VEC('a box: [x, y, z] in mm'), height: numb('mm'), origin: str('base, center or corner'),
      with: { type: 'array', items: { type: 'string' }, description: 'a combine: the other parts, by id or name' }, keep: bool('a combine: leave the other parts as they are'),
    },
    ['id']
  ),
  tool('add_part', 'A new, empty part: a place for sketches. It stands at the origin, under nothing, and becomes the current part. edit_part names it; move_part places it or puts it into a group.'),
  tool(
    'add_group',
    'A new, empty group: a container for parts. It has a name and a place and no shape of its own; what is in it moves, turns and hides with it, takes its colour where it has none, and is exported with it. It stands at the origin, under nothing. move_part puts a part into it ("parent") and takes one out; a group can hold groups. (delete_part deletes a group with everything in it: move out first what is to stay.)'
  ),
  tool(
    'combine',
    'Joins other parts to a part, cuts them out of it, or keeps only what it shares with them, where they stand. It is a step in the history of the part that is changed. The other parts become its tools: hidden, placed under it, and still there to edit or move (the result follows). A group or a linked copy can be taken too.',
    {
      part: str('The part that is changed, by id or name. Left out: the current part.'),
      with: { type: 'array', items: { type: 'string' }, description: 'The other parts, by id or name.' },
      operation: str('"join" (add them), "cut" (take them away) or "intersect" (keep the common volume).', { enum: ['join', 'cut', 'intersect'] }),
      keep: bool('true: the other parts stay as they are, visible and where they are in the tree.'),
    },
    ['with', 'operation']
  ),
  tool(
    'move_part',
    'Places a part: where it stands, how it is turned, what it stands under. Nothing is rebuilt unless a combine depends on it. What is left out stays as it is.',
    {
      part: PART_ARG,
      position: VEC('Where the part\'s origin is: [x, y, z] in mm, in its parent\'s frame (in space when it has no parent).'),
      rotation: VEC('How it is turned: [rx, ry, rz] in degrees, about the fixed X axis first, then Y, then Z, round the part\'s origin.'),
      parent: { description: 'Put it under another part or into a group (id or name), or null for none. It stays where it is in space unless position or rotation are given too.' },
    }
  ),
  tool(
    'copy_part',
    'Copies a part with everything under it. A copy of its own has its own history, free to change. linked: true makes a linked copy instead: it shows the original in another place and changes with it (make as many as needed; unlink_part makes one independent). The copy stands where the original stands, under what it stands under, and becomes the current part: move_part places it.',
    { part: PART_ARG, linked: bool('A linked copy.') }
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
    'The model as a file. "3mf": for slicers (Bambu Studio, OrcaSlicer, PrusaSlicer, Cura): every part an object of its own, with its name, its colour and its painted faces, where it stands. "stl": a plain mesh; an STL file cannot tell objects apart, so everything is one mesh unless per_part is asked for. "step": exact geometry for other CAD, parts named and coloured. "pdf": a drawing (add_drawing), one page at its true size, to print at 100 %. Hidden parts are left out. Returned as text (step) or base64 (3mf, stl, pdf), or sent to the browser\'s downloads. (The project itself is get_document.)',
    {
      format: str('Default "step".', { enum: ['3mf', 'step', 'stl', 'pdf'] }),
      drawing: str('For "pdf": the drawing, by id such as "d1" or by name. Left out: the newest drawing.'),
      part: str('Only this part and what stands under it: an id, a name, or "this" (the part the person has selected). Left out: everything that is to be seen.'),
      per_part: bool('For "stl" with several parts: a .zip with one STL file for each part, named after it.'),
      download: bool('true: save it through the browser instead of returning its content.'),
    }
  ),
  tool(
    'screenshot',
    'A picture of the 3D view as it stands, as a PNG data URL, to see what the model looks like (set_view turns the camera and fits the model); or, with "drawing", a picture of that drawing\'s sheet.',
    {
      max: numb('The longer side in pixels at most (default 1200).'),
      dimensions: bool('true: with the numbers that drive the model drawn on it, as the Dimensions view shows them.'),
      drawing: str('A drawing (by id or name): the picture is of its sheet, not of the 3D view.'),
    }
  ),
  tool('set_view', 'Turns the camera to a standard view and fits the model in the picture.', { view: str('The view. Left out: the camera stays turned as it is.', { enum: VIEWS }), fit: bool('Fit the model (default true).') }),
  tool(
    'set_section',
    'Cuts the model open to look inside, along a plane square to an axis: what lies beyond the plane is not drawn, the cut through each solid is filled in, and the faces inside can be seen, pointed at and measured. It changes how the model is shown, in the page and in screenshot, never the model. The person has the same in the page (Section); get_selection says how they are looking.',
    {
      plane: { type: ['string', 'null'], enum: [...PLANES, null], description: 'The plane the cut lies along: "XY" (the cut moves along z), "XZ" (along y) or "YZ" (along x). null: the model whole again.' },
      at: numb('Where the cut is along that axis, in mm. Left out: through the middle of the model.'),
      flip: bool('false (default): what lies above "at" along the axis is taken away. true: what lies below it.'),
    },
    ['plane']
  ),
  tool('set_xray', 'Draws the solids see-through, with every edge showing, or solid again. Like set_section it changes how the model is shown, not the model.', { on: bool('true: see-through. false: solid.') }, ['on']),
  tool(
    'add_drawing',
    'Starts a drawing of a part for the workshop: an empty sheet of A4 (landscape) at 1:1, with a frame and a title block that names the part and the project. add_view puts views of the part on it, add_drawing_dimension the sizes; edit_drawing changes the paper and the scale; export with format "pdf" gives it to print. A drawing is kept in the project and follows the model: change the part and the drawing shows it as it is. Returns the drawing as get_drawing does.',
    { part: PART_ARG }
  ),
  tool(
    'edit_drawing',
    'Changes a drawing: its name, the part it shows, the paper, the scale, and what its title block and notes say (drawing number, revision, date of issue, owner, who drew and who approved it, material, general tolerances, surface finish, notes). Views keep their places on the paper; check them with get_drawing after a change of paper or scale.',
    {
      drawing: str('The drawing: its id such as "d1", or its name. Left out: the newest drawing.'),
      name: str('Its name, in the title block.'),
      part: PART_ARG,
      sheet: str('The paper: A4 (297 × 210 mm), A3, A2, A1, A0, landscape; or "A4 portrait".', { enum: Object.keys(Drawing.SHEETS) }),
      scale: numb('How big the part is drawn: 1 is its true size, 0.5 is 1:2, 2 is 2:1. One scale for every view; it is written in the title block.'),
      ...Object.fromEntries(Object.entries(Drawing.FIELDS).map(([k, label]) => [k, str(`${label}: text in the title block${k === 'notes' ? ' (the notes stand above it, numbered)' : ''}. "" takes it away.${k === 'date' ? ' It is the day the drawing was made until it is given.' : ''}`)])),
    }
  ),
  tool(
    'edit_drawing_dimension',
    'Gives a dimension of a drawing a tolerance, written after its number: "±0.1", "+0.2/-0", or a fit such as "H7" (Ø8H7). What has none falls under the general tolerances of the title block (edit_drawing).',
    { dimension: str('The dimension\'s id, such as "m5" (get_drawing).'), tolerance: { type: ['string', 'null'], description: 'The tolerance as it is to be written; null or "" takes it away.' } },
    ['dimension', 'tolerance']
  ),
  tool('delete_drawing', 'Deletes a drawing with its views and dimensions. The model is not touched.', { drawing: str('The drawing: id or name.') }, ['drawing']),
  tool(
    'add_view',
    'Puts a view of the drawing\'s part on its sheet: the part as seen from one side, at the scale of the drawing, with the edges behind it dashed and centre lines through what is round; "iso" is a picture from the front, the right and above, without hidden edges. Views are placed by first angle projection (ISO, as in Europe): the top view below the front view, the view from the left to the right of it, the view from the right to its left, the view from below above it; each lined up with the front view. Answers where it stands on the paper and how big it is, so that the next one can be placed (get_drawing tells the same).',
    {
      drawing: str('The drawing: id or name. Left out: the newest drawing.'),
      look: str('Where the part is seen from: front (from -y, z up), back, left, right (from +x), top (from +z, y up), bottom, iso.', { enum: Drawing.LOOK_NAMES }),
      at: VEC('Where the middle of the view stands on the paper: [x, y] in mm from its lower left corner. The frame leaves 20 mm on the left and 10 mm on the other sides; the title block fills the lower right corner (get_drawing says where).'),
    },
    ['look', 'at']
  ),
  tool(
    'add_section_view',
    'Puts a section on the drawing: the part cut along a straight line across a view (horizontal or vertical on the paper), seen square onto the cut, with what the cut goes through hatched at 45° and no hidden edges. The view it is cut from gets the cutting line, thick at its ends, with arrows the way the section looks and its letter (A, B, …); the section is named SECTION A-A under it. It looks from the side of the line the arrows start from: a horizontal cut of the front view from above (lined up as the top view is, below the front view), a vertical cut from the right (to the left of it, as the view from the right is); flip looks from the other side. Its sizes are added as in any view.',
    {
      view: str('The view it is cut from, such as "v2": a view from a side (not iso, not a section).'),
      cut: str('Which way the cutting line runs on that view.', { enum: ['horizontal', 'vertical'] }),
      through: numb('Where the plane lies, as a coordinate of space along the axis the line runs square to: for a horizontal cut of the front view, a height z; for a vertical one, an x. Through the centre of a hole is the usual place (list_faces gives it). Left out: through the middle of the part.'),
      flip: bool('true: seen from the other side of the line (the arrows turn).'),
      at: VEC('Where the middle of the section stands on the paper: [x, y] in mm from its lower left corner.'),
    },
    ['view', 'cut', 'at']
  ),
  tool(
    'add_detail_view',
    'Puts a detail on the drawing: a round piece of a view drawn larger, to show and size what is small. The view it comes from gets a thin circle round that piece with a letter; the detail is the same piece inside a circle, named DETAIL B (5:1) under it, with its own scale. Sizes are added to it as to any view.',
    {
      view: str('The view it enlarges, such as "v2" (any view but a detail).'),
      around: VEC('The middle of the piece, on the paper: [x, y] in mm, inside that view (get_drawing gives its box).'),
      radius: numb('How far the piece reaches round that middle, in mm on the paper as the view is drawn now.'),
      scale: numb('The scale of the detail: 5 is 5:1. Left out: twice the scale of the view it comes from.'),
      at: VEC('Where the middle of the detail stands on the paper: [x, y] in mm.'),
    },
    ['view', 'around', 'radius', 'at']
  ),
  tool(
    'add_revision',
    'Adds a row to the revision table of a drawing (on its title block, the newest at the top): the next letter (A, then B, …), today\'s date, what changed and who changed it. The title block\'s REV is the newest letter.',
    { drawing: str('The drawing: id or name. Left out: the newest drawing.'), description: str('What changed, in a few words.'), by: str('Who changed it (initials).') },
    ['description']
  ),
  tool(
    'add_surface_symbol',
    'Puts a surface texture symbol (ISO 1302) on a flat face in a view where the face is seen from its side, as a line: standing on it when it faces up, else at the end of a leader from it. Its text says what the surface must be (Ra 1.6). A surface with no symbol of its own is as the title block\'s surface finish says.',
    {
      view: str('The view\'s id, such as "v2".'),
      face: { description: 'The face: "this", a side name such as "top", or { "face": index } from list_faces.' },
      value: str('What the surface must be, such as "Ra 1.6". Left out: the symbol alone.'),
      process: str('"any" (default): made in any way; "removal": material must be taken off (machined); "no_removal": it must not be.', { enum: ['any', 'removal', 'no_removal'] }),
    },
    ['view', 'face']
  ),
  tool('move_view', 'Moves a view on its sheet, with its dimensions.', { view: str('The view\'s id, such as "v2" (get_drawing).'), at: VEC('Where its middle stands on the paper: [x, y] in mm from the lower left corner.') }, ['view', 'at']),
  tool(
    'add_drawing_dimension',
    'Draws a size in a view of a drawing, with its number, measured from the model: between two things (two parallel faces, two holes, a hole and a face, two edges), or of one thing (a hole or a round edge: its diameter, an arc: its radius, a straight edge: its length). It is placed outside the view by itself, each new one further out. It must lie flat in that view, as a length does that is not seen shortened: the width of a plate in the front or the top view, the diameter of a hole in the view that looks into it. What it measures is kept, and the number follows the model when it changes. Refused, with the reason, when it cannot be drawn in that view.',
    {
      view: str('The view\'s id, such as "v2" (add_view, get_drawing).'),
      from: { description: 'A face or an edge of the drawing\'s part: "this", "selected" or "pointed" (the person\'s; two selected things are a distance between them); a side name such as "left"; or { "face": index } or { "edge": index } from list_faces and list_edges.' },
      to: { description: 'The other one, given the same way, for a distance between two things.' },
      along: str('For a distance that runs at a slant in the view: "horizontal" or "vertical" draws only that part of it. Left out: the distance as it is.', { enum: ['horizontal', 'vertical'] }),
    },
    ['view', 'from']
  ),
  tool('remove_from_drawing', 'Takes views, dimensions, surface symbols or rows of the revision table off their drawing, by id. A view takes with it its dimensions and symbols, and the sections and details made from it.', { ids: { type: 'array', items: { type: 'string' }, description: 'Ids of views ("v2"), dimensions ("m5"), symbols ("s7") and revisions ("r6").' } }, ['ids']),
  tool(
    'get_drawing',
    'A drawing as it stands: its paper and scale, where the frame and the title block are, each view with where it stands and the box it fills on the paper (mm from the lower left corner), and each dimension with the number it shows, or why it cannot be drawn now. screenshot with "drawing" shows it.',
    { drawing: str('The drawing: id or name. Left out: the newest drawing.') }
  ),
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
 * @param {() => { camera: object, section: object | null, xray: boolean }} app.looking   how the person is looking at the model
 * @param {(section: { plane: string, at?: number, flip?: boolean } | null) => object | null} app.setSection   cuts the model open (view/section.js)
 * @param {(on: boolean) => boolean} app.setXray   draws the solids see-through
 * @param {(blob: Blob, name: string) => void} app.download
 * @param {(doc: object) => string} app.filename
 * @param {ReturnType<typeof createDrawings>} [app.drawings]  the page's drawings (drawing/make.js), with what it has made of them
 * @param {(id: string) => void} [app.drawingShown]  a command made or changed this drawing
 */
export function createCommands(app) {
  const { store, view } = app;
  const drawings = app.drawings ?? createDrawings(store.kernel);
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
      if (!p) throw Error('There is no part yet: make one with add_part.');
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
  /** The box in space round what a part shows (its own bodies and those under it), or null. */
  function boxOf(d, pid, list = bodies()) {
    const frame = worldOf(d).get(pid),
      boxes = contentOf(d, pid).flatMap((item) => list.filter((b) => b.part === item.from).map((b) => Mat.box(Mat.mul(frame, item.rel), b.bbox)));
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
    if (f.type === 'revolve') return { sketch: f.sketch, axis: f.axis, angle: f.angle, ...(f.rise > 0 ? { rise: f.rise, ...(f.left_handed ? { left_handed: true } : {}) } : {}), operation: f.operation, ...(f.flip ? { flip: true } : {}), profiles: f.profiles.length };
    if (f.type === 'import') return { format: f.format, bytes: f.bytes };
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
      features: st.doc.features.map((f) => {
        const r = resultOf(f.id);
        return { id: f.id, part: f.part, type: f.type, name: f.name, status: r?.status ?? 'unknown', ...(r?.message ? { message: r.message } : {}), ...summary(f) };
      }),
      bodies: bodyRows(),
      drawings: Drawing.drawingsOf(st.doc).map((d) => ({ id: d.id, name: d.name, part: d.part, sheet: d.sheet, scale: Drawing.scaleText(d.scale), views: d.views.length, dimensions: d.dims.length })),
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
      if (!base) return { type: a.flip === undefined ? 'symmetric' : 'oneSide', distance: 'all' };
      return { type: base.type === 'symmetric' ? 'symmetric' : 'oneSide', distance: 'all' };
    }
    const d = a.distance ?? (wasAll ? undefined : base?.distance);
    if (d === undefined) throw Error('Give a distance.');
    if (d < 0) throw Error('The distance is a positive number of millimetres: "flip" reverses the direction.');
    const distance = positive(d, 'The distance');
    // Half to each side is something a person chooses in the page: it stays so until a second distance is given.
    if (base?.type === 'symmetric' && a.distance2 === undefined) return { type: 'symmetric', distance };
    const distance2 = a.distance2 ?? (base?.type === 'twoSides' ? base.distance2 : undefined);
    if (distance2 !== undefined && distance2 !== 0) return { type: 'twoSides', distance, distance2: distance2 === 'all' ? 'all' : positive(distance2, 'The second distance') };
    return { type: 'oneSide', distance };
  }

  async function blend(type, a) {
    free();
    await settled();
    const key = type === 'fillet' ? 'radius' : 'distance';
    positive(a[key], type === 'fillet' ? 'The radius' : 'The distance');
    const hits = edgesFrom(a.edges);
    const made = makeFeature(doc(), type, { part: hits[0].body.part, [key]: a[key] });
    made.feature.edges = hits.map((h, i) => edgeRefFrom(h.body, h.edge, 'k' + (i + 1)));
    made.feature.kseq = hits.length;
    return apply(addFeature(made.doc, made.feature), made.feature, 'Apply ' + made.feature.name);
  }


  // ---- drawings
  /** A drawing by id or by name; nothing given: the newest. */
  function drawingOf(ref) {
    const list = Drawing.drawingsOf(doc());
    if (ref === undefined || ref === null) {
      if (!list.length) throw Error('There is no drawing yet: make one with add_drawing.');
      return list.at(-1);
    }
    const text = String(ref),
      found = Drawing.drawingById(doc(), text) ?? list.filter((d) => d.name.toLowerCase() === text.toLowerCase());
    if (!Array.isArray(found)) return found;
    if (found.length === 1) return found[0];
    throw Error(found.length ? `${found.length} drawings are named "${text}": use the id.` : `There is no drawing "${text}". Drawings: ${list.map((d) => `${d.id} "${d.name}"`).join(', ') || 'none'}.`);
  }
  function viewOf(id) {
    const hit = Drawing.itemById(doc(), String(id));
    if (!hit?.view) throw Error(`There is no view "${id}". Views: ${Drawing.drawingsOf(doc()).flatMap((d) => d.views.map((v) => `${v.id} (${v.look}, ${d.name})`)).join(', ') || 'none'}.`);
    return hit;
  }
  const sheetOf = async (d) => drawings.sheet(doc(), store.state.build, d.id);
  /** A drawing as get_drawing tells it. */
  async function drawingInfo(d) {
    const sheet = await sheetOf(d),
      [w, h] = sheet.size,
      part = partById(doc(), d.part);
    return {
      id: d.id,
      name: d.name,
      part: d.part,
      part_name: part?.name,
      sheet: d.sheet,
      paper: [w, h],
      scale: Drawing.scaleText(d.scale),
      scale_factor: d.scale,
      fields: Object.fromEntries(Drawing.FIELD_NAMES.map((k) => [k, d.fields?.[k] ?? ''])),
      frame: [MARGIN.left, MARGIN.bottom, w - MARGIN.right, h - MARGIN.top],
      title_block: [round(Math.max(MARGIN.left, w - MARGIN.right - TITLE_BLOCK.width), 2), MARGIN.bottom, w - MARGIN.right, MARGIN.bottom + TITLE_BLOCK.height],
      views: d.views.map((v) => {
        const box = sheet.views.find((x) => x.id === v.id)?.box;
        return { id: v.id, look: v.look, ...(v.detail ? { detail: { letter: v.detail.letter, of: v.detail.of, scale: Drawing.scaleText(v.detail.scale) } } : {}), ...(v.section ? { section: { letter: v.section.letter, of: v.section.of, cut: v.section.cut, through: v.section.through, ...(v.section.flip ? { flip: true } : {}) } } : {}), at: v.at, ...(box ? { box: round(box, 2), size: round([box[2] - box[0], box[3] - box[1]], 2) } : { empty: 'the part shows nothing from here' }) };
      }),
      dimensions: d.dims.map((m) => {
        const x = sheet.dims.find((y) => y.id === m.id);
        return { id: m.id, view: m.view, ...(m.along ? { along: m.along } : {}), ...(m.tolerance ? { tolerance: m.tolerance } : {}), ...(x?.problem ? { problem: x.problem } : { shows: x?.text, value: x?.value }) };
      }),
      revisions: (d.revisions ?? []).map((r) => ({ id: r.id, rev: r.rev, description: r.description, date: r.date, ...(r.by ? { by: r.by } : {}) })),
      symbols: (d.symbols ?? []).map((x) => {
        const row = sheet.symbols?.find((y) => y.id === x.id);
        return { id: x.id, view: x.view, value: x.value, process: x.process, ...(row?.problem ? { problem: row.problem } : {}) };
      }),
      how: 'Paper coordinates are mm from the lower left corner. A dimension stands outside its view: leave about 25 mm round a view for them. screenshot with "drawing" shows the sheet; export with format "pdf" gives it to print.',
    };
  }
  async function drawingChange(next, label, d) {
    await commit(next, label, null, null);
    app.drawingShown?.(d.id);
    return drawingInfo(Drawing.drawingById(doc(), d.id));
  }
  /** The bodies of a drawing's part, as the picks of a dimension are looked for among them. */
  function drawingBodies(d) {
    const inside = new Set([d.part, ...descendantsOf(doc(), d.part)]);
    return bodies().filter((b) => inside.has(b.part) && !b.away);
  }
  /** What a dimension measures, as the agent named it: of the drawing's part. */
  function drawingPicks(d, ref) {
    const scoped =
      typeof ref === 'string' && !theirWord(ref) && SIDE_NAMES.includes(ref)
        ? { side: ref, part: d.part }
        : ref && typeof ref === 'object' && !Array.isArray(ref) && ref.part === undefined && ref.body === undefined
        ? { ...ref, part: d.part }
        : ref;
    const picks = picksFrom(scoped),
      inside = new Set([d.part, ...descendantsOf(doc(), d.part)]),
      name = partById(doc(), d.part)?.name;
    for (const p of picks) {
      if (p.body.instance || String(p.body.id).includes('~')) throw Error(`That is on a linked copy: a dimension measures the part ${name} itself.`);
      if (!inside.has(p.body.part)) throw Error(`That is on ${partById(doc(), p.body.part)?.name ?? 'another part'}, and ${d.name} shows ${name}.`);
    }
    return picks;
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
      const l = app.looking();
      return {
        ...selectionInfo(),
        looking: { ...l, camera: { ...l.camera, towards: round(l.camera.towards), up: round(l.camera.up) } },
        how: 'Give "this" (or "selected", "pointed") wherever a command takes a face, edges, a part or a feature id. To draw where they clicked: add_sketch with "plane": "this", then shapes at "at", which is that point in the sketch\'s coordinates.',
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
    async add_drawing(a) {
      free();
      await settled();
      const p = partOf(a.part);
      if (p.link) throw Error(`${p.name} is a linked copy: draw ${partById(doc(), p.link)?.name ?? 'the original'} instead.`);
      const { doc: next, drawing } = Drawing.addDrawing(doc(), p.id, today());
      return drawingChange(next, 'Add ' + drawing.name, drawing);
    },
    async edit_drawing(a) {
      free();
      await settled();
      const d = drawingOf(a.drawing),
        patch = {};
      if (a.name !== undefined) {
        if (typeof a.name !== 'string' || !a.name.trim()) throw Error('A drawing needs a name.');
        patch.name = a.name.trim();
      }
      if (a.part !== undefined) {
        const p = partOf(a.part);
        if (p.link) throw Error(`${p.name} is a linked copy: draw ${partById(doc(), p.link)?.name ?? 'the original'} instead.`);
        patch.part = p.id;
      }
      if (a.sheet !== undefined) {
        if (!Drawing.SHEETS[a.sheet]) throw Error(`"sheet" is one of ${Object.keys(Drawing.SHEETS).join(', ')}.`);
        patch.sheet = a.sheet;
      }
      if (a.scale !== undefined) {
        if (!(Number.isFinite(a.scale) && a.scale >= 0.001 && a.scale <= 1000)) throw Error('"scale" is a positive number: 1 for true size, 0.5 for 1:2, 2 for 2:1.');
        patch.scale = a.scale;
      }
      for (const k of Drawing.FIELD_NAMES) {
        if (a[k] === undefined) continue;
        if (a[k] !== null && typeof a[k] !== 'string') throw Error(`"${k}" is a text.`);
        (patch.fields ??= {})[k] = (a[k] ?? '').trim();
      }
      if (!Object.keys(patch).length) throw Error(`Say what to change: name, part, sheet, scale, or ${Drawing.FIELD_NAMES.join(', ')}.`);
      let next = Drawing.editDrawing(doc(), d.id, patch);
      // a dimension of another part means nothing on this one
      if (patch.part && patch.part !== d.part) next = Drawing.removeItems(next, d.id, d.dims.map((m) => m.id));
      return drawingChange(next, 'Change ' + d.name, d);
    },
    async delete_drawing(a) {
      free();
      await settled();
      const d = drawingOf(a.drawing);
      await commit(Drawing.deleteDrawing(doc(), d.id), 'Delete ' + d.name, null, null);
      app.drawingShown?.(null);
      return { deleted: d.id, drawings: Drawing.drawingsOf(doc()).map((x) => ({ id: x.id, name: x.name })) };
    },
    async add_view(a) {
      free();
      await settled();
      const d = drawingOf(a.drawing);
      if (!Drawing.LOOKS[a.look]) throw Error(`"look" is one of ${Drawing.LOOK_NAMES.join(', ')}.`);
      if (!Array.isArray(a.at) || a.at.length !== 2 || !a.at.every(Number.isFinite)) throw Error('"at" is [x, y] on the paper, in mm from its lower left corner.');
      const { doc: next, view: v } = Drawing.addView(doc(), d.id, a.look, a.at),
        info = await drawingChange(next, `Add a ${a.look} view to ${d.name}`, d);
      return { view: info.views.find((x) => x.id === v.id), drawing: info };
    },
    async add_section_view(a) {
      free();
      await settled();
      const { drawing: d, view: of } = viewOf(a.view);
      if (!['horizontal', 'vertical'].includes(a.cut)) throw Error('"cut" is "horizontal" or "vertical": the way the cutting line runs on the view.');
      if (of.look === 'iso' || of.look === 'section') throw Error(`A section is cut from a view from a side (front, top, …), not from ${of.look === 'iso' ? 'the iso view' : 'another section'}.`);
      if (!Array.isArray(a.at) || a.at.length !== 2 || !a.at.every(Number.isFinite)) throw Error('"at" is [x, y] on the paper, in mm from its lower left corner.');
      if (a.through !== undefined && !Number.isFinite(a.through)) throw Error('"through" is a number of millimetres.');
      const probe = { look: 'section', section: { of: of.id, cut: a.cut, through: 0, flip: !!a.flip, letter: 'A' } },
        { axis } = Drawing.planeOf(d, probe),
        boxes = drawingBodies(d).map((b) => Mat.box(b.matrix, b.bbox)),
        name = 'xyz'[axis];
      if (!boxes.length) throw Error(`${partById(doc(), d.part)?.name} shows no solid to cut.`);
      const lo = Math.min(...boxes.map((b) => b[0][axis])),
        hi = Math.max(...boxes.map((b) => b[1][axis])),
        through = a.through ?? (lo + hi) / 2;
      if (through <= lo + 1e-6 || through >= hi - 1e-6) throw Error(`A plane at ${name} = ${round(through, 3)} misses the part: it reaches from ${name} = ${round(lo, 3)} to ${round(hi, 3)}.`);
      const { doc: next, view: v } = Drawing.addSectionView(doc(), d.id, { of: of.id, cut: a.cut, through, flip: !!a.flip, at: a.at }),
        info = await drawingChange(next, `Add section ${v.section.letter}-${v.section.letter} to ${d.name}`, d);
      return { view: info.views.find((x) => x.id === v.id), plane: `${name} = ${round(through, 3)}`, drawing: info };
    },
    async add_detail_view(a) {
      free();
      await settled();
      const { drawing: d, view: of } = viewOf(a.view);
      if (of.look === 'detail') throw Error('A detail is made from a view that is not itself a detail.');
      const pair = (v) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
      if (!pair(a.around) || !pair(a.at)) throw Error('"around" and "at" are [x, y] on the paper, in mm from its lower left corner.');
      if (!(a.radius > 0)) throw Error('"radius" is a positive number of mm on the paper.');
      if (a.scale !== undefined && !(Number.isFinite(a.scale) && a.scale > 0 && a.scale <= 1000)) throw Error('"scale" is a positive number: 5 for 5:1.');
      const sheet = await sheetOf(d),
        sv = sheet.views.find((x) => x.id === of.id);
      if (!sv?.box) throw Error(`The ${Drawing.viewName(of)} view shows nothing to enlarge.`);
      const [x0, y0, x1, y1] = sv.box;
      if (a.around[0] < x0 - 1 || a.around[0] > x1 + 1 || a.around[1] < y0 - 1 || a.around[1] > y1 + 1)
        throw Error(`[${a.around}] is not on the ${Drawing.viewName(of)} view: it fills [${round([x0, y0, x1, y1], 1)}] on the paper.`);
      const ownAt = of.at,
        centre = [sv.centre[0] + (a.around[0] - ownAt[0]) / sv.scale, sv.centre[1] + (a.around[1] - ownAt[1]) / sv.scale],
        scale = a.scale ?? 2 * sv.scale,
        { doc: next, view: v } = Drawing.addDetailView(doc(), d.id, { of: of.id, centre: round(centre, 4), radius: round(a.radius / sv.scale, 4), scale, at: a.at }),
        info = await drawingChange(next, `Add detail ${v.detail.letter} to ${d.name}`, d);
      return { view: info.views.find((x) => x.id === v.id), drawing: info };
    },
    async add_revision(a) {
      free();
      await settled();
      const d = drawingOf(a.drawing);
      if (typeof a.description !== 'string' || !a.description.trim()) throw Error('Say in "description" what changed.');
      if (a.by !== undefined && typeof a.by !== 'string') throw Error('"by" is a text.');
      if ((d.revisions ?? []).at(-1)?.rev === 'Z') throw Error('The revision table has reached Z.');
      const { doc: next, revision } = Drawing.addRevision(doc(), d.id, { description: a.description.trim(), date: today(), by: (a.by ?? '').trim() }),
        info = await drawingChange(next, `Revision ${revision.rev} of ${d.name}`, d);
      return { revision: info.revisions.find((r) => r.id === revision.id), drawing: info };
    },
    async add_surface_symbol(a) {
      free();
      await settled();
      const { drawing: d, view: v } = viewOf(a.view);
      if (a.process !== undefined && !['any', 'removal', 'no_removal'].includes(a.process)) throw Error('"process" is "any", "removal" or "no_removal".');
      if (a.value !== undefined && typeof a.value !== 'string') throw Error('"value" is a text, such as "Ra 1.6".');
      const picks = drawingPicks(d, a.face);
      if (picks.length !== 1) throw Error('A surface symbol is on one face.');
      const ref = Drawing.pickRefFrom(picks[0].body, picks[0].kind, picks[0].index),
        { doc: next, symbol } = Drawing.addSymbol(doc(), d.id, { view: v.id, face: ref, value: (a.value ?? '').trim(), process: a.process ?? 'any' }),
        trial = (await drawings.sheet(next, store.state.build, d.id)).symbols.find((x) => x.id === symbol.id);
      if (trial?.problem) throw Error(trial.problem);
      const info = await drawingChange(next, `Surface symbol on ${d.name}`, d);
      return { symbol: info.symbols.find((x) => x.id === symbol.id), drawing: info };
    },
    async move_view(a) {
      free();
      await settled();
      const { drawing: d, view: v } = viewOf(a.view);
      if (!Array.isArray(a.at) || a.at.length !== 2 || !a.at.every(Number.isFinite)) throw Error('"at" is [x, y] on the paper, in mm from its lower left corner.');
      const info = await drawingChange(Drawing.moveView(doc(), v.id, a.at), `Move the ${v.look} view of ${d.name}`, d);
      return { view: info.views.find((x) => x.id === v.id), drawing: info };
    },
    async add_drawing_dimension(a) {
      free();
      await settled();
      const { drawing: d, view: v } = viewOf(a.view);
      if (a.along !== undefined && !['horizontal', 'vertical'].includes(a.along)) throw Error('"along" is "horizontal" or "vertical".');
      const picks = [...drawingPicks(d, a.from), ...(a.to !== undefined ? drawingPicks(d, a.to) : [])];
      if (picks.length > 2) throw Error(`That is ${picks.length} things: a dimension is of one thing, or between two.`);
      // the same test the sheet makes, now, so that what cannot be drawn is refused with its reason
      const g = measureOf({ along: a.along ?? null }, picks, Drawing.viewAxes(d, v), Drawing.viewName(v)),
        refs = picks.map((p) => Drawing.pickRefFrom(p.body, p.kind, p.index)),
        { doc: next, dim } = Drawing.addDim(doc(), d.id, { view: v.id, from: refs[0], to: refs[1] ?? null, along: a.along ?? null }),
        info = await drawingChange(next, `Add a dimension to ${d.name}`, d);
      return { dimension: info.dimensions.find((x) => x.id === dim.id) ?? { id: dim.id, value: round(g.value) }, drawing: info };
    },
    async edit_drawing_dimension(a) {
      free();
      await settled();
      const hit = Drawing.itemById(doc(), String(a.dimension));
      if (!hit?.dim) throw Error(`There is no dimension "${a.dimension}" on any drawing (get_drawing lists them).`);
      if (a.tolerance !== null && typeof a.tolerance !== 'string') throw Error('"tolerance" is a text, such as "±0.1" or "H7", or null.');
      const t = (a.tolerance ?? '').trim().replace(/^\+-/, '±');
      if (t.length > 24) throw Error('That tolerance is long for a dimension: put it in the notes (edit_drawing).');
      const info = await drawingChange(Drawing.editDim(doc(), hit.dim.id, t || null), `Tolerance of ${hit.dim.id}`, hit.drawing);
      return { dimension: info.dimensions.find((x) => x.id === hit.dim.id), drawing: info };
    },
    async remove_from_drawing(a) {
      free();
      await settled();
      if (!Array.isArray(a.ids) || !a.ids.length) throw Error('"ids" lists views and dimensions, such as ["m5"].');
      const hits = a.ids.map((id) => {
        const hit = Drawing.itemById(doc(), String(id));
        if (!hit) throw Error(`There is no view or dimension "${id}" on any drawing.`);
        return hit;
      });
      if (new Set(hits.map((h) => h.drawing.id)).size > 1) throw Error('Those are on several drawings: take them off one drawing at a time.');
      const d = hits[0].drawing;
      return drawingChange(Drawing.removeItems(doc(), d.id, a.ids.map(String)), `Remove from ${d.name}`, d);
    },
    async get_drawing(a) {
      await settled();
      return drawingInfo(drawingOf(a.drawing));
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
      let plane, partId;
      if (typeof where === 'string' && PLANES.includes(where.toUpperCase())) {
        plane = { kind: 'base', base: where.toUpperCase() };
        const home = a.part === undefined ? partById(doc(), app.homePart()) : partOf(a.part);
        if (!home) throw Error(doc().parts.some((x) => !x.group && !x.link) ? 'The current part is a group: say with "part" which part the sketch goes into.' : 'There is no part to sketch in yet: make one with add_part.');
        if (home.group) throw Error(`${home.name} is a group and has no history of its own: sketch in a part (add_part makes one, move_part puts it into the group).`);
        if (home.link) throw Error(`${home.name} is a linked copy and has no history of its own: sketch in the original (${home.link}), or unlink_part first.`);
        partId = home.id;
      } else {
        const { body, face } = faceFrom(where);
        plane = { kind: 'face', ref: faceRefFrom(body, face) };
        partId = body.part;
        if (a.part !== undefined && partOf(a.part).id !== partId) throw Error(`That face belongs to part ${partId}: a sketch on a face is part of that part's history.`);
      }
      const made = makeFeature(doc(), 'sketch', { plane, part: partId });
      await commit(addFeature(made.doc, made.feature), 'Create ' + made.feature.name, made.feature.id);
      return outcome(made.feature.id, { sketch: sketchInfo(featureById(doc(), made.feature.id)) });
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
      const flip = a.flip ?? (operation === 'cut' && sk.plane.kind === 'face');
      const made = makeFeature(doc(), 'extrude', { part: sk.part, sketch: sk.id, profiles: regions.map(profileRefFrom), operation, extent, flip });
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
        rise: a.rise ?? 0,
        left_handed: !!a.left_handed,
        operation,
        flip: !!a.flip,
      });
      return apply(addFeature(made.doc, made.feature), made.feature, 'Apply ' + made.feature.name);
    },
    async import(a) {
      free();
      await settled();
      if (a.format === 'step') {
        const text = typeof a.content === 'string' ? a.content : '';
        if (!/^\s*ISO-10303-21\s*;/.test(text)) throw Error('"content" is not the text of a STEP file: one begins with ISO-10303-21;');
        if (text.length > MAX_IMPORT) throw Error(`This STEP file is ${(text.length / 1e6).toFixed(1)} MB. The most that is taken is ${MAX_IMPORT / 1e6} MB.`);
        const part = makePart(doc(), { base: 'Imported' }),
          placed = addPart(part.doc, part.part),
          made = makeFeature(placed, 'import', { part: part.part.id, format: 'step', data: { gzip: await gzipText(text) }, bytes: text.length });
        // as any feature: built first, and kept only when it could be built
        const next = addFeature(made.doc, made.feature),
          errors = validateFeature(made.feature);
        if (errors.length) throw Error(errors.join(' '));
        store.preview(next);
        const st = await settled(),
          r = st.build?.features.find((x) => x.id === made.feature.id);
        if (st.error || !r || r.status === 'error') {
          const why = st.error || (r ? [r.message, r.detail].filter(Boolean).join(' ') : 'What was imported could not be built.');
          store.cancelPreview();
          await settled();
          throw Error(why);
        }
        await commit(next, 'Import ' + placed.parts.at(-1).name, made.feature.id, part.part.id);
        return outcome(made.feature.id);
      }
      if (a.format === 'corecad') {
        let other = a.content;
        if (typeof other === 'string') {
          try {
            other = JSON.parse(other);
          } catch {
            throw Error('"content" is not a CoreCAD project: it is not JSON.');
          }
        }
        const errors = validateDocument(other);
        if (errors.length) throw Error('Not a valid CoreCAD project: ' + errors.join(' '));
        other = upgrade(structuredClone(other));
        if (!other.parts.length) throw Error('That project has no parts: there is nothing to bring in.');
        const merged = importParts(doc(), other, other.meta?.name || 'Imported'),
          at = merged.group ?? merged.parts[0];
        await commit(merged.doc, 'Import ' + (other.meta?.name || 'a project'), null, at);
        return partOutcome(at, { parts: merged.parts, group: merged.group });
      }
      throw Error('"format" is "step" or "corecad".');
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
          extrude: ['distance', 'through_all', 'distance2', 'operation', 'flip'],
          revolve: ['angle', 'rise', 'left_handed', 'axis', 'operation', 'flip'],
          hole: ['diameter', 'depth', 'through_all', 'at'],
          fillet: ['radius'],
          chamfer: ['distance'],
          box: ['size', 'origin'],
          cylinder: ['diameter', 'height', 'origin'],
          sphere: ['diameter', 'origin'],
          combine: ['operation', 'with', 'keep'],
          import: [],
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
        if (given.some((k) => ['distance', 'through_all', 'distance2'].includes(k))) next.extent = extentFrom(a, next.operation, f.extent);
      }
      if (f.type === 'revolve') {
        if (a.angle !== undefined) next.angle = a.angle;
        if (a.rise !== undefined) next.rise = a.rise;
        if (a.left_handed !== undefined) next.left_handed = !!a.left_handed;
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
    async add_part() {
      free();
      await settled();
      const made = makePart(doc());
      await commit(addPart(made.doc, made.part), 'New part', null, made.part.id);
      return partOutcome(made.part.id);
    },
    async add_group() {
      free();
      await settled();
      const made = makePart(doc(), { base: 'Group', group: true });
      await commit(addPart(made.doc, made.part), 'New group', null, made.part.id);
      return partOutcome(made.part.id);
    },
    async combine(a) {
      free();
      await settled();
      const target = partOf(a.part);
      if (target.group) throw Error(`${target.name} is a group and has no shape of its own: name the part that is to be changed. (A group can be given in "with": everything in it is then joined or cut.)`);
      if (target.link) throw Error(`${target.name} is a linked copy: combine changes a part with a history. Use the original (${target.link}), or unlink_part first.`);
      if (!['join', 'cut', 'intersect'].includes(a.operation)) throw Error('"operation" is "join", "cut" or "intersect".');
      const made = makeFeature(doc(), 'combine', { part: target.id, operation: a.operation, tools: toolsFrom(a.with, target), keep: !!a.keep });
      const out = await apply(adopt(addFeature(made.doc, made.feature), made.feature), made.feature, 'Apply ' + made.feature.name);
      return { ...out, parts: partRows() };
    },
    async move_part(a) {
      free();
      await settled();
      const p = partOf(a.part);
      if (a.parent === undefined && a.position === undefined && a.rotation === undefined) throw Error('Say where: give position, rotation or parent.');
      let next = doc();
      if (a.parent !== undefined) next = setParent(next, p.id, parentFrom(a.parent)); // it stays where it is in space
      const cur = partById(next, p.id);
      next = updatePart(next, p.id, { pos: vec3(a.position, 'position', cur.pos), rot: vec3(a.rotation, 'rotation', cur.rot) });
      return partChange(next, 'Move ' + p.name, p.id);
    },
    async copy_part(a) {
      free();
      await settled();
      const p = partOf(a.part),
        c = copyPart(doc(), p.id, { linked: !!a.linked });
      return partChange(c.doc, (a.linked ? 'Linked copy of ' : 'Copy of ') + p.name, c.id, { copy_of: p.id });
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
      if (!['3mf', 'step', 'stl', 'pdf'].includes(format)) throw Error('"format" is "3mf", "step", "stl" or "pdf". (The project itself is get_document.)');
      if (a.drawing !== undefined && format !== 'pdf') throw Error('"drawing" is for format "pdf".');
      if (format === 'pdf') {
        if (a.part !== undefined || a.per_part !== undefined) throw Error('A PDF is of a drawing: give "drawing", not "part" or "per_part".');
        const d = drawingOf(a.drawing),
          sheet = await sheetOf(d),
          bytes = sheetToPDF(sheet, { title: `${partById(doc(), d.part)?.name ?? ''} - ${d.name}` }),
          name = app.filename({ meta: { name: `${doc().meta.name} - ${d.name}` } }) + '.pdf',
          missing = sheet.dims.filter((x) => x.problem).map((x) => ({ id: x.id, problem: x.problem }));
        if (a.download) {
          app.download(new Blob([bytes], { type: 'application/pdf' }), name);
          return { format, filename: name, bytes: bytes.length, downloaded: true, ...(missing.length ? { not_drawn: missing } : {}) };
        }
        return { format, filename: name, bytes: bytes.length, base64: toBase64(bytes), ...(missing.length ? { not_drawn: missing } : {}) };
      }
      if (!bodies().length) throw Error('There is no body to export yet.');
      const only = a.part !== undefined ? partOf(a.part) : null,
        blob = await store.kernel.export(doc(), { format, split: !!a.per_part, ...(only ? { parts: [only.id] } : {}) }),
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
      if (a.drawing !== undefined) {
        if (a.dimensions !== undefined) throw Error('"dimensions" is for the 3D view; a drawing shows its own.');
        const d = drawingOf(a.drawing),
          sheet = await sheetOf(d),
          img = new Image();
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sheetToSVG(sheet));
        await img.decode();
        const k = Math.min(a.max ?? 1600, 4000) / Math.max(...sheet.size),
          out = document.createElement('canvas');
        out.width = Math.round(sheet.size[0] * k);
        out.height = Math.round(sheet.size[1] * k);
        out.getContext('2d').drawImage(img, 0, 0, out.width, out.height);
        return { png: out.toDataURL('image/png'), width: out.width, height: out.height, drawing: d.id };
      }
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
      if (a.view !== undefined && !STANDARD[a.view]) throw Error(`Unknown view "${a.view}". Views: ${VIEWS.join(', ')}.`);
      if (a.view === undefined && a.fit === false) throw Error('Give a view, or leave "fit" on: otherwise there is nothing to do.');
      if (a.view !== undefined) view.standard(a.view);
      if (a.fit !== false) view.fit();
      return { ...(a.view !== undefined ? { view: a.view } : {}), fitted: a.fit !== false };
    },
    async set_section(a) {
      if (a.plane === null) {
        app.setSection(null);
        return { section: null };
      }
      await settled(); // "through the middle" is the middle of the model as it is now
      const s = app.setSection({ plane: a.plane, ...(a.at !== undefined ? { at: a.at } : {}), flip: a.flip === true });
      return { section: { ...s, text: sectionText(s) } };
    },
    async set_xray(a) {
      if (typeof a.on !== 'boolean') throw Error('"on" is true or false.');
      return { xray: app.setXray(a.on) };
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

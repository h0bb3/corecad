// Every named tolerance and tunable of the program, in one place.
// Lengths are millimetres, angles radians, screen distances CSS pixels.
// "x scale" means: multiply by the sketch's scale = max(1, largest |x|, |y| or r in it).

// ---- geometry and the kernel
export const WELD = 1e-6; // two sketch points are one point (profile finder)
export const weldFor = (scale) => Math.max(WELD, 1e-9 * scale); // the weld distance of a sketch of this scale
export const LIN = 1e-6; // same point, same plane offset, in 3D
export const PARALLEL = 1 - 1e-9; // the dot product of two unit normals that count as one direction
export const MIN_FEATURE_SIZE = 1e-4; // least distance, radius or diameter a feature accepts
export const MIN_PIECE = 1e-7; // shortest profile piece the kernel layer accepts
export const AREA_REL = 1e-6; // profile face area against the 2D area, relative to max(1, area)
export const MIN_REGION_AREA = 1e-9; // mm2: smaller regions are slivers and are dropped
export const ANGLE_TIE = 1e-7; // two half-edges leave a vertex in the same direction
export const SIMPLIFY_ANG = 1e-3; // BRepAlgoAPI SimplifyResult angular tolerance (replicad's value)
export const BBOX_GROW = 1e-6; // "the tool reaches the body": boxes grown by this much intersect
export const ALL_MARGIN_MIN = 1; // "through all" overshoots by max(ALL_MARGIN_MIN, ALL_MARGIN_REL * span)
export const ALL_MARGIN_REL = 0.01;
export const MESH_REL = 5e-4; // display mesh: linear deflection = clamp(MESH_REL * diagonal, MESH_MIN, MESH_MAX)
export const MESH_MIN = 0.01;
export const MESH_MAX = 0.1;
export const MESH_ANG = 0.3; // display mesh: angular deflection
export const STL_QUALITY = { draft: [0.1, 0.5], normal: [0.02, 0.2], fine: [0.005, 0.1] }; // [linear mm, angular rad]
export const HEAP_LIMIT = 1.5e9; // bytes of kernel heap above which the worker is restarted after the next commit
export const SLOW_MS = 10000; // silence of the worker after which the page offers Stop
export const BUSY_MS = 150; // a request out this long shows "busy"

// ---- solver
export const SOLVE_TOL = 1e-10; // x scale: largest scaled residual of a solved sketch
export const REDUCE_TOL = 1e-9; // x scale: a relation of the reduction already holds
export const CONST_EQ_TOL = 1e-7; // x scale: an equation without unknowns holds
export const LM_MU0 = 1e-6; // damping: start
export const LM_MU_MIN = 1e-10; // damping: floor
export const LM_MU_MAX = 1e12; // damping: give up
export const LM_ACCEPT = 1e-3; // smallest gain ratio of an accepted step
export const LM_ITER = 50;
export const LM_ITER_DRAG = 12;
export const LM_ITER_RESTORE = 20;
export const ANG_STEP = 0.1; // most an angular residual closes in one continuation step
export const H_MIN = 1 / 1024; // smallest continuation step
export const WITNESS_MIN = 0.05; // a corner's sine below this may change sign
export const RANK_TOL = 1e-8; // a unit gradient is dependent on those before it
export const FREE_TOL = 1e-6; // a variable takes part in a free motion
export const BLAME_RANK = 1e-6; // relative size of a coefficient that makes a constraint part of the blame
export const BLAME_CONFLICT = 1e-3; // relative size of a residual that makes a constraint part of a conflict
export const SK_MIN_SIZE = 1e-7; // x scale: shortest line, smallest radius, smallest arc chord
export const STIFF = 0.01; // mobility of the drag handle
export const DRAG_STEP_REL = 0.25; // longest drag step, as a part of the nearest feature
export const DRAG_STEP_MIN_PX = 4; // ... but at least this many pixels
export const DRAG_STEPS_PER_FRAME = 8;
export const DRAG_POLISH = 2;

// ---- snapping, picking, gestures (pixels and milliseconds)
export const SNAP_POINT = 10; // to a point, a midpoint, a meeting of guide and curve
export const SNAP_CURVE = 7; // onto a line, circle or arc
export const SNAP_DIR = 6; // distance of the cursor from a guide through the anchor
export const SNAP_MIN_LEN = 20; // a rubber band shorter than this infers no direction
export const PICK_POINT = 10; // sketch picking: a point
export const PICK_CURVE = 6; // sketch picking: a curve
export const PICK_BOX_GROW = 2; // sketch picking: a dimension's number or a glyph, box grown by this
export const PICK_EDGE_3D = 6; // model picking: an edge
export const PICK_SKETCH_3D = 5; // model picking: a line of a finished sketch
export const CLICK_MOVE = 4; // a press that moves further is a drag
export const DBLCLICK_MS = 350;
export const DBLCLICK_MOVE = 5;
export const MIN_DRAW_PX = 2; // a drawn thing smaller than this is ignored
export const EDGE_ON_TILT = 0.26; // |n . back| below which a sketch is "seen edge-on" and takes no clicks

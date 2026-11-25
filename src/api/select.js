// Choosing bodies, faces and edges by description instead of by a click: "the top
// face", "the edges parallel to z". Pure: works on what the kernel reports for each
// body (its faces and edges with their geometry), nothing else.
import { topoOfBody } from '../doc/refs.js';

const SIDES = {
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  back: [0, 1, 0],
  front: [0, -1, 0],
};
const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const SIDE_NAMES = Object.keys(SIDES);

/** The body meant: by id, or the only one there is. */
export function findBody(bodies, id) {
  if (!bodies.length) throw Error('There is no body yet: extrude a sketch first.');
  if (id !== undefined) {
    const b = bodies.find((b) => b.id === id);
    if (!b) throw Error(`There is no body "${id}". Bodies: ${bodies.map((b) => b.id).join(', ')}.`);
    return b;
  }
  if (bodies.length > 1)
    throw Error(`There are ${bodies.length} bodies (${bodies.map((b) => b.id).join(', ')}): say which with "body".`);
  return bodies[0];
}

/** For each side name, the index of the flat face that is furthest out that way (or absent). */
export function sidesOf(body) {
  const faces = topoOfBody(body).faces,
    out = {};
  for (const [name, n] of Object.entries(SIDES)) {
    let best = -1;
    faces.forEach((f, i) => {
      if (!f.plane || dot(f.plane.n, n) < 0.9999) return;
      if (best < 0 || f.plane.d > faces[best].plane.d + 1e-9 || (Math.abs(f.plane.d - faces[best].plane.d) <= 1e-9 && f.area > faces[best].area))
        best = i;
    });
    if (best >= 0) out[name] = best;
  }
  return out;
}

/**
 * One face. `sel`: a side name ('top', 'bottom', 'front', 'back', 'left', 'right'), or
 * { body?, face: index } or { body?, side: name }. Indices are those of list_faces.
 * @returns {{ body: object, face: number }}
 */
export function findFace(bodies, sel) {
  if (typeof sel === 'string') sel = { side: sel };
  if (!sel || typeof sel !== 'object') throw Error('Say which face: a side such as "top", or { body, face: index }.');
  const body = findBody(bodies, sel.body),
    faces = topoOfBody(body).faces;
  if (sel.face !== undefined) {
    if (!Number.isInteger(sel.face) || !faces[sel.face])
      throw Error(`Body ${body.id} has no face ${sel.face} (it has ${faces.length}; see list_faces).`);
    return { body, face: sel.face };
  }
  if (!SIDES[sel.side]) throw Error(`Unknown side "${sel.side}". Sides: ${SIDE_NAMES.join(', ')}; or give { face: index }.`);
  const face = sidesOf(body)[sel.side];
  if (face === undefined) throw Error(`Body ${body.id} has no flat face on its ${sel.side} side.`);
  return { body, face };
}

/**
 * Edges. `sel`: 'all', an array of indices, or { body?, indices?, kind?, parallel?, on?, length? }
 * where every condition given must hold: kind 'line' | 'circle'; parallel 'x' | 'y' | 'z' (straight
 * edges along that axis); on: a face (as for findFace) whose border the edge is part of; length in mm.
 * Seams of round faces are never chosen. Indices are those of list_edges.
 * @returns {{ body: object, edge: number }[]} at least one, or it throws.
 */
export function findEdges(bodies, sel) {
  if (sel === 'all') sel = {};
  if (Array.isArray(sel)) sel = { indices: sel };
  if (!sel || typeof sel !== 'object') throw Error('Say which edges: "all", [indices], or { parallel: "z" } and the like.');
  const body = findBody(bodies, sel.body),
    topo = topoOfBody(body);
  const usable = (e) => !e.seam && e.faces.length === 2;
  if (sel.indices !== undefined) {
    if (!Array.isArray(sel.indices) || !sel.indices.length) throw Error('"indices" must list at least one edge.');
    for (const i of sel.indices) {
      if (!Number.isInteger(i) || !topo.edges[i]) throw Error(`Body ${body.id} has no edge ${i} (it has ${topo.edges.length}; see list_edges).`);
      if (!usable(topo.edges[i])) throw Error(`Edge ${i} is the seam of a round face and cannot be chosen.`);
    }
  }
  if (sel.kind !== undefined && !['line', 'circle', 'other'].includes(sel.kind)) throw Error('"kind" is "line" or "circle".');
  if (sel.parallel !== undefined && !AXES[sel.parallel]) throw Error('"parallel" is "x", "y" or "z".');
  const onFace = sel.on !== undefined ? findFace([body], sel.on).face : null;
  const hits = [];
  topo.edges.forEach((e, i) => {
    if (!usable(e)) return;
    if (sel.indices && !sel.indices.includes(i)) return;
    if (sel.kind && e.kind !== sel.kind) return;
    if (sel.parallel) {
      if (e.kind !== 'line') return;
      const d = [e.b[0] - e.a[0], e.b[1] - e.a[1], e.b[2] - e.a[2]],
        l = Math.hypot(...d);
      if (l < 1e-9 || Math.abs(dot(d, AXES[sel.parallel])) / l < 0.9999) return;
    }
    if (onFace !== null && !e.faces.includes(onFace)) return;
    if (sel.length !== undefined && Math.abs(e.length - sel.length) > 1e-6 * Math.max(1, sel.length)) return;
    hits.push({ body, edge: i });
  });
  if (!hits.length) throw Error(`No edge of body ${body.id} matches ${JSON.stringify(sel)} (see list_edges).`);
  return hits;
}

const round = (v, digits = 4) => (Array.isArray(v) ? v.map((x) => round(x, digits)) : +Number(v).toFixed(digits));

/** The faces of a body as plain rows for a script to read. */
export function describeFaces(body) {
  const sides = Object.entries(sidesOf(body));
  return topoOfBody(body).faces.map((f, i) => ({
    face: i,
    kind: f.kind,
    center: round(f.center),
    area: round(f.area),
    ...(f.plane ? { normal: round(f.plane.n, 6) } : {}),
    ...(f.cyl ? { radius: round(f.cyl.r), axis: round(f.cyl.dir, 6), hole: !f.cyl.convex } : {}),
    ...(sides.some(([, j]) => j === i) ? { side: sides.filter(([, j]) => j === i).map(([name]) => name).join(',') } : {}),
  }));
}

/** The edges of a body as plain rows (seams left out: they cannot be chosen). */
export function describeEdges(body) {
  return topoOfBody(body).edges.flatMap((e, i) =>
    e.seam || e.faces.length !== 2
      ? []
      : [
          {
            edge: i,
            kind: e.kind,
            from: round(e.a),
            to: round(e.b),
            middle: round(e.mid),
            length: round(e.length),
            faces: e.faces,
            ...(e.circle ? { radius: round(e.circle.r), center: round(e.circle.c) } : {}),
          },
        ]
  );
}

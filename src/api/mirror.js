// A second seat at a tab: another page (a headset, a phone) that shows what the tab shows and
// points at it. This is what goes between the two, through the relay (bridge/relay.js, `show`
// and `input`), and how the tab keeps a viewer up to date. Pure: no page, no socket.
//
// The tab shows:   { kind: 'mesh', key, mesh }          the triangles and edges of a body, once for each key
//                  { kind: 'bodies', list }             what stands where, in which colours
//                  { kind: 'select', hits }  { kind: 'section', half }  { kind: 'xray', on }
//                  { kind: 'labels', list }             numbers and lines in space (view/viewport.js, labels())
//                  { kind: 'name', name }               the project's name
// A viewer sends:  { kind: 'point', cam }               the camera it looks with and the pixel pointed at
//                  { kind: 'click', cam, shift }
//                  { kind: 'section', section }         { plane, at, flip } or null
//                  { kind: 'xray', on }
// The tab does the picking, with the viewer's camera: a viewer cannot name a face by itself.

const TYPES = { Float32Array, Float64Array, Uint32Array, Uint16Array, Int32Array, Uint8Array };
const MESH = ['positions', 'normals', 'indices', 'faceTris', 'edgeSegs', 'edgeLines'];
/** The largest message the tab sends a viewer: the relay takes 8 MB. */
export const MAX_SHOW = 6e6;

/** Numbers as text that JSON can carry: a typed array's bytes in base64; a plain array as it is. */
export function pack(a) {
  if (!ArrayBuffer.isView(a)) return a;
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { t: a.constructor.name, b: btoa(s) };
}
export function unpack(p) {
  if (Array.isArray(p) || !p) return p;
  const Type = TYPES[p.t];
  if (!Type || typeof p.b !== 'string') throw new Error('not numbers');
  const s = atob(p.b),
    bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Type(bytes.buffer, 0, bytes.length / Type.BYTES_PER_ELEMENT);
}
export const packMesh = (m) => Object.fromEntries(MESH.map((k) => [k, pack(m[k])]));
export const unpackMesh = (m) => Object.fromEntries(MESH.map((k) => [k, unpack(m[k])]));
/** A body as the view draws it, without its mesh (that goes by its key). */
export const packBody = (b) => ({
  id: b.id,
  key: b.key,
  part: b.part ?? null,
  bbox: b.bbox,
  matrix: b.matrix ?? null,
  color: b.color ?? null,
  faceColors: b.faceColors ? [...b.faceColors] : [],
  chosen: !!b.chosen,
  instance: !!b.instance,
});
/** The bodies a viewer draws: those whose mesh it has. meshes: key -> mesh. */
export const unpackBodies = (list, meshes) =>
  list.filter((b) => meshes.has(b.key)).map((b) => ({ ...b, matrix: b.matrix ?? undefined, color: b.color ?? undefined, faceColors: new Map(b.faceColors), mesh: meshes.get(b.key) }));

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const vec = (v, n) => Array.isArray(v) && v.length === n && v.every(num);
/** A camera as a viewer sends it, checked: { view, vp, p } or null. */
export function checkCam(c) {
  const v = c?.view,
    ok = v && vec(v.target, 3) && vec(v.quat, 4) && num(v.dist) && v.dist > 0 && num(v.fov) && v.fov > 0 && v.fov < 180 && c.vp && num(c.vp.w) && num(c.vp.h) && c.vp.w > 0 && c.vp.h > 0 && vec(c.p, 2);
  return ok ? { view: { target: v.target, quat: v.quat, dist: v.dist, fov: v.fov, ortho: !!v.ortho }, vp: { w: c.vp.w, h: c.vp.h }, p: c.p } : null;
}
/** What a viewer sent, checked: the same with only what is understood in it, or null. */
export function checkInput(d) {
  if (d?.kind === 'point') return { kind: 'point', cam: checkCam(d.cam) };
  if (d?.kind === 'click') {
    const cam = checkCam(d.cam);
    return cam ? { kind: 'click', cam, shift: !!d.shift } : null;
  }
  if (d?.kind === 'xray') return { kind: 'xray', on: d.on === undefined ? undefined : !!d.on };
  if (d?.kind === 'section') {
    const s = d.section;
    if (s === null) return { kind: 'section', section: null };
    return s && ['XY', 'XZ', 'YZ'].includes(s.plane) && num(s.at) ? { kind: 'section', section: { plane: s.plane, at: s.at, flip: !!s.flip } } : null;
  }
  return null;
}

/**
 * The tab's side: remembers what is shown, and sends a viewer what it has not got.
 * @param {(data: object, to?: number) => boolean} send  to every viewer, or to one
 */
export function createMirror(send) {
  const now = { bodies: [], select: [], section: null, xray: false, labels: [], name: '' },
    said = {}, // kind -> what was last sent, as text: nothing is sent twice
    viewers = new Set();
  let has = new Set(), // the keys of the meshes every viewer has
    waiting = null;
  const one = (kind) =>
    kind === 'bodies'
      ? { kind, list: now.bodies.map(packBody) }
      : kind === 'select'
      ? { kind, hits: now.select }
      : kind === 'section'
      ? { kind, half: now.section }
      : kind === 'xray'
      ? { kind, on: now.xray }
      : kind === 'labels'
      ? { kind, list: now.labels }
      : { kind, name: now.name };
  /** The meshes of what is shown that `known` does not have, each in a message of its own, then the kind itself. */
  function tell(kind, to, known) {
    if (kind === 'bodies')
      for (const b of now.bodies) {
        if (known.has(b.key)) continue;
        const mesh = packMesh(b.mesh),
          size = Object.values(mesh).reduce((n, v) => n + (v?.b?.length ?? (v?.length ?? 0) * 8), 0);
        if (size <= MAX_SHOW) send({ kind: 'mesh', key: b.key, mesh }, to); // a body too big to send is not seen there
        known.add(b.key);
      }
    const data = one(kind);
    if (to === undefined) {
      const text = JSON.stringify(data);
      if (said[kind] === text) return;
      said[kind] = text;
    }
    send(data, to);
  }
  const flush = () => {
    const kinds = waiting;
    waiting = null;
    if (!viewers.size) return;
    for (const kind of kinds) tell(kind, undefined, has);
    // what nobody shows any more is forgotten, so that it is sent again if it comes back
    const shown = new Set(now.bodies.map((b) => b.key));
    has = new Set([...has].filter((k) => shown.has(k)));
  };
  return {
    viewers,
    /** Something that is shown has changed. */
    set(kind, value) {
      now[kind] = value;
      if (!viewers.size) return;
      if (!waiting) {
        waiting = new Set();
        setTimeout(flush, 40);
      }
      waiting.add(kind);
    },
    /** A viewer has come: it is shown everything. */
    join(id) {
      viewers.add(id);
      const known = new Set();
      for (const kind of ['name', 'bodies', 'section', 'xray', 'select', 'labels']) tell(kind, id, known);
      for (const k of known) has.add(k); // the others have had these already, or get them with the next change
      if (viewers.size > 1) has = new Set(); // simplest and right: after a newcomer, a changed body goes to all again
    },
    leave(id) {
      viewers.delete(id);
      if (!viewers.size) {
        has = new Set();
        for (const k of Object.keys(said)) delete said[k];
      }
    },
    /** The relay is gone: nobody watches. */
    reset() {
      for (const id of [...viewers]) this.leave(id);
    },
  };
}

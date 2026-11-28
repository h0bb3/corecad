import { hash64, geometryKey } from '../core/hash.js';
import * as Mat from '../core/mat.js';
import { upgrade } from '../doc/schema.js';
import { partById, worldOf, contentOf, consumedIn, buildOrder, sceneOf, appearanceOf, descendantsOf } from '../doc/parts.js';
import { evaluate, emptyState } from './features.js';
import { packBody, topoOf } from './topo.js';
import { weld, package3mf } from './threemf.js';
import { zip } from '../core/zip.js';
import { dispose, movedShape } from './shapes.js';
import { kernel, heapBytes, errorText, isFatal, scope } from './occ.js';
import { gunzipText } from '../core/pack.js';

/** A colour as the kernel must be given it for a STEP file to hold the colour that was meant: the kernel
 *  takes the numbers as linear light and writes them out encoded, so they are decoded first. */
function forStep(hex) {
  const linear = (i) => {
    const c = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255,
      l = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    return Math.round(l * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return '#' + linear(0) + linear(1) + linear(2);
}

/**
 * Builds the model. Every part has its own history: its features, in document order, starting
 * from nothing. Parts are built in an order that puts a part after the parts its combine
 * features take as tools. A prefix cache with explicit ownership keeps what did not change;
 * cache entries share immutable body states.
 *
 * A job may look back in one history: `roll: { part, count }` builds only the first `count`
 * features of that part (the others are 'rolled'), every other part in full. `count` alone is
 * the same over the whole feature list, for a project of one part.
 */
export function createEngine(post) {
  const cache = new Map(),
    owned = new Set();
  let pinned = new Set(),
    latest = 0,
    delay = 0,
    lastBodies = [];
  const channel = new MessageChannel(),
    yields = [];
  channel.port1.onmessage = () => yields.shift()?.();
  const yieldNow = () =>
    new Promise((resolve) => {
      yields.push(resolve);
      channel.port2.postMessage(0);
    });
  const own = (x) => {
    owned.add(x);
    return x;
  };
  function collect(capacity = 96) {
    for (const key of cache.keys()) {
      if (cache.size <= capacity) break;
      if (!pinned.has(key)) cache.delete(key);
    }
    const live = new Set([
      ...lastBodies,
      ...[...cache.values()].flatMap((e) => [...e.state.bodies, ...(e.tool ? [e.tool] : [])]),
    ]);
    for (const b of owned)
      if (!live.has(b)) {
        dispose(b);
        owned.delete(b);
      }
  }
  /** The texts of what was imported, by how they are kept in the project. */
  const unpacked = new Map();
  async function rebuild(job, exporting = false) {
    const doc = upgrade(job.doc),
      features = doc.features,
      limit = Math.min(job.count ?? features.length, features.length),
      roll = job.roll ?? null,
      start = performance.now();
    const superseded = () => {
      collect();
      return { status: 'superseded', seq: job.seq };
    };
    const world = worldOf(doc),
      consumed = consumedIn(doc),
      { order, cyclic } = buildOrder(doc);
    // What was imported is kept small in the project: it is unpacked here, once for each text, before the
    // features are built (they are built without waiting for anything).
    const imported = new Map();
    for (const f of features) {
      const packed = f.type === 'import' ? f.data?.gzip : null;
      if (typeof packed !== 'string') continue;
      if (!unpacked.has(packed)) unpacked.set(packed, await gunzipText(packed).catch(() => null));
      imported.set(f.id, unpacked.get(packed));
    }
    for (const packed of [...unpacked.keys()]) if (!features.some((f) => f.data?.gzip === packed)) unpacked.delete(packed);
    const results = new Map(),
      keys = [],
      final = new Map(), // part id -> { state, key }
      used = new Map(); // tool part -> the part whose combine used it up
    let recomputed = 0,
      evaluated = 0,
      focus = null; // { part, before: ModelState, tool, feature }
    const total = features.filter((f, i) => i < limit).length;

    /** The bodies a combine feature of `part` works with, and text that changes when they do. */
    function toolsFor(f, part) {
      const tools = [];
      let text = '';
      const base = Mat.invert(world.get(part.id));
      for (const t of f.tools ?? []) {
        const toolPart = partById(doc, t);
        if (!toolPart) return { error: { code: 'tool-lost', message: 'A part this was combined with no longer exists. Edit the feature and choose the parts again.' } };
        for (const item of contentOf(doc, t, consumed)) {
          if (item.from === part.id || cyclic.has(part.id) && cyclic.has(item.from))
            return { error: { code: 'tool-cycle', message: 'A part cannot be combined with something that is built from it.' } };
          const built = final.get(item.from);
          if (!built) return { error: { code: 'tool-cycle', message: 'A part cannot be combined with something that is built from it.' } };
          const matrix = Mat.mul(base, Mat.mul(world.get(t), item.rel));
          for (const body of built.state.bodies) {
            tools.push({ body, matrix });
            text += `\n${body.key}@${Mat.key(matrix)}`;
          }
        }
      }
      if (!tools.length) return { error: { code: 'no-tool', message: 'The parts to combine with have no solid.' } };
      return { tools, text };
    }

    const globalIndex = new Map(features.map((f, i) => [f.id, i]));
    for (const partId of order) {
      const part = partById(doc, partId);
      let state = emptyState(),
        key = '0',
        index = 0;
      for (const f of features) {
        if (f.part !== partId) continue;
        const at = index++;
        if (globalIndex.get(f.id) >= limit || (roll && roll.part === partId && at >= roll.count)) continue;
        let tools = null,
          toolError = null,
          extra = '';
        if (f.type === 'combine' && !f.suppressed) {
          const t = toolsFor(f, part);
          if (t.error) {
            toolError = t.error;
            extra = '\n!' + t.error.code;
          } else {
            tools = t.tools;
            extra = t.text;
          }
        }
        const before = state;
        key = hash64(key + '\n' + geometryKey(f) + extra);
        keys.push(key);
        await yieldNow();
        if (!exporting && latest !== job.seq) return superseded();
        let entry = cache.get(key);
        const cached = !!entry;
        if (!entry) {
          post({ type: 'progress', seq: job.seq, featureId: f.id, index: evaluated, total, key });
          if (delay) await new Promise((r) => setTimeout(r, delay));
          if (!exporting && latest !== job.seq) return superseded();
          const t = performance.now();
          recomputed++;
          try {
            if (job.poison?.includes(key))
              throw Error(
                'This operation was stopped or crashed the kernel. Change its parameters to retry.'
              );
            if (f.suppressed) entry = { state, result: { id: f.id, status: 'suppressed' } };
            else {
              const out = evaluate(f, state, { key, own, tools, toolError, imported });
              entry = {
                ...out,
                result: { id: f.id, status: out.result.code ? 'warning' : 'ok', ...out.result },
              };
            }
          } catch (e) {
            if (isFatal(e)) {
              e.during = { featureId: f.id, key };
              throw e;
            }
            entry = {
              state,
              result: {
                id: f.id,
                status: 'error',
                code: e.code ?? 'kernel',
                message: errorText(e),
                ...e.data,
              },
            };
          }
          entry.result.ms = performance.now() - t;
          cache.set(key, entry);
        } else {
          cache.delete(key);
          cache.set(key, entry);
        }
        state = entry.state;
        evaluated++;
        results.set(f.id, { ...entry.result, cached });
        if (f.type === 'combine' && !f.keep && ['ok', 'warning'].includes(entry.result.status))
          for (const t of f.tools) if (!used.has(t)) used.set(t, partId);
        // The feature being looked at: the last one built of the part looked back in, or (with
        // `count` alone) the last one of the whole list.
        if (roll ? roll.part === partId : globalIndex.get(f.id) === limit - 1)
          focus = { part: partId, before, tool: entry.tool, feature: f };
      }
      final.set(partId, { state, key });
    }
    if (!exporting && latest !== job.seq) return superseded();
    const out = features.map((f) => {
      if (results.has(f.id)) return results.get(f.id);
      const part = partById(doc, f.part);
      if (!part || part.link)
        return { id: f.id, status: 'error', code: 'no-part', message: 'This feature belongs to no part.', cached: false, ms: 0 };
      return { id: f.id, status: 'rolled', cached: false, ms: 0 };
    });
    const bodiesOf = (swap = null) =>
      doc.parts.flatMap((p) =>
        p.link ? [] : (swap?.part === p.id ? swap.state : final.get(p.id)?.state ?? emptyState()).bodies.map((b) => ({ body: b, part: p.id }))
      );
    const all = bodiesOf();
    lastBodies = all.map((x) => x.body);
    if (job.purpose === 'commit') pinned = new Set(keys);
    const capacity = Math.max(96, features.length * 3);
    if (exporting) {
      collect(capacity);
      return { doc, features: out, bodies: all, used };
    }
    const pack = (list) => list.map(({ body, part }) => ({ ...packBody(body), part }));
    const result = {
      status: 'done',
      seq: job.seq,
      tag: job.tag,
      count: limit,
      features: out,
      bodies: pack(all),
      used: Object.fromEntries(used),
      ...(job.before ? { before: pack(focus ? bodiesOf({ part: focus.part, state: focus.before }) : all) } : {}),
      stats: {
        recomputed,
        cached: evaluated - recomputed,
        ms: performance.now() - start,
        heap: heapBytes(),
      },
    };
    if (job.tool && focus?.tool) {
      const mesh = packBody(focus.tool).mesh;
      result.tool = {
        positions: mesh.positions,
        normals: mesh.normals,
        indices: mesh.indices,
        op: focus.feature.operation ?? 'cut',
        part: focus.part,
      };
    }
    collect(capacity);
    result.stats.prefixes = cache.size;
    result.stats.ownedShapes = owned.size;
    return result;
  }
  return {
    setLatest: (seq) => {
      latest = seq;
    },
    debug: (ms) => {
      delay = Math.max(0, Math.min(ms, 2000));
    },
    rebuild,
    /**
     * The visible solids, each where it stands in the world, as a file. One object for every part that
     * shows something, with the part's name and colour:
     *   '3mf'  a package for slicers: named objects, their colours and the colours of painted faces
     *   'step' exact solids, named and coloured
     *   'stl'  a mesh; with job.split and more than one part, a zip of one STL for each part
     *          (an STL file cannot tell one object from another)
     * job.parts: only these parts and what stands under them, instead of everything.
     */
    async export(job) {
      const { doc, features, bodies, used } = await rebuild({ ...job, count: undefined, roll: null }, true),
        { r } = kernel();
      if (features.some((f) => f.status === 'error'))
        throw Error('Resolve failed features before exporting the part.');
      const only = job.parts ? new Set(job.parts.flatMap((id) => [id, ...descendantsOf(doc, id)])) : null,
        items = sceneOf(doc, bodies.map(({ body, part }) => ({ id: body.id, part, body })), used).filter(
          (it) => (!job.bodies || job.bodies.includes(it.id) || job.bodies.includes(it.source)) && (!only || only.has(it.part))
        );
      if (!items.length)
        throw Error(
          only
            ? `${job.parts.map((id) => partById(doc, id)?.name ?? id).join(', ')} shows no solid to export: it is empty, hidden, or was used up as a tool.`
            : 'There are no visible solids to export.'
        );
      if (!['3mf', 'step', 'stl'].includes(job.format)) throw Error('Choose 3MF, STL or STEP.');
      // The parts, in the order of the document, each with what it shows and a name of its own.
      const objects = [],
        byPart = new Map(),
        taken = new Set();
      for (const it of items) {
        if (!byPart.has(it.part)) {
          const base = partById(doc, it.part)?.name ?? 'Part';
          let name = base;
          for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
          taken.add(name);
          byPart.set(it.part, { name, items: [] });
          objects.push(byPart.get(it.part));
        }
        byPart.get(it.part).items.push(it);
      }
      const look = (it) => appearanceOf(doc, it, topoOf(it.body).faces),
        MESH = { tolerance: 0.02, angularTolerance: 0.2 };
      if (job.format === '3mf') {
        const colors = [],
          colorOf = (hex) => {
            const c = hex.toLowerCase();
            if (!colors.includes(c)) colors.push(c);
            return colors.indexOf(c);
          };
        const out = objects.map((o) => {
          const mesh = { vertices: [], triangles: [], colors: [] };
          let own = null;
          for (const it of o.items) {
            const m = it.body.shape.mesh(MESH),
              a = look(it),
              faceOf = new Map(it.body.faces.map((f, i) => [f.hashCode, i])),
              tri = new Int32Array(m.triangles.length / 3).fill(-1);
            own ??= a.color;
            for (const g of m.faceGroups) {
              const hex = a.faces.get(faceOf.get(g.faceId));
              if (hex) tri.fill(colorOf(hex), g.start / 3, (g.start + g.count) / 3);
            }
            let positions = m.vertices;
            if (!Mat.isIdentity(it.matrix)) {
              positions = new Float64Array(m.vertices.length);
              for (let i = 0; i < positions.length; i += 3) positions.set(Mat.point(it.matrix, [m.vertices[i], m.vertices[i + 1], m.vertices[i + 2]]), i);
            }
            const w = weld(positions, m.triangles, (t) => tri[t]),
              offset = mesh.vertices.length / 3;
            for (const v of w.vertices) mesh.vertices.push(v);
            for (const i of w.triangles) mesh.triangles.push(i + offset);
            for (const c of w.colors) mesh.colors.push(c);
          }
          // A part without a colour that has painted faces still needs one for the rest of it.
          const painted = mesh.colors.some((c) => c >= 0);
          return { name: o.name, color: own ? colorOf(own) : painted ? colorOf('#bac8ca') : -1, ...mesh };
        });
        return package3mf({ title: doc.meta?.name ?? 'CoreCAD', objects: out, colors }).buffer;
      }
      const placed = (it) => (Mat.isIdentity(it.matrix) ? it.body.shape.clone() : movedShape(it.body.shape, it.matrix)),
        made = [],
        keep = (shape) => (made.push(shape), shape);
      try {
        if (job.format === 'step')
          return await r
            .exportSTEP(
              objects.flatMap((o) =>
                o.items.map((it, i) => ({
                  shape: keep(placed(it)),
                  name: (!it.instance && doc.bodies[it.id]?.name) || (o.items.length > 1 ? `${o.name} ${i + 1}` : o.name),
                  ...(look(it).color ? { color: forStep(look(it).color) } : {}),
                }))
              )
            )
            .arrayBuffer();
        const stl = async (its) => {
          const compound = r.makeCompound(its.map((it) => keep(placed(it))));
          try {
            return await compound.blobSTL({ binary: true, ...MESH }).arrayBuffer();
          } finally {
            compound.delete();
          }
        };
        if (!job.split || objects.length < 2) return await stl(items);
        const files = [];
        for (const o of objects) files.push({ name: o.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') + '.stl', data: new Uint8Array(await stl(o.items)) });
        return zip(files).buffer;
      } finally {
        for (const shape of made) {
          try {
            shape.delete();
          } catch {
            /* already deleted */
          }
        }
      }
    },
    /**
     * The lines of views of parts, for a drawing: what OpenCascade's hidden-line removal (HLRBRep_Algo) sees
     * of the solids of job.parts (and what stands under them), where they stand, looking from each of
     * job.looks: { [name]: { dir, x } }, `dir` towards the eye and `x` across. Each view is
     * { visible, smooth, hidden }, lists of polylines [x0, y0, x1, y1, ...] in mm along x and up (dir × x),
     * from the origin of space: `visible` the sharp edges and outlines that are seen, `smooth` where faces
     * meet without a corner (the edge of a fillet), `hidden` the edges and outlines behind the solid.
     * job.hidden: the looks whose hidden lines are wanted.
     */
    async views(job) {
      const { doc, features, bodies, used } = await rebuild({ ...job, count: undefined, roll: null }, true),
        { OC, r } = kernel();
      if (features.some((f) => f.status === 'error')) throw Error('Resolve failed features before drawing the part.');
      const only = new Set(job.parts.flatMap((id) => [id, ...descendantsOf(doc, id)])),
        items = sceneOf(doc, bodies.map(({ body, part }) => ({ id: body.id, part, body })), used).filter((it) => only.has(it.part)),
        out = {},
        none = () => ({ visible: [], smooth: [], hidden: [] });
      if (!items.length) {
        for (const look of Object.keys(job.looks)) out[look] = none();
        return out;
      }
      const s = scope(),
        made = items.map((it) => s(Mat.isIdentity(it.matrix) ? it.body.shape.clone() : movedShape(it.body.shape, it.matrix))),
        compound = s(r.makeCompound(made));
      /** The edges of a result as polylines; a curve is cut into short straight pieces. */
      const lines = (shape) => {
        const list = [];
        if (!shape || shape.IsNull()) return list;
        const c = s(r.cast(shape));
        for (const e of c.edges) {
          s(e);
          OC.BRepLib.BuildCurves3d(e.wrapped);
          const m = e.meshEdges({ tolerance: 0.01, angularTolerance: 0.1 }),
            L = m.lines;
          // pieces end to end; a gap starts another polyline
          let cur = null;
          for (let i = 0; i + 5 < L.length; i += 6) {
            const x0 = L[i],
              y0 = L[i + 1],
              x1 = L[i + 3],
              y1 = L[i + 4];
            if (cur && Math.abs(cur.at(-2) - x0) < 1e-9 && Math.abs(cur.at(-1) - y0) < 1e-9) cur.push(x1, y1);
            else {
              if (cur) list.push(Float32Array.from(cur));
              cur = [x0, y0, x1, y1];
            }
          }
          if (cur) list.push(Float32Array.from(cur));
        }
        return list;
      };
      try {
        for (const [look, cam] of Object.entries(job.looks)) {
          // a section: what lies on the eye's side of its plane is taken away first, and the faces the
          // plane makes are given as outlines (for hatching), in the view's own mm
          let shape = compound,
            cut = [];
          if (cam.cut) {
            const B = 1e5,
              lo = [-B, -B, -B],
              hi = [B, B, B],
              i = cam.cut.n.findIndex((x) => Math.abs(x) > 0.5);
            if (cam.cut.n[i] > 0) lo[i] = cam.cut.c;
            else hi[i] = -cam.cut.c;
            shape = s(s(compound.clone()).cut(s(r.makeBox(lo, hi))));
            const X = cam.x,
              Y = [cam.dir[1] * X[2] - cam.dir[2] * X[1], cam.dir[2] * X[0] - cam.dir[0] * X[2], cam.dir[0] * X[1] - cam.dir[1] * X[0]],
              dot3 = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
            for (const f of shape.faces) {
              s(f);
              if (f.geomType !== 'PLANE') continue;
              const nv = s(f.normalAt()),
                n = [nv.x, nv.y, nv.z];
              if (Math.abs(dot3(n, cam.cut.n)) < 1 - 1e-6) continue;
              const m = f.meshEdges({ tolerance: 0.01, angularTolerance: 0.1 }).lines;
              if (!m.length || Math.abs(dot3([m[0], m[1], m[2]], cam.cut.n) - cam.cut.c) > 1e-4) continue;
              for (let k = 0; k + 5 < m.length; k += 6) {
                const a = [m[k], m[k + 1], m[k + 2]],
                  b = [m[k + 3], m[k + 4], m[k + 5]];
                cut.push(Float32Array.of(dot3(a, X), dot3(a, Y), dot3(b, X), dot3(b, Y)));
              }
            }
          }
          const v = s(new r.ProjectionCamera([0, 0, 0], cam.dir, cam.x)),
            algo = s(new OC.HLRBRep_Algo());
          algo.Add(shape.wrapped, 0);
          algo.Projector(s(new OC.HLRAlgo_Projector(v.wrapped)));
          algo.Update();
          algo.Hide();
          const hlr = s(new OC.HLRBRep_HLRToShape(algo)),
            want = job.hidden?.includes(look);
          out[look] = {
            visible: [...lines(hlr.VCompound()), ...lines(hlr.OutLineVCompound())],
            smooth: lines(hlr.Rg1LineVCompound()),
            hidden: want ? [...lines(hlr.HCompound()), ...lines(hlr.OutLineHCompound())] : [],
            ...(cam.cut ? { cut } : {}),
          };
        }
      } finally {
        s.end();
      }
      return out;
    },
    clear() {
      cache.clear();
      pinned.clear();
      lastBodies = [];
      collect();
    },
  };
}

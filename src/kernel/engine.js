import { hash64, geometryKey } from '../core/hash.js';
import * as Mat from '../core/mat.js';
import { upgrade } from '../doc/schema.js';
import { partById, worldOf, contentOf, consumedIn, buildOrder, sceneOf, appearanceOf, descendantsOf } from '../doc/parts.js';
import { evaluate, emptyState } from './features.js';
import { packBody, topoOf } from './topo.js';
import { weld, package3mf } from './threemf.js';
import { zip } from '../core/zip.js';
import { dispose, movedShape } from './shapes.js';
import { kernel, heapBytes, errorText, isFatal } from './occ.js';

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
              const out = evaluate(f, state, { key, own, tools, toolError });
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
    clear() {
      cache.clear();
      pinned.clear();
      lastBodies = [];
      collect();
    },
  };
}

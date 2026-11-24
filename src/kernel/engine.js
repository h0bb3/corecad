import { hash64, geometryKey } from '../core/hash.js';
import { evaluate, emptyState } from './features.js';
import { packBody } from './topo.js';
import { dispose } from './shapes.js';
import { kernel, heapBytes, errorText, isFatal } from './occ.js';

/** Prefix cache with explicit ownership. Cache entries share immutable body states. */
export function createEngine(post) {
  const cache = new Map(), owned = new Set(); let pinned = new Set(), latest = 0, delay = 0, lastState = emptyState();
  const channel = new MessageChannel(), yields = [];
  channel.port1.onmessage = () => yields.shift()?.();
  const yieldNow = () => new Promise(resolve => { yields.push(resolve); channel.port2.postMessage(0); });
  const own = x => { owned.add(x); return x; };
  function collect(capacity = 96) {
    for (const key of cache.keys()) { if (cache.size <= capacity) break; if (!pinned.has(key)) cache.delete(key); }
    const live = new Set([...lastState.bodies, ...[...cache.values()].flatMap(e => [...e.state.bodies, ...(e.tool ? [e.tool] : [])])]);
    for (const b of owned) if (!live.has(b)) { dispose(b); owned.delete(b); }
  }
  async function rebuild(job, exporting = false) {
    let state = emptyState(), before = state, key = '0'; const results = [], keys = [], start = performance.now(); let recomputed = 0, tool = null;
    const count = Math.min(job.count ?? job.doc.features.length, job.doc.features.length);
    for (let i = 0; i < count; i++) {
      const f = job.doc.features[i]; before = state; key = hash64(key + '\n' + geometryKey(f)); keys.push(key);
      await yieldNow();
      if (!exporting && latest !== job.seq) { collect(); return { status: 'superseded', seq: job.seq }; }
      let entry = cache.get(key), cached = !!entry;
      if (!entry) {
        post({ type: 'progress', seq: job.seq, featureId: f.id, index: i, total: count, key });
        if (delay) await new Promise(r => setTimeout(r, delay));
        if (!exporting && latest !== job.seq) { collect(); return { status: 'superseded', seq: job.seq }; }
        const t = performance.now(); recomputed++;
        try {
          if (job.poison?.includes(key)) throw Error('This operation was stopped or crashed the kernel. Change its parameters to retry.');
          if (f.suppressed) entry = { state, result: { id: f.id, status: 'suppressed' } };
          else {
            const out = evaluate(f, state, { key, own });
            entry = { ...out, result: { id: f.id, status: out.result.code ? 'warning' : 'ok', ...out.result } };
          }
        } catch (e) {
          if (isFatal(e)) { e.during = { featureId: f.id, key }; throw e; }
          entry = { state, result: { id: f.id, status: 'error', code: e.code ?? 'kernel', message: errorText(e), ...e.data } };
        }
        entry.result.ms = performance.now() - t;
        cache.set(key, entry);
      } else { cache.delete(key); cache.set(key, entry); }
      state = entry.state; tool = entry.tool; results.push({ ...entry.result, cached });
    }
    for (const f of job.doc.features.slice(count)) results.push({ id: f.id, status: 'rolled', cached: false, ms: 0 });
    if (!exporting && latest !== job.seq) { collect(); return { status: 'superseded', seq: job.seq }; }
    lastState = state;
    if (job.purpose === 'commit') pinned = new Set(keys);
    if (exporting) { collect(Math.max(96, job.doc.features.length * 3)); return { state, features: results }; }
    const out = { status: 'done', seq: job.seq, tag: job.tag, count, features: results, bodies: state.bodies.map(packBody),
      ...(job.before ? { before: before.bodies.map(packBody) } : {}),
      stats: { recomputed, cached: count - recomputed, ms: performance.now() - start, heap: heapBytes() } };
    if (job.tool && tool) { const mesh = packBody(tool).mesh; out.tool = { positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, op: job.doc.features[count - 1].operation ?? 'cut' }; }
    collect(Math.max(96, job.doc.features.length * 3)); return out;
  }
  return { setLatest: seq => { latest = seq; }, debug: ms => { delay = Math.max(0, Math.min(ms, 2000)); }, rebuild,
    async export(job) {
      const { state, features } = await rebuild({ ...job, count: job.doc.features.length }, true), { r } = kernel();
      if (features.some(f => f.status === 'error')) throw Error('Resolve failed features before exporting the part.');
      const bodies = state.bodies.filter(b => !job.doc.bodies[b.id]?.hidden && (!job.bodies || job.bodies.includes(b.id)));
      if (!bodies.length) throw Error('There are no visible solids to export.');
      if (job.format === 'step') return await r.exportSTEP(bodies.map((b, i) => ({ shape: b.shape, name: job.doc.bodies[b.id]?.name ?? `Body ${i + 1}` }))).arrayBuffer();
      if (job.format !== 'stl') throw Error('Choose STL or STEP.');
      const compound = r.makeCompound(bodies.map(b => b.shape.clone()));
      try { return await compound.blobSTL({ binary: true, tolerance: .02, angularTolerance: .2 }).arrayBuffer(); } finally { compound.delete(); }
    }, clear() { cache.clear(); pinned.clear(); lastState = emptyState(); collect(); },
  };
}

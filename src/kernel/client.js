export function createKernel() {
  let worker, seq = 0, readyResolve, readyReject, ready, lastProgress = null, latestJob = null, disposed = false;
  const pending = new Map(), listeners = new Map(), poison = new Set();
  const emit = (topic, data) => listeners.get(topic)?.forEach(fn => fn(data));
  function spawn() {
    ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    ready.catch(() => {});
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onerror = e => { e.preventDefault(); const error = new Error(e.message || 'The geometry kernel could not be loaded.'); readyReject(error); for (const p of pending.values()) p.reject(error); pending.clear(); emit('error', error.message); };
    worker.onmessage = ({ data: m }) => {
      if (m.type === 'ready') { readyResolve(true); emit('ready', true); return; }
      if (m.type === 'progress') { lastProgress = m; emit('progress', m); return; }
      if (m.type === 'fatal') {
        if (m.during?.key) { poison.add(m.during.key); restart(true); }
        else { const error = new Error(m.message); readyReject(error); for (const p of pending.values()) p.reject(error); pending.clear(); emit('error', m.message); }
        return;
      }
      const p = pending.get(m.seq); if (!p) return; pending.delete(m.seq);
      if (m.type === 'failure') p.reject(new Error(m.message));
      else if (m.type === 'exported') p.resolve(new Blob([m.buffer], { type: 'application/octet-stream' }));
      else p.resolve(m);
    };
  }
  async function request(type, args) {
    const id = ++seq;
    if (type === 'rebuild') latestJob = { seq: id, type, ...args };
    await ready;
    if (disposed) throw Error('The kernel client is closed.');
    if (type === 'rebuild' && latestJob.seq !== id) return { status: 'superseded', seq: id };
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, type }); worker.postMessage({ type, seq: id, ...args, poison: [...poison] }); });
  }
  function restart(skip = false) {
    worker.terminate(); if (skip && lastProgress?.key) poison.add(lastProgress.key);
    for (const p of pending.values()) p.type === 'rebuild' ? p.resolve({ status: 'superseded' }) : p.reject(new Error('The kernel was restarted. Please export again.'));
    pending.clear(); lastProgress = null; spawn(); emit('restart');
  }
  spawn();
  return { get ready() { return ready; },
    rebuild: (doc, opts = {}) => request('rebuild', { doc, ...opts }),
    export: (doc, opts) => request('export', { doc, ...opts }),
    on(topic, fn) { if (!listeners.has(topic)) listeners.set(topic, new Set()); listeners.get(topic).add(fn); return () => listeners.get(topic).delete(fn); },
    stop: () => restart(true), retry: () => { poison.clear(); restart(); },
    debugDelay: ms => worker.postMessage({ type: 'debug', ms }), clear: () => worker.postMessage({ type: 'clear' }),
    dispose() { disposed = true; worker.terminate(); for (const p of pending.values()) p.reject(new Error('Kernel closed.')); pending.clear(); },
  };
}

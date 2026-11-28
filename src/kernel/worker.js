import { loadKernel, errorText } from './occ.js';
import { createEngine } from './engine.js';
const engine = createEngine((m) => postMessage(m));
let running = false,
  queue = [],
  loaded = false;
function transfers(value, out = new Set()) {
  if (ArrayBuffer.isView(value)) out.add(value.buffer);
  else if (value && typeof value === 'object')
    Object.values(value).forEach((v) => transfers(v, out));
  return [...out];
}
async function drain() {
  if (running || !loaded) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try {
        if (job.type === 'rebuild') {
          const result = await engine.rebuild(job);
          postMessage({ type: 'result', ...result }, transfers(result));
        } else if (job.type === 'export') {
          const buffer = await engine.export(job);
          postMessage({ type: 'exported', seq: job.seq, buffer }, [buffer]);
        } else if (job.type === 'views') {
          const views = await engine.views(job);
          postMessage({ type: 'viewed', seq: job.seq, views }, transfers(views));
        }
      } catch (e) {
        if (e.during) {
          postMessage({ type: 'fatal', seq: job.seq, message: errorText(e), during: e.during });
          queue = [];
          break;
        }
        postMessage({ type: 'failure', seq: job.seq, message: errorText(e) });
      }
    }
  } finally {
    running = false;
  }
}
onmessage = ({ data: m }) => {
  if (m.type === 'debug') {
    engine.debug(m.ms);
    return;
  }
  if (m.type === 'clear') {
    if (!running) engine.clear();
    return;
  }
  if (m.type === 'rebuild') {
    engine.setLatest(m.seq);
    for (const old of queue.filter((j) => j.type === 'rebuild'))
      postMessage({ type: 'result', seq: old.seq, status: 'superseded' });
    queue = queue.filter((j) => j.type !== 'rebuild');
  }
  queue.push(m);
  drain();
};
loadKernel()
  .then(() => {
    loaded = true;
    postMessage({ type: 'ready' });
    drain();
  })
  .catch((e) => postMessage({ type: 'fatal', message: errorText(e) }));

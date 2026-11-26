// view.html#<code>: a page that watches a CoreCAD tab, for a headset or a phone. It shows what the
// tab shows, live, and points at it: what is pointed at and clicked here is what "this" means in the
// tab and to an agent that works there. It has no model of its own and no kernel: the tab sends the
// triangles (api/mirror.js) through the relay (bridge/relay.js), and does the picking with the
// camera this page looks with. In a headset the model stands in the room at its real size (view/xr.js).
import { createViewport } from './view/viewport.js';
import { relayUrl } from './api/bridge.js';
import { unpackMesh, unpackBodies } from './api/mirror.js';

const id = (x) => document.getElementById(x);
const code = decodeURIComponent(location.hash.slice(1));
const RETRY_S = [1, 2, 5, 10];
let ws = null,
  attempt = 0,
  timer = 0,
  hostOn = false,
  fitted = false,
  lastPoint = 0,
  list = [];
const meshes = new Map();

function say(text, kind = '') {
  id('status').textContent = text;
  id('status').className = 'status ' + kind;
}
const send = (data) => {
  if (ws?.readyState === WebSocket.OPEN && hostOn) ws.send(JSON.stringify({ type: 'input', data }));
};
const camAt = (p) => ({ view: view.view, vp: view.vp, p });

const view = createViewport(id('viewport'), {
  marks: true, // the numbers the tab sends are drawn here
  viewer: true, // dragging turns the model: there is nothing here to draw or to move
  move: (p) => {
    view.hover(view.pick(...p));
    const now = performance.now();
    if (now - lastPoint > 80) {
      lastPoint = now;
      send({ kind: 'point', cam: camAt(p) });
    }
  },
  up: (p, e) => send({ kind: 'click', cam: camAt(p), shift: e.shiftKey }),
  leave: () => {
    view.hover(null);
    send({ kind: 'point', cam: null });
  },
  error: (message) => say(message, 'bad'),
  ready: () =>
    view.xr.mode().then((mode) => {
      id('xr').hidden = !mode;
      id('hands').hidden = !mode;
      if (mode === 'immersive-ar') id('xr').textContent = 'Enter: the model in your room';
    }),
  xrPoint: (cam) => {
    view.hover(cam ? view.pick(...cam.p, 'all', false, cam) : null);
    send({ kind: 'point', cam });
  },
  xrClick: (cam, e) => send({ kind: 'click', cam, shift: !!e.shiftKey }),
  xrSection: (section) => send({ kind: 'section', section }),
  xrButton: (name) => name === 'xray' && send({ kind: 'xray' }),
  xrEnded: () => {
    id('xr').classList.remove('active');
    id('xr').textContent = 'Enter headset view';
    view.dirty();
  },
});
// for the tests: what this page has been shown
const seen = { select: [], labels: [], half: null, xray: false };
view.planes(false); // the origin planes are the tab's business
window.corecadView = {
  view,
  send,
  seen,
  get meshes() {
    return meshes.size;
  },
  get bodies() {
    return list.length;
  },
  get on() {
    return hostOn;
  },
};

/** What the tab shows (api/mirror.js). */
function show(d) {
  try {
    if (d.kind === 'mesh') meshes.set(d.key, unpackMesh(d.mesh));
    else if (d.kind === 'bodies') {
      list = Array.isArray(d.list) ? d.list : [];
      const keys = new Set(list.map((b) => b.key));
      for (const k of [...meshes.keys()]) if (!keys.has(k)) meshes.delete(k);
      view.setBodies(unpackBodies(list, meshes));
      if (!fitted && list.length) {
        view.fit();
        fitted = true;
      }
    } else if (d.kind === 'select') view.select((seen.select = Array.isArray(d.hits) ? d.hits : []));
    else if (d.kind === 'section') view.section((seen.half = d.half ?? null));
    else if (d.kind === 'xray') {
      view.xray((seen.xray = !!d.on));
      id('xray').classList.toggle('active', !!d.on);
    } else if (d.kind === 'labels') view.labels((seen.labels = Array.isArray(d.list) ? d.list : []));
    else if (d.kind === 'name') {
      id('name').textContent = String(d.name ?? 'CoreCAD');
      document.title = `${d.name} — CoreCAD view`;
    }
  } catch (e) {
    say('Something the tab sent could not be shown: ' + (e?.message ?? e), 'bad');
  }
}
function host(on) {
  hostOn = on;
  say(on ? 'Live from the CoreCAD tab' : 'Waiting for the CoreCAD tab: open it and choose Connect', on ? 'on' : '');
}
function open() {
  clearTimeout(timer);
  say(attempt ? 'Connecting again…' : 'Connecting…');
  const socket = new WebSocket(relayUrl());
  ws = socket;
  socket.onopen = () => socket.send(JSON.stringify({ type: 'watch', code }));
  socket.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.type === 'watching') {
      attempt = 0;
      host(!!m.host);
    } else if (m.type === 'host') host(!!m.on);
    else if (m.type === 'show') show(m.data ?? {});
  };
  socket.onerror = () => {};
  socket.onclose = (e) => {
    if (socket !== ws) return;
    ws = null;
    hostOn = false;
    // 44xx: refused, and trying again will not help
    if (e.code === 4401) return say(/hello/.test(e.reason) ? 'The relay cannot show a model to a second device yet: it is an older one.' : 'This address is not a whole one. Scan the code in the Connect dialog of CoreCAD again.', 'bad');
    if (e.code === 4403) return say('This page may not use the relay.', 'bad');
    if (e.code === 4429) return say('Too many devices are watching this tab already.', 'bad');
    const wait = RETRY_S[Math.min(attempt++, RETRY_S.length - 1)];
    say(`The relay is not answering. Trying again in ${wait} s.`);
    timer = setTimeout(open, wait * 1000);
  };
}

id('fit').onclick = () => view.fit();
id('xray').onclick = () => send({ kind: 'xray' });
id('whole').onclick = () => send({ kind: 'section', section: null });
id('xr').onclick = () => {
  if (view.xr.active) return view.xr.exit();
  view.xr.enter().then(
    () => {
      id('xr').classList.add('active');
      id('xr').textContent = 'Leave headset view';
    },
    (e) => say('The headset view could not be started: ' + e.message, 'bad')
  );
};

if (!/^[A-Za-z0-9_-]{20,64}$/.test(code)) say('This address has no code. Open the Connect dialog in CoreCAD and scan the code there.', 'bad');
else open();

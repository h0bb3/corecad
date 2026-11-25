// The tab's end of the CoreCAD bridge (bridge/relay.js): lets an MCP client such as
// Claude use the commands of THIS tab.
//
// A tab cannot be connected TO, so it connects out, to the relay, and names a code.
// The MCP client connects to the address that ends in the same code. The code is made
// here, from 144 random bits, and kept in this browser: it is the key to this tab's
// commands (and to nothing else), until "New address" replaces it.
//
// Nothing is sent anywhere until the person chooses Connect.

const DEFAULT_URL = 'wss://vibedit.app/CoreCAD/ws';

export const INSTRUCTIONS =
  'CoreCAD is a parametric CAD program open in the user\'s browser tab; these tools work in that tab, on the model the user sees. ' +
  'Units are millimetres, Z is up. Start with get_state. A project is made of parts; each part has its own history of features and its own place. ' +
  'Start a part with add_box, add_cylinder or add_sphere, or with add_sketch (shapes on a plane or on a face) and extrude; then hole, fillet, chamfer. ' +
  'move_part places a part, copy_part repeats it (linked: the copy follows the original), combine joins another part to it or cuts one out of it. ' +
  'add_group keeps parts together under a name (a container with a place and no shape: moving, turning, hiding, colouring or exporting it does that to what is in it). ' +
  'Everything stays editable: set_dimension changes a sketch, edit_feature a feature, and what is built on it follows. ' +
  'Every change answers with the bodies\' volumes and any problems: read them, and use screenshot to look at the result. ' +
  'A command that cannot be built changes nothing and says why. Changes are undo steps in the user\'s page (undo). ' +
  'When the user says "this", "here" or "that": they have clicked something in the page or hold their mouse on it. get_selection tells what; ' +
  'and the word "this" can be given wherever a command takes a face, edges, a part or a feature id (a hole on "this" face goes where they clicked). ' +
  'measure tells how big something is and how far apart two things are; list_dimensions lists the numbers that drive the model, each with the command that changes it. ' +
  'set_color colours a part or single faces. For printing, export as "3mf": every part is then an object of its own in the slicer, with its name and colours. ' +
  'CoreCAD is updated often: get_state says under "app" when a newer one is published, and reload_app loads it.';

/** Where the relay is. ?bridge=ws://localhost:… overrides it, for development only: never another host. */
export function relayUrl(search = location.search) {
  const given = new URLSearchParams(search).get('bridge');
  if (given) {
    try {
      const u = new URL(given);
      if ((u.protocol === 'ws:' || u.protocol === 'wss:') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return u.href;
    } catch {
      /* not an address: the default */
    }
  }
  return DEFAULT_URL;
}

/** The address an MCP client is given: the relay's /mcp/ with the code. */
export const addressFor = (wsUrl, code) => wsUrl.replace(/^ws/, 'http').replace(/\/ws\/?$/, '/mcp/') + code;

export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

/** What corecad.run answered, as the content of an MCP tool result. A screenshot goes as a picture. */
export function toContent(answer) {
  if (!answer?.ok) return { isError: true, content: [{ type: 'text', text: String(answer?.error ?? 'The command failed.') }] };
  const r = answer.result,
    prefix = 'data:image/png;base64,';
  if (r && typeof r.png === 'string' && r.png.startsWith(prefix)) {
    const { png, ...rest } = r;
    return { content: [{ type: 'image', data: png.slice(prefix.length), mimeType: 'image/png' }, { type: 'text', text: JSON.stringify(rest) }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(r ?? null) }] };
}

const RETRY_S = [1, 2, 5, 10, 30, 60];
const MAX_ANSWER = 6e6; // the relay takes 8 MB; leave room

/**
 * @param {object} o
 * @param {(name: string, args: object) => Promise<{ok: boolean}>} o.run   corecad.run
 * @param {{name: string, description: string, input: object}[]} o.tools  corecad.tools
 * @param {(state: object) => void} [o.onChange]
 * @param {string} [o.url]        the relay's WebSocket address
 * @param {string} [o.keySuffix]  keeps test runs out of the real settings
 */
export function createBridge({ run, tools, onChange = () => {}, url = relayUrl(), keySuffix = '' }) {
  const KEY_CODE = 'corecad.bridge.code' + keySuffix,
    KEY_ON = 'corecad.bridge.on' + keySuffix;
  const read = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const write = (k, v) => {
    try {
      v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    } catch {
      /* a browser without storage: the code lives as long as the tab */
    }
  };
  let code = read(KEY_CODE);
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(code ?? '')) {
    code = newCode();
    write(KEY_CODE, code);
  }
  let ws = null,
    wanted = false,
    attempt = 0,
    timer = null;
  const state = { status: 'off', note: '', calls: 0, last: null, seenAt: null };
  const changed = () => onChange(view());
  const view = () => ({ ...state, code, address: addressFor(url, code), wanted });

  function open() {
    clearTimeout(timer);
    state.status = attempt ? 'retrying' : 'connecting';
    changed();
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      return closed(socket, { code: 0, reason: String(e?.message ?? e) });
    }
    ws = socket;
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: 'hello',
          code,
          app: 'corecad',
          instructions: INSTRUCTIONS,
          tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input })),
        })
      );
    socket.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === 'ready') {
        attempt = 0;
        state.status = 'on';
        state.note = '';
        changed();
      } else if (m.type === 'seen') {
        state.seenAt = new Date();
        changed();
      } else if (m.type === 'replaced') {
        // The same address was connected from another tab: that one has it now. Do not fight over it.
        wanted = false;
        state.note = 'This address is now connected from another CoreCAD tab.';
      } else if (m.type === 'call') answer(socket, m);
    };
    socket.onclose = (e) => closed(socket, e);
    socket.onerror = () => {};
  }

  async function answer(socket, m) {
    let result;
    try {
      // Only the commands that were announced; run() refuses anything else by name anyway.
      result = toContent(tools.some((t) => t.name === m.name) ? await run(m.name, m.arguments ?? {}) : { ok: false, error: `CoreCAD has no tool "${m.name}".` });
    } catch (e) {
      result = toContent({ ok: false, error: String(e?.message ?? e) });
    }
    let payload = JSON.stringify({ type: 'result', id: m.id, ...result });
    if (payload.length > MAX_ANSWER)
      payload = JSON.stringify({
        type: 'result',
        id: m.id,
        ...toContent({ ok: false, error: `The answer is ${Math.round(payload.length / 1e6)} MB, too large to send. For an export, ask for download: true (it is saved in the user's browser).` }),
      });
    state.calls++;
    state.last = { name: m.name, ok: !result.isError, at: new Date() };
    state.seenAt = state.last.at;
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    changed();
  }

  function closed(socket, e) {
    if (socket !== ws && socket !== undefined) return; // an old socket: a newer one is in charge
    ws = null;
    // 44xx: the relay refused this tab (the page is not allowed, the bridge is full): trying again will not help now.
    const refused = e?.code >= 4400 && e.code < 4500 && e.code !== 4408;
    if (refused && e.code !== 4409) state.note = 'The bridge refused the connection: ' + (e.reason || 'no reason given') + '.';
    if (!wanted || refused) {
      wanted = wanted && !refused;
      state.status = 'off';
      attempt = 0;
      return changed();
    }
    const wait = RETRY_S[Math.min(attempt, RETRY_S.length - 1)];
    attempt++;
    state.status = 'retrying';
    state.note = `The bridge is not answering. Trying again in ${wait} s.`;
    timer = setTimeout(open, wait * 1000);
    changed();
  }

  return {
    get state() {
      return view();
    },
    connect() {
      wanted = true;
      attempt = 0;
      state.note = '';
      write(KEY_ON, '1');
      ws?.close();
      ws = null;
      open();
    },
    disconnect() {
      wanted = false;
      attempt = 0;
      clearTimeout(timer);
      write(KEY_ON, null);
      state.note = '';
      const socket = ws;
      ws = null;
      socket?.close();
      state.status = 'off';
      changed();
    },
    /** A new code: the old address stops working at once. */
    renew() {
      code = newCode();
      write(KEY_CODE, code);
      if (wanted) this.connect();
      else changed();
    },
    /** Connects again if the person had it connected when the page was last open. */
    resume() {
      if (read(KEY_ON) === '1') this.connect();
    },
  };
}

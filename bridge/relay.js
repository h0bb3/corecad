// The CoreCAD bridge: lets an MCP client (Claude) work in a CoreCAD browser tab.
//
//   Claude  --MCP over HTTPS-->  this relay  <--WebSocket--  the CoreCAD tab
//
// A browser tab cannot be an MCP server: nothing can connect to it. So the tab
// connects OUT to this relay and names a code; the MCP client connects to the
// address that ends in the same code; the relay passes tool calls to the tab and
// the answers back. The relay knows nothing about CAD: the tab says which tools
// it has, and the relay hands them on.
//
// The code is the key. It is made in the browser from 144 random bits, and anyone
// who has it can use that tab's tools while the tab is connected (they can read
// and change the CAD model open in it; they cannot do anything else in the
// browser). It is never written to disk here and not logged.
//
// A tab may also be WATCHED: another page (a headset, a phone) connects with the same code
// and says `watch`. What the tab shows goes to its viewers, and what a viewer points at goes
// to the tab. The relay does not read either: it only passes them on. A viewer has no tools.
//
// This file has no server of its own. A host gives it:
//   acceptBrowser(ws, req)        an accepted WebSocket (the `ws` package) and its upgrade request
//   handleMcp(req, res, code)     an HTTP request (req.body: the parsed JSON, or absent) for /mcp/<code>
// bridge/server.js is a small stand-alone host; an Express app mounts the same two.
'use strict';

if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
  globalThis.crypto = require('node:crypto').webcrypto; // the SDK's transport expects it
}
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const VERSION = '0.2.0';
/** A code: 20 to 64 URL-safe characters. Short codes are refused: they could be guessed. */
const CODE_RE = /^[A-Za-z0-9_-]{20,64}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/**
 * @param {object} [options]
 * @param {string[]} [options.origins]       pages that may connect as a tab (their Origin header)
 * @param {boolean} [options.allowLocalOrigins]  also http://localhost:* and http://127.0.0.1:* (development, tests)
 * @param {string} [options.homepage]        where a person opens CoreCAD (used in messages)
 * @param {number} [options.callTimeoutMs]   how long a tab may take to answer a call
 * @param {number} [options.maxMessageBytes] largest message a tab may send
 * @param {number} [options.maxRooms]        how many tabs may be connected at once
 * @param {number} [options.maxViewers]      how many viewers one code may have
 * @param {number} [options.maxViewersTotal] how many viewers there may be in all
 * @param {number} [options.maxViewerMessageBytes] largest message a viewer may send
 */
function createRelay(options = {}) {
  const opt = {
    origins: ['https://h0bb3.github.io'],
    allowLocalOrigins: false,
    homepage: 'https://h0bb3.github.io/corecad/',
    callTimeoutMs: 90_000, // under the 100 s after which a proxy such as Cloudflare gives up on a request
    helloTimeoutMs: 10_000,
    pingMs: 30_000,
    maxMessageBytes: 8 * 1024 * 1024,
    maxRooms: 200,
    maxPending: 8,
    maxTools: 64,
    maxViewers: 4,
    maxViewersTotal: 400,
    maxViewerMessageBytes: 64 * 1024,
    ...options,
  };
  /** code -> { code, ws, tools, instructions, pending: Map, seq, alive, since } */
  const rooms = new Map();
  /** code -> Set of { ws, id, code, alive }: who watches the tab with this code. They wait when no tab is there. */
  const watchers = new Map();
  let viewerSeq = 0,
    viewerCount = 0;
  const watching = (code) => [...(watchers.get(code) ?? [])];
  // What tools/list answers while no tab is connected: the tools of the last tab that said hello.
  let knownTools = [];

  const STATUS_TOOL = {
    name: 'corecad_status',
    description: 'Says whether a CoreCAD browser tab is connected to this address, and how to connect one. Use it first if another CoreCAD tool says that nothing is connected.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  };
  const HOW = `Open ${opt.homepage} in a browser, choose Connect, and keep that tab open.`;

  function originAllowed(origin) {
    if (opt.origins.includes(origin)) return true;
    return !!opt.allowLocalOrigins && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  }
  const close = (ws, code, reason) => {
    try {
      ws.close(code, reason);
    } catch {
      /* already gone */
    }
  };
  const send = (ws, message) => {
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };

  function leave(room, why) {
    if (rooms.get(room.code) === room) {
      rooms.delete(room.code);
      for (const v of watching(room.code)) send(v.ws, { type: 'host', on: false });
    }
    for (const p of room.pending.values()) p.done(text(why, true));
    room.pending.clear();
  }

  /** A page that wants to watch a tab says so first: { type: 'watch', code }. */
  function sayWatch(ws, m) {
    if (!CODE_RE.test(String(m.code ?? ''))) return close(ws, 4401, 'a valid code is needed'), null;
    const set = watchers.get(m.code) ?? new Set();
    if (set.size >= opt.maxViewers || viewerCount >= opt.maxViewersTotal) return close(ws, 4429, 'too many viewers; try again later'), null;
    const viewer = { ws, id: ++viewerSeq, code: m.code, alive: true };
    set.add(viewer);
    watchers.set(m.code, set);
    viewerCount++;
    const room = rooms.get(m.code);
    send(ws, { type: 'watching', version: VERSION, host: !!room });
    if (room) send(room.ws, { type: 'viewer', id: viewer.id, on: true });
    return viewer;
  }
  function unwatch(viewer) {
    const set = watchers.get(viewer.code);
    if (!set?.delete(viewer)) return;
    viewerCount--;
    if (!set.size) watchers.delete(viewer.code);
    const room = rooms.get(viewer.code);
    if (room) send(room.ws, { type: 'viewer', id: viewer.id, on: false });
  }

  function sayHello(ws, m) {
    if (m?.type !== 'hello' || !CODE_RE.test(String(m.code ?? ''))) return close(ws, 4401, 'a hello with a valid code is needed'), null;
    const list = Array.isArray(m.tools) ? m.tools : null;
    const fine = (t) =>
      t && TOOL_NAME_RE.test(String(t.name ?? '')) && t.name !== STATUS_TOOL.name && typeof t.description === 'string' && t.description.length <= 4000 &&
      t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema);
    if (!list || !list.length || list.length > opt.maxTools || !list.every(fine)) return close(ws, 4400, 'the list of tools is not valid'), null;
    const old = rooms.get(m.code);
    if (!old && rooms.size >= opt.maxRooms) return close(ws, 4429, 'the bridge is full; try again later'), null;
    if (old) {
      // The same code from another tab: the newer one takes over, as the person just asked for it there.
      send(old.ws, { type: 'replaced' });
      leave(old, 'The CoreCAD tab was replaced by another tab with the same address. Try again.');
      close(old.ws, 4409, 'replaced by another tab');
    }
    const room = {
      code: m.code,
      ws,
      tools: list.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      instructions: typeof m.instructions === 'string' ? m.instructions.slice(0, 4000) : '',
      pending: new Map(),
      seq: 0,
      alive: true,
      since: Date.now(),
    };
    rooms.set(room.code, room);
    knownTools = room.tools;
    // viewers: who watches this code already (they may have come first, or stayed through a reload of the tab)
    send(ws, { type: 'ready', version: VERSION, viewers: watching(room.code).map((v) => v.id) });
    for (const v of watching(room.code)) send(v.ws, { type: 'host', on: true });
    return room;
  }

  /** A tab has connected. `ws` is an accepted socket of the `ws` package; `req` its upgrade request. */
  function acceptBrowser(ws, req) {
    if (!originAllowed(String(req?.headers?.origin ?? ''))) return close(ws, 4403, 'this page may not use the bridge');
    let room = null,
      viewer = null;
    const waiting = setTimeout(() => close(ws, 4408, 'no hello'), opt.helloTimeoutMs);
    ws.on('pong', () => {
      if (room) room.alive = true;
      if (viewer) viewer.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      const size = Array.isArray(data) ? data.reduce((n, d) => n + d.length, 0) : data.length ?? data.byteLength;
      if (isBinary || size > (viewer ? opt.maxViewerMessageBytes : opt.maxMessageBytes)) return close(ws, 4413, 'only text messages up to the size limit');
      let m;
      try {
        m = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.concat([].concat(data).map((d) => Buffer.from(d))).toString('utf8'));
      } catch {
        return close(ws, 4400, 'not JSON');
      }
      if (viewer) {
        // What a viewer points at or asks to see: to the tab, which decides what it means.
        const host = rooms.get(viewer.code);
        if (m?.type === 'input' && host) send(host.ws, { type: 'input', from: viewer.id, data: m.data });
        return;
      }
      if (!room) {
        clearTimeout(waiting);
        if (m?.type === 'watch') viewer = sayWatch(ws, m);
        else room = sayHello(ws, m);
        return;
      }
      if (m?.type === 'show') {
        // What the tab shows: to its viewers (to one of them, when it says which), as it is.
        if (rooms.get(room.code) !== room) return;
        const out = JSON.stringify({ type: 'show', data: m.data });
        for (const v of watching(room.code))
          if (m.to === undefined || m.to === v.id)
            try {
              v.ws.send(out);
            } catch {
              /* its close event follows */
            }
        return;
      }
      if (m?.type !== 'result') return;
      const p = room.pending.get(m.id);
      if (!p) return; // answered too late, or never asked
      const content = Array.isArray(m.content) && m.content.every((c) => c && typeof c.type === 'string') ? m.content : null;
      p.done(content ? { content, ...(m.isError ? { isError: true } : {}) } : text('CoreCAD answered in a form the bridge does not understand.', true));
    });
    ws.on('close', () => {
      clearTimeout(waiting);
      if (room) leave(room, 'The CoreCAD tab disconnected before it answered. ' + HOW);
      if (viewer) unwatch(viewer);
    });
    ws.on('error', () => {});
  }

  function call(room, name, args) {
    if (room.pending.size >= opt.maxPending) return Promise.resolve(text('CoreCAD is still working on earlier commands. Wait for them, then try again.', true));
    return new Promise((resolve) => {
      const id = ++room.seq;
      const timer = setTimeout(
        () => p.done(text(`CoreCAD did not answer within ${Math.round(opt.callTimeoutMs / 1000)} s. It may still be working: ask get_state before trying again.`, true)),
        opt.callTimeoutMs
      );
      const p = {
        done(result) {
          clearTimeout(timer);
          room.pending.delete(id);
          resolve(result);
        },
      };
      room.pending.set(id, p);
      if (!send(room.ws, { type: 'call', id, name, arguments: args })) p.done(text('The CoreCAD tab could not be reached. ' + HOW, true));
    });
  }

  function buildServer(code) {
    const room = rooms.get(code);
    const server = new Server(
      { name: 'corecad', version: VERSION },
      {
        capabilities: { tools: {} },
        instructions: room?.instructions || `CoreCAD is a CAD program that runs in the user's browser tab; this server passes commands to that tab. If no tab is connected: ${HOW}`,
      }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const now = rooms.get(code);
      if (now) send(now.ws, { type: 'seen', what: 'tools/list' });
      return { tools: [STATUS_TOOL, ...(now?.tools ?? knownTools)] };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name,
        args = request.params.arguments ?? {},
        now = rooms.get(code);
      if (name === STATUS_TOOL.name)
        return text(now ? `A CoreCAD tab is connected (for ${Math.round((Date.now() - now.since) / 1000)} s) with ${now.tools.length} tools. Start with get_state.` : `No CoreCAD tab is connected to this address. ${HOW}`);
      if (!now) return text(`No CoreCAD tab is connected to this address. ${HOW} Then try again.`, true);
      if (!now.tools.some((t) => t.name === name)) return text(`CoreCAD has no tool "${name}".`, true);
      return call(now, name, args);
    });
    return server;
  }

  /** An MCP request for the tab with this code. One request: a fresh server and transport, as the SDK's stateless mode wants. */
  async function handleMcp(req, res, code) {
    const fail = (status, message, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
    };
    if (!CODE_RE.test(String(code ?? ''))) return fail(404, 'This is not a CoreCAD address. Copy the address from the Connect dialog in CoreCAD.');
    // No stream from here to the client (GET) and no sessions to end (DELETE): the specification's answer is 405.
    if (req.method !== 'POST') return fail(405, 'Method not allowed.', { Allow: 'POST' });
    const server = buildServer(code);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) fail(500, 'The bridge failed on this request.');
    } finally {
      try {
        await transport.close();
      } catch {
        /* closed */
      }
      try {
        await server.close();
      } catch {
        /* closed */
      }
    }
  }

  /** What a person sees who opens the bridge's address in a browser. */
  function info(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ name: 'corecad-bridge', version: VERSION, about: `Connects an MCP client to a CoreCAD browser tab. ${HOW}` }));
  }

  // Tabs that went away without saying so (a closed laptop) are noticed by a ping they do not answer.
  const pinger = setInterval(() => {
    for (const room of rooms.values()) {
      if (!room.alive) {
        try {
          room.ws.terminate();
        } catch {
          /* gone */
        }
        leave(room, 'The CoreCAD tab stopped answering. ' + HOW);
        continue;
      }
      room.alive = false;
      try {
        room.ws.ping();
      } catch {
        /* the close event follows */
      }
    }
    for (const set of [...watchers.values()])
      for (const v of [...set]) {
        if (!v.alive) {
          try {
            v.ws.terminate();
          } catch {
            /* gone */
          }
          unwatch(v);
          continue;
        }
        v.alive = false;
        try {
          v.ws.ping();
        } catch {
          /* the close event follows */
        }
      }
  }, opt.pingMs);
  pinger.unref?.();

  return {
    acceptBrowser,
    handleMcp,
    info,
    /** How many tabs are connected (for the host's own monitoring; never which). */
    get connected() {
      return rooms.size;
    },
    /** How many viewers are watching (never whom). */
    get watching() {
      return viewerCount;
    },
    close() {
      clearInterval(pinger);
      for (const set of [...watchers.values()]) for (const v of [...set]) close(v.ws, 1001, 'the bridge is shutting down');
      for (const room of [...rooms.values()]) {
        leave(room, 'The bridge is shutting down.');
        close(room.ws, 1001, 'the bridge is shutting down');
      }
    },
  };
}

module.exports = { createRelay, CODE_RE, VERSION };

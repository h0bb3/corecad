// The relay, from both ends: a real MCP client (the SDK's own, as Claude would speak)
// and a stand-in for the CoreCAD tab on a WebSocket.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { start } = require('../server.js');

const CODE = 'abcdefghijklmnopqrstuvwx';
const OTHER = 'ABCDEFGHIJKLMNOPQRSTUVWX';
const ORIGIN = 'https://h0bb3.github.io';
const TOOLS = [
  { name: 'get_state', description: 'The model at a glance.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'extrude', description: 'Extrudes a sketch.', inputSchema: { type: 'object', properties: { distance: { type: 'number' } } } },
];

let host;
test.before(async () => {
  host = await start({ port: 0, relayOptions: { callTimeoutMs: 400, helloTimeoutMs: 300, pingMs: 150 } });
});
test.after(async () => {
  await host.close();
});

const wsUrl = () => `ws://127.0.0.1:${host.port}/CoreCAD/ws`;
const mcpUrl = (code) => `http://127.0.0.1:${host.port}/CoreCAD/mcp/${code}`;

/** A tab: connects, says hello, answers calls with `answer(call)`. */
function tab({ code = CODE, origin = ORIGIN, tools = TOOLS, answer = (c) => ({ content: [{ type: 'text', text: `${c.name} ${JSON.stringify(c.arguments)}` }] }), hello = true, instructions } = {}) {
  const ws = new WebSocket(wsUrl(), { headers: { Origin: origin } });
  const t = { ws, messages: [], calls: [], closed: null };
  t.ready = new Promise((resolve, reject) => {
    ws.on('open', () => hello && ws.send(JSON.stringify({ type: 'hello', code, tools, instructions })));
    ws.on('message', async (data) => {
      const m = JSON.parse(data.toString());
      t.messages.push(m);
      if (m.type === 'ready') resolve(t);
      if (m.type === 'call') {
        t.calls.push(m);
        const r = await answer(m);
        if (r) ws.send(JSON.stringify({ type: 'result', id: m.id, ...r }));
      }
    });
    ws.on('close', (c, reason) => {
      t.closed = { code: c, reason: reason.toString() };
      reject(new Error(`closed ${c} ${reason}`));
    });
    ws.on('error', () => {});
  });
  t.ready.catch(() => {});
  t.gone = new Promise((resolve) => ws.on('close', () => resolve(t.closed)));
  t.close = () => new Promise((resolve) => (ws.readyState === WebSocket.CLOSED ? resolve() : (ws.once('close', resolve), ws.close())));
  return t;
}

async function client(code = CODE) {
  const c = new Client({ name: 'test-client', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl(code))));
  return c;
}
const textOf = (r) => r.content.map((c) => c.text ?? `[${c.type}]`).join(' ');

test('a client lists the tab\'s tools and calls one; the answer comes back', async () => {
  const t = await tab({ instructions: 'Start with get_state.' }).ready;
  const c = await client();
  assert.equal(c.getServerVersion().name, 'corecad');
  assert.equal(c.getInstructions(), 'Start with get_state.');
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((x) => x.name), ['corecad_status', 'get_state', 'extrude']);
  assert.deepEqual(tools[2].inputSchema.properties, { distance: { type: 'number' } });
  const r = await c.callTool({ name: 'extrude', arguments: { distance: 10 } });
  assert.equal(textOf(r), 'extrude {"distance":10}');
  assert.ok(!r.isError);
  assert.deepEqual(t.calls.map((x) => [x.name, x.arguments]), [['extrude', { distance: 10 }]]);
  assert.ok(t.messages.some((m) => m.type === 'seen'), 'the tab is told that a client looked');
  assert.match(textOf(await c.callTool({ name: 'corecad_status', arguments: {} })), /A CoreCAD tab is connected .* with 2 tools/);
  await c.close();
  await t.close();
});

test('errors and pictures pass through as the tab gave them', async () => {
  const t = await tab({
    answer: (c) =>
      c.name === 'extrude'
        ? { isError: true, content: [{ type: 'text', text: 'Give a distance.' }] }
        : { content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }, { type: 'text', text: '{"width":2}' }] },
  }).ready;
  const c = await client();
  const bad = await c.callTool({ name: 'extrude', arguments: {} });
  assert.equal(bad.isError, true);
  assert.equal(textOf(bad), 'Give a distance.');
  const pic = await c.callTool({ name: 'get_state', arguments: {} });
  assert.deepEqual(pic.content[0], { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
  await c.close();
  await t.close();
});

test('each code reaches its own tab only', async () => {
  const a = await tab({ code: CODE, answer: () => ({ content: [{ type: 'text', text: 'from A' }] }) }).ready;
  const b = await tab({ code: OTHER, answer: () => ({ content: [{ type: 'text', text: 'from B' }] }) }).ready;
  const ca = await client(CODE),
    cb = await client(OTHER);
  assert.equal(textOf(await ca.callTool({ name: 'get_state', arguments: {} })), 'from A');
  assert.equal(textOf(await cb.callTool({ name: 'get_state', arguments: {} })), 'from B');
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
  await ca.close();
  await cb.close();
  await a.close();
  await b.close();
});

test('with no tab connected the client is told how to connect one, and still sees the tools', async () => {
  await (await tab().ready).close();
  const c = await client('nobodyisconnectedwiththiscode');
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((x) => x.name), ['corecad_status', 'get_state', 'extrude'], 'the tools of the last tab are remembered');
  const r = await c.callTool({ name: 'get_state', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /No CoreCAD tab is connected to this address\. Open https:\/\/h0bb3\.github\.io\/corecad\/ in a browser, choose Connect/);
  assert.match(textOf(await c.callTool({ name: 'corecad_status', arguments: {} })), /No CoreCAD tab is connected/);
  await c.close();
});

test('an unknown tool, a tab that never answers, and a tab that leaves mid-call', async () => {
  let t = await tab({ answer: () => null }).ready;
  const c = await client();
  const unknown = await c.callTool({ name: 'format_disk', arguments: {} });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /CoreCAD has no tool "format_disk"/);
  assert.equal(t.calls.length, 0, 'an unknown tool never reaches the tab');
  const slow = await c.callTool({ name: 'get_state', arguments: {} });
  assert.equal(slow.isError, true);
  assert.match(textOf(slow), /did not answer within/);
  const leaving = c.callTool({ name: 'get_state', arguments: {} });
  await new Promise((r) => setTimeout(r, 50));
  t.ws.terminate();
  assert.match(textOf(await leaving), /disconnected before it answered/);
  await c.close();
});

test('a second tab with the same code takes over; the first is told', async () => {
  const first = await tab({ answer: () => ({ content: [{ type: 'text', text: 'first' }] }) }).ready;
  const second = await tab({ answer: () => ({ content: [{ type: 'text', text: 'second' }] }) }).ready;
  const gone = await first.gone;
  assert.equal(gone.code, 4409);
  assert.ok(first.messages.some((m) => m.type === 'replaced'));
  const c = await client();
  assert.equal(textOf(await c.callTool({ name: 'get_state', arguments: {} })), 'second');
  await c.close();
  await second.close();
});

test('who may connect as a tab: the right page, a real code, real tools, and in time', async () => {
  assert.equal((await tab({ origin: 'https://evil.example' }).gone).code, 4403);
  assert.equal((await tab({ origin: 'http://localhost:8000' }).gone).code, 4403, 'localhost only when allowed');
  assert.equal((await tab({ code: 'short' }).gone).code, 4401);
  assert.equal((await tab({ tools: [] }).gone).code, 4400);
  assert.equal((await tab({ tools: [{ name: 'Bad Name', description: 'x', inputSchema: {} }] }).gone).code, 4400);
  assert.equal((await tab({ tools: [{ name: 'corecad_status', description: 'x', inputSchema: {} }] }).gone).code, 4400, 'the bridge\'s own tool cannot be taken');
  assert.equal((await tab({ hello: false }).gone).code, 4408);
});

test('a tab that stops answering pings is dropped', async () => {
  const t = await tab().ready;
  t.ws.pong = () => {}; // go deaf: the `ws` client answers pings by itself otherwise
  t.ws._receiver.removeAllListeners('ping');
  const gone = await Promise.race([t.gone, new Promise((r) => setTimeout(() => r('still here'), 1500))]);
  assert.notEqual(gone, 'still here');
  const c = await client();
  assert.equal((await c.callTool({ name: 'get_state', arguments: {} })).isError, true);
  await c.close();
});

/** A viewer: connects and says watch. */
function viewer({ code = CODE, origin = ORIGIN } = {}) {
  const ws = new WebSocket(wsUrl(), { headers: { Origin: origin } });
  const v = { ws, messages: [], closed: null };
  const waiters = [];
  v.next = (type) =>
    new Promise((resolve) => {
      const i = v.messages.findIndex((m) => m.type === type && !m.taken);
      if (i >= 0) return resolve(((v.messages[i].taken = true), v.messages[i]));
      waiters.push({ type, resolve });
    });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'watch', code })));
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    v.messages.push(m);
    const i = waiters.findIndex((w) => w.type === m.type);
    if (i >= 0) ((m.taken = true), waiters.splice(i, 1)[0].resolve(m));
  });
  ws.on('error', () => {});
  v.gone = new Promise((resolve) => ws.on('close', (c, reason) => resolve((v.closed = { code: c, reason: reason.toString() }))));
  v.send = (data) => ws.send(JSON.stringify({ type: 'input', data }));
  v.close = () => new Promise((resolve) => (ws.readyState === WebSocket.CLOSED ? resolve() : (ws.once('close', resolve), ws.close())));
  return v;
}
const until = async (fn, ms = 1500) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
};

test('a viewer watches a tab: what the tab shows reaches it, what it points at reaches the tab', async () => {
  const t = await tab().ready;
  assert.deepEqual(t.messages.find((m) => m.type === 'ready').viewers, [], 'nobody watches yet');
  const v = viewer();
  assert.equal((await v.next('watching')).host, true);
  assert.ok(await until(() => t.messages.some((m) => m.type === 'viewer' && m.on)), 'the tab is told that somebody watches');
  const id = t.messages.find((m) => m.type === 'viewer').id;
  t.ws.send(JSON.stringify({ type: 'show', data: { bodies: [1, 2, 3] } }));
  assert.deepEqual((await v.next('show')).data, { bodies: [1, 2, 3] });
  v.send({ point: [1, 2, 3] });
  assert.ok(await until(() => t.messages.some((m) => m.type === 'input')));
  assert.deepEqual(t.messages.find((m) => m.type === 'input'), { type: 'input', from: id, data: { point: [1, 2, 3] } });
  // a viewer has no tools: nothing it sends is a call or an answer
  v.ws.send(JSON.stringify({ type: 'result', id: 1, content: [{ type: 'text', text: 'not mine to give' }] }));
  v.ws.send(JSON.stringify({ type: 'hello', code: CODE, tools: TOOLS }));
  // a second viewer, shown something alone; another code's viewer sees nothing of it
  const second = viewer(),
    other = viewer({ code: OTHER });
  await second.next('watching');
  assert.equal((await other.next('watching')).host, false);
  assert.ok(await until(() => t.messages.filter((m) => m.type === 'viewer' && m.on).length === 2));
  const secondId = t.messages.filter((m) => m.type === 'viewer').at(-1).id;
  t.ws.send(JSON.stringify({ type: 'show', to: secondId, data: 'for the second' }));
  t.ws.send(JSON.stringify({ type: 'show', data: 'for all' }));
  assert.equal((await second.next('show')).data, 'for the second');
  assert.equal((await second.next('show')).data, 'for all');
  assert.equal((await v.next('show')).data, 'for all');
  assert.equal(other.messages.filter((m) => m.type === 'show').length, 0);
  // the tools still work beside it, and the tab is still the tab
  const c = await client();
  assert.equal(textOf(await c.callTool({ name: 'get_state', arguments: {} })), 'get_state {}');
  await c.close();
  // a viewer leaves: the tab is told
  await second.close();
  assert.ok(await until(() => t.messages.some((m) => m.type === 'viewer' && m.id === secondId && m.on === false)));
  await Promise.all([v.close(), other.close(), t.close()]);
});

test('a viewer may come first and stays through a reload of the tab', async () => {
  const v = viewer();
  assert.equal((await v.next('watching')).host, false);
  const t = await tab().ready;
  assert.equal(t.messages.find((m) => m.type === 'ready').viewers.length, 1, 'the tab learns who waits');
  assert.equal((await v.next('host')).on, true);
  await t.close();
  assert.equal((await v.next('host')).on, false);
  const again = await tab().ready;
  assert.equal(again.messages.find((m) => m.type === 'ready').viewers.length, 1);
  assert.equal((await v.next('host')).on, true);
  again.ws.send(JSON.stringify({ type: 'show', data: 'back' }));
  assert.equal((await v.next('show')).data, 'back');
  await Promise.all([v.close(), again.close()]);
});

test('who may watch: the right page, a real code, not too many, small messages, and it must answer pings', async () => {
  assert.equal((await viewer({ origin: 'https://example.com' }).gone).code, 4403);
  assert.equal((await viewer({ code: 'short' }).gone).code, 4401);
  const four = [viewer(), viewer(), viewer(), viewer()];
  await Promise.all(four.map((x) => x.next('watching')));
  assert.equal((await viewer().gone).code, 4429, 'a fifth viewer of one code');
  four[0].ws.send(JSON.stringify({ type: 'input', data: 'x'.repeat(70 * 1024) }));
  assert.equal((await four[0].gone).code, 4413);
  // one that stops answering pings is dropped
  four[1].ws.pong = () => {};
  four[1].ws._receiver.removeAllListeners('ping');
  assert.ok((await four[1].gone).code);
  await Promise.all(four.slice(2).map((x) => x.close()));
});

test('the HTTP edges: not a code, not POST, not JSON, and the line about what this is', async () => {
  const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body });
  const short = await post(mcpUrl('short'), '{}');
  assert.equal(short.status, 404);
  assert.match((await short.json()).error.message, /not a CoreCAD address/);
  const get = await fetch(mcpUrl(CODE));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await fetch(mcpUrl(CODE), { method: 'DELETE' })).status, 405);
  assert.equal((await post(mcpUrl(CODE), '{not json')).status, 400);
  const info = await fetch(`http://127.0.0.1:${host.port}/CoreCAD`);
  assert.equal((await info.json()).name, 'corecad-bridge');
  assert.equal(info.headers.get('access-control-allow-origin'), '*');
  assert.equal((await fetch(`http://127.0.0.1:${host.port}/elsewhere`)).status, 404);
  // The code may also be given as ?code= (for hosts whose routing cannot take it in the path).
  const viaQuery = await post(`http://127.0.0.1:${host.port}/CoreCAD/mcp?code=${CODE}`, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
  assert.equal(viaQuery.status, 200);
});

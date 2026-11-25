// A stand-alone host for the CoreCAD bridge (relay.js): for running your own, and for the tests.
//
//   PORT=8787 BASE=/CoreCAD node server.js
//
//   POST  {BASE}/mcp/<code>     the MCP endpoint a client connects to
//   WS    {BASE}/ws             where a CoreCAD tab connects
//   GET   {BASE}                one line about what this is
//
// ORIGINS: comma-separated pages that may connect as a tab (default: the public CoreCAD).
// ALLOW_LOCAL=1: also pages on localhost (development).
// Put it behind TLS (a reverse proxy): the code in the address is the key.
'use strict';

const http = require('node:http');
const { WebSocketServer } = require('ws');
const { createRelay } = require('./relay.js');

function start({ port = 8787, base = '/CoreCAD', host = '127.0.0.1', relayOptions = {} } = {}) {
  const relay = createRelay(relayOptions);
  const prefix = base.replace(/\/+$/, '').toLowerCase();
  const wss = new WebSocketServer({ noServer: true, maxPayload: relayOptions.maxMessageBytes ?? 8 * 1024 * 1024 });

  // A plain limit per address: this is a public door.
  const seen = new Map();
  const tooMany = (req) => {
    const key = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || ''),
      now = Date.now(),
      e = seen.get(key);
    if (!e || now - e.t > 60_000) return seen.set(key, { t: now, n: 1 }), false;
    return ++e.n > 300;
  };
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of seen) if (now - e.t > 60_000) seen.delete(k);
  }, 60_000);
  sweep.unref();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x'),
      path = url.pathname.replace(/\/+$/, '').toLowerCase();
    if (tooMany(req)) return res.writeHead(429, { 'Content-Type': 'application/json' }).end('{"error":"rate limit exceeded"}');
    if (path === prefix && req.method === 'GET') return relay.info(req, res);
    if (!path.startsWith(prefix + '/mcp')) return res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}');
    const code = url.pathname.replace(/\/+$/, '').slice(prefix.length + '/mcp'.length).replace(/^\//, '') || url.searchParams.get('code');
    if (req.method !== 'POST') return relay.handleMcp(req, res, code);
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' }).end('{"error":"body too large"}');
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        req.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"},"id":null}');
      }
      relay.handleMcp(req, res, code);
    });
  });
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '').toLowerCase();
    if (path !== prefix + '/ws' || tooMany(req)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => relay.acceptBrowser(ws, req));
  });
  return new Promise((resolve) => {
    server.listen(port, host, () =>
      resolve({
        port: server.address().port,
        relay,
        close: () =>
          new Promise((done) => {
            relay.close();
            clearInterval(sweep);
            wss.close();
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      })
    );
  });
}

module.exports = { start };

if (require.main === module) {
  const origins = (process.env.ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  start({
    port: Number(process.env.PORT || 8787),
    host: process.env.HOST || '127.0.0.1',
    base: process.env.BASE || '/CoreCAD',
    relayOptions: { ...(origins.length ? { origins } : {}), allowLocalOrigins: process.env.ALLOW_LOCAL === '1' },
  }).then((s) => console.log(`CoreCAD bridge listening on :${s.port}${process.env.BASE || '/CoreCAD'}`));
}

# The CoreCAD bridge

Lets an MCP client (Claude) work in a CoreCAD browser tab.

```
Claude  --MCP over HTTPS-->  the relay  <--WebSocket--  the CoreCAD tab
        POST {base}/mcp/<code>          WS {base}/ws, then { type: 'hello', code, tools }
```

A browser tab cannot be an MCP server, because nothing can connect to it. So
the tab connects out to this relay and names a code, the MCP client connects
to the address that ends in the same code, and the relay passes tool calls to
the tab and the answers back. The relay knows nothing about CAD: the tab
announces its tools (`corecad.tools`, see `docs/COMMANDS.md`) and the relay
hands them on, plus one of its own, `corecad_status`.

## For a person

1. Open CoreCAD, choose **Connect**, then **Connect** in the dialog, and keep
   the tab open.
2. Copy the address from the dialog. In Claude: Settings, Connectors, *Add
   custom connector*; paste it; no sign-in.
3. Ask Claude to build something. Every change appears in the tab and is an
   undo step there.

**Disconnect** cuts the client off. **New address** makes the old address
useless. The tab reconnects by itself after a reload if it was left
connected, and stays off if it was switched off.

## What the code protects, and what it does not

- The code is 144 random bits made in the browser and kept in that browser's
  storage. It is the whole key: whoever has the address can use the tab's
  commands while the tab is connected. Treat the address like a password.
- A holder of the code can read and change **the CAD model in that tab**
  through the announced commands. They cannot run script in the page, reach
  other tabs, or touch anything else in the browser.
- The model passes through the relay (in memory only; nothing is stored or
  logged) and on to the MCP client. "Nothing leaves your computer" is true of
  CoreCAD only while this is not connected.
- The relay accepts tabs only from the pages listed in `origins`, refuses
  codes shorter than 20 characters, and bounds everything: tabs at once,
  message size, calls waiting, time per call.

## The pieces

- `relay.js`: the relay, with no server of its own. A host gives it accepted
  WebSockets (`acceptBrowser(ws, req)`) and MCP requests
  (`handleMcp(req, res, code)`). It uses the official MCP SDK in its
  stateless mode: one request, one answer, no sessions.
- `server.js`: a small stand-alone host (`PORT=8787 BASE=/CoreCAD node
  server.js`; `ALLOW_LOCAL=1` lets pages on localhost connect). Put it behind
  TLS.
- `test/relay.test.js`: `npm test`, with the SDK's own MCP client on one side
  and a stand-in tab on the other.
- `../src/api/bridge.js`: the tab's end. `../tools/e2e_bridge.py`: the whole
  chain with the real page and the real kernel.

The public CoreCAD connects to the relay mounted at `vibedit.app/CoreCAD`
(the same `relay.js`, in that server). `?bridge=ws://localhost:8787/CoreCAD/ws`
points a page at a relay on your own machine instead; only localhost is
accepted there.

## The messages between tab and relay

| From | Message |
|---|---|
| tab | `{ type: 'hello', code, tools: [{ name, description, inputSchema }], instructions }` |
| relay | `{ type: 'ready', version }` |
| relay | `{ type: 'call', id, name, arguments }` |
| tab | `{ type: 'result', id, content: [...], isError? }` (MCP tool-result content) |
| relay | `{ type: 'seen', what }` an MCP client listed the tools |
| relay | `{ type: 'replaced' }` another tab connected with the same code |

The relay closes a tab with a reason: 4400 bad hello, 4401 no valid code,
4403 page not allowed, 4408 no hello in time, 4409 replaced, 4413 message too
large, 4429 full.

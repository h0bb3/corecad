# The CoreCAD bridge

Lets an MCP client (Claude) work in a CoreCAD browser tab.

```
Claude  --MCP over HTTPS-->  the relay  <--WebSocket--  the CoreCAD tab
        POST {base}/mcp/<code>          WS {base}/ws, then { type: 'hello', code, tools }
```

A tab can also be **watched**: another page (a headset, a phone) connects
with the same code and shows what the tab shows.

```
the watching page  --WebSocket, { type: 'watch', code }-->  the relay  <--  the CoreCAD tab
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

**While an agent is at work** the view in the tab has an orange frame and a
line at its lower left: what the agent is doing while a command runs ("An
agent is changing the model · extrude", or "is looking at the model" for a
command that only reads), and after it what it did last. The Connect button
reads **Agent working**. Twenty seconds after the last command they go away:
an agent thinks between commands, so a short silence is not the end of its
work. The line opens the Connect dialog, which lists the latest commands with
their times and marks the ones that were refused.

**On a headset or a phone.** Once the tab is connected, the Connect dialog
shows a QR code and an address: the page `view.html` with the tab's code
behind a `#`. A device that opens it shows the model of the tab, live, and in
a headset at its real size in the room. It can point, choose, measure, cut
the model open and see through it; what it points at is "this" for an agent.
It cannot change the model. Up to four devices may watch one tab. The address
holds the tab's code: treat it like the address for Claude.

**Disconnect** cuts the client off. **New address** makes the old address
useless. The tab reconnects by itself after a reload if it was left
connected, and stays off if it was switched off.

**New commands that the client does not show.** The tab says which tools it
has when it connects, and the relay answers `tools/list` with those, afresh
each time. A client keeps the list it read: after CoreCAD has been updated,
reload the tab (its **Update** button, or the `reload_app` tool) and then
reconnect the server in the client. The relay has no open connection to a
client, so it cannot announce a changed list (`notifications/tools/list_changed`).

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
- A watching page needs the same code and the same `origins`. It has no
  tools: the relay passes what it sends to the tab as `input` and nothing
  else, and the tab takes only pointing, choosing, a cut and see-through
  from it (`checkInput` in `src/api/mirror.js`). Whoever has the code could
  use the MCP address as well, so a watching page is no weaker a key. Four
  viewers a code, 64 KB a message from one.

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
- `../src/api/mirror.js`: what a tab shows a watching page and what comes
  back. `../view.html` and `../src/viewer.js`: the watching page.
  `../tools/e2e_view.py`: a tab and a watching page through this relay.

The public CoreCAD connects to the relay mounted at `vibedit.app/CoreCAD`
(the same `relay.js`, in that server). `?bridge=ws://localhost:8787/CoreCAD/ws`
points a page at a relay on your own machine instead; only localhost is
accepted there.

## The messages between tab and relay

| From | Message |
|---|---|
| tab | `{ type: 'hello', code, tools: [{ name, description, inputSchema }], instructions }` |
| relay | `{ type: 'ready', version }` |
| relay | `{ type: 'call', id, name, arguments }` (from its arrival to the tab's answer the tab counts an agent as busy) |
| tab | `{ type: 'result', id, content: [...], isError? }` (MCP tool-result content) |
| relay | `{ type: 'seen', what }` an MCP client listed the tools |
| relay | `{ type: 'replaced' }` another tab connected with the same code |
| relay | `{ type: 'ready', version, viewers: [id] }` since 0.2.0: who watches already |
| relay | `{ type: 'viewer', id, on }` a page has begun or stopped watching |
| tab | `{ type: 'show', data, to? }` for its viewers (for one of them): passed on as it is |
| relay | `{ type: 'input', from, data }` what a viewer sent |

Between a watching page and the relay:

| From | Message |
|---|---|
| page | `{ type: 'watch', code }` |
| relay | `{ type: 'watching', version, host }` host: whether the tab is there |
| relay | `{ type: 'host', on }` the tab has come or gone; the page waits |
| relay | `{ type: 'show', data }` what the tab shows (`src/api/mirror.js` says what is in it) |
| page | `{ type: 'input', data }` |

A relay before 0.2.0 closes a `watch` with 4401; the tab sees no `viewers` in
`ready` and says in its dialog that the relay is an older one.

The relay closes a tab with a reason: 4400 bad hello, 4401 no valid code,
4403 page not allowed, 4408 no hello in time, 4409 replaced, 4413 message too
large, 4429 full.

# Handover

For the next agent, on 2026-11-28. `main` is clean, pushed and published
(https://h0bb3.github.io/corecad/; `src/version.js` names the build).

## Read first

- [docs/STATUS.md](docs/STATUS.md): where it stands, what is decided, what
  is open for the owner, what is next, and the log of all work.
- [docs/COMMANDS.md](docs/COMMANDS.md): the 53 commands, and the rule of one
  way to do each thing.
- [docs/KERNEL_NOTES.md](docs/KERNEL_NOTES.md) before touching the kernel:
  OpenCascade gets several things wrong without saying so (threads, see
  "A profile turned about an axis while it rises").
- [bridge/README.md](bridge/README.md): the MCP relay and the watching page.

## The owner's rules

- **One way to do each thing; primitives, not conveniences.** An agent is
  the main user; a person inspects and directs. Ask before adding any new
  shortcut.
- Commit and push straight to `main`. Do not put personal names in these
  public docs.

## Routine

- After any change to a page file: `python tools/stamp.py`.
- Tests: `python tools/run_tests.py` (165 tests in 20 pages), then
  `tools/e2e.py`, `e2e_more.py`, `e2e_parts.py`, `e2e_export.py`,
  `e2e_api.py`, and with Node (`NODE=E:/projects/new_coding/tools/node/node.exe`)
  `e2e_bridge.py` and `e2e_view.py`. Set `PYTHONIOENCODING=utf-8`.
- After pushing, GitHub Pages publishes in about a minute: poll
  `src/version.js`, then `python tools/e2e_api.py "https://h0bb3.github.io/corecad/?test=1"`
  and `python tools/e2e_bridge.py --live`.
- The relay runs as a copy in the private `h0bb3/vibedit`
  (`src/corecad-relay.js`). A relay change: edit `bridge/relay.js` here,
  run `npm test` in `bridge/`, copy it under the three header lines there,
  open a pull request; the owner merges and deploys.
- Write patch scripts to files with the Write tool: shell here-documents
  break backslashes.

## Open threads

- **The headset**: the in-page QR scanner (`view.html`, Scan a code) cannot
  work on the owner's Quest until it is updated: it was on Horizon OS v74
  with Browser 38.2, and its Software update page crashes. Until then the
  watching page works from a bookmark (it remembers the last tab).
- **Not tried by hand**: import of a STEP file from another CAD program;
  revolve with a rise (threads) printed; in the headset: numbers on the
  model, the cut, see-through, fine placement (grip + trigger).
- **Drawings** (2026-11-28, STATUS.md "Drawings for the workshop" and
  "Drawings by hand", "Section views"): made by the agent or by hand on the
  sheet, ISO 7200 title block, notes, tolerances, sections, details, angles,
  revisions, surface symbols, threads by ISO 6410, PDF. Not yet: a printed
  PDF measured with a ruler; what else professional drawings have
  (question 8).
- **Open for the owner** (STATUS.md, "Open, for the owner"): eight
  questions, none answered yet.
- **Next** (STATUS.md, not started): named numbers with arithmetic, mirror,
  shell, sweep, loft; STL import.

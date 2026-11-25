# CoreCAD v0.1 status — 2026-11-25

The takeover implementation is complete. The required first-version workflow is
implemented in the existing static site: constrained sketches on origin planes
and planar faces; dimensions and dragging; closed profiles with holes; new/join/
cut/intersect extrusions; quick holes; fillets and chamfers; editable history,
suppression/deletion/rename/rollback; undo/redo; project files, autosave and STL/STEP.
Plane redefinition and body visibility are included. Controls have hover help.

The specification is in `docs/SPEC.md`. Tested foundations and prototype algorithms
were promoted into `src/`; runtime and tests have no dependency on `.scratch/`.
Work was committed and pushed in stages to the existing `main` branch. The existing
Claude/psmux session was not touched. No repositories or releases were created.
The live site is [h0bb3.github.io/corecad](https://h0bb3.github.io/corecad/).
The verified application revision is `5afb7b3`.

## Verification

- `python tools/run_tests.py`: **57 tests passed**, including the real OpenCascade
  worker, all constraint derivatives and solve/drag cases, randomized analytic
  profile arrangements, document validation, safe rendering of imported names and undo id watermarks.
- `python tools/e2e.py`: passed using actual mouse/key events. A fully constrained
  60 × 40 plate is extruded 10 mm, cut by an 8 mm face circle, and given four
  R4 vertical fillets. Expected volume: 23,360 mm³. Changing upstream height to
  20 mm preserves references and gives 46,720 mm³. Undo/redo, exports and autosave
  reload also pass.
- `python tools/e2e_more.py`: passed. Covers XZ sketches, constrained dragging,
  redundant-constraint rejection, fixed arcs/points, typed sizes, dimension and
  history double-click editing, blind holes, chamfers, lost references, invalid
  preview cancellation, actual project download/reopen, YZ plane redefinition,
  body visibility, rollback and hover-help coverage.
- Kernel tests also check joins, intersections, nested and arc profiles, symmetric
  and two-sided extents, atomic failures, binary STL/STEP output, superseded requests,
  Stop/Retry recovery and ownership bounds after 125 parameter edits.
- Screenshots were visually reviewed. Validation used desktop Chrome on Windows;
  Firefox, Safari, mobile interaction and very large models are not certified.
- The deployed JavaScript was checked against the local source, and the primary
  end-to-end workflow passed again against the public GitHub Pages URL.

## Remaining limits

This is a small desktop modeller. Topological references use feature labels and
geometric hints; major topology changes can still lose a reference and are reported
in history. Sketches can be moved to another plane; edge selections can be re-picked.
Kernel operation failures keep the prior valid solid. Stop restarts the worker and
skips the stopped operation until its parameters change or Retry is used.

CDN access is needed for the geometry/view libraries. Autosave is one committed
project in localStorage, subject to browser quota and clearing; Save downloads the
portable copy. Number expressions are evaluated once, not retained as named formulas.

Deferred as specified: 2D fillet/chamfer, trim, offset, mirror, extra constraints,
named parameters, projected geometry, dedicated measurement/section tools, imports,
revolve, sweep, loft, shell, patterns and assemblies. No required work is blocked.

import { createStore } from './store.js';
import { createViewport } from './view/viewport.js';
import * as VM from './view/camera-math.js';
import { createEditor } from './sketch/editor.js';
import { findRegions, profileRefFrom, regionAt, resolveProfile } from './sketch/profiles.js';
import { polygonOf, curvesOf, curvePoint } from './sketch/geom2d.js';
import { measure } from './sketch/measure.js';
import { DIMENSIONS } from './sketch/catalogue.js';
import { solveSketch } from './sketch/solver.js';
import {
  createDocument,
  makeFeature,
  addFeature,
  updateFeature,
  removeFeature,
  featureById,
  setBodyProps,
  dependents,
} from './doc/model.js';
import { validateFeature } from './doc/features.js';
import { faceRefFrom, edgeRefFrom, frameOfSketch, resolveEdgeRef } from './doc/refs.js';
import { canonicalFrame, basePlane, toWorld, toLocal } from './core/plane.js';
import { parseNumber, formatNumber as fmt } from './core/num.js';
import { projectBlob, readProject, filename, download } from './persist.js';
import { escapeHTML as esc, icon, tool, field, selectField, check, head } from './ui.js';
import { createCommands } from './api/commands.js';
import { createBridge } from './api/bridge.js';

const $ = (s) => document.querySelector(s),
  id = (s) => document.getElementById(s),
  store = createStore();
let editor = null,
  sketchSession = null,
  draft = null,
  selectedFeature = null,
  replaneId = null,
  selection = [],
  lastBuild = null,
  toastTimer,
  previewTimer,
  fitNext = false,
  rolled = false,
  modal = null,
  modelPress = null;
const constraintNames = {
  coincident: ['●', 'Coincident'],
  pointOnLine: ['•', 'On line'],
  pointOnCircle: ['•', 'On circle'],
  horizontal: ['H', 'Horizontal'],
  vertical: ['V', 'Vertical'],
  parallel: ['∥', 'Parallel'],
  perpendicular: ['⊥', 'Perpendicular'],
  tangent: ['T', 'Tangent'],
  equal: ['=', 'Equal'],
  concentric: ['◎', 'Concentric'],
  midpoint: ['M', 'Midpoint'],
  fix: ['▣', 'Fix'],
};
function toast(message) {
  id('toast').textContent = message;
  id('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (id('toast').hidden = true), 7000);
}
const view = createViewport(id('viewport'), {
  down: (p, e) => {
    if (editor) editor.down(p, e);
    else modelPress = p;
  },
  move: (p, e) => {
    if (editor) editor.move(p, e);
    else {
      const filter =
        draft?.feature.type === 'hole'
          ? 'face'
          : ['fillet', 'chamfer'].includes(draft?.feature.type)
          ? 'edge'
          : 'all';
      view.hover(view.pick(...p, filter, e.altKey));
    }
  },
  up: (p, e) => {
    if (editor) editor.up();
    else if (modelPress && Math.hypot(p[0] - modelPress[0], p[1] - modelPress[1]) < 5)
      modelClick(p, e);
    modelPress = null;
  },
  double: (p, e) => editor?.double(p, e),
  cancel: () => editor?.cancel(),
  error: toast,
  ready: () => {
    window.corecadReady = true;
  },
});
view.overlay((ctx) => {
  if (editor) editor.draw(ctx);
  else drawProfiles(ctx);
});
function visible(bs) {
  return (bs ?? []).filter((b) => !store.state.doc.bodies[b.id]?.hidden);
}
function activeSketch() {
  const sid = draft?.feature.type === 'extrude' ? draft.feature.sketch : selectedFeature;
  return featureById(store.state.doc, sid)?.type === 'sketch'
    ? featureById(store.state.doc, sid)
    : null;
}
function sketchFrame(f) {
  return (
    store.state.build?.features.find((r) => r.id === f.id)?.frame ??
    frameOfSketch(f, store.state.build?.bodies ?? []).frame
  );
}
function profileData() {
  const s = activeSketch();
  if (!s) return null;
  try {
    return { s, frame: sketchFrame(s), regions: findRegions(s) };
  } catch {
    return null;
  }
}
function drawProfiles(ctx) {
  const data = profileData();
  if (!data) return;
  const { s, frame, regions } = data,
    project = (p) => view.project(toWorld(frame, p));
  for (const r of regions) {
    ctx.beginPath();
    for (const loop of [r.outer, ...r.holes]) {
      polygonOf(loop).forEach((p, i) => {
        const q = project(p);
        if (i) ctx.lineTo(q[0], q[1]);
        else ctx.moveTo(q[0], q[1]);
      });
      ctx.closePath();
    }
    const chosen = draft?.feature.profiles?.some(
      (ref) => resolveProfile(regions, ref)?.region === r
    );
    ctx.fillStyle = chosen ? '#1da57d39' : '#2d9b8c15';
    ctx.fill('evenodd');
  }
  ctx.strokeStyle = '#279680';
  ctx.lineWidth = 1.25;
  for (const c of curvesOf(s)) {
    ctx.beginPath();
    const n = c.kind === 'line' ? 1 : 96;
    for (let i = 0; i <= n; i++) {
      const q = project(curvePoint(c, i / n));
      if (i) ctx.lineTo(q[0], q[1]);
      else ctx.moveTo(q[0], q[1]);
    }
    ctx.stroke();
  }
}
function modelClick(p, e) {
  if (modal) return;
  if (replaneId) {
    const h = view.pick(...p, 'face');
    if (h) {
      try {
        changePlane({
          kind: 'face',
          ref: faceRefFrom(
            view.pickBodies.find((b) => b.id === h.body),
            h.face
          ),
        });
      } catch (error) {
        toast(error.message);
      }
    }
    return;
  }
  if (draft?.feature.type === 'extrude') {
    const data = profileData(),
      uv = data && VM.planePoint(view.view, view.vp, ...p, data.frame),
      r = uv && regionAt(data.regions, uv);
    if (r) {
      toggleRegion(r);
      return;
    }
  }
  const filter =
      draft?.feature.type === 'hole'
        ? 'face'
        : ['fillet', 'chamfer'].includes(draft?.feature.type)
        ? 'edge'
        : 'all',
    hit = view.pick(...p, filter, e.altKey);
  if (draft && ['fillet', 'chamfer'].includes(draft.feature.type) && hit?.type === 'edge') {
    toggleEdge(hit);
    return;
  }
  if (draft?.feature.type === 'hole' && hit?.type === 'face') {
    setHoleFace(hit);
    return;
  }
  if (!hit) {
    selection = [];
    view.select([]);
    return;
  }
  const key = (h) => `${h.body}:${h.type}:${h.face ?? h.edge}`;
  selection = e.shiftKey
    ? selection.some((h) => key(h) === key(hit))
      ? selection.filter((h) => key(h) !== key(hit))
      : [...selection, hit]
    : [hit];
  selectedFeature = null;
  view.select(selection);
  view.dirty();
  renderBrowser();
  const b = view.pickBodies.find((b) => b.id === hit.body);
  id('context-note').textContent =
    hit.type === 'face'
      ? b.mesh.faces[hit.face].plane
        ? 'Flat face selected · Sketch or Hole to continue.'
        : 'Curved face selected. Sketches and holes need a flat face.'
      : 'Edge selected · Shift-click more edges, then Fillet or Chamfer.';
}
function renderTools() {
  if (editor) {
    id('mode-pill').textContent = 'SKETCH';
    id('tools').innerHTML =
      [
        ['select', 'Select', 'Select and drag geometry · Esc'],
        ['line', 'Line', 'Draw connected lines · L'],
        ['rectangle', 'Rectangle', 'Draw a rectangle with horizontal and vertical sides · R'],
        ['circle', 'Circle', 'Draw a circle by centre and radius · C'],
        ['arc', 'Arc', 'Draw a counter-clockwise arc: centre, start, end · A'],
        ['point', 'Point', 'Place a sketch point · P'],
      ]
        .map(([a, l, t]) => tool(a, l, t, editor.tool === a))
        .join('') +
      '<span class="tool-divider"></span>' +
      tool(
        'dimension',
        'Dimension',
        'Select geometry, then add a driving or reference dimension · D'
      ) +
      tool(
        'construction',
        'Construct',
        'Toggle construction geometry for selected curves or new geometry · X',
        editor.construction
      ) +
      '<button class="primary finish" data-action="finish" title="Finish this sketch and rebuild the model · Ctrl+Enter">✓ <span>Finish sketch</span></button>';
  } else {
    id('mode-pill').textContent = 'MODEL';
    id('tools').innerHTML =
      tool('sketch', 'Sketch', 'Draw on an origin plane or the selected flat face · S') +
      '<span class="tool-divider"></span>' +
      tool(
        'extrude',
        'Extrude',
        'Give closed sketch areas depth: new body, join, cut or intersect · E'
      ) +
      tool('hole', 'Hole', 'Drill a blind or through hole on a flat face · H') +
      '<span class="tool-divider"></span>' +
      tool('fillet', 'Fillet', 'Round the selected solid edges · F') +
      tool('chamfer', 'Chamfer', 'Bevel the selected solid edges · Shift+F');
  }
  id('undo').disabled = editor ? !editor.canUndo : !store.history.canUndo;
  id('redo').disabled = editor ? !editor.canRedo : !store.history.canRedo;
}
let browserSignature = '';
function renderFeatureActions() {
  const f = featureById(store.state.doc, selectedFeature);
  id('browser-actions').innerHTML = f
    ? `<button data-action="edit-feature" title="Edit ${esc(
        f.name
      )}">Edit</button><button data-action="rename-feature" title="Rename this feature">Rename</button>${
        f.type === 'sketch'
          ? '<button data-action="replane" title="Choose another origin plane or flat face for this sketch">Plane…</button>'
          : ''
      }<button data-action="suppress" title="${
        f.suppressed ? 'Enable' : 'Suppress'
      } this feature without deleting it">${
        f.suppressed ? 'Enable' : 'Suppress'
      }</button><button data-action="rollback" title="Show the model immediately after this feature">Roll here</button><button data-action="delete-feature" title="Delete this feature; references to it will be reported as lost">Delete</button>`
    : '';
}
function renderBrowser() {
  const doc = store.state.doc,
    box = id('browser-content');
  const signature = JSON.stringify(
    editor
      ? [editor.feature, editor.analysis.dof]
      : [doc, store.state.build?.features, store.state.build?.bodies.map((b) => b.id), rolled]
  );
  if (signature === browserSignature) {
    if (editor) {
      for (const row of box.querySelectorAll('[data-cid]'))
        row.classList.toggle('selected', editor.selection.includes(row.dataset.cid));
      const note = box.querySelector('.browser-note');
      if (note)
        note.textContent = editor.selection.length
          ? editor.selection.join(', ') + ' selected'
          : 'Select points or curves. Shift-click adds to your selection.';
    } else {
      for (const row of box.querySelectorAll('[data-feature]'))
        row.classList.toggle('selected', selectedFeature === row.dataset.feature);
      renderFeatureActions();
    }
    return;
  }
  browserSignature = signature;
  if (editor) {
    const s = editor.feature,
      a = editor.analysis;
    box.innerHTML = `<div class="dof ${a.dof === 0 ? 'fully' : ''}"><strong>${
      a.dof === 0 ? '✓' : a.dof
    }</strong><span>${
      a.dof === 0 ? 'Fully constrained' : 'degrees of freedom'
    }</span></div><div class="legend"><span>Free</span><span>Constrained</span></div><div class="group-title">CONSTRAINTS <b>${
      s.constraints.length
    }</b></div><div class="constraint-grid">${Object.entries(constraintNames)
      .map(
        ([type, [symbol, name]]) =>
          `<button data-constraint="${type}" title="${esc(
            name
          )}: select compatible geometry with Shift-click, then apply"><b>${symbol}</b>${name}</button>`
      )
      .join('')}</div><div class="browser-note">${
      editor.selection.length
        ? esc(editor.selection.join(', ')) + ' selected'
        : 'Select points or curves. Shift-click adds to your selection.'
    }</div><div class="tree-section">${s.constraints
      .map(
        (c) =>
          `<div role="button" tabindex="0" class="constraint-row ${
            editor.selection.includes(c.id) ? 'selected' : ''
          }" data-cid="${c.id}" title="${
            DIMENSIONS.includes(c.type)
              ? 'Double-click to edit this dimension'
              : 'Select this constraint; Delete removes it'
          }"><span class="c-id">${c.id}</span><span class="c-name">${esc(
            constraintNames[c.type]?.[1] ??
              {
                distance: 'Distance',
                distancePL: 'Point–line',
                radius: 'Radius',
                diameter: 'Diameter',
                angle: 'Angle',
              }[c.type] ??
              c.type
          )}</span>${
            DIMENSIONS.includes(c.type)
              ? `<span class="c-value">${c.driven ? '(' : ''}${fmt(measure(s, c))}${
                  c.driven ? ')' : ''
                }</span>`
              : ''
          }</div>`
      )
      .join('')}</div><div class="browser-note">${editor.regions.length} closed ${
      editor.regions.length === 1 ? 'area' : 'areas'
    } · ${s.entities.length} entities</div>`;
    id('browser-actions').innerHTML =
      '<button data-action="delete-sketch" title="Delete the selected sketch geometry or constraints · Delete">Delete selected</button><button data-action="discard-sketch" title="Discard all changes made in this sketch session">Discard sketch</button>';
    return;
  }
  const results = store.state.build?.features ?? [],
    bodies = store.state.build?.bodies ?? [];
  box.innerHTML = `<div class="tree-section"><div class="group-title">ORIGIN <button class="eye" data-action="planes" title="Show or hide the three origin planes">◇</button></div>${[
    'XY',
    'XZ',
    'YZ',
  ]
    .map(
      (p) =>
        `<button class="tree-row" data-plane="${p}" title="Create a sketch on the ${p} plane"><span class="feature-symbol">▱</span><span class="tree-name">${p} plane</span></button>`
    )
    .join('')}</div><div class="tree-section"><div class="group-title">BODIES <b>${
    bodies.length
  }</b></div>${
    bodies.length
      ? bodies
          .map(
            (b, i) =>
              `<div class="tree-row"><span class="feature-symbol">⬡</span><button class="tree-name" data-body="${
                b.id
              }" title="Rename this body">${esc(
                doc.bodies[b.id]?.name ?? 'Body ' + (i + 1)
              )}</button><button class="eye" data-visible="${b.id}" title="${
                doc.bodies[b.id]?.hidden ? 'Show' : 'Hide'
              } this body">${doc.bodies[b.id]?.hidden ? '○' : '◉'}</button></div>`
          )
          .join('')
      : '<div class="empty-tree">Your solid bodies will<br>appear here.</div>'
  }</div><div class="group-title">FEATURE HISTORY <b>${doc.features.length}</b></div>${
    doc.features.length
      ? doc.features
          .map((f) => {
            const r = results.find((r) => r.id === f.id);
            return `<button class="tree-row ${selectedFeature === f.id ? 'selected' : ''} ${
              r?.status ?? ''
            }" data-feature="${f.id}" title="${esc(
              r?.message ?? f.name + ' · Double-click to edit'
            )}"><span class="feature-symbol">${
              { sketch: '▱', extrude: '⬡', hole: '⊙', fillet: '◜', chamfer: '◩' }[f.type] ?? '◇'
            }</span><span class="tree-name">${esc(
              f.name
            )}</span><span class="dot"></span></button>`;
          })
          .join('')
      : '<div class="empty-tree">Each step is kept editable.<br>Start with a sketch.</div>'
  }${
    rolled
      ? '<div class="browser-note">History is rolled back.<br><button data-action="end-history" title="Rebuild through the last feature">Return to end</button></div>'
      : ''
  }`;
  renderFeatureActions();
}
let shownError = '';
store.subscribe((state) => {
  id('project-name').textContent = state.doc.meta.name;
  document.title = state.doc.meta.name + ' — CoreCAD';
  id('save-state').textContent = state.saveError
    ? 'Autosave unavailable · Download a copy'
    : state.saved
    ? 'Saved in this browser'
    : 'Local project';
  id('save-state').title = state.saveError || 'Use Save to keep a portable copy of your project.';
  id('welcome').hidden = !!(editor || draft || state.doc.features.length);
  id('status-dot').className = 'status-dot' + (state.busy ? ' busy' : state.error ? ' error' : '');
  id('stop').hidden = !state.busy || !state.kernelReady;
  id('retry').hidden = state.kernelReady && !state.error;
  const failed = state.build?.features.filter((f) => f.status === 'error').length ?? 0;
  id('status').textContent = state.busy
    ? state.progress
      ? `Building ${
          featureById(state.doc, state.progress.featureId)?.name ??
          draft?.feature.name ??
          state.progress.featureId
        }…`
      : 'Loading geometry…'
    : state.error
    ? 'Geometry unavailable · ' + state.error
    : failed
    ? `${failed} feature${failed === 1 ? '' : 's'} need attention`
    : editor
    ? editor.instruction
    : 'Ready';
  id('metrics').textContent =
    state.build && !editor
      ? `${state.build.bodies.length} ${
          state.build.bodies.length === 1 ? 'body' : 'bodies'
        } · ${fmt(
          state.build.bodies.reduce((sum, b) => sum + b.volume, 0),
          1
        )} mm³`
      : '';
  const error = state.error || state.saveError;
  if (error && error !== shownError) {
    shownError = error;
    toast(error);
  }
  if (state.build !== lastBuild) {
    lastBuild = state.build;
    const b = state.build;
    view.setBodies(
      visible(b?.bodies),
      draft?.feature.type === 'extrude' ? b?.tool : null,
      draft && ['fillet', 'chamfer', 'hole'].includes(draft.feature.type)
        ? visible(b?.before ?? b?.bodies)
        : visible(b?.bodies)
    );
    if (fitNext && !state.busy && b?.bodies.length) {
      view.fit();
      fitNext = false;
    }
    if (draft && ['fillet', 'chamfer'].includes(draft.feature.type))
      view.select(
        draft.feature.edges.flatMap((ref) =>
          resolveEdgeRef(ref, view.pickBodies).hits.map((h) => ({
            type: 'edge',
            body: h.body.id,
            edge: h.edge,
          }))
        )
      );
    else view.select(selection);
    refreshFeatureLists();
  }
  renderBrowser();
  renderTools();
  updatePreviewState();
});
function enterSketch(plane, existing = null) {
  if (editor || draft) return;
  const doc = store.state.doc;
  let feature,
    index,
    isNew = !existing;
  if (existing) {
    feature = structuredClone(existing);
    index = doc.features.findIndex((f) => f.id === existing.id);
  } else {
    feature = makeFeature(doc, 'sketch', { plane }).feature;
    index = doc.features.length;
  }
  const frame = existing
    ? sketchFrame(feature)
    : frameOfSketch(feature, store.state.build?.bodies ?? []).frame;
  sketchSession = { base: doc, index, isNew };
  selectedFeature = feature.id;
  selection = [];
  view.select([]);
  view.hover(null);
  rolled = false;
  editor = createEditor(feature, view, {
    change: () => {
      renderTools();
      renderBrowser();
      renderNumbers();
      id('context-note').textContent = editor.instruction;
      id('status').textContent = editor.instruction;
    },
    error: toast,
    dimension: dimensionDialog,
    clearNumbers: () => {
      const a = id('draw-a'),
        b = id('draw-b');
      if (a) a.value = '';
      if (b) b.value = '';
    },
    coordinates: (p) => (id('coordinates').textContent = `X ${fmt(p[0], 2)}   Y ${fmt(p[1], 2)}`),
  });
  view.setFrame(frame, editor.box());
  view.planes(false);
  view.dirty();
  id('welcome').hidden = true;
  id('panel').hidden = true;
  id('context-note').textContent = editor.instruction;
  id('view-help').textContent =
    'Middle / right drag to pan · Scroll to zoom · Ctrl disables snapping';
  renderTools();
  renderBrowser();
  renderNumbers();
  store.preview(doc, { count: index });
}
function finishSketch(discard = false) {
  if (!editor) return;
  const { base, index, isNew } = sketchSession,
    feature = editor.feature;
  editor = null;
  sketchSession = null;
  view.setFrame(null);
  view.standard('home');
  id('sketch-numbers').hidden = true;
  id('coordinates').textContent = '';
  id('context-note').textContent = '';
  id('view-help').innerHTML =
    'Right drag <b>orbit</b><span>·</span>Middle drag <b>pan</b><span>·</span>Scroll <b>zoom</b>';
  id('modal-root').innerHTML = '';
  modal = null;
  if (discard) {
    selectedFeature = null;
    store.cancelPreview();
  } else {
    const doc = isNew ? addFeature(base, feature) : updateFeature(base, feature.id, feature);
    selectedFeature = feature.id;
    fitNext = true;
    store.commit(doc, (isNew ? 'Create ' : 'Edit ') + feature.name);
  }
  renderTools();
  renderBrowser();
  view.dirty();
}
let numbersKind = '';
function renderNumbers() {
  if (!editor) return;
  const show = editor.stage > 0 && ['rectangle', 'circle', 'line', 'arc'].includes(editor.tool);
  id('sketch-numbers').hidden = !show;
  if (!show) {
    numbersKind = '';
    return;
  }
  if (numbersKind === editor.tool) return;
  numbersKind = editor.tool;
  const a = editor.tool === 'rectangle' ? 'Width' : editor.tool === 'line' ? 'Length' : 'Radius',
    b = editor.tool === 'rectangle' ? 'Height' : editor.tool === 'line' ? 'Angle' : null;
  id(
    'sketch-numbers'
  ).innerHTML = `<label>${a}<input id="draw-a" title="${a} in millimetres. Type arithmetic, then Enter to place geometry." placeholder="${a}" autocomplete="off"></label>${
    b
      ? `<label>${b}<input id="draw-b" title="${
          b === 'Angle' ? 'Angle in degrees' : 'Height in millimetres'
        }. Tab switches fields; Enter places geometry." placeholder="${b}" autocomplete="off"></label>`
      : ''
  }<small>Tab to switch · Enter to place</small>`;
  for (const input of id('sketch-numbers').querySelectorAll('input'))
    input.oninput = () => editor?.setNumbers(id('draw-a').value, id('draw-b')?.value ?? '');
}
function closeModal() {
  id('modal-root').innerHTML = '';
  modal = null;
  view.canvas.focus();
}
function showModal(title, body, buttons, handler, wide = false) {
  modal = { handler };
  id(
    'modal-root'
  ).innerHTML = `<div class="modal-backdrop"><section role="dialog" aria-modal="true" aria-label="${esc(
    title
  )}" class="modal ${wide ? 'wide' : ''}">${head(
    title
  )}<div class="panel-body">${body}</div><div class="panel-actions">${buttons}</div></section></div>`;
  setTimeout(() => {
    const input = $('#modal-root input:not([type=checkbox])');
    if (input) {
      input.focus();
      input.select();
    } else $('#modal-root button')?.focus();
  }, 0);
}
const cancelButton =
  '<button data-modal="cancel" title="Cancel and close this dialog · Esc">Cancel</button>';
function textDialog(title, value, onSave) {
  showModal(
    title,
    `<label class="field"><span>Name</span><input id="name-value" title="Enter a name" value="${esc(
      value
    )}"></label>`,
    cancelButton +
      '<button class="primary" data-modal="save" title="Save this name · Enter">Save</button>',
    (action) => {
      if (action === 'save') {
        const value = id('name-value').value.trim();
        if (!value) {
          toast('Enter a name.');
          return;
        }
        onSave(value);
      }
      closeModal();
    }
  );
}
function dimensionDialog(source) {
  if (!editor) return;
  let c = structuredClone(source),
    choices =
      c.type === 'distance'
        ? [
            ['h', 'Horizontal'],
            ['v', 'Vertical'],
            ['aligned', 'Aligned'],
          ]
        : ['radius', 'diameter'].includes(c.type)
        ? [
            ['radius', 'Radius'],
            ['diameter', 'Diameter'],
          ]
        : null;
  showModal(
    c.id ? 'Edit dimension' : 'Add dimension',
    `${
      choices
        ? selectField(
            'dim-mode',
            'Measure',
            choices,
            c.mode ?? c.type,
            'Choose the direction or type of this dimension'
          )
        : ''
    }${field(
      'dim-value',
      'Value',
      fmt(c.value, 6),
      'Driving size. Supports arithmetic such as 60/2 or 12.5.',
      c.type === 'angle' ? '°' : 'mm'
    )}${check(
      'dim-driven',
      'Reference dimension (measured)',
      !!c.driven,
      'A reference dimension displays the measurement without constraining geometry.'
    )}<p>Driving dimensions move the sketch. Existing constraints are preserved.</p>`,
    cancelButton +
      '<button class="primary" data-modal="save" title="Apply this dimension · Enter">Apply</button>',
    (action) => {
      if (action === 'cancel') {
        closeModal();
        return;
      }
      const value = parseNumber(id('dim-value').value),
        driven = id('dim-driven').checked;
      if (value === null || value <= 1e-6) {
        toast('Enter a positive number or arithmetic expression.');
        return;
      }
      if (editor.saveDimension(c, driven ? measure(editor.feature, c) : value, driven))
        closeModal();
    }
  );
  id('dim-mode')?.addEventListener('change', () => {
    const v = id('dim-mode').value;
    if (c.type === 'distance') {
      c.mode = v;
      const ix = new Map(editor.feature.points.map((p) => [p.id, p]));
      ix.set('origin', { x: 0, y: 0 });
      const a = ix.get(c.refs[0]),
        b = ix.get(c.refs[1]);
      c.dir = (v === 'v' ? b.y - a.y : b.x - a.x) >= 0 ? 1 : -1;
      c.label = v === 'v' ? [8, 0] : [0, -8];
    } else c.type = v;
    c.value = measure(editor.feature, c);
    id('dim-value').value = fmt(c.value, 6);
  });
  id('dim-driven').onchange = () => {
    id('dim-value').disabled = id('dim-driven').checked;
  };
  id('dim-value').disabled = !!c.driven;
}
function startSketch() {
  if (editor || draft) return;
  const h = selection.find((h) => h.type === 'face');
  if (h) {
    try {
      const b = view.pickBodies.find((b) => b.id === h.body);
      enterSketch({ kind: 'face', ref: faceRefFrom(b, h.face) });
    } catch (e) {
      toast(e.message);
    }
    return;
  }
  id('panel').hidden = false;
  id('panel').innerHTML =
    head('Choose a sketch plane') +
    '<div class="panel-body"><p>Choose an origin plane, or close this panel and select a flat face on your part.</p>' +
    ['XY', 'XZ', 'YZ']
      .map(
        (p) =>
          `<button class="tree-row" data-plane="${p}" title="Sketch on the ${p} plane">▱ &nbsp; ${p} plane</button>`
      )
      .join('') +
    '</div><div class="panel-actions"><button data-action="close-panel" title="Close plane selection · Esc">Cancel</button></div>';
}
function changePlane(plane) {
  const fid = replaneId;
  replaneId = null;
  id('panel').hidden = true;
  id('context-note').textContent = '';
  rolled = false;
  store.commit(updateFeature(store.state.doc, fid, { plane }), 'Redefine sketch plane');
}
function draftDoc() {
  const { base, feature, index, isNew } = draft;
  return isNew ? addFeature(base, feature) : updateFeature(base, feature.id, feature);
}
function beginFeature(type, existing = null) {
  if (editor || draft) return;
  if (rolled) {
    store.cancelPreview();
    rolled = false;
  }
  const base = store.state.doc;
  let feature = existing ? structuredClone(existing) : makeFeature(base, type).feature;
  if (!existing && type === 'extrude') {
    const s =
      activeSketch() ??
      [...base.features].reverse().find((f) => f.type === 'sketch' && !f.suppressed);
    if (!s) {
      toast('Create a sketch with a closed area first.');
      return;
    }
    const regions = findRegions(s);
    if (!regions.length) {
      toast('This sketch has no closed areas. Close its outline before extruding.');
      selectedFeature = s.id;
      renderBrowser();
      return;
    }
    feature.sketch = s.id;
    feature.profiles = [profileRefFrom(regions[0])];
    if (base.features.some((f) => f.type !== 'sketch')) feature.operation = 'join';
  }
  if (!existing && type === 'hole') {
    const h = selection.find((h) => h.type === 'face');
    if (h) {
      try {
        const b = view.pickBodies.find((b) => b.id === h.body);
        feature.face = faceRefFrom(b, h.face);
        const frame = canonicalFrame(feature.face.hint.n, feature.face.hint.d);
        feature.at = toLocal(frame, h.point ?? b.mesh.faces[h.face].center).slice(0, 2);
      } catch (e) {
        toast(e.message);
        return;
      }
    }
  }
  if (!existing && ['fillet', 'chamfer'].includes(type)) {
    for (const h of selection.filter((h) => h.type === 'edge')) {
      try {
        feature.edges.push(
          edgeRefFrom(
            view.pickBodies.find((b) => b.id === h.body),
            h.edge,
            'k' + ++feature.kseq
          )
        );
      } catch (e) {
        toast(e.message);
      }
    }
  }
  draft = {
    base,
    feature,
    index: existing ? base.features.findIndex((f) => f.id === feature.id) : base.features.length,
    isNew: !existing,
    valid: false,
    paramError: '',
  };
  selectedFeature = existing?.id ?? feature.sketch ?? null;
  selection = [];
  view.select([]);
  view.hover(null);
  id('welcome').hidden = true;
  renderFeaturePanel();
  schedulePreview(0);
  renderBrowser();
  view.dirty();
}
function renderFeaturePanel() {
  if (!draft) return;
  const f = draft.feature;
  let body = '';
  if (f.type === 'extrude') {
    body =
      selectField(
        'feature-sketch',
        'Sketch',
        draft.base.features
          .slice(0, draft.index)
          .filter((s) => s.type === 'sketch')
          .map((s) => [s.id, s.name]),
        f.sketch,
        'Choose the sketch to extrude'
      ) +
      '<h3>CLOSED AREAS</h3><div id="profile-list" class="profile-list"></div>' +
      selectField(
        'feature-operation',
        'Operation',
        [
          ['new', 'New body'],
          ['join', 'Join'],
          ['cut', 'Cut'],
          ['intersect', 'Intersect'],
        ],
        f.operation,
        'New body creates a solid. Join adds material; Cut removes it; Intersect keeps common volume.'
      ) +
      selectField(
        'feature-extent',
        'Direction',
        [
          ['oneSide', 'One side'],
          ['symmetric', 'Symmetric (total)'],
          ['twoSides', 'Two sides'],
        ],
        f.extent.type,
        'Symmetric distance is the total thickness, centred on the sketch plane.'
      ) +
      field(
        'feature-distance',
        'Distance',
        f.extent.distance === 'all' ? '10' : f.extent.distance,
        'Extrusion depth in millimetres; arithmetic is supported.'
      ) +
      `<div id="second-distance" ${f.extent.type !== 'twoSides' ? 'hidden' : ''}>${field(
        'feature-distance2',
        'Opposite distance',
        f.extent.distance2 === 'all' ? '10' : f.extent.distance2 ?? 10,
        'Extrusion depth on the other side of the sketch.'
      )}${check(
        'feature-all2',
        'Through all on opposite side',
        f.extent.distance2 === 'all',
        'Extend past every target in the opposite direction.'
      )}</div>` +
      check(
        'feature-all',
        'Through all',
        f.extent.distance === 'all',
        'For cuts and intersections: extend beyond all target bodies.'
      ) +
      check(
        'feature-flip',
        'Reverse direction',
        f.flip,
        'Reverse the sketch normal. Face cuts usually go into the face.'
      ) +
      '<div id="targets"></div>';
  }
  if (f.type === 'hole')
    body = `<p id="face-prompt">${
      f.face
        ? 'Flat face selected. Click another face or position to move the hole.'
        : 'Click a flat face where the hole should start.'
    }</p><div class="fields">${field(
      'hole-x',
      'Centre X',
      fmt(f.at[0], 4),
      'Horizontal coordinate in the selected face plane.'
    )}${field(
      'hole-y',
      'Centre Y',
      fmt(f.at[1], 4),
      'Vertical coordinate in the selected face plane.'
    )}</div>${field(
      'hole-diameter',
      'Diameter',
      f.diameter,
      'Hole diameter in millimetres.'
    )}${field(
      'hole-depth',
      'Depth',
      f.depth === 'all' ? 10 : f.depth,
      'Blind hole depth into the selected face.'
    )}${check(
      'hole-all',
      'Through all',
      f.depth === 'all',
      'Drill through the entire body, including future upstream size changes.'
    )}`;
  if (['fillet', 'chamfer'].includes(f.type))
    body = `<p>Click edges to add or remove them. Orbit to reach the other side. The preview keeps the original edges available.</p><div id="edge-list" class="edge-list"></div>${field(
      'blend-size',
      f.type === 'fillet' ? 'Radius' : 'Distance',
      f.radius ?? f.distance,
      'Positive size in millimetres. A failed preview keeps the preceding valid solid.'
    )}<button data-action="clear-edges" title="Remove all edges from this feature">Clear edges</button>`;
  id('panel').innerHTML =
    head(f.name, draft.isNew ? 'NEW' : 'EDIT') +
    `<div class="panel-body">${body}<div id="preview-state" class="preview-state">Preparing preview…</div><div id="preview-error" class="panel-error" hidden></div></div><div class="panel-actions"><button data-action="cancel-feature" title="Discard this feature edit · Esc">Cancel</button><button id="apply-feature" class="primary" data-action="apply-feature" title="Apply this feature and rebuild later history" disabled>Apply</button></div>`;
  id('panel').hidden = false;
  for (const input of id('panel').querySelectorAll('input,select'))
    input.addEventListener(
      input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'input',
      readFeatureForm
    );
  refreshFeatureLists();
  updateFields();
}
function refreshFeatureLists() {
  if (!draft) return;
  const f = draft.feature;
  if (f.type === 'extrude') {
    const s = featureById(draft.base, f.sketch),
      rs = s ? findRegions(s) : [];
    id('profile-list').innerHTML = rs
      .map(
        (r, i) =>
          `<button data-region="${i}" class="${
            f.profiles.some((ref) => resolveProfile(rs, ref)?.region === r) ? 'active' : ''
          }" title="Toggle this closed sketch area">${
            f.profiles.some((ref) => resolveProfile(rs, ref)?.region === r) ? '✓' : '○'
          } &nbsp; Area ${i + 1} <span style="float:right">${fmt(r.area, 1)} mm²</span></button>`
      )
      .join('');
    const bs = store.state.build?.before ?? store.state.build?.bodies ?? [];
    id('targets').innerHTML =
      f.operation === 'new'
        ? ''
        : `<h3>TARGET BODIES</h3>${check(
            'targets-all',
            'All bodies',
            f.targets === null,
            'Affect every body reached by this feature.'
          )}${bs
            .map((b, i) =>
              check(
                'target-' + b.id,
                draft.base.bodies[b.id]?.name ?? 'Body ' + (i + 1),
                f.targets === null || f.targets.includes(b.id),
                'Include this body in the extrusion operation.'
              )
            )
            .join('')}`;
    id('targets-all')?.addEventListener('change', () => {
      f.targets = id('targets-all').checked ? null : [];
      refreshFeatureLists();
      schedulePreview();
    });
    bs.forEach((b) =>
      id('target-' + b.id)?.addEventListener('change', () => {
        f.targets = bs.filter((x) => id('target-' + x.id)?.checked).map((x) => x.id);
        id('targets-all').checked = false;
        schedulePreview();
      })
    );
  }
  if (['fillet', 'chamfer'].includes(f.type))
    id('edge-list').innerHTML = f.edges.length
      ? f.edges
          .map(
            (ref, i) =>
              `<button data-remove-edge="${esc(ref.k)}" title="Remove edge ${
                i + 1
              } from this feature"><span>Edge ${i + 1} · ${
                esc(ref.hint.kind)
              }</span><span>×</span></button>`
          )
          .join('')
      : '<p>No edges selected.</p>';
}
function updateFields() {
  if (!draft) return;
  const f = draft.feature;
  if (f.type === 'extrude') {
    const allAllowed = ['cut', 'intersect'].includes(f.operation);
    id('feature-all').disabled = !allAllowed;
    id('feature-all2').disabled = !allAllowed;
    id('feature-distance').disabled = f.extent.distance === 'all';
    id('feature-distance2').disabled = f.extent.distance2 === 'all';
    id('second-distance').hidden = f.extent.type !== 'twoSides';
  }
  if (f.type === 'hole') id('hole-depth').disabled = f.depth === 'all';
}
function readFeatureForm(e) {
  if (!draft) return;
  const f = draft.feature;
  draft.paramError = '';
  const number = (key) => {
    const v = parseNumber(id(key).value);
    if (v === null) draft.paramError = 'Enter a finite number or arithmetic expression.';
    return v;
  };
  if (f.type === 'extrude') {
    if (f.sketch !== id('feature-sketch').value) {
      f.sketch = id('feature-sketch').value;
      f.profiles = findRegions(featureById(draft.base, f.sketch)).slice(0, 1).map(profileRefFrom);
    }
    f.operation = id('feature-operation').value;
    f.flip = id('feature-flip').checked;
    const allowed = ['cut', 'intersect'].includes(f.operation);
    if (!allowed) {
      id('feature-all').checked = false;
      id('feature-all2').checked = false;
    }
    f.extent = {
      type: id('feature-extent').value,
      distance: id('feature-all').checked ? 'all' : number('feature-distance'),
    };
    if (f.extent.type === 'twoSides')
      f.extent.distance2 = id('feature-all2').checked ? 'all' : number('feature-distance2');
  }
  if (f.type === 'hole') {
    f.at = [number('hole-x'), number('hole-y')];
    f.diameter = number('hole-diameter');
    f.depth = id('hole-all').checked ? 'all' : number('hole-depth');
  }
  if (['fillet', 'chamfer'].includes(f.type))
    f[f.type === 'fillet' ? 'radius' : 'distance'] = number('blend-size');
  updateFields();
  if (e?.target?.tagName === 'SELECT') refreshFeatureLists();
  schedulePreview();
  view.dirty();
}
function schedulePreview(delay = 130) {
  clearTimeout(previewTimer);
  if (!draft) return;
  draft.paramError = validateFeature(draft.feature)[0] ?? '';
  draft.valid = false;
  updatePreviewState();
  previewTimer = setTimeout(() => {
    if (!draft) return;
    store.preview(draftDoc(), {
      count: draft.index + 1,
      before: true,
      tool: true,
      tag: JSON.stringify(draft.feature),
    });
  }, delay);
}
function updatePreviewState() {
  if (!draft || !id('apply-feature')) return;
  const fresh = store.state.build?.tag === JSON.stringify(draft.feature),
    r = fresh ? store.state.build?.features.find((f) => f.id === draft.feature.id) : null,
    busy = store.state.busy;
  const message = draft.paramError || (r?.status === 'error' ? r.message : '');
  draft.valid = fresh && !busy && !message && ['ok', 'warning'].includes(r?.status);
  id('apply-feature').disabled = !draft.valid;
  id('preview-error').hidden = !message;
  id('preview-error').textContent = message;
  id('preview-state').textContent =
    busy || (!fresh && !message)
      ? 'Building preview…'
      : r?.status === 'warning'
      ? r.message
      : draft.valid
      ? '✓ Preview ready'
      : 'Choose geometry and valid parameters.';
}
function toggleRegion(r) {
  const rs = findRegions(featureById(draft.base, draft.feature.sketch)),
    i = draft.feature.profiles.findIndex(
      (ref) =>
        resolveProfile(rs, ref)?.region.sides === r.sides &&
        resolveProfile(rs, ref)?.region.key === r.key
    );
  if (i < 0) draft.feature.profiles.push(profileRefFrom(r));
  else draft.feature.profiles.splice(i, 1);
  draft.paramError = '';
  refreshFeatureLists();
  schedulePreview();
  view.dirty();
}
function toggleEdge(hit) {
  const f = draft.feature,
    b = view.pickBodies.find((b) => b.id === hit.body);
  let ref;
  try {
    ref = edgeRefFrom(b, hit.edge, 'k' + (f.kseq + 1));
  } catch (e) {
    toast(e.message);
    return;
  }
  const i = f.edges.findIndex((ref) =>
    resolveEdgeRef(ref, view.pickBodies).hits.some(
      (h) => h.body.id === hit.body && h.edge === hit.edge
    )
  );
  if (i >= 0) f.edges.splice(i, 1);
  else {
    f.kseq++;
    f.edges.push(ref);
  }
  draft.paramError = '';
  refreshFeatureLists();
  schedulePreview();
}
function setHoleFace(hit) {
  try {
    const f = draft.feature,
      b = view.pickBodies.find((b) => b.id === hit.body);
    f.face = faceRefFrom(b, hit.face);
    f.at = toLocal(canonicalFrame(f.face.hint.n, f.face.hint.d), hit.point).slice(0, 2);
    draft.paramError = '';
    id('hole-x').value = fmt(f.at[0], 4);
    id('hole-y').value = fmt(f.at[1], 4);
    id('face-prompt').textContent = 'Flat face selected. Click another position to move the hole.';
    schedulePreview();
  } catch (e) {
    toast(e.message);
  }
}
function endFeature(apply = false) {
  if (!draft) return;
  if (apply && !draft.valid) return;
  clearTimeout(previewTimer);
  const next = apply ? draftDoc() : null,
    label = draft.feature.name;
  selectedFeature = apply ? draft.feature.id : null;
  draft = null;
  id('panel').hidden = true;
  view.hover(null);
  if (apply) {
    fitNext = true;
    store.commit(next, 'Apply ' + label);
  } else store.cancelPreview();
  view.dirty();
  renderBrowser();
}
function editFeature() {
  const f = featureById(store.state.doc, selectedFeature);
  if (!f) return;
  if (f.type === 'sketch') enterSketch(f.plane, f);
  else beginFeature(f.type, f);
}
async function exportFile(format) {
  if (editor || draft) {
    toast('Finish the current edit before exporting.');
    return;
  }
  try {
    toast('Preparing ' + format.toUpperCase() + '…');
    const blob = await store.kernel.export(store.state.doc, { format });
    download(blob, filename(store.state.doc) + '.' + format);
    toast(format.toUpperCase() + ' exported.');
    window.__lastExport = { format, size: blob.size };
  } catch (e) {
    toast(e.message);
  }
}
async function openFile(file) {
  if (!file) return;
  if (editor || draft) {
    toast('Finish or cancel the current edit before opening another project.');
    return;
  }
  try {
    const doc = await readProject(file);
    for (const s of doc.features.filter((f) => f.type === 'sketch')) {
      const solved = solveSketch(s);
      if (!solved.ok) throw Error(`${s.name}: ${solved.message}`);
      Object.assign(s, solved.sketch);
    }
    store.open(doc);
    selectedFeature = null;
    selection = [];
    fitNext = true;
    view.setFrame(null);
    view.standard('home');
    toast('Opened ' + doc.meta.name);
  } catch (e) {
    toast(e.message);
  }
  id('file-input').value = '';
}
const actions = {
  connect: openConnect,
  sketch: startSketch,
  extrude: () => beginFeature('extrude'),
  hole: () => beginFeature('hole'),
  fillet: () => beginFeature('fillet'),
  chamfer: () => beginFeature('chamfer'),
  select: () => editor?.setTool('select'),
  line: () => editor?.setTool('line'),
  rectangle: () => editor?.setTool('rectangle'),
  circle: () => editor?.setTool('circle'),
  arc: () => editor?.setTool('arc'),
  point: () => editor?.setTool('point'),
  dimension: () => editor?.dimension(),
  construction: () => editor?.toggleConstruction(),
  finish: () => finishSketch(),
  'delete-sketch': () => editor?.delete(),
  'discard-sketch': () => finishSketch(true),
  undo: () => {
    if (draft) endFeature();
    else if (editor) editor.undo();
    else store.undo();
  },
  redo: () => (editor ? editor.redo() : !draft && store.redo()),
  'rename-project': () =>
    textDialog('Rename project', store.state.doc.meta.name, (name) =>
      store.commit(
        { ...store.state.doc, meta: { ...store.state.doc.meta, name } },
        'Rename project'
      )
    ),
  new: () => {
    if (editor || draft) {
      toast('Finish or cancel the current edit first.');
      return;
    }
    showModal(
      'New project',
      '<p>Your current project is saved in this browser. Starting a new one replaces that autosave. Download a copy to keep it.</p>',
      cancelButton +
        '<button data-modal="save" title="Download this project, then start a new one">Save & new</button><button class="primary" data-modal="new" title="Start a blank project">New project</button>',
      (a) => {
        if (a === 'cancel') {
          closeModal();
          return;
        }
        if (a === 'save')
          download(projectBlob(store.state.doc), filename(store.state.doc) + '.corecad');
        store.open(createDocument());
        selectedFeature = null;
        selection = [];
        view.select([]);
        view.standard('home');
        view.fit();
        closeModal();
      }
    );
  },
  save: () => {
    if (editor || draft) {
      toast('Finish the current edit to include it in the saved project.');
      return;
    }
    download(projectBlob(store.state.doc), filename(store.state.doc) + '.corecad');
    toast('Project downloaded.');
  },
  open: () => id('file-input').click(),
  'export-menu': () =>
    showModal(
      'Export solids',
      '<p>Export visible bodies. STL is a triangle mesh in millimetres for printing; STEP preserves exact solid geometry.</p>',
      cancelButton +
        '<button data-modal="stl" title="Export a binary STL mesh">STL</button><button class="primary" data-modal="step" title="Export exact solids as STEP">STEP</button>',
      (a) => {
        closeModal();
        if (a !== 'cancel') exportFile(a);
      }
    ),
  fit: () => (editor ? view.fitSketch(editor.box()) : view.fit()),
  projection: () => {
    id('projection').textContent = view.toggleProjection() ? 'Ortho' : 'Perspective';
  },
  'edit-feature': editFeature,
  'rename-feature': () => {
    const f = featureById(store.state.doc, selectedFeature);
    if (f)
      textDialog('Rename feature', f.name, (name) =>
        store.commit(updateFeature(store.state.doc, f.id, { name }), 'Rename feature')
      );
  },
  replane: () => {
    const f = featureById(store.state.doc, selectedFeature);
    if (!f || f.type !== 'sketch') return;
    replaneId = f.id;
    store.preview(store.state.doc, {
      count: store.state.doc.features.findIndex((x) => x.id === f.id),
    });
    id('panel').hidden = false;
    id('panel').innerHTML =
      head('Redefine sketch plane') +
      '<div class="panel-body"><p>Choose an origin plane or click a flat face from earlier history. Sketch coordinates and constraints are preserved.</p>' +
      ['XY', 'XZ', 'YZ']
        .map(
          (p) =>
            `<button class="tree-row" data-plane="${p}" title="Move this sketch to the ${p} plane">▱ &nbsp; ${p} plane</button>`
        )
        .join('') +
      '</div><div class="panel-actions"><button data-action="close-panel" title="Keep the existing sketch plane">Cancel</button></div>';
  },
  suppress: () => {
    const f = featureById(store.state.doc, selectedFeature);
    if (f)
      store.commit(
        updateFeature(store.state.doc, f.id, { suppressed: !f.suppressed }),
        f.suppressed ? 'Enable feature' : 'Suppress feature'
      );
  },
  'delete-feature': () => {
    const f = featureById(store.state.doc, selectedFeature);
    if (!f) return;
    const deps = dependents(store.state.doc, f.id);
    showModal(
      'Delete ' + f.name,
      `<p>${
        deps.length
          ? `${deps.length} later feature(s) refer to this feature. Deleting it will leave those references lost. You can delete dependents too, or restore everything with Undo.`
          : 'Delete this feature? You can restore it with Undo.'
      }</p>`,
      cancelButton +
        (deps.length
          ? '<button data-modal="all" title="Delete this feature and every dependent feature">Delete dependents</button>'
          : '') +
        '<button class="primary" data-modal="delete" title="Delete only this feature">Delete</button>',
      (a) => {
        if (a !== 'cancel') {
          let doc = store.state.doc;
          for (const fid of [f.id, ...(a === 'all' ? deps : [])]) doc = removeFeature(doc, fid);
          selectedFeature = null;
          store.commit(doc, 'Delete ' + f.name);
        }
        closeModal();
      }
    );
  },
  rollback: () => {
    const i = store.state.doc.features.findIndex((f) => f.id === selectedFeature);
    if (i >= 0) {
      rolled = true;
      store.preview(store.state.doc, { count: i + 1 });
    }
  },
  'end-history': () => {
    rolled = false;
    store.cancelPreview();
  },
  'cancel-feature': () => endFeature(false),
  'apply-feature': () => endFeature(true),
  'clear-edges': () => {
    if (draft) {
      draft.feature.edges = [];
      draft.paramError = '';
      refreshFeatureLists();
      schedulePreview();
    }
  },
  'close-panel': () => {
    id('panel').hidden = true;
    if (replaneId) {
      replaneId = null;
      store.cancelPreview();
    }
  },
  stop: () => store.kernel.stop(),
  retry: () => {
    store.clearError();
    store.kernel.retry();
  },
  planes: () => {
    showPlanes = !showPlanes;
    view.planes(showPlanes);
  },
  help: () =>
    showModal(
      'Your parametric workshop',
      '<p>Sketch on a plane, add constraints and dimensions, finish the sketch, then extrude a closed area. Select a flat face for another sketch or a quick hole. Select edges for fillets and chamfers.</p><table>' +
        [
          ['S / E / H', 'Sketch / Extrude / Hole'],
          ['F / Shift+F', 'Fillet / Chamfer'],
          ['L / R / C / A / P', 'Line / Rectangle / Circle / Arc / Point'],
          ['D / X', 'Dimension / Construction'],
          ['Shift-click', 'Add or remove a selection'],
          ['H / V in sketch', 'Horizontal / Vertical constraint'],
          ['Delete', 'Delete selected sketch items'],
          ['Ctrl+Enter', 'Finish sketch'],
          ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'],
          ['Ctrl+S / Ctrl+O', 'Save / Open'],
          ['F6 / Home', 'Fit / Isometric view'],
          ['Right drag', 'Orbit (pan in sketch)'],
          ['Middle / Shift-right drag', 'Pan'],
          ['Scroll', 'Zoom at cursor'],
          ['Esc', 'Cancel tool or dialog'],
        ]
          .map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`)
          .join('') +
        '</table><p>Number fields accept arithmetic, decimals with a dot or comma, and a trailing mm. Blue geometry can move; green geometry is constrained. Dimensions in parentheses are measurements. Double-click history entries to edit them.</p>',
      '<button class="primary" data-modal="close" title="Close help">Got it</button>',
      closeModal,
      true
    ),
};
let showPlanes = true;
document.addEventListener('click', (e) => {
  const target = e.target.closest(
    '[data-action],[data-plane],[data-view],[data-feature],[data-cid],[data-constraint],[data-modal],[data-region],[data-remove-edge],[data-visible],[data-body]'
  );
  if (!target || target.disabled) return;
  const d = target.dataset;
  if (d.modal) {
    modal?.handler(d.modal);
    return;
  }
  if (modal) return;
  if (d.action) {
    if (
      (editor || draft) &&
      [
        'rename-feature',
        'suppress',
        'rollback',
        'delete-feature',
        'edit-feature',
        'rename-project',
        'replane',
      ].includes(d.action)
    ) {
      toast('Finish or cancel the current edit first.');
      return;
    }
    if (replaneId && !['close-panel', 'fit', 'projection', 'planes'].includes(d.action)) {
      toast('Choose a new sketch plane or cancel the plane change first.');
      return;
    }
    actions[d.action]?.();
    return;
  }
  if (d.plane) {
    if (replaneId) changePlane({ kind: 'base', base: d.plane });
    else enterSketch({ kind: 'base', base: d.plane });
    return;
  }
  if (d.view) {
    if (editor) {
      toast('Finish the sketch to change to a model view.');
      return;
    }
    view.standard(d.view);
    return;
  }
  if (d.feature) {
    if (editor || draft) return;
    selectedFeature = d.feature;
    selection = [];
    view.select([]);
    renderBrowser();
    view.dirty();
    const r = store.state.build?.features.find((f) => f.id === d.feature);
    id('context-note').textContent =
      r?.message ?? 'Double-click this feature to edit its parameters.';
    return;
  }
  if (d.cid) {
    editor?.select(d.cid, e.shiftKey);
    return;
  }
  if (d.constraint) {
    editor?.constrain(d.constraint);
    return;
  }
  if (d.region) {
    const rs = findRegions(featureById(draft.base, draft.feature.sketch));
    toggleRegion(rs[Number(d.region)]);
    return;
  }
  if (d.removeEdge) {
    draft.feature.edges = draft.feature.edges.filter((ref) => ref.k !== d.removeEdge);
    draft.paramError = '';
    refreshFeatureLists();
    schedulePreview();
    return;
  }
  if (d.visible) {
    store.commit(
      setBodyProps(store.state.doc, d.visible, {
        hidden: !store.state.doc.bodies[d.visible]?.hidden,
      }),
      'Body visibility'
    );
    return;
  }
  if (d.body)
    textDialog('Rename body', store.state.doc.bodies[d.body]?.name ?? 'Body', (name) =>
      store.commit(setBodyProps(store.state.doc, d.body, { name }), 'Rename body')
    );
});
document.addEventListener('dblclick', (e) => {
  const f = e.target.closest('[data-feature]'),
    c = e.target.closest('[data-cid]');
  if (f && !editor && !draft) {
    selectedFeature = f.dataset.feature;
    editFeature();
  }
  if (c && editor) {
    const con = editor.feature.constraints.find((x) => x.id === c.dataset.cid);
    if (DIMENSIONS.includes(con.type)) dimensionDialog(con);
  }
});
id('more-views').onchange = (e) => {
  if (!editor && e.target.value) view.standard(e.target.value);
  e.target.value = '';
};
id('file-input').onchange = (e) => openFile(e.target.files[0]);
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer.types.includes('Files')) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) {
    e.preventDefault();
    openFile(e.dataTransfer.files[0]);
  }
});
document.addEventListener('keydown', (e) => {
  const input = e.target.matches('input,select,textarea'),
    key = e.key.toLowerCase(),
    ctrl = e.ctrlKey || e.metaKey;
  if (modal) {
    if (key === 'escape') {
      e.preventDefault();
      modal.handler('cancel');
    } else if (key === 'enter' && e.target.tagName !== 'BUTTON') {
      e.preventDefault();
      const b = $('#modal-root .primary');
      if (b) modal.handler(b.dataset.modal);
    }
    return;
  }
  if (ctrl && ['s', 'o', 'z', 'y'].includes(key)) {
    if (input && ['z', 'y'].includes(key)) return;
    e.preventDefault();
    actions[
      key === 's' ? 'save' : key === 'o' ? 'open' : key === 'y' || e.shiftKey ? 'redo' : 'undo'
    ]();
    return;
  }
  if (ctrl && key === 'enter' && editor) {
    e.preventDefault();
    finishSketch();
    return;
  }
  if (key === 'escape') {
    e.preventDefault();
    if (draft) endFeature();
    else if (editor) {
      editor.escape();
      view.canvas.focus();
    } else {
      actions['close-panel']();
      selection = [];
      view.select([]);
    }
    return;
  }
  if (key === 'enter' && editor && editor.stage) {
    e.preventDefault();
    editor.enter();
    view.canvas.focus();
    return;
  }
  if (input) return;
  if (key === 'f6') {
    e.preventDefault();
    actions.fit();
    return;
  }
  if (key === 'home' && !editor) {
    e.preventDefault();
    view.standard('home');
    return;
  }
  if (draft || replaneId) return;
  if (editor) {
    if (/^[0-9.,]$/.test(e.key) && editor.stage && id('draw-a')) {
      e.preventDefault();
      id('draw-a').focus();
      id('draw-a').value = e.key;
      editor.setNumbers(e.key, id('draw-b')?.value ?? '');
      return;
    }
    const action = {
      l: 'line',
      r: 'rectangle',
      c: 'circle',
      a: 'arc',
      p: 'point',
      d: 'dimension',
      x: 'construction',
      delete: 'delete-sketch',
      backspace: 'delete-sketch',
    }[key];
    if (action) {
      e.preventDefault();
      actions[action]();
    }
    if (key === 'h' || key === 'v') {
      e.preventDefault();
      editor.constrain(key === 'h' ? 'horizontal' : 'vertical');
    }
  } else {
    const action = { s: 'sketch', e: 'extrude', h: 'hole', f: e.shiftKey ? 'chamfer' : 'fillet' }[
      key
    ];
    if (action) {
      e.preventDefault();
      actions[action]();
    }
  }
});
renderTools();
renderBrowser();
// The command set for scripts and agents (src/api/commands.js): it changes the model through
// the same store as the controls above, so what it does is undoable, autosaved and shown.
const api = createCommands({
  store,
  view,
  editing: () => !!(editor || draft),
  cancelEdit: () => {
    if (editor) finishSketch(true);
    if (draft) endFeature(false);
  },
  ready: () => {
    if (rolled && !editor && !draft) {
      store.cancelPreview();
      rolled = false;
    }
  },
  shown: (fid) => {
    selectedFeature = fid;
    selection = [];
    view.select([]);
    view.fit();
    renderBrowser();
  },
  download,
  filename,
});
// The bridge to an MCP client (src/api/bridge.js). It connects only when the person chooses to.
// BRIDGE_LIVE: the relay at vibedit.app is deployed (since 2026-11-25). Set it to false if the relay
// is ever taken down: the Connect button is then only shown with ?connect in the address (or ?bridge=
// for a relay on localhost), so nobody meets a dead button.
const BRIDGE_LIVE = true;
const bridgeAsked = ['connect', 'bridge'].some((k) => new URLSearchParams(location.search).has(k));
const bridge = createBridge({
  run: api.run,
  tools: api.tools,
  keySuffix: new URLSearchParams(location.search).has('test') ? '.test' : '',
  onChange: renderBridge,
});
const clock = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function bridgeStatus(b) {
  if (b.status === 'on')
    return b.last
      ? `Connected. Last command: ${b.last.name} at ${clock(b.last.at)} (${b.calls} so far).`
      : b.seenAt
      ? `Connected. An MCP client looked at ${clock(b.seenAt)}.`
      : 'Connected. Waiting for an MCP client.';
  if (b.status === 'connecting') return 'Connecting…';
  if (b.status === 'retrying') return b.note;
  return b.note || 'Not connected.';
}
function connectBody(b) {
  return `<p id="bridge-status" class="bridge-status ${b.status}"><i></i>${esc(bridgeStatus(b))}</p>
    <label class="bridge-address" title="The address of this tab for an MCP client. It works while this tab is connected.">Address for Claude
      <input id="bridge-address" readonly value="${esc(b.address)}" title="Give this address to Claude as a custom connector. Treat it like a password." /></label>
    <ol>
      <li>Choose <b>${b.status === 'off' ? 'Connect' : 'Copy address'}</b> below and keep this tab open.</li>
      <li>In Claude: Settings, Connectors, <b>Add custom connector</b>. Paste the address; no sign-in is needed.</li>
      <li>Ask Claude to build or change something in CoreCAD. You see every change here, and Undo takes it back.</li>
    </ol>
    <p class="bridge-note">While connected, whoever has this address can read and change the model in this tab, and nothing else in your browser. Commands pass through vibedit.app, and Claude sees the model. <b>New address</b> makes the old one useless.</p>`;
}
function openConnect() {
  const b = bridge.state,
    on = b.status !== 'off';
  showModal(
    'Connect to Claude',
    connectBody(b),
    `<button data-modal="renew" title="Make a new address; the old one stops working at once">New address</button><button data-modal="copy" title="Copy the address to the clipboard">Copy address</button><button data-modal="toggle" class="${on ? '' : 'primary'}" title="${
      on ? 'Stop letting an MCP client use this tab' : 'Connect this tab to the bridge, so an MCP client with the address can use it'
    }">${on ? 'Disconnect' : 'Connect'}</button><button data-modal="close" class="${on ? 'primary' : ''}" title="Close this dialog · Esc">Close</button>`,
    (action) => {
      if (action === 'toggle') bridge.state.status === 'off' ? bridge.connect() : bridge.disconnect();
      else if (action === 'renew') bridge.renew();
      else if (action === 'copy')
        navigator.clipboard?.writeText(bridge.state.address).then(
          () => toast('Address copied. Paste it into Claude as a custom connector.'),
          () => toast('Could not copy: select the address and copy it yourself.')
        );
      else closeModal();
    },
    true
  );
  modal.kind = 'connect';
}
function renderBridge(b) {
  const button = id('connect-button');
  if (button) {
    button.hidden = !(BRIDGE_LIVE || bridgeAsked || b.wanted);
    button.className = 'connect-button ' + b.status;
    button.lastChild.textContent = b.status === 'on' ? 'Connected' : 'Connect';
  }
  if (modal?.kind === 'connect') openConnect();
}
renderBridge(bridge.state);
bridge.resume();
// Inspection and coordinate helpers for browser automation, and the commands. The modelling
// tests in tools/e2e.py edit with actual pointer/key events; tools/e2e_api.py uses the commands.
window.corecad = {
  commands: api.commands,
  tools: api.tools,
  run: api.run,
  get bridge() {
    return bridge.state;
  },
  get doc() {
    return structuredClone(store.state.doc);
  },
  get build() {
    return store.state.build;
  },
  get sketch() {
    return editor?.feature ?? null;
  },
  get dof() {
    return editor?.analysis.dof;
  },
  get editing() {
    return !!(editor || draft);
  },
  get busy() {
    return store.state.busy;
  },
  get settled() {
    return !store.state.busy && !previewTimerPending();
  },
  get selection() {
    return structuredClone(editor?.selection ?? selection);
  },
  screen(p) {
    const r = view.canvas.getBoundingClientRect(),
      q = editor ? view.screen(p) : view.project(p);
    return [q[0] + r.left, q[1] + r.top];
  },
  get viewport() {
    return view.view;
  },
  get draft() {
    return draft?.feature ?? null;
  },
  get pickBodies() {
    return view.pickBodies;
  },
  pick(p, filter = 'all') {
    const r = view.canvas.getBoundingClientRect();
    return view.pick(p[0] - r.left, p[1] - r.top, filter);
  },
  get errors() {
    return store.state.error;
  },
};
function previewTimerPending() {
  return !!draft && !draft.valid && !draft.paramError;
}

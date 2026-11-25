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
import {
  partById,
  featuresOf,
  treeOrder,
  worldOf,
  makePart,
  addPart,
  updatePart,
  removePart,
  partDependents,
  setParent,
  copyPart,
  unlinkPart,
  sceneOf,
  contentOf,
  descendantsOf,
  ancestorsOf,
  setPartColor,
  paintFaces,
  appearanceOf,
  childrenOf,
  ungroup,
  containerOf,
} from './doc/parts.js';
import { PALETTE } from './api/colors.js';
import * as Mat from './core/mat.js';
import { gizmoArrows, hitArrow, alongAxis, drawArrows, gizmoRings, hitRing, ringAngle, ringTangent, drawRings } from './view/gizmo.js';
import { sizeOf, spansOf, between, total, boxOf } from './api/measure3d.js';
import { dimensionsOf } from './api/dimensions.js';
import { pill, pillWidth, line as inkLine, inBox, INK } from './view/annotate.js';
import { faceRefFrom, edgeRefFrom, frameOfSketch, resolveEdgeRef } from './doc/refs.js';
import { canonicalFrame, basePlane, toWorld, toLocal } from './core/plane.js';
import { parseNumber, formatNumber as fmt } from './core/num.js';
import { projectBlob, readProject, filename, download } from './persist.js';
import { escapeHTML as esc, icon, tool, field, selectField, check, head } from './ui.js';
import { createCommands } from './api/commands.js';
import { createBridge } from './api/bridge.js';
import { BUILD, published, freshReload } from './update.js';

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
  modelPress = null,
  selectedPart = null, // the part new sketches go into, and whose actions the browser shows
  mover = null, // { id, base, doc, drag, hot }: a part being placed
  pointed = null, // the face or edge the mouse last rested on (a pick, with `when`): what "this" means to a command
  mouse = null, // where the mouse is over the view, or null when it is elsewhere
  restTimer = 0,
  dimLabels = [], // the numbers drawn on the model in the last frame: [{ box, d }]
  drawnNumbers = [], // every value drawn in the last frame: [{ text, kind }]
  dimEdit = null, // { d, input }: a number being typed over
  selectedDim = null, // { feature, key }: the number that was clicked
  numbersFor = null, // the feature that was clicked in the history: its numbers are shown on the model
  hotDim = null, // { feature, key }: the number the mouse is on
  colouring = false, // the Colour panel is open
  quietShown = false; // a change made from the view itself: the camera stays as it is
// Whether sizes are shown where the mouse rests is kept between visits. Dimensions is not: its numbers
// take the clicks that land on them, and a view that was left that way would be a surprise the next day.
const PREF = (name) => 'corecad.' + name + (new URLSearchParams(location.search).has('test') ? '.test' : '');
function pref(name, fallback) {
  try {
    const v = localStorage.getItem(PREF(name));
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}
function setPref(name, on) {
  try {
    localStorage.setItem(PREF(name), on ? '1' : '0');
  } catch {
    /* it is only remembered when it can be */
  }
}
let measureOn = pref('measure', true), // sizes where the mouse rests or clicks
  dimsOn = false; // every driving number of the selected part
const REST_MS = 300; // how long the mouse must stay on something for it to be what the person points at
const collapsed = new Set(); // the parts whose history is folded away in the browser
const PRIMITIVES = ['box', 'cylinder', 'sphere'];
/** The features that have a dialog in the page. The others (revolve) are made by command and changed by their numbers. */
const DIALOGS = ['extrude', 'hole', 'fillet', 'chamfer', 'box', 'cylinder', 'sphere', 'combine'];
const pickFilter = () =>
  ['hole', 'combine'].includes(draft?.feature.type)
    ? 'face'
    : ['fillet', 'chamfer'].includes(draft?.feature.type)
    ? 'edge'
    : 'all';
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
/** Sets an element's content only when it changes: a control that is replaced between the press and
 *  the release of a click (a build finishing just then) would lose that click. */
const htmlNow = new Map();
function setHTML(key, html) {
  if (htmlNow.get(key) === html) return;
  htmlNow.set(key, html);
  id(key).innerHTML = html;
}
function toast(message) {
  id('toast').textContent = message;
  id('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (id('toast').hidden = true), 7000);
}
const view = createViewport(id('viewport'), {
  down: (p, e) => {
    if (editor) editor.down(p, e);
    else if (mover) moveDown(p, e);
    else modelPress = p;
  },
  move: (p, e) => {
    if (editor) editor.move(p, e);
    else if (mover) moveDrag(p, e);
    else {
      // A number on the model is clicked, not what lies under it.
      const label = draft ? null : labelAt(p),
        hit = label ? null : view.pick(...p, pickFilter(), e.altKey),
        cursor = label ? (label.d.edit ? 'pointer' : 'default') : '',
        hot = label ? { feature: label.d.feature, key: label.d.key } : null;
      if (view.canvas.style.cursor !== cursor) view.canvas.style.cursor = cursor;
      if (hot?.feature !== hotDim?.feature || hot?.key !== hotDim?.key) {
        hotDim = hot; // its line is drawn heavier and it says what it is
        view.dirty();
      }
      view.hover(hit);
      // What the mouse comes to rest on is what the person points at; what it only passes over
      // on its way out of the view is not.
      mouse = p;
      clearTimeout(restTimer);
      if (!draft)
        restTimer = setTimeout(() => {
          // Picked again now, not as it was when the mouse stopped: the model may have been rebuilt since.
          const now = mouse && !draft && !mover && !editor ? view.pick(...mouse, pickFilter()) : null;
          if (now) point(now);
        }, REST_MS);
    }
  },
  leave: () => {
    mouse = null;
    clearTimeout(restTimer);
    // With an MCP client connected the thing pointed at stays marked; otherwise nothing is left lit.
    if (!editor && !mover && !draft) view.hover(bridgeOn() ? stillThere(pointed) : null);
  },
  up: (p, e) => {
    if (editor) editor.up();
    else if (mover) moveUp();
    else if (modelPress && Math.hypot(p[0] - modelPress[0], p[1] - modelPress[1]) < 5)
      modelClick(p, e);
    modelPress = null;
  },
  double: (p, e) => editor?.double(p, e),
  cancel: () => (editor ? editor.cancel() : mover && moveUp()),
  error: toast,
  ready: () => {
    window.corecadReady = true;
  },
});
view.overlay((ctx) => {
  if (editor) editor.draw(ctx);
  else {
    drawProfiles(ctx);
    drawNumbers(ctx);
    if (mover) drawGizmo(ctx);
    else if (!draft && bridgeOn()) drawPointed(ctx);
  }
});
// ------------------------------------------------------------------ numbers on the model
const mm = (v) => fmt(v, Math.abs(v) >= 100 ? 1 : 2);
/** A pick as the measuring functions take it: the body as it is shown, and the clicked point in space. */
function asPick(hit) {
  const b = pickedBody(hit);
  return { body: b, kind: hit.type, index: hit.face ?? hit.edge, point: b.matrix ? Mat.point(b.matrix, hit.point) : hit.point };
}
/** The numbers that drive the model and are to be seen: with Dimensions on, all of the selected part and
 *  its tools (of every part, when none is selected); otherwise those of the feature clicked in the history. */
function shownDimensions() {
  if (draft || mover || editor) return [];
  const d = store.state.doc,
    results = store.state.build?.features ?? [],
    built = (f) => ['ok', 'warning'].includes(results.find((r) => r.id === f.id)?.status);
  let features = [];
  if (dimsOn) {
    const used = usedParts(),
      own = partById(d, selectedPart),
      hidden = (pid) => [pid, ...ancestorsOf(d, pid)].some((x) => partById(d, x)?.hidden),
      scope = new Set(
        own ? [own.id, ...descendantsOf(d, own.id).filter((x) => own.group || used.has(x))] : d.parts.filter((p) => !hidden(p.id)).map((p) => p.id)
      );
    features = d.features.filter((f) => scope.has(f.part));
  } else if (numbersFor === selectedFeature) {
    // Only a feature the person clicked in the history: one that was just made is selected too, and its
    // numbers would lie over the very geometry that is clicked next.
    const f = featureById(d, selectedFeature);
    if (f) features = ['extrude', 'revolve'].includes(f.type) ? [featureById(d, f.sketch), f].filter(Boolean) : [f];
  }
  return features.filter(built).flatMap((f) => {
    const sketch = f.type === 'sketch' ? f : ['extrude', 'revolve'].includes(f.type) ? featureById(d, f.sketch) : null;
    return dimensionsOf(f, { frame: sketch ? sketchFrame(sketch) : null, matrix: placementOf(f.part), sketch });
  });
}
const labelAt = (p) => dimLabels.findLast((l) => inBox(l.box, p)) ?? null;
function drawNumbers(ctx) {
  dimLabels = [];
  drawnNumbers = [];
  if (draft || mover) return;
  // Lines first; the values are collected and drawn last, on top, moved off each other where they would overlap.
  const S = (p) => view.project(p),
    driving = [],
    measured = [],
    overall = [];
  const is = (which, d) => which?.feature === d.feature && which.key === d.key;
  for (const d of shownDimensions()) {
    const picked = is(selectedDim, d),
      hot = is(hotDim, d),
      style = d.edit ? INK.driving : INK.reference,
      pts = d.line.map(S);
    // The line a number is the length of; heavier, and named, for the one the mouse is on or that was clicked.
    inkLine(ctx, pts, picked || hot ? INK.measure : style, { ticks: pts.length === 4 ? [1, 2] : [0, 1], width: picked || hot ? 2.2 : 0.9 });
    driving.push({
      text: d.text,
      at: S(d.at),
      style: picked ? INK.chosen : style,
      d,
      caption: hot || picked ? `${d.what} · ${featureById(store.state.doc, d.feature)?.name ?? ''}` : '',
    });
  }
  if (dimsOn) drawOverall(ctx, overall);
  if (measureOn) drawMeasured(ctx, measured);
  const placed = [],
    clash = (box) => placed.some((o) => box.x < o.x + o.w + 2 && o.x < box.x + box.w + 2 && box.y < o.y + o.h + 2 && o.y < box.y + box.h + 2);
  for (const l of [...measured, ...driving, ...overall]) {
    const w = pillWidth(ctx, l.text);
    let y = l.at[1];
    for (const dy of [0, 21, -21, 42, -42, 63, -63, 84]) {
      y = l.at[1] + dy;
      if (!clash({ x: l.at[0] - w / 2, y: y - 9, w, h: 18 })) break;
    }
    if (y !== l.at[1]) inkLine(ctx, [l.at, [l.at[0], y]], l.style === INK.chosen ? INK.driving : l.style, { width: 0.5 });
    const box = pill(ctx, l.text, l.at[0], y, l.style);
    placed.push(box);
    if (l.caption) {
      placed.push(pill(ctx, l.caption, l.at[0], y + 20, INK.reference));
      drawnNumbers.push({ text: l.caption, kind: 'caption' });
    }
    drawnNumbers.push({ text: l.text, kind: Object.keys(INK).find((k) => INK[k] === l.style) });
    if (l.d) dimLabels.push({ box, d: l.d });
  }
}
/** The overall size of the selected part (of everything, when none is): three lines along the box round it. */
function drawOverall(ctx, labels) {
  const d = store.state.doc,
    own = partById(d, selectedPart),
    scope = own ? new Set([own.id, ...descendantsOf(d, own.id)]) : null,
    box = boxOf(sceneFor(store.state.build?.bodies).filter((b) => !scope || scope.has(b.part)));
  if (!box) return;
  const [lo, hi] = box,
    S = (p) => view.project(p),
    c = S([0, 1, 2].map((i) => (lo[i] + hi[i]) / 2));
  for (let axis = 0; axis < 3; axis++) {
    const size = hi[axis] - lo[axis],
      [j, k] = [0, 1, 2].filter((i) => i !== axis);
    if (size < 1e-6) continue;
    // Of the four edges of the box along this axis: the highest on the screen for X and Y, the rightmost
    // for Z. The numbers that drive a part are mostly low and in front, where its sketches lie.
    let best = null;
    for (const vj of [lo[j], hi[j]])
      for (const vk of [lo[k], hi[k]]) {
        const a = [0, 0, 0],
          b = [0, 0, 0];
        a[axis] = lo[axis];
        b[axis] = hi[axis];
        a[j] = b[j] = vj;
        a[k] = b[k] = vk;
        const sa = S(a),
          sb = S(b),
          score = axis === 2 ? sa[0] + sb[0] : -(sa[1] + sb[1]);
        if (!best || score > best.score) best = { sa, sb, score };
      }
    const { sa, sb } = best,
      l = Math.hypot(sb[0] - sa[0], sb[1] - sa[1]);
    if (l < 26) continue; // seen end-on
    // Set off from the box, away from its middle.
    const mid = [(sa[0] + sb[0]) / 2, (sa[1] + sb[1]) / 2];
    let nx = -(sb[1] - sa[1]) / l,
      ny = (sb[0] - sa[0]) / l;
    if ((mid[0] - c[0]) * nx + (mid[1] - c[1]) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const off = (p, o) => [p[0] + nx * o, p[1] + ny * o];
    inkLine(ctx, [sa, off(sa, 29)], INK.reference, { width: 0.6 });
    inkLine(ctx, [sb, off(sb, 29)], INK.reference, { width: 0.6 });
    inkLine(ctx, [off(sa, 24), off(sb, 24)], INK.reference, { ticks: [0, 1] });
    labels.push({ text: `${'XYZ'[axis]} ${mm(size)}`, at: off(mid, 24), style: INK.reference });
  }
}
/** How big what was clicked is, how far apart two clicked things are, and how big what the mouse rests on is.
 *  A size is drawn where it is: each number along the edge or the side it is the length of. */
function drawMeasured(ctx, labels) {
  const S = (p) => view.project(p),
    cam = VM.basis(view.view),
    sel = selection.filter(stillThere).map(asPick);
  /** The numbers of one thing, along its own edges; as one label at `at` when none of them can be seen as a line. */
  const sized = (p, style, at) => {
    let drawn = 0;
    for (const span of spansOf(p.body, p.kind, p.index, cam)) {
      const a = S(span.a),
        b = S(span.b);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 14) continue; // seen end-on
      inkLine(ctx, [a, b], style, { width: 1.8, ticks: [0, 1] });
      labels.push({ text: span.text, at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], style });
      drawn++;
    }
    if (!drawn) labels.push({ text: sizeOf(p.body, p.kind, p.index).text, at, style });
  };
  if (sel.length === 2) {
    const m = between(sel[0], sel[1]),
      real = m.from && m.distance > 1e-7,
      a = S(real ? m.from : sel[0].point),
      b = S(real ? m.to : sel[1].point);
    inkLine(ctx, [a, b], INK.measure, real ? { width: 1.6, ticks: [0, 1] } : { width: 1, dash: [4, 3] });
    labels.push({ text: m.text, at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], style: INK.measure });
    for (const p of sel) {
      const s = S(p.point);
      labels.push({ text: sizeOf(p.body, p.kind, p.index).text, at: [s[0], s[1] - 20], style: INK.measure });
    }
  } else if (sel.length === 1) {
    const s = S(sel[0].point);
    sized(sel[0], INK.measure, [s[0], s[1] - 20]);
  }
  const at = stillThere(pointed),
    same = (h) => h.body === at.body && h.type === at.type && (h.face ?? h.edge) === (at.face ?? at.edge);
  if (at && (mouse || bridgeOn()) && !selection.some(same)) {
    const p = asPick(at),
      s = S(p.point);
    sized(p, INK.pointed, [s[0], s[1] - 22]);
  }
}
/** What the line under the view bar says about the selection: its size, or what lies between two. */
function selectionNote() {
  const sel = selection.filter(stillThere).map(asPick);
  if (!sel.length) return '';
  if (sel.length === 1) {
    const p = sel[0],
      size = sizeOf(p.body, p.kind, p.index).text;
    return p.kind === 'edge'
      ? `Edge · ${size} · Shift-click more edges, then Fillet or Chamfer; a second one gives the distance between them.`
      : p.body.mesh.faces[p.index].plane
      ? `Flat face · ${size} · Sketch or Hole to continue; Shift-click another face or edge to measure between them.`
      : `${size} · Shift-click another face or edge to measure between them.`;
  }
  if (sel.length === 2) {
    const m = between(sel[0], sel[1]);
    return `Between them: ${m.text} (${m.what})` + (m.delta ? ` · ΔX ${mm(Math.abs(m.delta[0]))}  ΔY ${mm(Math.abs(m.delta[1]))}  ΔZ ${mm(Math.abs(m.delta[2]))}` : '');
  }
  return total(sel).text;
}
/** A number on the model was clicked: it is the chosen one, and if it drives the model it can be typed over. */
function editDimension({ box, d }) {
  closeDimEdit();
  selectedDim = { feature: d.feature, key: d.key };
  view.dirty();
  if (!d.edit) {
    toast('This number is measured: it follows the model.');
    return;
  }
  const input = document.createElement('input');
  input.className = 'dim-input';
  input.id = 'dim-input';
  input.value = fmt(d.value, 6);
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.title = `The ${d.what}, in ${d.unit === '°' ? 'degrees' : 'millimetres'}. Type a value or arithmetic: Enter applies it, Esc leaves it.`;
  input.style.left = box.x + box.w / 2 + 'px';
  input.style.top = box.y + box.h / 2 + 'px';
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') applyDimEdit();
    else if (e.key === 'Escape') {
      closeDimEdit();
      view.canvas.focus();
    }
  });
  input.addEventListener('blur', () => dimEdit?.input === input && !dimEdit.busy && closeDimEdit());
  id('viewport').append(input);
  dimEdit = { d, input, busy: false };
  input.focus();
  input.select();
}
function closeDimEdit() {
  const open = dimEdit;
  dimEdit = null;
  open?.input.remove();
}
async function applyDimEdit() {
  const { d, input } = dimEdit,
    value = parseNumber(input.value);
  if (value === null) {
    toast('Enter a number or arithmetic, such as 60/2.');
    return;
  }
  if (Math.abs(value - d.value) < 1e-9) {
    closeDimEdit();
    return;
  }
  // Through the command set: tried first, kept only if the model can be built with it, one undo step.
  dimEdit.busy = true;
  quietShown = true;
  const r = await api.run(d.edit.command, d.edit.args(value));
  quietShown = false;
  if (dimEdit?.input !== input) return;
  dimEdit.busy = false;
  if (r.ok) {
    closeDimEdit();
    view.canvas.focus();
  } else {
    toast(r.error);
    input.focus();
    input.select();
  }
}
function renderToggles() {
  id('dimensions').classList.toggle('on', dimsOn);
  id('measure').classList.toggle('on', measureOn);
}
// ------------------------------------------------------------------ what the person points at
const bridgeOn = () => {
  try {
    return bridge.state.status === 'on';
  } catch {
    return false; // asked before the bridge exists
  }
};
/** A pick, if the face or edge it names is still that one (the body has not been rebuilt or removed). */
function stillThere(hit) {
  if (!hit) return null;
  const b = pickedBody(hit);
  return b && b.key === hit.key ? hit : null;
}
function point(hit) {
  pointed = { ...hit, when: Date.now() };
  view.dirty();
}
/** A ring where the mouse last rested, while an MCP client can ask about it: "here". */
function drawPointed(ctx) {
  const hit = stillThere(pointed);
  if (!hit) return;
  const b = pickedBody(hit),
    s = view.project(b.matrix ? Mat.point(b.matrix, hit.point) : hit.point);
  ctx.beginPath();
  ctx.arc(s[0], s[1], 7, 0, 2 * Math.PI);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.strokeStyle = '#c9772d';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(s[0], s[1], 1.8, 0, 2 * Math.PI);
  ctx.fillStyle = '#c9772d';
  ctx.fill();
}
/** After a rebuild the numbers of faces and edges are new: what was pointed at is found again under the mouse, if it is still there. */
function repoint() {
  pointed = stillThere(pointed);
  if (!mouse || editor || draft || mover) return;
  const hit = view.pick(...mouse, pickFilter());
  view.hover(hit);
  if (hit) point(hit);
}
/** What the person has chosen, for the commands: picks that are still good, with the part each is on. */
function chosen() {
  const d = store.state.doc,
    row = (hit) => {
      const b = pickedBody(hit);
      return {
        kind: hit.type,
        index: hit.face ?? hit.edge,
        body: b.instance ? b.source : b.id,
        part: b.part,
        instance: !!b.instance,
        matrix: b.matrix ?? Mat.IDENTITY,
        point: hit.point,
      };
    },
    at = stillThere(pointed);
  return {
    selected: editor || draft || mover ? [] : selection.filter(stillThere).map(row),
    pointed: at && !editor && !draft && !mover ? { ...row(at), ms: Date.now() - at.when, over: !!mouse } : null,
    part: partById(d, selectedPart) ? selectedPart : null,
    feature: featureById(d, selectedFeature) ? selectedFeature : null,
    dimension: chosenDimension(),
  };
}
/** The number on the model that was clicked, if it is still shown: what it is and how it is changed. */
function chosenDimension() {
  if (!selectedDim) return null;
  const d = shownDimensions().find((x) => x.feature === selectedDim.feature && x.key === selectedDim.key);
  return d && { feature: d.feature, key: d.key, value: d.value, text: d.text, what: d.what, unit: d.unit, change: d.edit ? { command: d.edit.command, args: d.edit.args(d.value) } : null };
}
/** The document that is on screen: with the feature, the sketch's new part or the placement being edited. */
function viewDoc() {
  return mover
    ? mover.doc
    : draft
    ? draftDoc()
    : sketchSession?.newPart
    ? addPart(sketchSession.base, sketchSession.newPart)
    : store.state.doc;
}
const usedParts = () => new Map(Object.entries(store.state.build?.used ?? {}));
/** What is drawn of `bodies`: each where it stands, the selected part marked when there are several. */
function sceneFor(bodies, d = viewDoc()) {
  const mark = !editor && !draft && d.parts.length > 1 ? selectedPart : null;
  return sceneOf(d, bodies ?? [], usedParts()).map((b) => {
    const look = appearanceOf(d, b, b.mesh.faces);
    return { ...b, color: look.color, faceColors: look.faces, ...(b.part === mark ? { chosen: true } : {}) };
  });
}
const placementOf = (partId, d = viewDoc()) => worldOf(d).get(partId) ?? Mat.IDENTITY;
/** The body under a pick, as the view has it (the bodies of a linked copy have ids of their own). */
const pickedBody = (hit) => view.pickBodies.find((b) => b.id === hit.body);
const LINKED = 'This is a linked copy: work on the original, or make the copy independent with Unlink.';
/** A part that is being placed but is not in the picture (a tool that was used up, a hidden part): its solids, drawn faintly. */
function ghostsOf(d, pid, bodies) {
  const used = usedParts();
  if (![pid, ...ancestorsOf(d, pid)].some((x) => partById(d, x)?.hidden || used.has(x))) return [];
  const W = placementOf(pid, d);
  return contentOf(d, pid).flatMap((item) =>
    bodies.filter((b) => b.part === item.from).map((b) => ({ ...b, matrix: Mat.mul(W, item.rel) }))
  );
}
/** Hands the view what the kernel last built, placed by the document that is on screen. */
function refreshScene() {
  const b = store.state.build,
    d = viewDoc(),
    shown = sceneFor(b?.bodies, d),
    type = draft?.feature.type;
  view.setBodies(
    shown,
    ['extrude', 'combine'].includes(type) && b?.tool ? { ...b.tool, matrix: placementOf(b.tool.part, d) } : null,
    ['fillet', 'chamfer', 'hole'].includes(type) ? sceneFor(b?.before ?? b?.bodies, d) : shown,
    mover ? ghostsOf(d, mover.id, b?.bodies ?? []) : []
  );
  view.origin(selectedPart && !editor ? worldOf(d).get(selectedPart) : null);
}
/** The part a new sketch goes into: the selected one, else the newest with a history; null when one must be made. */
function homePart(d = store.state.doc) {
  const p = partById(d, selectedPart);
  if (p?.group) return null; // a group is selected: what is made now is a new part in it
  if (p && !p.link) return p.id;
  return [...d.parts].reverse().find((x) => !x.link && !x.group)?.id ?? null;
}
/** The group a new part goes into: the selected group, or the one the selected part stands in; null for none. */
const container = (d = store.state.doc) => containerOf(d, selectedPart);
function selectPart(pid) {
  selectedPart = pid;
  selectedFeature = null;
  selection = [];
  pointed = null; // a click in the list is newer than what the mouse rested on in the view: "this" is this part now
  view.hover(null);
  view.select([]);
  refreshScene();
  renderBrowser();
  renderColourPanel();
}
// ------------------------------------------------------------------ colours
/** What a colour would be given to: the faces that are selected, else the selected part. */
function colourTarget() {
  const d = store.state.doc,
    faces = selection.filter(stillThere).filter((h) => h.type === 'face'),
    p = partById(d, selectedPart);
  if (faces.length) {
    const owner = partById(d, pickedBody(faces[0]).part);
    return { faces, text: `${faces.length === 1 ? 'the selected face' : `the ${faces.length} selected faces`} of ${owner?.name ?? 'the part'}` };
  }
  return p ? { part: p, text: p.group ? `everything in ${p.name} that has no colour of its own` : `the whole of ${p.name}` } : { text: '' };
}
function renderColourPanel() {
  if (!colouring || editor || draft || mover) return;
  const t = colourTarget();
  let current = t.part?.color ?? '';
  if (t.faces) {
    const b = pickedBody(t.faces[0]);
    current = b.faceColors?.get(t.faces[0].face) ?? '';
  }
  id('panel').innerHTML =
    head('Colour') +
    `<div class="panel-body"><p id="colour-target">${
      t.text ? `For <b>${esc(t.text)}</b>.` : 'Select a part in the list, or click a face in the view.'
    }</p><div class="swatches">${PALETTE.map(
      ([hex, name]) => `<button class="swatch-button${current === hex ? ' on' : ''}" data-colour="${hex}" style="--c:${hex}" title="${name}"></button>`
    ).join('')}</div><label class="field"><span>Another colour</span><input type="color" id="colour-custom" value="${
      current || '#bac8ca'
    }" title="Any colour: choose it here"></label><button data-colour="" title="Take the colour away again">No colour</button><p>Click a face to give it a colour of its own (Shift-click for several); with no face selected the whole part is coloured. Colours go into 3MF and STEP files.</p></div><div class="panel-actions"><button class="primary" data-action="close-panel" title="Close this panel · Esc">Done</button></div>`;
  id('panel').hidden = false;
  id('colour-custom').addEventListener('change', (e) => applyColour(e.target.value));
}
/** Gives the selected faces, or else the selected part, a colour; '' takes it away. */
function applyColour(hex) {
  const t = colourTarget(),
    d = store.state.doc;
  if (t.faces) {
    let next = d;
    for (const h of t.faces) {
      const b = pickedBody(h);
      if (b.instance) {
        toast('The faces of a linked copy are those of its original: colour them there. The copy as a whole can have a colour: select it in the list.');
        return;
      }
      next = paintFaces(next, b.part, [{ body: b.id, labels: b.mesh.faces[h.face].labels }], hex || null);
    }
    store.commit(next, hex ? 'Colour faces' : 'Clear the colour of faces');
  } else if (t.part) store.commit(setPartColor(d, t.part.id, hex || null), (hex ? 'Colour ' : 'Clear the colour of ') + t.part.name);
  else toast('Select a part in the list, or click a face in the view, to give it a colour.');
}
/** Looking back in a feature's own history, for the kernel. inclusive: the feature itself is built. */
function rollTo(d, fid, inclusive) {
  const f = featureById(d, fid);
  return { part: f.part, count: featuresOf(d, f.part).findIndex((x) => x.id === fid) + (inclusive ? 1 : 0) };
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
/** A sketch's frame in space: its own frame, placed with its part. */
function placedFrame(f) {
  const m = placementOf(f.part);
  return Mat.isIdentity(m) ? sketchFrame(f) : Mat.frame(m, sketchFrame(f));
}
function profileData() {
  const s = activeSketch();
  if (!s) return null;
  try {
    return { s, frame: placedFrame(s), regions: findRegions(s) };
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
  const label = draft || replaneId ? null : labelAt(p);
  if (label) {
    editDimension(label);
    return;
  }
  selectedDim = null;
  if (replaneId) {
    const h = view.pick(...p, 'face');
    if (h) {
      try {
        const b = pickedBody(h);
        if (b.instance) throw Error(LINKED);
        if (b.part !== featureById(store.state.doc, replaneId)?.part)
          throw Error('Choose a face of the same part as the sketch.');
        changePlane({ kind: 'face', ref: faceRefFrom(b, h.face) });
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
  const hit = view.pick(...p, pickFilter(), e.altKey);
  if (draft && ['fillet', 'chamfer'].includes(draft.feature.type) && hit?.type === 'edge') {
    toggleEdge(hit);
    return;
  }
  if (draft?.feature.type === 'combine') {
    if (hit) toggleTool(pickedBody(hit).part);
    return;
  }
  if (draft?.feature.type === 'hole' && hit?.type === 'face') {
    setHoleFace(hit);
    return;
  }
  if (!hit) {
    selection = [];
    pointed = null;
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
  const b = pickedBody(hit);
  if (!draft && b.part !== selectedPart) {
    selectedPart = b.part;
    refreshScene();
  }
  view.select(selection);
  view.dirty();
  renderBrowser();
  id('context-note').textContent = selectionNote();
  renderColourPanel();
}
function renderTools() {
  if (editor) {
    id('mode-pill').textContent = 'SKETCH';
    setHTML('tools',
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
      '<button class="primary finish" data-action="finish" title="Finish this sketch and rebuild the model · Ctrl+Enter">✓ <span>Finish sketch</span></button>'
    );
  } else {
    id('mode-pill').textContent = 'MODEL';
    setHTML('tools',
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
      tool('chamfer', 'Chamfer', 'Bevel the selected solid edges · Shift+F') +
      '<span class="tool-divider"></span>' +
      tool('box', 'Box', 'A box as a new part, without a sketch · B') +
      tool('cylinder', 'Cylinder', 'A cylinder as a new part, without a sketch') +
      tool('sphere', 'Sphere', 'A sphere as a new part, without a sketch') +
      '<span class="tool-divider"></span>' +
      tool(
        'combine',
        'Combine',
        'Join other parts to the selected part, cut them out of it, or keep what they share'
      ) +
      tool(
        'move-part',
        'Move',
        'Place the selected part: drag it, type its position and rotation, choose its parent · M'
      ) +
      tool('colour', 'Colour', 'Give the selected faces, or the selected part, a colour') +
      tool('new-part', 'Part', 'Start a new, empty part: the next sketch goes into it') +
      tool('new-group', 'Group', 'A group: a container for parts. It has a place and no shape; it moves, turns, hides and colours what is in it')
    );
  }
  id('undo').disabled = editor ? !editor.canUndo : !store.history.canUndo;
  id('redo').disabled = editor ? !editor.canRedo : !store.history.canRedo;
}
let browserSignature = '';
function renderFeatureActions() {
  const f = featureById(store.state.doc, selectedFeature),
    p = f ? null : partById(store.state.doc, selectedPart);
  if (p) {
    setHTML('browser-actions', `<button data-action="move-part" title="Place ${esc(
      p.name
    )}: position, rotation and parent · M">Move</button><button data-action="copy-part" title="A copy of its own, with its own history, free to change">Copy</button><button data-action="link-part" title="A linked copy: it shows this part in another place and changes with it">Linked copy</button>${
      p.link
        ? '<button data-action="unlink-part" title="Make this linked copy a part of its own, with its own history">Unlink</button>'
        : ''
    }<button data-action="rename-part" title="Rename this part">Rename</button><button data-action="export-part" title="Export this part alone, with what stands under it: 3MF, STL or STEP">Export</button>${
      p.group ? '<button data-action="ungroup" title="Take the group away and leave what is in it where it is">Ungroup</button>' : ''
    }<button data-action="delete-part" title="Delete this part, its history and the parts under it">Delete</button>`);
    return;
  }
  setHTML('browser-actions', f
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
    : '');
}
function renderBrowser() {
  const doc = store.state.doc,
    box = id('browser-content');
  const signature = JSON.stringify(
    editor
      ? [editor.feature, editor.analysis.dof]
      : [
          doc,
          store.state.build?.features,
          store.state.build?.bodies.map((b) => b.id),
          store.state.build?.used,
          rolled,
          selectedPart,
          [...collapsed],
        ]
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
      for (const row of box.querySelectorAll('[data-part]'))
        row.classList.toggle('selected', !selectedFeature && selectedPart === row.dataset.part);
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
    setHTML('browser-actions',
      '<button data-action="delete-sketch" title="Delete the selected sketch geometry or constraints · Delete">Delete selected</button><button data-action="discard-sketch" title="Discard all changes made in this sketch session">Discard sketch</button>'
    );
    return;
  }
  const results = store.state.build?.features ?? [],
    bodies = store.state.build?.bodies ?? [],
    used = usedParts(),
    symbols = { sketch: '▱', extrude: '⬡', revolve: '◔', hole: '⊙', fillet: '◜', chamfer: '◩', box: '▣', cylinder: '◎', sphere: '●', combine: '◐' };
  const featureRow = (f, depth) => {
    const r = results.find((r) => r.id === f.id);
    return `<button class="tree-row ${selectedFeature === f.id ? 'selected' : ''} ${
      r?.status ?? ''
    }" style="--depth:${depth}" data-feature="${f.id}" title="${esc(
      r?.message ?? f.name + ' · Double-click to edit'
    )}"><span class="feature-symbol">${symbols[f.type] ?? '◇'}</span><span class="tree-name">${esc(
      f.name
    )}</span><span class="dot"></span></button>`;
  };
  // Every part with its own history under it; a part's children are indented under it.
  const partRows = treeOrder(doc)
    .filter(({ part: p }) => !ancestorsOf(doc, p.id).some((a) => collapsed.has(a) && partById(doc, a)?.group))
    .map(({ part: p, depth }) => {
      const fs = featuresOf(doc, p.id),
        own = bodies.filter((b) => b.part === p.id),
        open = !collapsed.has(p.id),
        source = p.link ? partById(doc, p.link) : null,
        inside = p.group ? childrenOf(doc, p.id).length : 0;
      const note = p.group
        ? inside
          ? `${inside} ${inside === 1 ? 'part' : 'parts'}`
          : 'empty'
        : used.has(p.id)
        ? used.get(p.id) === p.parent
          ? 'tool'
          : 'tool of ' + (partById(doc, used.get(p.id))?.name ?? 'a part')
        : p.link
        ? source
          ? 'copy of ' + source.name
          : 'original is gone'
        : '';
      return (
        `<div role="button" tabindex="0" draggable="true" class="tree-row part-row ${
          !selectedFeature && selectedPart === p.id ? 'selected' : ''
        } ${used.has(p.id) ? 'used' : ''} ${p.hidden ? 'hidden-part' : ''} ${p.group ? 'group-row' : ''}" style="--depth:${depth}" data-part="${
          p.id
        }" title="${esc(p.name)}${
          used.has(p.id) ? ' (tool of ' + esc(partById(doc, used.get(p.id))?.name ?? 'a part') + ')' : note ? ' (' + esc(note) + ')' : ''
        } · ${
          p.group ? 'A group: click to select, double-click to place it, drag parts onto it to put them in' : 'Click to select, double-click to place it, drag onto another part to put it under that'
        }">${
          fs.length || inside
            ? `<button class="twist" data-twist="${p.id}" title="${open ? 'Fold away' : 'Show'} ${
                p.group ? 'what is in this group' : 'the history of this part'
              }">${open ? '▾' : '▸'}</button>`
            : '<span class="twist"></span>'
        }<span class="feature-symbol">${p.group ? '▤' : p.link ? '⧉' : fs.length ? '⬢' : '▢'}</span><span class="tree-name">${esc(
          p.name
        )}</span>${note ? `<span class="part-note">${esc(note)}</span>` : ''}<button class="swatch" data-part-colour="${
          p.id
        }" style="--c:${p.color ?? 'transparent'}" title="The colour of this part: click to change it"></button><button class="eye" data-part-eye="${
          p.id
        }" title="${p.hidden ? 'Show' : 'Hide'} this part and the parts under it">${
          p.hidden ? '○' : '◉'
        }</button></div>` +
        (open
          ? fs.map((f) => featureRow(f, depth + 1)).join('') +
            (own.length > 1 || own.some((b) => doc.bodies[b.id]?.hidden)
              ? own
                  .map(
                    (b, i) =>
                      `<div class="tree-row body-row" style="--depth:${
                        depth + 1
                      }"><span class="feature-symbol">⬡</span><button class="tree-name" data-body="${
                        b.id
                      }" title="Rename this body">${esc(
                        doc.bodies[b.id]?.name ?? 'Body ' + (i + 1)
                      )}</button><button class="eye" data-visible="${b.id}" title="${
                        doc.bodies[b.id]?.hidden ? 'Show' : 'Hide'
                      } this body">${doc.bodies[b.id]?.hidden ? '○' : '◉'}</button></div>`
                  )
                  .join('')
              : '')
          : '')
      );
    })
    .join('');
  box.innerHTML = `<div class="tree-section"><div class="group-title">ORIGIN <button class="eye" data-action="planes" title="Show or hide the three origin planes">◇</button></div>${[
    'XY',
    'XZ',
    'YZ',
  ]
    .map(
      (p) =>
        `<button class="tree-row" data-plane="${p}" title="Create a sketch on the ${p} plane"><span class="feature-symbol">▱</span><span class="tree-name">${p} plane</span></button>`
    )
    .join('')}</div><div class="group-title">PARTS <b>${
    doc.parts.length
  }</b><button class="eye" data-action="new-part" title="Start a new, empty part: the next sketch goes into it">+</button></div><div class="tree-section">${
    partRows ||
    '<div class="empty-tree">Each part keeps its own<br>editable history.<br>Start with a sketch or a box.</div>'
  }</div>${
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
  if (selectedPart && !partById(viewDoc(), selectedPart)) selectedPart = null;
  id('welcome').hidden = !!(editor || draft || mover || state.doc.features.length || state.doc.parts.length);
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
  const solids = state.build && !editor ? sceneOf(viewDoc(), state.build.bodies, usedParts()) : null;
  id('metrics').textContent = solids
    ? `${solids.length} ${solids.length === 1 ? 'body' : 'bodies'} · ${fmt(
        solids.reduce((sum, b) => sum + b.volume, 0),
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
    refreshScene();
    repoint();
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
  renderColourPanel();
});
function enterSketch(plane, existing = null) {
  if (editor || draft || mover) return;
  colouring = false;
  let doc = store.state.doc,
    feature,
    index,
    partId,
    newPart = null;
  const isNew = !existing;
  if (existing) {
    feature = structuredClone(existing);
    partId = existing.part;
    index = featuresOf(doc, partId).findIndex((f) => f.id === existing.id);
  } else {
    // On a face: the part that face belongs to. On an origin plane: the selected part, or a first part.
    partId = plane.kind === 'face' ? featureById(doc, plane.ref.body)?.part : homePart(doc);
    if (!partId) {
      const made = makePart(doc, { parent: container(doc) });
      doc = made.doc;
      newPart = made.part;
      partId = newPart.id;
    }
    feature = makeFeature(doc, 'sketch', { plane, part: partId }).feature;
    index = featuresOf(doc, partId).length;
  }
  const local = existing
      ? sketchFrame(feature)
      : frameOfSketch(feature, store.state.build?.bodies ?? []).frame,
    frame = Mat.frame(placementOf(partId, newPart ? addPart(doc, newPart) : store.state.doc), local);
  sketchSession = { base: doc, index, isNew, newPart };
  if (!newPart) selectedPart = partId;
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
  store.preview(store.state.doc, { roll: { part: partId, count: index } });
}
function finishSketch(discard = false) {
  if (!editor) return;
  const { base, isNew, newPart } = sketchSession,
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
    const doc = isNew
      ? addFeature(newPart ? addPart(base, newPart) : base, feature)
      : updateFeature(base, feature.id, feature);
    selectedFeature = feature.id;
    selectedPart = feature.part;
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
  if (editor || draft || mover) return;
  colouring = false;
  const h = selection.find((h) => h.type === 'face');
  if (h) {
    try {
      const b = pickedBody(h);
      if (b.instance) throw Error(LINKED);
      enterSketch({ kind: 'face', ref: faceRefFrom(b, h.face) });
    } catch (e) {
      toast(e.message);
    }
    return;
  }
  id('panel').hidden = false;
  id('panel').innerHTML =
    head('Choose a sketch plane') +
    `<div class="panel-body"><p>Choose an origin plane, or close this panel and select a flat face on your part.</p><p>${
      partById(store.state.doc, homePart())
        ? `The sketch goes into <b>${esc(partById(store.state.doc, homePart()).name)}</b>, on its own origin planes.`
        : partById(store.state.doc, container())
        ? `The sketch starts a new part in <b>${esc(partById(store.state.doc, container()).name)}</b>.`
        : 'This starts a new part.'
    }</p>` +
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
  const { base, feature, isNew, newPart } = draft,
    d = newPart ? addPart(base, newPart) : base;
  return isNew ? addFeature(d, feature) : updateFeature(d, feature.id, feature);
}
/** The sketches an extrusion may use: those before it in its part; a new one may take any sketch (and joins its part). */
function sketchChoices() {
  const { base, feature, isNew } = draft;
  if (isNew) return base.features.filter((s) => s.type === 'sketch');
  const own = featuresOf(base, feature.part);
  return own.slice(0, own.findIndex((f) => f.id === feature.id)).filter((s) => s.type === 'sketch');
}
/** The parts a combine feature may take: not its own part, not what that stands under, not what another feature used up. */
function toolChoices(d, feature) {
  const no = new Set([feature.part, ...ancestorsOf(d, feature.part)]);
  for (const f of d.features)
    if (f.type === 'combine' && !f.suppressed && !f.keep && f.id !== feature.id) for (const t of f.tools ?? []) no.add(t);
  return d.parts.filter((p) => !no.has(p.id)).map((p) => p.id);
}
function beginFeature(type, existing = null) {
  if (editor || draft || mover) return;
  colouring = false;
  if (rolled) {
    store.cancelPreview();
    rolled = false;
  }
  let base = store.state.doc,
    newPart = null,
    feature;
  const bodyOf = (h) => {
    const b = pickedBody(h);
    if (b?.instance) throw Error(LINKED);
    return b;
  };
  if (existing) feature = structuredClone(existing);
  else if (PRIMITIVES.includes(type)) {
    // A primitive starts a part of its own, named after it.
    const made = makePart(base, { base: type[0].toUpperCase() + type.slice(1), parent: container(base) });
    base = made.doc;
    newPart = made.part;
    feature = makeFeature(base, type, { part: newPart.id }).feature;
  } else feature = makeFeature(base, type).feature;
  if (!existing && type === 'extrude') {
    const usable = (f) => f.type === 'sketch' && !f.suppressed;
    const s =
      activeSketch() ??
      [...featuresOf(base, homePart(base))].reverse().find(usable) ??
      [...base.features].reverse().find(usable);
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
    feature.part = s.part;
    feature.profiles = [profileRefFrom(regions[0])];
    if (featuresOf(base, s.part).some((f) => f.type !== 'sketch')) feature.operation = 'join';
  }
  if (!existing && type === 'hole') {
    const h = selection.find((h) => h.type === 'face');
    if (h) {
      try {
        const b = bodyOf(h);
        feature.face = faceRefFrom(b, h.face);
        feature.part = b.part;
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
        const b = bodyOf(h);
        if (feature.part && b.part !== feature.part)
          throw Error('The edges of one fillet or chamfer are all on one part.');
        const ref = edgeRefFrom(b, h.edge, 'k' + (feature.kseq + 1));
        feature.kseq++;
        feature.part = b.part;
        feature.edges.push(ref);
      } catch (e) {
        toast(e.message);
      }
    }
  }
  if (!existing && type === 'combine') {
    // The part picked first is the one that is changed; the others picked with it are what it is combined with.
    const picked = [...new Set(selection.map((h) => pickedBody(h)?.part).filter(Boolean))],
      target = partById(base, picked[0]) ?? partById(base, selectedPart) ?? partById(base, homePart(base));
    if (!target || target.link || target.group || base.parts.length < 2) {
      toast(
        target?.link
          ? LINKED
          : target?.group
          ? 'A group has no shape of its own to change: select the part that the others are to be joined to or cut out of.'
          : 'Combine needs two parts: one to change, and another to join to it or cut out of it. Make one with Box, Cylinder or Sphere.'
      );
      return;
    }
    feature.part = target.id;
    feature.tools = picked.slice(1).filter((t) => toolChoices(base, feature).includes(t));
  }
  draft = { base, feature, isNew: !existing, valid: false, paramError: '', newPart };
  selectedFeature = existing?.id ?? feature.sketch ?? null;
  selection = [];
  view.select([]);
  view.hover(null);
  id('welcome').hidden = true;
  renderFeaturePanel();
  schedulePreview(0);
  renderBrowser();
  refreshScene();
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
        sketchChoices().map((s) => [
          s.id,
          draft.isNew && draft.base.parts.length > 1 ? `${partById(draft.base, s.part)?.name ?? ''} · ${s.name}` : s.name,
        ]),
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
  if (PRIMITIVES.includes(f.type)) {
    const origin = (options) =>
      selectField(
        'prim-origin',
        'Origin at',
        options,
        f.origin,
        'Which point of the solid is the origin of its part: the point its position places.'
      );
    body =
      f.type === 'box'
        ? `<div class="fields">${field('box-x', 'Width X', fmt(f.size[0], 4), 'Size along X in millimetres.')}${field(
            'box-y',
            'Depth Y',
            fmt(f.size[1], 4),
            'Size along Y in millimetres.'
          )}${field('box-z', 'Height Z', fmt(f.size[2], 4), 'Size along Z in millimetres.')}</div>${origin([
            ['base', 'Middle of the bottom'],
            ['center', 'Centre'],
            ['corner', 'Lowest corner'],
          ])}`
        : f.type === 'cylinder'
        ? `<div class="fields">${field('cyl-d', 'Diameter', fmt(f.diameter, 4), 'Diameter in millimetres.')}${field(
            'cyl-h',
            'Height',
            fmt(f.height, 4),
            'Height along Z in millimetres.'
          )}</div>${origin([
            ['base', 'Middle of the bottom'],
            ['center', 'Centre'],
          ])}`
        : `${field('sph-d', 'Diameter', fmt(f.diameter, 4), 'Diameter in millimetres.')}${origin([
            ['base', 'Lowest point'],
            ['center', 'Centre'],
          ])}`;
    if (draft.newPart)
      body += `<h3>POSITION</h3><div class="fields">${['X', 'Y', 'Z']
        .map((a, i) =>
          field('prim-p' + a.toLowerCase(), a, fmt(draft.newPart.pos[i], 4), `Where the origin of the new part is placed, along ${a}.`)
        )
        .join('')}</div><p>It becomes a part of its own. Turn it, move it under another part or copy it with Move; join it to another part or cut it out of one with Combine.</p>`;
    else body += '<p>Place this part with Move.</p>';
  }
  if (f.type === 'combine')
    body = `<p><b>${esc(
      partById(draft.base, f.part)?.name ?? 'This part'
    )}</b> is changed. Click the other parts in the view, or tick them here.</p>${selectField(
      'combine-op',
      'Operation',
      [
        ['join', 'Join: add them'],
        ['cut', 'Cut: take them away'],
        ['intersect', 'Intersect: keep what they share'],
      ],
      f.operation,
      'Join adds the other parts to this one; Cut removes them from it; Intersect keeps the common volume.'
    )}<h3>WITH</h3><div id="tool-list" class="tool-list"></div>${check(
      'combine-keep',
      'Keep the other parts as they are',
      !!f.keep,
      'Otherwise they become tools of this part: hidden, placed under it, and still there to edit or move.'
    )}`;
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
    const bs = (store.state.build?.before ?? store.state.build?.bodies ?? []).filter((b) => b.part === f.part);
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
  if (f.type === 'combine') {
    const choices = toolChoices(draft.base, f);
    id('tool-list').innerHTML = choices.length
      ? choices
          .map((t) => check('tool-' + t, partById(draft.base, t).name, f.tools.includes(t), 'Combine with this part.'))
          .join('')
      : '<p>There is no other part to combine with.</p>';
    for (const t of choices) id('tool-' + t).addEventListener('change', () => toggleTool(t, id('tool-' + t).checked));
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
      f.part = featureById(draft.base, f.sketch).part;
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
  if (f.type === 'box') f.size = [number('box-x'), number('box-y'), number('box-z')];
  if (f.type === 'cylinder') {
    f.diameter = number('cyl-d');
    f.height = number('cyl-h');
  }
  if (f.type === 'sphere') f.diameter = number('sph-d');
  if (PRIMITIVES.includes(f.type)) {
    f.origin = id('prim-origin').value;
    if (draft.newPart) {
      const pos = ['prim-px', 'prim-py', 'prim-pz'].map((k) => parseNumber(id(k).value));
      if (!pos.includes(null)) draft.newPart = { ...draft.newPart, pos };
    }
  }
  if (f.type === 'combine') {
    f.operation = id('combine-op').value;
    f.keep = id('combine-keep').checked;
  }
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
    const own = featuresOf(draft.base, draft.feature.part),
      at = draft.isNew ? own.length : own.findIndex((f) => f.id === draft.feature.id);
    store.preview(draftDoc(), {
      roll: { part: draft.feature.part, count: at + 1 },
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
function toggleTool(t, on = !draft.feature.tools.includes(t)) {
  const f = draft.feature;
  if (!toolChoices(draft.base, f).includes(t)) {
    if (t !== f.part) toast('That part cannot be combined with this one.');
    return;
  }
  f.tools = on ? [...new Set([...f.tools, t])] : f.tools.filter((x) => x !== t);
  draft.paramError = '';
  refreshFeatureLists();
  schedulePreview();
}
function toggleEdge(hit) {
  const f = draft.feature,
    b = pickedBody(hit);
  let ref;
  try {
    if (b.instance) throw Error(LINKED);
    if (f.part && b.part !== f.part && (f.edges.length || !draft.isNew))
      throw Error('The edges of one fillet or chamfer are all on one part.');
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
    f.part = b.part;
  }
  draft.paramError = '';
  refreshFeatureLists();
  schedulePreview();
}
function setHoleFace(hit) {
  try {
    const f = draft.feature,
      b = pickedBody(hit);
    if (b.instance) throw Error(LINKED);
    if (!draft.isNew && b.part !== f.part) throw Error('This hole belongs to another part. Make a new hole there.');
    f.face = faceRefFrom(b, hit.face);
    f.part = b.part;
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
  const feature = draft.feature,
    label = feature.name;
  let next = apply ? draftDoc() : null;
  // The parts a combine uses up become its tools: from then on they stand under the part and move with it.
  if (next && feature.type === 'combine' && !feature.keep)
    for (const t of feature.tools)
      if (!ancestorsOf(next, t).includes(feature.part)) next = setParent(next, t, feature.part);
  selectedFeature = apply ? feature.id : null;
  if (apply) selectedPart = feature.part;
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
  else if (!DIALOGS.includes(f.type)) {
    // Made and changed by command; a person changes its numbers where they stand on the model.
    numbersFor = f.id;
    view.dirty();
    toast(`${f.name} has no dialog. Its numbers are on the model: click one to change it.`);
  } else beginFeature(f.type, f);
}
/** only: the id of the one part to export (with what stands under it), or nothing for everything. */
async function exportFile(format, only = null) {
  if (editor || draft || mover) {
    toast('Finish the current edit before exporting.');
    return;
  }
  try {
    toast('Preparing ' + format.toUpperCase() + '…');
    const d = store.state.doc,
      part = only ? partById(d, only) : null,
      blob = await store.kernel.export(d, { format, split: true, ...(part ? { parts: [part.id] } : {}) }),
      // several parts as STL come as a zip of one file each
      zipped = format === 'stl' && new Uint8Array(await blob.slice(0, 2).arrayBuffer()).join() === '80,75',
      name = filename(part ? { meta: { name: `${d.meta.name} - ${part.name}` } } : d) + (zipped ? ' STL.zip' : '.' + format);
    download(blob, name);
    toast(zipped ? 'One STL for each part, in a .zip. For one file with every part as its own object, use 3MF.' : format.toUpperCase() + ' exported.');
    window.__lastExport = { format, size: blob.size, name };
  } catch (e) {
    toast(e.message);
  }
}
async function openFile(file) {
  if (!file) return;
  if (editor || draft || mover) {
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
    selectedPart = null;
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
// ------------------------------------------------------------------ placing a part
function startMove(pid) {
  if (editor || draft || mover) return;
  colouring = false;
  const d = store.state.doc,
    p = partById(d, pid);
  if (!p) {
    toast('Select a part to move: click it in the list or in the view.');
    return;
  }
  if (rolled) {
    store.cancelPreview();
    rolled = false;
  }
  mover = { id: p.id, base: d, doc: d, drag: null, hot: null, angle: 90 };
  selectedPart = p.id;
  selectedFeature = null;
  selection = [];
  view.select([]);
  view.hover(null);
  id('welcome').hidden = true;
  renderMovePanel();
  refreshScene();
  renderBrowser();
}
function renderMovePanel() {
  const d = mover.doc,
    p = partById(d, mover.id),
    parent = partById(d, p.parent),
    under = new Set([p.id, ...descendantsOf(d, p.id)]);
  id('panel').innerHTML =
    head(p.name, 'MOVE') +
    `<div class="panel-body"><p>Drag an arrow to move it, a ring to turn it. It moves in steps of 1 mm and turns in steps of 15°; Shift turns by single degrees, Ctrl lets go of the steps.</p><h3>POSITION${
      parent ? ' IN ' + esc(parent.name.toUpperCase()) : ''
    }</h3><div class="fields">${['x', 'y', 'z']
      .map((a, i) => field('move-' + a, a.toUpperCase(), fmt(p.pos[i], 4), `Where the origin of the part is, along ${a.toUpperCase()}${parent ? ' of its parent' : ''}.`))
      .join('')}</div><h3>TURN</h3><div class="turn-row">${field(
      'move-angle',
      'By',
      fmt(mover.angle, 4),
      'How far the three buttons turn the part, in degrees. A negative angle turns the other way.',
      '°'
    )}<div class="turns">${['X', 'Y', 'Z']
      .map((a, i) => `<button data-turn="${i}" title="Turn the part by this angle about ${a}, round its middle: it turns on the spot">about ${a}</button>`)
      .join('')}</div></div><p class="turned"><span id="move-rot" title="How the part is turned now, as angles about X, then Y, then Z. Turn it with the rings or the buttons: each always turns about its own axis.">${turnedText(
      p.rot
    )}</span><button data-action="upright" title="Take every turn away again: the part stands as it was made, in the same place">Upright</button></p>${selectField(
      'move-parent',
      'Parent',
      [['', 'None: it stands on its own'], ...d.parts.filter((x) => !under.has(x.id)).map((x) => [x.id, x.name])],
      p.parent ?? '',
      'The part this one stands under and moves with. Changing it leaves the part where it is.'
    )}</div><div class="panel-actions"><button data-action="cancel-move" title="Put the part back · Esc">Cancel</button><button id="apply-move" class="primary" data-action="apply-move" title="Keep this placement">Apply</button></div>`;
  id('panel').hidden = false;
  for (const input of id('panel').querySelectorAll('input,select'))
    input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', readMoveForm);
}
const MOVE_FIELDS = ['move-x', 'move-y', 'move-z'];
const turnedText = (rot) => (rot.some((v) => Math.abs(v) > 1e-9) ? `Turned X ${fmt(rot[0], 2)}° · Y ${fmt(rot[1], 2)}° · Z ${fmt(rot[2], 2)}°` : 'Not turned');
function fillMoveForm() {
  const p = partById(mover.doc, mover.id);
  MOVE_FIELDS.forEach((k, i) => (id(k).value = fmt(p.pos[i], 4)));
  id('move-rot').textContent = turnedText(p.rot);
  id('apply-move').disabled = false;
}
function readMoveForm(e) {
  if (!mover) return;
  if (e?.target?.id === 'move-parent') {
    try {
      mover.doc = setParent(mover.doc, mover.id, id('move-parent').value || null);
    } catch (error) {
      toast(error.message);
    }
    renderMovePanel(); // the numbers are now given in the new parent
  } else if (e?.target?.id === 'move-angle') {
    const angle = parseNumber(id('move-angle').value);
    if (angle !== null) mover.angle = angle; // how far the buttons turn; nothing moves yet
    return;
  } else {
    const values = MOVE_FIELDS.map((k) => parseNumber(id(k).value));
    id('apply-move').disabled = values.includes(null);
    if (values.includes(null)) return;
    mover.doc = updatePart(mover.doc, mover.id, { pos: values });
  }
  moved();
}
/** The placement being edited changed: show it at once. The kernel is asked only when a combine depends on where parts stand. */
function moved() {
  refreshScene();
  view.dirty();
  clearTimeout(previewTimer);
  if (mover.doc.features.some((f) => f.type === 'combine' && !f.suppressed))
    previewTimer = setTimeout(() => mover && store.preview(mover.doc, { tag: 'move' }), 130);
}
/** The middle of what the part being placed shows (its origin when it shows nothing), and the axes of its parent.
 *  While a ring is dragged the middle is where it was when the drag began: that is what the part turns about. */
function moveFrame() {
  const d = mover.doc,
    p = partById(d, mover.id),
    W = placementOf(p.id, d),
    parentW = p.parent ? placementOf(p.parent, d) : Mat.IDENTITY,
    bodies = store.state.build?.bodies ?? [];
  const boxesOf = (pid) => contentOf(d, pid).flatMap((item) => bodies.filter((b) => b.part === item.from).map((b) => Mat.box(Mat.mul(W, item.rel), b.bbox)));
  let boxes = boxesOf(p.id);
  // A copy that the kernel has not built yet has the shape of its original: the arrows and rings
  // stand where they will stand, and do not jump when the copy arrives.
  if (!boxes.length && mover.like) boxes = boxesOf(mover.like);
  const anchor =
    mover.drag?.kind === 'ring'
      ? mover.drag.anchor
      : boxes.length
      ? [0, 1, 2].map((i) => (Math.min(...boxes.map((b) => b[0][i])) + Math.max(...boxes.map((b) => b[1][i]))) / 2)
      : Mat.point(W, [0, 0, 0]);
  return { anchor, parentW, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((a) => Mat.dir(parentW, a)) };
}
function moveArrows() {
  const f = moveFrame();
  return gizmoArrows(view.view, view.vp, f.anchor, f.axes);
}
function moveRings() {
  const f = moveFrame();
  return gizmoRings(view.view, view.vp, f.anchor, f.axes);
}
/** The arrows and the rings, the one in hand heavier; a turn in progress says how far it has gone. */
function drawGizmo(ctx) {
  const hot = mover.drag ?? mover.hot,
    g = mover.drag?.kind === 'ring' ? mover.drag : null;
  drawRings(ctx, moveRings(), hot?.kind === 'ring' ? hot.axis : -1, g ? { axis: g.axis, from: g.grab, to: g.grab + (g.degrees * Math.PI) / 180 } : null);
  drawArrows(ctx, moveArrows(), hot?.kind === 'arrow' ? hot.axis : -1);
  if (g) pill(ctx, `${fmt(g.degrees, 1)}°`, g.at[0], g.at[1] - 26, INK.measure);
}
/** What of the gizmo is under a pixel: an arrow before a ring. */
function gizmoAt(p) {
  const axis = hitArrow(moveArrows(), p[0], p[1]);
  if (axis >= 0) return { kind: 'arrow', axis };
  const ring = hitRing(moveRings(), p[0], p[1]);
  return ring ? { kind: 'ring', axis: ring.axis, t: ring.t } : null;
}
function moveDown(p, e) {
  if (e.button !== 0) return;
  const f = moveFrame(),
    hit = gizmoAt(p),
    part = partById(mover.doc, mover.id);
  if (!hit) return;
  if (hit.kind === 'arrow') {
    const s0 = alongAxis(view.view, view.vp, f.anchor, f.axes[hit.axis], p[0], p[1]);
    if (s0 !== null) mover.drag = { kind: 'arrow', axis: hit.axis, s0, anchor: f.anchor, dir: f.axes[hit.axis], pos: [...part.pos] };
    return;
  }
  // A ring: the part turns about that axis of its parent, round its middle. Where the ring is seen
  // squarely the turn follows the mouse round it; seen edge-on, it follows the mouse along it.
  const ring = gizmoRings(view.view, view.vp, f.anchor, f.axes)[hit.axis],
    a0 = ringAngle(view.view, view.vp, ring, f.anchor, p[0], p[1]);
  mover.drag = {
    kind: 'ring',
    axis: hit.axis,
    ring,
    anchor: f.anchor,
    grab: hit.t,
    last: a0,
    tangent: a0 === null ? ringTangent(view.view, view.vp, ring, f.anchor, hit.t) : null,
    radiusPx: ring.radius / view.mmPerPx,
    down: p,
    at: p,
    turned: 0,
    degrees: 0,
    local: Mat.fromPlacement(part.pos, part.rot),
    pivot: Mat.point(Mat.invert(f.parentW), f.anchor),
  };
  view.dirty();
}
function moveDrag(p, e) {
  const g = mover.drag;
  if (!g) {
    const hot = gizmoAt(p);
    if (hot?.kind !== mover.hot?.kind || hot?.axis !== mover.hot?.axis) {
      mover.hot = hot;
      view.canvas.style.cursor = hot ? 'grab' : '';
      view.dirty();
    }
    return;
  }
  if (g.kind === 'arrow') {
    const s = alongAxis(view.view, view.vp, g.anchor, g.dir, p[0], p[1]);
    if (s === null) return;
    const next = [...g.pos],
      value = g.pos[g.axis] + s - g.s0;
    next[g.axis] = e.ctrlKey ? +value.toFixed(3) : Math.round(value);
    mover.doc = updatePart(mover.doc, mover.id, { pos: next });
  } else {
    if (g.tangent) g.turned = ((p[0] - g.down[0]) * g.tangent[0] + (p[1] - g.down[1]) * g.tangent[1]) / g.radiusPx;
    else {
      const a = ringAngle(view.view, view.vp, g.ring, g.anchor, p[0], p[1]);
      if (a === null) return;
      let d = a - g.last;
      d -= 2 * Math.PI * Math.round(d / (2 * Math.PI)); // the short way round, so that a turn can go past half a circle
      g.turned += d;
      g.last = a;
    }
    const step = e.ctrlKey ? 0.1 : e.shiftKey ? 1 : 15;
    g.degrees = +(Math.round(((g.turned * 180) / Math.PI) / step) * step).toFixed(1);
    g.at = p;
    // always from where the part stood when the ring was taken hold of: nothing adds up
    mover.doc = updatePart(mover.doc, mover.id, Mat.toPlacement(Mat.mul(Mat.turn([0, 1, 2].map((i) => +(i === g.axis)), g.degrees, g.pivot), g.local)));
  }
  fillMoveForm();
  moved();
}
function moveUp() {
  if (!mover) return;
  mover.drag = null;
  view.dirty();
}
/** A turn about an axis of the parent, through the middle of the part (so it turns on the spot). */
function turnBy(axis, degrees) {
  const p = partById(mover.doc, mover.id),
    f = moveFrame(),
    pivot = Mat.point(Mat.invert(f.parentW), f.anchor),
    local = Mat.mul(Mat.turn([0, 1, 2].map((i) => +(i === axis)), degrees, pivot), Mat.fromPlacement(p.pos, p.rot));
  mover.doc = updatePart(mover.doc, mover.id, Mat.toPlacement(local));
  fillMoveForm();
  moved();
}
/** Takes every turn away: the part stands as it was made, with its middle where it is. */
function upright() {
  const p = partById(mover.doc, mover.id),
    f = moveFrame(),
    local = Mat.fromPlacement(p.pos, p.rot),
    middle = Mat.point(Mat.invert(f.parentW), f.anchor), // in the parent
    own = Mat.point(Mat.invert(local), middle); // the same point in the part itself
  mover.doc = updatePart(mover.doc, mover.id, Mat.toPlacement(Mat.shift([middle[0] - own[0], middle[1] - own[1], middle[2] - own[2]])));
  fillMoveForm();
  moved();
}
function endMove(apply) {
  if (!mover) return;
  clearTimeout(previewTimer);
  const { base, doc: next, id: pid } = mover,
    name = partById(next, pid)?.name ?? 'part';
  mover = null;
  id('panel').hidden = true;
  view.canvas.style.cursor = '';
  if (apply && next !== base) store.commit(next, 'Move ' + name);
  else store.cancelPreview();
  refreshScene();
  view.dirty();
  renderBrowser();
}
function duplicatePart(linked) {
  const p = partById(store.state.doc, selectedPart);
  if (!p) return;
  try {
    const c = copyPart(store.state.doc, p.id, { linked });
    selectedFeature = null;
    selectedPart = c.id;
    store.commit(c.doc, (linked ? 'Linked copy of ' : 'Copy of ') + p.name);
    startMove(c.id); // it stands where the original stands: the next thing is to move it away
    if (mover && !linked) mover.like = p.id;
    toast(
      linked
        ? 'A linked copy: it changes with the original. Drag an arrow to move it away, then Apply.'
        : 'A copy of its own. Drag an arrow to move it away, then Apply.'
    );
  } catch (e) {
    toast(e.message);
  }
}
const actions = {
  connect: openConnect,
  colour: () => {
    colouring = true;
    renderColourPanel();
  },
  dimensions: () => {
    dimsOn = !dimsOn;
    renderToggles();
    view.dirty();
    if (dimsOn)
      toast(
        partById(store.state.doc, selectedPart)
          ? `The numbers that drive ${partById(store.state.doc, selectedPart).name}. Click one to change it.`
          : 'The numbers that drive the model. Click one to change it.'
      );
  },
  measure: () => {
    measureOn = !measureOn;
    setPref('measure', measureOn);
    renderToggles();
    view.dirty();
  },
  box: () => beginFeature('box'),
  cylinder: () => beginFeature('cylinder'),
  sphere: () => beginFeature('sphere'),
  combine: () => beginFeature('combine'),
  'new-part': () => {
    const made = makePart(store.state.doc, { parent: container() });
    selectedFeature = null;
    selectedPart = made.part.id;
    store.commit(addPart(made.doc, made.part), 'New part');
    toast(`${made.part.name} is empty. Sketch on a plane to give it a shape.`);
  },
  'new-group': () => {
    const made = makePart(store.state.doc, { base: 'Group', group: true, parent: container() });
    selectedFeature = null;
    selectedPart = made.part.id;
    store.commit(addPart(made.doc, made.part), 'New group');
    toast(`${made.part.name} is empty. Drag parts onto it in the list; what you make while it is selected goes into it.`);
  },
  ungroup: () => {
    const g = partById(store.state.doc, selectedPart);
    if (!g?.group) return;
    let next;
    try {
      next = ungroup(store.state.doc, g.id);
    } catch (error) {
      toast(error.message);
      return;
    }
    selectedPart = null;
    store.commit(next, 'Ungroup ' + g.name);
  },
  'move-part': () => startMove(selectedPart ?? homePart()),
  'copy-part': () => duplicatePart(false),
  'link-part': () => duplicatePart(true),
  'unlink-part': () => {
    const p = partById(store.state.doc, selectedPart);
    if (!p?.link) return;
    try {
      const u = unlinkPart(store.state.doc, p.id);
      selectedPart = u.id;
      store.commit(u.doc, 'Unlink ' + p.name);
    } catch (e) {
      toast(e.message);
    }
  },
  'rename-part': () => {
    const p = partById(store.state.doc, selectedPart);
    if (p)
      textDialog('Rename part', p.name, (name) =>
        store.commit(updatePart(store.state.doc, p.id, { name }), 'Rename part')
      );
  },
  'delete-part': () => {
    const d = store.state.doc,
      p = partById(d, selectedPart);
    if (!p) return;
    const under = descendantsOf(d, p.id).length,
      deps = partDependents(d, p.id),
      count = (n, one, many) => `${n} ${n === 1 ? one : many}`,
      hanging = [
        deps.links.length ? count(deps.links.length, 'linked copy', 'linked copies') : '',
        deps.features.length ? count(deps.features.length, 'combine feature', 'combine features') : '',
      ].filter(Boolean);
    showModal(
      'Delete ' + p.name,
      `<p>Delete this part${featuresOf(d, p.id).length ? ' and its history' : ''}${
        under ? `, and the ${count(under, 'part', 'parts')} under it` : ''
      }? You can restore it with Undo.</p>${
        hanging.length
          ? `<p>${hanging.join(' and ')} elsewhere ${
              deps.links.length + deps.features.length === 1 ? 'uses' : 'use'
            } it. They will be reported as lost, or can be deleted too.</p>`
          : ''
      }`,
      cancelButton +
        (hanging.length
          ? '<button data-modal="all" title="Delete this part and what depends on it">Delete dependents</button>'
          : '') +
        '<button class="primary" data-modal="delete" title="Delete this part and what is under it">Delete</button>',
      (a) => {
        if (a !== 'cancel') {
          let next = removePart(d, p.id);
          if (a === 'all') {
            for (const l of deps.links) next = removePart(next, l);
            for (const f of deps.features) next = removeFeature(next, f);
          }
          selectedPart = null;
          selectedFeature = null;
          store.commit(next, 'Delete ' + p.name);
        }
        closeModal();
      }
    );
  },
  upright: () => mover && upright(),
  update: () => {
    if (editor || draft || mover) toast('Finish or cancel what is open first: reloading would lose it.');
    else reloadApp();
  },
  'cancel-move': () => endMove(false),
  'apply-move': () => endMove(true),
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
    else if (mover) endMove(false);
    else if (editor) editor.undo();
    else store.undo();
  },
  redo: () => (editor ? editor.redo() : !draft && !mover && store.redo()),
  'rename-project': () =>
    textDialog('Rename project', store.state.doc.meta.name, (name) =>
      store.commit(
        { ...store.state.doc, meta: { ...store.state.doc.meta, name } },
        'Rename project'
      )
    ),
  new: () => {
    if (editor || draft || mover) {
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
        selectedPart = null;
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
  'export-part': () => actions['export-menu'](true),
  'export-menu': (onlySelected = false) => {
    showModal(
      'Export solids',
      '<p><b>3MF</b> is for printing: every part is an object of its own, with its name and its colours, where it stands. Bambu Studio, OrcaSlicer, PrusaSlicer and Cura open it.</p><p><b>STL</b> is a plain triangle mesh. An STL file cannot tell one object from another, so with several parts you get a .zip with one STL for each. <b>STEP</b> keeps exact solids, named and coloured, for other CAD programs.</p><p>Hidden parts are left out.</p>',
      cancelButton +
        '<button data-modal="stl" title="A binary STL mesh; with several parts, one for each in a .zip">STL</button><button data-modal="step" title="Exact solids as STEP, named and coloured">STEP</button><button class="primary" data-modal="3mf" title="For slicers: every part an object of its own, with its name and colours">3MF</button>',
      (a) => {
        const only = id('export-only')?.checked ? id('export-only').value : null;
        closeModal();
        if (a !== 'cancel') exportFile(a, only);
      }
    );
    // One part only, when one is selected: asked for here, or beforehand with the part's own Export button.
    const p = partById(store.state.doc, selectedPart);
    if (p) {
      $('#modal-root .panel-body').insertAdjacentHTML(
        'beforeend',
        check('export-only', `Only the selected part: ${p.name}`, onlySelected, 'Export this part and what stands under it, and nothing else.')
      );
      id('export-only').value = p.id;
    }
  },
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
    store.preview(store.state.doc, { roll: rollTo(store.state.doc, f.id, false) });
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
    if (featureById(store.state.doc, selectedFeature)) {
      rolled = true;
      store.preview(store.state.doc, { roll: rollTo(store.state.doc, selectedFeature, true) });
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
    colouring = false;
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
          ['B / M', 'Box as a new part / Move the selected part'],
          ['D', 'Dimensions: the numbers that drive the model, to click and change'],
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
        '</table><p>Number fields accept arithmetic, decimals with a dot or comma, and a trailing mm. Blue geometry can move; green geometry is constrained. Dimensions in parentheses are measurements. Double-click history entries to edit them.</p><p>A project is made of parts. Each part has its own history and its own place: select one in the list or in the view, and Move places it (arrows to move it, rings to turn it), Copy and Linked copy repeat it, Combine joins another part to it or cuts one out of it. Box, Cylinder and Sphere start a part without a sketch. A Group is a container: it has a place but no shape, and moves, turns, hides and colours the parts in it; drag parts onto it in the list.</p><p>Rest the mouse on a face or an edge to see how big it is; click one and Shift-click another for the distance or the angle between them. Dimensions (D) shows the numbers that drive the selected part where they are: click one, type, Enter.</p>',
      '<button class="primary" data-modal="close" title="Close help">Got it</button>',
      closeModal,
      true
    ),
};
let showPlanes = true;
document.addEventListener('click', (e) => {
  const target = e.target.closest(
    '[data-action],[data-plane],[data-view],[data-feature],[data-cid],[data-constraint],[data-modal],[data-region],[data-remove-edge],[data-visible],[data-body],[data-part-eye],[data-part-colour],[data-colour],[data-twist],[data-turn],[data-part]'
  );
  if (!target || target.disabled) return;
  const d = target.dataset;
  if (d.modal) {
    modal?.handler(d.modal);
    return;
  }
  if (modal) return;
  if (d.turn !== undefined) {
    if (mover) {
      const angle = parseNumber(id('move-angle').value);
      if (angle === null) toast('Enter the angle to turn by, in degrees.');
      else turnBy(Number(d.turn), angle);
    }
    return;
  }
  const busy = editor || draft || mover;
  if (d.colour !== undefined) {
    if (!busy) applyColour(d.colour);
    return;
  }
  if (d.partColour) {
    if (busy) toast('Finish or cancel the current edit first.');
    else {
      selectPart(d.partColour);
      actions.colour();
    }
    return;
  }
  if (d.partEye) {
    if (busy) toast('Finish or cancel the current edit first.');
    else
      store.commit(
        updatePart(store.state.doc, d.partEye, (p) => {
          const { hidden, ...rest } = p;
          return hidden ? rest : { ...rest, hidden: true };
        }),
        'Part visibility'
      );
    return;
  }
  if (d.twist) {
    if (!collapsed.delete(d.twist)) collapsed.add(d.twist);
    renderBrowser();
    return;
  }
  if (d.part) {
    if (busy) return;
    selectPart(d.part);
    const p = partById(store.state.doc, d.part);
    id('context-note').textContent = p?.group
      ? 'A group · Move places everything in it; parts you make now go into it; drag parts onto it in the list.'
      : p?.link
      ? 'A linked copy: it follows its original. Move places it; Unlink makes it a part of its own.'
      : 'Part selected · Move places it, Combine joins or cuts other parts, new sketches go into it.';
    return;
  }
  if (d.action) {
    if (
      mover &&
      !['apply-move', 'cancel-move', 'upright', 'fit', 'projection', 'planes', 'help', 'undo', 'connect', 'dimensions', 'measure'].includes(d.action)
    ) {
      toast('Apply or cancel the move first.');
      return;
    }
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
        'new-part',
        'move-part',
        'copy-part',
        'link-part',
        'unlink-part',
        'rename-part',
        'delete-part',
        'export-part',
        'colour',
        'new-group',
        'ungroup',
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
    if (editor || draft || mover) return;
    selectedFeature = d.feature;
    numbersFor = d.feature;
    selectedPart = featureById(store.state.doc, d.feature)?.part ?? selectedPart;
    selection = [];
    pointed = null;
    view.hover(null);
    view.select([]);
    refreshScene();
    renderBrowser();
    view.dirty();
    const r = store.state.build?.features.find((f) => f.id === d.feature),
      kind = featureById(store.state.doc, d.feature)?.type;
    id('context-note').textContent =
      r?.message ?? (DIALOGS.includes(kind) || kind === 'sketch' ? 'Double-click this feature to edit its parameters.' : 'Its numbers are on the model: click one to change it.');
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
    c = e.target.closest('[data-cid]'),
    part = e.target.closest('[data-part-eye],[data-twist]') ? null : e.target.closest('[data-part]');
  if (f && !editor && !draft && !mover) {
    selectedFeature = f.dataset.feature;
    editFeature();
  }
  if (part && !editor && !draft && !mover) startMove(part.dataset.part);
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
// A part dragged onto another in the list goes under it; dropped on the list's heading or its
// empty space it stands on its own again. It stays where it is in space either way.
let dragPart = null;
/** Where a dragged part would go: a part's id, null for the top level, undefined for nowhere. */
function dropParent(e) {
  if (!dragPart || !e.target.closest) return undefined;
  const d = store.state.doc,
    row = e.target.closest('[data-part]');
  if (row) {
    const to = row.dataset.part;
    return to === dragPart || descendantsOf(d, dragPart).includes(to) ? undefined : to;
  }
  return e.target.closest('#browser-content') ? null : undefined;
}
const clearDrop = () => document.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop'));
document.addEventListener('dragstart', (e) => {
  const row = e.target.closest?.('[data-part]');
  if (!row) return;
  if (editor || draft || mover) {
    e.preventDefault();
    return;
  }
  dragPart = row.dataset.part;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragPart);
});
document.addEventListener('dragend', () => {
  dragPart = null;
  clearDrop();
});
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  if (!dragPart) return;
  const to = dropParent(e);
  clearDrop();
  if (to === undefined) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  (to ? document.querySelector(`[data-part="${to}"]`) : id('browser-content'))?.classList.add('drop');
});
document.addEventListener('drop', (e) => {
  if (dragPart) {
    const to = dropParent(e),
      pid = dragPart,
      d = store.state.doc;
    dragPart = null;
    clearDrop();
    e.preventDefault();
    if (to === undefined || (partById(d, pid)?.parent ?? null) === to) return;
    try {
      selectedFeature = null;
      selectedPart = pid;
      store.commit(setParent(d, pid, to), to ? `Put ${partById(d, pid).name} under ${partById(d, to).name}` : `Take ${partById(d, pid).name} out`);
    } catch (error) {
      toast(error.message);
    }
    return;
  }
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
    else if (mover) endMove(false);
    else if (editor) {
      editor.escape();
      view.canvas.focus();
    } else {
      actions['close-panel']();
      selection = [];
      pointed = null;
      selectedDim = null;
      view.select([]);
      view.hover(null);
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
  if (draft || replaneId || mover) return;
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
    const action = {
      s: 'sketch',
      e: 'extrude',
      h: 'hole',
      f: e.shiftKey ? 'chamfer' : 'fillet',
      b: 'box',
      m: 'move-part',
      d: 'dimensions',
    }[key];
    if (action) {
      e.preventDefault();
      actions[action]();
    }
  }
});
renderTools();
renderBrowser();
renderToggles();
// The command set for scripts and agents (src/api/commands.js): it changes the model through
// the same store as the controls above, so what it does is undoable, autosaved and shown.
const api = createCommands({
  store,
  view,
  editing: () => !!(editor || draft || mover),
  /** The part the last command or click worked on (null when there is none), and the part a new sketch would go into. */
  currentPart: () => (partById(store.state.doc, selectedPart) ? selectedPart : homePart()),
  /** What the person has clicked, and what their mouse last rested on. */
  chosen,
  /** Shows or hides the numbers that drive the model (for a picture); answers what it was. */
  showDimensions: (on) => {
    const was = dimsOn;
    dimsOn = !!on;
    renderToggles();
    view.dirty();
    return was;
  },
  homePart: () => homePart(),
  /** This tab's build, the published build when that is another, and the way to get it. */
  build: BUILD,
  newest: () => updateReady,
  checkUpdate: () => checkUpdate(),
  reload: () => setTimeout(reloadApp, 400), // after the answer to the command has gone out
  /** The group a new part would go into, as the page has it: the selected group, or the one the selected part is in. */
  container: () => container(),
  cancelEdit: () => {
    if (editor) finishSketch(true);
    if (draft) endFeature(false);
    if (mover) endMove(false);
  },
  ready: () => {
    if (rolled && !editor && !draft) {
      store.cancelPreview();
      rolled = false;
    }
  },
  shown: (fid, pid = null) => {
    if (quietShown) {
      // A number typed over in the view: what is selected and where the camera looks stay as they are.
      refreshScene();
      renderBrowser();
      return;
    }
    selectedFeature = fid;
    selectedPart = featureById(store.state.doc, fid)?.part ?? pid ?? (partById(store.state.doc, selectedPart) ? selectedPart : null);
    selection = [];
    view.select([]);
    refreshScene();
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
      <li>Say <b>this</b> or <b>here</b>: Claude can see what you have clicked, and what your mouse last rested on (it is marked with a ring).</li>
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
  view.dirty(); // the ring on what is pointed at is drawn while connected
}
renderBridge(bridge.state);
bridge.resume();

// ---- a newer CoreCAD is published: say so, and get all of it (src/update.js)
let updateReady = null, // the published build, when it is not the one this tab runs
  updateChecked = 0;
/** Looks what is published. `read`: where its version.js comes from (tests); without it, at most once a minute. */
async function checkUpdate(read) {
  if (!read && Date.now() - updateChecked < 60000) return updateReady;
  updateChecked = Date.now();
  const stamp = await published(read);
  if (stamp) {
    updateReady = stamp.build !== BUILD ? stamp.build : null;
    id('update-button').hidden = !updateReady;
  }
  return updateReady;
}
function reloadApp() {
  id('update-button').disabled = true;
  toast('Getting the newest CoreCAD…');
  return freshReload();
}
if (!new URLSearchParams(location.search).has('test')) {
  // A tab that stays open for days, and one reloaded while the browser still kept older files.
  setTimeout(checkUpdate, 4000);
  setInterval(() => document.visibilityState === 'visible' && checkUpdate(), 180000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkUpdate());
}
// Inspection and coordinate helpers for browser automation, and the commands. The modelling
// tests in tools/e2e.py edit with actual pointer/key events; tools/e2e_api.py uses the commands.
window.corecad = {
  /** This tab's build (src/version.js). checkUpdate(read) looks what is published: the newer build, or null. */
  version: BUILD,
  checkUpdate: (read) => checkUpdate(read ?? (() => fetch(new URL('./version.js', import.meta.url), { cache: 'no-store' }).then((r) => r.text()))),
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
    return !!(editor || draft || mover);
  },
  get parts() {
    return structuredClone(store.state.doc.parts);
  },
  get selectedPart() {
    return selectedPart;
  },
  /** The numbers drawn on the model, with where each is on the page: [{ feature, key, text, value, what, x, y, editable }]. */
  get dimensions() {
    view.snapshot(); // drawn now, so that the list is of this moment
    const r = view.canvas.getBoundingClientRect();
    return dimLabels.map(({ box, d }) => ({ feature: d.feature, key: d.key, text: d.text, value: d.value, what: d.what, x: box.x + box.w / 2 + r.left, y: box.y + box.h / 2 + r.top, editable: !!d.edit }));
  },
  /** What the line under the view bar says about the selection. */
  get measured() {
    return selectionNote();
  },
  /** Every value drawn on the model right now: [{ text, kind }], kind 'driving', 'reference', 'measure', 'pointed' or
   *  'chosen'; and 'caption': what the number under the mouse is. */
  get numbers() {
    view.snapshot();
    return structuredClone(drawnNumbers);
  },
  /** The face or edge the mouse last rested on, if it is still there: { type, body, face | edge, point, world, when }. */
  get pointed() {
    return structuredClone(stillThere(pointed));
  },
  /** The part being placed, as it would be kept; null when none is. */
  get moving() {
    return mover ? structuredClone(partById(mover.doc, mover.id)) : null;
  },
  /** The rings of the part being placed: [{ axis, facing, points: [[x, y, angle], ...] }], in page coordinates;
   *  angle in radians, growing the way a turn about that axis goes. */
  get rings() {
    if (!mover) return null;
    const r = view.canvas.getBoundingClientRect();
    return moveRings().map(({ axis, facing, points }) => ({ axis, facing, points: points.map(([x, y, t]) => [x + r.left, y + r.top, t]) }));
  },
  /** The arrows of the part being placed, in page coordinates: [{ axis, a, b }]. */
  get arrows() {
    if (!mover) return null;
    const r = view.canvas.getBoundingClientRect();
    return moveArrows().map(({ axis, a, b }) => ({ axis, a: [a[0] + r.left, a[1] + r.top], b: [b[0] + r.left, b[1] + r.top] }));
  },
  /** What is drawn: every body with the part it shows and where it stands (twelve numbers, row order). */
  get scene() {
    return sceneFor(store.state.build?.bodies).map(({ mesh, faceColors, ...b }) => ({ ...b, colors: [...faceColors] }));
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

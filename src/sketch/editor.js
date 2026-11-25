import {
  at,
  indexSketch,
  pointsOf,
  cloneSketch,
  addLine,
  addCircle,
  addArc,
  addPointEntity,
  addRectangle,
  addConstraint,
  removeItems,
} from './model.js';
import {
  solveSketch,
  analyseSketch,
  tryAddConstraint,
  beginDrag,
  setDimensions,
} from './solver.js';
import {
  curvesOf,
  curvePoint,
  nearestOnCurve,
  distance,
  angle,
  intersections,
  polygonOf,
  signedDistance,
} from './geom2d.js';
import { findRegions, openEnds } from './profiles.js';
import { DIMENSIONS } from './catalogue.js';
import { dimensionFrom, dimensionGeometry, measure, midpoint } from './measure.js';
import { parseNumber, formatNumber } from '../core/num.js';

export function createEditor(initial, view, cb = {}) {
  let sketch = cloneSketch(initial),
    history = [sketch],
    position = 0,
    watermark = sketch.seq,
    selection = [],
    tool = 'select',
    construction = false,
    anchors = [],
    cursor = [0, 0],
    snap = null,
    drag = null,
    press = null,
    moved = false,
    labels = [],
    glyphs = [],
    numbers = ['', ''];
  let analysis = analyseSketch(sketch),
    regions = [],
    ends = [];
  const announce = () => cb.change?.(api);
  function analyze() {
    analysis = analyseSketch(sketch);
    try {
      regions = findRegions(sketch);
      ends = openEnds(sketch);
    } catch (e) {
      regions = [];
      ends = [];
      cb.error?.(e.message);
    }
    view.dirty();
  }
  function commit(next, label) {
    watermark = Math.max(watermark, next.seq);
    sketch = { ...next, seq: watermark };
    history = history.slice(0, position + 1);
    history.push(sketch);
    position++;
    analyze();
    cb.commit?.(sketch, label);
    announce();
  }
  function solved(next, label) {
    const r = solveSketch(next);
    if (!r.ok) {
      cb.error?.(r.message);
      return false;
    }
    commit(r.sketch, label);
    return true;
  }
  function infer(s, c) {
    const r = tryAddConstraint(s, c);
    return r.ok ? r.sketch : s;
  }
  function attach(s, p, hit) {
    if (!hit) return s;
    if (hit.point && p !== hit.point) s = infer(s, { type: 'coincident', refs: [p, hit.point] });
    for (const curve of hit.curves ?? [])
      s = infer(s, {
        type: curve.kind === 'line' ? 'pointOnLine' : 'pointOnCircle',
        refs: [p, curve.entity],
      });
    if (hit.midpoint) s = infer(s, { type: 'midpoint', refs: [p, hit.midpoint] });
    return s;
  }
  const pixel = (p) => view.screen(p).slice(0, 2),
    mm = () => view.mmPerPx;
  function snapping(p, disabled = false) {
    if (disabled) return { p };
    const tol = 9 * mm(),
      ix = indexSketch(sketch),
      ps = [{ id: 'origin', x: 0, y: 0 }, ...sketch.points];
    const candidates = ps
      .map((q) => ({
        p: [q.x, q.y],
        point: q.id,
        text: q.id === 'origin' ? 'Origin' : 'Coincident',
        d: distance(p, [q.x, q.y]),
      }))
      .filter((c) => c.d < tol)
      .sort((a, b) => a.d - b.d);
    if (candidates.length) return candidates[0];
    const curves = curvesOf(sketch, true);
    for (const c of curves)
      if (c.kind === 'line') {
        const mid = curvePoint(c, 0.5);
        if (distance(p, mid) < tol * 0.8) return { p: mid, midpoint: c.entity, text: 'Midpoint' };
      }
    const close = curves.filter((c) => distance(p, nearestOnCurve(c, p)) < tol);
    for (let i = 0; i < close.length; i++)
      for (let j = i + 1; j < close.length; j++) {
        const q = intersections(close[i], close[j]).find((q) => distance(p, q) < tol);
        if (q) return { p: q, curves: [close[i], close[j]], text: 'Intersection' };
      }
    if (close.length) {
      const c = close.sort(
        (a, b) => distance(p, nearestOnCurve(a, p)) - distance(p, nearestOnCurve(b, p))
      )[0];
      return { p: nearestOnCurve(c, p), curves: [c], text: 'On curve' };
    }
    if (anchors.length && tool === 'line') {
      const a = anchors[0].p;
      if (Math.abs(p[1] - a[1]) < tol)
        return { p: [p[0], a[1]], axis: 'horizontal', text: 'Horizontal' };
      if (Math.abs(p[0] - a[0]) < tol)
        return { p: [a[0], p[1]], axis: 'vertical', text: 'Vertical' };
    }
    return { p };
  }
  function effective() {
    const p = [...cursor],
      a = anchors[0]?.p;
    if (!a) return p;
    const v = numbers.map((x) => (x.trim() ? parseNumber(x) : null));
    if (tool === 'rectangle') {
      if (v[0] > 0) p[0] = a[0] + (p[0] >= a[0] ? 1 : -1) * v[0];
      if (v[1] > 0) p[1] = a[1] + (p[1] >= a[1] ? 1 : -1) * v[1];
    }
    if (
      (['line', 'circle'].includes(tool) || (tool === 'arc' && anchors.length === 1)) &&
      v[0] > 0
    ) {
      let ang = angle(a, p);
      if (tool === 'line' && v[1] !== null) ang = (v[1] * Math.PI) / 180;
      p[0] = a[0] + v[0] * Math.cos(ang);
      p[1] = a[1] + v[0] * Math.sin(ang);
    }
    if (tool === 'arc' && anchors.length === 2) {
      const r = distance(a, anchors[1].p),
        ang = angle(a, p);
      return [a[0] + r * Math.cos(ang), a[1] + r * Math.sin(ang)];
    }
    return p;
  }
  function makeAt(hit) {
    const p = hit.p,
      a = anchors[0]?.p;
    if (!a && tool !== 'point') {
      anchors.push(hit);
      announce();
      view.dirty();
      return;
    }
    let s = cloneSketch(sketch),
      e,
      opts = { construction },
      endPoint;
    if (tool === 'point') {
      e = addPointEntity(s, ...p);
      e = s.entities.find((x) => x.id === e.id);
      e.construction = construction;
      s = attach(s, e.p, hit);
    }
    if (tool === 'line') {
      if (distance(a, p) < 1e-5) return;
      e = addLine(s, ...a, ...p, opts);
      s = attach(s, e.a, anchors[0]);
      s = attach(s, e.b, hit);
      if (Math.abs(a[1] - p[1]) < 1e-6) s = infer(s, { type: 'horizontal', refs: [e.id] });
      else if (Math.abs(a[0] - p[0]) < 1e-6) s = infer(s, { type: 'vertical', refs: [e.id] });
      if (numbers[0].trim()) s = infer(s, dimensionFrom(s, [e.id]));
      endPoint = e.b;
    }
    if (tool === 'rectangle') {
      if (Math.min(Math.abs(a[0] - p[0]), Math.abs(a[1] - p[1])) < 1e-5) return;
      const ls = addRectangle(s, a, p);
      if (construction)
        ls.forEach((l) => {
          s.entities.find((e) => e.id === l.id).construction = true;
        });
      const first = s.points.find(
        (q) => distance([q.x, q.y], a) < 1e-7 && ls.some((l) => pointsOf(l).includes(q.id))
      );
      s = attach(s, first.id, anchors[0]);
      if (numbers[0].trim()) s = infer(s, dimensionFrom(s, [ls[0].id]));
      if (numbers[1].trim()) s = infer(s, dimensionFrom(s, [ls[1].id]));
    }
    if (tool === 'circle') {
      const r = distance(a, p);
      if (r < 1e-5) return;
      e = addCircle(s, ...a, r, opts);
      s = attach(s, e.c, anchors[0]);
      if (numbers[0].trim()) s = infer(s, dimensionFrom(s, [e.id]));
    }
    if (tool === 'arc') {
      if (anchors.length === 1) {
        if (distance(a, p) > 1e-5) anchors.push(hit);
        announce();
        view.dirty();
        return;
      }
      if (distance(anchors[1].p, p) < 1e-5) return;
      e = addArc(s, ...a, ...anchors[1].p, ...p, opts);
      s = attach(s, e.c, anchors[0]);
      s = attach(s, e.a, anchors[1]);
      if (distance(p, hit.p) < 1e-6) s = attach(s, e.b, hit);
      if (numbers[0].trim()) s = infer(s, dimensionFrom(s, [e.id]));
    }
    if (!solved(s, 'Draw ' + tool)) return;
    anchors = tool === 'line' ? [{ p, point: endPoint, text: 'Coincident' }] : [];
    numbers = ['', ''];
    cb.clearNumbers?.();
    announce();
    view.dirty();
  }
  function pick(p) {
    const s = pixel(p);
    for (const l of labels)
      if (Math.abs(s[0] - l.s[0]) < l.w / 2 + 5 && Math.abs(s[1] - l.s[1]) < 12)
        return { type: 'dimension', id: l.id };
    for (const g of glyphs) if (distance(s, g.s) < 7) return { type: 'constraint', id: g.id };
    let best = null,
      d = 8 * mm();
    for (const q of [{ id: 'origin', x: 0, y: 0 }, ...sketch.points]) {
      const dd = distance(p, [q.x, q.y]);
      if (dd < d) {
        d = dd;
        best = { type: 'point', id: q.id };
      }
    }
    if (best) return best;
    d = 7 * mm();
    for (const c of curvesOf(sketch, true)) {
      const dd = distance(p, nearestOnCurve(c, p));
      if (dd < d) {
        d = dd;
        best = { type: 'entity', id: c.entity };
      }
    }
    return best;
  }
  function select(id, add = false) {
    selection = add
      ? selection.includes(id)
        ? selection.filter((x) => x !== id)
        : [...selection, id]
      : id
      ? [id]
      : [];
    announce();
    view.dirty();
  }
  function path(ctx, pts, close = false) {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const q = pixel(p);
      if (i) ctx.lineTo(q[0], q[1]);
      else ctx.moveTo(q[0], q[1]);
    });
    if (close) ctx.closePath();
  }
  const symbol = {
    coincident: '●',
    horizontal: 'H',
    vertical: 'V',
    parallel: '∥',
    perpendicular: '⊥',
    tangent: 'T',
    equal: '=',
    concentric: '◎',
    midpoint: 'M',
    fix: '▣',
    pointOnLine: '•',
    pointOnCircle: '•',
  };
  function draw(ctx) {
    for (const r of regions) {
      ctx.beginPath();
      for (const loop of [r.outer, ...r.holes]) {
        polygonOf(loop, Math.max(0.01, mm() * 0.5)).forEach((p, i) => {
          const q = pixel(p);
          if (i) ctx.lineTo(...q);
          else ctx.moveTo(...q);
        });
        ctx.closePath();
      }
      ctx.fillStyle = '#0d9d7910';
      ctx.fill('evenodd');
    }
    for (const c of curvesOf(sketch, true)) {
      const e = sketch.entities.find((e) => e.id === c.entity),
        sel = selection.includes(c.entity);
      ctx.strokeStyle = sel
        ? '#ef9a3c'
        : analysis.states[e.id] === 'free'
        ? '#287eb4'
        : analysis.states[e.id] === 'fixed'
        ? '#8a5ba2'
        : '#22735b';
      ctx.lineWidth = sel ? 2.7 : 1.8;
      ctx.setLineDash(e.construction ? [6, 4] : []);
      const n =
        c.kind === 'line' ? 1 : Math.min(720, Math.max(16, Math.ceil((c.r * c.sweep) / mm() / 4)));
      path(
        ctx,
        Array.from({ length: n + 1 }, (_, i) => curvePoint(c, i / n))
      );
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const p of [{ id: 'origin', x: 0, y: 0 }, ...sketch.points]) {
      const q = pixel([p.x, p.y]),
        sel = selection.includes(p.id);
      ctx.beginPath();
      ctx.arc(...q, p.id === 'origin' ? 4 : sel ? 4.5 : 3, 0, 2 * Math.PI);
      ctx.fillStyle = sel ? '#ef9a3c' : analysis.states[p.id] === 'free' ? '#287eb4' : '#22735b';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    labels = [];
    glyphs = [];
    ctx.font = '12px "SFMono-Regular", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of sketch.constraints.filter((c) => !c.off && DIMENSIONS.includes(c.type))) {
      const g = dimensionGeometry(sketch, c),
        ps = [g.p, g.a, g.b, g.q].map(pixel),
        color = selection.includes(c.id) ? '#c47a24' : c.driven ? '#7e8891' : '#25646b';
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(...ps[0]);
      ps.slice(1).forEach((p) => ctx.lineTo(...p));
      ctx.stroke();
      for (const p of [ps[1], ps[2]]) {
        ctx.beginPath();
        ctx.moveTo(p[0] - 3, p[1] + 3);
        ctx.lineTo(p[0] + 3, p[1] - 3);
        ctx.stroke();
      }
      const prefix = c.type === 'radius' ? 'R ' : c.type === 'diameter' ? 'Ø ' : '';
      const text =
        (c.driven ? '(' : '') +
        prefix +
        formatNumber(measure(sketch, c)) +
        (c.type === 'angle' ? '°' : '') +
        (c.driven ? ')' : '');
      const s = pixel(g.label),
        w = ctx.measureText(text).width + 12;
      ctx.fillStyle = '#f0f4f4';
      ctx.fillRect(s[0] - w / 2, s[1] - 9, w, 18);
      ctx.fillStyle = color;
      ctx.fillText(text, ...s);
      labels.push({ id: c.id, s, w });
    }
    const used = new Map();
    for (const c of sketch.constraints.filter((c) => !c.off && !DIMENSIONS.includes(c.type))) {
      const ref = c.refs[0],
        ix = indexSketch(sketch),
        e = ix.entity(ref);
      let p = ix.point(ref)
        ? at(sketch, ref)
        : e?.type === 'line'
        ? midpoint(at(sketch, e.a), at(sketch, e.b))
        : e?.c
        ? at(sketch, e.c)
        : e?.p
        ? at(sketch, e.p)
        : null;
      if (!p) continue;
      const n = used.get(ref) ?? 0;
      used.set(ref, n + 1);
      const s = pixel(p);
      s[0] += 12 + n * 13;
      s[1] -= 12;
      ctx.fillStyle = selection.includes(c.id) ? '#ce842c' : '#829499';
      ctx.font = '10px system-ui';
      ctx.fillText(symbol[c.type] ?? '•', ...s);
      glyphs.push({ id: c.id, s });
    }
    for (const p of ends) {
      const q = pixel(Array.isArray(p) ? p : p.at ?? p.p);
      ctx.beginPath();
      ctx.arc(...q, 5, 0, 2 * Math.PI);
      ctx.strokeStyle = '#db9369';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (anchors.length) {
      const p = effective(),
        a = anchors[0].p;
      ctx.strokeStyle = '#1b9a87';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      if (tool === 'rectangle') path(ctx, [a, [p[0], a[1]], p, [a[0], p[1]]], true);
      else if (tool === 'circle' || tool === 'arc') {
        const r = distance(a, tool === 'arc' && anchors[1] ? anchors[1].p : p),
          a0 = tool === 'arc' && anchors[1] ? angle(a, anchors[1].p) : 0,
          sw =
            tool === 'arc' && anchors[1]
              ? (angle(a, p) - a0 + Math.PI * 2) % (Math.PI * 2)
              : Math.PI * 2;
        path(
          ctx,
          Array.from({ length: 97 }, (_, i) => [
            a[0] + r * Math.cos(a0 + (sw * i) / 96),
            a[1] + r * Math.sin(a0 + (sw * i) / 96),
          ])
        );
      } else path(ctx, [a, p]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (snap?.text && tool !== 'select') {
      const s = pixel(snap.p);
      ctx.strokeStyle = '#138e75';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(s[0] - 5, s[1] - 5, 10, 10);
      ctx.font = '11px system-ui';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#107f6a';
      ctx.fillText(snap.text, s[0] + 12, s[1] - 13);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  const api = {
    get feature() {
      return sketch;
    },
    get analysis() {
      return analysis;
    },
    get regions() {
      return regions;
    },
    get selection() {
      return selection;
    },
    get tool() {
      return tool;
    },
    get construction() {
      return construction;
    },
    get stage() {
      return anchors.length;
    },
    get canUndo() {
      return position > 0;
    },
    get canRedo() {
      return position < history.length - 1;
    },
    get instruction() {
      return tool === 'select'
        ? 'Select geometry · Shift-click adds · Drag free points · D to dimension'
        : tool === 'rectangle'
        ? anchors.length
          ? 'Place the opposite corner, or type width and height.'
          : 'Pick the first corner. Snap to the origin to anchor the rectangle.'
        : tool === 'line'
        ? anchors.length
          ? 'Place the next point. Esc ends the chain.'
          : 'Pick the first point.'
        : tool === 'circle'
        ? anchors.length
          ? 'Set the radius, or type a value.'
          : 'Pick the circle centre.'
        : tool === 'arc'
        ? [
            'Pick the arc centre.',
            'Pick the start of the arc.',
            'Pick the end, counter-clockwise from the start.',
          ][anchors.length]
        : 'Click to place a point.';
    },
    draw,
    pick,
    select,
    setTool(t) {
      if (drag) {
        drag.cancel();
        drag = null;
      }
      tool = t;
      anchors = [];
      numbers = ['', ''];
      cb.clearNumbers?.();
      selection = [];
      announce();
      view.dirty();
    },
    setNumbers(a, b) {
      numbers = [a, b];
      view.dirty();
    },
    down(p, e) {
      const uv = view.sketchPoint(p);
      if (!uv) return;
      cursor = uv;
      press = p;
      moved = false;
      if (tool !== 'select') {
        snap = snapping(uv, e.ctrlKey);
        cursor = snap.p;
        const q = effective();
        makeAt(distance(q, snap.p) < 1e-7 ? snap : { p: q });
        return;
      }
      const hit = pick(uv);
      if (!hit) {
        select(null);
        return;
      }
      if (e.shiftKey) {
        select(hit.id, true);
        return;
      }
      if (!selection.includes(hit.id)) select(hit.id);
      if (hit.type === 'dimension') {
        drag = { label: true, id: hit.id, initial: sketch, start: uv };
        return;
      }
      if (hit.type === 'constraint') return;
      drag = beginDrag(sketch, { id: hit.id, at: uv }, { pxPerMm: 1 / mm() });
    },
    move(p, e) {
      const uv = view.sketchPoint(p);
      if (!uv) return;
      cursor = uv;
      if (press && distance(p, press) > 3) moved = true;
      if (drag && moved) {
        if (drag.label) {
          sketch = cloneSketch(drag.initial);
          const c = sketch.constraints.find((c) => c.id === drag.id),
            off = c.label ?? [0, -8];
          c.label = [off[0] + uv[0] - drag.start[0], off[1] + uv[1] - drag.start[1]];
        } else {
          drag.move(uv);
          sketch = drag.sketch();
        }
        analyze();
      } else if (tool !== 'select') {
        snap = snapping(uv, e.ctrlKey);
        cursor = snap.p;
        view.dirty();
      }
      cb.coordinates?.(cursor);
    },
    up() {
      if (drag) {
        if (drag.label) {
          if (moved) commit(sketch, 'Move dimension');
        } else {
          const next = drag.end();
          if (next) commit(next, 'Drag geometry');
        }
        drag = null;
      }
      press = null;
    },
    double(p) {
      if (tool !== 'select') return;
      const uv = view.sketchPoint(p),
        hit = uv && pick(uv);
      if (hit?.type === 'dimension')
        cb.dimension?.(sketch.constraints.find((c) => c.id === hit.id));
    },
    cancel() {
      if (drag?.cancel) drag.cancel();
      drag = null;
      press = null;
      sketch = history[position];
      anchors = [];
      analyze();
    },
    escape() {
      if (anchors.length) {
        anchors = [];
        announce();
        view.dirty();
      } else api.setTool('select');
    },
    enter() {
      if (anchors.length) {
        const values = numbers.filter((x) => x.trim());
        if (values.some((x) => parseNumber(x) === null)) {
          cb.error?.('Enter a number or arithmetic expression.');
          return;
        }
        makeAt({ p: effective() });
      }
    },
    dimension(mode = 'auto') {
      try {
        cb.dimension?.(dimensionFrom(sketch, selection, mode));
      } catch (e) {
        cb.error?.(e.message);
      }
    },
    constrain(type) {
      let refs = [...selection],
        ix = indexSketch(sketch);
      if (['pointOnLine', 'pointOnCircle', 'midpoint'].includes(type))
        refs.sort((a, b) => Number(!ix.point(a)) - Number(!ix.point(b)));
      if (type === 'coincident' && refs.some((id) => ix.entity(id))) {
        const line = refs.find((id) => ix.entity(id)?.type === 'line'),
          curve = refs.find((id) => ['circle', 'arc'].includes(ix.entity(id)?.type)),
          p = refs.find((id) => ix.point(id));
        if (p && (line || curve)) {
          type = line ? 'pointOnLine' : 'pointOnCircle';
          refs = [p, line ?? curve];
        }
      }
      const c = { type, refs };
      if (type === 'tangent' && refs.length === 2) {
        const es = refs.map(ix.entity),
          line = es.find((e) => e?.type === 'line'),
          curves = es.filter((e) => ['circle', 'arc'].includes(e?.type));
        if (line && curves.length)
          c.side =
            signedDistance(at(sketch, curves[0].c), at(sketch, line.a), at(sketch, line.b)) >= 0
              ? 1
              : -1;
        else if (curves.length === 2) {
          const radius = (e) =>
            e.type === 'circle' ? e.r : distance(at(sketch, e.c), at(sketch, e.a));
          c.inside =
            distance(at(sketch, curves[0].c), at(sketch, curves[1].c)) <
            Math.max(...curves.map(radius));
        }
      }
      const r = tryAddConstraint(sketch, c);
      if (r.ok) {
        selection = [r.id];
        commit(r.sketch, 'Constrain ' + type);
      } else cb.error?.(r.message);
    },
    saveDimension(c, value, driven = false) {
      let r;
      if (c.id) {
        const next = cloneSketch(sketch),
          old = next.constraints.find((x) => x.id === c.id);
        Object.assign(old, c, { value, driven });
        r = solveSketch(next);
      } else r = tryAddConstraint(sketch, { ...c, value, driven });
      if (!r.ok) {
        cb.error?.(r.message);
        return false;
      }
      commit(r.sketch, 'Dimension');
      return true;
    },
    delete() {
      const ids = selection
        .map((id) => (indexSketch(sketch).point(id) ? indexSketch(sketch).ownerOf(id)?.id : id))
        .filter(Boolean);
      if (ids.length) solved(removeItems(sketch, ids), 'Delete sketch items');
      selection = [];
      announce();
    },
    toggleConstruction() {
      const selected = sketch.entities.filter((e) => selection.includes(e.id));
      if (selected.length) {
        const next = cloneSketch(sketch),
          on = !selected.every((e) => e.construction);
        next.entities.forEach((e) => {
          if (selection.includes(e.id)) e.construction = on;
        });
        commit(next, 'Construction geometry');
      } else {
        construction = !construction;
        announce();
      }
    },
    undo() {
      if (position > 0) {
        sketch = { ...history[--position], seq: watermark };
        selection = [];
        anchors = [];
        analyze();
        announce();
        cb.commit?.(sketch, 'Undo');
      }
    },
    redo() {
      if (position < history.length - 1) {
        sketch = { ...history[++position], seq: watermark };
        selection = [];
        analyze();
        announce();
        cb.commit?.(sketch, 'Redo');
      }
    },
    box() {
      const ps = sketch.points;
      if (!ps.length)
        return [
          [-20, -15],
          [90, 65],
        ];
      const cs = curvesOf(sketch);
      return [
        [
          Math.min(...ps.map((p) => p.x), ...cs.filter((c) => c.r).map((c) => c.c[0] - c.r)) - 10,
          Math.min(...ps.map((p) => p.y), ...cs.filter((c) => c.r).map((c) => c.c[1] - c.r)) - 10,
        ],
        [
          Math.max(...ps.map((p) => p.x), ...cs.filter((c) => c.r).map((c) => c.c[0] + c.r)) + 10,
          Math.max(...ps.map((p) => p.y), ...cs.filter((c) => c.r).map((c) => c.c[1] + c.r)) + 10,
        ],
      ];
    },
  };
  analyze();
  return api;
}

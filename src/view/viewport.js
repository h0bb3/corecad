import * as M from './camera-math.js';
import { buildPickData, pickFace, pickEdge, projectEdges } from './pick3d.js';
import { basePlane, canonicalFrame, toWorld } from '../core/plane.js';

/** Demand-rendered WebGL solids and a CSS-pixel canvas for sketch annotations. */
export function createViewport(host, callbacks = {}) {
  const surface = document.createElement('div'),
    canvas = document.createElement('canvas');
  surface.className = 'solid-surface';
  canvas.className = 'overlay';
  host.prepend(surface, canvas);
  const ctx = canvas.getContext('2d');
  let view = {
    target: [25, 20, 0],
    quat: M.quatLooking(...M.STANDARD.home),
    dist: 150,
    fov: 35,
    ortho: true,
  };
  let vp = { w: 1, h: 1 },
    bodies = [],
    pickBodies = [],
    picks = [],
    selected = [],
    hover = null,
    frame = null,
    drawOverlay = null,
    planes = true,
    preview = null,
    queued = false;
  let T, renderer, scene, camera, solids, highlights, toolGroup;
  const cache = new Map();
  const dirty = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(render);
    }
  };
  function geometry(mesh) {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(mesh.positions, 3));
    g.setAttribute('normal', new T.BufferAttribute(mesh.normals, 3));
    g.setIndex(new T.BufferAttribute(mesh.indices, 1));
    return g;
  }
  function free(group) {
    if (!group) return;
    for (const c of [...group.children]) {
      group.remove(c);
      c.geometry?.dispose();
      c.material?.dispose();
    }
  }
  function buildSolids() {
    if (!T) return;
    free(solids);
    free(toolGroup);
    for (const b of bodies) {
      const mesh = new T.Mesh(
        geometry(b.mesh),
        new T.MeshStandardMaterial({
          color: 0xbac8ca,
          metalness: 0.15,
          roughness: 0.55,
          side: T.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        })
      );
      solids.add(mesh);
      const g = new T.BufferGeometry(),
        segments = b.mesh.edgeSegs,
        lines = new Float32Array(segments.reduce((n, v, i) => n + (i % 2 ? v * 3 : 0), 0));
      let cursor = 0;
      for (let i = 0; i < segments.length; i += 2) {
        const n = segments[i + 1] * 3;
        lines.set(b.mesh.edgeLines.subarray(segments[i] * 3, segments[i] * 3 + n), cursor);
        cursor += n;
      }
      g.setAttribute('position', new T.BufferAttribute(lines, 3));
      solids.add(
        new T.LineSegments(
          g,
          new T.LineBasicMaterial({ color: 0x41585d, transparent: true, opacity: 0.72 })
        )
      );
    }
    if (preview) {
      const mesh = new T.Mesh(
        geometry(preview),
        new T.MeshBasicMaterial({
          color: preview.op === 'cut' ? 0xe78a59 : 0x25ad91,
          transparent: true,
          opacity: 0.22,
          depthWrite: false,
          side: T.DoubleSide,
        })
      );
      toolGroup.add(mesh);
    }
    dirty();
  }
  function highlightsNow() {
    if (!T) return;
    free(highlights);
    for (const h of [...selected, ...(hover ? [hover] : [])]) {
      const b = pickBodies.find((b) => b.id === h.body);
      if (!b) continue;
      const m = b.mesh,
        color = h === hover ? 0xf1a449 : 0x05a18b;
      let g = new T.BufferGeometry(),
        object;
      if (h.type === 'face') {
        g.setAttribute('position', new T.BufferAttribute(m.positions, 3));
        const a = m.faceTris[2 * h.face],
          n = m.faceTris[2 * h.face + 1];
        g.setIndex(new T.BufferAttribute(m.indices.slice(a, a + n), 1));
        object = new T.Mesh(
          g,
          new T.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.35,
            side: T.DoubleSide,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
          })
        );
      } else if (h.type === 'edge') {
        const a = m.edgeSegs[2 * h.edge] * 3,
          n = m.edgeSegs[2 * h.edge + 1] * 3;
        g.setAttribute('position', new T.BufferAttribute(m.edgeLines.slice(a, a + n), 3));
        object = new T.LineSegments(g, new T.LineBasicMaterial({ color, depthTest: false }));
      }
      if (object) {
        object.renderOrder = 5;
        highlights.add(object);
      } else g.dispose();
    }
  }
  function line(points, color, width = 1, dash = []) {
    ctx.beginPath();
    points.forEach((p, i) => {
      const s = M.project(view, vp, p);
      if (i) ctx.lineTo(s[0], s[1]);
      else ctx.moveTo(s[0], s[1]);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  function render() {
    queued = false;
    ctx.clearRect(0, 0, vp.w, vp.h);
    if (renderer) {
      const h = view.dist * M.tanHalf(view),
        aspect = vp.w / vp.h,
        near = Math.max(0.001, view.dist / 1000),
        far = Math.max(1000, view.dist * 20);
      camera = view.ortho
        ? new T.OrthographicCamera(-h * aspect, h * aspect, h, -h, near, far)
        : new T.PerspectiveCamera(view.fov, aspect, near, far);
      camera.position.fromArray(M.eye(view));
      camera.quaternion.fromArray(view.quat);
      camera.updateMatrixWorld();
      renderer.render(scene, camera);
    }
    if (frame) {
      const mm = M.mmPerPx(view, vp),
        step = 10 ** Math.floor(Math.log10(mm * 85)),
        a = M.planePoint(view, vp, 0, 0, frame),
        b = M.planePoint(view, vp, vp.w, vp.h, frame);
      if (a && b) {
        const x0 = Math.min(a[0], b[0]),
          x1 = Math.max(a[0], b[0]),
          y0 = Math.min(a[1], b[1]),
          y1 = Math.max(a[1], b[1]);
        for (let x = Math.floor(x0 / step) * step; x <= x1; x += step)
          line(
            [toWorld(frame, [x, y0]), toWorld(frame, [x, y1])],
            Math.abs(x) < 1e-8 ? '#cf9290' : '#dce4e5'
          );
        for (let y = Math.floor(y0 / step) * step; y <= y1; y += step)
          line(
            [toWorld(frame, [x0, y]), toWorld(frame, [x1, y])],
            Math.abs(y) < 1e-8 ? '#88b9a1' : '#dce4e5'
          );
      }
    } else if (planes) {
      for (const [i, name] of ['XY', 'XZ', 'YZ'].entries()) {
        const p = basePlane(name),
          f = canonicalFrame(p.n, p.d),
          coords = [
            [-15, -15],
            [50, -15],
            [50, 50],
            [-15, 50],
            [-15, -15],
          ].map((p) => toWorld(f, p));
        line(coords, ['#a5b6c1', '#b9aaa0', '#a1bfb4'][i], 1, [5, 4]);
        const s = M.project(view, vp, toWorld(f, [50, 50]));
        ctx.fillStyle = '#778a91';
        ctx.font = '11px system-ui';
        ctx.fillText(name, s[0] + 5, s[1]);
      }
    }
    drawOverlay?.(ctx, api);
    const start = [vp.w - 52, vp.h - 49],
      axes = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      colors = ['#c56462', '#469477', '#4c8ec1'];
    const { right, up } = M.basis(view);
    axes.forEach((a, i) => {
      ctx.beginPath();
      ctx.moveTo(...start);
      const end = [start[0] + M.dot(a, right) * 27, start[1] - M.dot(a, up) * 27];
      ctx.lineTo(...end);
      ctx.strokeStyle = colors[i];
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = colors[i];
      ctx.font = 'bold 10px system-ui';
      ctx.fillText('XYZ'[i], end[0] - 3, end[1] - 5);
    });
  }
  function resize() {
    const rect = host.getBoundingClientRect();
    vp = { w: rect.width, h: rect.height };
    const dpr = Math.min(devicePixelRatio, 2);
    canvas.width = Math.round(vp.w * dpr);
    canvas.height = Math.round(vp.h * dpr);
    canvas.style.width = vp.w + 'px';
    canvas.style.height = vp.h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderer?.setSize(vp.w, vp.h);
    dirty();
  }
  function pick(x, y, filter = 'all', hidden = false) {
    const ray = M.ray(view, vp, x, y);
    let face = null,
      edge = null;
    for (let i = 0; i < pickBodies.length; i++) {
      const b = pickBodies[i],
        hit = pickFace(b.mesh, picks[i], ray);
      if (hit && (!face || hit.t < face.t)) face = { type: 'face', body: b.id, ...hit };
    }
    if (filter !== 'face')
      for (let i = 0; i < pickBodies.length; i++) {
        const b = pickBodies[i],
          hit = pickEdge(b.mesh, projectEdges(b.mesh, view, vp), x, y, 8);
        if (!hit) continue;
        const depth = M.dot(M.sub(hit.point, ray.o), ray.d),
          tolerance = Math.max(0.01, M.mmPerPx(view, vp) * 2);
        if (!hidden && face && depth > face.t + tolerance) {
          // At silhouettes a subpixel rounding change can put the ray just inside
          // the solid. Test a tiny neighbourhood of the edge itself, not the mouse.
          const s = M.project(view, vp, hit.point),
            visible = [
              [0.75, 0],
              [-0.75, 0],
              [0, 0.75],
              [0, -0.75],
            ].some(([dx, dy]) => {
              const r = M.ray(view, vp, s[0] + dx, s[1] + dy),
                z = M.dot(M.sub(hit.point, r.o), r.d);
              return !pickBodies.some((body, j) => {
                const h = pickFace(body.mesh, picks[j], r);
                return h && h.t < z - tolerance;
              });
            });
          if (!visible) continue;
        }
        if (!edge || hit.distPx < edge.distPx) edge = { type: 'edge', body: b.id, ...hit };
      }
    return filter === 'edge' ? edge : edge ?? face;
  }
  let navigation = null,
    last = [0, 0];
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    const p = local(e);
    last = p;
    if (e.button === 1 || e.button === 2 || e.altKey) {
      navigation = { pan: e.button === 1 || e.shiftKey || !!frame };
      canvas.setPointerCapture(e.pointerId);
    } else {
      callbacks.down?.(p, e);
      if (e.button === 0) canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (navigation) {
      view = navigation.pan
        ? M.pan(view, vp, p[0] - last[0], p[1] - last[1])
        : M.orbit(view, p[0] - last[0], p[1] - last[1]);
      dirty();
      callbacks.camera?.();
    } else callbacks.move?.(p, e);
    last = p;
  });
  canvas.addEventListener('pointerup', (e) => {
    if (navigation) navigation = null;
    else callbacks.up?.(local(e), e);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointercancel', () => {
    navigation = null;
    callbacks.cancel?.();
  });
  canvas.addEventListener('dblclick', (e) => callbacks.double?.(local(e), e));
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e);
      const v = M.zoomAt(
        view,
        vp,
        ...p,
        Math.exp(Math.max(-200, Math.min(200, e.deltaY)) * 0.0015)
      );
      if (v.dist > 0.01 && v.dist < 1e6) view = v;
      dirty();
      callbacks.camera?.();
    },
    { passive: false }
  );
  function local(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  const api = {
    canvas,
    get vp() {
      return vp;
    },
    get view() {
      return view;
    },
    set view(v) {
      view = v;
      dirty();
    },
    dirty,
    project: (p) => M.project(view, vp, p),
    sketchPoint: (p) => (frame ? M.planePoint(view, vp, ...p, frame) : null),
    screen: (p) => M.project(view, vp, toWorld(frame, p)),
    get mmPerPx() {
      return M.mmPerPx(view, vp);
    },
    get pickBodies() {
      return pickBodies;
    },
    setBodies(bs, tool = null, source = bs) {
      bodies = bs;
      pickBodies = source;
      preview = tool;
      picks = source.map((b) => {
        if (!cache.has(b.key)) cache.set(b.key, buildPickData(b.mesh));
        return cache.get(b.key);
      });
      if (cache.size > 100) cache.clear();
      buildSolids();
      highlightsNow();
      dirty();
    },
    select(hs) {
      selected = hs;
      highlightsNow();
      dirty();
    },
    hover(h) {
      hover = h;
      highlightsNow();
      dirty();
    },
    pick,
    overlay(fn) {
      drawOverlay = fn;
      dirty();
    },
    planes(on) {
      planes = on;
      dirty();
    },
    setFrame(f, box) {
      frame = f;
      if (f) {
        view = { ...M.lookAtFrame(view, f), ortho: true };
        if (box) view = M.fitInPlane(view, vp, f, box);
      }
      dirty();
    },
    standard(name) {
      const q = M.STANDARD[name];
      if (q) {
        view = { ...view, quat: M.quatLooking(...q) };
        dirty();
      }
    },
    fit() {
      if (frame) return;
      const boxes = bodies.map((b) => b.bbox);
      if (!boxes.length) {
        view = { ...view, target: [20, 15, 0], dist: 160 };
      } else {
        const lo = [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b[0][i]))),
          hi = [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b[1][i])));
        view = M.fitSphere(
          view,
          vp,
          M.mul(M.add(lo, hi), 0.5),
          Math.max(1, M.len(M.sub(hi, lo)) / 2)
        );
      }
      dirty();
    },
    fitSketch(box) {
      if (frame) {
        view = M.fitInPlane(view, vp, frame, box);
        dirty();
      }
    },
    toggleProjection() {
      if (!frame) view = { ...view, ortho: !view.ortho };
      dirty();
      return view.ortho;
    },
  };
  new ResizeObserver(resize).observe(host);
  canvas.tabIndex = 0;
  canvas.setAttribute(
    'aria-label',
    'Model viewport. Right drag to orbit; middle drag or Shift-right drag to pan; scroll to zoom.'
  );
  import('https://cdn.jsdelivr.net/npm/three@0.187.0/build/three.module.js')
    .then((three) => {
      T = three;
      renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      surface.append(renderer.domElement);
      scene = new T.Scene();
      scene.add(new T.HemisphereLight(0xffffff, 0x75838c, 2.8));
      for (const [pos, intensity] of [
        [[100, -120, 160], 3],
        [[-80, 40, 90], 1.4],
      ]) {
        const light = new T.DirectionalLight(0xffffff, intensity);
        light.position.fromArray(pos);
        scene.add(light);
      }
      solids = new T.Group();
      highlights = new T.Group();
      toolGroup = new T.Group();
      scene.add(solids, highlights, toolGroup);
      resize();
      buildSolids();
      highlightsNow();
      callbacks.ready?.();
    })
    .catch((e) => callbacks.error?.('The 3D viewport could not start: ' + e.message));
  resize();
  return api;
}

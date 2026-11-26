import * as M from './camera-math.js';
import { buildPickData, pickFace, pickEdge, projectEdges, countHits } from './pick3d.js';
import { halfSpaceIn, rayRange, cutOutline } from './section.js';
import { basePlane, canonicalFrame, toWorld } from '../core/plane.js';
import * as Mat from '../core/mat.js';
import { INK, pill, pillWidth, line as inkLine } from './annotate.js';
import { createXR, xrMode } from './xr.js';

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
    origin = null,
    preview = null,
    ghosts = [],
    inverses = [],
    cut = null, // looking inside: the half of space that is drawn ({ n, d }: every p with n.p <= d), or null
    seeThrough = false, // the solids drawn see-through, every edge showing
    geometries = [], // of the bodies as they are drawn, for their cut surfaces
    marked = [], // numbers and lines in space (labels()), for a headset and for a page that only shows
    markedText = '[]',
    sun = [], // the lights of the screen, which stand where the model stands
    lamp = null, // the light of a room, for a headset: from above, and it stays when the model is turned
    queued = false;
  // world: everything of the model, in mm. On the screen it stands where it is; in a headset it is stood in the room.
  let T, renderer, scene, camera, solids, highlights, toolGroup, cuts, clipPlane, modelClip, world, marks, xr;
  /** How the model is looked into. Neither while a sketch is drawn: there the plane of the sketch is what is looked at. */
  const active = () => (frame ? null : cut),
    through = () => seeThrough && !frame,
    clips = () => (active() ? [clipPlane] : null);
  function aim() {
    // three.js draws where normal.p + constant >= 0; the plane is asked for in the scene's space, and in a
    // headset the model does not stand at the scene's origin
    if (!T || !cut) return;
    modelClip.set(new T.Vector3(-cut.n[0], -cut.n[1], -cut.n[2]), cut.d);
    clipPlane.copy(modelClip);
    if (xr?.active) clipPlane.applyMatrix4(world.matrixWorld);
  }
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
  /** Puts a three.js object where a body stands (b.matrix: twelve numbers, or nothing). */
  function place(object, m) {
    if (m && !Mat.isIdentity(m)) {
      object.matrixAutoUpdate = false;
      object.matrix.fromArray(Mat.toColumns16(m));
      object.matrixWorldNeedsUpdate = true;
    }
    return object;
  }
  function buildSolids() {
    if (!T) return;
    free(solids);
    free(toolGroup);
    geometries = [];
    const xr = through();
    for (const b of bodies) {
      // A body's own colour (b.color), else the plain one; the selected part is tinted towards the accent.
      // Painted faces (b.faceColors: face number -> colour) are drawn through a colour for every vertex:
      // each face has vertices of its own.
      const g0 = geometry(b.mesh),
        tint = (c) => (b.chosen ? c.lerp(new T.Color(0x35b89f), 0.18) : c),
        base = b.color ? tint(new T.Color(b.color)) : new T.Color(b.chosen ? 0xa8d2c8 : b.instance ? 0xb9c4d6 : 0xbac8ca),
        painted = b.faceColors?.size > 0;
      if (painted) {
        const colors = new Float32Array(b.mesh.positions.length),
          I = b.mesh.indices;
        for (let i = 0; i < colors.length; i += 3) colors.set([base.r, base.g, base.b], i);
        for (const [face, hex] of b.faceColors) {
          const c = tint(new T.Color(hex)),
            start = b.mesh.faceTris[2 * face],
            end = start + b.mesh.faceTris[2 * face + 1];
          for (let k = start; k < end; k++) colors.set([c.r, c.g, c.b], I[k] * 3);
        }
        g0.setAttribute('color', new T.BufferAttribute(colors, 3));
      }
      const mesh = new T.Mesh(
        g0,
        new T.MeshStandardMaterial({
          color: painted ? 0xffffff : base,
          vertexColors: painted,
          metalness: 0.15,
          roughness: 0.55,
          side: T.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
          clippingPlanes: clips(),
          transparent: xr,
          opacity: xr ? 0.3 : 1,
          depthWrite: !xr,
        })
      );
      geometries.push(g0);
      solids.add(place(mesh, b.matrix));
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
        place(
          new T.LineSegments(
            g,
            new T.LineBasicMaterial({ color: b.chosen ? 0x0b7f6e : 0x41585d, transparent: true, opacity: b.chosen || xr ? 0.95 : 0.72, clippingPlanes: clips() })
          ),
          b.matrix
        )
      );
    }
    // Parts that are not part of the picture but are being worked with: a tool that was used up.
    for (const b of ghosts)
      toolGroup.add(
        place(
          new T.Mesh(
            geometry(b.mesh),
            new T.MeshBasicMaterial({ color: 0x5b83b8, transparent: true, opacity: 0.2, depthWrite: false, side: T.DoubleSide, clippingPlanes: clips() })
          ),
          b.matrix
        )
      );
    if (preview) {
      const mesh = new T.Mesh(
        geometry(preview),
        new T.MeshBasicMaterial({
          color: preview.op === 'cut' ? 0xe78a59 : 0x25ad91,
          transparent: true,
          opacity: 0.22,
          depthWrite: false,
          side: T.DoubleSide,
          clippingPlanes: clips(),
        })
      );
      toolGroup.add(place(mesh, preview.matrix));
    }
    buildCut();
    dirty();
  }
  /** The cut surfaces of the bodies and their outlines, where the model is cut open. Made again when the cut moves. */
  function buildCut() {
    if (!T) return;
    for (const c of [...cuts.children]) {
      cuts.remove(c);
      if (c.userData.own) c.geometry.dispose(); // the others are the bodies' own geometry
      c.material.dispose();
    }
    const half = active();
    if (!half || !bodies.length) return;
    const boxes = bodies.map((b) => (b.matrix ? Mat.box(b.matrix, b.bbox) : b.bbox)),
      lo = [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b[0][i]))),
      hi = [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b[1][i]))),
      centre = M.mul(M.add(lo, hi), 0.5),
      onPlane = M.sub(centre, M.mul(half.n, M.dot(half.n, centre) - half.d)),
      size = Math.max(10, M.len(M.sub(hi, lo))) * 4,
      turn = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, 1), new T.Vector3(...half.n));
    bodies.forEach((b, i) => {
      // Of the faces that are left of a closed solid, a pixel that looks into the cut has one more
      // turned away from the eye than towards it: counted in the stencil buffer, body by body, and
      // a sheet in the plane is drawn where the count is not nothing.
      const order = 10 + i;
      for (const [side, op] of [
        [T.BackSide, T.IncrementWrapStencilOp],
        [T.FrontSide, T.DecrementWrapStencilOp],
      ]) {
        const counted = new T.Mesh(
          geometries[i],
          new T.MeshBasicMaterial({
            side,
            clippingPlanes: [clipPlane],
            depthWrite: false,
            depthTest: false,
            colorWrite: false,
            stencilWrite: true,
            stencilFunc: T.AlwaysStencilFunc,
            stencilFail: op,
            stencilZFail: op,
            stencilZPass: op,
          })
        );
        counted.renderOrder = order;
        cuts.add(place(counted, b.matrix));
      }
      const sheet = new T.Mesh(
        new T.PlaneGeometry(size, size),
        new T.MeshBasicMaterial({
          // the body's own colour, darker: material that was cut through
          color: new T.Color(b.color ?? (b.chosen ? 0xa8d2c8 : b.instance ? 0xb9c4d6 : 0xbac8ca)).multiplyScalar(0.55),
          side: T.DoubleSide,
          stencilWrite: true,
          stencilRef: 0,
          stencilFunc: T.NotEqualStencilFunc,
          stencilFail: T.ReplaceStencilOp,
          stencilZFail: T.ReplaceStencilOp,
          stencilZPass: T.ReplaceStencilOp,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        })
      );
      sheet.userData.own = true;
      sheet.position.fromArray(onPlane);
      sheet.quaternion.copy(turn);
      sheet.renderOrder = order + 0.5;
      sheet.onAfterRender = (r) => r.clearStencil();
      cuts.add(sheet);
      const outline = cutOutline(b.mesh, halfSpaceIn(half, b.matrix));
      if (outline.length) {
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(outline, 3));
        const lines = new T.LineSegments(g, new T.LineBasicMaterial({ color: 0x1f2f33 }));
        lines.userData.own = true;
        lines.renderOrder = order + 0.6;
        cuts.add(place(lines, b.matrix));
      }
    });
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
            clippingPlanes: clips(),
          })
        );
      } else if (h.type === 'edge') {
        const a = m.edgeSegs[2 * h.edge] * 3,
          n = m.edgeSegs[2 * h.edge + 1] * 3;
        g.setAttribute('position', new T.BufferAttribute(m.edgeLines.slice(a, a + n), 3));
        object = new T.LineSegments(g, new T.LineBasicMaterial({ color, depthTest: false, clippingPlanes: clips() }));
      }
      if (object) {
        object.renderOrder = 5;
        highlights.add(place(object, b.matrix));
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
  /** The numbers and lines in space, as objects of the scene: what a headset shows of them. */
  function buildMarks() {
    if (!T) return;
    for (const c of [...marks.children]) {
      marks.remove(c);
      c.geometry?.dispose();
      c.material.map?.dispose();
      c.material.dispose();
    }
    if (!xr?.active) return;
    for (const m of marked) {
      const style = INK[m.kind] ?? INK.reference;
      if (m.line) {
        const g = new T.BufferGeometry().setFromPoints(m.line.map((p) => new T.Vector3(...p))),
          object = new T.Line(g, new T.LineBasicMaterial({ color: style.ink, depthTest: false, transparent: true }));
        object.renderOrder = 20;
        marks.add(object);
      } else if (m.text) {
        const plate = document.createElement('canvas'),
          c = plate.getContext('2d'),
          k = 4,
          w = pillWidth(c, m.text) + 4;
        plate.width = Math.ceil(w * k);
        plate.height = 22 * k;
        c.scale(k, k);
        pill(c, m.text, w / 2, 11, style);
        const sprite = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(plate), depthTest: false, transparent: true }));
        sprite.position.set(...m.at);
        sprite.userData.aspect = w / 22;
        sprite.renderOrder = 21;
        marks.add(sprite);
      }
    }
  }
  /** The same on the screen, for a page that has no drawing of its own. */
  function drawMarks() {
    const S = (p) => M.project(view, vp, p);
    for (const m of marked) if (m.line) inkLine(ctx, m.line.map(S), INK[m.kind] ?? INK.reference, { width: m.width ?? 1.4, ticks: m.ticks ?? [], dash: m.dash ?? [] });
    for (const m of marked)
      if (m.text) {
        const s = S(m.at);
        pill(ctx, m.text, s[0], s[1] - (m.lift ?? 0), INK[m.kind] ?? INK.reference);
      }
  }
  function render() {
    queued = false;
    if (xr?.active) return; // the headset draws, frame by frame
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
          f = origin ? Mat.frame(origin, canonicalFrame(p.n, p.d)) : canonicalFrame(p.n, p.d),
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
    if (callbacks.marks) drawMarks();
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
    if (!xr?.active) renderer?.setSize(vp.w, vp.h);
    dirty();
  }
  /** A ray of the world in the frame of body i (placements are rigid: distances along it are the same). */
  const rayIn = (i, ray) => (inverses[i] ? { o: Mat.point(inverses[i], ray.o), d: Mat.dir(inverses[i], ray.d) } : ray);
  /** What is under a pixel. A hit's `point` is in the frame of the body's part (where its faces
   *  and references are); `world` is the same point in space; `key` names the exact geometry the
   *  face or edge number belongs to (it is another body's once the model is rebuilt). */
  /** What a ray meets first of what is drawn: a face ({ i, face, t, point }, i the body's number and
   *  point in its frame), or where the model is cut open the cut surface of a body ({ i, cut: true, t });
   *  null when it meets nothing. */
  function first(ray) {
    const half = active();
    let t0 = 0,
      t1 = Infinity;
    if (half) {
      const range = rayRange(half, ray);
      if (!range) return null;
      [t0, t1] = range;
      // Coming into what is left from inside a solid: what is seen there is its cut surface.
      if (t0 > 0)
        for (let i = 0; i < pickBodies.length; i++)
          if (countHits(pickBodies[i].mesh, picks[i], rayIn(i, ray), t0) % 2) return { i, cut: true, t: t0 };
    }
    const from = t0 > 0 ? { o: M.add(ray.o, M.mul(ray.d, t0)), d: ray.d } : ray;
    let best = null;
    for (let i = 0; i < pickBodies.length; i++) {
      const hit = pickFace(pickBodies[i].mesh, picks[i], rayIn(i, from), t1 - t0);
      if (hit && (!best || hit.t + t0 < best.t)) best = { i, ...hit, t: hit.t + t0 };
    }
    return best;
  }
  /** cam: another camera than the view's own ({ view, vp }): a hand's ray in a headset, or the camera of a page that only shows. */
  function pick(x, y, filter = 'all', hidden = false, cam = null) {
    const view = cam?.view ?? api.view, // eslint-disable-line no-shadow
      vp = cam?.vp ?? api.vp; // eslint-disable-line no-shadow
    const ray = M.ray(view, vp, x, y),
      half = active(),
      front = first(ray);
    let face = null,
      edge = null;
    if (front && !front.cut) {
      const b = pickBodies[front.i];
      face = {
        type: 'face',
        body: b.id,
        key: b.key,
        face: front.face,
        t: front.t,
        point: front.point,
        world: b.matrix ? Mat.point(b.matrix, front.point) : front.point,
      };
    }
    if (filter !== 'face')
      for (let i = 0; i < pickBodies.length; i++) {
        const b = pickBodies[i],
          hit = pickEdge(b.mesh, projectEdges(b.mesh, view, vp, b.matrix), x, y, 8, half && halfSpaceIn(half, b.matrix));
        if (!hit) continue;
        const world = b.matrix ? Mat.point(b.matrix, hit.point) : hit.point,
          depth = M.dot(M.sub(world, ray.o), ray.d),
          tolerance = Math.max(0.01, M.mmPerPx(view, vp) * 2);
        // See-through, every edge is seen. Otherwise an edge behind what the ray meets first is hidden.
        if (!hidden && !through() && front && depth > front.t + tolerance) {
          // At silhouettes a subpixel rounding change can put the ray just inside
          // the solid. Test a tiny neighbourhood of the edge itself, not the mouse.
          const s = M.project(view, vp, world),
            visible = [
              [0.75, 0],
              [-0.75, 0],
              [0, 0.75],
              [0, -0.75],
            ].some(([dx, dy]) => {
              const r = M.ray(view, vp, s[0] + dx, s[1] + dy),
                z = M.dot(M.sub(world, r.o), r.d),
                f = first(r);
              return !f || f.t >= z - tolerance;
            });
          if (!visible) continue;
        }
        if (!edge || hit.distPx < edge.distPx) edge = { type: 'edge', body: b.id, key: b.key, ...hit, world };
      }
    return filter === 'edge' ? edge : edge ?? face;
  }
  let navigation = null,
    pressed = null, // on a page that only shows (callbacks.viewer): where the button went down; dragging from there turns the model
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
      if (e.button === 0) {
        canvas.setPointerCapture(e.pointerId);
        if (callbacks.viewer) pressed = p;
      }
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (!navigation && pressed && Math.hypot(p[0] - pressed[0], p[1] - pressed[1]) > 5) navigation = { pan: e.shiftKey };
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
    pressed = null;
    if (navigation) navigation = null;
    else callbacks.up?.(local(e), e);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointercancel', () => {
    navigation = null;
    pressed = null;
    callbacks.cancel?.();
  });
  canvas.addEventListener('pointerleave', () => callbacks.leave?.());
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
    /** Where a point of space is on the screen. The answer remembers the point (`w`), so that what is drawn
     *  there can also be put into space (annotate.js). */
    project: (p) => {
      const s = M.project(view, vp, p);
      s.w = p;
      return s;
    },
    sketchPoint: (p) => (frame ? M.planePoint(view, vp, ...p, frame) : null),
    screen: (p) => M.project(view, vp, toWorld(frame, p)),
    get mmPerPx() {
      return M.mmPerPx(view, vp);
    },
    get pickBodies() {
      return pickBodies;
    },
    /** bs: what is drawn; source: what can be picked (the model before a feature, while it is
     *  edited). Each body may have `matrix`: where it stands (twelve numbers, core/mat.js).
     *  tool: a translucent solid of the feature being edited; extra: translucent parts beside the picture. */
    setBodies(bs, tool = null, source = bs, extra = []) {
      bodies = bs;
      pickBodies = source;
      preview = tool;
      ghosts = extra;
      inverses = source.map((b) => (b.matrix && !Mat.isIdentity(b.matrix) ? Mat.invert(b.matrix) : null));
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
    /** Cuts the model open for looking inside: what is drawn, and what can be pointed at, is every
     *  point p with n.p <= d of half = { n, d } (section.js), with the cut surfaces filled in. null: whole again. */
    section(half) {
      const was = !!cut;
      cut = half;
      aim();
      if (was !== !!cut) buildSolids();
      else buildCut();
      highlightsNow();
      dirty();
    },
    /** Draws the solids see-through, with every edge showing (and every edge can then be pointed at). */
    xray(on) {
      if (seeThrough === !!on) return;
      seeThrough = !!on;
      buildSolids();
      highlightsNow();
      dirty();
    },
    /** The body whose cut surface is under a pixel (its id), or null. */
    cutAt(x, y, cam = null) {
      const f = first(M.ray(cam?.view ?? view, cam?.vp ?? vp, x, y));
      return f?.cut ? pickBodies[f.i].id : null;
    },
    overlay(fn) {
      drawOverlay = fn;
      dirty();
    },
    /** Draws what is drawn over the model now, not at the next frame: in a headset there is no next frame of the screen. */
    redraw() {
      ctx.clearRect(0, 0, vp.w, vp.h);
      drawOverlay?.(ctx, api);
    },
    /** Numbers and lines in space: [{ line: [[x, y, z], ...], kind, width?, ticks?, dash? } | { text, at: [x, y, z], kind, lift? }],
     *  kind one of annotate.js's INK. A headset shows them; so does the screen of a page made with `marks: true`. */
    labels(list) {
      const text = JSON.stringify(list ?? []);
      if (text === markedText) return; // the same again, as while a hand rests: nothing is made anew
      markedText = text;
      marked = list ?? [];
      buildMarks();
      dirty();
    },
    /** The headset: mode() says how this browser can show the model in one ('immersive-ar', 'immersive-vr' or null). */
    xr: {
      mode: () => xrMode(),
      enter: async () => {
        if (!xr) throw new Error('The 3D view has not started yet.');
        const mode = await xr.enter();
        for (const light of sun) light.visible = false;
        lamp.visible = true;
        aim();
        buildMarks();
        return mode;
      },
      exit: () => xr?.exit(),
      get active() {
        return !!xr?.active;
      },
      get scale() {
        return xr?.scale ?? '1 : 1';
      },
    },
    planes(on) {
      planes = on;
      dirty();
    },
    /** Where the origin planes are drawn: the placement of the part whose planes they are (or nothing). */
    origin(at) {
      origin = at && !Mat.isIdentity(at) ? at : null;
      dirty();
    },
    setFrame(f, box) {
      frame = f;
      if (f) {
        view = { ...M.lookAtFrame(view, f), ortho: true };
        if (box) view = M.fitInPlane(view, vp, f, box);
      }
      if (cut || seeThrough) {
        // neither is shown while a sketch is drawn
        buildSolids();
        highlightsNow();
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
      const boxes = bodies.map((b) => (b.matrix ? Mat.box(b.matrix, b.bbox) : b.bbox));
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
    /** The view as one picture: the solids and what is drawn over them, on `background`. */
    snapshot(background = '#edf2f2') {
      render(); // now: a WebGL canvas can only be read in the same task that drew it
      const out = document.createElement('canvas');
      out.width = canvas.width;
      out.height = canvas.height;
      const g = out.getContext('2d');
      g.fillStyle = background;
      g.fillRect(0, 0, out.width, out.height);
      if (renderer) g.drawImage(renderer.domElement, 0, 0, out.width, out.height);
      g.drawImage(canvas, 0, 0);
      return out;
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
      renderer = new T.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
      renderer.localClippingEnabled = true;
      clipPlane = new T.Plane();
      modelClip = new T.Plane();
      aim();
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
        sun.push(light);
      }
      lamp = new T.DirectionalLight(0xffffff, 3);
      lamp.position.set(0.6, 2, 1); // a headset's space has Y up
      lamp.visible = false;
      scene.add(lamp);
      solids = new T.Group();
      highlights = new T.Group();
      toolGroup = new T.Group();
      cuts = new T.Group();
      marks = new T.Group();
      world = new T.Group();
      world.add(solids, cuts, highlights, toolGroup, marks);
      scene.add(world);
      xr = createXR({
        T,
        renderer,
        scene,
        world,
        hooks: {
          box() {
            const boxes = bodies.map((b) => (b.matrix ? Mat.box(b.matrix, b.bbox) : b.bbox));
            return boxes.length ? [[0, 1, 2].map((i) => Math.min(...boxes.map((b) => b[0][i]))), [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b[1][i])))] : null;
          },
          first,
          frame(head, factor) {
            if (cut) clipPlane.copy(modelClip).applyMatrix4(world.matrixWorld);
            // a number is as big to the eye wherever it stands: about a degree and a half high
            const at = new T.Vector3();
            for (const m of marks.children)
              if (m.isSprite) {
                const h = Math.min(0.2, Math.max(0.004, m.getWorldPosition(at).distanceTo(head) * 0.028)) / factor;
                m.scale.set(h * m.userData.aspect, h, 1);
              }
          },
          point: (cam) => callbacks.xrPoint?.(cam),
          click: (cam, e) => callbacks.xrClick?.(cam, e),
          section: (s) => callbacks.xrSection?.(s),
          button: (name) => callbacks.xrButton?.(name),
          ended() {
            for (const light of sun) light.visible = true;
            lamp.visible = false;
            aim();
            buildMarks();
            resize();
            callbacks.xrEnded?.();
          },
        },
      });
      resize();
      buildSolids();
      highlightsNow();
      callbacks.ready?.();
    })
    .catch((e) => callbacks.error?.('The 3D viewport could not start: ' + e.message));
  resize();
  return api;
}

// The model in a headset (WebXR): the same scene as on the screen, standing in the room at its real
// size. Hands hold it, turn it and size it; a hand points at a face or an edge as the mouse does; a
// hand cuts it open. Nothing here knows about documents or features: what is pointed at and clicked
// is handed on as a camera that looks along the hand's ray (camera-math.js, rayCamera), and the
// page picks with it exactly as it picks under the mouse.
//
//   trigger          point and choose (the other trigger held: one more, as Shift does)
//   grip             take hold of the model; both grips: size it and turn it between the hands
//   stick up, down   bigger, smaller, about the hand
//   stick pressed    back to its real size, in front of you
//   A or X held      cut the model open along the hand; tapped: whole again
//   B or Y           see-through, and back
import * as M from './camera-math.js';

/** A millimetre of the model is a millimetre of the room. */
export const XR_SCALE = 0.001;

/** How this browser can show it: 'immersive-ar' (the room is seen round the model), 'immersive-vr', or null. */
export async function xrMode(xr = globalThis.navigator?.xr) {
  if (!xr?.isSessionSupported) return null;
  for (const mode of ['immersive-ar', 'immersive-vr']) {
    try {
      if (await xr.isSessionSupported(mode)) return mode;
    } catch {
      /* not allowed here */
    }
  }
  return null;
}

/**
 * The cut a hand makes: along the origin plane that the hand's flat lies nearest to, where the hand is,
 * and with the side the head is on taken away. All three in the model's own space, in mm.
 * @param {number[]} blade  the normal of the flat of the hand
 * @param {number[]} tip    where the hand is
 * @param {number[]} eye    where the head is
 * @returns {{ plane: 'XY'|'XZ'|'YZ', at: number, flip: boolean }} as view/section.js has it
 */
export function knifeSection(blade, tip, eye) {
  const axis = [0, 1, 2].reduce((best, i) => (Math.abs(blade[i]) > Math.abs(blade[best]) ? i : best), 0),
    at = Math.round(tip[axis]);
  // not flipped, what is left is everything up to `at` along the axis: right when the head is beyond it
  return { plane: ['YZ', 'XZ', 'XY'][axis], at, flip: eye[axis] < at };
}

/** Where the model stands when two hands that held it at a0 and b0 are at a1 and b1: moved, turned and sized with them. */
export function twoHands(T, start, a0, b0, a1, b1) {
  const v0 = b0.clone().sub(a0),
    v1 = b1.clone().sub(a1),
    s = v1.length() / Math.max(1e-6, v0.length()),
    q = new T.Quaternion().setFromUnitVectors(v0.clone().normalize(), v1.clone().normalize()),
    m0 = a0.clone().add(b0).multiplyScalar(0.5),
    m1 = a1.clone().add(b1).multiplyScalar(0.5);
  return new T.Matrix4()
    .makeTranslation(m1.x, m1.y, m1.z)
    .multiply(new T.Matrix4().makeRotationFromQuaternion(q))
    .multiply(new T.Matrix4().makeScale(s, s, s))
    .multiply(new T.Matrix4().makeTranslation(-m0.x, -m0.y, -m0.z))
    .multiply(start);
}

/** Where the model stands at first: its middle `ahead` metres in front of the head and a little below it, upright
 *  (the model's Z is up), its front (-Y) towards the person, at its real size. box: [[lo], [hi]] in mm, or null. */
export function standing(T, box, head, forward) {
  const lo = box?.[0] ?? [-10, -10, 0],
    hi = box?.[1] ?? [10, 10, 10],
    centre = new T.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2),
    size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * XR_SCALE,
    up = new T.Vector3(0, 1, 0),
    f = new T.Vector3(forward.x, 0, forward.z);
  if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
  f.normalize();
  const at = head.clone().addScaledVector(f, Math.max(0.45, size * 0.9 + 0.3));
  at.y = Math.max(0.5, head.y - 0.3);
  const m = new T.Matrix4().makeBasis(new T.Vector3().crossVectors(f, up), f, up).scale(new T.Vector3(XR_SCALE, XR_SCALE, XR_SCALE));
  const moved = centre.applyMatrix4(m);
  return m.setPosition(at.sub(moved));
}

/** How big the model is in the room, as a person says it: "1 : 1", "2 : 1" (twice its size), "1 : 4". */
export function scaleText(factor) {
  const k = factor / XR_SCALE,
    r = (v) => +v.toFixed(v < 10 ? 1 : 0);
  return Math.abs(k - 1) < 1e-6 ? '1 : 1' : k > 1 ? `${r(k)} : 1` : `1 : ${r(1 / k)}`;
}

/**
 * @param {object} o
 * @param {object} o.T         three.js
 * @param {object} o.renderer  its WebGLRenderer
 * @param {object} o.scene     the scene; the hands are put into it
 * @param {object} o.world     the group that holds the model, in mm: it is stood in the room here
 * @param {object} o.hooks     box(): the model's box in mm or null; first(ray): what a ray of the model's space meets
 *                             ({ t } in mm) or null; frame(head, factor): every frame, after the model is placed;
 *                             point(cam | null), click(cam, { shiftKey }), section(section | null), button(name),
 *                             ended(): what the hands do, for the page
 */
export function createXR({ T, renderer, scene, world, hooks }) {
  let session = null,
    placed = false,
    pointer = 1,
    lastPoint = 0,
    lastCut = 0,
    lastTime = 0,
    pointedAt = null, // where the ray of the pointing hand was, a metre along it, when it was last told
    hold = null; // { hands: [i] | [i, j], start: Matrix4, a0, b0 } while the model is held
  const camera = new T.PerspectiveCamera(60, 1, 0.02, 60),
    hands = [],
    tmp = new T.Vector3();

  const factor = () => tmp.setFromMatrixColumn(world.matrix, 0).length();
  const setWorld = (m) => {
    world.matrix.copy(m);
    world.matrixWorldNeedsUpdate = true;
  };
  /** A hand's ray in the room: where it starts and which way it goes. */
  function rayOf(hand) {
    const o = new T.Vector3().setFromMatrixPosition(hand.ray.matrixWorld),
      d = new T.Vector3(0, 0, -1).transformDirection(hand.ray.matrixWorld);
    return { o, d };
  }
  /** The same ray in the model's own space (mm), as the camera that looks along it. */
  function camOf(hand) {
    const inverse = new T.Matrix4().copy(world.matrixWorld).invert(),
      { o, d } = rayOf(hand);
    o.applyMatrix4(inverse);
    d.transformDirection(inverse);
    return M.rayCamera(o.toArray(), d.toArray());
  }
  const pulse = (hand, strength = 0.4, ms = 25) => {
    try {
      hand.source?.gamepad?.hapticActuators?.[0]?.pulse(strength, ms);
    } catch {
      /* no motor in it */
    }
  };
  /** Sized to its real size when it is nearly that, about a point of the room. */
  function snap(about, hand) {
    const k = factor() / XR_SCALE;
    if (Math.abs(k - 1) > 0.04 || Math.abs(k - 1) < 1e-9) return;
    const s = 1 / k,
      m = new T.Matrix4().makeTranslation(about.x, about.y, about.z).multiply(new T.Matrix4().makeScale(s, s, s)).multiply(new T.Matrix4().makeTranslation(-about.x, -about.y, -about.z));
    setWorld(m.multiply(world.matrix));
    if (hand) pulse(hand, 0.7, 40);
  }
  function grab() {
    const held = hands.filter((h) => h.grip);
    if (!held.length) {
      if (hold) snap(new T.Vector3().setFromMatrixPosition(hands[hold.hands[0]].ray.matrixWorld), hands[hold.hands[0]]);
      hold = null;
      return;
    }
    const at = held.map((h) => new T.Vector3().setFromMatrixPosition(h.ray.matrixWorld));
    hold =
      held.length === 2
        ? { hands: held.map((h) => h.i), start: world.matrix.clone(), a0: at[0], b0: at[1] }
        : { hands: [held[0].i], start: new T.Matrix4().copy(held[0].ray.matrixWorld).invert().multiply(world.matrix) };
  }

  function makeHands() {
    for (let i = 0; i < 2; i++) {
      const ray = renderer.xr.getController(i),
        line = new T.Line(
          new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0, 0), new T.Vector3(0, 0, -1)]),
          new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 })
        ),
        dot = new T.Mesh(new T.SphereGeometry(0.0035, 12, 8), new T.MeshBasicMaterial({ color: 0xf1a449, depthTest: false })),
        hand = { i, ray, line, dot, source: null, trigger: false, grip: false, was: {}, cutFrom: 0, reach: 1.5, hit: false, met: 0 };
      dot.renderOrder = 30;
      dot.visible = false;
      ray.add(line);
      scene.add(ray, dot);
      ray.addEventListener('connected', (e) => {
        hand.source = e.data;
        if (e.data?.handedness === 'right') pointer = i;
      });
      ray.addEventListener('disconnected', () => {
        hand.source = null;
        hand.trigger = hand.grip = false;
        grab();
      });
      ray.addEventListener('selectstart', () => {
        hand.trigger = true;
        pointer = i;
        hooks.click?.(camOf(hand), { shiftKey: hands.some((h) => h !== hand && h.trigger) });
        pulse(hand);
      });
      ray.addEventListener('selectend', () => (hand.trigger = false));
      ray.addEventListener('squeezestart', () => {
        hand.grip = true;
        grab();
      });
      ray.addEventListener('squeezeend', () => {
        hand.grip = false;
        grab();
      });
      hands.push(hand);
    }
  }

  /** The buttons and the stick of a hand, once a frame. */
  function controls(hand, time, dt, head) {
    const pad = hand.source?.gamepad;
    if (!pad) return;
    const down = (n) => !!pad.buttons[n]?.pressed,
      now = { stick: down(3), cut: down(4), through: down(5) },
      at = new T.Vector3().setFromMatrixPosition(hand.ray.matrixWorld);
    if (now.stick && !hand.was.stick) placed = false; // stood in front again, at its real size
    if (now.through && !hand.was.through) hooks.button?.('xray');
    if (now.cut && !hand.was.cut) hand.cutFrom = time;
    if (now.cut && time - hand.cutFrom > 250 && time - lastCut > 60) {
      lastCut = time;
      const inverse = new T.Matrix4().copy(world.matrixWorld).invert(),
        blade = new T.Vector3(1, 0, 0).transformDirection(hand.ray.matrixWorld).transformDirection(inverse),
        tip = at.clone().applyMatrix4(inverse),
        eye = head.clone().applyMatrix4(inverse);
      hooks.section?.(knifeSection(blade.toArray(), tip.toArray(), eye.toArray()));
    }
    if (!now.cut && hand.was.cut && time - hand.cutFrom <= 250) hooks.section?.(null); // a tap: whole again
    hand.was = now;
    // the stick: bigger and smaller, about the hand
    const y = pad.axes.length >= 4 ? pad.axes[3] : pad.axes[1] ?? 0;
    if (Math.abs(y) > 0.25 && !hold) {
      const before = factor(),
        s = Math.min(50 * XR_SCALE, Math.max(0.05 * XR_SCALE, before * Math.exp(-y * dt * 1.4))) / before,
        m = new T.Matrix4().makeTranslation(at.x, at.y, at.z).multiply(new T.Matrix4().makeScale(s, s, s)).multiply(new T.Matrix4().makeTranslation(-at.x, -at.y, -at.z));
      setWorld(m.multiply(world.matrix));
      hand.sized = time;
    } else if (hand.sized && time - hand.sized > 150) {
      hand.sized = 0;
      snap(at, hand);
    }
  }

  function frame(time, xrFrame) {
    if (!session) return;
    const space = renderer.xr.getReferenceSpace(),
      pose = space && xrFrame?.getViewerPose(space);
    if (!pose) return;
    const p = pose.transform.position,
      o = pose.transform.orientation,
      head = new T.Vector3(p.x, p.y, p.z),
      dt = Math.min(0.1, (time - lastTime) / 1000 || 0);
    lastTime = time;
    if (!placed) {
      setWorld(standing(T, hooks.box?.(), head, new T.Vector3(0, 0, -1).applyQuaternion(new T.Quaternion(o.x, o.y, o.z, o.w))));
      placed = true;
      hold = null;
    }
    for (const hand of hands) hand.ray.updateMatrixWorld(true);
    for (const hand of hands) controls(hand, time, dt, head);
    if (hold?.hands.length === 2) {
      const [a, b] = hold.hands.map((i) => new T.Vector3().setFromMatrixPosition(hands[i].ray.matrixWorld));
      setWorld(twoHands(T, hold.start, hold.a0, hold.b0, a, b));
    } else if (hold) setWorld(new T.Matrix4().copy(hands[hold.hands[0]].ray.matrixWorld).multiply(hold.start));
    world.updateMatrixWorld(true);
    const size = factor();
    hooks.frame?.(head, size);
    // what each hand's ray meets, and what the pointing hand points at
    for (const hand of hands) {
      const seen = !!hand.source && !hand.grip;
      hand.line.visible = seen;
      hand.dot.visible = false;
      if (!seen) continue;
      const cam = camOf(hand),
        { o: from, d } = rayOf(hand);
      // A headset has a small processor and many frames to draw: what the ray meets is looked for twenty
      // times a second, and what is pointed at eight times, and then only when the hand has moved.
      if (time - hand.met > 50) {
        hand.met = time;
        const hit = hooks.first?.(M.ray(cam.view, cam.vp, ...cam.p));
        hand.hit = !!hit;
        hand.reach = hit ? hit.t * size : 1.5;
      }
      hand.line.scale.z = Math.min(3, hand.reach);
      if (hand.hit) {
        hand.dot.position.copy(from).addScaledVector(d, hand.reach);
        hand.dot.visible = true;
      }
      if (hand.i === pointer && time - lastPoint > 120) {
        const o = cam.view.target,
          moved = !pointedAt || Math.hypot(o[0] - pointedAt[0], o[1] - pointedAt[1], o[2] - pointedAt[2]) > 3; // mm, a metre along the ray: 0.2 degrees
        if (moved) {
          lastPoint = time;
          pointedAt = o;
          hooks.point?.(cam);
        }
      }
    }
    if (!hands[pointer]?.source && pointedAt && time - lastPoint > 400) {
      lastPoint = time;
      pointedAt = null;
      hooks.point?.(null);
    }
    renderer.render(scene, camera);
  }

  async function enter() {
    if (session) return;
    const mode = await xrMode();
    if (!mode) throw new Error('This browser cannot show the model in a headset.');
    const made = await navigator.xr.requestSession(mode, { optionalFeatures: ['local-floor', 'hand-tracking'] });
    if (!hands.length) makeHands();
    made.addEventListener('end', () => {
      session = null;
      hold = null;
      renderer.setAnimationLoop(null);
      renderer.xr.enabled = false;
      world.matrix.identity();
      world.matrixWorldNeedsUpdate = true;
      for (const hand of hands) hand.dot.visible = hand.line.visible = false;
      hooks.ended?.();
    });
    // The loop is given before the session: three.js stops the screen's own frames when a session starts,
    // and would start them again for a loop that is given afterwards.
    renderer.xr.enabled = true;
    renderer.setAnimationLoop(frame);
    renderer.xr.setReferenceSpaceType('local-floor');
    session = made;
    placed = false;
    pointedAt = null;
    world.matrixAutoUpdate = false;
    try {
      await renderer.xr.setSession(made);
    } catch (e) {
      try {
        await made.end();
      } catch {
        /* it never began */
      }
      if (session) {
        session = null;
        renderer.setAnimationLoop(null);
        renderer.xr.enabled = false;
      }
      throw e;
    }
    return mode;
  }

  return {
    enter,
    exit: () => session?.end(),
    get active() {
      return !!session;
    },
    /** How big the model stands in the room: 'in "2 : 1"' words. */
    get scale() {
      return scaleText(factor());
    },
  };
}

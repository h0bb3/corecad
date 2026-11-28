import { FeatureError } from '../core/errors.js';
import { validateFeature, extentInterval } from '../doc/features.js';
import { frameOfSketch, resolveFaceRef, resolveEdgeRef } from '../doc/refs.js';
import { findRegions, resolveProfile } from '../sketch/profiles.js';
import { indexSketch } from '../sketch/model.js';
import { canonicalFrame, toWorld } from '../core/plane.js';
import { sub, mul, dot } from '../core/vec.js';
import { prism, revolved, screwed, stepSolids, isValid, boolean, cylinder, blend, edgesOf, bounds, volume, countSolids, boxSolid, cylinderSolid, sphereSolid, placed } from './shapes.js';
import { topoOf } from './topo.js';
import { errorText, isFatal } from './occ.js';

export const emptyState = () => ({ bodies: [], sketches: new Map() });
const fail = (code, message, data) => {
  throw new FeatureError(code, message, data);
};
function corners(box) {
  return [0, 1].flatMap((i) =>
    [0, 1].flatMap((j) => [0, 1].map((k) => [box[i][0], box[j][1], box[k][2]]))
  );
}
function spanOf(bodies, frame, direction) {
  const values = bodies.flatMap((b) =>
    corners(bounds(b.shape)).map((c) => dot(sub(c, frame.o), direction))
  );
  return values.length ? [Math.min(...values), Math.max(...values)] : [0, 0];
}
function reached(a, b) {
  const x = bounds(a.shape),
    y = bounds(b.shape);
  return [0, 1, 2].every((i) => x[0][i] <= y[1][i] + 1e-6 && x[1][i] >= y[0][i] - 1e-6);
}
const changedVolume = (a, b) =>
  Math.abs(volume(a.shape) - volume(b.shape)) > 1e-7 * Math.max(1, Math.abs(volume(a.shape)));

const WORDS = {
  extrude: {
    madeBody: 'The extrusion touches no target body. A new body was created.',
    removesAll: 'This cut would remove an entire body. Reduce the size or depth.',
    empty: 'The selected profiles and bodies have no common volume.',
    noEffect: 'The cut does not remove material from any target body.',
  },
  revolve: {
    madeBody: 'The revolve touches no target body. A new body was created.',
    removesAll: 'This cut would remove an entire body. Reduce the profile.',
    empty: 'The revolved profiles and the bodies have no common volume.',
    noEffect: 'The cut does not remove material from any target body.',
  },
  combine: {
    madeBody: 'The parts do not touch. They are kept as separate bodies of this part.',
    removesAll: 'This cut would remove the whole part. Move or shrink the part that cuts.',
    empty: 'The parts have no common volume.',
    noEffect: 'The cut does not remove material: the parts do not overlap.',
  },
};
/** A tool solid applied to bodies: the one rule for extrusions and for combining parts. */
function applyTool(fid, operation, all, targets, tool, own, body, words) {
  let bodies = [...all],
    result = {};
  if (operation === 'new') bodies.push(body(fid, tool));
  else if (operation === 'join') {
    const tried = new Map(); // the join with each target is worked out once: a thread takes seconds
    const merges = targets.filter((t) => {
      if (!reached(t, tool)) return false;
      const fused = own(boolean('fuse', t, tool, fid));
      tried.set(t, fused);
      return countSolids(fused.shape) < countSolids(t.shape) + countSolids(tool.shape);
    });
    if (!merges.length) {
      bodies.push(body(fid, tool));
      result = { code: 'join-made-body', message: words.madeBody };
    } else {
      let acc = tool;
      for (const t of merges) acc = acc === tool ? tried.get(t) : own(boolean('fuse', t, acc, fid));
      const id = merges[0].id,
        ids = new Set(merges.map((b) => b.id));
      bodies = bodies.flatMap((b) => (b.id === id ? [body(id, acc)] : ids.has(b.id) ? [] : [b]));
    }
  } else {
    let changed = 0;
    for (const target of targets) {
      if (!reached(target, tool)) continue;
      const next = own(boolean(operation === 'cut' ? 'cut' : 'common', target, tool, fid));
      if (!countSolids(next.shape)) {
        if (operation === 'cut') fail('removes-all', words.removesAll);
        continue;
      }
      if (!changedVolume(target, next) && operation === 'cut') continue;
      bodies = bodies.map((b) => (b.id === target.id ? body(b.id, next) : b));
      changed++;
    }
    if (!changed) {
      if (operation === 'intersect') fail('empty-result', words.empty);
      result = { code: 'no-effect', message: words.noEffect };
    }
  }
  return { bodies, result };
}

/** The closed areas a feature names in its sketch, as they are now. */
function regionsOf(f, sk, what) {
  let guessed = false;
  const regions = [
    ...new Set(
      f.profiles.map((ref) => {
        const r = resolveProfile(sk.regions, ref);
        if (!r) fail('profile-lost', `A selected profile no longer exists. Edit the ${what} to choose its closed areas.`);
        guessed ||= r.status === 'guessed';
        return r.region;
      })
    ),
  ];
  if (!regions.length) fail('profile-empty', 'Choose a closed area of the sketch.');
  return { regions, guessed };
}
/** The lines of a sketch by id, each as its two ends in the sketch plane: what a revolve can turn about. */
function linesOf(f) {
  const ix = indexSketch(f),
    out = new Map();
  for (const e of f.entities) {
    if (e.type !== 'line') continue;
    const a = ix.point(e.a),
      b = ix.point(e.b);
    if (a && b) out.set(e.id, [[a.x, a.y], [b.x, b.y]]);
  }
  return out;
}

/** Each feature is atomic: only the returned state is installed by the engine. */
export function evaluate(f, state, ctx) {
  const errors = validateFeature(f);
  if (errors.length) fail('bad-param', errors[0]);
  const own = ctx.own,
    body = (id, shape) => Object.assign(shape, { id, key: ctx.key + ':' + id });
  const topologies = () => state.bodies.map(topoOf);
  if (f.type === 'sketch') {
    const frame = frameOfSketch(f, topologies());
    if (frame.status === 'lost')
      fail(
        'plane-lost',
        'The face this sketch was drawn on no longer exists. Restore it upstream or redefine the sketch plane.'
      );
    const sketches = new Map(state.sketches),
      regions = findRegions(f);
    sketches.set(f.id, { frame: frame.frame, regions, lines: linesOf(f) });
    return {
      state: { ...state, sketches },
      result: {
        frame: frame.frame,
        ...(frame.status === 'ambiguous'
          ? {
              code: 'ref-ambiguous',
              message:
                'The supporting face split into different planes. The nearest labelled plane is used.',
            }
          : {}),
      },
    };
  }
  if (f.type === 'extrude') {
    const sk = state.sketches.get(f.sketch);
    if (!sk)
      fail('sketch-error', 'The extrusion sketch is missing, suppressed or could not be built.');
    const { regions, guessed } = regionsOf(f, sk, 'extrusion');
    const targets = state.bodies.filter((b) => f.targets === null || f.targets.includes(b.id));
    if (!targets.length && ['cut', 'intersect'].includes(f.operation))
      fail('no-target', 'There is no body to cut or intersect.');
    const dir = mul(sk.frame.n, f.flip ? -1 : 1),
      [lo, hi] = extentInterval(f.extent, spanOf(targets, sk.frame, dir));
    const a = f.flip ? -hi : lo,
      b = f.flip ? -lo : hi,
      roles = f.flip ? ['end', 'start'] : ['start', 'end'];
    let tool = null;
    for (const region of regions) {
      const shape = own(prism(f.id, sk.frame, region, a, b, roles));
      tool = tool ? own(boolean('fuse', tool, shape, f.id)) : shape;
    }
    let { bodies, result } = applyTool(f.id, f.operation, state.bodies, targets, tool, own, body, WORDS.extrude);
    if (guessed)
      result = {
        code: 'profile-guessed',
        message: 'The profile outline changed. The area under the original selection was used.',
      };
    return { state: { ...state, bodies }, result, tool };
  }
  if (f.type === 'revolve') {
    const sk = state.sketches.get(f.sketch);
    if (!sk) fail('sketch-error', 'The sketch of this revolve is missing, suppressed or could not be built.');
    const line = sk.lines.get(f.axis);
    if (!line) fail('axis-lost', 'The line this revolve turns about is no longer in its sketch. Give it another line as its axis.');
    const [a, b] = line,
      length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(length > 1e-9)) fail('axis-lost', 'The line this revolve turns about has no length.');
    const { regions, guessed } = regionsOf(f, sk, 'revolve');
    const targets = state.bodies.filter((b) => f.targets === null || f.targets.includes(b.id));
    if (!targets.length && ['cut', 'intersect'].includes(f.operation)) fail('no-target', 'There is no body to cut or intersect.');
    const axis = { p: a, d: [(b[0] - a[0]) / length, (b[1] - a[1]) / length] },
      rise = f.rise ?? 0;
    if (ctx.drawing && rise > 0) return threadForDrawing(f, state, ctx, sk, regions, axis, targets, body);
    const made = (backwards) => {
      let tool = null;
      for (const region of regions) {
        const shape = own(rise > 0 ? screwed(f.id, sk.frame, region, axis, f.angle, rise, f.flip, !!f.left_handed, backwards) : revolved(f.id, sk.frame, region, axis, f.angle, f.flip));
        tool = tool ? own(boolean('fuse', tool, shape, f.id)) : shape;
      }
      return tool;
    };
    let tool = made(false),
      applied;
    if (!(rise > 0) || f.operation === 'new') applied = applyTool(f.id, f.operation, state.bodies, targets, tool, own, body, WORDS.revolve);
    else {
      // The kernel loses the cut or the join of a risen solid with some bodies and says nothing: the body
      // comes back as it was (KERNEL_NOTES, "A profile turned about an axis while it rises along it"). The
      // same solid made from its far end is then cut or joined rightly. So what did nothing is tried again.
      const NOTHING = ['no-effect', 'join-made-body'],
        HINT = ' A profile that rises must cross the surface of the body it is joined to or cut from: let it reach a little past that surface, with no side lying in it and no corner on it.';
      const attempt = (t) => {
        try {
          const done = applyTool(f.id, f.operation, state.bodies, targets, t, own, body, WORDS.revolve);
          return { done, nothing: NOTHING.includes(done.result.code) };
        } catch (e) {
          if (isFatal(e) || (e instanceof FeatureError && !['kernel', 'invalid-result', 'empty-result'].includes(e.code))) throw e;
          return { error: e, nothing: true };
        }
      };
      let tried = attempt(tool);
      if (tried.nothing) {
        const other = made(true),
          again = attempt(other);
        if (!again.nothing || (tried.error && !again.error)) {
          tried = again;
          tool = other;
        }
      }
      if (tried.error) {
        const e = tried.error;
        if (e instanceof FeatureError && e.code === 'empty-result') throw e;
        fail(e instanceof FeatureError ? e.code : 'kernel', (e instanceof FeatureError ? e.message : 'The kernel could not do this: ' + errorText(e)).replace(/\.$/, '') + '.' + HINT);
      }
      applied = tried.done;
      if (tried.nothing) applied = { ...applied, result: { ...applied.result, message: applied.result.message + ' If it does pass through the body, the kernel could not work it out.' + HINT } };
    }
    let { bodies, result } = applied;
    if (guessed) result = { code: 'profile-guessed', message: 'The profile outline changed. The area under the original selection was used.' };
    return { state: { ...state, bodies }, result, tool };
  }
  if (f.type === 'hole') {
    const ref = resolveFaceRef(f.face, topologies());
    if (!ref.hit) fail('ref-lost', 'The face for this hole no longer exists.');
    const target = state.bodies.find((b) => b.id === ref.hit.body.id),
      p = ref.hit.info.plane,
      frame = canonicalFrame(p.n, p.d),
      center = toWorld(frame, f.at),
      dir = mul(frame.n, -1);
    const depth =
      f.depth === 'all'
        ? Math.max(...corners(bounds(target.shape)).map((c) => dot(sub(c, center), dir))) + 1
        : f.depth;
    if (!(depth > 0)) fail('nothing-there', 'There is no material in the drilling direction.');
    const tool = own(cylinder(f.id, center, dir, f.diameter / 2, depth)),
      next = own(boolean('cut', target, tool, f.id));
    if (!countSolids(next.shape)) fail('removes-all', 'The hole would remove the whole body.');
    if (!changedVolume(target, next))
      fail('no-effect', 'The hole does not touch the body. Pick a position on the face.');
    return {
      state: { ...state, bodies: state.bodies.map((b) => (b === target ? body(b.id, next) : b)) },
      result:
        ref.status === 'ambiguous'
          ? {
              code: 'ref-ambiguous',
              message: 'The hole uses the nearest of several labelled planes.',
            }
          : {},
      tool,
    };
  }
  if (['fillet', 'chamfer'].includes(f.type)) {
    const sets = new Map(),
      refs = {};
    let lost = 0;
    for (const r of f.edges) {
      const resolved = resolveEdgeRef(r, topologies());
      refs['edges.' + r.k] = { status: resolved.status, count: resolved.count };
      if (!resolved.hits.length) lost++;
      for (const hit of resolved.hits) {
        if (!sets.has(hit.body.id)) sets.set(hit.body.id, new Map());
        sets.get(hit.body.id).set(hit.edge, r.k);
      }
    }
    if (!sets.size)
      fail(
        'ref-lost',
        'None of the selected edges still exist. Edit the feature and select edges again.',
        { refs }
      );
    const size = f.type === 'fillet' ? f.radius : f.distance;
    let bodies = [...state.bodies];
    for (const [id, picksByIndex] of sets) {
      const target = state.bodies.find((b) => b.id === id),
        edges = edgesOf(target),
        picks = [...picksByIndex].map(([i, k]) => ({ e: edges[i].e, k }));
      let next;
      try {
        next = own(blend(f.type, f.id, target, picks, size));
      } catch (e) {
        const culprits = [];
        if (picks.length <= 16)
          for (const p of picks) {
            try {
              own(blend(f.type, f.id, target, [p], size));
            } catch {
              culprits.push(p.k);
            }
          }
        fail(
          'blend-failed',
          `The ${f.type} cannot be built with ${
            f.type === 'fillet' ? 'radius' : 'distance'
          } ${size} mm${
            culprits.length ? ` on ${culprits.length} selected edge(s)` : ' on these edges together'
          }. Try a smaller size or fewer edges.`,
          { culprits, refs, detail: errorText(e) }
        );
      }
      bodies = bodies.map((b) => (b.id === id ? body(id, next) : b));
    }
    return {
      state: { ...state, bodies },
      result: {
        refs,
        ...(lost
          ? {
              code: 'ref-partial',
              message: `${lost} of ${f.edges.length} selected edges no longer exist. The remaining edges were used.`,
            }
          : {}),
      },
    };
  }
  if (f.type === 'import') {
    // ctx.imported: the texts of what was imported, unpacked before the features are built (engine.js)
    const text = ctx.imported?.get(f.id);
    if (typeof text !== 'string') fail('import-unreadable', 'What was imported cannot be unpacked. Import the file again.');
    const solid = own(stepSolids(f.id, text));
    return {
      state: { ...state, bodies: [...state.bodies, body(f.id, solid)] },
      result: isValid(solid.shape)
        ? {}
        : { code: 'import-faults', message: 'The kernel finds faults in these solids. They can be looked at and measured; cutting or joining them may fail.' },
    };
  }
  if (['box', 'cylinder', 'sphere'].includes(f.type)) {
    const solid = own(
      f.type === 'box'
        ? boxSolid(f.id, f.size, f.origin)
        : f.type === 'cylinder'
        ? cylinderSolid(f.id, f.diameter / 2, f.height, f.origin)
        : sphereSolid(f.id, f.diameter / 2, f.origin)
    );
    return { state: { ...state, bodies: [...state.bodies, body(f.id, solid)] }, result: {} };
  }
  if (f.type === 'combine') {
    // ctx.tools: the bodies of the other parts, each with where it stands in this part's frame.
    if (ctx.toolError) fail(ctx.toolError.code, ctx.toolError.message);
    let tool = null;
    for (const t of ctx.tools ?? []) {
      const moved = own(placed(t.body, t.matrix));
      tool = tool ? own(boolean('fuse', tool, moved, f.id)) : moved;
    }
    if (!tool) fail('no-tool', 'The parts to combine with have no solid.');
    if (!state.bodies.length) {
      if (f.operation !== 'join') fail('no-target', 'This part has no solid yet to cut or intersect.');
      return { state: { ...state, bodies: [body(f.id, tool)] }, result: {}, tool };
    }
    const { bodies, result } = applyTool(f.id, f.operation, state.bodies, state.bodies, tool, own, body, WORDS.combine);
    return { state: { ...state, bodies }, result, tool };
  }
  fail('unknown-type', `Feature type "${f.type}" needs a newer CoreCAD.`);
}

/**
 * A thread as a drawing shows it (ISO 6410), not as it is: on a bolt the solid fills out to the crests of
 * the thread over its length (a plain cylinder at the major diameter), in a nut the hole stays at the
 * crests of its thread (the minor diameter, as it was bored); the other diameter is drawn as thin lines
 * by the sheet. The result says where the thread is, in the part's frame: `thread`.
 */
function threadForDrawing(f, state, ctx, sk, regions, axis, targets, body) {
  const off = ([x, y]) => axis.d[0] * (y - axis.p[1]) - axis.d[1] * (x - axis.p[0]),
    up = ([x, y]) => axis.d[0] * (x - axis.p[0]) + axis.d[1] * (y - axis.p[1]),
    pts = regions.flatMap((r) => r.outer.flatMap((piece) => (piece.kind === 'circle' ? [[piece.c[0] + piece.r, piece.c[1]], [piece.c[0] - piece.r, piece.c[1]], [piece.c[0], piece.c[1] + piece.r], [piece.c[0], piece.c[1] - piece.r]] : [piece.a, piece.b]))),
    offs = pts.map(off),
    ups = pts.map(up),
    lo = Math.min(...offs),
    hi = Math.max(...offs),
    climb = ((f.flip ? -1 : 1) * f.rise * f.angle) / 360,
    u0 = Math.min(...ups) + Math.min(0, climb),
    u1 = Math.max(...ups) + Math.max(0, climb),
    at = (u, o = 0) => [axis.p[0] + axis.d[0] * u - axis.d[1] * o, axis.p[1] + axis.d[1] * u + axis.d[0] * o],
    minor = Math.min(Math.abs(lo), Math.abs(hi)),
    major = Math.max(Math.abs(lo), Math.abs(hi)),
    internal = f.operation === 'cut',
    thread = { p0: toWorld(sk.frame, at(u0)), p1: toWorld(sk.frame, at(u1)), minor, major, internal };
  if (internal || f.operation === 'intersect') return { state, result: { thread } };
  // the band the thread fills, turned once about the axis
  const line = (p, q) => ({ kind: 'line', a: p, b: q, entity: 'band' }),
    c = [at(u0, lo), at(u1, lo), at(u1, hi), at(u0, hi)],
    region = { outer: [line(c[0], c[1]), line(c[1], c[2]), line(c[2], c[3]), line(c[3], c[0])], holes: [] },
    tool = ctx.own(revolved(f.id, sk.frame, region, axis, 360, false)),
    applied = applyTool(f.id, f.operation, state.bodies, targets, tool, ctx.own, body, WORDS.revolve);
  return { state: { ...state, bodies: applied.bodies }, result: { ...applied.result, thread }, tool };
}

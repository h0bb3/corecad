import { FeatureError } from '../core/errors.js';
import { validateFeature, extentInterval } from '../doc/features.js';
import { frameOfSketch, resolveFaceRef, resolveEdgeRef } from '../doc/refs.js';
import { findRegions, resolveProfile } from '../sketch/profiles.js';
import { canonicalFrame, toWorld } from '../core/plane.js';
import { sub, mul, dot } from '../core/vec.js';
import { prism, boolean, cylinder, blend, edgesOf, bounds, volume, countSolids } from './shapes.js';
import { topoOf } from './topo.js';
import { errorText } from './occ.js';

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
    sketches.set(f.id, { frame: frame.frame, regions });
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
    let guessed = false;
    const regions = [
      ...new Set(
        f.profiles.map((ref) => {
          const r = resolveProfile(sk.regions, ref);
          if (!r)
            fail(
              'profile-lost',
              'A selected profile no longer exists. Edit the extrusion to choose its closed areas.'
            );
          guessed ||= r.status === 'guessed';
          return r.region;
        })
      ),
    ];
    if (!regions.length) fail('profile-empty', 'Choose a closed area of the sketch.');
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
    let bodies = [...state.bodies],
      result = {};
    if (f.operation === 'new') bodies.push(body(f.id, tool));
    else if (f.operation === 'join') {
      const merges = targets.filter((t) => {
        if (!reached(t, tool)) return false;
        const fused = own(boolean('fuse', t, tool, f.id));
        return countSolids(fused.shape) < countSolids(t.shape) + countSolids(tool.shape);
      });
      if (!merges.length) {
        bodies.push(body(f.id, tool));
        result = {
          code: 'join-made-body',
          message: 'The extrusion touches no target body. A new body was created.',
        };
      } else {
        let acc = tool;
        for (const t of merges) acc = own(boolean('fuse', t, acc, f.id));
        const id = merges[0].id,
          ids = new Set(merges.map((b) => b.id));
        bodies = bodies.flatMap((b) => (b.id === id ? [body(id, acc)] : ids.has(b.id) ? [] : [b]));
      }
    } else {
      let changed = 0;
      for (const target of targets) {
        if (!reached(target, tool)) continue;
        const next = own(boolean(f.operation === 'cut' ? 'cut' : 'common', target, tool, f.id));
        if (!countSolids(next.shape)) {
          if (f.operation === 'cut')
            fail('removes-all', 'This cut would remove an entire body. Reduce the size or depth.');
          continue;
        }
        if (!changedVolume(target, next) && f.operation === 'cut') continue;
        bodies = bodies.map((b) => (b.id === target.id ? body(b.id, next) : b));
        changed++;
      }
      if (!changed) {
        if (f.operation === 'intersect')
          fail('empty-result', 'The selected profiles and bodies have no common volume.');
        result = {
          code: 'no-effect',
          message: 'The cut does not remove material from any target body.',
        };
      }
    }
    if (guessed)
      result = {
        code: 'profile-guessed',
        message: 'The profile outline changed. The area under the original selection was used.',
      };
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
  fail('unknown-type', `Feature type "${f.type}" needs a newer CoreCAD.`);
}

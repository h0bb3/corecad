import { FeatureError } from '../core/errors.js';
import { validateSketch } from '../sketch/catalogue.js';
const size = (x) => Number.isFinite(x) && x > 1e-4;
const vec = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
const labels = (l) =>
  Array.isArray(l) && l.length > 0 && l.every((x) => typeof x === 'string' && /^f\d+\//.test(x));
export const validFaceRef = (r) =>
  !!r &&
  labels(r.labels) &&
  typeof r.body === 'string' &&
  Number.isInteger(r.of) &&
  r.of > 0 &&
  vec(r.hint?.n, 3) &&
  Math.hypot(...r.hint.n) > 0.99 &&
  Number.isFinite(r.hint.d) &&
  vec(r.hint.center, 3) &&
  Number.isFinite(r.hint.area);
export const validEdgeRef = (r) =>
  !!r &&
  typeof r.k === 'string' && /^k[1-9][0-9]*$/.test(r.k) &&
  typeof r.body === 'string' && /^f[1-9][0-9]*$/.test(r.body) &&
  Array.isArray(r.faces) &&
  r.faces.length === 2 &&
  r.faces.every(labels) &&
  Number.isInteger(r.of) &&
  r.of > 0 &&
  vec(r.hint?.mid, 3) &&
  ['line', 'circle', 'other'].includes(r.hint.kind) &&
  Number.isFinite(r.hint.length);
export function validateFeature(f) {
  const errors = [],
    check = (v, msg) => {
      if (!v) errors.push(msg);
    };
  if (!f || typeof f.type !== 'string' || typeof f.name !== 'string' || !f.name.trim())
    return ['Feature needs a type and name.'];
  check(f.suppressed === undefined || typeof f.suppressed === 'boolean', 'Suppression must be true or false.');
  switch (f.type) {
    case 'sketch':
      check(
        f.plane?.kind === 'base'
          ? ['XY', 'XZ', 'YZ'].includes(f.plane.base)
          : f.plane?.kind === 'face' && validFaceRef(f.plane.ref),
        'Choose an origin plane or a flat face.'
      );
      errors.push(...validateSketch(f));
      break;
    case 'extrude': {
      check(typeof f.sketch === 'string' && /^f\d+$/.test(f.sketch), 'Choose a sketch.');
      check(
        Array.isArray(f.profiles) &&
          f.profiles.length > 0 &&
          f.profiles.every(
            (p) =>
              p &&
              Array.isArray(p.loop) &&
              p.loop.length &&
              p.loop.every((id) => typeof id === 'string') &&
              vec(p.at, 2)
          ),
        'Select at least one closed profile.'
      );
      check(
        ['new', 'join', 'cut', 'intersect'].includes(f.operation),
        'Choose a valid extrusion operation.'
      );
      check(
        ['oneSide', 'symmetric', 'twoSides'].includes(f.extent?.type),
        'Choose an extrusion direction.'
      );
      const reach = (x) => size(x) || (x === 'all' && ['cut', 'intersect'].includes(f.operation));
      if (f.extent?.type === 'twoSides') {
        check(
          (reach(f.extent.distance) || f.extent.distance === 0) &&
            (reach(f.extent.distance2) || f.extent.distance2 === 0) &&
            !(f.extent.distance === 0 && f.extent.distance2 === 0),
          'Enter valid distances for both sides.'
        );
      } else
        check(
          reach(f.extent?.distance),
          'Distance must be positive; through-all is available for cuts and intersections.'
        );
      check(
        f.targets === null ||
          (Array.isArray(f.targets) && f.targets.every((id) => typeof id === 'string')),
        'Invalid target body list.'
      );
      check(typeof f.flip === 'boolean', 'Extrusion direction is invalid.');
      break;
    }
    case 'hole':
      check(validFaceRef(f.face), 'Choose a flat face for the hole.');
      check(vec(f.at, 2), 'Enter finite hole coordinates.');
      check(size(f.diameter), 'Hole diameter must be positive.');
      check(size(f.depth) || f.depth === 'all', 'Hole depth must be positive.');
      break;
    case 'fillet':
    case 'chamfer':
      check(
        Array.isArray(f.edges) && f.edges.length > 0 && f.edges.every(validEdgeRef),
        'Select at least one non-seam edge.'
      );
      check(
        size(f.type === 'fillet' ? f.radius : f.distance),
        `${f.type === 'fillet' ? 'Radius' : 'Distance'} must be positive.`
      );
      check(Number.isInteger(f.kseq) && f.kseq >= 0, 'Invalid edge key counter.');
      break;
    case 'box':
      check(vec(f.size, 3) && f.size.every(size), 'Width, depth and height must be positive.');
      check(['base', 'center', 'corner'].includes(f.origin), 'Choose where the box has its origin.');
      break;
    case 'cylinder':
      check(size(f.diameter), 'Diameter must be positive.');
      check(size(f.height), 'Height must be positive.');
      check(['base', 'center'].includes(f.origin), 'Choose where the cylinder has its origin.');
      break;
    case 'sphere':
      check(size(f.diameter), 'Diameter must be positive.');
      check(['base', 'center'].includes(f.origin), 'Choose where the sphere has its origin.');
      break;
    case 'combine':
      check(['join', 'cut', 'intersect'].includes(f.operation), 'Choose join, cut or intersect.');
      check(
        Array.isArray(f.tools) && f.tools.length > 0 && f.tools.every((t) => typeof t === 'string' && /^o[1-9][0-9]*$/.test(t)),
        'Choose at least one other part to combine with.'
      );
      check(new Set(f.tools ?? []).size === (f.tools ?? []).length && !(f.tools ?? []).includes(f.part), 'A part cannot be combined with itself.');
      check(f.keep === undefined || typeof f.keep === 'boolean', 'Keep tools must be true or false.');
      break;
  }
  return errors;
}
export function extentInterval(extent, span) {
  const [lo, hi] = span,
    margin = Math.max(1, 0.01 * (hi - lo));
  if (extent.type === 'symmetric')
    return extent.distance === 'all'
      ? [lo - margin, hi + margin]
      : [-extent.distance / 2, extent.distance / 2];
  const front = extent.distance === 'all' ? hi + margin : extent.distance;
  if (extent.distance === 'all' && hi <= 1e-6 && extent.type === 'oneSide')
    throw new FeatureError(
      'nothing-there',
      'There is nothing to cut in that direction. Flip the direction.'
    );
  return [
    extent.type === 'twoSides' ? (extent.distance2 === 'all' ? lo - margin : -extent.distance2) : 0,
    front,
  ];
}

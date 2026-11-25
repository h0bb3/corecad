// The numbers that drive the model, and where each one is on it: the dimensions of a sketch in
// its plane, how far an extrusion goes, the diameter and depth of a hole, the radius of a fillet,
// the size of a box. Each comes with the command that changes it, so that a number shown on the
// model can be clicked and typed over. Pure: the document in, places in space out.
import { DIMENSIONS } from '../sketch/catalogue.js';
import { dimensionGeometry, measure } from '../sketch/measure.js';
import { indexSketch } from '../sketch/model.js';
import { canonicalFrame, toWorld } from '../core/plane.js';
import { formatNumber } from '../core/num.js';
import * as Mat from '../core/mat.js';

const fmt = (v) => formatNumber(v, 3);

/** A point of a profile's outline that an upright edge of its extrusion starts from: the start of its first
 *  line or arc, or a point of its circle. null when the sketch is not at hand. */
function cornerOf(sketch, profile) {
  if (!sketch) return null;
  const ix = indexSketch(sketch),
    xy = (id) => {
      const p = ix.point(id);
      return p ? [p.x, p.y] : null;
    };
  for (const id of profile.loop ?? []) {
    const e = ix.entity(id);
    if (!e) continue;
    if (e.type === 'line' || e.type === 'arc') return xy(e.a);
    if (e.type === 'circle') {
      const c = xy(e.c);
      return c && [c[0] + e.r, c[1]];
    }
  }
  return null;
}

/**
 * @typedef {object} Dimension
 * @property {string} feature   the feature it belongs to
 * @property {string} key       which of its numbers: a sketch constraint's id, or 'distance', 'diameter', 'size.0', ...
 * @property {number} value
 * @property {string} text      as shown: '60', 'Ø 8', 'R 4', '(12.5)'
 * @property {string} unit      'mm' or '°'
 * @property {string} what      in words: 'horizontal distance', 'extrusion distance', 'hole diameter', ...
 * @property {number[][]} line  the points of its dimension line, in space (empty for a number without one)
 * @property {number[]} at      where its label is, in space
 * @property {{ command: string, args: (value: number) => object } | null} edit   how to change it; null for a measurement
 */

/**
 * The driving numbers of one feature.
 * @param {object} f        the feature
 * @param {object} context  { frame: the frame of f (a sketch) or of the sketch f uses (an extrusion), in its part;
 *                            matrix: where its part stands (twelve numbers); sketch: the sketch an extrusion uses
 *                            (its distance is then drawn along an edge the extrusion made, from a corner of the outline) }
 * @returns {Dimension[]}
 */
export function dimensionsOf(f, { frame = null, matrix = Mat.IDENTITY, sketch = null } = {}) {
  const P = (p) => Mat.point(matrix, p),
    item = (key, value, text, what, line, at, edit, unit = 'mm') => ({ feature: f.id, key, value, text, unit, what, line: line.map(P), at: P(at), edit }),
    change = (field) => ({ command: 'edit_feature', args: (value) => ({ id: f.id, [field]: value }) }),
    mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  if (f.suppressed) return [];
  if (f.type === 'sketch' && frame) {
    const on = (uv) => toWorld(frame, uv),
      names = { h: 'horizontal distance', v: 'vertical distance' };
    return f.constraints
      .filter((c) => !c.off && DIMENSIONS.includes(c.type))
      .map((c) => {
        const g = dimensionGeometry(f, c),
          value = measure(f, c),
          text = (c.type === 'radius' ? 'R ' : c.type === 'diameter' ? 'Ø ' : '') + fmt(value) + (c.type === 'angle' ? '°' : '');
        return item(
          c.id,
          value,
          c.driven ? `(${text})` : text,
          c.type === 'distance' ? names[c.mode] ?? 'distance' : c.type === 'distancePL' ? 'distance to a line' : c.type,
          [g.p, g.a, g.b, g.q].map(on),
          on(g.label),
          c.driven ? null : { command: 'set_dimension', args: (v) => ({ sketch: f.id, dimension: c.id, value: v }) },
          c.type === 'angle' ? '°' : 'mm'
        );
      });
  }
  if (f.type === 'extrude' && frame && f.profiles?.length) {
    const e = f.extent,
      s = f.flip ? -1 : 1,
      uv = cornerOf(sketch, f.profiles[0]) ?? f.profiles[0].at,
      out = [];
    if (e.distance !== 'all') {
      const [t0, t1] = e.type === 'symmetric' ? [-e.distance / 2, e.distance / 2] : [0, s * e.distance],
        a = toWorld(frame, uv, t0),
        b = toWorld(frame, uv, t1);
      out.push(item('distance', e.distance, fmt(e.distance), e.type === 'symmetric' ? 'extrusion distance, in all' : 'extrusion distance', [a, b], mid(a, b), change('distance')));
    }
    if (e.type === 'twoSides' && e.distance2 !== 'all') {
      const a = toWorld(frame, uv, 0),
        b = toWorld(frame, uv, -s * e.distance2);
      out.push(item('distance2', e.distance2, fmt(e.distance2), 'extrusion distance, the other way', [a, b], mid(a, b), change('distance2')));
    }
    return out;
  }
  if (f.type === 'hole' && f.face) {
    const fr = canonicalFrame(f.face.hint.n, f.face.hint.d),
      c = toWorld(fr, f.at),
      r = f.diameter / 2,
      out = [item('diameter', f.diameter, 'Ø ' + fmt(f.diameter), 'hole diameter', [toWorld(fr, [f.at[0] - r, f.at[1]]), toWorld(fr, [f.at[0] + r, f.at[1]])], c, change('diameter'))];
    if (f.depth !== 'all') {
      const a = toWorld(fr, [f.at[0] + r, f.at[1]]),
        b = toWorld(fr, [f.at[0] + r, f.at[1]], -f.depth);
      out.push(item('depth', f.depth, fmt(f.depth), 'hole depth', [a, b], mid(a, b), change('depth')));
    }
    return out;
  }
  if (f.type === 'fillet' && f.edges?.length) return [item('radius', f.radius, 'R ' + fmt(f.radius), 'fillet radius', [], f.edges[0].hint.mid, change('radius'))];
  if (f.type === 'chamfer' && f.edges?.length) return [item('distance', f.distance, 'C ' + fmt(f.distance), 'chamfer distance', [], f.edges[0].hint.mid, change('distance'))];
  if (f.type === 'box') {
    const [x, y, z] = f.size,
      lo = f.origin === 'corner' ? [0, 0, 0] : [-x / 2, -y / 2, f.origin === 'center' ? -z / 2 : 0],
      ends = [
        [lo[0] + x, lo[1], lo[2]],
        [lo[0], lo[1] + y, lo[2]],
        [lo[0], lo[1], lo[2] + z],
      ];
    return ends.map((b, i) =>
      item('size.' + i, f.size[i], fmt(f.size[i]), ['box width (X)', 'box depth (Y)', 'box height (Z)'][i], [lo, b], mid(lo, b), {
        command: 'edit_feature',
        args: (v) => ({ id: f.id, size: f.size.map((old, k) => (k === i ? v : old)) }),
      })
    );
  }
  if (f.type === 'cylinder') {
    const r = f.diameter / 2,
      z0 = f.origin === 'center' ? -f.height / 2 : 0,
      z1 = z0 + f.height;
    return [
      item('diameter', f.diameter, 'Ø ' + fmt(f.diameter), 'cylinder diameter', [[-r, 0, z1], [r, 0, z1]], [0, 0, z1], change('diameter')),
      item('height', f.height, fmt(f.height), 'cylinder height', [[r, 0, z0], [r, 0, z1]], [r, 0, (z0 + z1) / 2], change('height')),
    ];
  }
  if (f.type === 'sphere') {
    const r = f.diameter / 2,
      c = f.origin === 'center' ? 0 : r;
    return [item('diameter', f.diameter, 'Ø ' + fmt(f.diameter), 'sphere diameter', [[-r, 0, c], [r, 0, c]], [0, 0, c], change('diameter'))];
  }
  return [];
}

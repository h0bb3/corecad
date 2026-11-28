// Drawings made from the model as it is built: the lines of each view from the kernel (kept until the
// model or the part changes), the dimensions found again on the built bodies, all laid out on the sheet.
import { drawingById, viewAxes, planeOf, resolvePick } from './model.js';
import { composeSheet } from './layout.js';
import { partById, descendantsOf, sceneOf } from '../doc/parts.js';

/** The date as a drawing carries it. */
export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * @param {{ views: (doc: object, opts: object) => Promise<object> }} kernel
 */
export function createDrawings(kernel) {
  const cache = new Map(); // what the model is + part + look -> lines
  /** What decides the lines of a view: the history, the parts and the bodies' settings, not the drawings. */
  const modelKey = (doc) => JSON.stringify([doc.features, doc.parts, doc.bodies]);

  /** The bodies that a part and what stands under it show, each where it stands (hidden ones and used-up tools are not). */
  function bodiesOf(doc, build, part) {
    const inside = new Set([part, ...descendantsOf(doc, part)]);
    return sceneOf(doc, build?.bodies ?? [], new Map(Object.entries(build?.used ?? {}))).filter((b) => inside.has(b.part));
  }

  /** What the kernel is asked for a view: where it looks from, and for a section the plane that cuts the part. */
  function specOf(d, v) {
    const ax = viewAxes(d, v);
    if (v.look !== 'section') return { dir: ax.n, x: ax.x, hidden: v.look !== 'iso' };
    const { n, c } = planeOf(d, v);
    return { dir: ax.n, x: ax.x, hidden: false, cut: { n, c } };
  }
  /** The lines of the views of a drawing, by view id. */
  async function linesOf(doc, d) {
    const key = modelKey(doc),
      specs = new Map(d.views.map((v) => [v.id, specOf(d, v)])),
      keyOf = (spec) => `${key}|${d.part}|${JSON.stringify(spec)}`,
      want = new Map();
    for (const spec of specs.values()) if (!cache.has(keyOf(spec))) want.set(keyOf(spec), spec);
    if (want.size) {
      const list = [...want.values()],
        looks = Object.fromEntries(list.map((spec, i) => ['l' + i, spec])),
        got = await kernel.views(doc, { parts: [d.part], looks, hidden: list.flatMap((spec, i) => (spec.hidden ? ['l' + i] : [])) });
      list.forEach((spec, i) => cache.set(keyOf(spec), got['l' + i]));
      while (cache.size > 64) cache.delete(cache.keys().next().value);
    }
    return new Map(d.views.map((v) => [v.id, cache.get(keyOf(specs.get(v.id)))]));
  }

  return {
    bodiesOf,
    /**
     * A drawing on its sheet (drawing/layout.js), from the document and what the kernel last built of it.
     * @param {object} doc
     * @param {{ bodies: object[], used: object }} build  store.state.build
     * @param {string} id  the drawing
     */
    async sheet(doc, build, id) {
      const d = drawingById(doc, id);
      if (!d) throw Error(`There is no drawing "${id}".`);
      const part = partById(doc, d.part),
        lines = await linesOf(doc, d),
        bodies = bodiesOf(doc, build, d.part),
        picks = new Map(
          d.dims.map((m) => {
            const ps = [m.from, ...(m.to ? [m.to] : [])].map((ref) => resolvePick(ref, bodies));
            return [m.id, ps.every(Boolean) ? ps : null];
          })
        );
      return composeSheet({ drawing: d, names: { part: part?.name ?? '?', project: doc.meta.name, date: today() }, lines, bodies, picks });
    },
    viewAxes,
  };
}

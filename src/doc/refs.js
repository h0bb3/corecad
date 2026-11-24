import { dot, dist } from '../core/vec.js';
import { canonicalFrame, basePlane } from '../core/plane.js';
export const topoOfBody = b => ({ id: b.id, faces: b.mesh?.faces ?? b.faces, edges: b.mesh?.edges ?? b.edges });
export const sortLabels = a => [...new Set(a)].sort((a, b) => Number(a.match(/^f(\d+)/)?.[1]) - Number(b.match(/^f(\d+)/)?.[1]) || a.localeCompare(b));
const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const overlap = (a, b) => { const n = a.filter(x => b.includes(x)).length; return n / (a.length + b.length - n || 1); };
const groups = (bodies, id) => [bodies.filter(b => b.id === id), bodies.filter(b => b.id !== id)];
export function faceRefFrom(body, face) {
  const b = topoOfBody(body), f = b.faces[face]; if (!f?.plane) throw Error('A sketch or hole needs a flat face.');
  return { body: b.id, labels: [...f.labels], of: b.faces.filter(x => same(x.labels, f.labels)).length, hint: { ...f.plane, center: f.center, area: f.area } };
}
const edgeFaces = (b, e) => e.faces.map(i => b.faces[i].labels).sort((a, b) => a.join('+').localeCompare(b.join('+')));
export function edgeRefFrom(body, edge, k = 'k1') {
  const b = topoOfBody(body), e = b.edges[edge]; if (!e || e.faces.length !== 2 || e.seam) throw Error('Select a solid edge between two faces.');
  const faces = edgeFaces(b, e);
  return { body: b.id, k, faces, of: b.edges.filter(x => x.faces.length === 2 && edgeFaces(b, x).every((ls, i) => same(ls, faces[i]))).length, hint: { kind: e.kind, mid: e.mid, length: e.length } };
}
export function resolveFaceRef(ref, bodies) {
  for (const group of groups(bodies.map(topoOfBody), ref.body)) {
    const all = group.flatMap(body => body.faces.flatMap((face, i) => face.plane ? [{ body, face: i, info: face, score: overlap(ref.labels, face.labels) }] : []));
    const max = Math.max(0, ...all.map(x => x.score)); if (!max) continue;
    const candidates = all.filter(x => x.score === max), p = candidates[0].info.plane;
    const ambiguous = candidates.some(x => dot(p.n, x.info.plane.n) < 1 - 1e-9 || Math.abs(p.d - x.info.plane.d) > 1e-6);
    const score = x => ambiguous ? Math.abs(x.info.plane.d - ref.hint.d) + 1000 * (1 - dot(x.info.plane.n, ref.hint.n)) + .001 * dist(x.info.center, ref.hint.center) : dist(x.info.center, ref.hint.center);
    candidates.sort((a, b) => score(a) - score(b));
    return { status: ambiguous ? 'ambiguous' : 'ok', hit: candidates[0], count: candidates.length };
  }
  return { status: 'lost', hit: null, count: 0 };
}
export function resolveEdgeRef(ref, bodies) {
  for (const group of groups(bodies.map(topoOfBody), ref.body)) {
    const all = group.flatMap(body => body.edges.flatMap((e, edge) => {
      if (e.seam || e.faces.length !== 2) return [];
      const [a, b] = e.faces.map(i => body.faces[i].labels), [u, v] = ref.faces;
      return [{ body, edge, info: e, score: Math.max(Math.min(overlap(a, u), overlap(b, v)), Math.min(overlap(a, v), overlap(b, u))) }];
    }));
    const max = Math.max(0, ...all.map(x => x.score)); if (!max) continue;
    let hits = all.filter(x => x.score === max); if (ref.of > 1) hits = [hits.sort((a, b) => dist(a.info.mid, ref.hint.mid) - dist(b.info.mid, ref.hint.mid))[0]];
    return { status: 'ok', hits, count: hits.length };
  }
  return { status: 'lost', hits: [], count: 0 };
}
export function frameOfSketch(f, bodies) {
  if (f.plane.kind === 'base') { const p = basePlane(f.plane.base); return { frame: canonicalFrame(p.n, p.d), status: 'ok' }; }
  const resolved = resolveFaceRef(f.plane.ref, bodies), plane = resolved.hit?.info.plane ?? f.plane.ref.hint;
  return { frame: canonicalFrame(plane.n, plane.d), status: resolved.status };
}

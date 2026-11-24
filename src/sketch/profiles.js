import { curvesOf, curvePoint, parameter, intersections, distance, TAU, mod, loopArea, pieceMid, polygonOf, pointInLoop } from './geom2d.js';
import { sortIds } from '../core/ids.js';
import { weldFor } from '../core/tol.js';
export { loopArea, pointInLoop } from './geom2d.js';
export const pointInRegion = (p, r) => pointInLoop(p, r.outer) && !r.holes.some(h => pointInLoop(p, h));
export const polygonsOf = (r, tol = .025) => ({ outer: polygonOf(r.outer, tol), holes: r.holes.map(h => polygonOf(h, tol)) });

/** A planar arrangement; all geometric output remains analytic. */
export function arrangement(sketch) {
  const scale = Math.max(1, ...sketch.points.flatMap(p => [Math.abs(p.x), Math.abs(p.y)])), tol = weldFor(scale);
  const curves = curvesOf(sketch).filter(c => c.kind === 'line' ? distance(c.a, c.b) > tol : c.r > tol);
  const cuts = curves.map(c => [0, ...(c.kind === 'circle' ? [] : [1])]);
  for (let i = 0; i < curves.length; i++) for (let j = i + 1; j < curves.length; j++) {
    for (const p of intersections(curves[i], curves[j], tol)) { cuts[i].push(parameter(curves[i], p, tol)); cuts[j].push(parameter(curves[j], p, tol)); }
  }
  const vertices = [], grid = new Map(), cell = tol * 2;
  const vertex = p => {
    const x = Math.floor(p[0] / cell), y = Math.floor(p[1] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const k of grid.get(`${x + dx},${y + dy}`) ?? []) if (distance(vertices[k], p) <= tol) return k;
    const id = vertices.length, key = `${x},${y}`; vertices.push(p); if (!grid.has(key)) grid.set(key, []); grid.get(key).push(id); return id;
  };
  const edges = [], seen = new Set();
  curves.forEach((c, i) => {
    const length = c.kind === 'line' ? distance(c.a, c.b) : c.r * c.sweep;
    const ts = cuts[i].filter(t => t !== null).sort((a, b) => a - b).filter((t, j, all) => j === 0 || (t - all[j - 1]) * length > tol);
    if (c.kind === 'circle') { if (ts.length > 1 && (1 - ts.at(-1) + ts[0]) * length <= tol) ts.pop(); ts.push(ts[0] + 1); }
    for (let j = 0; j < ts.length - 1; j++) {
      const t0 = ts[j], t1 = ts[j + 1], a = vertex(curvePoint(c, t0)), b = vertex(curvePoint(c, t1));
      if (a === b && (c.kind === 'line' || t1 - t0 < .99)) continue;
      const mid = curvePoint(c, (t0 + t1) / 2), key = [Math.min(a, b), Math.max(a, b), c.kind === 'line' ? 'L' : `C${Math.round(mid[0] / tol)},${Math.round(mid[1] / tol)}`].join(':');
      if (seen.has(key)) continue; seen.add(key); edges.push({ c, t0, t1, a, b });
    }
  });
  const half = [], fans = vertices.map(() => []);
  for (const [i, e] of edges.entries()) for (const reverse of [false, true]) {
    const a = reverse ? e.b : e.a, b = reverse ? e.a : e.b, sign = reverse ? -1 : 1;
    const tangent = e.c.kind === 'line' ? Math.atan2(vertices[b][1] - vertices[a][1], vertices[b][0] - vertices[a][0]) : e.c.a0 + e.c.sweep * (reverse ? e.t1 : e.t0) + sign * Math.PI / 2;
    const h = { id: half.length, edge: i, twin: half.length + (reverse ? -1 : 1), a, b, reverse, angle: mod(tangent + 1e-8), curvature: e.c.kind === 'line' ? 0 : sign / e.c.r, active: true };
    half.push(h); fans[a].push(h);
  }
  const open = fans.filter(f => f.length === 1).map(f => vertices[f[0].a]);
  let cycles = [];
  for (let pass = 0; pass <= edges.length; pass++) {
    for (const fan of fans) fan.sort((a, b) => Math.abs(a.angle - b.angle) > 1e-7 ? a.angle - b.angle : a.curvature - b.curvature);
    const activeFans = fans.map(f => f.filter(h => h.active));
    for (const h of half) if (h.active) { const fan = activeFans[h.b], at = fan.findIndex(t => t.id === h.twin); h.next = fan[(at + fan.length - 1) % fan.length].id; }
    const visited = new Set(); cycles = [];
    for (const h of half) if (h.active && !visited.has(h.id)) {
      const cycle = []; let cur = h;
      while (!visited.has(cur.id)) { visited.add(cur.id); cur.cycle = cycles.length; cycle.push(cur); cur = half[cur.next]; }
      cycles.push(cycle);
    }
    const bridges = half.filter(h => h.active && h.cycle === half[h.twin].cycle);
    if (!bridges.length) break;
    bridges.forEach(h => { h.active = false; });
  }
  const component = new Map(); let nc = 0;
  for (const h of half) if (h.active && !component.has(h.a)) {
    const stack = [h.a]; component.set(h.a, nc);
    while (stack.length) { const v = stack.pop(); for (const e of fans[v]) if (e.active && !component.has(e.b)) { component.set(e.b, nc); stack.push(e.b); } } nc++;
  }
  function pieces(cycle) {
    let groups = [];
    for (const h of cycle) {
      const e = edges[h.edge], last = groups.at(-1);
      if (last && last.c === e.c && last.reverse === h.reverse) { last.b = h.b; last.sweep += (e.t1 - e.t0) * (e.c.sweep ?? 0); }
      else groups.push({ c: e.c, reverse: h.reverse, a: h.a, b: h.b, sweep: (e.t1 - e.t0) * (e.c.sweep ?? 0) });
    }
    if (groups.length > 1 && groups[0].c === groups.at(-1).c && groups[0].reverse === groups.at(-1).reverse) { const end = groups.pop(); groups[0].a = end.a; groups[0].sweep += end.sweep; }
    return groups.map(g => {
      const base = { entity: g.c.entity, direction: g.reverse ? '-' : '+' };
      if (g.c.kind === 'line') return { ...base, kind: 'line', a: vertices[g.a], b: vertices[g.b] };
      if (Math.abs(g.sweep - TAU) < 1e-8) return { ...base, kind: 'circle', a: vertices[g.a], b: vertices[g.b], c: g.c.c, r: g.c.r, ccw: !g.reverse };
      const p = { ...base, kind: 'arc', a: vertices[g.a], b: vertices[g.b], c: g.c.c, r: g.c.r, ccw: !g.reverse }; p.m = pieceMid(p); return p;
    });
  }
  const loops = cycles.map(cycle => { const loop = pieces(cycle); return { loop, area: loopArea(loop), component: component.get(cycle[0].a), at: vertices[cycle[0].a] }; }).filter(l => Math.abs(l.area) > 1e-9);
  const regions = loops.filter(l => l.area > 0).map(l => ({ ...l, outer: l.loop, holes: [] }));
  for (const hole of loops.filter(l => l.area < 0)) {
    const parent = regions.filter(r => r.component !== hole.component && pointInLoop(hole.at, r.outer)).sort((a, b) => a.area - b.area)[0];
    if (parent) parent.holes.push(hole.loop);
  }
  for (const r of regions) {
    r.area = loopArea(r.outer) + r.holes.reduce((sum, h) => sum + loopArea(h), 0);
    r.key = sortIds(r.outer.map(p => p.entity)).join(',');
    r.sides = [...new Set([r.outer, ...r.holes].flat().map(p => p.entity + p.direction))].sort().join(',');
    r.inside = null;
    for (const p of r.outer) {
      const mid = pieceMid(p), tangent = p.kind === 'line' ? [p.b[0] - p.a[0], p.b[1] - p.a[1]] : [(p.ccw ? -1 : 1) * (mid[1] - p.c[1]), (p.ccw ? 1 : -1) * (mid[0] - p.c[0])], d = Math.hypot(...tangent);
      for (let step = Math.sqrt(Math.abs(r.area)) * .01, i = 0; i < 32; i++, step /= 2) {
        const q = [mid[0] - tangent[1] / d * step, mid[1] + tangent[0] / d * step];
        if (pointInRegion(q, r)) { r.inside = q; break; }
      }
      if (r.inside) break;
    }
    if (!r.inside) throw Error('A closed region is too small or degenerate to use.');
    delete r.loop; delete r.component; delete r.at;
  }
  return { regions: regions.filter(r => r.area > 1e-9).sort((a, b) => b.area - a.area || a.key.localeCompare(b.key) || a.sides.localeCompare(b.sides)), openEnds: open,
    graph: { vertices: component.size, edges: half.filter(h => h.active).length / 2, components: nc } };
}
export const findRegions = s => arrangement(s).regions;
export const openEnds = s => arrangement(s).openEnds;
export const regionAt = (regions, p) => regions.filter(r => pointInRegion(p, r)).sort((a, b) => a.area - b.area)[0] ?? null;
export const profileRefFrom = r => ({ loop: r.key.split(','), at: r.inside, sides: r.sides });
export function resolveProfile(regions, ref) {
  let candidates = regions.filter(r => r.key === sortIds(ref.loop).join(','));
  if (candidates.length > 1 && ref.sides) {
    const restrict = sides => sides.split(',').filter(s => ref.loop.includes(s.slice(0, -1))).join(',');
    const narrowed = candidates.filter(r => restrict(r.sides) === restrict(ref.sides)); if (narrowed.length) candidates = narrowed;
  }
  if (candidates.length) return { region: regionAt(candidates, ref.at) ?? candidates.sort((a, b) => distance(a.inside, ref.at) - distance(b.inside, ref.at))[0], status: 'ok' };
  const region = regionAt(regions, ref.at);
  return region ? { region, status: region.outer.some(p => ref.loop.includes(p.entity)) ? 'ok' : 'guessed' } : null;
}

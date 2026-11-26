// Spike: can the kernel turn a profile about an axis while it rises along it (a thread), as one solid?
// Answers go back as one message. What it found is written down in docs/KERNEL_NOTES.md.
import opencascade from 'https://cdn.jsdelivr.net/npm/replicad-opencascadejs@1.2.1/dist/replicad_single.js';
import * as r from 'https://cdn.jsdelivr.net/npm/replicad@1.2.1/dist/replicad.js';

const out = { steps: [] };
let OC;
const message = e => {
  if (e instanceof WebAssembly.Exception) {
    try { const m = OC.getExceptionMessage?.(e); if (m) return 'OCCT: ' + [].concat(m).join(' '); } catch { /* fall through */ }
    return 'OCCT exception (no message)';
  }
  return String(e?.message ?? e);
};
const step = async (name, fn) => {
  const t0 = performance.now();
  try { const v = await fn(); out.steps.push({ name, ms: Math.round(performance.now() - t0), ok: true, v }); return v; }
  catch (e) { out.steps.push({ name, ms: Math.round(performance.now() - t0), ok: false, error: message(e) + ' ' + String(e?.stack ?? '').split('\n').slice(1, 4).join(' | ') }); return null; }
};
const vol = s => +r.measureVolume(s).toFixed(3);
const valid = s => { const a = new OC.BRepCheck_Analyzer(s.wrapped, true, false, false); try { return a.IsValid(); } finally { a.delete(); } };
const box = s => { const b = s.boundingBox; try { return b.bounds.map(p => p.map(v => +v.toFixed(3))); } finally { b.delete(); } };
const timed = fn => { const t0 = performance.now(); const v = fn(); return [v, Math.round(performance.now() - t0)]; };
const kinds = s => { const n = {}; for (const f of s.faces) n[f.geomType] = (n[f.geomType] ?? 0) + 1; return n; };

// A thread like M30 x 3.5: the tooth is drawn in the plane y = 0, x from the axis, z along it.
const P = 3.5, R = 15, ROOT = R - 0.6134 * P, IN = 0.3; // IN: how far the tooth reaches into the core, for a clean join
/** The outline of a tooth: flat at the crest, and its flanks go on into the core, so that no edge of
 *  the ridge lies in the core's wall. `c` makes it bigger all round; `into` 0 gives the part outside the core. */
const tooth = (c = 0, into = IN) => {
  const a = 0.375 * P + c / 2, b = P / 16 + c / 2, k = (a - b) / (R - ROOT);
  return [[ROOT + c - into, -(a + into * k)], [R + c, -b], [R + c, b], [ROOT + c - into, a + into * k]];
};
/** The first moment of a polygon about the axis x = 0: times the angle it is turned through, that is its volume. */
const moment = pts => { let m = 0; for (let i = 0; i < pts.length; i++) { const [x0, z0] = pts[i], [x1, z1] = pts[(i + 1) % pts.length]; m += (x0 + x1) * (x0 * z1 - x1 * z0); } return Math.abs(m) / 6; };
const wireOf = (pts, z = 0) => r.assembleWire(pts.map((p, i) => { const q = pts[(i + 1) % pts.length]; return r.makeLine([p[0], 0, p[1] + z], [q[0], 0, q[1] + z]); }));
const axisWire = (z0, z1) => r.assembleWire([r.makeLine([0, 0, z0], [0, 0, z1])]);

/** The tooth carried up a helix: by the helix's own frame, or by the axis with the helix as its guide. */
const ridge = (how, pts, z0, turns) => {
  const h = P * turns, profile = wireOf(pts, z0);
  if (how === 'frenet') return r.genericSweep(profile, r.makeHelix(P, h, ROOT, [0, 0, z0]), { frenet: true });
  return r.genericSweep(profile, axisWire(z0, z0 + h), { auxiliarySpine: r.makeHelix(P, h, ROOT, [0, 0, z0]) });
};
/** A boolean as CoreCAD does it (src/kernel/shapes.js): errors are asked for, the result is simplified. */
const bool = (op, a, b) => {
  const Builder = { cut: OC.BRepAlgoAPI_Cut, fuse: OC.BRepAlgoAPI_Fuse, common: OC.BRepAlgoAPI_Common }[op];
  const builder = new Builder(a.wrapped, b.wrapped);
  try {
    builder.Build();
    if (builder.HasErrors()) throw new Error(`the ${op} has errors`);
    builder.SimplifyResult(true, true, 1e-3);
    return r.cast(builder.Shape());
  } finally { builder.delete(); }
};
/** A threaded rod of a height: the ridge runs past both ends and is cut off flat. */
const rod = (how, height, c = 0, report = null) => {
  const turns = Math.ceil(height / P) + 2;
  const [thread, sweepMs] = timed(() => ridge(how, tooth(c), -P, turns));
  const [cutOff, trimMs] = timed(() => bool('common', thread, r.makeCylinder(R + c + 1, height, [0, 0, 0], [0, 0, 1])));
  const [joined, fuseMs] = timed(() => bool('fuse', r.makeCylinder(ROOT + c, height, [0, 0, 0], [0, 0, 1]), cutOff));
  if (report) Object.assign(report, { turns, sweepMs, trimMs, fuseMs });
  return joined;
};
const rodVolume = (height, c = 0) => height * (Math.PI * (ROOT + c) ** 2 + 2 * Math.PI * moment(tooth(c, 0)) / P);

try {
  await step('init kernel', async () => { OC = await opencascade(); r.setOC(OC); return { has: Object.keys(r).filter(k => /helix|sweep|twist|loft|spline|arc/i.test(k)) }; });

  for (const how of ['frenet', 'guided']) {
    await step(`one ridge, four turns (${how})`, () => {
      const s = ridge(how, tooth(), 0, 4);
      return { type: s.constructor.name, vol: vol(s), exact: +(moment(tooth()) * 2 * Math.PI * 4).toFixed(3), valid: valid(s), faces: s.faces.length, kinds: kinds(s), box: box(s) };
    });
    await step(`a quarter of a turn, and a turn and a half (${how})`, () => [0.25, 1.5].map(t => {
      const s = ridge(how, tooth(), 0, t);
      return { turns: t, vol: vol(s), exact: +(moment(tooth()) * 2 * Math.PI * t).toFixed(3), valid: valid(s) };
    }));
  }

  let how = 'frenet';
  const better = out.steps.filter(s => /one ridge/.test(s.name)).map(s => (s.ok && s.v.valid ? Math.abs(s.v.vol - s.v.exact) : Infinity));
  if (better[1] < better[0]) how = 'guided';
  out.how = how;

  let bolt;
  await step('a threaded rod 14 mm long: core, ridge, both ends cut flat', () => {
    const t = {};
    bolt = rod(how, 14, 0, t);
    return { ...t, type: bolt.constructor.name, solids: bolt.solids.length, vol: vol(bolt), exact: +rodVolume(14).toFixed(3), valid: valid(bolt), faces: bolt.faces.length, kinds: kinds(bolt), box: box(bolt) };
  });
  await step('its mesh', () => {
    const [m, ms] = timed(() => bolt.mesh({ tolerance: 0.05, angularTolerance: 0.3 }));
    return { ms, triangles: m.triangles.length / 3 };
  });
  await step('the same thread in a block, 0.3 bigger all round', () => {
    const t = {};
    const tool = rod(how, 14, 0.3, t);
    const block = r.makeBox([-25, -25, 2], [25, 25, 12]);
    const [nut, cutMs] = timed(() => bool('cut', block, tool));
    return { ...t, cutMs, solids: nut.solids.length, vol: vol(nut), exact: +(50 * 50 * 10 - rodVolume(10, 0.3)).toFixed(3), valid: valid(nut), faces: nut.faces.length };
  });
  await step('a rod 60 mm long (17 turns), and its mesh', () => {
    const t = {};
    const long = rod(how, 60, 0, t);
    const [m, meshMs] = timed(() => long.mesh({ tolerance: 0.05, angularTolerance: 0.3 }));
    return { ...t, meshMs, vol: vol(long), exact: +rodVolume(60).toFixed(3), valid: valid(long), faces: long.faces.length, triangles: m.triangles.length / 3 };
  });
  // What goes wrong, and whether the kernel says so. Each is a tooth an agent could well draw.
  const joinTo = (pts, height = 14) => {
    const thread = ridge(how, pts, -P, Math.ceil(height / P) + 2);
    const core = r.makeCylinder(ROOT, height + 2 * P, [0, 0, -P], [0, 0, 1]);
    try {
      const [s, ms] = timed(() => bool('fuse', core, thread));
      return { ms, said: 'nothing', solids: s.solids.length, valid: valid(s), vol: vol(s), core: vol(core), ridge: vol(thread) };
    } catch (e) { return { said: message(e) }; }
  };
  await step('hazard: the tooth stands on the wall of the core (its base lies in the wall)', () => joinTo(tooth(0, 0)));
  await step('hazard: the tooth has a corner in the wall of the core and goes on inside', () => {
    const a = 0.375 * P, b = P / 16;
    return joinTo([[ROOT - IN, -a], [ROOT, -a], [R, -b], [R, b], [ROOT, a], [ROOT - IN, a]]);
  });
  await step('the tooth that crosses the wall, joined the same way (for comparison)', () => joinTo(tooth()));

  await step('the same 60 mm as a stair of wedges, 36 to a turn: two turns of it, timed', () => {
    // what an agent builds without this: each step a wedge of 10 degrees, joined to what is there
    const n = 72, rise = P / 36;
    let body = r.makeCylinder(ROOT, 2 * P + 0.75 * P, [0, 0, 0], [0, 0, 1]);
    const wedge = i => {
      const a0 = (i * 10 * Math.PI) / 180, a1 = ((i + 1) * 10 * Math.PI) / 180, z = i * rise;
      const pts = [[ROOT - IN, a0], [R, a0], [R, a1], [ROOT - IN, a1]].map(([d, a]) => [d * Math.cos(a), d * Math.sin(a), z]);
      const f = r.makeFace(r.assembleWire(pts.map((p, k) => r.makeLine(p, pts[(k + 1) % 4]))));
      return r.basicFaceExtrusion(f, new r.Vector([0, 0, 0.75 * P]));
    };
    const [, ms] = timed(() => { for (let i = 0; i < n; i++) body = bool('fuse', body, wedge(i)); });
    return { wedges: n, ms, each: Math.round(ms / n), faces: body.faces.length, valid: valid(body) };
  });
} catch (e) {
  out.fatal = message(e) + ' ' + String(e?.stack ?? '');
}
self.postMessage(out);

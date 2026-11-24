// Spike: does the kernel load in a module worker straight from the CDN, and
// do the operations CoreCAD needs behave? Answers go back as one message.
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
const vol = s => +r.measureVolume(s).toFixed(2);
const rect = (x0, y0, x1, y1, z, ccw = true) => {
  const pts = [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
  if (!ccw) pts.reverse();
  return r.assembleWire(pts.map((p, i) => r.makeLine(p, pts[(i + 1) % 4])));
};
const alive = o => { try { void o.wrapped; return true; } catch { return false; } };

try {
  await step('init kernel', async () => { OC = await opencascade(); r.setOC(OC); return { exceptionHelpers: Object.keys(OC).filter(k => /xception/i.test(k)) }; });

  // 1. A face with a hole: which way must the hole wire run?
  await step('hole wire, same direction as the outer (counter-clockwise)', () => {
    const f = r.makeFace(rect(0, 0, 60, 40, 0), [r.assembleWire([r.makeCircle(5, [20, 20, 0], [0, 0, 1])])]);
    return { area: +r.measureArea(f).toFixed(2), vol: vol(r.basicFaceExtrusion(f, new r.Vector([0, 0, 10]))), expectArea: +(2400 - Math.PI * 25).toFixed(2), expectVol: +(24000 - Math.PI * 250).toFixed(2) };
  });
  await step('hole wire, opposite direction (circle normal -z)', () => {
    const f = r.makeFace(rect(0, 0, 60, 40, 0), [r.assembleWire([r.makeCircle(5, [20, 20, 0], [0, 0, -1])])]);
    return { area: +r.measureArea(f).toFixed(2), vol: vol(r.basicFaceExtrusion(f, new r.Vector([0, 0, 10]))) };
  });
  await step('hole of lines, clockwise', () => {
    const f = r.makeFace(rect(0, 0, 60, 40, 0), [rect(10, 10, 20, 20, 0, false)]);
    return { area: +r.measureArea(f).toFixed(2), expect: 2300 };
  });
  await step('hole of lines, counter-clockwise (wrong way?)', () => {
    const f = r.makeFace(rect(0, 0, 60, 40, 0), [rect(10, 10, 20, 20, 0, true)]);
    return { area: +r.measureArea(f).toFixed(2), expect: 2300 };
  });
  await step('outer clockwise, no hole: does the face still extrude to a positive volume?', () => {
    const f = r.makeFace(rect(0, 0, 60, 40, 0, false));
    return { area: +r.measureArea(f).toFixed(2), vol: vol(r.basicFaceExtrusion(f, new r.Vector([0, 0, 10]))), volDown: vol(r.basicFaceExtrusion(r.makeFace(rect(0, 0, 60, 40, 0)), new r.Vector([0, 0, -10]))) };
  });
  await step('a face on another plane (XZ at y = 5), extruded along its normal', () => {
    const pts = [[0, 5, 0], [10, 5, 0], [10, 5, 10], [0, 5, 10]];
    const f = r.makeFace(r.assembleWire(pts.map((p, i) => r.makeLine(p, pts[(i + 1) % 4]))));
    return { vol: vol(r.basicFaceExtrusion(f, new r.Vector([0, -3, 0]))) };
  });

  // 2. Booleans.
  let plate;
  await step('cut with a cylinder', () => {
    plate = r.basicFaceExtrusion(r.makeFace(rect(0, 0, 60, 40, 0)), new r.Vector([0, 0, 10]));
    const tool = r.makeCylinder(4, 30, [45, 20, -10], [0, 0, 1]);
    const cut = plate.cut(tool);
    return { vol: vol(cut), expect: +(24000 - Math.PI * 160).toFixed(2), faces: cut.faces.length, plateAlive: alive(plate), toolAlive: alive(tool), type: cut.constructor.name };
  });
  await step('fuse a boss that sits on the top face', () => {
    const boss = r.basicFaceExtrusion(r.makeFace(rect(5, 5, 15, 15, 10)), new r.Vector([0, 0, 6]));
    const a = plate.fuse(boss);
    return { vol: vol(a), expect: 24600, solids: a.solids.length, faces: a.faces.length, type: a.constructor.name, plateAlive: alive(plate), bossAlive: alive(boss) };
  });
  await step('fuse two solids that share a whole side: are the split faces merged?', () => {
    const a = r.makeBox([0, 0, 0], [10, 10, 10]), b = r.makeBox([10, 0, 0], [20, 10, 10]);
    const plain = a.fuse(b);
    const simple = r.makeBox([0, 0, 0], [10, 10, 10]).fuse(r.makeBox([10, 0, 0], [20, 10, 10]), { simplify: true });
    return { plainFaces: plain.faces.length, plainSolids: plain.solids.length, simplifiedFaces: simple.faces.length, vol: vol(simple) };
  });
  await step('a cut that splits a solid in two', () => {
    const a = r.makeBox([0, 0, 0], [30, 10, 10]).cut(r.makeBox([10, -1, -1], [20, 11, 11]));
    return { type: a.constructor.name, solids: a.solids.length, vols: a.solids.map(vol) };
  });
  await step('transformations: is the original kept?', () => {
    const a = r.makeBox([0, 0, 0], [1, 1, 1]);
    const b = a.translate([5, 0, 0]);
    const c = r.makeBox([0, 0, 0], [1, 1, 1]); const d = c.clone();
    return { originalAliveAfterTranslate: alive(a), movedAlive: alive(b), cloneAlive: alive(d), sourceAliveAfterClone: alive(c) };
  });

  // 3. Faces and edges of a shape, and their descriptions.
  let part;
  await step('describe faces', () => {
    part = plate.cut(r.makeCylinder(4, 30, [45, 20, -10], [0, 0, 1]));
    return part.faces.map((f, i) => {
      const d = { i, type: f.geomType, o: f.orientation };
      try { d.c = f.center.toTuple().map(v => +v.toFixed(2)); } catch (e) { d.c = 'ERR ' + message(e); }
      try { d.n = f.normalAt().toTuple().map(v => +v.toFixed(2)); } catch (e) { d.n = 'ERR ' + message(e); }
      try { d.area = +r.measureArea(f).toFixed(2); } catch (e) { d.area = 'ERR ' + message(e); }
      return d;
    });
  });
  await step('describe edges', () => part.edges.map((e, i) => {
    const d = { i, type: e.geomType };
    try { d.a = e.startPoint.toTuple().map(v => +v.toFixed(2)); d.b = e.endPoint.toTuple().map(v => +v.toFixed(2)); } catch (x) { d.ends = 'ERR ' + message(x); }
    try { d.len = +e.length.toFixed(3); } catch (x) { d.len = 'ERR ' + message(x); }
    try { d.mid = e.pointAt(0.5).toTuple().map(v => +v.toFixed(2)); } catch (x) { d.mid = 'ERR ' + message(x); }
    return d;
  }).slice(0, 16));
  await step('outer and inner wires of the top face', () => {
    const top = part.faces.find(f => { const c = f.center; return f.geomType === 'PLANE' && Math.abs(c.z - 10) < 1e-6; });
    const res = { found: !!top };
    try { const w = top.outerWire(); res.outerEdges = w.edges.length; res.topAliveAfterOuterWire = alive(top); } catch (e) { res.outer = 'ERR ' + message(e); }
    try { res.inner = top.innerWires().length; } catch (e) { res.innerErr = 'ERR ' + message(e); }
    return res;
  });
  await step('radius and centre of a circular edge, from points on it', () => {
    const e = part.edges.find(x => x.geomType === 'CIRCLE');
    const p0 = e.pointAt(0).toTuple(), p5 = e.pointAt(0.5).toTuple();
    return { radius: +(e.length / (2 * Math.PI)).toFixed(4), centre: p0.map((v, i) => +((v + p5[i]) / 2).toFixed(4)), closed: e.isClosed };
  });
  await step('plane helper: local and world coordinates', () => {
    const plane = new r.Plane([0, 0, 10], [1, 0, 0], [0, 0, 1]);
    const side = new r.Plane([0, 5, 0], [1, 0, 0], [0, -1, 0]);
    return { world: plane.toWorldCoords([3, 4, 0]).toTuple(), local: plane.toLocalCoords(new r.Vector([3, 4, 10])).toTuple(), sideWorld: side.toWorldCoords([3, 4, 0]).toTuple(), sideY: side.yDir.toTuple() };
  });

  // 4. Fillet and chamfer on edges chosen by description.
  await step('fillet four vertical corner edges', () => {
    const corners = [[0, 0], [60, 0], [60, 40], [0, 40]];
    let n = 0;
    const f = part.fillet(e => {
      const a = e.startPoint, b = e.endPoint;
      const hit = e.geomType === 'LINE' && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && corners.some(c => Math.abs(a.x - c[0]) < 1e-6 && Math.abs(a.y - c[1]) < 1e-6);
      return hit ? (n++, 4) : null;
    });
    return { chosen: n, vol: vol(f), expect: +(24000 - Math.PI * 160 - (16 - Math.PI * 4) * 10 * 4).toFixed(2), partAlive: alive(part) };
  });
  await step('chamfer the rim of the hole on top', () => {
    let n = 0;
    const c = part.chamfer(e => (e.geomType === 'CIRCLE' && Math.abs(e.startPoint.z - 10) < 1e-6 ? (n++, 1) : null));
    return { chosen: n, faces: c.faces.length, vol: vol(c) };
  });
  await step('a fillet that is too large: the error and its message', () => {
    try { const f = part.fillet(50); return 'no error; faces ' + f.faces.length + ' vol ' + vol(f); } catch (e) { return 'threw: ' + message(e); }
  });
  await step('fillet with no edge chosen', () => {
    try { const f = part.fillet(() => null); return 'no error; same volume: ' + (vol(f) === vol(part)); } catch (e) { return 'threw: ' + message(e); }
  });

  // 5. Meshes and export.
  await step('mesh and edge mesh', () => {
    const m = part.mesh({ tolerance: 0.05, angularTolerance: 0.3 });
    const em = part.meshEdges({ tolerance: 0.05, angularTolerance: 0.3 });
    const faceIds = part.faces.map(f => f.hashCode), edgeIds = part.edges.map(e => e.hashCode);
    return {
      triangles: m.triangles.length / 3, vertices: m.vertices.length / 3, groups: m.faceGroups.length,
      groupUnits: m.faceGroups.slice(0, 3), trianglesLength: m.triangles.length,
      faceOrderMatches: m.faceGroups.every((g, i) => g.faceId === faceIds[i]), uniqueFaceIds: new Set(faceIds).size === faceIds.length,
      lines: em.lines.length, edgeGroupsHead: em.edgeGroups.slice(0, 3), edgeGroups: em.edgeGroups.length, edges: part.edges.length,
      edgeOrderMatches: em.edgeGroups.every((g, i) => g.edgeId === edgeIds[i]), uniqueEdgeIds: new Set(edgeIds).size === edgeIds.length,
    };
  });
  await step('export STEP and STL', async () => {
    const step = await part.blobSTEP().arrayBuffer();
    const stl = await part.blobSTL({ binary: true }).arrayBuffer();
    const several = r.exportSTEP ? await r.exportSTEP([{ shape: part, name: 'plate' }, { shape: r.makeBox([0, 0, 20], [5, 5, 25]), name: 'cube' }]).arrayBuffer() : null;
    return { step: step.byteLength, stl: stl.byteLength, stlTriangles: new DataView(stl).getUint32(80, true), several: several?.byteLength };
  });
} catch (e) {
  out.fatal = message(e) + ' ' + String(e?.stack ?? '');
}
self.postMessage(out);

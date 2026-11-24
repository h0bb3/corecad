// Numerical constraint engine, promoted from the tested design prototype.
// Its private flat variable model is adapted by ../solver.js.
//
// Pipeline: reduce (substitution of x_j - x_i = c and constants) -> equations
// (residual + exact gradient) -> Levenberg-Marquardt in the dual (minimum-norm)
// form with Cholesky -> rank analysis by Householder QR in creation order.

const PI = Math.PI, TAU = 2 * PI;
const wrapHalf = t => t - PI * Math.round(t / PI);
const wrapFull = t => t - TAU * Math.round(t / TAU);

// ---- primitives on local value / gradient arrays (a point is two slots) ----
function dist(v, g, i, j, k) {
  let dx = v[j] - v[i], dy = v[j + 1] - v[i + 1];
  const D = Math.hypot(dx, dy);
  if (D < 1e-12) { g[i] -= k; g[j] += k; return 0; }
  dx /= D; dy /= D;
  g[i] -= k * dx; g[i + 1] -= k * dy; g[j] += k * dx; g[j + 1] += k * dy;
  return D;
}
function sdist(v, g, p, a, b, k) {
  const dx = v[b] - v[a], dy = v[b + 1] - v[a + 1], wx = v[p] - v[a], wy = v[p + 1] - v[a + 1];
  const L = Math.max(Math.hypot(dx, dy), 1e-12), s = (dx * wy - dy * wx) / L, ux = dx / L, uy = dy / L;
  g[p] += k * (-dy / L); g[p + 1] += k * (dx / L);
  g[a] += k * ((dy - wy) / L + s * ux / L); g[a + 1] += k * ((wx - dx) / L + s * uy / L);
  g[b] += k * (wy / L - s * ux / L); g[b + 1] += k * (-wx / L - s * uy / L);
  return s;
}
function ang(v, g, a, b, k) {
  const dx = v[b] - v[a], dy = v[b + 1] - v[a + 1], L2 = Math.max(dx * dx + dy * dy, 1e-24);
  g[b] += k * (-dy / L2); g[b + 1] += k * (dx / L2); g[a] -= k * (-dy / L2); g[a + 1] -= k * (dx / L2);
  return Math.atan2(dy, dx);
}

// ---- building the system ----
export function buildSystem(sk, opt = {}) {
  const E = new Map(sk.entities.map(e => [e.id, e]));
  const vkey = [], vof = new Map();
  for (const e of sk.entities) {
    if (e.type === 'point') { vof.set(e.id + '.x', vkey.length); vkey.push([e, 'x']); vof.set(e.id + '.y', vkey.length); vkey.push([e, 'y']); }
    else if (e.type === 'circle') { vof.set(e.id + '.r', vkey.length); vkey.push([e, 'r']); }
  }
  const N = vkey.length;
  const cur = i => vkey[i][0][vkey[i][1]];
  let scale = 1;
  for (let i = 0; i < N; i++) scale = Math.max(scale, Math.abs(cur(i)));
  const tolS = 1e-9 * scale;

  // weighted union-find: x_i = X_root(i) + off[i]; a root may be bound to a constant
  const parent = new Int32Array(N), off = new Float64Array(N), konst = new Float64Array(N).fill(NaN);
  for (let i = 0; i < N; i++) parent[i] = i;
  const adj = Array.from({ length: N + 1 }, () => []);   // node N is the ground (constants)
  const issues = [];
  function find(i) {
    if (parent[i] === i) return i;
    const p = parent[i], r = find(p);
    off[i] += off[p]; parent[i] = r;
    return r;
  }
  function path(u, v) {   // the constraints that already tie u to v
    const prev = new Map([[u, null]]), q = [u];
    while (q.length) {
      const a = q.shift();
      if (a === v) break;
      for (const [b, cid] of adj[a]) if (!prev.has(b)) { prev.set(b, [a, cid]); q.push(b); }
    }
    const out = [];
    for (let a = v; prev.get(a); a = prev.get(a)[0]) out.push(prev.get(a)[1]);
    return [...new Set(out)].reverse();
  }
  const R = { redundant: 0, conflict: 1, ok: 2 };
  function link(u, v, c, cid) {   // x_v - x_u = c
    const ru = find(u), rv = find(v), ku = konst[ru], kv = konst[rv];
    if (ru === rv || (!Number.isNaN(ku) && !Number.isNaN(kv))) {
      const err = (ru === rv ? 0 : kv - ku) + off[v] - off[u] - c;
      return { r: Math.abs(err) <= tolS ? R.redundant : R.conflict, blame: path(u, ru === rv ? v : N).concat(ru === rv ? [] : path(v, N)) };
    }
    if (!Number.isNaN(kv)) { parent[ru] = rv; off[ru] = off[v] - c - off[u]; }
    else { parent[rv] = ru; off[rv] = off[u] + c - off[v]; }
    adj[u].push([v, cid]); adj[v].push([u, cid]);
    return { r: R.ok };
  }
  function bind(u, value, cid) {
    const ru = find(u);
    if (!Number.isNaN(konst[ru])) return { r: Math.abs(konst[ru] + off[u] - value) <= tolS ? R.redundant : R.conflict, blame: path(u, N) };
    konst[ru] = value - off[u];
    adj[u].push([N, cid]); adj[N].push([u, cid]);
    return { r: R.ok };
  }
  const V = k => vof.get(k), P = id => [V(id + '.x'), V(id + '.y')];
  const varsOf = e => e.type === 'point' ? P(e.id) : e.type === 'line' ? [...P(e.p1), ...P(e.p2)] : e.type === 'circle' ? [...P(e.c), V(e.id + '.r')] : [...P(e.c), ...P(e.s), ...P(e.e)];
  const pair = c => c.l ? [E.get(c.l).p1, E.get(c.l).p2] : [c.a, c.b];

  for (const e of sk.entities) if (e.fixed) for (const i of varsOf(e)) bind(i, cur(i), e.id);
  const later = [];
  for (const c of sk.constraints) {
    if (c.driven) continue;
    let rs = null;
    const A = E.get(c.a), B = E.get(c.b);
    switch (c.type) {
      case 'coincident': rs = [link(V(c.a + '.x'), V(c.b + '.x'), 0, c.id), link(V(c.a + '.y'), V(c.b + '.y'), 0, c.id)]; break;
      case 'concentric': rs = [link(V(A.c + '.x'), V(B.c + '.x'), 0, c.id), link(V(A.c + '.y'), V(B.c + '.y'), 0, c.id)]; break;
      case 'horizontal': { const [a, b] = pair(c); rs = [link(V(a + '.y'), V(b + '.y'), 0, c.id)]; break; }
      case 'vertical': { const [a, b] = pair(c); rs = [link(V(a + '.x'), V(b + '.x'), 0, c.id)]; break; }
      case 'fix': rs = varsOf(E.get(c.e)).map(i => bind(i, cur(i), c.id)); break;
      case 'equal': if (A.type === 'circle' && B.type === 'circle') rs = [link(V(A.id + '.r'), V(B.id + '.r'), 0, c.id)]; else later.push(c); break;
      case 'distance':
        if (c.mode === 'h') rs = [link(V(c.a + '.x'), V(c.b + '.x'), c.dir * c.value, c.id)];
        else if (c.mode === 'v') rs = [link(V(c.a + '.y'), V(c.b + '.y'), c.dir * c.value, c.id)];
        else later.push(c);
        break;
      case 'radius': case 'diameter': {
        const C = E.get(c.c), val = c.type === 'radius' ? c.value : c.value / 2;
        if (C.type === 'circle') rs = [bind(V(C.id + '.r'), val, c.id)]; else later.push(c);
        break;
      }
      case '_vector': {   // temporary, while a line is dragged by its body: the line keeps its vector
        const L = E.get(c.l), i = P(L.p1), j = P(L.p2);
        rs = [link(i[0], j[0], cur(j[0]) - cur(i[0]), c.id), link(i[1], j[1], cur(j[1]) - cur(i[1]), c.id)]; break;
      }
      default: later.push(c);
    }
    if (rs) {   // a constraint is redundant only when every scalar relation of it is; one conflicting relation makes it a conflict
      if (rs.some(x => x.r === R.conflict)) issues.push({ kind: 'conflict', id: c.id, blame: [...new Set(rs.flatMap(x => x.blame ?? []))] });
      else if (rs.every(x => x.r === R.redundant)) issues.push({ kind: 'redundant', id: c.id, blame: [...new Set(rs.flatMap(x => x.blame ?? []))] });
    }
  }

  // reduced variables; a class starts at the mean of what its members say (least movement)
  const red = new Int32Array(N).fill(-1), kOf = new Int32Array(N), cOf = new Float64Array(N);
  const sum = [], cnt = [];
  for (let i = 0; i < N; i++) {
    const r = find(i);
    if (Number.isNaN(konst[r])) {
      if (red[r] < 0) { red[r] = sum.length; sum.push(0); cnt.push(0); }
      sum[red[r]] += cur(i) - off[i]; cnt[red[r]]++;
      kOf[i] = red[r]; cOf[i] = off[i];
    } else { kOf[i] = -1; cOf[i] = konst[r] + off[i]; }
  }
  const goals = opt.goals ?? [], n0 = sum.length, n = n0 + goals.length, X0 = new Float64Array(n);
  for (let k = 0; k < n0; k++) X0[k] = sum[k] / cnt[k];
  const same = (i, j) => kOf[i] === kOf[j] && Math.abs(cOf[i] - cOf[j]) <= tolS;
  const samePt = (a, b) => same(V(a + '.x'), V(b + '.x')) && same(V(a + '.y'), V(b + '.y'));
  for (const e of sk.entities) {
    if (e.type === 'line' && samePt(e.p1, e.p2)) issues.push({ kind: 'degenerate', id: e.id, blame: [] });
    if (e.type === 'arc' && (samePt(e.c, e.s) || samePt(e.c, e.e) || samePt(e.s, e.e))) issues.push({ kind: 'degenerate', id: e.id, blame: [] });
  }

  // equations
  const eqs = [];
  const add = (cid, vars, fn, kind = 'len') => {
    const k = Int32Array.from(vars, i => i <= -2 ? n0 - i - 2 : kOf[i]), c = Float64Array.from(vars, i => i <= -2 ? 0 : cOf[i]);   // -2 - j is slack j
    const cols = [...new Set([...k].filter(x => x >= 0))];
    const pos = Int32Array.from(k, x => cols.indexOf(x));
    eqs.push({ cid, k, c, fn, kind, cols: Int32Array.from(cols), pos, vals: new Float64Array(cols.length), v: new Float64Array(vars.length), g: new Float64Array(vars.length) });
  };
  const rad = (C, vars) => {   // adds the variables the radius needs; returns (v, g, k) => radius, adding k * gradient
    const i = vars.length;
    if (C.type === 'circle') { vars.push(V(C.id + '.r')); return (v, g, k) => { g[i] += k; return v[i]; }; }
    vars.push(...P(C.c), ...P(C.s));
    return (v, g, k) => dist(v, g, i, i + 2, k);
  };
  const onLine = (p, L) => samePt(p, L.p1) || samePt(p, L.p2) || sk.constraints.some(c => (c.type === 'pointOnLine' || c.type === 'midpoint') && c.l === L.id && samePt(c.p, p));
  const onCurve = (p, C) => (C.type === 'arc' && (samePt(p, C.s) || samePt(p, C.e))) || sk.constraints.some(c => c.type === 'pointOnCircle' && c.c === C.id && samePt(c.p, p));
  const sharedPoint = (A, B) => {   // a point known to lie on both: there the general tangency equation has a double root
    const cand = new Set();
    for (const X of [A, B]) {
      if (X.type === 'line') { cand.add(X.p1); cand.add(X.p2); }
      if (X.type === 'arc') { cand.add(X.s); cand.add(X.e); }
      for (const c of sk.constraints) if ((c.l === X.id && (c.type === 'pointOnLine' || c.type === 'midpoint')) || (c.c === X.id && c.type === 'pointOnCircle')) cand.add(c.p);
    }
    const on = (p, X) => X.type === 'line' ? onLine(p, X) : onCurve(p, X);
    for (const p of cand) if (on(p, A) && on(p, B)) return p;
    return null;
  };
  for (const e of sk.entities) if (e.type === 'arc')
    add('arc:' + e.id, [...P(e.c), ...P(e.s), ...P(e.e)], (v, g) => dist(v, g, 0, 2, 1) - dist(v, g, 0, 4, -1));
  for (const c of later) {
    const A = E.get(c.a), B = E.get(c.b);
    switch (c.type) {
      case 'pointOnLine': { const L = E.get(c.l); add(c.id, [...P(c.p), ...P(L.p1), ...P(L.p2)], (v, g) => sdist(v, g, 0, 2, 4, 1)); break; }
      case 'pointOnCircle': {
        const C = E.get(c.c), vars = [...P(c.p), ...P(C.c)], r = rad(C, vars);
        add(c.id, vars, (v, g) => dist(v, g, 0, 2, 1) - r(v, g, -1)); break;
      }
      case 'parallel': add(c.id, [...P(A.p1), ...P(A.p2), ...P(B.p1), ...P(B.p2)], (v, g) => wrapHalf(ang(v, g, 4, 6, 1) - ang(v, g, 0, 2, -1)), 'ang'); break;
      case 'perpendicular': add(c.id, [...P(A.p1), ...P(A.p2), ...P(B.p1), ...P(B.p2)], (v, g) => wrapHalf(ang(v, g, 4, 6, 1) - ang(v, g, 0, 2, -1) - PI / 2), 'ang'); break;
      case 'angle': {
        const target = c.value * PI / 180 + (c.flipA ? PI : 0) - (c.flipB ? PI : 0);
        add(c.id, [...P(A.p1), ...P(A.p2), ...P(B.p1), ...P(B.p2)], (v, g) => wrapFull(ang(v, g, 4, 6, 1) - ang(v, g, 0, 2, -1) - target), 'ang'); break;
      }
      case 'equal':
        if (A.type === 'line') add(c.id, [...P(A.p1), ...P(A.p2), ...P(B.p1), ...P(B.p2)], (v, g) => dist(v, g, 0, 2, 1) - dist(v, g, 4, 6, -1));
        else { const vars = [], ra = rad(A, vars), rb = rad(B, vars); add(c.id, vars, (v, g) => ra(v, g, 1) - rb(v, g, -1)); }
        break;
      case 'midpoint': {
        const L = E.get(c.l);
        add(c.id, [V(c.p + '.x'), V(L.p1 + '.x'), V(L.p2 + '.x')], (v, g) => { g[0] = 1; g[1] = -0.5; g[2] = -0.5; return v[0] - (v[1] + v[2]) / 2; });
        add(c.id, [V(c.p + '.y'), V(L.p1 + '.y'), V(L.p2 + '.y')], (v, g) => { g[0] = 1; g[1] = -0.5; g[2] = -0.5; return v[0] - (v[1] + v[2]) / 2; });
        break;
      }
      case '_pointAt': {   // temporary, the handle of a line dragged by its body: p = a + u (b - a)
        const L = E.get(c.l), u = c.u;
        for (const ax of ['.x', '.y']) add(c.id, [V(c.p + ax), V(L.p1 + ax), V(L.p2 + ax)], (v, g) => { g[0] = 1; g[1] = u - 1; g[2] = -u; return v[0] - (1 - u) * v[1] - u * v[2]; });
        break;
      }
      case 'distance': add(c.id, [...P(c.a), ...P(c.b)], (v, g) => dist(v, g, 0, 2, 1) - c.value); break;
      case 'distancePL': { const L = E.get(c.l); add(c.id, [...P(c.p), ...P(L.p1), ...P(L.p2)], (v, g) => sdist(v, g, 0, 2, 4, 1) - c.side * c.value); break; }
      case 'radius': case 'diameter': { const C = E.get(c.c), val = c.type === 'radius' ? c.value : c.value / 2; add(c.id, [...P(C.c), ...P(C.s)], (v, g) => dist(v, g, 0, 2, 1) - val); break; }
      case 'tangent': {
        const p = c.general ? null : sharedPoint(A, B);
        if (A.type === 'line') {
          if (p) add(c.id, [...P(p), ...P(B.c), ...P(A.p1), ...P(A.p2)], (v, g) => wrapHalf(ang(v, g, 2, 0, 1) - ang(v, g, 4, 6, -1) - PI / 2), 'ang');
          else { const vars = [...P(B.c), ...P(A.p1), ...P(A.p2)], r = rad(B, vars); add(c.id, vars, (v, g) => sdist(v, g, 0, 2, 4, 1) - c.side * r(v, g, -c.side)); }
        } else if (p) add(c.id, [...P(p), ...P(A.c), ...P(B.c)], (v, g) => wrapHalf(ang(v, g, 2, 0, 1) - ang(v, g, 4, 0, -1)), 'ang');
        else {
          const vars = [...P(A.c), ...P(B.c)], ra = rad(A, vars), rb = rad(B, vars);
          if (c.mode === 'int') {
            const radius = X => X.type === 'circle' ? X.r : Math.hypot(E.get(X.s).x - E.get(X.c).x, E.get(X.s).y - E.get(X.c).y);
            const tau = radius(A) >= radius(B) ? 1 : -1;   // which contains which, as the sketch stands when the solve starts
            add(c.id, vars, (v, g) => dist(v, g, 0, 2, 1) - tau * (ra(v, g, -tau) - rb(v, g, tau)));
          } else add(c.id, vars, (v, g) => dist(v, g, 0, 2, 1) - ra(v, g, -1) - rb(v, g, -1));
        }
        break;
      }
      default: throw new Error('unknown constraint ' + c.type);
    }
  }
  // drag goals: G(X; mouse) - slack = 0. The slack moves only when the geometry cannot (see beginDrag).
  goals.forEach((gl, j) => {
    const sl = -2 - j, t = gl.target;
    if (gl.kind === 'coord') add('goal', [gl.v, sl], (v, g) => { g[0] = 1; g[1] = -1; return v[0] - t[gl.axis] - v[1]; });
    else if (gl.kind === 'onLine') add('goal', [gl.a, gl.b, sl], (v, g) => { g[0] = 1 - gl.u; g[1] = gl.u; g[2] = -1; return v[0] + gl.u * (v[1] - v[0]) - t[gl.axis] - v[2]; });
    else {   // rim: the distance from the centre to the mouse is the radius
      const C = E.get(gl.c), vars = [...P(C.c)], r = rad(C, vars); vars.push(sl);
      const si = vars.length - 1;
      add('goal', vars, (v, g) => {
        const dx = t[0] - v[0], dy = t[1] - v[1], D = Math.hypot(dx, dy) || 1e-12;
        g[0] -= dx / D; g[1] -= dy / D; g[si] = -1;
        return D + gl.offset - r(v, g, -1) - v[si];
      });
    }
  });
  const m = eqs.length;
  // equations without a free variable are decided here
  for (const q of eqs) if (!q.cols.length) {
    for (let s = 0; s < q.v.length; s++) q.v[s] = q.c[s];
    const f = q.fn(q.v, q.g);
    issues.push({ kind: Math.abs(f) <= 1e-7 * scale ? 'redundant' : 'conflict', id: q.cid, blame: [] });
  }

  const sys = {
    n, n0, m, X0, eqs, issues, scale, N,
    eval(X, f, wantJ) {
      for (let i = 0; i < m; i++) {
        const q = eqs[i], v = q.v, g = q.g;
        for (let s = 0; s < v.length; s++) { const k = q.k[s]; v[s] = (k >= 0 ? X[k] : 0) + q.c[s]; g[s] = 0; }
        f[i] = q.fn(v, g);
        if (wantJ) { q.vals.fill(0); for (let s = 0; s < v.length; s++) if (q.pos[s] >= 0) q.vals[q.pos[s]] += g[s]; }
      }
    },
    full(X, out = new Float64Array(N)) { for (let i = 0; i < N; i++) out[i] = (kOf[i] >= 0 ? X[kOf[i]] : 0) + cOf[i]; return out; },
    write(X, target) {   // target: a sketch with the same entities
      const T = new Map(target.entities.map(e => [e.id, e]));
      for (let i = 0; i < N; i++) { const t = T.get(vkey[i][0].id); if (t) t[vkey[i][1]] = (kOf[i] >= 0 ? X[kOf[i]] : 0) + cOf[i]; }
      return target;
    },
    kOf, cOf, V, P, E,
  };
  // rows that share a variable, for J W J^T
  const byVar = Array.from({ length: n }, () => []);
  eqs.forEach((q, i) => q.cols.forEach((k, p) => byVar[k].push([i, p])));
  sys.byVar = byVar;
  return sys;
}

// ---- linear algebra: envelope (skyline) Cholesky in a reverse Cuthill-McKee order ----
/** The pattern of A = J W J^T (equations that share a variable), an ordering that keeps it near the diagonal, and the envelope storage. */
export function structure(sys) {
  if (sys.st) return sys.st;
  const { m, eqs, byVar } = sys;
  const sets = Array.from({ length: m }, () => new Set());
  for (const rows of byVar) for (const [i] of rows) for (const [j] of rows) if (i !== j) sets[i].add(j);
  const adj = sets.map(s => [...s]);
  const order = [], seen = new Uint8Array(m);
  const byDeg = [...adj.keys()].sort((a, b) => adj[a].length - adj[b].length);
  for (const start of byDeg) {
    if (seen[start]) continue;
    seen[start] = 1;
    const q = [start];
    for (let h = 0; h < q.length; h++) {
      const a = q[h]; order.push(a);
      const next = adj[a].filter(b => !seen[b]).sort((x, y) => adj[x].length - adj[y].length);
      for (const b of next) { seen[b] = 1; q.push(b); }
    }
  }
  order.reverse();
  const inv = new Int32Array(m); order.forEach((old, nw) => { inv[old] = nw; });
  const first = new Int32Array(m), ptr = new Int32Array(m + 1);
  for (let nw = 0; nw < m; nw++) { let f = nw; for (const b of adj[order[nw]]) f = Math.min(f, inv[b]); first[nw] = f; }
  for (let i = 0; i < m; i++) ptr[i + 1] = ptr[i] + (i - first[i] + 1);
  return (sys.st = { inv, first, ptr, size: ptr[m], order: Int32Array.from(order) });
}
/** In place: A (lower envelope, row i holds columns first[i]..i) becomes L with A = L L^T. False when A is not positive definite. */
export function envCholesky(L, first, ptr, m) {
  for (let i = 0; i < m; i++) {
    const fi = first[i], pi = ptr[i] - fi;
    for (let j = fi; j < i; j++) {
      const fj = first[j], pj = ptr[j] - fj;
      let s = L[pi + j];
      for (let k = fi > fj ? fi : fj; k < j; k++) s -= L[pi + k] * L[pj + k];
      L[pi + j] = s / L[pj + j];
    }
    let d = L[pi + i];
    for (let k = fi; k < i; k++) d -= L[pi + k] * L[pi + k];
    if (!(d > 0)) return false;
    L[pi + i] = Math.sqrt(d);
  }
  return true;
}
export function envSolve(L, first, ptr, m, b) {
  for (let i = 0; i < m; i++) { const fi = first[i], pi = ptr[i] - fi; let s = b[i]; for (let k = fi; k < i; k++) s -= L[pi + k] * b[k]; b[i] = s / L[pi + i]; }
  for (let i = m - 1; i >= 0; i--) { const fi = first[i], pi = ptr[i] - fi; const y = b[i] / L[pi + i]; b[i] = y; for (let k = fi; k < i; k++) b[k] -= L[pi + k] * y; }
  return b;
}

// ---- Levenberg-Marquardt with minimum-norm steps: (J W J^T + mu D) z = -f, dx = W J^T z ----
// W is diagonal (1, or small for the variables the mouse holds). opt.offset: solve f(X) = offset instead of 0.
export function lm(sys, X, opt = {}) {
  const { m, n, eqs } = sys, wi = opt.wi ?? null, maxIter = opt.maxIter ?? 50, off = opt.offset ?? null;
  const tolF = opt.tolF ?? 1e-10 * sys.scale;
  if (!m) return { ok: true, iters: 0, res: 0, solves: 0 };
  const { inv, first, ptr, size } = structure(sys);
  const ws = (sys.ws ??= { f: new Float64Array(m), fn: new Float64Array(m), s: new Float64Array(m), z: new Float64Array(m), A: new Float64Array(size), M: new Float64Array(size), Xn: new Float64Array(n), dx: new Float64Array(n) });
  const { f, fn, s, z, A, M, Xn, dx } = ws;
  const ev = (Y, out, wantJ) => { sys.eval(Y, out, wantJ); if (off) for (let i = 0; i < m; i++) out[i] -= off[i]; };
  ev(X, f, true);
  for (let i = 0; i < m; i++) { let t = 0; for (const a of eqs[i].vals) t += a * a; s[i] = 1 / Math.max(Math.sqrt(t), 1e-9); }
  const cost = ff => { let t = 0; for (let i = 0; i < m; i++) t += (s[i] * ff[i]) ** 2; return t / 2; };
  const maxres = ff => { let t = 0; for (let i = 0; i < m; i++) t = Math.max(t, Math.abs(s[i] * ff[i])); return t; };
  const fail = (iters, solves, why) => ({ ok: false, iters, res: maxres(f), solves, why, f: Array.from(f, (x, i) => x * s[i]) });
  let F = cost(f), mu = opt.mu0 ?? 1e-6, solves = 0;
  for (let iters = 0; iters < maxIter; iters++) {
    const res = maxres(f);
    if (res <= tolF) return { ok: true, iters, res, solves };
    A.fill(0);
    for (let k = 0; k < n; k++) {
      const rows = sys.byVar[k], w = wi ? wi[k] : 1;
      for (let a = 0; a < rows.length; a++) {
        const i = rows[a][0], ji = eqs[i].vals[rows[a][1]] * s[i] * w, pi = inv[i];
        if (ji === 0) continue;
        for (let b = 0; b <= a; b++) {
          const j = rows[b][0], pj = inv[j], val = ji * eqs[j].vals[rows[b][1]] * s[j];
          if (pi >= pj) A[ptr[pi] - first[pi] + pj] += val; else A[ptr[pj] - first[pj] + pi] += val;
        }
      }
    }
    let accepted = false;
    for (let tries = 0; tries < 40 && !accepted; tries++) {
      M.set(A);
      for (let i = 0; i < m; i++) { const d = ptr[i + 1] - 1; M[d] = A[d] * (1 + mu) + 1e-30; }
      if (!envCholesky(M, first, ptr, m)) { mu = Math.max(mu * 10, 1e-12); if (mu > 1e12) break; continue; }
      for (let i = 0; i < m; i++) z[inv[i]] = -s[i] * f[i];
      envSolve(M, first, ptr, m, z); solves++;
      dx.fill(0);
      for (let i = 0; i < m; i++) { const q = eqs[i], t = z[inv[i]] * s[i]; for (let p = 0; p < q.cols.length; p++) dx[q.cols[p]] += q.vals[p] * t; }
      let step = 0;
      for (let k = 0; k < n; k++) { if (wi) dx[k] *= wi[k]; Xn[k] = X[k] + dx[k]; step = Math.max(step, Math.abs(dx[k])); }
      // what the linear model promises: |f|^2/2 - |f + J dx|^2/2
      let pred = 0;
      for (let i = 0; i < m; i++) { const q = eqs[i]; let jd = 0; for (let p = 0; p < q.cols.length; p++) jd += q.vals[p] * dx[q.cols[p]]; jd *= s[i]; pred += -s[i] * f[i] * jd - jd * jd / 2; }
      ev(Xn, fn, false);
      const Fn = cost(fn), rho = pred > 0 ? (F - Fn) / pred : -1;
      if (Number.isFinite(Fn) && rho > 1e-3) {
        X.set(Xn); F = Fn; ev(X, f, true);
        mu = Math.max(1e-10, mu * (rho > 0.75 ? 0.1 : rho < 0.25 ? 4 : 1));
        accepted = true;
        if (step < 1e-15 * sys.scale && maxres(f) > tolF) return fail(iters + 1, solves, 'no progress');
      } else { mu *= 10; if (mu > 1e12) break; }
    }
    if (!accepted) return fail(iters, solves, 'stalled');
  }
  const res = maxres(f);
  return res <= tolF ? { ok: true, iters: maxIter, res, solves } : fail(maxIter, solves, 'iterations');
}

// ---- rank analysis: Householder QR of J^T, columns (equations) taken in creation order ----
export function analyse(sys, X, opt = {}) {
  const { m, n, eqs } = sys, tolRank = opt.tolRank ?? 1e-8, tolFree = opt.tolFree ?? 1e-6;
  const f = new Float64Array(m);
  sys.eval(X, f, true);
  const M = new Float64Array(Math.max(1, n * m));   // column j at j * n
  for (let j = 0; j < m; j++) {
    const q = eqs[j]; let t = 0;
    for (const a of q.vals) t += a * a;
    t = Math.sqrt(t);
    if (t > 1e-12) for (let p = 0; p < q.cols.length; p++) M[j * n + q.cols[p]] = q.vals[p] / t;
  }
  const refl = [], pivCol = [], dependent = [];
  let r = 0;
  for (let j = 0; j < m; j++) {
    const c = j * n;
    let nrm = 0;
    for (let i = r; i < n; i++) nrm += M[c + i] * M[c + i];
    nrm = Math.sqrt(nrm);
    if (r >= n || nrm <= tolRank) {
      // which earlier equations already say this: solve R coef = top of the column
      const coef = new Float64Array(pivCol.length), b = Array.from({ length: r }, (_, i) => M[c + i]);
      for (let p = r - 1; p >= 0; p--) {
        const cp = pivCol[p] * n;
        coef[p] = b[p] / M[cp + p];
        for (let i = 0; i < p; i++) b[i] -= coef[p] * M[cp + i];
      }
      let mx = 0; for (const x of coef) mx = Math.max(mx, Math.abs(x));
      dependent.push({ eq: j, id: eqs[j].cid, residual: f[j], blame: [...new Set(pivCol.filter((_, p) => Math.abs(coef[p]) > 1e-6 * mx && mx > 0).map(jc => eqs[jc].cid))] });
      continue;
    }
    const alpha = M[c + r] >= 0 ? -nrm : nrm;
    const v = M.slice(c + r, c + n); v[0] -= alpha;
    let vv = 0; for (const x of v) vv += x * x;
    for (let cc = j + 1; cc < m; cc++) {
      const o = cc * n + r; let d = 0;
      for (let i = 0; i < v.length; i++) d += v[i] * M[o + i];
      d = 2 * d / vv;
      if (d !== 0) for (let i = 0; i < v.length; i++) M[o + i] -= d * v[i];
    }
    M[c + r] = alpha; for (let i = r + 1; i < n; i++) M[c + i] = 0;
    refl.push({ r, v, vv }); pivCol.push(j); r++;
  }
  // how free each variable is: the length of row k of Q2 (a basis of the motions the constraints allow)
  const free = new Float64Array(n), e = new Float64Array(n);
  for (let k = r; k < n; k++) {
    e.fill(0); e[k] = 1;
    for (let h = refl.length - 1; h >= 0; h--) {
      const { r: r0, v, vv } = refl[h]; let d = 0;
      for (let i = 0; i < v.length; i++) d += v[i] * e[r0 + i];
      d = 2 * d / vv;
      for (let i = 0; i < v.length; i++) e[r0 + i] -= d * v[i];
    }
    for (let i = 0; i < n; i++) free[i] += e[i] * e[i];
  }
  for (let i = 0; i < n; i++) free[i] = Math.sqrt(free[i]);
  return { rank: r, dof: n - r, dependent, free, isFree: i => sys.kOf[i] >= 0 && free[sys.kOf[i]] > tolFree };
}

/** 'full' or 'free' for every entity, from the analysis. */
export function entityStates(sk, sys, an) {
  const out = {};
  const pf = id => an.isFree(sys.V(id + '.x')) || an.isFree(sys.V(id + '.y'));
  for (const e of sk.entities) {
    const free = e.type === 'point' ? pf(e.id) : e.type === 'line' ? pf(e.p1) || pf(e.p2) : e.type === 'circle' ? pf(e.c) || an.isFree(sys.V(e.id + '.r')) : pf(e.c) || pf(e.s) || pf(e.e);
    out[e.id] = free ? 'free' : 'full';
  }
  return out;
}

// ---- orientation witnesses: what must not change sign within one step unless it passes through zero ----
export function witnesses(sk, sys, X) {
  const full = sys.full(X), w = [];
  const xy = id => [full[sys.V(id + '.x')], full[sys.V(id + '.y')]];
  const lines = sk.entities.filter(e => e.type === 'line');
  const dir = lines.map(l => { const a = xy(l.p1), b = xy(l.p2), L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; });
  const key = id => { const i = sys.V(id + '.x'), j = sys.V(id + '.y'); return sys.kOf[i] + ':' + sys.cOf[i].toFixed(9) + '/' + sys.kOf[j] + ':' + sys.cOf[j].toFixed(9); };
  const at = new Map();
  lines.forEach((l, i) => { for (const p of [l.p1, l.p2]) { const k = key(p); if (!at.has(k)) at.set(k, []); at.get(k).push(i); } });
  for (const list of at.values()) for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
    const u = dir[list[a]], v = dir[list[b]];
    w.push({ t: 'corner', id: lines[list[a]].id, s: u[0] * v[1] - u[1] * v[0] });
  }
  for (const a of sk.entities) if (a.type === 'arc') {
    const c = xy(a.c), s = xy(a.s), e = xy(a.e);
    let sw = Math.atan2(e[1] - c[1], e[0] - c[0]) - Math.atan2(s[1] - c[1], s[0] - c[0]);
    if (sw <= 0) sw += TAU;
    w.push({ t: 'arc', id: a.id, sweep: sw });
  }
  return w;
}
export function flipped(w0, w1) {
  for (let i = 0; i < w0.length; i++) {
    const a = w0[i], b = w1[i];
    if (a.t === 'corner' && a.s * b.s < 0 && Math.min(Math.abs(a.s), Math.abs(b.s)) > 0.05) return a.id;
    if (a.t === 'arc' && Math.abs(a.sweep - b.sweep) > PI) return a.id;
  }
  return null;
}

// ---- the public operations ----
const clone = s => JSON.parse(JSON.stringify(s));
function blameOfFailure(sys, r) {
  if (!r.f) return [];
  const mx = Math.max(...r.f.map(Math.abs));
  return [...new Set(sys.eqs.filter((q, i) => Math.abs(r.f[i]) > 1e-3 * mx).map(q => q.cid))];
}
function geometryOk(sk) {
  const E = new Map(sk.entities.map(e => [e.id, e]));
  let scale = 1; for (const e of sk.entities) if (e.type === 'point') scale = Math.max(scale, Math.abs(e.x), Math.abs(e.y));
  const tiny = 1e-7 * scale, d = (a, b) => Math.hypot(E.get(a).x - E.get(b).x, E.get(a).y - E.get(b).y);
  for (const e of sk.entities) {
    if (e.type === 'line' && d(e.p1, e.p2) < tiny) return e.id;
    if (e.type === 'circle' && !(e.r > tiny)) return e.id;
    if (e.type === 'arc' && (d(e.c, e.s) < tiny || d(e.s, e.e) < tiny)) return e.id;
  }
  return null;
}

export const ANG_STEP = 0.1;   // radians an angular residual may close in one step of the continuation

/** Solves the sketch from where it stands, by continuation on the residuals: f(X) = (1 - t) f(X0), t from 0 to 1.
 *  One step when that works; smaller steps when the solver stalls, when an orientation flips, or when an angle has far to go.
 *  Never changes its argument. */
export function solveSketch(sk, opt = {}) {
  const sys = buildSystem(sk);
  const bad = sys.issues[0];
  if (bad) return { ok: false, reason: bad.kind, blame: [bad.id, ...bad.blame], sys };
  let X = sys.X0.slice();
  const { m } = sys, f0 = new Float64Array(m), offset = new Float64Array(m);
  sys.eval(X, f0, true);
  let res0 = 0, maxAng = 0;
  sys.eqs.forEach((q, i) => { let t = 0; for (const a of q.vals) t += a * a; res0 = Math.max(res0, Math.abs(f0[i]) / Math.max(Math.sqrt(t), 1e-9)); if (q.kind === 'ang') maxAng = Math.max(maxAng, Math.abs(f0[i])); });
  let steps = 0, t = 0, last = null;
  if (res0 > 1e-10 * sys.scale) {
    const hMax = opt.plain ? 1 : 1 / Math.max(1, Math.ceil(maxAng / ANG_STEP));
    let h = hMax;
    while (t < 1) {
      const t1 = Math.min(1, t + h), Xt = X.slice();
      for (let i = 0; i < m; i++) offset[i] = (1 - t1) * f0[i];
      const r = lm(sys, Xt, { offset }); steps++; last = r;
      const fl = r.ok && !opt.plain ? flipped(witnesses(sk, sys, X), witnesses(sk, sys, Xt)) : null;
      if (r.ok && !fl) { X = Xt; t = t1; h = Math.min(2 * h, hMax); continue; }
      h /= 2;
      if (h < 1 / 1024 || opt.plain) return { ok: false, reason: 'conflict', blame: fl ? [fl] : blameOfFailure(sys, r), lm: r, sys, steps, reached: t };
    }
  }
  const out = sys.write(X, clone(sk)), collapsed = geometryOk(out);
  if (collapsed) return { ok: false, reason: 'degenerate', blame: [collapsed], sys, steps };
  return { ok: true, sketch: out, sys, X, steps, lm: last };
}

export function analyseSketch(sk) {
  const sys = buildSystem(sk), an = analyse(sys, sys.X0);
  return { dof: an.dof, states: entityStates(sk, sys, an), dependent: an.dependent, issues: sys.issues, n: sys.n, m: sys.m };
}

/** Adds one constraint: kept only when the sketch still solves and the constraint says something new. */
export function tryAddConstraint(sk, c) {
  const t = clone(sk);
  const id = 'k' + (t.nextId++);
  t.constraints.push({ id, ...c });
  const r = solveSketch(t);
  if (!r.ok) return { ok: false, reason: r.reason, blame: r.blame.filter(x => x !== id), id };
  const an = analyse(r.sys, r.X);
  const dep = an.dependent.find(d => d.id === id) ?? an.dependent[0];
  if (dep) return { ok: false, reason: 'redundant', blame: dep.blame.filter(x => x !== id), id };
  return { ok: true, sketch: r.sketch, id, dof: an.dof, steps: r.steps };
}

/** Changes dimension values; the continuation inside solveSketch carries the sketch there. */
export function setDimensions(sk, changes) {
  const t = clone(sk);
  for (const [id, to] of changes) t.constraints.find(c => c.id === id).value = to;
  const r = solveSketch(t);
  if (!r.ok) {
    const from = sk.constraints.find(c => c.id === changes[0][0]).value;
    return { ok: false, reason: r.reason, blame: r.blame, steps: r.steps, reachedValue: r.reached === undefined ? undefined : from + r.reached * (changes[0][1] - from) };
  }
  return { ok: true, sketch: r.sketch, steps: r.steps };
}

// ---- dragging ----
// Every drag is the drag of one point, the handle: the point itself, or a temporary point tied to the line or the
// rim where it was grabbed. Each step: put the handle at the mouse, then restore the constraints with the handle
// very reluctant to move (mobility STIFF against 1), so that everything else gives way first.
export const STIFF = 1e-2;
export function beginDrag(sk, grab, opt = {}) {
  const e0 = sk.entities.find(e => e.id === grab.id);
  let work = sk, handle = e0.id, frozenIds = [];
  if (e0.type !== 'point') {
    work = clone(sk);
    const E0 = new Map(sk.entities.map(e => [e.id, e]));
    let hx = grab.at[0], hy = grab.at[1];
    if (e0.type === 'line') {
      const a = E0.get(e0.p1), b = E0.get(e0.p2), dx = b.x - a.x, dy = b.y - a.y;
      const u = Math.min(1, Math.max(0, ((hx - a.x) * dx + (hy - a.y) * dy) / (dx * dx + dy * dy)));
      hx = a.x + u * dx; hy = a.y + u * dy;
      work.constraints.push({ id: '_at', type: '_pointAt', p: '_h', l: e0.id, u });
      // the line keeps its length and direction, unless that would lock it
      const t = clone(work); t.entities.push({ id: '_h', type: 'point', x: hx, y: hy }); t.constraints.push({ id: '_rigid', type: '_vector', l: e0.id });
      const sysT = buildSystem(t), an = analyse(sysT, sysT.X0);
      if (!sysT.issues.some(i => i.kind !== 'redundant') && sysT.P('_h').some(i => an.isFree(i))) work.constraints.push({ id: '_rigid', type: '_vector', l: e0.id });
    } else {
      const c = E0.get(e0.c), R = e0.type === 'circle' ? e0.r : Math.hypot(E0.get(e0.s).x - c.x, E0.get(e0.s).y - c.y);
      const d = Math.hypot(hx - c.x, hy - c.y) || 1;
      hx = c.x + (hx - c.x) * R / d; hy = c.y + (hy - c.y) * R / d;
      work.constraints.push({ id: '_at', type: 'pointOnCircle', p: '_h', c: e0.id });
      frozenIds = [e0.c];   // first try with the centre held: a rim drag should change the radius, not move the circle
    }
    work.entities.push({ id: '_h', type: 'point', x: hx, y: hy });
    handle = '_h';
  }
  const sys = buildSystem(work), { n } = sys;
  const X = sys.X0.slice(), Xt = new Float64Array(n), wi = new Float64Array(n);
  const [hx, hy] = sys.P(handle), kx = sys.kOf[hx], ky = sys.kOf[hy];
  const off = [X[kx] === undefined ? 0 : X[kx] + sys.cOf[hx] - grab.at[0], X[ky] === undefined ? 0 : X[ky] + sys.cOf[hy] - grab.at[1]];
  const frozen = frozenIds.flatMap(id => sys.P(id)).map(i => sys.kOf[i]).filter(k => k >= 0);
  const stats = { frames: 0, solves: 0, iters: 0, failed: 0, restored: 0 };
  const maxStep = opt.maxStep ?? Infinity, stiff = opt.stiff ?? STIFF, maxIter = opt.maxIter ?? 12, tolAt = 1e-6 * sys.scale;
  let at = grab.at.slice(), stuck = false;
  const away = (Y, m) => Math.max(kx >= 0 ? Math.abs(Y[kx] + sys.cOf[hx] - m[0] - off[0]) : 0, ky >= 0 ? Math.abs(Y[ky] + sys.cOf[hy] - m[1] - off[1]) : 0);
  const attempt = m => {
    for (const pass of frozen.length ? [0, 1] : [1]) {
      Xt.set(X); wi.fill(1);
      if (kx >= 0) { Xt[kx] = m[0] + off[0] - sys.cOf[hx]; wi[kx] = stiff; }
      if (ky >= 0) { Xt[ky] = m[1] + off[1] - sys.cOf[hy]; wi[ky] = stiff; }
      if (pass === 0) for (const k of frozen) wi[k] = 0;
      let r = lm(sys, Xt, { wi, maxIter });
      stats.solves += r.solves; stats.iters += r.iters;
      if (pass === 0 && !(r.ok && away(Xt, m) <= tolAt + 0.1 * away(X, m))) continue;   // the radius alone did not follow: let the centre move
      if (!r.ok) {   // the tug of war did not settle in time: let go of the handle and just restore the constraints
        wi.fill(1);
        r = lm(sys, Xt, { wi, maxIter: 20 }); stats.solves += r.solves; stats.iters += r.iters; stats.restored++;
        if (!r.ok) return false;
      }
      X.set(Xt); at = m.slice(); stuck = away(X, m) > tolAt;
      return true;
    }
    return false;
  };
  return {
    sys,
    /** Moves towards the mouse, in steps of at most maxStep and at most 8 of them per call. */
    move(m) {
      stats.frames++;
      for (let i = 0; i < 8; i++) {
        const d = Math.hypot(m[0] - at[0], m[1] - at[1]);
        if (d < 1e-12) break;
        const k = Math.min(1, maxStep / d);
        if (!attempt([at[0] + (m[0] - at[0]) * k, at[1] + (m[1] - at[1]) * k])) { stats.failed++; return { arrived: false, stuck: true }; }
      }
      // the handle gave way by STIFF of what the others had to move: close that, while it still closes
      for (let p = 0; p < 2 && stuck; p++) if (!attempt(at)) break;
      return { arrived: Math.hypot(m[0] - at[0], m[1] - at[1]) < 1e-12, stuck };
    },
    sketch() { return sys.write(X, clone(sk)); },
    stats,
  };
}

// The test harness: tests run in the browser (there is no Node here), and
// tools/run_tests.py reads the result from window.__tests.
//
//   import { test, eq, ok, near, throws, run } from './harness.js';
//   test('adds', () => { eq(1 + 1, 2); });
//   test('loads', async () => { ok(await thing()); });
//   run();
//
// ?only=text in the address runs only the tests whose name contains text.

const tests = [];

export function test(name, fn) { tests.push([name, fn]); }

const show = v => {
  try { return (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, (k, x) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : ArrayBuffer.isView(x) ? [...x] : x))) ?? String(v); }
  catch { return String(v); }
};

/** Deep equality by value (through JSON). */
export function eq(actual, expected, what = '') {
  const a = show(actual), b = show(expected);
  if (a !== b) throw new Error(`${what ? what + ': ' : ''}${a.slice(0, 400)} is not ${b.slice(0, 400)}`);
}

export function ok(value, what = 'expected a truthy value') {
  if (!value) throw new Error(typeof what === 'function' ? what() : what);
}

/** Numbers, or arrays of numbers, within a tolerance of each other. */
export function near(actual, expected, tolerance = 1e-6, what = '') {
  const a = [actual].flat(Infinity), b = [expected].flat(Infinity);
  const fine = a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tolerance);
  if (!fine) throw new Error(`${what ? what + ': ' : ''}${show(actual).slice(0, 300)} is not within ${tolerance} of ${show(expected).slice(0, 300)}`);
}

export async function throws(fn, pattern, what = 'expected an error') {
  try { await fn(); } catch (e) {
    if (pattern && !pattern.test(String(e?.message ?? e))) throw new Error(`${what}: the error was "${e?.message ?? e}"`);
    return e;
  }
  throw new Error(what);
}

export async function run() {
  const only = new URLSearchParams(location.search).get('only');
  const lines = [];
  let passed = 0, failed = 0;
  const out = document.body.appendChild(document.createElement('pre'));
  for (const [name, fn] of tests) {
    if (only && !name.includes(only)) continue;
    const t0 = performance.now();
    try {
      await fn();
      passed++;
      lines.push(`ok    ${name} (${Math.round(performance.now() - t0)} ms)`);
    } catch (e) {
      failed++;
      lines.push(`FAIL  ${name}: ${e?.message ?? e}`);
      const where = String(e?.stack ?? '').split('\n').find(l => /\.js:\d+/.test(l) && !l.includes('harness.js'));
      if (where) lines.push(`      ${where.trim()}`);
      else if (e?.stack) lines.push(String(e.stack).split('\n').slice(1, 4).join('\n'));
    }
    out.textContent = lines.join('\n');
  }
  lines.push(failed ? `${failed} FAILED, ${passed} passed` : `all ${passed} passed`);
  out.textContent = lines.join('\n');
  document.title = failed ? 'FAILED' : 'passed';
  window.__tests = { done: true, passed, failed, lines };
}

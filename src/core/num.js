/** Arithmetic only: no eval, functions or access to page globals. */
export function parseNumber(text) {
  const s = String(text)
    .trim()
    .replace(/(?:mm|deg|°)\s*$/i, '')
    .replaceAll(',', '.');
  let i = 0;
  const space = () => {
    while (/\s/.test(s[i] ?? '') && i < s.length) i++;
  };
  function atom() {
    space();
    if (s[i] === '+' || s[i] === '-') {
      const sign = s[i++] === '-' ? -1 : 1;
      return sign * atom();
    }
    if (s[i] === '(') {
      i++;
      const v = expr();
      space();
      if (s[i++] !== ')') throw Error();
      return v;
    }
    const m = s.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
    if (!m) throw Error();
    i += m[0].length;
    return Number(m[0]);
  }
  function term() {
    let v = atom();
    space();
    while (s[i] === '*' || s[i] === '/') {
      const op = s[i++],
        b = atom();
      v = op === '*' ? v * b : v / b;
      space();
    }
    return v;
  }
  function expr() {
    let v = term();
    space();
    while (s[i] === '+' || s[i] === '-') {
      const op = s[i++],
        b = term();
      v = op === '+' ? v + b : v - b;
      space();
    }
    return v;
  }
  try {
    const v = expr();
    space();
    return i === s.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
export const formatNumber = (v, digits = 3) => String(+Number(v).toFixed(digits));

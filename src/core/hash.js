export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function hash64(text) {
  let a = 2166136261, b = 3339675911;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b ^ text.charCodeAt(i), 2246822519); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
export function geometryKey(f) {
  if (f.type === 'sketch') { const { id, type, suppressed, plane, points, entities } = f; return canonicalJson({ id, type, suppressed, plane, points, entities }); }
  const { name, ui, ...geometry } = f; return canonicalJson(geometry);
}

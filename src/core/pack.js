// Text made small, to be kept in a project: a STEP file is mostly numbers and names said again and
// again, and comes to about a seventh in gzip. As base64, so that it is text in the project's JSON.

/** @returns {Promise<string>} the gzip of a text, in base64 */
export async function gzipText(text) {
  const bytes = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** @returns {Promise<string>} the text that gzipText made small. Rejects when it is not that. */
export async function gunzipText(base64) {
  const s = atob(base64),
    bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

// Knowing that a newer CoreCAD is published, and getting all of it.
//
// A tab runs the files it loaded. The site is updated often, and a browser may keep single files
// for a while after that: a tab left open, or reloaded soon after an update, runs an older
// CoreCAD, wholly or in part. For a person that means a missing button; for an MCP client it
// means missing tools, because the tab tells the bridge which commands it has.
//
// src/version.js (written by tools/stamp.py) names the build and lists its files. The page
// compares its own with the published one, and a reload from here first fetches every listed
// file past the browser's cache, so that what loads is all of the new version.
import { BUILD, FILES } from './version.js';

export { BUILD };

/** BUILD and FILES out of the text of a version.js; null when it is not one. */
export function readStamp(text) {
  const build = /BUILD = '([0-9a-z.+-]{1,40})'/.exec(String(text))?.[1];
  if (!build) return null;
  let files = [];
  try {
    files = JSON.parse(/FILES = (\[[\s\S]*?\]);/.exec(text)?.[1] ?? '[]');
  } catch {
    /* no list: the build alone still says whether it is another */
  }
  // paths inside the site only: this list comes over the network
  return { build, files: Array.isArray(files) ? files.filter((f) => typeof f === 'string' && /^[\w./-]+$/.test(f) && !f.includes('..') && !f.startsWith('/')) : [] };
}

const publishedText = async () => {
  const r = await fetch(new URL('./version.js', import.meta.url), { cache: 'no-store' });
  if (!r.ok) throw Error('HTTP ' + r.status);
  return r.text();
};

/** The stamp of what is published now, or null when it cannot be read (no network). */
export async function published(read = publishedText) {
  try {
    return readStamp(await read());
  } catch {
    return null;
  }
}

/**
 * Reloads the page so that it runs what is published now: every file of that version is fetched
 * past the browser's cache first. Without a network it is a plain reload.
 * @param {() => Promise<string>} [read]   where the published version.js comes from (tests)
 * @param {() => void} [reload]
 */
export async function freshReload(read = publishedText, reload = () => location.reload()) {
  const stamp = await published(read),
    root = new URL('../', import.meta.url);
  await Promise.allSettled((stamp?.files.length ? stamp.files : FILES).map((f) => fetch(new URL(f, root), { cache: 'reload' })));
  reload();
}

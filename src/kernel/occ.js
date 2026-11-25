// The geometry kernel: OpenCascade through replicad, loaded from the CDN at pinned versions.
// Worker side (and the main thread of kernel test pages). Import maps do not apply in workers, so
// the URLs are written out. Everything here was observed to work: see docs/KERNEL_NOTES.md.
import opencascade from 'https://cdn.jsdelivr.net/npm/replicad-opencascadejs@1.2.1/dist/replicad_single.js';
import * as replicad from 'https://cdn.jsdelivr.net/npm/replicad@1.2.1/dist/replicad.js';

export const VERSIONS = Object.freeze({ replicad: '1.2.1', occt: 'replicad-opencascadejs 1.2.1' });

let K = null; // { OC, r } once loaded
let loading = null;

/** Loads the kernel once. @returns {Promise<{ OC: any, r: typeof replicad }>} */
export function loadKernel() {
  loading ??= opencascade().then((OC) => {
    replicad.setOC(OC);
    K = { OC, r: replicad };
    return K;
  });
  return loading;
}

/** The loaded kernel; throws when loadKernel() has not finished. */
export function kernel() {
  if (!K) throw new Error('the kernel is not loaded yet');
  return K;
}

/** The text of anything the kernel throws. A WebAssembly.Exception carries no message of its own:
 *  it has to be asked for (KERNEL_NOTES, "Errors"). */
export function errorText(e) {
  if (
    typeof WebAssembly !== 'undefined' &&
    WebAssembly.Exception &&
    e instanceof WebAssembly.Exception
  ) {
    try {
      const m = K?.OC.getExceptionMessage?.(e);
      if (m) return 'OCCT: ' + [].concat(m).join(' ');
    } catch {
      /* fall through */
    }
    return 'OCCT exception (no message)';
  }
  return String(e?.message ?? e);
}

/** True when the module's memory can no longer be trusted: the worker must be restarted. */
export const isFatal = (e) =>
  (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) ||
  e instanceof RangeError;

/** Owns temporaries: s = scope(); const x = s(make()); ...; s.end() deletes what was registered, newest first.
 *  Deleting twice is harmless. */
export function scope() {
  const owned = [];
  const s = (obj) => {
    if (obj && typeof obj.delete === 'function') owned.push(obj);
    return obj;
  };
  s.end = () => {
    while (owned.length) {
      try {
        owned.pop().delete();
      } catch {
        /* already deleted */
      }
    }
  };
  return s;
}

/** Bytes of the kernel's heap (it only ever grows). */
export const heapBytes = () => kernel().OC.wasmMemory.buffer.byteLength;

export const HASH_MAX = 2147483647;
/** The hash code of a raw TopoDS shape, the same number as replicad's shape.hashCode. */
export const hashOf = (raw) => kernel().OC.ReplicadShapeHasher.HashCode(raw, HASH_MAX);

/** Empties an NCollection_List_TopoDS_Shape into an array and deletes the list.
 *  The caller deletes the elements. */
export function listToArray(list) {
  const out = [];
  while (!list.IsEmpty()) {
    out.push(list.First());
    list.RemoveFirst();
  }
  list.delete();
  return out;
}

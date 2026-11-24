// Ids are a letter and a number from a counter: 'f12' (feature), 'p7' 'e9' 'c12' (sketch), 'k3' (blend edge key).
// Lists of ids are kept in the order of their numbers, so that 'e9' comes before 'e12'.

/** The number in an id ('e12' -> 12); NaN when there is none. */
export const idNumber = id => { const m = /(\d+)\s*$/.exec(id); return m ? Number(m[1]) : NaN; };

/** Order by number, then as text (ids without a number last, as text). */
export function compareIds(a, b) {
  const x = idNumber(a), y = idNumber(b);
  if (x === y || (Number.isNaN(x) && Number.isNaN(y))) return a < b ? -1 : a > b ? 1 : 0;
  if (Number.isNaN(x)) return 1;
  if (Number.isNaN(y)) return -1;
  return x - y;
}

/** A sorted copy with duplicates removed. */
export const sortIds = ids => [...new Set(ids)].sort(compareIds);

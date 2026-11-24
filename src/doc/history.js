/** Immutable snapshots, with id watermarks retained when an undo branch is replaced. */
export function createHistory(initial, limit = 200) {
  let entries = [{ doc: initial, label: '', mergeKey: null }], at = 0, featureSeq = initial.seq;
  const sketchSeq = new Map();
  const reserve = doc => {
    featureSeq = Math.max(featureSeq, doc.seq);
    for (const f of doc.features) if (f.type === 'sketch') sketchSeq.set(f.id, Math.max(sketchSeq.get(f.id) ?? 0, f.seq));
    return { ...doc, seq: featureSeq, features: doc.features.map(f => f.type === 'sketch' && f.seq < sketchSeq.get(f.id) ? { ...f, seq: sketchSeq.get(f.id) } : f) };
  };
  return {
    get doc() { return reserve(entries[at].doc); }, get canUndo() { return at > 0; }, get canRedo() { return at < entries.length - 1; },
    get undoLabel() { return entries[at].label; }, get redoLabel() { return entries[at + 1]?.label ?? ''; },
    commit(doc, label, mergeKey = null) {
      doc = reserve(doc); const merge = mergeKey && entries[at].mergeKey === mergeKey && at === entries.length - 1;
      entries = entries.slice(0, at + 1);
      if (merge) entries[at] = { doc, label, mergeKey }; else { entries.push({ doc, label, mergeKey }); at++; }
      if (entries.length > limit + 1) { entries.shift(); at--; }
      return doc;
    }, undo() { if (at > 0) at--; return this.doc; }, redo() { if (at < entries.length - 1) at++; return this.doc; },
  };
}

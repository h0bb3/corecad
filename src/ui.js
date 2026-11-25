export const escapeHTML = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
export const icons = {
  sketch: 'M4 17V5h12M3 20l5-1L20 7l-4-4L4 15zM13 6l4 4',
  extrude: 'm4 10 8-4 8 4-8 4zm0 0v9l8 4 8-4v-9M12 14v9M12 1v7m-3-4 3-3 3 3',
  hole: 'M3 8c0-3 18-3 18 0v10c0 3-18 3-18 0zm4 0c0 3 10 3 10 0s-10-3-10 0M7 8v7m10-7v7',
  fillet: 'M4 20V4h16M4 20C4 9 9 4 20 4M4 14h4m6-10v4',
  chamfer: 'M4 20V4h16M4 14 14 4M4 14h4m6-10v4',
  select: 'm5 3 4 17 4-6 7-3z',
  line: 'm4 20 16-16M3 18v3h3M18 3h3v3',
  rectangle: 'M3 5h18v14H3zM3 8V5h3',
  circle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M10 12h4m-2-2v4',
  arc: 'M4 19A12 12 0 0 1 20 5M2 18h4m13-15v4M7 17h3m-1-1v3',
  point: 'M12 3v5m0 8v5M3 12h5m8 0h5M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
  dimension: 'M3 3v18m18-18v18M3 12h18m-14-3-4 3 4 3m10-6 4 3-4 3',
  construction: 'M3 20l4-4m3-3 4-4m3-3 4-4',
  check: 'm5 12 4 4L20 5',
};
export const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[name] ?? icons.sketch}"/></svg>`;
export const tool = (action, label, tip, active = false) =>
  `<button class="tool${active ? ' active' : ''}" data-action="${action}" title="${escapeHTML(
    tip
  )}">${icon(action)}<span>${escapeHTML(label)}</span></button>`;
export const field = (id, label, value, tip, unit = 'mm') =>
  `<label class="field"><span>${escapeHTML(
    label
  )}</span><div class="input-unit"><input id="${id}" value="${escapeHTML(
    value
  )}" autocomplete="off" spellcheck="false" title="${escapeHTML(
    tip
  )}" inputmode="decimal"><span>${unit}</span></div></label>`;
export const selectField = (id, label, options, value, tip) =>
  `<label class="field"><span>${escapeHTML(label)}</span><select id="${id}" title="${escapeHTML(tip)}">${options
    .map(([v, t]) => `<option value="${escapeHTML(v)}"${v === value ? ' selected' : ''}>${escapeHTML(t)}</option>`)
    .join('')}</select></label>`;
export const check = (id, label, on, tip) =>
  `<label class="check" title="${escapeHTML(tip)}"><input type="checkbox" id="${id}"${
    on ? ' checked' : ''
  } title="${escapeHTML(tip)}">${escapeHTML(label)}</label>`;
export const head = (title, tag = '') =>
  `<div class="panel-head"><h2>${escapeHTML(title)}</h2><span class="step-tag">${tag}</span></div>`;

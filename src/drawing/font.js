// The one typeface of a drawing: Helvetica, which every PDF reader has, and its widths, so that text can be
// placed before it is drawn. Widths are those of the standard Helvetica metrics, in thousandths of the
// height; the characters are those of the WinAnsi encoding that a PDF gives the font.

const ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space to /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0 to ?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @ to O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P to _
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // ` to o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p to ~
];
/** Characters past ASCII that a drawing uses, with their WinAnsi code and width. */
const MORE = {
  'Ø': [0xd8, 778], 'ø': [0xf8, 611], '°': [0xb0, 400], '×': [0xd7, 584], '±': [0xb1, 584], '·': [0xb7, 278],
  'Å': [0xc5, 667], 'Ä': [0xc4, 667], 'Ö': [0xd6, 778], 'å': [0xe5, 556], 'ä': [0xe4, 556], 'ö': [0xf6, 556],
  'É': [0xc9, 667], 'é': [0xe9, 556], 'Ü': [0xdc, 722], 'ü': [0xfc, 556], 'ß': [0xdf, 611], 'Æ': [0xc6, 1000], 'æ': [0xe6, 889],
  '–': [0x96, 556], '—': [0x97, 1000], '’': [0x92, 222], '“': [0x93, 333], '”': [0x94, 333], '€': [0x80, 556], '²': [0xb2, 333], '³': [0xb3, 333],
};

/** The text as the font can write it: what it has no letter for becomes a question mark. */
export const writable = (text) => [...String(text)].map((c) => (MORE[c] || (c >= ' ' && c <= '~') ? c : c === '⌀' ? 'Ø' : '?')).join('');

/** How wide a text is, in mm, at a height of h mm. */
export function textWidth(text, h) {
  let w = 0;
  for (const c of writable(text)) w += MORE[c]?.[1] ?? ASCII[c.charCodeAt(0) - 32] ?? 556;
  return (w / 1000) * h;
}

/** The bytes of a text in WinAnsi, for a PDF. */
export function winAnsi(text) {
  return [...writable(text)].map((c) => MORE[c]?.[0] ?? c.charCodeAt(0));
}

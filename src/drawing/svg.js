// A sheet (drawing/layout.js) as SVG: what the page shows, and what a picture of the drawing is made from.
// The same lines and text as the PDF, in mm. Pure.
const n = (v) => String(+v.toFixed(3));
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param {{ size: number[], items: object[] }} sheet
 * @param {{ ink?: string, paper?: string }} [colours]
 * @returns {string}
 */
export function sheetToSVG(sheet, { ink = '#000', paper = '#fff' } = {}) {
  const [w, h] = sheet.size,
    out = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" width="${n(w)}mm" height="${n(h)}mm">`,
      `<rect width="${n(w)}" height="${n(h)}" fill="${paper}"/>`,
      `<g fill="none" stroke="${ink}" stroke-linecap="round" stroke-linejoin="round">`,
    ];
  const texts = [];
  for (const it of sheet.items) {
    if (it.t === 'path') {
      const p = it.pts;
      let d = `M${n(p[0])} ${n(h - p[1])}`;
      for (let i = 2; i < p.length; i += 2) d += `L${n(p[i])} ${n(h - p[i + 1])}`;
      if (it.closed) d += 'Z';
      out.push(
        `<path d="${d}" stroke-width="${n(it.w)}"${it.dash ? ` stroke-dasharray="${it.dash.map(n).join(' ')}"` : ''}${it.fill ? ` fill="${ink}" stroke="none"` : ''}/>`
      );
    } else if (it.t === 'text') {
      const x = n(it.x),
        y = n(h - it.y);
      texts.push(
        `<text x="${x}" y="${y}" font-size="${n(it.size)}" text-anchor="${it.anchor}"${it.angle ? ` transform="rotate(${n(-it.angle)} ${x} ${y})"` : ''}>${esc(it.text)}</text>`
      );
    }
  }
  out.push('</g>', `<g fill="${ink}" font-family="Helvetica, Arial, sans-serif">`, ...texts, '</g>', '</svg>');
  return out.join('\n');
}

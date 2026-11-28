// A sheet (drawing/layout.js) as a PDF of one page, at its true size: printed at 100 % it measures what the
// scale says. Lines and text stay lines and text. Pure: no library, the file is written here.
import { winAnsi, textWidth as widthOf } from './font.js';

const MM = 72 / 25.4;
const n = (v) => String(+v.toFixed(3));
const hex = (bytes) => '<' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('') + '>';

/**
 * @param {{ size: number[], items: object[] }} sheet
 * @param {{ title?: string, date?: Date }} [info]
 * @returns {Uint8Array}
 */
export function sheetToPDF(sheet, info = {}) {
  const [w, h] = sheet.size,
    ops = [`${n(MM)} 0 0 ${n(MM)} 0 0 cm`, '0 G 0 g 1 J 1 j'];
  let width = null,
    dash = '';
  for (const it of sheet.items) {
    if (it.t === 'path') {
      if (it.w !== width) ops.push(`${n((width = it.w))} w`);
      const d = it.dash ? `[${it.dash.map(n).join(' ')}] 0 d` : '[] 0 d';
      if (d !== dash) ops.push((dash = d));
      const p = it.pts,
        parts = [`${n(p[0])} ${n(p[1])} m`];
      for (let i = 2; i < p.length; i += 2) parts.push(`${n(p[i])} ${n(p[i + 1])} l`);
      if (it.closed) parts.push('h');
      parts.push(it.fill ? 'f' : 'S');
      ops.push(parts.join(' '));
    } else if (it.t === 'text') {
      const a = (it.angle * Math.PI) / 180,
        c = Math.cos(a),
        s = Math.sin(a),
        bytes = winAnsi(it.text),
        shift = it.anchor === 'middle' ? 0.5 : it.anchor === 'end' ? 1 : 0;
      // where the text starts: its anchor less part of its width, along the way it runs
      const tw = shift ? widthOf(it.text, it.size) * shift : 0,
        x = it.x - c * tw,
        y = it.y - s * tw;
      ops.push(`BT /F1 ${n(it.size)} Tf ${n(c)} ${n(s)} ${n(-s)} ${n(c)} ${n(x)} ${n(y)} Tm ${hex(bytes)} Tj ET`);
    }
  }
  const content = ops.join('\n'),
    date = info.date ?? new Date(),
    pad = (v) => String(v).padStart(2, '0'),
    stamp = `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(w * MM)} ${n(h * MM)}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Title ${hex(winAnsi(info.title ?? 'Drawing'))} /Producer (CoreCAD) /CreationDate (${stamp}) >>`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out); // every character is ASCII: the text of the drawing is written in hex
}

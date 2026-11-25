// A 3MF package: the format slicers are built on. Unlike STL it holds several objects, each with
// a name and a colour, and colours of single triangles. Pure: meshes in, the bytes of a .3mf out.
//
// Colours are written the way the core specification has them (a `basematerials` group, `pid` and
// `pindex` on an object, `pid` and `p1` on a triangle that differs): that is what Bambu Studio,
// OrcaSlicer and others read from a file that is not their own.
import { zip } from '../core/zip.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v) => {
  const s = (+v.toFixed(6)).toString();
  return s === '-0' ? '0' : s;
};

/**
 * One closed mesh from a kernel mesh whose faces each have vertices of their own: vertices at the
 * same place become one, so that triangles of neighbouring faces share the edge between them.
 * @param {ArrayLike<number>} positions  x, y, z per vertex
 * @param {ArrayLike<number>} indices    three per triangle
 * @param {(triangle: number) => number} colorOf  the colour number of a triangle, or -1
 * @returns {{ vertices: number[], triangles: number[], colors: number[] }}  flat; one colour number per triangle
 */
export function weld(positions, indices, colorOf = () => -1) {
  const seen = new Map(),
    vertices = [],
    map = new Uint32Array(positions.length / 3);
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[3 * i],
      y = positions[3 * i + 1],
      z = positions[3 * i + 2],
      key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    let at = seen.get(key);
    if (at === undefined) {
      at = vertices.length / 3;
      seen.set(key, at);
      vertices.push(x, y, z);
    }
    map[i] = at;
  }
  const triangles = [],
    colors = [];
  for (let t = 0; t < indices.length / 3; t++) {
    const a = map[indices[3 * t]],
      b = map[indices[3 * t + 1]],
      c = map[indices[3 * t + 2]];
    if (a === b || b === c || a === c) continue; // a sliver that closed up
    triangles.push(a, b, c);
    colors.push(colorOf(t));
  }
  return { vertices, triangles, colors };
}

/** True when every edge of a mesh is used by exactly two triangles, once each way: a closed, consistently turned surface. */
export function isClosed(triangles) {
  const edges = new Map();
  for (let t = 0; t < triangles.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k],
        b = triangles[t + ((k + 1) % 3)];
      edges.set(a + '>' + b, (edges.get(a + '>' + b) ?? 0) + 1);
    }
  for (const [key, n] of edges) {
    const [a, b] = key.split('>');
    if (n !== 1 || edges.get(b + '>' + a) !== 1) return false;
  }
  return true;
}

/**
 * @param {object} model
 * @param {string} model.title
 * @param {{ name: string, color: number, vertices: number[], triangles: number[], colors: number[] }[]} model.objects
 *   color: the number of the object's colour in `colors`, or -1; colors (of an object): one number per triangle,
 *   -1 for a triangle that has the object's own
 * @param {string[]} model.colors  '#rrggbb' each
 * @returns {string} the text of 3D/3dmodel.model
 */
export function modelXml({ title, objects, colors }) {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    ` <metadata name="Title">${esc(title)}</metadata>`,
    ' <metadata name="Application">CoreCAD</metadata>',
    ' <resources>',
  ];
  if (colors.length) {
    out.push('  <basematerials id="1">');
    for (const c of colors) out.push(`   <base name="${esc(c.toUpperCase())}" displaycolor="${esc(c.toUpperCase())}"/>`);
    out.push('  </basematerials>');
  }
  objects.forEach((o, i) => {
    out.push(`  <object id="${i + 2}" type="model" name="${esc(o.name)}"${o.color >= 0 ? ` pid="1" pindex="${o.color}"` : ''}>`, '   <mesh>', '    <vertices>');
    for (let v = 0; v < o.vertices.length; v += 3) out.push(`     <vertex x="${num(o.vertices[v])}" y="${num(o.vertices[v + 1])}" z="${num(o.vertices[v + 2])}"/>`);
    out.push('    </vertices>', '    <triangles>');
    for (let t = 0; t < o.triangles.length; t += 3) {
      const c = o.colors[t / 3];
      out.push(`     <triangle v1="${o.triangles[t]}" v2="${o.triangles[t + 1]}" v3="${o.triangles[t + 2]}"${c >= 0 && c !== o.color ? ` pid="1" p1="${c}"` : ''}/>`);
    }
    out.push('    </triangles>', '   </mesh>', '  </object>');
  });
  out.push(' </resources>', ' <build>');
  objects.forEach((o, i) => out.push(`  <item objectid="${i + 2}"/>`));
  out.push(' </build>', '</model>', '');
  return out.join('\n');
}

/** The bytes of a .3mf file with one model. */
export function package3mf(model) {
  return zip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n',
    },
    { name: '3D/3dmodel.model', data: modelXml(model) },
  ]);
}

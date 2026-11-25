// The colours offered for parts and faces, and reading a colour that was typed or said.

/** [hex, name]: plain colours of the kind filament comes in. */
export const PALETTE = [
  ['#f2f2ee', 'White'],
  ['#2b2b2b', 'Black'],
  ['#8e9aa0', 'Grey'],
  ['#d43f3a', 'Red'],
  ['#e8862e', 'Orange'],
  ['#f2c230', 'Yellow'],
  ['#58a84a', 'Green'],
  ['#2f9c95', 'Teal'],
  ['#2f6fd0', 'Blue'],
  ['#7a52c7', 'Purple'],
  ['#d455a0', 'Pink'],
  ['#8a5a3c', 'Brown'],
];
const NAMES = new Map([...PALETTE.map(([hex, name]) => [name.toLowerCase(), hex]), ['gray', '#8e9aa0']]);

/**
 * '#rrggbb' from what was given: '#rrggbb', '#rgb', or the name of a palette colour. null for
 * none (null, '', 'none'). Throws a sentence when it is none of these.
 */
export function colorFrom(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  if (!text || text === 'none' || text === 'default') return null;
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  if (/^#[0-9a-f]{3}$/.test(text)) return '#' + [...text.slice(1)].map((c) => c + c).join('');
  if (NAMES.has(text)) return NAMES.get(text);
  throw Error(`"${value}" is not a colour: write #rrggbb, or one of ${[...NAMES.keys()].filter((n) => n !== 'gray').join(', ')}; null for none.`);
}

/** The palette's name for a colour, or the colour itself. */
export const colorName = (hex) => PALETTE.find(([h]) => h === hex?.toLowerCase())?.[1].toLowerCase() ?? hex;

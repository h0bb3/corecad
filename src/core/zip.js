// A zip archive with its files stored as they are (no compression): enough for a 3MF package and
// for handing over several files as one download. Pure; bytes in, bytes out.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** The CRC-32 of bytes, as zip wants it. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = (text) => new TextEncoder().encode(text);

/**
 * @param {{ name: string, data: Uint8Array | string }[]} files  in the order they are to be in the archive
 * @returns {Uint8Array}
 */
export function zip(files) {
  const entries = files.map((f) => {
    const data = typeof f.data === 'string' ? utf8(f.data) : f.data;
    return { name: utf8(f.name), data, crc: crc32(data) };
  });
  const size = entries.reduce((n, e) => n + 30 + e.name.length + e.data.length + 46 + e.name.length, 22),
    out = new Uint8Array(size),
    view = new DataView(out.buffer);
  let at = 0;
  const u16 = (v) => (view.setUint16(at, v, true), (at += 2)),
    u32 = (v) => (view.setUint32(at, v, true), (at += 4)),
    put = (bytes) => (out.set(bytes, at), (at += bytes.length));
  // 1980-01-01 00:00: an archive of the same files is the same bytes every time.
  const common = (e) => {
    u16(20); // version needed
    u16(0x0800); // names are UTF-8
    u16(0); // stored
    u16(0); // time
    u16(0x21); // date
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.name.length);
    u16(0); // extra
  };
  for (const e of entries) {
    e.offset = at;
    u32(0x04034b50);
    common(e);
    put(e.name);
    put(e.data);
  }
  const directory = at;
  for (const e of entries) {
    u32(0x02014b50);
    u16(20); // made by
    common(e);
    u16(0); // comment
    u16(0); // disk
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(e.offset);
    put(e.name);
  }
  const length = at - directory;
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(entries.length);
  u16(entries.length);
  u32(length);
  u32(directory);
  u16(0);
  return out;
}

/** The files of an archive made by zip() (stored entries only): [{ name, data }]. For tests and for reading back. */
export function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    out = [];
  let at = 0;
  while (at + 4 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    if (view.getUint16(at + 8, true) !== 0) throw Error('This archive is compressed: only stored files are read.');
    const size = view.getUint32(at + 18, true),
      n = view.getUint16(at + 26, true),
      extra = view.getUint16(at + 28, true),
      start = at + 30 + n + extra;
    out.push({ name: new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + n)), data: bytes.subarray(start, start + size) });
    at = start + size;
  }
  return out;
}

// Minimal ZIP writer for browser PNG-sequence export. Entries are stored, not
// deflated: PNG data is already compressed.
// ponytail: no ZIP64, so under 65535 files and 4 GB; enough for a PNG sequence.

const CRC = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = ~0;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return ~c >>> 0;
};

export function zip(files: [name: string, data: Uint8Array][]): Blob {
  const local: BlobPart[] = [], central: BlobPart[] = [];
  let off = 0, cdSize = 0;
  for (const [name, data] of files) {
    const n = new TextEncoder().encode(name), crc = crc32(data);
    // Fields shared by the local and central headers, starting at `o`:
    // version 2.0, flags 0, method 0 (stored), time 0, date 1980-01-01, crc, sizes, name length.
    const put = (v: DataView, o: number) => {
      v.setUint16(o, 20, true); v.setUint16(o + 8, 33, true); v.setUint32(o + 10, crc, true);
      v.setUint32(o + 14, data.length, true); v.setUint32(o + 18, data.length, true); v.setUint16(o + 22, n.length, true);
    };
    const l = new DataView(new ArrayBuffer(30));
    l.setUint32(0, 0x04034b50, true); put(l, 4);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); put(c, 6); c.setUint32(42, off, true);
    local.push(l, n, data as Uint8Array<ArrayBuffer>);
    central.push(c, n);
    off += 30 + n.length + data.length;
    cdSize += 46 + n.length;
  }
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  return new Blob([...local, ...central, e], { type: 'application/zip' });
}

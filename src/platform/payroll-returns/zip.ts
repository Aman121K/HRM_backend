import { crc32 } from "node:zlib";

/**
 * Minimal ZIP writer (STORED entries, no compression) for bundling generated PDFs — they are already compressed, so
 * deflating again buys nothing. Supports < 65,535 entries and < 4 GB in total (no ZIP64), which is far beyond a year's
 * certificates for one brand.
 */
export function buildZip(entries: { name: string; bytes: Buffer }[], modified = new Date()) {
  const dosTime = (modified.getHours() << 11) | (modified.getMinutes() << 5) | Math.floor(modified.getSeconds() / 2);
  const dosDate = ((modified.getFullYear() - 1980) << 9) | ((modified.getMonth() + 1) << 5) | modified.getDate();
  const locals: Buffer[] = [], central: Buffer[] = [];
  const used = new Set<string>();
  let offset = 0;
  for (const entry of entries) {
    let name = entry.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
    for (let n = 2; used.has(name); n++) name = entry.name.replace(/(\.[^.]*)?$/, `-${n}$1`);
    used.add(name);
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(entry.bytes) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.bytes.length, 18); local.writeUInt32LE(entry.bytes.length, 22); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(0, 10);
    header.writeUInt16LE(dosTime, 12); header.writeUInt16LE(dosDate, 14); header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(entry.bytes.length, 20); header.writeUInt32LE(entry.bytes.length, 24); header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, entry.bytes);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + entry.bytes.length;
  }
  const centralSize = central.reduce((t, b) => t + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

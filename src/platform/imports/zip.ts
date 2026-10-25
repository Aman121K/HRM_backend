import { inflateRawSync } from "node:zlib";

export type ZipEntry = { name: string; bytes: Buffer };
export class ZipError extends Error {}

/**
 * Minimal, defensive ZIP reader (stored + deflate, no ZIP64, no encryption) for the payslip import.
 * Limits guard against zip bombs: entry count, per-entry and total uncompressed size (checked against the
 * declared size AND enforced while inflating).
 */
export function readZip(buffer: Buffer, limits = { maxEntries: 600, maxEntryBytes: 8 * 1024 * 1024, maxTotalBytes: 96 * 1024 * 1024 }): ZipEntry[] {
  let eocd = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 65_535); at--) {
    if (buffer.readUInt32LE(at) === 0x06054b50) { eocd = at; break; }
  }
  if (eocd < 0) throw new ZipError("This is not a valid .zip file.");
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || cursor === 0xffffffff) throw new ZipError("ZIP64 archives are not supported — split the payslips into smaller zips.");
  if (count > limits.maxEntries) throw new ZipError(`A zip may hold at most ${limits.maxEntries} files.`);
  const entries: ZipEntry[] = [];
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new ZipError("The zip's file list is damaged.");
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20), size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString(flags & 0x800 ? "utf8" : "latin1");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue; // directory
    if (flags & 0x1) throw new ZipError(`${name} is password protected.`);
    if (size > limits.maxEntryBytes) throw new ZipError(`${name} is larger than ${Math.round(limits.maxEntryBytes / 1048576)} MB.`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError("The zip expands to more than the allowed total size — split it.");
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipError(`${name}: damaged entry.`);
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(start, start + compressed);
    if (data.length !== compressed) throw new ZipError(`${name}: truncated entry.`);
    let bytes: Buffer;
    if (method === 0) bytes = Buffer.from(data);
    else if (method === 8) {
      try { bytes = inflateRawSync(data, { maxOutputLength: limits.maxEntryBytes }); } catch { throw new ZipError(`${name} could not be decompressed.`); }
    } else throw new ZipError(`${name} uses an unsupported compression method.`);
    if (bytes.length !== size) throw new ZipError(`${name}: size mismatch.`);
    entries.push({ name, bytes });
  }
  return entries;
}

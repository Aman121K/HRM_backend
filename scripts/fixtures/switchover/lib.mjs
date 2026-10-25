import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
export const base = "http://127.0.0.1:4100/api/v2";
export const dir = new URL(".", import.meta.url).pathname;
export const csv = (name) => readFileSync(dir + name, "utf8");
export const as = (tenant, emp) => async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { "x-tenant-id": tenant, "x-employee-id": emp, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: r.status, j, h: r.headers };
};
export const hr = as("blue-tokai", "BT000"), payroll = as("blue-tokai", "BT009"), owner = as("blue-tokai", "BT-OWN"), ravi = as("blue-tokai", "BT002"), gtHr = as("got-tea", "GT001");
export const log = (label, r, f = (j) => j) => console.log(`${label.padEnd(58)} ${r.s} ${JSON.stringify(f(r.j))?.slice(0, 900)}`);
/** Tiny stored (uncompressed) zip writer for test fixtures. */
export function zip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const { name, bytes } of files) {
    const n = Buffer.from(name), crc = crc32(bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, bytes); centrals.push(central, n); offset += 30 + n.length + bytes.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
export const pdf = (text) => Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% ${text}\ntrailer<</Root 1 0 R>>\n%%EOF\n`);

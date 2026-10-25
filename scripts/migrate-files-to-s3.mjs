#!/usr/bin/env node
// Moves stored files between storage drivers, company by company, verifying every byte.
//
//   node scripts/migrate-files-to-s3.mjs --dry-run          # what would move
//   node scripts/migrate-files-to-s3.mjs                    # local → s3 (keeps local copies)
//   node scripts/migrate-files-to-s3.mjs --delete-source    # … and removes local copies after verification
//   node scripts/migrate-files-to-s3.mjs --to local         # s3 → local (rollback)
//   node scripts/migrate-files-to-s3.mjs --org <organization_id>
//
// Needs `npm run build` first (uses the compiled storage module) and FILES_S3_* in .env.
// Each file lands in tenants/<organization_id>/<entity_type>/<category>/<yyyy>/<mm>/<file_id>.<ext>.
// A file is only switched over after the copy has been read back and its SHA-256 matches the database record.
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { keyBelongsTo, objectKey, sha256Hex, storageFor } from "../dist-v2/platform/files/storage.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const target = option("--to") || "s3";
const source = target === "s3" ? "local" : "s3";
const dryRun = flag("--dry-run");
const deleteSource = flag("--delete-source");
const onlyOrg = option("--org");
if (!["s3", "local"].includes(target)) throw new Error("--to must be s3 or local");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const from = storageFor(source);
const to = storageFor(target);
console.log(`Moving files ${source} (${from.location}) → ${target} (${to.location})${dryRun ? " [dry run]" : ""}`);

const rows = (await pool.query(
  `SELECT id, organization_id, entity_type, category, mime_type, sha256, storage_key, created_at
     FROM stored_files WHERE storage_driver=$1 AND storage_key <> '' AND ($2::uuid IS NULL OR organization_id=$2::uuid)
    ORDER BY organization_id, created_at`, [source, onlyOrg || null])).rows;

const manifest = [];
const totals = { moved: 0, skipped: 0, failed: 0, bytes: 0 };
for (const row of rows) {
  const org = row.organization_id;
  const ext = (row.storage_key.match(/\.([a-z0-9]{2,5})$/i) || [])[1]?.toLowerCase() || "bin";
  const newKey = objectKey({ organizationId: org, entityType: row.entity_type, category: row.category, fileId: row.id, ext, at: new Date(row.created_at) });
  const entry = { id: row.id, organizationId: org, from: `${source}:${row.storage_key}`, to: `${target}:${newKey}`, sha256: row.sha256.trim() };
  try {
    if (!keyBelongsTo(row.storage_key, org)) throw new Error("source key is outside the company's folder");
    if (dryRun) { manifest.push({ ...entry, status: "planned" }); totals.skipped += 1; continue; }
    const bytes = await from.get(row.storage_key);
    if (sha256Hex(bytes) !== entry.sha256) throw new Error("source bytes don't match the recorded SHA-256");
    if (!(await to.exists(newKey))) await to.put(newKey, bytes, { contentType: row.mime_type, sha256: entry.sha256, organizationId: org, fileId: row.id });
    const copy = await to.get(newKey);
    if (sha256Hex(copy) !== entry.sha256) throw new Error("copy read back with a different SHA-256");
    const updated = await pool.query(`UPDATE stored_files SET storage_driver=$1, storage_key=$2 WHERE id=$3 AND storage_driver=$4 AND storage_key=$5`,
      [target, newKey, row.id, source, row.storage_key]);
    if (updated.rowCount !== 1) throw new Error("row changed during migration; left as is");
    if (deleteSource) await from.delete(row.storage_key);
    manifest.push({ ...entry, status: "moved", bytes: bytes.length });
    totals.moved += 1; totals.bytes += bytes.length;
  } catch (error) {
    manifest.push({ ...entry, status: "failed", error: error.message });
    totals.failed += 1;
    console.error(`  ✗ ${row.id}: ${error.message}`);
  }
}

mkdirSync(join(process.cwd(), ".data", "migrations"), { recursive: true });
const file = join(process.cwd(), ".data", "migrations", `files-${source}-to-${target}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ source, target, dryRun, totals, manifest }, null, 2));
const byOrg = manifest.reduce((sum, row) => ({ ...sum, [row.organizationId]: (sum[row.organizationId] || 0) + 1 }), {});
console.log(`Done: moved ${totals.moved}, planned/skipped ${totals.skipped}, failed ${totals.failed}, ${(totals.bytes / 1024).toFixed(0)} KB`);
console.log("Files per company:", byOrg);
console.log(`Manifest: ${file}`);
await pool.end();
process.exit(totals.failed ? 1 : 0);

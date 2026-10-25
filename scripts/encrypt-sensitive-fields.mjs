#!/usr/bin/env node
/**
 * Field-encryption maintenance (idempotent, batched). Uses the same implementation as the API
 * (dist-v2/platform/security/field-crypto.js — run `npm run build` first) and the keys from .env.
 *
 *   node scripts/encrypt-sensitive-fields.mjs            backfill: encrypt plaintext PAN/UAN/ESI/bank values not yet encrypted
 *   node scripts/encrypt-sensitive-fields.mjs --verify   decrypt every ciphertext (and compare with plaintext while it still exists)
 *   node scripts/encrypt-sensitive-fields.mjs --rotate   re-encrypt values written under an older key with DATA_ENCRYPTION_ACTIVE_KEY
 *
 * Runs on DATABASE_URL (table owner) because it walks every brand. Never prints identifier values.
 */
import "dotenv/config";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const require = createRequire(import.meta.url);
const crypto = require(join(dirname(fileURLToPath(import.meta.url)), "..", "dist-v2", "platform", "security", "field-crypto.js"));
const mode = process.argv.includes("--verify") ? "verify" : process.argv.includes("--rotate") ? "rotate" : "backfill";
const BATCH = 200;

const TARGETS = [
  { table: "payroll_profiles", key: "employee_id", fields: [
    { column: "pan", kind: "pan" }, { column: "uan", kind: "uan" }, { column: "esi_number", kind: "esi" }, { column: "bank_account", kind: "bank_account" }] },
  { table: "onboarding_joiners", key: "id", fields: [{ column: "pan", plaintext: "pan_number", kind: "pan" }] },
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const info = crypto.assertFieldCryptoConfigured();
console.log(`field-crypto: active key ${info.activeKey}, ring [${info.keys.join(", ")}], mode ${mode}`);

const columnsOf = async (table) => new Set((await pool.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table])).rows.map((row) => row.column_name));

let failures = 0;
for (const target of TARGETS) {
  const columns = await columnsOf(target.table);
  for (const field of target.fields) {
    const plain = field.plaintext || field.column;
    const enc = `${field.column}_enc`, hash = `${field.column}_hash`, last4 = `${field.column}_last4`;
    if (!columns.has(enc)) { console.error(`${target.table}.${enc} missing — apply migration 027 first.`); process.exit(1); }
    const hasPlain = columns.has(plain);
    const ctx = (row) => ({ table: target.table, column: field.column, organizationId: row.organization_id, rowId: row[target.key] });
    let done = 0, checked = 0, mismatched = 0;
    if (mode === "backfill") {
      if (!hasPlain) { console.log(`${target.table}.${plain}: plaintext column already dropped — nothing to backfill`); continue; }
      for (;;) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const rows = (await client.query(
            `SELECT organization_id, ${target.key}, ${plain} AS value FROM ${target.table}
              WHERE ${plain} IS NOT NULL AND ${plain} <> '' AND ${enc} IS NULL ORDER BY organization_id, ${target.key} LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`)).rows;
          for (const row of rows) {
            const sealed = crypto.sealField(field.kind, row.value, ctx(row));
            await client.query(`UPDATE ${target.table} SET ${enc}=$3, ${hash}=$4, ${last4}=$5 WHERE organization_id=$1 AND ${target.key}=$2`,
              [row.organization_id, row[target.key], sealed.enc, sealed.hash, sealed.last4]);
          }
          await client.query("COMMIT");
          done += rows.length;
          if (rows.length < BATCH) break;
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      }
      console.log(`${target.table}.${field.column}: encrypted ${done} value(s)`);
    } else {
      let after = null;
      for (;;) {
        const rows = (await pool.query(
          `SELECT organization_id, ${target.key}, ${enc} AS enc, ${hash} AS hash${hasPlain ? `, ${plain} AS value` : ""} FROM ${target.table}
            WHERE ${enc} IS NOT NULL ${after ? `AND (organization_id, ${target.key}) > ($1::uuid, $2::uuid)` : ""} ORDER BY organization_id, ${target.key} LIMIT ${BATCH}`,
          after ? [after.organization_id, after[target.key]] : [])).rows;
        for (const row of rows) {
          let value;
          try { value = crypto.decryptField(row.enc, ctx(row)); } catch (error) { failures++; console.error(`  FAIL ${target.table} ${row[target.key]}: ${error.message}`); continue; }
          checked++;
          if (hasPlain && row.value && crypto.normalize(field.kind, row.value) !== value) mismatched++;
          if (row.hash !== crypto.blindIndex(field.kind, value, row.organization_id)) mismatched++;
          if (mode === "rotate" && crypto.ciphertextKeyId(row.enc) !== crypto.activeKeyId()) {
            await pool.query(`UPDATE ${target.table} SET ${enc}=$3 WHERE organization_id=$1 AND ${target.key}=$2`,
              [row.organization_id, row[target.key], crypto.encryptField(value, ctx(row))]);
            done++;
          }
        }
        if (rows.length < BATCH) break;
        after = rows[rows.length - 1];
      }
      const pending = hasPlain ? Number((await pool.query(`SELECT count(*) FROM ${target.table} WHERE ${plain} IS NOT NULL AND ${plain} <> '' AND ${enc} IS NULL`)).rows[0].count) : 0;
      failures += mismatched + pending;
      console.log(`${target.table}.${field.column}: ${checked} decrypt OK, ${mismatched} mismatch, ${pending} not yet encrypted${mode === "rotate" ? `, ${done} re-encrypted` : ""}`);
    }
  }
}
await pool.end();
if (failures) { console.error(`${failures} problem(s) found.`); process.exit(2); }

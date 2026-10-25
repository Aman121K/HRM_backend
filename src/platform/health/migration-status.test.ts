import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

const sum = (text: string) => createHash("sha256").update(text).digest("hex");

test("migration status: ok, pending, changed and database-ahead", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migs-"));
  writeFileSync(join(dir, "001_a.sql"), "SELECT 1;\r\n");
  writeFileSync(join(dir, "002_b.sql"), "SELECT 2;\n");
  process.env.MIGRATIONS_DIR = dir;
  const { migrationStatus } = await import("./migration-status");
  const db = (rows: { version: number; checksum: string | null }[]) => async (sql: string) =>
    sql.includes("information_schema") ? { rows: [{ "?column?": 1 }] } : { rows };

  const ok = await migrationStatus(db([{ version: 1, checksum: sum("SELECT 1;\n") }, { version: 2, checksum: null }]));
  assert.equal(ok.status, "ok"); // CRLF normalised; a missing checksum (psql-applied) is not a change
  const pending = await migrationStatus(db([{ version: 1, checksum: null }]));
  assert.deepEqual([pending.status, pending.pending], ["pending", 1]);
  const changed = await migrationStatus(db([{ version: 1, checksum: "x" }, { version: 2, checksum: null }]));
  assert.deepEqual([changed.status, changed.changed], ["changed", 1]);
  const ahead = await migrationStatus(db([{ version: 1, checksum: null }, { version: 2, checksum: null }, { version: 3, checksum: null }]));
  assert.deepEqual([ahead.status, ahead.databaseAhead, ahead.latestApplied], ["ok", 1, 3]);
  delete process.env.MIGRATIONS_DIR;
});

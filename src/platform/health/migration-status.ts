import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Compares the migrations shipped with this build (migrations, or MIGRATIONS_DIR) with schema_migrations.
 * Checksums use the same normalisation as scripts/migrate.mjs (sha256 of the file with CRLF → LF).
 */
type Expected = { version: number; checksum: string };
let expectedCache: Expected[] | null | undefined;

export function migrationsDir() {
  if (process.env.MIGRATIONS_DIR) return resolve(process.env.MIGRATIONS_DIR);
  // dist-v2/platform/health → migrations; src/platform/health (tsx) → migrations
  const fromBuild = resolve(__dirname, "..", "..", "..", "migrations");
  return existsSync(fromBuild) ? fromBuild : resolve(process.cwd(), "migrations");
}

export function expectedMigrations(): Expected[] | null {
  if (expectedCache !== undefined) return expectedCache;
  const dir = migrationsDir();
  if (!existsSync(dir)) return (expectedCache = null);
  expectedCache = readdirSync(dir).filter((file) => /^\d+_.+\.sql$/.test(file)).sort().map((file) => ({
    version: Number(file.split("_")[0]),
    checksum: createHash("sha256").update(readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n")).digest("hex"),
  }));
  return expectedCache;
}

export type MigrationStatus = {
  status: "ok" | "pending" | "changed" | "unknown";
  expected: number | null; applied: number; latestApplied: number | null; latestExpected: number | null;
  pending: number; changed: number; databaseAhead: number;
};

type Query = (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;

export async function migrationStatus(query: Query): Promise<MigrationStatus> {
  const hasChecksum = (await query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_migrations' AND column_name='checksum'`)).rows.length > 0;
  const rows = (await query(`SELECT version${hasChecksum ? ", checksum" : ", NULL AS checksum"} FROM schema_migrations`)).rows
    .map((row) => ({ version: Number(row.version), checksum: (row.checksum as string | null) || null }));
  const applied = new Map(rows.map((row) => [row.version, row.checksum]));
  const expected = expectedMigrations();
  const latestApplied = rows.length ? Math.max(...rows.map((row) => row.version)) : null;
  if (!expected) return { status: "unknown", expected: null, applied: rows.length, latestApplied, latestExpected: null, pending: 0, changed: 0, databaseAhead: 0 };
  const pending = expected.filter((file) => !applied.has(file.version)).length;
  const changed = expected.filter((file) => { const sum = applied.get(file.version); return sum && sum !== file.checksum; }).length;
  const known = new Set(expected.map((file) => file.version));
  const databaseAhead = rows.filter((row) => !known.has(row.version)).length; // a newer release already migrated (rolling deploy): fine
  return {
    status: pending ? "pending" : changed ? "changed" : "ok",
    expected: expected.length, applied: rows.length, latestApplied,
    latestExpected: expected.length ? expected[expected.length - 1].version : null,
    pending, changed, databaseAhead,
  };
}

#!/usr/bin/env node
// Fresh-install migration check (CI: `npm run ci:migrate-check`; locally against a throwaway database).
//
//   DATABASE_URL=postgresql://hrm_app:...@localhost:5432/hrm_ci node scripts/migrate-check.mjs [--write-snapshot] [--compare-db=<url>]
//
// DATABASE_URL must point at an EMPTY database owned by hrm_app, with the hrm_runtime role present
// (db/runtime-role.sql). The check:
//   1. runs every migration through scripts/migrate.mjs (plain SQL, no psql),
//   2. runs it again — must apply nothing (idempotent bookkeeping),
//   3. `migrate.mjs --verify` — nothing pending, every checksum recorded,
//   4. compares the normalised `pg_dump --schema-only` with db/schema.snapshot.sql (and/or --compare-db),
//      so any schema change is visible in review. --write-snapshot regenerates the snapshot after an intended change.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const snapshotFile = path.resolve(here, '..', 'db', 'schema.snapshot.sql');
const args = process.argv.slice(2);
const writeSnapshot = args.includes('--write-snapshot');
const compareDb = args.find((a) => a.startsWith('--compare-db='))?.slice('--compare-db='.length);
const url = process.env.DATABASE_URL;
const fail = (message) => { console.error(`migrate-check: FAIL — ${message}`); process.exit(1); };
if (!url) fail('DATABASE_URL is not set');

const client = new pg.Client({ connectionString: url });
await client.connect();
const tables = (await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n;
await client.end();
if (tables > 0 && !process.env.MIGRATE_CHECK_ALLOW_NONEMPTY) fail(`database is not empty (${tables} tables). Point DATABASE_URL at a fresh database.`);

const run = (extra = []) => {
  const result = spawnSync(process.execPath, [path.join(here, 'migrate.mjs'), ...extra], { encoding: 'utf8', env: process.env });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
};
const first = run();
process.stdout.write(first.out.split('\n').filter((l) => !l.startsWith('Applied ')).join('\n'));
if (first.code !== 0) fail('fresh migration run failed');
console.log(`migrate-check: pass 1 applied ${(first.out.match(/^Applied /gm) || []).length} migrations`);
const second = run();
if (second.code !== 0 || /^Applied /m.test(second.out)) fail(`second run was not a no-op:\n${second.out}`);
console.log('migrate-check: pass 2 applied nothing (idempotent)');
const verify = run(['--verify']);
if (verify.code !== 0) fail(`verify failed:\n${verify.out}`);
console.log(`migrate-check: verify ok — ${verify.out.trim().split('\n').pop()}`);

/** pg_dump --schema-only without comments/SET noise; column lines inside CREATE TABLE sorted (order is cosmetic). */
export function normalisedSchema(connection) {
  const dump = execFileSync('pg_dump', ['--schema-only', '--no-comments', '-d', connection], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = dump.split('\n').filter((l) => l && !l.startsWith('--') && !/^\\(un)?restrict/.test(l) && !l.startsWith('SET ') && !l.startsWith('SELECT pg_catalog.set_config'));
  const out = []; let block = null;
  for (const l of lines) {
    if (/^CREATE TABLE /.test(l)) { out.push(l); block = []; continue; }
    if (block && /^\)/.test(l)) { out.push(...block.map((c) => c.replace(/,$/, '')).sort(), l); block = null; continue; }
    if (block) block.push(l); else out.push(l);
  }
  return `${out.join('\n')}\n`;
}

const hasPgDump = spawnSync('pg_dump', ['--version']).status === 0;
if (!hasPgDump) { console.log('migrate-check: pg_dump not found — schema comparison skipped'); process.exit(0); }
const fresh = normalisedSchema(url);
const diff = (a, b, label) => {
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || '/tmp', 'schema-'));
  fs.writeFileSync(path.join(dir, 'expected.sql'), a); fs.writeFileSync(path.join(dir, 'fresh.sql'), b);
  const result = spawnSync('diff', ['-u', path.join(dir, 'expected.sql'), path.join(dir, 'fresh.sql')], { encoding: 'utf8' });
  if (result.status !== 0) fail(`schema differs from ${label}:\n${result.stdout.slice(0, 20000)}`);
  console.log(`migrate-check: schema identical to ${label}`);
};
if (writeSnapshot) {
  fs.writeFileSync(snapshotFile, fresh);
  console.log(`migrate-check: wrote ${path.relative(process.cwd(), snapshotFile)} (${fresh.split('\n').length} lines)`);
} else if (fs.existsSync(snapshotFile)) diff(fs.readFileSync(snapshotFile, 'utf8'), fresh, 'db/schema.snapshot.sql');
if (compareDb) diff(normalisedSchema(compareDb), fresh, 'the comparison database');
console.log('migrate-check: PASS');

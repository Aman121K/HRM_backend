#!/usr/bin/env node
// ClanChief migration runner.
//
//   npm run db:migrate                      apply pending migrations/NNN_*.sql (as DATABASE_URL = owner role)
//   node scripts/migrate.mjs --status   list applied/pending, verify checksums, change nothing
//   node scripts/migrate.mjs --verify   exit 1 if anything is pending or an applied file changed (CI / readiness)
//   node scripts/migrate.mjs --accept-changed=28,31   re-record checksums of reviewed, already-applied files
//
// Behaviour
// - One advisory lock per database, so two migrate jobs (e.g. two ECS tasks) never interleave.
// - Optional step 0: when DATABASE_ADMIN_URL is set, db/runtime-role.sql runs through it (creates/updates the
//   hrm_runtime role) and RUNTIME_DB_PASSWORD, if set, becomes its password. Without it the role must already exist.
// - Step 1: db/runtime-grants.sql (CONNECT, schema USAGE, default privileges) as the owner role.
// - Step 2: each pending file runs in its own transaction together with its schema_migrations row (version, filename,
//   sha256 checksum). Files are plain SQL — psql meta-commands (\if, \set, :var) are rejected up front.
// - Applied files are checksummed: a row without a checksum (applied by psql or an older runner) adopts the current one;
//   a mismatch aborts before anything is applied, because the database no longer matches the code that describes it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const migrationsDir = path.resolve(process.env.MIGRATIONS_DIR || path.join(root, 'migrations'));
const dbDir = path.join(root, 'db');
const args = process.argv.slice(2);
const mode = args.includes('--status') ? 'status' : args.includes('--verify') ? 'verify' : 'apply';
const accept = new Set((args.find((a) => a.startsWith('--accept-changed='))?.split('=')[1] ?? '')
  .split(',').map((v) => v.trim()).filter(Boolean).map(Number));
const LOCK_KEY = 4_190_032_017; // arbitrary, stable

if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set (owner role, e.g. postgresql://hrm_app:...@host:5432/hrm)');

export const checksum = (text) => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

function fail(message) { console.error(`migrate: ${message}`); process.exit(1); }

function loadFiles() {
  const files = fs.readdirSync(migrationsDir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const seen = new Map();
  return files.map((file) => {
    const version = Number(file.split('_')[0]);
    if (seen.has(version)) fail(`duplicate migration version ${version}: ${seen.get(version)} and ${file}`);
    seen.set(version, file);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // psql-only syntax would be sent verbatim to the server and fail (or worse, half-apply) — refuse it.
    const meta = sql.split('\n').findIndex((line) => /^\s*\\[a-z]/i.test(line));
    if (meta >= 0) fail(`${file}:${meta + 1} uses a psql meta-command; migrations must be plain SQL`);
    return { version, file, sql, checksum: checksum(sql) };
  }).sort((a, b) => a.version - b.version);
}

// TLS comes from the connection string (e.g. ?sslmode=verify-full&sslrootcert=/etc/ssl/rds-global-bundle.pem), as for the API.

async function setupRuntimeRole() {
  if (!process.env.DATABASE_ADMIN_URL) return;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL, application_name: 'hrm-migrate-admin' });
  await admin.connect();
  try {
    await admin.query(fs.readFileSync(path.join(dbDir, 'runtime-role.sql'), 'utf8'));
    if (process.env.RUNTIME_DB_PASSWORD) {
      await admin.query(`ALTER ROLE hrm_runtime PASSWORD ${admin.escapeLiteral(process.env.RUNTIME_DB_PASSWORD)}`);
    }
    console.log('migrate: runtime role hrm_runtime ensured (db/runtime-role.sql)');
  } finally { await admin.end(); }
}

async function main() {
  const files = loadFiles();
  if (mode === 'apply') await setupRuntimeRole();
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'hrm-migrate' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    const exists = (await client.query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t;
    let applied = new Map();
    if (exists) {
      if (mode === 'apply') {
        await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS filename text, ADD COLUMN IF NOT EXISTS checksum text');
      }
      const cols = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_migrations'")).rows.map((r) => r.column_name);
      const hasChecksum = cols.includes('checksum');
      const rows = (await client.query(`SELECT version${hasChecksum ? ', filename, checksum' : ', NULL AS filename, NULL AS checksum'} FROM schema_migrations ORDER BY version`)).rows;
      applied = new Map(rows.map((r) => [Number(r.version), r]));
    }

    const changed = [], adopt = [];
    for (const f of files) {
      const row = applied.get(f.version);
      if (!row) continue;
      if (!row.checksum) adopt.push(f);
      else if (row.checksum !== f.checksum) (accept.has(f.version) ? adopt : changed).push(f);
    }
    const orphans = [...applied.keys()].filter((v) => !files.some((f) => f.version === v));
    const pending = files.filter((f) => !applied.has(f.version));

    if (mode !== 'apply') {
      for (const f of files) {
        const row = applied.get(f.version);
        const state = !row ? 'PENDING' : changed.includes(f) ? 'CHANGED' : row.checksum ? 'ok' : 'ok (no checksum recorded)';
        if (mode === 'status' || state !== 'ok') console.log(`${String(f.version).padStart(3, '0')}  ${state.padEnd(26)} ${f.file}`);
      }
      for (const v of orphans) console.log(`${v}  APPLIED BUT FILE MISSING`);
      const bad = pending.length || changed.length;
      console.log(`migrate: ${files.length} files, ${applied.size} applied, ${pending.length} pending, ${changed.length} changed`);
      process.exitCode = mode === 'verify' && bad ? 1 : 0;
      return;
    }

    if (changed.length) {
      fail(`applied migration(s) changed on disk since they ran: ${changed.map((f) => f.file).join(', ')}.\n` +
        'Never edit an applied migration — add a new one. If the edit is a reviewed no-op for existing databases ' +
        `(comments, a fresh-install fix), re-record it with --accept-changed=${changed.map((f) => f.version).join(',')}`);
    }
    for (const v of orphans) console.warn(`migrate: warning — version ${v} is recorded as applied but has no file in ${migrationsDir}`);

    await client.query(fs.readFileSync(path.join(dbDir, 'runtime-grants.sql'), 'utf8')).catch((error) => {
      if (/role "hrm_runtime" does not exist/.test(error.message)) {
        fail('role hrm_runtime does not exist. Run db/runtime-role.sql as the DBA first (or set DATABASE_ADMIN_URL).');
      }
      throw error;
    });

    for (const f of pending) {
      const started = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(f.sql);
        // 001 creates schema_migrations; add the bookkeeping columns in the same transaction on a fresh database.
        await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS filename text, ADD COLUMN IF NOT EXISTS checksum text');
        await client.query(
          `INSERT INTO schema_migrations(version, filename, checksum) VALUES ($1, $2, $3)
           ON CONFLICT (version) DO UPDATE SET filename = EXCLUDED.filename, checksum = EXCLUDED.checksum`,
          [f.version, f.file, f.checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        fail(`${f.file} failed and was rolled back: ${error.message}`);
      }
      console.log(`Applied ${f.file} (${Date.now() - started} ms)`);
    }
    for (const f of adopt) {
      await client.query('UPDATE schema_migrations SET filename = $2, checksum = $3 WHERE version = $1', [f.version, f.file, f.checksum]);
    }
    if (adopt.length) console.log(`migrate: recorded checksums for ${adopt.length} previously applied file(s)`);
    console.log(`migrate: up to date (${files.length} migrations, ${pending.length} applied now)`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

main().catch((error) => fail(error.stack || error.message));

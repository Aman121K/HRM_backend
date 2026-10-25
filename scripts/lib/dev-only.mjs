// Guard for demo/development scripts (seed-*.mjs, dev-oidc-provider.mjs, simulate-*.mjs). Imported FIRST by each of
// them, so it runs before any other module code. Refuses to run when:
//   - NODE_ENV or APP_ENV is "production" (in the environment or in ./.env), or
//   - DATABASE_URL points at a non-local host (e.g. RDS) — unless ALLOW_DEV_SCRIPTS_ON_REMOTE_DB=true is set for a
//     disposable staging/demo database.
// Production bootstrap is scripts/bootstrap-production.mjs (first super admin only, no demo data).
import fs from 'node:fs';
import path from 'node:path';

const script = path.basename(process.argv[1] || 'this script');
const fileEnv = {};
try {
  for (const line of fs.readFileSync(path.resolve('.env'), 'utf8').split('\n')) {
    const match = /^\s*(NODE_ENV|APP_ENV|DATABASE_URL)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
    if (match) fileEnv[match[1]] = match[2];
  }
} catch { /* no .env */ }
const get = (name) => process.env[name] ?? fileEnv[name] ?? '';
const refuse = (why) => {
  console.error(`${script}: refusing to run — ${why}. Demo/development scripts never run against production.`);
  process.exit(2);
};
if (get('NODE_ENV').toLowerCase() === 'production' || get('APP_ENV').toLowerCase() === 'production') refuse('NODE_ENV/APP_ENV is production');
const databaseUrl = get('DATABASE_URL');
if (databaseUrl && process.env.ALLOW_DEV_SCRIPTS_ON_REMOTE_DB !== 'true') {
  let host = '';
  try { host = new URL(databaseUrl).hostname; } catch { /* unix socket / keyword DSN: local */ }
  if (host && !/^(localhost|127\.0\.0\.1|::1|\[::1\]|postgres|db|hrm-postgres)$/.test(host)) {
    refuse(`DATABASE_URL points at a remote host (${host}); set ALLOW_DEV_SCRIPTS_ON_REMOTE_DB=true only for a disposable demo database`);
  }
}

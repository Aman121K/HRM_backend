#!/usr/bin/env node
// Production bootstrap: creates the FIRST platform super admin, and nothing else (no brands, no employees, no demo data).
//
//   DATABASE_URL=postgresql://hrm_app:...@<rds>/hrm \
//   APP_BASE_URL=https://people.example.com \
//   node scripts/bootstrap-production.mjs --email admin@example.com --name "Platform Admin"
//
// (or BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_NAME). Idempotent: re-running for the same email changes nothing except
// issuing a fresh invite when native sign-in is available and the admin has not activated yet.
//
// Sign-in for the new admin:
// - Native auth (src/platform/auth/local, migration 033): a one-time PLATFORM invite (72 h) is created and its
//   activation link printed (only the token hash is stored). Give it to the admin over a trusted channel.
// - SSO (OIDC): no link is needed — the admin signs in at APP_BASE_URL with the same, verified email and the account is
//   bound to the IdP subject on first sign-in (auth.service.ts).
// Requires migrations to be applied (npm run db:migrate). Uses the owner role: platform tables are not writable by hrm_runtime.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const email = String(arg('email') || process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
const fullName = String(arg('name') || process.env.BOOTSTRAP_ADMIN_NAME || '').trim() || email.split('@')[0];
const appBase = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');

function fail(message) { console.error(`bootstrap: ${message}`); process.exit(1); }
if (!process.env.DATABASE_URL) fail('DATABASE_URL (owner role) is not set.');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) fail('pass --email <address> (or BOOTSTRAP_ADMIN_EMAIL).');
if (/@(northstar\.example|example\.(com|org|net))$/.test(email) && process.env.NODE_ENV === 'production') fail(`refusing placeholder address ${email} in production.`);
if (fullName.length > 200) fail('--name is too long.');

const INVITE_HOURS = 72; // same as native-auth.service.ts INVITE_HOURS

/**
 * Native sign-in (migration 033 + src/platform/auth/local): uses the compiled helpers the API itself uses
 * (newToken / tokenHash / recordAuthEvent in native-auth.shared.js), so the link is accepted by POST /activate exactly
 * like an invite sent from the platform console. Returns null when native auth isn't built/migrated.
 */
async function loadNativeAuth(client) {
  const file = path.resolve(here, '..', 'dist-v2', 'platform', 'auth', 'local', 'native-auth.shared.js');
  if (!fs.existsSync(file)) return null;
  const table = (await client.query("SELECT to_regclass('public.auth_invites') AS t")).rows[0].t;
  if (!table) return null;
  const mod = await import(pathToFileURL(file).href);
  const lib = mod.newToken ? mod : mod.default;
  return typeof lib?.newToken === 'function' && typeof lib?.tokenHash === 'function' ? lib : null;
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'hrm-bootstrap' });
await client.connect();
try {
  const missing = (await client.query(`SELECT t FROM unnest(ARRAY['schema_migrations','users','platform_admins']) t WHERE to_regclass('public.' || t) IS NULL`)).rows.map((r) => r.t);
  if (missing.length) fail(`schema not migrated (missing ${missing.join(', ')}). Run npm run db:migrate first.`);

  await client.query('BEGIN');
  let user = (await client.query('SELECT id, full_name, oidc_subject, last_sign_in_at FROM users WHERE lower(email) = $1', [email])).rows[0];
  let createdUser = false;
  if (!user) {
    user = (await client.query('INSERT INTO users(email, full_name) VALUES ($1, $2) RETURNING id, full_name, oidc_subject, last_sign_in_at', [email, fullName])).rows[0];
    createdUser = true;
  }
  const granted = (await client.query('INSERT INTO platform_admins(user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING user_id', [user.id])).rowCount > 0;

  let invite = null;
  const native = await loadNativeAuth(client);
  const hasPassword = native ? (await client.query('SELECT password_hash IS NOT NULL AS p FROM users WHERE id = $1', [user.id])).rows[0].p : false;
  const activated = Boolean(hasPassword || user.oidc_subject);
  if (native && !activated) {
    await client.query("UPDATE auth_invites SET revoked_at = now() WHERE user_id = $1 AND kind = 'PLATFORM' AND accepted_at IS NULL AND revoked_at IS NULL", [user.id]);
    const raw = native.newToken();
    const row = (await client.query(
      `INSERT INTO auth_invites(kind, organization_id, user_id, email, token_hash, invited_by, expires_at)
       VALUES ('PLATFORM', NULL, $1, $2, $3, NULL, now() + make_interval(hours => $4)) RETURNING expires_at`,
      [user.id, email, native.tokenHash(raw), INVITE_HOURS])).rows[0];
    if (typeof native.recordAuthEvent === 'function') {
      await native.recordAuthEvent(client, { event: 'platform_admin_invited', success: true, userId: user.id, detail: { by: 'bootstrap-production' } });
    }
    invite = { token: raw, expiresAt: row.expires_at };
  }
  await client.query('COMMIT');

  const admins = (await client.query('SELECT count(*)::int AS n FROM platform_admins')).rows[0].n;
  console.log(JSON.stringify({ event: 'bootstrap_platform_admin', userId: user.id, createdUser, grantedPlatformAdmin: granted, platformAdmins: admins }));
  console.log(`\nPlatform super admin ${createdUser ? 'created' : 'already existed'}: ${email}${granted ? '' : ' (already a platform admin)'}`);
  if (invite) {
    const url = invite.url || (invite.token ? `${appBase || '<APP_BASE_URL>'}/activate?token=${encodeURIComponent(invite.token)}` : null);
    console.log(`\nOne-time activation link${invite.expiresAt ? ` (expires ${new Date(invite.expiresAt).toISOString()})` : ''}:\n  ${url}`);
    console.log('Send it to the admin over a trusted channel (not email if avoidable). They set a password and enrol MFA on the');
    console.log('main domain, then open /platform. Re-running this script revokes the previous link and prints a new one.');
  } else if (activated) {
    console.log('\nThis admin has already signed in; no invite issued.');
  } else {
    console.log(`\nNext steps:
  1. SSO: make sure ${email} exists in your identity provider (MFA enforced), with a verified email claim.
  2. Open ${appBase || '<APP_BASE_URL>'}/login on the MAIN domain (not a brand subdomain) and sign in — the account binds
     to the IdP subject on first sign-in. Then open /platform to create brands and their first HR admins.
  ${native ? '' : '3. Native (password) sign-in is not built/migrated in this deployment, so no activation link was printed.'}`);
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  fail(error.message);
} finally {
  await client.end();
}

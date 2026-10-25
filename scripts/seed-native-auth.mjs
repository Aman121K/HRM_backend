// Development only: gives a few demo accounts a known password and an authenticator (TOTP) secret so the first-party
// sign-in, MFA, refresh and reset flows can be exercised locally. Demo header identities keep working unchanged.
// Usage: npm run build && node scripts/seed-native-auth.mjs
// Prints the TOTP secrets (add them to any authenticator app, or use the printed otpauth:// links) and writes them to
// .data/secrets/native-auth-dev.json (mode 0600). Refuses to run in production.
import "dotenv/config";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";

if ((process.env.NODE_ENV || "development") === "production") throw new Error("seed-native-auth must never run in production.");
const require = createRequire(import.meta.url);
const dist = resolve(process.cwd(), "dist-v2/platform");
const { hashPassword } = require(join(dist, "auth/local/password.js"));
const { newTotpSecret, otpauthUrl, newRecoveryCode, recoveryCodeHash } = require(join(dist, "auth/local/totp.js"));
const { encryptField } = require(join(dist, "security/field-crypto.js"));

const PASSWORD = process.env.DEV_NATIVE_PASSWORD || "Blue-Kettle-Morning-42";
// [brand slug or "platform", employee number or email, enrol TOTP?]
const ACCOUNTS = [
  ["blue-tokai", "BT000", true],      // HR admin — MFA required
  ["blue-tokai", "BT-OWN", true],     // owner — MFA required
  ["blue-tokai", "BT002", false],     // employee — MFA optional
  ["blue-tokai", "BT001", true],      // manager with an authenticator (optional MFA, enrolled)
  ["got-tea", "GT001", true],         // got-tea HR
  ["got-tea", "GT003", false],        // got-tea employee
  ["platform", "superadmin@northstar.example", true],
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const out = [];
try {
  const hash = await hashPassword(PASSWORD);
  for (const [brand, who, totp] of ACCOUNTS) {
    const user = brand === "platform"
      ? (await pool.query(`SELECT id, email FROM users WHERE lower(email)=lower($1)`, [who])).rows[0]
      : (await pool.query(`SELECT u.id, u.email FROM employees e JOIN organizations o ON o.id=e.organization_id JOIN users u ON u.id=e.user_id
                             WHERE o.slug=$1 AND e.employee_number=$2`, [brand, who])).rows[0];
    if (!user) { console.warn(`skip ${brand}/${who}: not found`); continue; }
    await pool.query(`UPDATE users SET password_hash=$2, password_changed_at=now(), failed_login_count=0, locked_until=NULL WHERE id=$1`, [user.id, hash]);
    await pool.query(`DELETE FROM auth_password_history WHERE user_id=$1`, [user.id]);
    await pool.query(`DELETE FROM auth_totp_devices WHERE user_id=$1`, [user.id]);
    await pool.query(`DELETE FROM auth_recovery_codes WHERE user_id=$1`, [user.id]);
    const entry = { brand, who, email: user.email, userId: user.id, password: PASSWORD };
    if (totp) {
      const id = (await pool.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
      const secret = newTotpSecret();
      await pool.query(`INSERT INTO auth_totp_devices(id,user_id,name,secret_enc,confirmed_at) VALUES($1,$2,'Dev authenticator',$3,now())`,
        [id, user.id, encryptField(secret, { table: "users", column: "totp_secret", organizationId: user.id, rowId: id })]);
      const codes = Array.from({ length: 10 }, () => newRecoveryCode());
      for (const code of codes) await pool.query(`INSERT INTO auth_recovery_codes(user_id,code_hash) VALUES($1,$2)`, [user.id, recoveryCodeHash(user.id, code)]);
      Object.assign(entry, { totpSecret: secret, otpauthUrl: otpauthUrl(secret, user.email), recoveryCodes: codes });
    }
    out.push(entry);
    console.log(`${brand.padEnd(11)} ${who.padEnd(30)} ${user.email.padEnd(36)} ${entry.totpSecret ? `TOTP ${entry.totpSecret}` : "no MFA"}`);
  }
  const dir = resolve(process.env.DATA_DIR || join(process.cwd(), ".data"), "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "native-auth-dev.json"), JSON.stringify(out, null, 2), { mode: 0o600 });
  console.log(`\nPassword for all of them: ${PASSWORD}\nDetails (recovery codes, otpauth links): ${join(dir, "native-auth-dev.json")}`);
} finally {
  await pool.end();
}

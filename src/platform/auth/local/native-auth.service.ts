import {
  BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit, UnauthorizedException,
} from "@nestjs/common";
import { createHash, timingSafeEqual, randomInt } from "node:crypto";
import type { PoolClient } from "pg";
import { RuntimeConfig } from "../../config/runtime-config";
import { DatabaseService } from "../../database/database.service";
import { brandFromHost, subdomainOriginPattern } from "../../organizations/brand-host";
import { decryptField, encryptField } from "../../security/field-crypto";
import { AuthService, MFA_ROLES } from "../auth.service";
import type { AuthIdentity } from "../auth.types";
import { IdentityRateLimiter } from "../identity-rate-limit";
import { AuthMailer, brandWebUrl, emailButton, paragraphs } from "./auth-mailer";
import {
  auditAccount, BAD_CODE, CHALLENGE_EXPIRED, deviceLabel, emailKey, GENERIC_LOGIN_ERROR, LOCKED_ERROR, maskEmail, newToken, normalizeEmail,
  recordAuthEvent, sleep, tokenHash, uaHash,
} from "./native-auth.shared";
import { dummyVerify, hashPassword, needsRehash, passwordProblem, verifyPassword } from "./password";
import { localTokenKeys } from "./signing-keys";
import { AuthThrottle } from "./throttle";
import { matchTotp, newRecoveryCode, newTotpSecret, otpauthUrl, recoveryCodeHash } from "./totp";

export type ClientInfo = { ip: string; userAgent: string; origin?: string; client: "web" | "mobile"; deviceName?: string };
export type AuthResult = { body: Record<string, unknown>; cookie?: { value: string; maxAge: number } | "clear" };

type Target = { kind: "platform" } | { kind: "any" } | { kind: "brand"; org: { id: string; slug: string; name: string } };
type Eligibility = {
  organization: { id: string; slug: string; name: string } | null; platform: boolean; privileged: boolean;
  mfaRequired: boolean; emailOtp: boolean; maxHours: number; idleMinutes: number;
};
type ChallengeContext = Eligibility & { stage: "verify" | "enroll"; enrollRequired: boolean; client: "web" | "mobile"; deviceName?: string; enrollDeviceId?: string; emailSends?: number };
type UserRow = { id: string; email: string; full_name: string; password_hash: string | null; failed_login_count: number; locked_until: Date | null };

const env = (name: string, fallback: number) => Number(process.env[name] || fallback);
const LOCK_THRESHOLD = () => env("AUTH_LOCKOUT_THRESHOLD", 5);
const LOCK_MINUTES = () => env("AUTH_LOCKOUT_MINUTES", 15);
const LOGIN_PER_IP_PER_MIN = () => env("AUTH_LOGIN_PER_IP_PER_MINUTE", 30);
const IP_FAILURES_PER_15M = () => env("AUTH_IP_FAILURES_PER_15M", 50);
const LOGIN_PER_ACCOUNT_PER_MIN = () => env("AUTH_LOGIN_PER_ACCOUNT_PER_MINUTE", 10);
const PLATFORM_SESSION_HOURS = () => env("AUTH_PLATFORM_SESSION_HOURS", 12);
const PLATFORM_IDLE_MINUTES = () => env("AUTH_PLATFORM_IDLE_MINUTES", 60);
const CHALLENGE_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;
const RESET_MINUTES = 30;
/** Concurrent-refresh tolerance (same IP + user agent only). After this, presenting a spent token revokes the family. */
const REFRESH_RACE_MS = 5_000;
export const INVITE_HOURS = 72;
export const REFRESH_COOKIE = "ns_rt";
export const REFRESH_COOKIE_PATH = "/api/v2/auth/session";

const tooMany = (message = "Too many sign-in attempts from this network. Please wait a few minutes and try again.") =>
  new HttpException({ statusCode: 429, error: "Too Many Requests", message }, HttpStatus.TOO_MANY_REQUESTS);
const unauthorized = (message: string, code?: string) => new UnauthorizedException(code ? { statusCode: 401, error: "Unauthorized", message, code } : message);

@Injectable()
export class NativeAuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("NativeAuth");
  readonly keys = localTokenKeys();
  private readonly throttle: AuthThrottle;
  private readonly perMinute: IdentityRateLimiter;
  private readonly allowedOrigin: (origin: string) => boolean;

  constructor(private readonly database: DatabaseService, private readonly config: RuntimeConfig, private readonly auth: AuthService, private readonly mailer: AuthMailer) {
    this.throttle = new AuthThrottle(config.redisUrl);
    this.perMinute = new IdentityRateLimiter(config.redisUrl, "northstar-auth-rl:");
    const pattern = subdomainOriginPattern(config.appDomain, config.corsOrigins);
    this.allowedOrigin = (origin) => config.corsOrigins.includes(origin) || pattern.test(origin);
  }

  onModuleInit() { this.keys.assertConfigured(); }

  /** The owner pool shaped like a PoolClient, for helpers that also run inside transactions. */
  private readonly sys = { query: (text: string, values: unknown[] = []) => this.database.systemQuery(text, values) } as unknown as Pick<PoolClient, "query">;
  async onModuleDestroy() { await this.throttle.close(); }

  /** Cookie-authenticated endpoints accept browser calls only from the app's own origins (CSRF defence in depth). */
  assertOrigin(origin?: string) {
    if (origin && !this.allowedOrigin(origin)) throw new ForbiddenException("This request did not come from a Northstar page.");
  }

  // ---- public configuration ------------------------------------------------------------------------------------------

  async publicPolicy(slug: string) {
    const row = (await this.database.systemQuery(
      `SELECT coalesce(p.sign_in_methods,'BOTH') AS methods FROM organizations o LEFT JOIN organization_auth_policies p ON p.organization_id=o.id
        WHERE o.slug=$1 AND o.status='ACTIVE'`, [slug])).rows[0];
    if (!row) throw new NotFoundException("We couldn't find that workspace.");
    const sso = !!(this.config.oidcIssuer && this.config.oidcClientId);
    return { password: row.methods !== "SSO", sso: sso && row.methods !== "PASSWORD", signInMethods: row.methods };
  }

  // ---- sign-in -----------------------------------------------------------------------------------------------------

  private async resolveTarget(brand: string | undefined, origin: string | undefined): Promise<Target> {
    const hostBrand = brandFromHost(origin, this.config.appDomain);
    let slug = String(brand || "").toLowerCase();
    if (hostBrand) {
      if (slug && slug !== hostBrand) throw new BadRequestException("Sign in on that workspace's own address.");
      slug = hostBrand;
    }
    if (slug === "platform") return { kind: "platform" };
    if (!slug) return { kind: "any" };
    const org = (await this.database.systemQuery(
      `SELECT id, slug, coalesce(display_name,name) AS name FROM organizations WHERE slug=$1 AND status='ACTIVE'`, [slug])).rows[0];
    if (!org) throw new NotFoundException("We couldn't find that workspace.");
    return { kind: "brand", org: org as { id: string; slug: string; name: string } };
  }

  private async findUser(email: string, client: Pick<PoolClient, "query"> | null = null): Promise<UserRow | undefined> {
    const sql = `SELECT id, email, full_name, password_hash, failed_login_count, locked_until FROM users WHERE lower(email)=$1`;
    return (client ? await client.query(sql, [email]) : await this.database.systemQuery(sql, [email])).rows[0];
  }

  async login(input: { email: string; password: string; brand?: string; deviceName?: string }, info: ClientInfo): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    const key = emailKey(email);
    if ((await this.perMinute.hit(`login-ip:${info.ip}`)).count > LOGIN_PER_IP_PER_MIN()) throw tooMany();
    if ((await this.throttle.peek(`ipfail:${info.ip}`)) >= IP_FAILURES_PER_15M()) throw tooMany();
    if ((await this.perMinute.hit(`login-acct:${key}`)).count > LOGIN_PER_ACCOUNT_PER_MIN()) throw tooMany("Too many sign-in attempts for this account. Please wait a minute.");
    const target = await this.resolveTarget(input.brand, info.origin);
    const user = await this.findUser(email);
    const locked = user ? !!(user.locked_until && new Date(user.locked_until) > new Date()) : (await this.throttle.peek(`fail:${key}`)) >= LOCK_THRESHOLD();
    if (locked) {
      await dummyVerify(input.password);
      await recordAuthEvent(this.database, { event: "sign_in_locked", success: false, userId: user?.id, email, ip: info.ip, userAgent: info.userAgent });
      throw unauthorized(LOCKED_ERROR, "ACCOUNT_LOCKED");
    }
    const ok = user?.password_hash ? await verifyPassword(input.password, user.password_hash) : (await dummyVerify(input.password), false);
    if (!ok || !user) {
      await this.recordFailure(user, email, info, "password", target);
      throw unauthorized(GENERIC_LOGIN_ERROR, "INVALID_CREDENTIALS");
    }
    if (needsRehash(user.password_hash!))
      await this.database.systemQuery(`UPDATE users SET password_hash=$2 WHERE id=$1`, [user.id, await hashPassword(input.password)]);
    const eligibility = await this.eligibility(user.id, target);
    return this.secondFactor(user, eligibility, { ...info, deviceName: input.deviceName || info.deviceName }, false);
  }

  /** Counts a failed password / code: progressive delay, temporary lock with an unlock email, per-IP failure budget. */
  private async recordFailure(user: UserRow | undefined, email: string, info: ClientInfo, kind: "password" | "mfa", target?: Target) {
    const key = emailKey(email);
    const emailFails = await this.throttle.hit(`fail:${key}`, LOCK_MINUTES() * 60);
    await this.throttle.hit(`ipfail:${info.ip}`, 15 * 60);
    let count = emailFails;
    if (user) {
      const row = (await this.database.systemQuery(
        `UPDATE users SET failed_login_count=failed_login_count+1, last_failed_login_at=now() WHERE id=$1 RETURNING failed_login_count`, [user.id])).rows[0];
      count = row.failed_login_count;
      if (count % LOCK_THRESHOLD() === 0) {
        // 15 min, then 30, 60 … capped at 24 h for an account that keeps being attacked.
        const minutes = Math.min(LOCK_MINUTES() * 2 ** (count / LOCK_THRESHOLD() - 1), 24 * 60);
        await this.database.systemQuery(`UPDATE users SET locked_until=now()+make_interval(mins => $2) WHERE id=$1`, [user.id, minutes]);
        await recordAuthEvent(this.database, { event: "account_locked", success: false, userId: user.id, ip: info.ip, userAgent: info.userAgent, detail: { failures: count, minutes } });
        await this.sendUnlockEmail(user, target, minutes).catch((error) => this.logger.warn(`Unlock email failed: ${(error as Error).message}`));
      }
    }
    await recordAuthEvent(this.database, { event: kind === "password" ? "sign_in_failed" : "mfa_failed", success: false, userId: user?.id, email, ip: info.ip, userAgent: info.userAgent });
    await sleep(Math.min(250 * 2 ** Math.max(0, (count % LOCK_THRESHOLD()) - 1), 3000));
  }

  private async sendUnlockEmail(user: UserRow, target: Target | undefined, minutes: number) {
    const raw = newToken();
    const brand = await this.mailBrand(user.id, target?.kind === "brand" ? target.org.id : null);
    await this.database.systemQuery(
      `INSERT INTO auth_one_time_tokens(user_id,purpose,token_hash,organization_id,expires_at) VALUES($1,'UNLOCK',$2,$3,now()+make_interval(mins => $4))`,
      [user.id, tokenHash(raw), brand?.id || null, Math.max(minutes, 60)]);
    const link = brandWebUrl(brand?.slug || null, `/reset-password?unlock=${encodeURIComponent(raw)}`);
    await this.mailer.send(brand?.id || null, user.email, "Sign-in to your account was paused",
      paragraphs(`Hi ${user.full_name},`, `We paused sign-in to your Northstar account after several failed attempts. It unlocks automatically in ${minutes} minutes.`,
        "If this was you, use the button below to unlock it now. If it wasn't you, unlock it and then reset your password.")
      + emailButton("Unlock my account", link) + paragraphs("This link works once and expires in an hour."));
  }

  /** The brand an account email is sent through: the preferred brand if the person belongs to it, else their first. */
  private async mailBrand(userId: string, preferred: string | null) {
    return (await this.database.systemQuery(
      `SELECT o.id, o.slug FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id AND o.status='ACTIVE'
        WHERE m.user_id=$1 AND m.status='ACTIVE' ORDER BY (o.id::text=$2) DESC, coalesce(o.display_name,o.name) LIMIT 1`, [userId, preferred || ""])).rows[0] as { id: string; slug: string } | undefined;
  }

  /** Where this password may take the person, and what second factor that requires. Messages here follow a correct password. */
  private async eligibility(userId: string, target: Target): Promise<Eligibility> {
    const memberships = (await this.database.systemQuery(
      `SELECT m.organization_id AS id, o.slug, coalesce(o.display_name,o.name) AS name, m.role, m.status AS membership_status, coalesce(e.status,'ACTIVE') AS employee_status,
              coalesce(p.sign_in_methods,'BOTH') AS methods, coalesce(p.mfa_required_all,false) AS mfa_all, coalesce(p.email_otp_fallback,true) AS email_otp,
              coalesce(p.session_max_hours,720) AS max_hours, coalesce(p.session_idle_minutes,720) AS idle_minutes
         FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id AND o.status='ACTIVE'
         LEFT JOIN employees e ON e.organization_id=m.organization_id AND e.user_id=m.user_id
         LEFT JOIN organization_auth_policies p ON p.organization_id=m.organization_id
        WHERE m.user_id=$1 ORDER BY coalesce(o.display_name,o.name)`, [userId])).rows;
    const usable = memberships.filter((row) => row.employee_status === "ACTIVE" && row.membership_status === "ACTIVE");
    const isPlatform = !!(await this.database.systemQuery(`SELECT 1 FROM platform_admins WHERE user_id=$1`, [userId])).rowCount;
    const privileged = isPlatform || usable.some((row) => MFA_ROLES.includes(row.role));
    const hasTotp = !!(await this.database.systemQuery(`SELECT 1 FROM auth_totp_devices WHERE user_id=$1 AND confirmed_at IS NOT NULL`, [userId])).rowCount;
    const platformResult = (): Eligibility => ({ organization: null, platform: true, privileged: true, mfaRequired: true, emailOtp: false,
      maxHours: PLATFORM_SESSION_HOURS(), idleMinutes: PLATFORM_IDLE_MINUTES() });
    if (target.kind === "platform") {
      if (!isPlatform) throw new ForbiddenException({ message: "This account is not a platform administrator.", code: "NOT_PLATFORM_ADMIN" });
      return platformResult();
    }
    let chosen = usable.filter((row) => row.methods !== "SSO");
    if (target.kind === "brand") {
      const member = memberships.find((row) => row.id === target.org.id);
      if (!member) throw new ForbiddenException({ message: "Your account isn't part of this workspace. Check the sign-in link, or ask HR to invite you.", code: "NOT_A_MEMBER" });
      if (member.employee_status !== "ACTIVE" || member.membership_status !== "ACTIVE") throw new ForbiddenException({ message: "Your account in this workspace is inactive. Contact your HR team.", code: "ACCOUNT_INACTIVE" });
      if (member.methods === "SSO") throw new ForbiddenException({ message: `${target.org.name} signs in with company single sign-on. Use "Continue with company SSO".`, code: "SSO_ONLY" });
      chosen = [member];
    } else if (!chosen.length) {
      if (isPlatform) return platformResult();
      throw new ForbiddenException({ message: usable.length ? "Your workspace signs in with company single sign-on." : "Your account has no active workspace. Contact your HR team.", code: "NO_PASSWORD_WORKSPACE" });
    }
    const mfaAll = chosen.some((row) => row.mfa_all);
    return {
      organization: { id: chosen[0].id, slug: chosen[0].slug, name: chosen[0].name }, platform: false, privileged,
      mfaRequired: privileged || mfaAll || hasTotp,
      emailOtp: !privileged && chosen.every((row) => row.email_otp),
      maxHours: Math.min(...chosen.map((row) => Number(row.max_hours))), idleMinutes: Math.min(...chosen.map((row) => Number(row.idle_minutes))),
    };
  }

  private async mfaState(userId: string) {
    const row = (await this.database.systemQuery(
      `SELECT (SELECT count(*)::int FROM auth_totp_devices WHERE user_id=$1 AND confirmed_at IS NOT NULL) AS devices,
              (SELECT count(*)::int FROM auth_recovery_codes WHERE user_id=$1 AND used_at IS NULL) AS recovery`, [userId])).rows[0];
    return { devices: row.devices as number, recovery: row.recovery as number };
  }

  /** After a correct password: either a session, or a short-lived challenge for the second factor / enrolment. */
  private async secondFactor(user: UserRow, eligibility: Eligibility, info: ClientInfo, offerEnrolment: boolean): Promise<AuthResult> {
    const { devices, recovery } = await this.mfaState(user.id);
    if (!eligibility.mfaRequired && !offerEnrolment) return this.issueSession(user, eligibility, ["pwd"], info);
    const methods = [...(devices ? ["totp"] : []), ...(devices && recovery ? ["recovery"] : []), ...(eligibility.emailOtp && eligibility.mfaRequired ? ["email"] : [])];
    const enroll = !devices && (offerEnrolment || !methods.length);
    const enrollRequired = enroll && eligibility.mfaRequired && !methods.length;
    const context: ChallengeContext = { ...eligibility, stage: enroll ? "enroll" : "verify", enrollRequired, client: info.client, deviceName: info.deviceName };
    const raw = newToken();
    await this.database.systemQuery(
      `INSERT INTO auth_one_time_tokens(user_id,purpose,token_hash,organization_id,context,expires_at) VALUES($1,'MFA_LOGIN',$2,$3,$4,now()+make_interval(mins => $5))`,
      [user.id, tokenHash(raw), eligibility.organization?.id || null, JSON.stringify(context), CHALLENGE_MINUTES]);
    return { body: {
      status: enroll ? (enrollRequired ? "MFA_ENROLL_REQUIRED" : "MFA_ENROLL_OPTIONAL") : "MFA_REQUIRED",
      challenge: raw, methods, email: methods.includes("email") ? maskEmail(user.email) : undefined, expiresIn: CHALLENGE_MINUTES * 60,
    } };
  }

  private async loadChallenge(client: PoolClient, raw: string) {
    const row = (await client.query(
      `SELECT t.id, t.user_id, t.context, t.attempts, u.email, u.full_name, u.password_hash, u.failed_login_count, u.locked_until
         FROM auth_one_time_tokens t JOIN users u ON u.id=t.user_id
        WHERE t.token_hash=$1 AND t.purpose='MFA_LOGIN' AND t.used_at IS NULL AND t.expires_at > now() FOR UPDATE OF t`, [tokenHash(String(raw || ""))])).rows[0];
    if (!row || row.attempts >= MAX_CODE_ATTEMPTS) throw unauthorized(CHALLENGE_EXPIRED, "CHALLENGE_EXPIRED");
    if (row.locked_until && new Date(row.locked_until) > new Date()) throw unauthorized(LOCKED_ERROR, "ACCOUNT_LOCKED");
    const user: UserRow = { id: row.user_id, email: row.email, full_name: row.full_name, password_hash: row.password_hash, failed_login_count: row.failed_login_count, locked_until: row.locked_until };
    return { id: row.id as string, user, context: row.context as ChallengeContext };
  }

  /** Checks a TOTP code against the user's confirmed devices; the matching step must be newer than the last one used (replay). */
  private async checkTotp(client: Pick<PoolClient, "query">, userId: string, code: string, deviceId?: string, includeUnconfirmed = false) {
    const devices = (await client.query(
      `SELECT id, secret_enc FROM auth_totp_devices WHERE user_id=$1 AND ($2::uuid IS NULL OR id=$2::uuid) AND ($3 OR confirmed_at IS NOT NULL)`,
      [userId, deviceId || null, includeUnconfirmed])).rows;
    for (const device of devices) {
      const secret = decryptField(device.secret_enc, { table: "users", column: "totp_secret", organizationId: userId, rowId: device.id })!;
      const step = matchTotp(secret, code);
      if (step === null) continue;
      const updated = await client.query(
        `UPDATE auth_totp_devices SET last_used_step=$2, last_used_at=now() WHERE id=$1 AND (last_used_step IS NULL OR last_used_step < $2) RETURNING id`, [device.id, step]);
      return updated.rowCount ? device.id as string : null; // same or older step = replay
    }
    return null;
  }

  async verifyMfa(input: { challenge: string; method: "totp" | "recovery" | "email"; code: string }, info: ClientInfo): Promise<AuthResult> {
    let failedUser: UserRow | undefined;
    const outcome = await this.database.platformTransaction(async (client) => {
      const challenge = await this.loadChallenge(client, input.challenge);
      if (challenge.context.stage !== "verify") throw new BadRequestException("Set up your authenticator app first.");
      await client.query(`UPDATE auth_one_time_tokens SET attempts=attempts+1 WHERE id=$1`, [challenge.id]);
      const userId = challenge.user.id;
      let amr: string[] | null = null;
      if (input.method === "totp" && (await this.checkTotp(client, userId, input.code))) amr = ["pwd", "otp", "mfa"];
      if (input.method === "recovery") {
        const used = await client.query(`UPDATE auth_recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id`,
          [userId, recoveryCodeHash(userId, input.code)]);
        if (used.rowCount) amr = ["pwd", "rec", "mfa"];
      }
      if (input.method === "email" && challenge.context.emailOtp) {
        const otp = (await client.query(
          `SELECT id, token_hash FROM auth_one_time_tokens WHERE user_id=$1 AND purpose='EMAIL_OTP' AND used_at IS NULL AND expires_at > now()
              AND context->>'challengeId'=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [userId, challenge.id])).rows[0];
        const expected = otp ? Buffer.from(otp.token_hash) : Buffer.alloc(64);
        const given = Buffer.from(tokenHash(`${challenge.id}|${String(input.code || "").replace(/\s+/g, "")}`));
        if (otp && expected.length === given.length && timingSafeEqual(expected, given)) {
          await client.query(`UPDATE auth_one_time_tokens SET used_at=now() WHERE id=$1`, [otp.id]);
          amr = ["pwd", "email", "mfa"];
        }
      }
      if (!amr) { failedUser = challenge.user; return null; }
      await client.query(`UPDATE auth_one_time_tokens SET used_at=now() WHERE id=$1`, [challenge.id]);
      return { user: challenge.user, context: challenge.context, amr };
    });
    if (!outcome) {
      await this.recordFailure(failedUser, failedUser!.email, info, "mfa");
      throw unauthorized(BAD_CODE, "INVALID_CODE");
    }
    if (outcome.amr.includes("rec")) {
      await recordAuthEvent(this.database, { event: "recovery_code_used", success: true, userId: outcome.user.id, ip: info.ip, userAgent: info.userAgent });
      await auditAccount(this.database, { subjectUserId: outcome.user.id, actorUserId: outcome.user.id, action: "AUTH_RECOVERY_CODE_USED" });
    }
    return this.issueSession(outcome.user, outcome.context, outcome.amr, { ...info, client: outcome.context.client, deviceName: outcome.context.deviceName });
  }

  async sendEmailCode(rawChallenge: string, info: ClientInfo) {
    if ((await this.perMinute.hit(`email-otp-ip:${info.ip}`)).count > 10) throw tooMany();
    const sent = await this.database.platformTransaction(async (client) => {
      const challenge = await this.loadChallenge(client, rawChallenge);
      if (!challenge.context.emailOtp || challenge.context.stage !== "verify") throw new BadRequestException("Email codes aren't available for this account.");
      const sends = (challenge.context.emailSends || 0) + 1;
      if (sends > 3) throw tooMany("We've already sent several codes. Check your inbox (and spam folder), or start again.");
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      await client.query(`UPDATE auth_one_time_tokens SET used_at=now() WHERE user_id=$1 AND purpose='EMAIL_OTP' AND used_at IS NULL`, [challenge.user.id]);
      await client.query(
        `INSERT INTO auth_one_time_tokens(user_id,purpose,token_hash,organization_id,context,expires_at) VALUES($1,'EMAIL_OTP',$2,$3,$4,now()+interval '10 minutes')`,
        [challenge.user.id, tokenHash(`${challenge.id}|${code}`), challenge.context.organization?.id || null, JSON.stringify({ challengeId: challenge.id })]);
      await client.query(`UPDATE auth_one_time_tokens SET context=context || jsonb_build_object('emailSends', $2::int) WHERE id=$1`, [challenge.id, sends]);
      return { user: challenge.user, organizationId: challenge.context.organization?.id || null, code };
    });
    await this.mailer.send(sent.organizationId, sent.user.email, `Your sign-in code is ${sent.code}`,
      paragraphs(`Hi ${sent.user.full_name},`, `Your Northstar sign-in code is: ${sent.code}`, "It expires in 10 minutes. If you didn't try to sign in, change your password — someone may know it."));
    return { body: { sent: true, email: maskEmail(sent.user.email) } };
  }

  /** Enrolment during sign-in or activation (only for accounts that have no authenticator yet). */
  async startEnrollment(rawChallenge: string) {
    return this.database.platformTransaction(async (client) => {
      const challenge = await this.loadChallenge(client, rawChallenge);
      if (challenge.context.stage !== "enroll") throw new BadRequestException("This account already has an authenticator.");
      const confirmed = (await client.query(`SELECT 1 FROM auth_totp_devices WHERE user_id=$1 AND confirmed_at IS NOT NULL`, [challenge.user.id])).rowCount;
      if (confirmed) throw new BadRequestException("This account already has an authenticator.");
      const { id, secret } = await this.createDevice(client, challenge.user.id, "Authenticator app");
      await client.query(`UPDATE auth_one_time_tokens SET context=context || jsonb_build_object('enrollDeviceId', $2::text) WHERE id=$1`, [challenge.id, id]);
      return { body: { secret, otpauthUrl: otpauthUrl(secret, challenge.user.email), account: challenge.user.email } };
    });
  }

  private async createDevice(client: Pick<PoolClient, "query">, userId: string, name: string) {
    await client.query(`DELETE FROM auth_totp_devices WHERE user_id=$1 AND confirmed_at IS NULL`, [userId]);
    const id = (await client.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
    const secret = newTotpSecret();
    const sealed = encryptField(secret, { table: "users", column: "totp_secret", organizationId: userId, rowId: id });
    await client.query(`INSERT INTO auth_totp_devices(id,user_id,name,secret_enc) VALUES($1,$2,$3,$4)`, [id, userId, name, sealed]);
    return { id, secret };
  }

  private async newRecoveryCodes(client: Pick<PoolClient, "query">, userId: string) {
    await client.query(`DELETE FROM auth_recovery_codes WHERE user_id=$1`, [userId]);
    const codes = Array.from({ length: 10 }, () => newRecoveryCode());
    for (const code of codes) await client.query(`INSERT INTO auth_recovery_codes(user_id,code_hash) VALUES($1,$2)`, [userId, recoveryCodeHash(userId, code)]);
    return codes;
  }

  async confirmEnrollment(input: { challenge: string; code: string }, info: ClientInfo): Promise<AuthResult> {
    let failedUser: UserRow | undefined;
    const outcome = await this.database.platformTransaction(async (client) => {
      const challenge = await this.loadChallenge(client, input.challenge);
      const deviceId = challenge.context.enrollDeviceId;
      if (challenge.context.stage !== "enroll" || !deviceId) throw new BadRequestException("Start the authenticator setup first.");
      await client.query(`UPDATE auth_one_time_tokens SET attempts=attempts+1 WHERE id=$1`, [challenge.id]);
      if (!(await this.checkTotp(client, challenge.user.id, input.code, deviceId, true))) { failedUser = challenge.user; return null; }
      await client.query(`UPDATE auth_totp_devices SET confirmed_at=now() WHERE id=$1`, [deviceId]);
      const recoveryCodes = await this.newRecoveryCodes(client, challenge.user.id);
      await client.query(`UPDATE auth_one_time_tokens SET used_at=now() WHERE id=$1`, [challenge.id]);
      await auditAccount(client, { subjectUserId: challenge.user.id, actorUserId: challenge.user.id, action: "AUTH_MFA_ENROLLED", after: { method: "totp", deviceId } });
      return { user: challenge.user, context: challenge.context, recoveryCodes };
    });
    if (!outcome) {
      await this.recordFailure(failedUser, failedUser!.email, info, "mfa");
      throw unauthorized(BAD_CODE, "INVALID_CODE");
    }
    await recordAuthEvent(this.database, { event: "mfa_enrolled", success: true, userId: outcome.user.id, ip: info.ip, userAgent: info.userAgent });
    const eligibility = { ...outcome.context, mfaRequired: true };
    const result = await this.issueSession(outcome.user, eligibility, ["pwd", "otp", "mfa"], { ...info, client: outcome.context.client, deviceName: outcome.context.deviceName });
    return { ...result, body: { ...result.body, recoveryCodes: outcome.recoveryCodes } };
  }

  /** "Not now" on optional enrolment: continue with whatever the policy requires (email code) or sign straight in. */
  async skipEnrollment(rawChallenge: string, info: ClientInfo): Promise<AuthResult> {
    const outcome = await this.database.platformTransaction(async (client) => {
      const challenge = await this.loadChallenge(client, rawChallenge);
      if (challenge.context.stage !== "enroll" || challenge.context.enrollRequired) throw new BadRequestException("Your workspace requires an authenticator app.");
      await client.query(`UPDATE auth_one_time_tokens SET used_at=now() WHERE id=$1`, [challenge.id]);
      await client.query(`DELETE FROM auth_totp_devices WHERE user_id=$1 AND confirmed_at IS NULL`, [challenge.user.id]);
      return challenge;
    });
    return this.secondFactor(outcome.user, outcome.context, { ...info, client: outcome.context.client, deviceName: outcome.context.deviceName }, false);
  }

  // ---- sessions ----------------------------------------------------------------------------------------------------

  private async issueSession(user: Pick<UserRow, "id" | "email" | "full_name">, eligibility: Eligibility, amr: string[], info: ClientInfo): Promise<AuthResult> {
    const session = (await this.database.systemQuery(
      `INSERT INTO auth_sessions(user_id,organization_id,client,device,user_agent_hash,ip,amr,idle_minutes,absolute_expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+make_interval(hours => $9)) RETURNING id, absolute_expires_at`,
      [user.id, eligibility.organization?.id || null, info.client, deviceLabel(info.userAgent, info.deviceName), uaHash(info.userAgent), info.ip, amr,
        eligibility.idleMinutes, eligibility.maxHours])).rows[0];
    const refresh = newToken();
    await this.database.systemQuery(`INSERT INTO auth_refresh_tokens(session_id,token_hash) VALUES($1,$2)`, [session.id, tokenHash(refresh)]);
    await this.database.systemQuery(`UPDATE users SET failed_login_count=0, locked_until=NULL, last_sign_in_at=now() WHERE id=$1`, [user.id]);
    await this.throttle.clear(`fail:${emailKey(user.email)}`);
    await recordAuthEvent(this.database, { event: "sign_in", success: true, userId: user.id, organizationId: eligibility.organization?.id, ip: info.ip, userAgent: info.userAgent, detail: { amr, client: info.client } });
    const access = await this.keys.sign({ userId: user.id, sessionId: session.id, amr });
    const maxAge = Math.max(60, Math.floor((new Date(session.absolute_expires_at).getTime() - Date.now()) / 1000));
    return {
      body: {
        status: "OK", accessToken: access.token, tokenType: "Bearer", expiresIn: access.expiresIn,
        session: { id: session.id, absoluteExpiresAt: session.absolute_expires_at, idleMinutes: eligibility.idleMinutes },
        user: { id: user.id, email: user.email, fullName: user.full_name },
        organization: eligibility.organization, platform: eligibility.platform,
        ...(info.client === "mobile" ? { refreshToken: refresh } : {}),
      },
      cookie: info.client === "mobile" ? undefined : { value: refresh, maxAge },
    };
  }

  async refresh(raw: string | undefined, info: ClientInfo): Promise<AuthResult> {
    if (!raw) throw unauthorized("No session to refresh. Please sign in.", "NO_SESSION");
    if ((await this.perMinute.hit(`refresh-ip:${info.ip}`)).count > 120) throw tooMany();
    const outcome = await this.database.platformTransaction(async (client) => {
      const row = (await client.query(
        `SELECT t.id, t.used_at, s.id AS session_id, s.user_id, s.revoked_at, s.absolute_expires_at, s.last_seen_at, s.idle_minutes, s.amr, s.ip, s.user_agent_hash,
                u.email, u.full_name
           FROM auth_refresh_tokens t JOIN auth_sessions s ON s.id=t.session_id JOIN users u ON u.id=s.user_id
          WHERE t.token_hash=$1 FOR UPDATE OF t, s`, [tokenHash(raw)])).rows[0];
      if (!row || row.revoked_at) return { kind: "invalid" as const };
      if (row.used_at) {
        // Two tabs refreshing at the same instant: tolerate briefly from the same device instead of nuking the session.
        if (Date.now() - new Date(row.used_at).getTime() < REFRESH_RACE_MS && row.ip === info.ip && row.user_agent_hash === uaHash(info.userAgent))
          return { kind: "race" as const };
        await client.query(`UPDATE auth_sessions SET revoked_at=now(), revoked_reason='refresh_token_reuse' WHERE id=$1`, [row.session_id]);
        return { kind: "reuse" as const, userId: row.user_id, sessionId: row.session_id };
      }
      const idleExpired = new Date(row.last_seen_at).getTime() + row.idle_minutes * 60_000 < Date.now();
      if (new Date(row.absolute_expires_at) <= new Date() || idleExpired) {
        await client.query(`UPDATE auth_sessions SET revoked_at=now(), revoked_reason='expired' WHERE id=$1`, [row.session_id]);
        return { kind: "expired" as const, sessionId: row.session_id };
      }
      const allowed = (await client.query(
        `SELECT EXISTS(SELECT 1 FROM platform_admins WHERE user_id=$1) OR EXISTS(
            SELECT 1 FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id AND o.status='ACTIVE'
              LEFT JOIN employees e ON e.organization_id=m.organization_id AND e.user_id=m.user_id
              LEFT JOIN organization_auth_policies p ON p.organization_id=m.organization_id
             WHERE m.user_id=$1 AND m.status='ACTIVE' AND coalesce(e.status,'ACTIVE')='ACTIVE' AND coalesce(p.sign_in_methods,'BOTH')<>'SSO') AS ok`, [row.user_id])).rows[0].ok;
      if (!allowed) {
        await client.query(`UPDATE auth_sessions SET revoked_at=now(), revoked_reason='access_removed' WHERE id=$1`, [row.session_id]);
        return { kind: "expired" as const, sessionId: row.session_id };
      }
      const next = newToken();
      await client.query(`UPDATE auth_refresh_tokens SET used_at=now() WHERE id=$1`, [row.id]);
      await client.query(`INSERT INTO auth_refresh_tokens(session_id,token_hash) VALUES($1,$2)`, [row.session_id, tokenHash(next)]);
      await client.query(`UPDATE auth_sessions SET last_seen_at=now(), ip=$2 WHERE id=$1`, [row.session_id, info.ip]);
      return { kind: "ok" as const, next, row };
    });
    if (outcome.kind === "race") throw unauthorized("Your session was just refreshed in another tab. Retry.", "REFRESH_RACE");
    if (outcome.kind === "reuse") {
      this.auth.forgetSession(outcome.sessionId);
      await recordAuthEvent(this.database, { event: "refresh_token_reuse", success: false, userId: outcome.userId, ip: info.ip, userAgent: info.userAgent, detail: { sessionId: outcome.sessionId } });
      await auditAccount(this.database, { subjectUserId: outcome.userId, actorUserId: outcome.userId, action: "AUTH_SESSION_REVOKED_TOKEN_REUSE", after: { sessionId: outcome.sessionId } });
      return Promise.reject(unauthorized("For your security this session was signed out because its refresh token was used twice. Please sign in again.", "REFRESH_REUSED"));
    }
    if (outcome.kind !== "ok") {
      if (outcome.kind === "expired") this.auth.forgetSession(outcome.sessionId);
      throw unauthorized("Your session has ended. Please sign in again.", "SESSION_ENDED");
    }
    const { row, next } = outcome;
    const access = await this.keys.sign({ userId: row.user_id, sessionId: row.session_id, amr: row.amr });
    const maxAge = Math.max(60, Math.floor((new Date(row.absolute_expires_at).getTime() - Date.now()) / 1000));
    return {
      body: { status: "OK", accessToken: access.token, tokenType: "Bearer", expiresIn: access.expiresIn, session: { id: row.session_id, absoluteExpiresAt: row.absolute_expires_at },
        user: { id: row.user_id, email: row.email, fullName: row.full_name }, ...(info.client === "mobile" ? { refreshToken: next } : {}) },
      cookie: info.client === "mobile" ? undefined : { value: next, maxAge },
    };
  }

  /** Sign-out: revokes the refresh family named by the cookie / body token, and the session of the bearer token if any. */
  async logout(raw: string | undefined, identity: AuthIdentity | undefined, info: ClientInfo): Promise<AuthResult> {
    const ids = new Set<string>();
    if (raw) {
      const row = (await this.database.systemQuery(`SELECT session_id FROM auth_refresh_tokens WHERE token_hash=$1`, [tokenHash(raw)])).rows[0];
      if (row) ids.add(row.session_id);
    }
    if (identity?.sessionId) ids.add(identity.sessionId);
    for (const id of ids) {
      const revoked = (await this.database.systemQuery(`UPDATE auth_sessions SET revoked_at=now(), revoked_reason='sign_out' WHERE id=$1 AND revoked_at IS NULL RETURNING user_id`, [id])).rows[0];
      this.auth.forgetSession(id);
      if (revoked) await recordAuthEvent(this.database, { event: "sign_out", success: true, userId: revoked.user_id, ip: info.ip, userAgent: info.userAgent });
    }
    return { body: { signedOut: true }, cookie: "clear" };
  }

  /** Revokes sessions of a user (all, or all but one) and drops them from this process's cache immediately. */
  async revokeSessions(userId: string, reason: string, options: { except?: string; only?: string } = {}) {
    const rows = (await this.database.systemQuery(
      `UPDATE auth_sessions SET revoked_at=now(), revoked_reason=$2 WHERE user_id=$1 AND revoked_at IS NULL
          AND ($3::uuid IS NULL OR id<>$3::uuid) AND ($4::uuid IS NULL OR id=$4::uuid) RETURNING id`,
      [userId, reason, options.except || null, options.only || null])).rows;
    for (const row of rows) this.auth.forgetSession(row.id);
    return rows.length;
  }

  // ---- my security ---------------------------------------------------------------------------------------------------

  async overview(identity: AuthIdentity) {
    const userId = identity.userId;
    const user = (await this.database.systemQuery(`SELECT email, full_name, password_hash IS NOT NULL AS has_password, password_changed_at, oidc_subject IS NOT NULL AS sso FROM users WHERE id=$1`, [userId])).rows[0];
    if (!user) throw new NotFoundException("Account not found.");
    const devices = (await this.database.systemQuery(
      `SELECT id, name, created_at AS "createdAt", last_used_at AS "lastUsedAt" FROM auth_totp_devices WHERE user_id=$1 AND confirmed_at IS NOT NULL ORDER BY created_at`, [userId])).rows;
    const { recovery } = await this.mfaState(userId);
    const sessions = (await this.database.systemQuery(
      `SELECT id, client, device, ip, created_at AS "createdAt", last_seen_at AS "lastSeenAt", absolute_expires_at AS "expiresAt", amr
         FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL AND absolute_expires_at > now()
          AND last_seen_at + make_interval(mins => idle_minutes) > now() ORDER BY last_seen_at DESC LIMIT 50`, [userId])).rows
      .map((row) => ({ ...row, current: row.id === identity.sessionId }));
    const events = (await this.database.systemQuery(
      `SELECT event, success, ip, created_at AS "createdAt" FROM auth_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 15`, [userId])).rows;
    const privileged = identity.roles.some((role) => MFA_ROLES.includes(role)) || identity.roles.includes("PLATFORM_ADMIN");
    return {
      email: user.email, fullName: user.full_name, hasPassword: user.has_password, passwordChangedAt: user.password_changed_at, ssoLinked: user.sso,
      authMethod: identity.authMethod, currentSessionId: identity.sessionId || null,
      mfa: { required: privileged, devices, recoveryCodesRemaining: recovery },
      sessions, events,
    };
  }

  private async requirePassword(userId: string, password: string | undefined, info: ClientInfo) {
    const user = (await this.database.systemQuery(`SELECT id, email, full_name, password_hash, failed_login_count, locked_until FROM users WHERE id=$1`, [userId])).rows[0] as UserRow;
    if (!user?.password_hash) return user; // SSO-only account: no password to confirm
    if (user.locked_until && new Date(user.locked_until) > new Date()) throw unauthorized(LOCKED_ERROR, "ACCOUNT_LOCKED");
    if (!password || !(await verifyPassword(password, user.password_hash))) {
      await this.recordFailure(user, user.email, info, "password");
      throw new BadRequestException({ message: "Your current password is incorrect.", code: "WRONG_PASSWORD" });
    }
    return user;
  }

  private async requireCurrentMfa(userId: string, code: string | undefined, info: ClientInfo, user: UserRow) {
    const { devices } = await this.mfaState(userId);
    if (!devices) return;
    if (!code || !(await this.checkTotp(this.sys, userId, code))) {
      await this.recordFailure(user, user.email, info, "mfa");
      throw new BadRequestException({ message: "Enter a current code from your authenticator app.", code: "MFA_CODE_REQUIRED" });
    }
  }

  async changePassword(identity: AuthIdentity, input: { currentPassword: string; newPassword: string; code?: string }, info: ClientInfo) {
    const user = await this.requirePassword(identity.userId, input.currentPassword, info);
    if (!user?.password_hash) throw new BadRequestException("Your account signs in with company SSO and has no password.");
    await this.requireCurrentMfa(identity.userId, input.code, info, user);
    await this.setPassword(user, input.newPassword);
    const revoked = await this.revokeSessions(user.id, "password_changed", { except: identity.sessionId });
    await auditAccount(this.database, { subjectUserId: user.id, actorUserId: user.id, action: "AUTH_PASSWORD_CHANGED", after: { otherSessionsRevoked: revoked } });
    await recordAuthEvent(this.database, { event: "password_changed", success: true, userId: user.id, ip: info.ip, userAgent: info.userAgent });
    const brand = await this.mailBrand(user.id, identity.organizationId || null);
    await this.mailer.send(brand?.id || null, user.email, "Your password was changed",
      paragraphs(`Hi ${user.full_name},`, "The password for your Northstar account was just changed, and your other devices were signed out.",
        "If this wasn't you, reset your password straight away and tell your HR team.")).catch(() => undefined);
    return { changed: true, otherSessionsRevoked: revoked };
  }

  /** Policy + history check, then store. Used by activation, reset and change. */
  private async setPassword(user: Pick<UserRow, "id" | "email" | "full_name">, password: string, client?: PoolClient) {
    const problem = passwordProblem(password, { email: user.email, fullName: user.full_name, extraWords: ["northstar"] });
    if (problem) throw new BadRequestException({ message: problem, code: "WEAK_PASSWORD" });
    const query = (text: string, values: unknown[]) => (client ? client.query(text, values) : this.database.systemQuery(text, values));
    const history = (await query(
      `SELECT password_hash FROM (SELECT password_hash, created_at FROM auth_password_history WHERE user_id=$1
          UNION ALL SELECT password_hash, now() FROM users WHERE id=$1 AND password_hash IS NOT NULL) h ORDER BY created_at DESC LIMIT 5`, [user.id])).rows;
    for (const row of history)
      if (await verifyPassword(password, row.password_hash)) throw new BadRequestException({ message: "Choose a password you haven't used recently.", code: "PASSWORD_REUSED" });
    const hash = await hashPassword(password);
    await query(`INSERT INTO auth_password_history(user_id,password_hash) VALUES($1,$2)`, [user.id, hash]);
    await query(`DELETE FROM auth_password_history WHERE user_id=$1 AND id NOT IN (SELECT id FROM auth_password_history WHERE user_id=$1 ORDER BY created_at DESC, id DESC LIMIT 5)`, [user.id]);
    await query(`UPDATE users SET password_hash=$2, password_changed_at=now(), failed_login_count=0, locked_until=NULL WHERE id=$1`, [user.id, hash]);
  }

  async startTotp(identity: AuthIdentity, input: { currentPassword?: string; name?: string }, info: ClientInfo) {
    await this.requirePassword(identity.userId, input.currentPassword, info);
    const user = (await this.database.systemQuery(`SELECT email FROM users WHERE id=$1`, [identity.userId])).rows[0];
    const { devices } = await this.mfaState(identity.userId);
    if (devices >= 3) throw new BadRequestException("You can register up to three authenticator apps. Remove one first.");
    const created = await this.database.platformTransaction((client) => this.createDevice(client, identity.userId, (input.name || "Authenticator app").slice(0, 60)));
    return { deviceId: created.id, secret: created.secret, otpauthUrl: otpauthUrl(created.secret, user.email), account: user.email };
  }

  async confirmTotp(identity: AuthIdentity, input: { deviceId: string; code: string }, info: ClientInfo) {
    const result = await this.database.platformTransaction(async (client) => {
      const device = (await client.query(`SELECT id FROM auth_totp_devices WHERE id=$1 AND user_id=$2 AND confirmed_at IS NULL`, [input.deviceId, identity.userId])).rows[0];
      if (!device) throw new BadRequestException("Start the authenticator setup again.");
      if (!(await this.checkTotp(client, identity.userId, input.code, input.deviceId, true))) return null;
      const first = !(await client.query(`SELECT 1 FROM auth_totp_devices WHERE user_id=$1 AND confirmed_at IS NOT NULL`, [identity.userId])).rowCount;
      await client.query(`UPDATE auth_totp_devices SET confirmed_at=now() WHERE id=$1`, [input.deviceId]);
      const recoveryCodes = first ? await this.newRecoveryCodes(client, identity.userId) : undefined;
      await auditAccount(client, { subjectUserId: identity.userId, actorUserId: identity.userId, action: "AUTH_MFA_ENROLLED", after: { method: "totp", deviceId: input.deviceId } });
      return { confirmed: true, recoveryCodes };
    });
    if (!result) throw new BadRequestException({ message: BAD_CODE, code: "INVALID_CODE" });
    await recordAuthEvent(this.database, { event: "mfa_enrolled", success: true, userId: identity.userId, ip: info.ip, userAgent: info.userAgent });
    return result;
  }

  async removeTotp(identity: AuthIdentity, deviceId: string, input: { currentPassword?: string; code?: string }, info: ClientInfo) {
    const user = await this.requirePassword(identity.userId, input.currentPassword, info);
    await this.requireCurrentMfa(identity.userId, input.code, info, user);
    const { devices } = await this.mfaState(identity.userId);
    const privileged = identity.roles.some((role) => MFA_ROLES.includes(role)) || identity.roles.includes("PLATFORM_ADMIN");
    if (devices <= 1 && privileged) throw new BadRequestException("Your role requires multi-factor authentication. Add another authenticator before removing this one.");
    const removed = await this.database.systemQuery(`DELETE FROM auth_totp_devices WHERE id=$1 AND user_id=$2 RETURNING id`, [deviceId, identity.userId]);
    if (!removed.rowCount) throw new NotFoundException("Authenticator not found.");
    if (devices <= 1) await this.database.systemQuery(`DELETE FROM auth_recovery_codes WHERE user_id=$1`, [identity.userId]);
    await auditAccount(this.database, { subjectUserId: identity.userId, actorUserId: identity.userId, action: "AUTH_MFA_REMOVED", before: { deviceId } });
    await recordAuthEvent(this.database, { event: "mfa_removed", success: true, userId: identity.userId, ip: info.ip, userAgent: info.userAgent });
    return { removed: true };
  }

  async regenerateRecoveryCodes(identity: AuthIdentity, input: { code: string }, info: ClientInfo) {
    const user = (await this.database.systemQuery(`SELECT id, email, full_name, password_hash, failed_login_count, locked_until FROM users WHERE id=$1`, [identity.userId])).rows[0] as UserRow;
    const { devices } = await this.mfaState(identity.userId);
    if (!devices) throw new BadRequestException("Set up an authenticator app first.");
    await this.requireCurrentMfa(identity.userId, input.code, info, user);
    const codes = await this.database.platformTransaction((client) => this.newRecoveryCodes(client, identity.userId));
    await auditAccount(this.database, { subjectUserId: identity.userId, actorUserId: identity.userId, action: "AUTH_RECOVERY_CODES_REGENERATED" });
    return { recoveryCodes: codes };
  }

  async revokeSession(identity: AuthIdentity, sessionId: string) {
    const count = await this.revokeSessions(identity.userId, "revoked_by_user", { only: sessionId });
    if (!count) throw new NotFoundException("Session not found.");
    await auditAccount(this.database, { subjectUserId: identity.userId, actorUserId: identity.userId, action: "AUTH_SESSION_REVOKED", after: { sessionId } });
    return { revoked: true, current: sessionId === identity.sessionId };
  }

  async revokeAll(identity: AuthIdentity, info: ClientInfo) {
    const count = await this.revokeSessions(identity.userId, "signed_out_everywhere");
    await auditAccount(this.database, { subjectUserId: identity.userId, actorUserId: identity.userId, action: "AUTH_SIGNED_OUT_EVERYWHERE", after: { sessions: count } });
    await recordAuthEvent(this.database, { event: "sign_out_everywhere", success: true, userId: identity.userId, ip: info.ip, userAgent: info.userAgent });
    return { revoked: count };
  }

  // ---- password reset / unlock ------------------------------------------------------------------------------------------

  /** Always answers the same way; the email is only sent when an account with a password exists. */
  async forgotPassword(input: { email: string; brand?: string }, info: ClientInfo) {
    if ((await this.perMinute.hit(`forgot-ip:${info.ip}`)).count > 10) throw tooMany();
    const email = normalizeEmail(input.email);
    const target = await this.resolveTarget(input.brand, info.origin).catch(() => ({ kind: "any" } as Target));
    // Work happens after the response so timing doesn't reveal whether the account exists.
    setImmediate(() => void this.sendReset(email, target, info).catch((error) => this.logger.warn(`Reset email failed: ${(error as Error).message}`)));
    return { accepted: true, message: "If an account exists for that email, we've sent a link to reset the password. It expires in 30 minutes." };
  }

  private async sendReset(email: string, target: Target, info: ClientInfo) {
    if ((await this.throttle.hit(`reset:${emailKey(email)}`, 3600)) > 3) return;
    const user = await this.findUser(email);
    if (!user?.password_hash) { await recordAuthEvent(this.database, { event: "password_reset_requested", success: false, email, ip: info.ip, userAgent: info.userAgent }); return; }
    const raw = newToken();
    const brand = await this.mailBrand(user.id, target.kind === "brand" ? target.org.id : null);
    await this.database.systemQuery(
      `INSERT INTO auth_one_time_tokens(user_id,purpose,token_hash,organization_id,expires_at) VALUES($1,'RESET',$2,$3,now()+make_interval(mins => $4))`,
      [user.id, tokenHash(raw), brand?.id || null, RESET_MINUTES]);
    const isPlatform = target.kind === "platform" || !brand;
    const link = brandWebUrl(isPlatform ? null : brand!.slug, `/reset-password?token=${encodeURIComponent(raw)}${isPlatform ? "&admin=1" : ""}`);
    await this.mailer.send(isPlatform ? null : brand!.id, user.email, "Reset your Northstar password",
      paragraphs(`Hi ${user.full_name},`, "We received a request to reset the password for your Northstar account.")
      + emailButton("Choose a new password", link)
      + paragraphs(`The link works once and expires in ${RESET_MINUTES} minutes. Resetting signs you out on every device.`, "If you didn't ask for this, you can ignore this email — your password stays the same."));
    await recordAuthEvent(this.database, { event: "password_reset_requested", success: true, userId: user.id, ip: info.ip, userAgent: info.userAgent });
  }

  async resetPassword(input: { token: string; password: string }, info: ClientInfo) {
    if ((await this.perMinute.hit(`reset-ip:${info.ip}`)).count > 20) throw tooMany();
    const user = await this.database.platformTransaction(async (client) => {
      const row = (await client.query(
        `SELECT t.id, u.id AS user_id, u.email, u.full_name FROM auth_one_time_tokens t JOIN users u ON u.id=t.user_id
          WHERE t.token_hash=$1 AND t.purpose='RESET' AND t.used_at IS NULL AND t.expires_at > now() FOR UPDATE OF t`, [tokenHash(String(input.token || ""))])).rows[0];
      if (!row) throw new BadRequestException({ message: "This reset link is invalid or has expired. Request a new one.", code: "TOKEN_INVALID" });
      const subject = { id: row.user_id, email: row.email, full_name: row.full_name };
      await this.setPassword(subject, input.password, client);
      await client.query(`UPDATE auth_one_time_tokens SET used_at=now() WHERE user_id=$1 AND purpose IN ('RESET','UNLOCK') AND used_at IS NULL`, [row.user_id]);
      return subject;
    });
    const revoked = await this.revokeSessions(user.id, "password_reset");
    await this.throttle.clear(`fail:${emailKey(user.email)}`);
    await auditAccount(this.database, { subjectUserId: user.id, actorUserId: user.id, action: "AUTH_PASSWORD_RESET", after: { sessionsRevoked: revoked } });
    await recordAuthEvent(this.database, { event: "password_reset", success: true, userId: user.id, ip: info.ip, userAgent: info.userAgent });
    const brand = await this.mailBrand(user.id, null);
    await this.mailer.send(brand?.id || null, user.email, "Your password was reset",
      paragraphs(`Hi ${user.full_name},`, "Your Northstar password was just reset and every device was signed out.", "If this wasn't you, contact your HR team immediately.")).catch(() => undefined);
    return { reset: true, sessionsRevoked: revoked };
  }

  async unlock(input: { token: string }, info: ClientInfo) {
    if ((await this.perMinute.hit(`unlock-ip:${info.ip}`)).count > 20) throw tooMany();
    const row = (await this.database.systemQuery(
      `UPDATE auth_one_time_tokens SET used_at=now() WHERE token_hash=$1 AND purpose='UNLOCK' AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
      [tokenHash(String(input.token || ""))])).rows[0];
    if (!row) throw new BadRequestException({ message: "This unlock link is invalid or has expired.", code: "TOKEN_INVALID" });
    const user = (await this.database.systemQuery(`UPDATE users SET failed_login_count=0, locked_until=NULL WHERE id=$1 RETURNING email`, [row.user_id])).rows[0];
    await this.throttle.clear(`fail:${emailKey(user.email)}`);
    await recordAuthEvent(this.database, { event: "account_unlocked", success: true, userId: row.user_id, ip: info.ip, userAgent: info.userAgent });
    await auditAccount(this.database, { subjectUserId: row.user_id, actorUserId: row.user_id, action: "AUTH_ACCOUNT_UNLOCKED" });
    return { unlocked: true };
  }

  // ---- invitations (public side) --------------------------------------------------------------------------------------

  private async loadInvite(client: Pick<PoolClient, "query">, raw: string, origin: string | undefined, lock = false) {
    const row = (await client.query(
      `SELECT i.id, i.kind, i.organization_id, i.user_id, i.employee_id, i.email, u.full_name, u.password_hash IS NOT NULL AS has_password,
              o.slug, coalesce(o.display_name,o.name) AS brand_name
         FROM auth_invites i JOIN users u ON u.id=i.user_id LEFT JOIN organizations o ON o.id=i.organization_id
        WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() ${lock ? "FOR UPDATE OF i" : ""}`,
      [tokenHash(String(raw || ""))])).rows[0];
    if (!row) throw new BadRequestException({ message: "This invitation link is invalid, was already used, or has expired. Ask HR to send a new one.", code: "INVITE_INVALID" });
    const hostBrand = brandFromHost(origin, this.config.appDomain);
    if (row.kind === "PLATFORM" ? !!hostBrand : (hostBrand && hostBrand !== row.slug))
      throw new BadRequestException({ message: "This invitation belongs to a different workspace. Open the link exactly as it appears in your email.", code: "INVITE_WRONG_WORKSPACE" });
    return row;
  }

  async inspectInvite(raw: string, info: ClientInfo) {
    if ((await this.perMinute.hit(`invite-ip:${info.ip}`)).count > 30) throw tooMany();
    const row = await this.loadInvite(this.sys, raw, info.origin);
    return { email: row.email, fullName: row.full_name, workspace: row.kind === "PLATFORM" ? { slug: "platform", name: "Northstar Platform" } : { slug: row.slug, name: row.brand_name },
      passwordRules: { minLength: 12 } };
  }

  async activate(input: { token: string; password: string; deviceName?: string }, info: ClientInfo): Promise<AuthResult> {
    if ((await this.perMinute.hit(`invite-ip:${info.ip}`)).count > 30) throw tooMany();
    const invite = await this.database.platformTransaction(async (client) => {
      const row = await this.loadInvite(client, input.token, info.origin, true);
      if (row.has_password) throw new BadRequestException({ message: "This account is already set up. Sign in instead.", code: "ALREADY_ACTIVE" });
      if (row.kind === "BRAND") {
        const member = (await client.query(
          `SELECT m.status, coalesce(e.status,'ACTIVE') AS employee_status FROM organization_memberships m
             LEFT JOIN employees e ON e.organization_id=m.organization_id AND e.user_id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2`,
          [row.organization_id, row.user_id])).rows[0];
        if (!member || member.status !== "ACTIVE" || member.employee_status !== "ACTIVE")
          throw new BadRequestException({ message: "Your access to this workspace isn't active. Contact your HR team.", code: "INVITE_INVALID" });
      }
      await this.setPassword({ id: row.user_id, email: row.email, full_name: row.full_name }, input.password, client);
      await client.query(`UPDATE auth_invites SET accepted_at=now() WHERE id=$1`, [row.id]);
      await client.query(`UPDATE auth_invites SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND accepted_at IS NULL AND revoked_at IS NULL`, [row.user_id, row.id]);
      if (row.kind === "PLATFORM") await client.query(`INSERT INTO platform_admins(user_id) VALUES($1) ON CONFLICT DO NOTHING`, [row.user_id]);
      await auditAccount(client, { subjectUserId: row.user_id, actorUserId: row.user_id, action: "AUTH_INVITE_ACCEPTED",
        organizationIds: row.organization_id ? [row.organization_id] : [], after: { inviteId: row.id, kind: row.kind } });
      return row;
    });
    await recordAuthEvent(this.database, { event: "invite_accepted", success: true, userId: invite.user_id, organizationId: invite.organization_id, ip: info.ip, userAgent: info.userAgent });
    const user = (await this.database.systemQuery(`SELECT id, email, full_name, password_hash, failed_login_count, locked_until FROM users WHERE id=$1`, [invite.user_id])).rows[0] as UserRow;
    const eligibility = await this.eligibility(user.id, invite.kind === "PLATFORM" ? { kind: "platform" } : { kind: "brand", org: { id: invite.organization_id, slug: invite.slug, name: invite.brand_name } });
    return this.secondFactor(user, eligibility, { ...info, deviceName: input.deviceName }, true);
  }
}

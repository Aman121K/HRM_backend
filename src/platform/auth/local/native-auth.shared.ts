import { createHash, createHmac, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { DatabaseService } from "../../database/database.service";

export const GENERIC_LOGIN_ERROR = "The email or password is incorrect.";
export const LOCKED_ERROR = "Too many failed attempts. Sign-in for this account is paused for a while. If it's your account, check your email for a link to unlock it now.";
export const CHALLENGE_EXPIRED = "This sign-in attempt has expired. Please start again.";
export const BAD_CODE = "That code didn't work. Check it and try again.";

export const newToken = () => randomBytes(32).toString("base64url");
export const tokenHash = (raw: string) => createHash("sha256").update(`northstar-token|${raw}`).digest("hex");
export const normalizeEmail = (email: string) => String(email || "").trim().toLowerCase().normalize("NFKC");

/** Keyed hash of an email for throttling keys and event rows (no raw emails in Redis or logs). */
export function emailKey(email: string) {
  const key = process.env.DATA_INDEX_KEY || process.env.AUTH_SIGNING_KEY || "northstar-dev-email-key";
  return createHmac("sha256", key).update(`auth-email|${normalizeEmail(email)}`).digest("base64url").slice(0, 32);
}
export const uaHash = (userAgent?: string) => (userAgent ? createHash("sha256").update(userAgent).digest("hex").slice(0, 16) : null);

/** "Chrome on macOS" — a coarse, human label for the session list (the raw user agent is not stored). */
export function deviceLabel(userAgent = "", deviceName?: string) {
  if (deviceName) return deviceName.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);
  const browser = /Edg\//.test(userAgent) ? "Edge" : /OPR\//.test(userAgent) ? "Opera" : /Chrome\//.test(userAgent) ? "Chrome"
    : /Firefox\//.test(userAgent) ? "Firefox" : /Safari\//.test(userAgent) ? "Safari" : /okhttp|CFNetwork|Dalvik|ReactNative/i.test(userAgent) ? "Mobile app"
    : /curl|node|python|axios|undici/i.test(userAgent) ? "API client" : "Browser";
  const os = /iPhone|iPad|iOS/.test(userAgent) ? "iOS" : /Android/.test(userAgent) ? "Android" : /Mac OS X|Macintosh/.test(userAgent) ? "macOS"
    : /Windows/.test(userAgent) ? "Windows" : /Linux/.test(userAgent) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!domain) return "your email";
  return `${local.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(6, local.length - 2)))}@${domain}`;
}

type Queryable = Pick<DatabaseService, "systemQuery"> | PoolClient;
const run = (db: Queryable, text: string, values: unknown[]) =>
  ("systemQuery" in db ? db.systemQuery(text, values) : (db as PoolClient).query(text, values));

/**
 * audit_log rows for an account-security change. audit_log is per brand, so the row is written in every brand the
 * person is an active member of (or only the given brands). Platform-only accounts have no brand: their trail is
 * auth_events (also written by the callers).
 */
export async function auditAccount(db: Queryable, input: {
  subjectUserId: string; actorUserId: string; action: string; organizationIds?: string[] | null; before?: unknown; after?: unknown;
}) {
  const orgs = input.organizationIds ?? (await run(db,
    `SELECT organization_id FROM organization_memberships WHERE user_id=$1 AND status='ACTIVE'`, [input.subjectUserId])).rows.map((row: any) => row.organization_id);
  for (const organizationId of new Set(orgs)) {
    await run(db, `INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,'user_account',$4,$5,$6)`,
      [organizationId, input.actorUserId, input.action, input.subjectUserId,
        input.before === undefined ? null : JSON.stringify(input.before), input.after === undefined ? null : JSON.stringify(input.after)]);
  }
}

export async function recordAuthEvent(db: Queryable, event: {
  event: string; success: boolean; userId?: string | null; organizationId?: string | null; email?: string | null; ip?: string; userAgent?: string; detail?: Record<string, unknown>;
}) {
  await run(db, `INSERT INTO auth_events(user_id,organization_id,event,success,email_hash,ip,user_agent_hash,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [event.userId || null, event.organizationId || null, event.event, event.success, event.email ? emailKey(event.email) : null,
      event.ip || null, uaHash(event.userAgent), event.detail ? JSON.stringify(event.detail) : null]);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

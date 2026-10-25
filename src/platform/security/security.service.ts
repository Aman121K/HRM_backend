import { ForbiddenException, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { AuthIdentity } from "../auth/auth.types";
import { RuntimeConfig } from "../config/runtime-config";
import { DatabaseService } from "../database/database.service";

type EventKey = { bucket: string; ip: string; status: number; reason: string; method: string; route: string; organizationId: string | null; userId: string | null; userAgentHash: string | null };
const REASONS: Record<number, string> = { 401: "unauthenticated", 403: "forbidden", 429: "rate_limited" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PostureCheck = { id: string; title: string; status: "pass" | "warn" | "fail" | "manual"; detail: string; fix?: string };

@Injectable()
export class SecurityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SecurityService.name);
  private readonly pending = new Map<string, EventKey & { count: number }>();
  private timer?: NodeJS.Timeout;
  constructor(private readonly database: DatabaseService, private readonly config: RuntimeConfig) {}

  onModuleInit() { this.timer = setInterval(() => void this.flush(), 5_000); this.timer.unref(); }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.flush(); }

  /** Called for every denied response; aggregated in memory per minute so an attack can't flood the database. */
  record(input: { ip: string; status: number; method: string; route: string; userAgent?: string; identity?: AuthIdentity }) {
    const reason = REASONS[input.status];
    if (!reason) return;
    const minute = new Date(); minute.setSeconds(0, 0);
    // Only the path is ever stored: query strings can carry device comm keys, signed-link tokens or signatures.
    const route = String(input.route || "").split(/[?#]/)[0].slice(0, 160);
    const key: EventKey = {
      bucket: minute.toISOString(), ip: input.ip || "unknown", status: input.status, reason, method: input.method, route,
      organizationId: input.identity?.organizationId && UUID.test(input.identity.organizationId) ? input.identity.organizationId : null,
      userId: input.identity?.userId && UUID.test(input.identity.userId) ? input.identity.userId : null,
      userAgentHash: input.userAgent ? createHash("sha256").update(input.userAgent).digest("hex").slice(0, 16) : null,
    };
    const id = JSON.stringify(key);
    const existing = this.pending.get(id);
    if (existing) existing.count += 1;
    else if (this.pending.size < 5_000) this.pending.set(id, { ...key, count: 1 });
  }

  private async flush() {
    if (!this.pending.size) return;
    const rows = [...this.pending.values()];
    this.pending.clear();
    for (const row of rows) {
      await this.database.systemQuery(
        `INSERT INTO security_events(bucket,organization_id,user_id,client_ip,status,reason,method,route,user_agent_hash,count)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (bucket,client_ip,status,reason,method,route,organization_id,user_id)
         DO UPDATE SET count = security_events.count + excluded.count, last_seen = now()`,
        [row.bucket, row.organizationId, row.userId, row.ip, row.status, row.reason, row.method, row.route, row.userAgentHash, row.count],
      ).catch((error) => this.logger.warn(`Security event not stored: ${(error as Error).message}`));
    }
  }

  private async requirePlatform(identity: AuthIdentity) {
    const ok = identity.userId && (await this.database.systemQuery(`SELECT 1 FROM platform_admins WHERE user_id=$1`, [identity.userId])).rowCount;
    if (!ok) throw new ForbiddenException("Only platform administrators can view platform security.");
  }

  /** Platform view: denied traffic, top sources and the routes being probed. */
  async events(identity: AuthIdentity, hours: number, organizationId?: string) {
    const scopeOrg = organizationId ?? null;
    if (scopeOrg === null) await this.requirePlatform(identity);
    const window = Math.min(Math.max(hours || 24, 1), 24 * 30);
    const args = [window, scopeOrg];
    const where = `last_seen > now() - make_interval(hours => $1) AND ($2::uuid IS NULL OR organization_id = $2::uuid)`;
    const [summary, sources, routes, timeline, recent] = await Promise.all([
      this.database.systemQuery(`SELECT reason, sum(count)::int AS count FROM security_events WHERE ${where} GROUP BY reason ORDER BY 2 DESC`, args),
      this.database.systemQuery(`SELECT client_ip AS ip, sum(count)::int AS count, array_agg(DISTINCT reason) AS reasons, max(last_seen) AS "lastSeen",
          count(DISTINCT route)::int AS routes FROM security_events WHERE ${where} GROUP BY client_ip ORDER BY 2 DESC LIMIT 10`, args),
      this.database.systemQuery(`SELECT method, route, reason, sum(count)::int AS count FROM security_events WHERE ${where} GROUP BY method, route, reason ORDER BY 4 DESC LIMIT 15`, args),
      this.database.systemQuery(`SELECT date_trunc('hour', bucket) AS hour, reason, sum(count)::int AS count FROM security_events WHERE ${where} GROUP BY 1, 2 ORDER BY 1`, args),
      this.database.systemQuery(`SELECT e.last_seen AS "lastSeen", e.client_ip AS ip, e.status, e.reason, e.method, e.route, e.count,
          coalesce(o.display_name, o.name) AS organization, u.email FROM security_events e
          LEFT JOIN organizations o ON o.id = e.organization_id LEFT JOIN users u ON u.id = e.user_id
         WHERE ${where.replace(/last_seen/g, "e.last_seen").replace(/organization_id/g, "e.organization_id")} ORDER BY e.last_seen DESC LIMIT 50`, args),
    ]);
    return { hours: window, summary: summary.rows, sources: sources.rows, routes: routes.rows, timeline: timeline.rows, recent: recent.rows };
  }

  /** Production-readiness checks computed from the live configuration and database. */
  async posture(identity: AuthIdentity): Promise<{ checks: PostureCheck[]; score: number; environment: string }> {
    await this.requirePlatform(identity);
    const checks = await this.baselineChecks();
    const scored = checks.filter((check) => check.status !== "manual");
    const score = Math.round((scored.filter((check) => check.status === "pass").length / Math.max(scored.length, 1)) * 100);
    return { checks, score, environment: this.config.nodeEnv };
  }

  /** The configuration baseline, without access checks — also collected daily as compliance evidence. */
  async baselineChecks(): Promise<PostureCheck[]> {
    const env = process.env;
    const checks: PostureCheck[] = [];
    const add = (check: PostureCheck) => checks.push(check);
    const prod = this.config.nodeEnv === "production";

    add(this.config.allowDemoIdentity
      ? { id: "demo-identity", title: "Demo sign-in disabled", status: prod ? "fail" : "warn", detail: "Demo identities (header sign-in) are ON. Production refuses to start with them.", fix: "Set ALLOW_DEMO_IDENTITY=false and NEXT_PUBLIC_ALLOW_DEMO_IDENTITY=false." }
      : { id: "demo-identity", title: "Demo sign-in disabled", status: "pass", detail: "Only verified SSO tokens are accepted." });

    const role = (await this.database.query(`SELECT current_user AS name, r.rolsuper OR r.rolbypassrls AS bypass,
        (SELECT count(*)::int FROM pg_class c WHERE c.relowner=r.oid AND c.relkind='r' AND c.relnamespace='public'::regnamespace) AS owned
       FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
    add(!role.bypass && role.owned === 0
      ? { id: "db-role", title: "Tenant queries use a least-privilege role", status: "pass", detail: `Role ${role.name} owns no tables and cannot bypass row-level security — Postgres isolates brands.` }
      : { id: "db-role", title: "Tenant queries use a least-privilege role", status: "fail", detail: `Role ${role.name} can bypass RLS.`, fix: "Create hrm_runtime with db/runtime-role.sql and set DATABASE_URL_RUNTIME." });

    const unprotected = (await this.database.systemQuery(`SELECT c.relname FROM pg_class c JOIN information_schema.columns col
        ON col.table_name=c.relname AND col.column_name='organization_id' AND col.table_schema='public'
       WHERE c.relkind='r' AND c.relnamespace='public'::regnamespace AND c.relname NOT IN ('security_events','access_review_items') -- platform-only tables; the runtime role has no grants on them
         AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename=c.relname))`)).rows.map((row) => row.relname);
    add(unprotected.length
      ? { id: "rls", title: "Row-level security on every brand table", status: "fail", detail: `Missing on: ${unprotected.join(", ")}`, fix: "Enable RLS and add the tenant_isolation policy in a migration." }
      : { id: "rls", title: "Row-level security on every brand table", status: "pass", detail: "Every table with organization_id has RLS and a tenant policy." });

    const trigger = (await this.database.systemQuery(`SELECT 1 FROM pg_trigger WHERE tgname='audit_log_no_update'`)).rowCount;
    add({ id: "audit", title: "Audit trail is append-only", status: trigger ? "pass" : "fail", detail: trigger ? "UPDATE/DELETE/TRUNCATE on audit_log are blocked for every role." : "audit_log can be edited.", fix: trigger ? undefined : "Apply migration 021_audit_integrity.sql." });

    const oidc = this.config.oidcIssuer;
    add(!oidc ? { id: "sso", title: "Company single sign-on", status: prod ? "fail" : "warn", detail: "No identity provider configured.", fix: "Set OIDC_ISSUER, OIDC_AUDIENCE, OIDC_JWKS_URL, OIDC_CLIENT_ID for your IdP (Entra ID, Okta, Google Workspace)." }
      : /localhost:4200/.test(oidc) ? { id: "sso", title: "Company single sign-on", status: prod ? "fail" : "warn", detail: "Using the development identity provider (localhost:4200).", fix: "Point OIDC_* at your real IdP with MFA enforced." }
      : { id: "sso", title: "Company single sign-on", status: "pass", detail: `Tokens verified against ${oidc}. Enforce MFA in the IdP.` });

    const master = env.INTEGRATIONS_MASTER_KEY || "";
    add({ id: "master-key", title: "Integration secrets key", status: master.length >= 32 ? "pass" : prod ? "fail" : "warn", detail: master.length >= 32 ? "Device and webhook secrets derive from a private key." : "INTEGRATIONS_MASTER_KEY is missing or short — a per-install development key (.data/secrets) is in use; production refuses to start.", fix: master.length >= 32 ? undefined : "Generate 32+ random characters (e.g. openssl rand -hex 32) and store it in your secrets manager." });
    add({ id: "payout-secret", title: "Bank payout webhook secret", status: (env.PAYOUTS_WEBHOOK_SECRET || "").length >= 24 ? "pass" : prod ? "fail" : "warn",
      detail: !env.PAYOUTS_WEBHOOK_SECRET ? "Using a per-install development secret (.data/secrets). Production answers 503 to payout callbacks until a secret is set."
        : env.PAYOUTS_WEBHOOK_SECRET.length < 24 ? "PAYOUTS_WEBHOOK_SECRET is shorter than 24 characters — production refuses to start." : "Inbound payout callbacks are verified (HMAC, ±5 min timestamp, replay-protected).",
      fix: (env.PAYOUTS_WEBHOOK_SECRET || "").length >= 24 ? undefined : "Set PAYOUTS_WEBHOOK_SECRET (24+ characters) to the value configured with your bank/payout provider." });
    add({ id: "redis", title: "Shared rate limits and background jobs", status: this.config.redisUrl ? "pass" : prod ? "fail" : "warn", detail: this.config.redisUrl ? "Redis backs rate limits across API instances and the job queue." : "No Redis — limits are per process.", fix: this.config.redisUrl ? undefined : "Set REDIS_URL (managed Redis with TLS and auth)." });
    add({ id: "smtp", title: "Outgoing email", status: env.SMTP_HOST ? "pass" : "warn", detail: env.SMTP_HOST ? `Email via ${env.SMTP_HOST}.` : "Emails are written to .data/mail instead of being sent.", fix: env.SMTP_HOST ? undefined : "Configure SMTP_HOST/SMTP_USER/SMTP_PASS (SPF/DKIM on your domain)." });
    const base = env.APP_BASE_URL || "";
    add({ id: "https", title: "HTTPS everywhere", status: base.startsWith("https://") ? "pass" : prod ? "fail" : "warn", detail: base ? `App URL ${base}` : "APP_BASE_URL is not set (local HTTP).", fix: base.startsWith("https://") ? undefined : "Serve web and API only over HTTPS behind a TLS-terminating load balancer; HSTS is sent automatically in production." });
    const cors = this.config.corsOrigins;
    add({ id: "cors", title: "API accepts only your web origins", status: cors.some((value) => value === "*") ? "fail" : cors.every((value) => value.startsWith("https://")) ? "pass" : "warn", detail: `Allowed origins: ${cors.join(", ")}` });
    add({ id: "runtime-secret", title: "Database credentials separated", status: this.config.runtimeDatabaseUrl && this.config.runtimeDatabaseUrl !== this.config.databaseUrl ? "pass" : prod ? "fail" : "warn", detail: "The API uses a runtime role for tenant data and the owner role only for system paths; migrations should run from CI with the owner credentials." });
    const storage = (env.FILES_STORAGE || "local").toLowerCase();
    add(storage === "s3" && env.FILES_S3_BUCKET
      ? { id: "file-storage", title: "Employee files in encrypted object storage", status: "pass", detail: `S3 bucket ${env.FILES_S3_BUCKET}${env.FILES_S3_PREFIX ? `/${env.FILES_S3_PREFIX}` : ""}, one folder per company (tenants/<organization>/…), ${env.FILES_S3_KMS_KEY_ID ? "SSE-KMS" : env.FILES_S3_ENDPOINT ? "store-managed encryption" : "SSE-S3"}, SHA-256 verified on every download.` }
      : { id: "file-storage", title: "Employee files in encrypted object storage", status: prod ? "fail" : "warn", detail: "Files are on this server's local disk (development). They aren't shared between servers and are lost if the server is replaced.", fix: "Set FILES_STORAGE=s3 and FILES_S3_BUCKET (Mumbai region), run scripts/s3-bucket-setup.mjs, then scripts/migrate-files-to-s3.mjs." });
    add({ id: "backups", title: "Encrypted backups with point-in-time recovery", status: "manual", detail: "Can't be checked from the app.", fix: "Enable PITR on your Postgres (e.g. RDS/Cloud SQL), encrypt at rest, and rehearse a restore quarterly." });
    add({ id: "pentest", title: "Independent penetration test", status: "manual", detail: "Recommended before go-live and after major changes.", fix: "Engage a CERT-In empanelled auditor; track findings to closure." });
    return checks;
  }
}

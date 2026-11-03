import { Injectable, Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { headerSafe } from "./email-layout";
import { currentJob, throwIfAborted } from "./job-context";
import { localClock, type LocalClock } from "./scheduling";

/** The automation actor (see migration 015). No membership, no password: it can never sign in. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SYSTEM_USER_EMAIL = "system@northstar.invalid";

export type Organization = { id: string; slug: string; name: string; timezone: string };
export type Counters = Record<string, number | string | boolean>;

export type TenantJobContext = {
  organization: Organization;
  client: PoolClient;
  /** System identity: organizationId + automation user, no employee, role SYSTEM (passes no @Roles check). */
  identity: AuthIdentity;
  now: Date;
  clock: LocalClock;
  /** True for "Run now" from the console: reminder jobs skip their working-hours window. */
  manual: boolean;
  /** Records a dedupe key; returns false when it was already recorded (the caller must then NOT send). */
  claim(key: string, meta?: { recipient?: string | null; entityId?: string | null }): Promise<boolean>;
  notify(employeeId: string, eventType: string, entityType: string, entityId: string, payload: Record<string, unknown>): Promise<void>;
  /** Queues an email through the transactional outbox (sent by outbox.dispatch). `html` must escape every interpolated value with escapeHtml(); the subject is made single-line here. */
  email(recipient: string | null | undefined, subject: string, html: string): Promise<void>;
  audit(action: string, entityType: string, entityId: string, after: unknown, before?: unknown): Promise<void>;
};

type RunOptions = { organizationId?: string; manual?: boolean };

/**
 * Runs a recurring job once per active organization, each inside its own tenant transaction with the system
 * identity. A tenant's notifications, ledger rows and emails commit together, so a failed tenant retries cleanly.
 * Per-tenant errors are stored in job_runs (tenant-scoped); the error thrown back to BullMQ only carries counts,
 * so the shared failed-jobs list never leaks one tenant's data to another.
 */
@Injectable()
export class TenantJobRunner {
  private readonly logger = new Logger("Jobs");
  private systemUser?: string;

  constructor(private readonly database: DatabaseService) {}

  async systemUserId() {
    if (this.systemUser) return this.systemUser;
    const found = (await this.database.systemQuery(`SELECT id FROM users WHERE email=$1`, [SYSTEM_USER_EMAIL])).rows[0];
    const row = found || (await this.database.systemQuery(
      `INSERT INTO users(email,full_name,oidc_issuer,oidc_subject) VALUES($1,'ClanChief Automation','urn:northstar:system','automation')
       ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id`, [SYSTEM_USER_EMAIL])).rows[0];
    this.systemUser = row.id as string;
    return this.systemUser;
  }

  async organizations(organizationId?: string): Promise<Organization[]> {
    const values: unknown[] = [];
    let where = `status='ACTIVE'`;
    if (organizationId !== undefined) {
      if (!UUID.test(organizationId)) throw new Error("Invalid organizationId in job payload.");
      values.push(organizationId); where += ` AND id=$1`;
    }
    return (await this.database.systemQuery(`SELECT id, slug, name, timezone FROM organizations WHERE ${where} ORDER BY created_at, id`, values)).rows as Organization[];
  }

  async systemIdentity(organizationId: string): Promise<AuthIdentity> {
    return { organizationId, userId: await this.systemUserId(), employeeId: "", roles: ["SYSTEM"] };
  }

  /** Runs `work` for one tenant (payload.organizationId) or every active tenant. Returns a tenant-neutral summary. */
  async forEachTenant(jobName: string, payload: Record<string, unknown>, work: (ctx: TenantJobContext) => Promise<Counters>) {
    // payload is the job's own stored data (written by the API/scheduler), never caller input. A payload that names an
    // organization but not as a UUID is refused rather than silently widened to "every tenant".
    if (payload.organizationId !== undefined && !(typeof payload.organizationId === "string" && UUID.test(payload.organizationId)))
      throw new Error(`${jobName}: invalid organizationId in job payload.`);
    const options: RunOptions = {
      organizationId: typeof payload.organizationId === "string" ? payload.organizationId : undefined,
      manual: payload.trigger === "manual",
    };
    const organizations = await this.organizations(options.organizationId);
    const job = currentJob();
    const trigger = options.manual ? "MANUAL" : payload.scheduled ? "SCHEDULE" : "QUEUED";
    let failed = 0;
    const totals: Record<string, number> = {};
    for (const organization of organizations) {
      throwIfAborted();
      const startedAt = new Date();
      try {
        const result = await this.runTenant(organization, options, work);
        for (const [key, value] of Object.entries(result)) if (typeof value === "number") totals[key] = (totals[key] || 0) + value;
        await this.record(organization.id, jobName, job?.id, trigger, result.skipped === true ? "SKIPPED" : "SUCCEEDED", startedAt, result, null);
        this.logger.log(JSON.stringify({ event: "tenant_done", job: jobName, jobId: job?.id, org: organization.slug, ms: Date.now() - startedAt.getTime(), result }));
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        await this.record(organization.id, jobName, job?.id, trigger, "FAILED", startedAt, {}, message).catch(() => undefined);
        this.logger.error(JSON.stringify({ event: "tenant_failed", job: jobName, jobId: job?.id, org: organization.slug, error: message }));
      }
    }
    if (failed) throw new Error(`${jobName}: ${failed} of ${organizations.length} organization(s) failed — see each organization's job history.`);
    return { organizations: organizations.length, ...totals };
  }

  private async runTenant(organization: Organization, options: RunOptions, work: (ctx: TenantJobContext) => Promise<Counters>) {
    const identity = await this.systemIdentity(organization.id);
    const now = new Date();
    return this.database.tenantTransaction(identity, async (client) => {
      const orgId = organization.id;
      const ctx: TenantJobContext = {
        organization, client, identity, now, clock: localClock(now, organization.timezone), manual: !!options.manual,
        claim: async (key, meta) => {
          const jobName = key.split(":")[0];
          const inserted = await client.query(
            `INSERT INTO job_dispatch_log(organization_id,dedupe_key,job_name,recipient_employee_id,entity_id) VALUES($1,$2,$3,$4,$5)
             ON CONFLICT (organization_id,dedupe_key) DO NOTHING`, [orgId, key, jobName, meta?.recipient || null, meta?.entityId || null]);
          return inserted.rowCount === 1;
        },
        notify: async (employeeId, eventType, entityType, entityId, payload) => {
          await client.query(`INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload) VALUES($1,$2,$3,$4,$5,$6)`,
            [orgId, employeeId, eventType, entityType, entityId, JSON.stringify({ ...payload, automated: true })]);
        },
        email: async (recipient, subject, html) => {
          if (!recipient) return;
          await client.query(`INSERT INTO email_outbox(organization_id,recipient,subject,html) VALUES($1,$2,$3,$4)`, [orgId, recipient, headerSafe(subject), html]);
        },
        audit: async (action, entityType, entityId, after, before) => {
          await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [orgId, identity.userId, action, entityType, entityId, before === undefined ? null : JSON.stringify(before), JSON.stringify(after ?? null)]);
        },
      };
      return work(ctx);
    });
  }

  private async record(organizationId: string, jobName: string, bullJobId: string | undefined, trigger: string, status: string, startedAt: Date, result: Counters, error: string | null) {
    const identity = await this.systemIdentity(organizationId);
    await this.database.tenantTransaction(identity, (client) => client.query(
      `INSERT INTO job_runs(organization_id,job_name,bull_job_id,trigger,status,started_at,duration_ms,result,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [organizationId, jobName, bullJobId || null, trigger, status, startedAt, Date.now() - startedAt.getTime(), JSON.stringify(result), error ? error.slice(0, 2000) : null]));
  }
}

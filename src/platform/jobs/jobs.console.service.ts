import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { Job } from "bullmq";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { JobRegistry } from "./job-registry";
import type { JobRunsQuery, OutboxQuery } from "./jobs.dto";
import { JobsService } from "./jobs.service";
import { MAIL_MAX_ATTEMPTS, OutboxDispatcher } from "./outbox.dispatcher";
import { describeSchedule, isOwnTenantJob, isTenantNeutralJob } from "./scheduling";

const JOB_ID = /^[A-Za-z0-9:_.-]{1,120}$/;
const REDIS_TIMEOUT_MS = 3000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Redis did not answer (${label})`)), REDIS_TIMEOUT_MS).unref())]);
}

/**
 * Read/act on the job system for HR admins. The BullMQ queue is shared by all tenants, so everything returned here is
 * filtered: a job is shown in full only when its payload names the caller's organization; recurring jobs with a
 * tenant-neutral payload are shown without data (their per-tenant outcome comes from the tenant-scoped job_runs table);
 * anything else is omitted.
 */
@Injectable()
export class JobsConsoleService {
  private readonly logger = new Logger("JobsConsole");
  constructor(
    private readonly jobs: JobsService,
    private readonly registry: JobRegistry,
    private readonly database: DatabaseService,
    private readonly outbox: OutboxDispatcher,
  ) {}

  async overview(identity: AuthIdentity) {
    const queue = this.jobs.bullQueue;
    let redis: { status: "connected" | "unavailable" | "not_configured"; error?: string } = { status: queue ? "connected" : "not_configured" };
    let counts: Record<string, number> = {};
    let workers: { name: string; ageSeconds: number; idleSeconds: number }[] = [];
    const next = new Map<string, number | null>();
    if (queue) {
      try {
        const [jobCounts, clients, schedulers] = await Promise.all([
          withTimeout(queue.getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused", "prioritized"), "counts"),
          withTimeout(queue.getWorkers(), "workers"),
          withTimeout(queue.getJobSchedulers(0, 199, true), "schedulers"),
        ]);
        counts = jobCounts;
        workers = clients.map((client) => ({ name: (client.rawname || client.name || "worker").replace(/^bull:[^:]+:/, "").replace(/^w:/, ""), ageSeconds: Number(client.age) || 0, idleSeconds: Number(client.idle) || 0 }));
        for (const scheduler of schedulers) next.set(scheduler.key, scheduler.next ?? null);
      } catch (error) {
        redis = { status: "unavailable", error: error instanceof Error ? error.message : String(error) };
      }
    }
    const lastRuns = await this.database.tenantTransaction(identity, async (client) => (await client.query(
      `SELECT DISTINCT ON (job_name) job_name, status, trigger, started_at, finished_at, duration_ms, result, error
         FROM job_runs WHERE organization_id=$1 ORDER BY job_name, started_at DESC`, [identity.organizationId])).rows);
    const lastByName = new Map(lastRuns.map((row) => [row.job_name as string, row]));
    const mail = await this.outboxCounts(identity);
    const schedules = this.registry.schedules().sort((a, b) => a.name.localeCompare(b.name)).map((schedule) => {
      const last = lastByName.get(schedule.name);
      return {
        name: schedule.name,
        description: schedule.description || this.registry.describe(schedule.name).description || null,
        schedule: describeSchedule(schedule), every: schedule.every || null, cron: schedule.cron || null, tz: schedule.tz || null,
        nextRunAt: next.has(schedule.name) && next.get(schedule.name) ? new Date(next.get(schedule.name)!).toISOString() : null,
        scheduled: next.has(schedule.name),
        canRunNow: !!schedule.tenantScoped,
        lastRun: last ? { status: last.status, trigger: last.trigger, startedAt: last.started_at, finishedAt: last.finished_at, durationMs: last.duration_ms, result: last.result, error: last.error } : null,
      };
    });
    return {
      redis, queue: counts, workers, schedules, mail: { ...mail, mode: this.outbox.mode, maxAttempts: MAIL_MAX_ATTEMPTS() },
      handlers: this.registry.names(), checkedAt: new Date().toISOString(),
    };
  }

  async failed(identity: AuthIdentity, limit = 50) {
    const queue = this.requireQueue();
    const jobs = await withTimeout(queue.getFailed(0, 499), "failed jobs");
    const items = jobs.filter((job) => job && (isOwnTenantJob(job.data, identity.organizationId) || isTenantNeutralJob(job.data)))
      .sort((a, b) => (b.finishedOn || b.timestamp) - (a.finishedOn || a.timestamp)).slice(0, limit).map((job) => this.present(job, identity));
    return { items };
  }

  /**
   * Retry a failed job. A brand may retry only a job whose stored payload names its own organization. A failed
   * tenant-neutral run of a tenant-scoped schedule (one run that covered every brand) is never re-run globally from a
   * brand console: it becomes a fresh run for the caller's organization only. Platform-wide jobs: platform admins only.
   */
  async retry(identity: AuthIdentity, id: string) {
    const job = await this.visibleJob(identity, id);
    const state = await job.getState();
    if (state !== "failed") throw new ConflictException(`This job is ${state}, only failed jobs can be retried.`);
    if (!isOwnTenantJob(job.data, identity.organizationId)) {
      const schedule = this.registry.schedules().find((item) => item.name === job.name && item.tenantScoped);
      if (!schedule) throw new ForbiddenException("This is a platform job that runs for every organization — only a platform administrator can retry it.");
      const result = await this.runNow(identity, job.name);
      await this.audit(identity, "JOB_RETRIED", { jobId: job.id, name: job.name, scope: "organization", newJobId: result.jobId ?? null });
      return { id: job.id, name: job.name, retried: true, scope: "organization", newJobId: result.jobId ?? null };
    }
    await job.retry("failed");
    await this.audit(identity, "JOB_RETRIED", { jobId: job.id, name: job.name });
    return { id: job.id, name: job.name, retried: true, scope: "organization" };
  }

  // ---- platform administrators (no brand): every job, globally --------------------------------------------------

  async platformFailed(limit = 100) {
    const queue = this.requireQueue();
    const jobs = await withTimeout(queue.getFailed(0, 999), "failed jobs");
    return { items: jobs.filter(Boolean).sort((a, b) => (b.finishedOn || b.timestamp) - (a.finishedOn || a.timestamp)).slice(0, limit).map((job) => ({
      id: job.id, name: job.name, organizationId: typeof job.data?.organizationId === "string" ? job.data.organizationId : null,
      error: job.failedReason || "Unknown error", attemptsMade: job.attemptsMade, attempts: job.opts.attempts || 1,
      createdAt: new Date(job.timestamp).toISOString(), failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    })) };
  }

  async platformRetry(identity: AuthIdentity, id: string) {
    if (!identity.roles.includes("PLATFORM_ADMIN") || identity.organizationId) throw new ForbiddenException("Platform administrators only.");
    if (!JOB_ID.test(id)) throw new NotFoundException("Job not found.");
    const job = await withTimeout(this.requireQueue().getJob(id), "job");
    if (!job) throw new NotFoundException("Job not found.");
    const state = await job.getState();
    if (state !== "failed") throw new ConflictException(`This job is ${state}, only failed jobs can be retried.`);
    await job.retry("failed");
    const org = typeof job.data?.organizationId === "string" && UUID.test(job.data.organizationId) ? job.data.organizationId : null;
    if (org) await this.database.systemQuery(
      `INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'JOB_RETRIED','organization',$1,$3)`,
      [org, identity.userId, JSON.stringify({ jobId: job.id, name: job.name, by: "platform_admin" })]).catch(() => undefined);
    this.logger.log(JSON.stringify({ event: "platform_job_retried", jobId: job.id, name: job.name, org, by: identity.userId }));
    return { id: job.id, name: job.name, retried: true, scope: org ? "organization" : "platform" };
  }

  async runNow(identity: AuthIdentity, name: string) {
    const schedule = this.registry.schedules().find((item) => item.name === name);
    if (!schedule) throw new NotFoundException("No recurring job with this name.");
    if (!schedule.tenantScoped) throw new ConflictException("This job runs for the whole platform and cannot be started for one organization.");
    this.requireQueue();
    const result = await this.jobs.enqueue(name, { organizationId: identity.organizationId, trigger: "manual", requestedBy: identity.userId },
      { attempts: 2, deduplication: { id: `manual:${name}:${identity.organizationId}`, ttl: 15_000 } });
    await this.audit(identity, "JOB_RUN_REQUESTED", { name, jobId: result.jobId });
    const workers = await withTimeout(this.jobs.bullQueue!.getWorkersCount(), "workers").catch(() => 0);
    return { ...result, name, workersOnline: workers };
  }

  async runs(identity: AuthIdentity, query: JobRunsQuery) {
    return this.database.tenantTransaction(identity, async (client) => {
      const values: unknown[] = [identity.organizationId, query.limit || 50];
      let filter = "";
      if (query.name) { values.push(query.name); filter = ` AND job_name=$3`; }
      const rows = (await client.query(
        `SELECT id, job_name AS "name", trigger, status, started_at AS "startedAt", finished_at AS "finishedAt", duration_ms AS "durationMs", result, error
           FROM job_runs WHERE organization_id=$1${filter} ORDER BY started_at DESC LIMIT $2`, values)).rows;
      return { items: rows.map((row) => ({ ...row, id: String(row.id) })) };
    });
  }

  async outboxList(identity: AuthIdentity, query: OutboxQuery) {
    return this.database.tenantTransaction(identity, async (client) => {
      const values: unknown[] = [identity.organizationId, query.limit || 50];
      let filter = "";
      if (query.status) { values.push(query.status); filter = ` AND status=$3`; }
      const rows = (await client.query(
        `SELECT id, recipient, subject, status, attempts, available_at AS "availableAt", sent_at AS "sentAt", last_error AS "lastError", created_at AS "createdAt"
           FROM email_outbox WHERE organization_id=$1${filter} ORDER BY created_at DESC, id DESC LIMIT $2`, values)).rows;
      const max = MAIL_MAX_ATTEMPTS();
      return {
        items: rows.map((row) => ({ ...row, id: String(row.id), gaveUp: row.status === "FAILED" && row.attempts >= max })),
        counts: await this.outboxCounts(identity, client), maxAttempts: max, mode: this.outbox.mode,
      };
    });
  }

  /** Puts a failed email back in the queue (fresh attempts). Only FAILED rows of the caller's organization. */
  async requeueEmail(identity: AuthIdentity, id: string) {
    if (!/^\d{1,18}$/.test(id)) throw new NotFoundException("Email not found.");
    return this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(
        `UPDATE email_outbox SET status='PENDING', attempts=0, available_at=now(), last_error=NULL
          WHERE organization_id=$1 AND id=$2 AND status='FAILED' RETURNING id, recipient, subject`, [identity.organizationId, id])).rows[0];
      if (!row) throw new NotFoundException("No failed email with this id.");
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'EMAIL_REQUEUED','organization',$1,$3)`,
        [identity.organizationId, identity.userId, JSON.stringify({ outboxId: String(row.id), subject: row.subject })]);
      if (this.jobs.bullQueue) await this.jobs.enqueue("outbox.dispatch", { organizationId: identity.organizationId, trigger: "manual" }).catch(() => undefined);
      return { id: String(row.id), status: "PENDING" };
    });
  }

  // ---- helpers -----------------------------------------------------------------------------------

  private async outboxCounts(identity: AuthIdentity, existing?: import("pg").PoolClient) {
    const run = async (client: import("pg").PoolClient) => {
      const rows = (await client.query(
        `SELECT status, count(*)::int AS count, (count(*) FILTER (WHERE status='FAILED' AND attempts >= $2))::int AS gave_up
           FROM email_outbox WHERE organization_id=$1 GROUP BY status`, [identity.organizationId, MAIL_MAX_ATTEMPTS()])).rows;
      const counts: Record<string, number> = { PENDING: 0, PROCESSING: 0, SENT: 0, FAILED: 0, gaveUp: 0 };
      for (const row of rows) { counts[row.status] = row.count; counts.gaveUp += row.gave_up; }
      return counts;
    };
    return existing ? run(existing) : this.database.tenantTransaction(identity, run);
  }

  private requireQueue() {
    const queue = this.jobs.bullQueue;
    if (!queue) throw new ServiceUnavailableException("Background jobs are not configured (REDIS_URL is empty).");
    return queue;
  }

  private async visibleJob(identity: AuthIdentity, id: string) {
    if (!JOB_ID.test(id)) throw new NotFoundException("Job not found.");
    const job = await withTimeout(this.requireQueue().getJob(id), "job");
    if (!job || !(isOwnTenantJob(job.data, identity.organizationId) || isTenantNeutralJob(job.data))) throw new NotFoundException("Job not found.");
    return job;
  }

  private present(job: Job, identity: AuthIdentity) {
    const own = isOwnTenantJob(job.data, identity.organizationId);
    let data: string | null = null;
    if (own) {
      const text = JSON.stringify(job.data);
      data = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
    }
    // Tenant-scoped automations (TenantJobRunner) only ever fail with tenant-neutral messages; other platform jobs
    // might mention another organization's data in their error, so it is withheld.
    const neutralError = own || !!this.registry.schedules().find((item) => item.name === job.name && item.tenantScoped);
    return {
      id: job.id, name: job.name, scope: own ? "organization" : "platform",
      error: neutralError ? job.failedReason || "Unknown error" : "Platform job failed — details are only available in the worker logs.", attemptsMade: job.attemptsMade, attempts: job.opts.attempts || 1,
      createdAt: new Date(job.timestamp).toISOString(), failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
      data, description: this.registry.describe(job.name).description || null, known: !!this.registry.handler(job.name),
      // Own jobs retry in place; a tenant-neutral run of a tenant-scoped schedule retries as a run for this org only.
      canRetry: own || neutralError,
    };
  }

  private async audit(identity: AuthIdentity, action: string, after: Record<string, unknown>) {
    await this.database.tenantTransaction(identity, (client) => client.query(
      `INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,$3,'organization',$1,$4)`,
      [identity.organizationId, identity.userId, action, JSON.stringify(after)]));
  }
}

import { Injectable, Logger } from "@nestjs/common";

export type JobHandler = (payload: Record<string, unknown>) => Promise<unknown>;
/**
 * A recurring schedule. Use `every` (ms) or `cron` (5-field, evaluated in `tz`, default Asia/Kolkata).
 * Optional extras: `description` (shown in the jobs console), `timeoutMs` (per-run limit in the worker),
 * `tenantScoped` (true when the handler honours `payload.organizationId`, so HR can "Run now" for their own org).
 */
export type RecurringJob = {
  name: string; every?: number; cron?: string; payload?: Record<string, unknown>;
  tz?: string; description?: string; timeoutMs?: number; tenantScoped?: boolean;
};
export type JobOptions = { description?: string; timeoutMs?: number };

/**
 * Feature modules register named job handlers (and optional recurring schedules) here during onModuleInit.
 * The worker process (npm run jobs:dev) dispatches queued jobs to these handlers; the API process only enqueues.
 */
@Injectable()
export class JobRegistry {
  private readonly logger = new Logger(JobRegistry.name);
  private readonly handlers = new Map<string, JobHandler>();
  private readonly recurring = new Map<string, RecurringJob>();
  private readonly options = new Map<string, JobOptions>();

  register(name: string, handler: JobHandler, schedule?: Omit<RecurringJob, "name">, options?: JobOptions) {
    if (this.handlers.has(name)) this.logger.warn(`Job handler ${name} registered twice; keeping the latest.`);
    this.handlers.set(name, handler);
    if (schedule) this.recurring.set(name, { name, ...schedule });
    else this.recurring.delete(name);
    const merged = { description: options?.description ?? schedule?.description, timeoutMs: options?.timeoutMs ?? schedule?.timeoutMs };
    this.options.set(name, merged);
  }
  handler(name: string) { return this.handlers.get(name); }
  names() { return [...this.handlers.keys()].sort(); }
  schedules() { return [...this.recurring.values()]; }
  /** Console/worker metadata for one job (description, timeout); empty object when none was given. */
  describe(name: string): JobOptions { return this.options.get(name) || {}; }
}

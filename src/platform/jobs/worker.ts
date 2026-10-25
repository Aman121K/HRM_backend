// Northstar background worker: `npm run jobs:dev` (build + watch) or `npm run jobs:start`.
// Boots the Nest application context (no HTTP server), so every feature module's onModuleInit has registered its
// handlers in JobRegistry, then consumes BullMQ queue "northstar-platform" and keeps the recurring schedules in sync.
import "dotenv/config";
import "reflect-metadata";
import { Module, type LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { UnrecoverableError, Worker, type Job, type Queue } from "bullmq";
import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import type { Redis } from "ioredis";
import { buildInfo, probeError, withTimeout } from "../health/lifecycle";
import { reportError } from "../ops/error-reporter";
import { WORKER_HEARTBEAT_EVERY_MS, WORKER_HEARTBEAT_PREFIX, WORKER_HEARTBEAT_TTL_S, type WorkerHeartbeat } from "../ops/heartbeat";
import { AppModule } from "../app.module";
import { RuntimeConfig } from "../config/runtime-config";
import { JobRegistry, type RecurringJob } from "./job-registry";
import { runWithJobContext, runWithTimeout } from "./job-context";
import { JobsModule } from "./jobs.module";
import { JobsService } from "./jobs.service";
import { OutboxDispatcher } from "./outbox.dispatcher";
import { DEFAULT_TIMEZONE, QUEUE_NAME } from "./scheduling";

@Module({ imports: [AppModule, JobsModule] })
class WorkerModule {}

const CONCURRENCY = Math.max(1, Number(process.env.JOBS_CONCURRENCY || 4));
const DEFAULT_TIMEOUT_MS = Math.max(1000, Number(process.env.JOBS_TIMEOUT_MS || 5 * 60_000));
const SHUTDOWN_GRACE_MS = Math.max(1000, Number(process.env.JOBS_SHUTDOWN_GRACE_MS || 30_000));
const WORKER_NAME = `${hostname()}:${process.pid}`;
/** Health endpoint port (0 disables). Binds BIND_HOST (loopback by default; containers set 0.0.0.0). */
const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 4190);
const STARTED_AT = new Date().toISOString();

/** One JSON object per line so logs can be shipped/queried as-is. */
function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: "northstar-worker", worker: WORKER_NAME, event, ...fields });
  if (level === "error") console.error(line); else console.log(line);
}

/** Routes Nest's logger through the same JSON lines (messages that are JSON objects are merged in, not re-encoded). */
class JsonLogger implements LoggerService {
  private write(level: "info" | "warn" | "error", message: unknown, context?: string) {
    if (level === "info" && (context === "InstanceLoader" || context === "NestFactory")) return; // boot noise
    let fields: Record<string, unknown> = { message };
    if (typeof message === "string" && message.startsWith("{")) {
      try { fields = JSON.parse(message); } catch { /* plain text */ }
    }
    const { event, ...rest } = fields as { event?: string };
    log(level, String(event || "log"), { context, ...rest });
  }
  log(message: unknown, context?: string) { this.write("info", message, context); }
  warn(message: unknown, context?: string) { this.write("warn", message, context); }
  error(message: unknown, trace?: string, context?: string) { this.write("error", message, context || trace); }
  debug() { /* quiet */ }
  verbose() { /* quiet */ }
}

/**
 * Upserts one BullMQ job scheduler per registered recurring job (id = job name). Upserts are idempotent across
 * restarts and safe with many workers: BullMQ derives each iteration's job id from the scheduler id + timestamp, so
 * concurrent instances never enqueue the same run twice. Schedulers no longer registered are removed.
 */
async function syncSchedules(queue: Queue, schedules: RecurringJob[]) {
  const wanted = new Set<string>();
  for (const schedule of schedules) {
    if (!schedule.every && !schedule.cron) continue;
    wanted.add(schedule.name);
    const repeat = schedule.every ? { every: schedule.every } : { pattern: schedule.cron!, tz: schedule.tz || DEFAULT_TIMEZONE };
    await queue.upsertJobScheduler(schedule.name, repeat, {
      name: schedule.name,
      data: { ...(schedule.payload || {}), scheduled: true },
      opts: { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 200, removeOnFail: { count: 1000, age: 30 * 24 * 3600 } },
    });
  }
  let removed = 0;
  if (process.env.JOBS_PRUNE_SCHEDULERS !== "false") {
    for (const existing of await queue.getJobSchedulers(0, 499, true)) {
      if (!wanted.has(existing.key)) { await queue.removeJobScheduler(existing.key); removed += 1; }
    }
  }
  log("info", "schedules_synced", { count: wanted.size, removed, names: [...wanted].sort() });
}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: new JsonLogger() });
  const config = app.get(RuntimeConfig);
  config.validate();
  if (!config.redisUrl) throw new Error("REDIS_URL is required to run the worker.");
  const registry = app.get(JobRegistry);
  const queue = app.get(JobsService).bullQueue!;

  const processor = async (job: Job) => {
    const handler = registry.handler(job.name);
    if (!handler) throw new UnrecoverableError(`No handler registered for job "${job.name}".`);
    const timeoutMs = registry.describe(job.name).timeoutMs || DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const startedAt = new Date();
    const attempt = job.attemptsMade + 1;
    log("info", "job_started", { job: job.name, id: job.id, attempt, org: job.data?.organizationId || null, trigger: job.data?.trigger || (job.data?.scheduled ? "schedule" : "queued") });
    const result = await runWithTimeout(
      (signal) => runWithJobContext({ id: String(job.id), name: job.name, attempt, signal, startedAt }, () => handler(job.data || {})),
      timeoutMs, controller);
    log("info", "job_completed", { job: job.name, id: job.id, attempt, ms: Date.now() - startedAt.getTime(), result });
    return result ?? null;
  };

  const worker = new Worker(QUEUE_NAME, processor, {
    connection: { url: config.redisUrl },
    concurrency: CONCURRENCY,
    name: WORKER_NAME,
    lockDuration: 60_000,
    maxStalledCount: 2,
    autorun: false,
  });
  const stats = { active: 0, completed: 0, failed: 0 };
  worker.on("active", () => { stats.active += 1; });
  worker.on("completed", () => { stats.completed += 1; stats.active = Math.max(0, stats.active - 1); });
  worker.on("failed", (job, error) => {
    const final = !job || job.attemptsMade >= (job.opts.attempts || 1) || error instanceof UnrecoverableError;
    log(final ? "error" : "warn", final ? "job_failed" : "job_retrying", { job: job?.name, id: job?.id, attempt: job?.attemptsMade, error: error.message });
    if (job) stats.active = Math.max(0, stats.active - 1);
    if (final) {
      stats.failed += 1;
      reportError(error, { service: "worker", job: job?.name, jobId: job?.id ? String(job.id) : undefined, organizationId: job?.data?.organizationId || undefined });
    }
  });
  worker.on("stalled", (id) => log("warn", "job_stalled", { id }));
  worker.on("error", (error) => log("error", "worker_error", { error: error.message }));

  await syncSchedules(queue, registry.schedules());
  log("info", "worker_started", { queue: QUEUE_NAME, concurrency: CONCURRENCY, handlers: registry.names(), mail: app.get(OutboxDispatcher).mode });
  void worker.run();

  // Heartbeat in Redis (read by GET /api/v2/platform/ops/status) and a tiny HTTP health endpoint for the orchestrator.
  let stopping = false;
  const redis = (await queue.client) as unknown as Redis;
  const beat = async () => {
    const heartbeat: WorkerHeartbeat = { worker: WORKER_NAME, startedAt: STARTED_AT, at: new Date().toISOString(),
      active: stats.active, completed: stats.completed, failed: stats.failed,
      concurrency: CONCURRENCY, version: buildInfo().version, commit: buildInfo().commit, stopping };
    await redis.set(`${WORKER_HEARTBEAT_PREFIX}${WORKER_NAME}`, JSON.stringify(heartbeat), "EX", WORKER_HEARTBEAT_TTL_S);
  };
  let lastBeatOk = 0;
  const heartbeatTimer = setInterval(() => { beat().then(() => { lastBeatOk = Date.now(); }, (error) => log("warn", "heartbeat_failed", { error: probeError(error) })); }, WORKER_HEARTBEAT_EVERY_MS);
  heartbeatTimer.unref();
  await beat().then(() => { lastBeatOk = Date.now(); }, () => {});
  const health = HEALTH_PORT > 0 ? startHealthServer(HEALTH_PORT, config.bindHost, async (ready) => {
    if (!ready) return { code: stopping ? 503 : 200, body: { status: stopping ? "stopping" : "ok", uptimeSeconds: Math.round(process.uptime()) } };
    const checks: Record<string, unknown> = {};
    let ok = !stopping && worker.isRunning();
    checks.worker = { status: worker.isRunning() ? "ok" : "fail" };
    try { await withTimeout(redis.ping(), 2_000); checks.redis = { status: "ok" }; } catch (error) { ok = false; checks.redis = { status: "fail", error: probeError(error) }; }
    const beatAge = lastBeatOk ? Math.round((Date.now() - lastBeatOk) / 1000) : null;
    checks.heartbeat = { status: beatAge !== null && beatAge < WORKER_HEARTBEAT_TTL_S ? "ok" : "fail", ageSeconds: beatAge };
    if (checks.heartbeat && (checks.heartbeat as { status: string }).status === "fail") ok = false;
    return { code: ok ? 200 : 503, body: { status: stopping ? "stopping" : ok ? "ready" : "not_ready", checks } };
  }) : null;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "worker_stopping", { signal, graceMs: SHUTDOWN_GRACE_MS });
    clearInterval(heartbeatTimer);
    await redis.del(`${WORKER_HEARTBEAT_PREFIX}${WORKER_NAME}`).catch(() => {});
    const force = setTimeout(() => { log("warn", "worker_force_close"); void worker.close(true); }, SHUTDOWN_GRACE_MS);
    try {
      await worker.close(); // stops taking jobs and waits for active ones to finish
      clearTimeout(force);
      await app.get(OutboxDispatcher).close();
      await new Promise<void>((resolve) => (health ? health.close(() => resolve()) : resolve()));
      await app.close();
      log("info", "worker_stopped", { signal });
      process.exit(0);
    } catch (error) {
      log("error", "worker_stop_failed", { error: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtExceptionMonitor", (error) => reportError(error, { service: "worker" }));
}

/** GET /health/live and /health/ready on the worker (no auth, no secrets: statuses and counts only). */
function startHealthServer(port: number, host: string, probe: (ready: boolean) => Promise<{ code: number; body: unknown }>): Server {
  const server = createServer((request, response) => {
    const path = (request.url || "").split("?")[0];
    const ready = path === "/health/ready";
    if (request.method !== "GET" || (!ready && path !== "/health/live" && path !== "/health")) {
      response.writeHead(404, { "content-type": "application/json" }).end('{"status":"not_found"}');
      return;
    }
    probe(ready).then(({ code, body }) => {
      response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
    }, () => response.writeHead(503, { "content-type": "application/json" }).end('{"status":"error"}'));
  });
  server.on("error", (error) => log("warn", "health_server_error", { error: probeError(error), port }));
  server.listen(port, host, () => log("info", "health_server_listening", { port, host }));
  return server;
}

bootstrap().catch((error) => {
  log("error", "worker_boot_failed", { error: error instanceof Error ? error.stack || error.message : String(error) });
  process.exit(1);
});

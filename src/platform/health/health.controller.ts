import { Controller, Get, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { access, constants } from "node:fs/promises";
import type { Redis } from "ioredis";
import { DatabaseService } from "../database/database.service";
import { JobsService } from "../jobs/jobs.service";
import { RuntimeConfig } from "../config/runtime-config";
import { activeDriver, storageFor } from "../files/storage";
import { Public } from "../auth/public.decorator";
import { isDraining, probeError, uptimeSeconds, withTimeout } from "./lifecycle";
import { migrationStatus } from "./migration-status";

type Check = { status: "ok" | "fail" | "skipped"; ms?: number; error?: string; [key: string]: unknown };
type Readiness = { status: "ready" | "not_ready" | "draining"; checks: Record<string, Check> };

const PROBE_TIMEOUT_MS = 2_000;
const READY_CACHE_MS = Math.max(0, Number(process.env.HEALTH_READY_CACHE_MS ?? 5_000));
type Reply = { code: (status: number) => Reply; header: (name: string, value: string) => Reply; send: (body: unknown) => void };

/**
 * Health endpoints (public, rate-limit tier "public" via the /api/v2/health prefix in config/rate-limit.ts):
 *   GET /api/v2/health        legacy summary (database round-trip) — kept for existing monitors
 *   GET /api/v2/health/live   liveness: the process is up and its event loop answers (container HEALTHCHECK)
 *   GET /api/v2/health/ready  readiness: both DB pools, Redis, file storage and migrations (load balancer target health)
 * Responses contain statuses, timings and counts only — no hostnames, bucket names, users or error messages.
 */
@ApiTags("health")
@Controller("api/v2/health")
export class HealthController {
  private cached?: { at: number; result: Readiness };
  private inflight?: Promise<Readiness>;

  constructor(private readonly database: DatabaseService, private readonly jobs: JobsService, private readonly config: RuntimeConfig) {}

  @Get()
  @Public()
  @ApiOperation({ summary: "Service and database readiness" })
  async health() {
    const result = await this.database.query<{ now: string }>("SELECT now()::text AS now");
    return { status: "ok", service: "northstar-platform", database: "postgresql", time: result.rows[0].now };
  }

  @Get("live")
  @Public()
  @ApiOperation({ summary: "Liveness: the API process is up" })
  live() {
    return { status: "ok", uptimeSeconds: uptimeSeconds() };
  }

  @Get("ready")
  @Public()
  @ApiOperation({ summary: "Readiness: database pools, Redis, file storage and migrations" })
  async ready(@Res() reply: Reply) {
    const result: Readiness = isDraining() ? { status: "draining", checks: {} } : await this.readiness();
    reply.code(result.status === "ready" ? 200 : 503).header("cache-control", "no-store").send(result);
  }

  /** Cached for HEALTH_READY_CACHE_MS (default 5 s) and coalesced, so a flood of probes costs one round of checks. */
  private async readiness(): Promise<Readiness> {
    if (this.cached && Date.now() - this.cached.at < READY_CACHE_MS) return this.cached.result;
    this.inflight ||= this.runChecks().finally(() => { this.inflight = undefined; });
    const result = await this.inflight;
    this.cached = { at: Date.now(), result };
    return result;
  }

  private async runChecks(): Promise<Readiness> {
    const production = this.config.nodeEnv === "production";
    const [database, databaseRuntime, redis, storage, migrations] = await Promise.all([
      timed(() => this.database.systemQuery("SELECT 1")),
      timed(() => this.database.query("SELECT 1")),
      this.jobs.bullQueue
        ? timed(async () => { const client = (await this.jobs.bullQueue!.client) as unknown as Redis; if ((await client.ping()) !== "PONG") throw new Error("ping"); })
        : Promise.resolve<Check>({ status: production ? "fail" : "skipped", error: "not_configured" }),
      this.storageCheck(),
      timed(async () => {
        const state = await migrationStatus((sql) => this.database.systemQuery(sql));
        if (state.status === "pending" || state.status === "changed") throw Object.assign(new Error(state.status), { code: state.status.toUpperCase(), state });
        return state;
      }, (state) => ({ ...state, status: state.status === "unknown" ? "skipped" : "ok" }), (error) => (error as { state?: object }).state ?? {}),
    ]);
    const checks: Record<string, Check> = { database, databaseRuntime, redis, storage, migrations };
    return { status: Object.values(checks).some((check) => check.status === "fail") ? "not_ready" : "ready", checks };
  }

  private async storageCheck(): Promise<Check> {
    let driver: string;
    try { driver = activeDriver(); } catch { return { status: "fail", error: "invalid_driver" }; }
    return timed(async () => {
      const storage = storageFor(driver as "local" | "s3");
      // local: the upload root must be writable. s3: a HEAD of a key that never exists answers 404 when the bucket is
      // reachable and the task role may list it (grant s3:ListBucket on the prefix, otherwise S3 answers 403 → fail).
      if (storage.name === "local") await access(storage.location, constants.W_OK);
      else await storage.exists("healthcheck/.probe");
    }, () => ({ status: "ok", driver }), () => ({ driver }));
  }
}

async function timed<T>(work: () => Promise<T>, onOk?: (value: T) => Partial<Check>, onFail?: (error: unknown) => object): Promise<Check> {
  const started = Date.now();
  try {
    const value = await withTimeout(work(), PROBE_TIMEOUT_MS);
    return { status: "ok", ...(onOk ? onOk(value) : {}), ms: Date.now() - started } as Check;
  } catch (error) {
    return { ...(onFail ? onFail(error) : {}), status: "fail", ms: Date.now() - started, error: probeError(error) };
  }
}

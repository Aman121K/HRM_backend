import { ForbiddenException, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { DatabaseService } from "../database/database.service";
import { JobsService } from "../jobs/jobs.service";
import { RuntimeConfig } from "../config/runtime-config";
import { activeDriver } from "../files/storage";
import type { AuthIdentity } from "../auth/auth.types";
import { buildInfo, processStartedAt, uptimeSeconds, withTimeout } from "../health/lifecycle";
import { migrationStatus } from "../health/migration-status";
import { errorReportingEnabled } from "./error-reporter";
import { BACKUP_MARKER_KEY, WORKER_HEARTBEAT_PREFIX, type WorkerHeartbeat } from "./heartbeat";

const TIMEOUT_MS = 3_000;

/** Read-only operational snapshot for platform administrators. No secrets, hostnames or connection strings. */
@Injectable()
export class OpsService {
  constructor(private readonly database: DatabaseService, private readonly jobs: JobsService, private readonly config: RuntimeConfig) {}

  async status(identity: AuthIdentity) {
    if (!identity.roles.includes("PLATFORM_ADMIN") || identity.organizationId) throw new ForbiddenException("Platform administrators only.");
    const [database, migrations, queue] = await Promise.all([
      this.section(() => this.databaseInfo()),
      this.section(() => migrationStatus((sql) => this.database.systemQuery(sql))),
      this.section(() => this.queueInfo()),
    ]);
    let storageDriver: string;
    try { storageDriver = activeDriver(); } catch { storageDriver = "invalid"; }
    return {
      generatedAt: new Date().toISOString(),
      environment: this.config.nodeEnv,
      api: { ...buildInfo(), startedAt: processStartedAt.toISOString(), uptimeSeconds: uptimeSeconds(), pid: process.pid,
        memoryRssMb: Math.round(process.memoryUsage().rss / 1048576) },
      database, migrations, queue,
      storage: { driver: storageDriver },
      errorReporting: { enabled: errorReportingEnabled() },
    };
  }

  private async section<T>(work: () => Promise<T>): Promise<T | { error: string }> {
    try { return await withTimeout(work(), TIMEOUT_MS); } catch (error) { return { error: (error as Error).message === "timeout" ? "timeout" : "unavailable" }; }
  }

  private async databaseInfo() {
    const row = (await this.database.systemQuery<{ size: string; version: string; connections: number; oldest_tx_s: number | null }>(
      `SELECT pg_database_size(current_database())::text AS size,
              current_setting('server_version') AS version,
              (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections,
              (SELECT extract(epoch FROM now() - min(xact_start))::int FROM pg_stat_activity
                WHERE datname = current_database() AND state <> 'idle' AND xact_start IS NOT NULL) AS oldest_tx_s`)).rows[0];
    const audit = (await this.database.systemQuery<{ rows: string; latest: string | null }>(
      `SELECT count(*)::text AS rows, max(created_at)::text AS latest FROM audit_log`)).rows[0];
    return {
      sizeBytes: Number(row.size), sizeMb: Math.round(Number(row.size) / 1048576), serverVersion: row.version,
      connections: row.connections, oldestTransactionSeconds: row.oldest_tx_s, auditLogRows: Number(audit.rows), auditLogLatest: audit.latest,
    };
  }

  private async queueInfo() {
    const queue = this.jobs.bullQueue;
    if (!queue) return { configured: false };
    const client = (await queue.client) as unknown as Redis;
    const [counts, failed, workers, heartbeats, marker] = await Promise.all([
      queue.getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused", "prioritized"),
      queue.getFailed(0, 9),
      queue.getWorkersCount(),
      this.heartbeats(client),
      client.get(BACKUP_MARKER_KEY),
    ]);
    let backup: unknown = null;
    if (marker) { try { backup = JSON.parse(marker); } catch { backup = { raw: marker.slice(0, 200) }; } }
    return {
      configured: true,
      counts,
      depth: (counts.waiting || 0) + (counts.delayed || 0) + (counts.prioritized || 0),
      recentFailed: failed.map((job) => ({
        id: job.id, name: job.name, attemptsMade: job.attemptsMade,
        failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        reason: String(job.failedReason || "").slice(0, 200),
      })),
      workersConnected: workers,
      workers: heartbeats,
      lastBackup: backup,
    };
  }

  private async heartbeats(client: Redis) {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await client.scan(cursor, "MATCH", `${WORKER_HEARTBEAT_PREFIX}*`, "COUNT", 100);
      cursor = next; keys.push(...batch);
    } while (cursor !== "0" && keys.length < 200);
    if (!keys.length) return [];
    return (await client.mget(...keys)).flatMap((value) => {
      try { return value ? [JSON.parse(value) as WorkerHeartbeat] : []; } catch { return []; }
    });
  }
}

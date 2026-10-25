/** Redis keys shared by the worker (writer) and the ops status endpoint (reader). */
export const WORKER_HEARTBEAT_PREFIX = "northstar:worker:heartbeat:";
/** Seconds a heartbeat stays visible; the worker refreshes it every WORKER_HEARTBEAT_EVERY_MS. */
export const WORKER_HEARTBEAT_TTL_S = 60;
export const WORKER_HEARTBEAT_EVERY_MS = 15_000;
/**
 * Written by the backup tooling / restore drill, never by the app (see docs/ops/backup-restore.md), e.g.
 *   redis-cli -u "$REDIS_URL" SET northstar:ops:backup-marker '{"at":"2026-10-20T02:00:00Z","kind":"rds-snapshot","ref":"rds:hrm-prod-2026-10-20-02-00","verifiedRestore":"2026-10-01"}'
 */
export const BACKUP_MARKER_KEY = "northstar:ops:backup-marker";

export type WorkerHeartbeat = {
  worker: string; startedAt: string; at: string; active: number; completed: number; failed: number;
  concurrency: number; version: string; commit: string | null; stopping: boolean;
};

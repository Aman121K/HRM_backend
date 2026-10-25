import { keyBelongsTo, storageFor, type StorageDriverName } from "../../files/storage";
import type { Counters, TenantJobContext } from "../tenant-runner";

export const fileRetentionDays = () => Math.max(1, Number(process.env.FILE_RETENTION_DAYS || 30));
export const notificationRetentionDays = () => Math.max(7, Number(process.env.NOTIFICATION_RETENTION_DAYS || 180));
const BATCH = 200;

/**
 * Purges attachments soft-deleted longer than FILE_RETENTION_DAYS (default 30): bytes first, then the row, each in a
 * savepoint. Rows still referenced elsewhere (e.g. an onboarding document review) are kept and counted as "kept".
 */
export async function purgeDeletedFiles(ctx: TenantJobContext): Promise<Counters> {
  const days = fileRetentionDays();
  const rows = (await ctx.client.query(
    `SELECT id, storage_key, storage_driver, original_name, byte_size, entity_type, entity_id, deleted_at FROM stored_files
      WHERE organization_id=$1 AND deleted_at IS NOT NULL AND deleted_at < now() - make_interval(days => $2)
      ORDER BY deleted_at LIMIT $3 FOR UPDATE SKIP LOCKED`, [ctx.organization.id, days, BATCH])).rows;
  let purged = 0, kept = 0, bytes = 0;
  for (const row of rows) {
    // Only ever delete inside this company's own folder.
    if (row.storage_key && !keyBelongsTo(row.storage_key, ctx.organization.id)) { kept += 1; continue; }
    await ctx.client.query("SAVEPOINT purge_file");
    try {
      await ctx.client.query(`DELETE FROM stored_files WHERE organization_id=$1 AND id=$2`, [ctx.organization.id, row.id]);
      if (row.storage_key) await storageFor((row.storage_driver || "local") as StorageDriverName).delete(row.storage_key);
      await ctx.audit("FILE_PURGED", "stored_file", row.id,
        { name: row.original_name, bytes: row.byte_size, entityType: row.entity_type, entityId: row.entity_id, deletedAt: row.deleted_at, retentionDays: days });
      await ctx.client.query("RELEASE SAVEPOINT purge_file");
      purged += 1; bytes += Number(row.byte_size) || 0;
    } catch {
      await ctx.client.query("ROLLBACK TO SAVEPOINT purge_file");
      kept += 1;
    }
  }
  return { purged, kept, bytes, retentionDays: days, more: rows.length === BATCH };
}

/**
 * Deletes in-app notifications older than NOTIFICATION_RETENTION_DAYS (default 180) in batches, plus job history
 * older than 90 days and idempotency ledger rows older than 400 days (well past every reminder window).
 */
export async function expireNotifications(ctx: TenantJobContext): Promise<Counters> {
  const org = ctx.organization.id;
  const days = notificationRetentionDays();
  const events = await ctx.client.query(
    `DELETE FROM workflow_events WHERE id IN (SELECT id FROM workflow_events WHERE organization_id=$1 AND created_at < now() - make_interval(days => $2) LIMIT 5000)`,
    [org, days]);
  const runs = await ctx.client.query(`DELETE FROM job_runs WHERE organization_id=$1 AND started_at < now() - interval '90 days'`, [org]);
  const ledger = await ctx.client.query(`DELETE FROM job_dispatch_log WHERE organization_id=$1 AND created_at < now() - interval '400 days'`, [org]);
  return { notifications: events.rowCount || 0, jobRuns: runs.rowCount || 0, ledger: ledger.rowCount || 0, retentionDays: days };
}

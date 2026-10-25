import { BadRequestException, ConflictException, ForbiddenException, Injectable, InternalServerErrorException, Logger, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { activeDriver, keyBelongsTo, objectKey, sha256Hex, storageFor, type StorageDriverName } from "../files/storage";
import { JobRegistry } from "../jobs/job-registry";
import { JobsService } from "../jobs/jobs.service";
import { TenantJobRunner } from "../jobs/tenant-runner";
import { cleanRow, EXPORT_TTL_DAYS, SAFE_IDENT, toCsv, toJson } from "./export-format";
import type { BrandExportDto, RequestClosureDto } from "./privacy.dto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BRAND_EXPORT_JOB = "privacy.brand_export";
export const CLOSURE_JOB = "privacy.brand_closures";
/** Platform-level tables that carry organization_id but are not the brand's own data (kept, or handled separately). */
const PLATFORM_TABLES = new Set(["organizations", "privacy_breaches", "privacy_brand_exports", "privacy_brand_closures", "audit_log", "schema_migrations"]);
const isBilling = (table: string) => table.startsWith("billing_");
type FileEntry = { name: string; key: string; driver: StorageDriverName; bytes: number; sha256: string; rows?: number };

/**
 * Customer exit (DPA: return and deletion at end of contract). Super admins export a whole brand (JSON + CSV per table
 * plus a files manifest, stored in the brand's own storage folder, downloadable for 7 days) and close a brand:
 * request → second platform admin confirms → brand suspended + export → deletion after the grace period. Deletion
 * erases all brand data except the audit chain and minimal billing records, then records a deletion certificate.
 */
@Injectable()
export class BrandExitService implements OnModuleInit {
  private readonly logger = new Logger(BrandExitService.name);
  constructor(private readonly database: DatabaseService, private readonly registry: JobRegistry, private readonly jobs: JobsService,
    private readonly runner: TenantJobRunner) {}

  onModuleInit() {
    this.registry.register(BRAND_EXPORT_JOB, (payload) => this.runExport(String(payload.exportId || "")), undefined,
      { description: "Exports all data of one brand (JSON/CSV per table + files manifest) into the brand's storage folder.", timeoutMs: 20 * 60_000 });
    this.registry.register(CLOSURE_JOB, () => this.sweep(), {
      cron: "30 1 * * *", description: "Deletes the data of closed brands whose grace period has ended (two-admin confirmed) and expires brand exports after 7 days.",
      timeoutMs: 30 * 60_000,
    });
  }

  private async requirePlatform(identity: AuthIdentity) {
    const ok = identity.userId && (await this.database.systemQuery(`SELECT 1 FROM platform_admins WHERE user_id=$1`, [identity.userId])).rowCount;
    if (!ok) throw new ForbiddenException("Only platform administrators can export or close brands.");
  }

  /** Audit rows go into the brand's own chain (audit_log needs an organization). */
  private brandAudit(client: PoolClient | null, organizationId: string, actor: string, action: string, after: unknown) {
    const sql = `INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,$3,'organization',$1,$4)`;
    const values = [organizationId, actor, action, JSON.stringify(after)];
    return client ? client.query(sql, values) : this.database.systemQuery(sql, values);
  }

  // ------------------------------------------------------------------ overview

  async brands(identity: AuthIdentity) {
    await this.requirePlatform(identity);
    const rows = (await this.database.systemQuery(
      `SELECT o.id, o.slug, coalesce(o.display_name, o.name) AS name, o.status,
              (SELECT row_to_json(x) FROM (SELECT id, status, created_at AS "createdAt", completed_at AS "completedAt", expires_at AS "expiresAt", error,
                        jsonb_array_length(coalesce(manifest->'files','[]'::jsonb)) AS files
                   FROM privacy_brand_exports WHERE organization_id=o.id ORDER BY created_at DESC LIMIT 1) x) AS "lastExport",
              (SELECT row_to_json(c) FROM (SELECT c.id, c.status, c.reason, c.grace_days AS "graceDays", c.requested_at AS "requestedAt", ru.full_name AS "requestedBy",
                        c.requested_by AS "requestedById", c.confirmed_at AS "confirmedAt", cu.full_name AS "confirmedBy", c.delete_after AS "deleteAfter", c.deleted_at AS "deletedAt",
                        c.certificate, c.error
                   FROM privacy_brand_closures c LEFT JOIN users ru ON ru.id=c.requested_by LEFT JOIN users cu ON cu.id=c.confirmed_by
                  WHERE c.organization_id=o.id ORDER BY c.requested_at DESC LIMIT 1) c) AS closure
         FROM organizations o ORDER BY coalesce(o.display_name, o.name)`)).rows;
    return { items: rows, me: identity.userId, exportTtlDays: EXPORT_TTL_DAYS };
  }

  // ------------------------------------------------------------------ brand export

  async startExport(identity: AuthIdentity, input: BrandExportDto) {
    await this.requirePlatform(identity);
    return this.queueExport(input.organizationId, identity.userId, input.reason || null);
  }

  private async queueExport(organizationId: string, actor: string, reason: string | null) {
    const org = (await this.database.systemQuery(`SELECT id FROM organizations WHERE id=$1`, [organizationId])).rows[0];
    if (!org) throw new NotFoundException("Brand not found.");
    const busy = (await this.database.systemQuery(`SELECT id FROM privacy_brand_exports WHERE organization_id=$1 AND status IN ('QUEUED','RUNNING') AND created_at > now() - interval '2 hours'`, [organizationId])).rows[0];
    if (busy) throw new ConflictException("An export of this brand is already running.");
    const row = (await this.database.systemQuery(`INSERT INTO privacy_brand_exports(organization_id, reason, requested_by) VALUES($1,$2,$3) RETURNING id, status, created_at AS "createdAt"`,
      [organizationId, reason, actor])).rows[0];
    await this.brandAudit(null, organizationId, actor, "BRAND_DATA_EXPORT_REQUESTED", { exportId: row.id, reason });
    const queued = await this.jobs.enqueue(BRAND_EXPORT_JOB, { exportId: row.id }, { attempts: 1 });
    if (!queued.queued) await this.runExport(row.id);
    return row;
  }

  async runExport(exportId: string) {
    if (!UUID.test(exportId)) throw new Error("privacy.brand_export: invalid exportId.");
    const claimed = (await this.database.systemQuery(`UPDATE privacy_brand_exports SET status='RUNNING' WHERE id=$1 AND status='QUEUED' RETURNING organization_id`, [exportId])).rows[0];
    if (!claimed) return { skipped: true };
    const org = claimed.organization_id as string;
    const written: FileEntry[] = [];
    try {
      const manifest = await this.database.platformTransaction(async (client) => {
        // Owner role + this brand's RLS context, so FORCE-RLS tables are readable for exactly this brand.
        await client.query(`SELECT set_config('app.organization_id',$1,true)`, [org]);
        await client.query(`SET LOCAL statement_timeout = '120s'`);
        const tables = await this.brandTables(client);
        const omitted = new Set<string>();
        const driver = activeDriver();
        const put = async (name: string, ext: string, mime: string, body: string, rows?: number) => {
          const bytes = Buffer.from(body, "utf8");
          const fileId = randomUUID();
          const key = objectKey({ organizationId: org, entityType: "privacy_export", category: "BRAND_EXPORT", fileId, ext });
          const sha256 = sha256Hex(bytes);
          await storageFor(driver).put(key, bytes, { contentType: mime, sha256, organizationId: org, fileId });
          const entry: FileEntry = { name, key, driver, bytes: bytes.length, sha256, rows };
          written.push(entry);
          return entry;
        };
        const counts: Record<string, number> = {};
        const organization = (await client.query(`SELECT id, slug, name, display_name, legal_name, timezone, currency, status, created_at, industry, default_state, employee_prefix, enabled_modules FROM organizations WHERE id=$1`, [org])).rows[0];
        await put("organization.json", "json", "application/json", toJson(organization), 1);
        for (const table of tables) {
          const rows = (await client.query(`SELECT * FROM "${table}" WHERE organization_id=$1`, [org])).rows.map((row) => cleanRow(table, row, org, omitted));
          counts[table] = rows.length;
          if (!rows.length) continue;
          await put(`tables/${table}.json`, "json", "application/json", toJson(rows), rows.length);
          await put(`tables/${table}.csv`, "csv", "text/csv", toCsv(rows), rows.length);
        }
        const files = (await client.query(
          `SELECT id, entity_type AS "entityType", entity_id AS "entityId", category, original_name AS "originalName", mime_type AS "mimeType", byte_size AS "byteSize",
                  sha256, storage_driver AS driver, storage_key AS "storageKey", created_at AS "createdAt", deleted_at AS "deletedAt"
             FROM stored_files WHERE organization_id=$1 AND entity_type <> 'privacy_export' ORDER BY created_at`, [org])).rows;
        await put("files-manifest.json", "json", "application/json", toJson(files), files.length);
        await put("files-manifest.csv", "csv", "text/csv", toCsv(files), files.length);
        const readme = {
          format: "northstar.brand-export/v1", organizationId: org, slug: organization.slug, generatedAt: new Date().toISOString(),
          notes: [
            "One JSON and one CSV file per table that holds this company's data (rows filtered by organization_id).",
            "PAN, UAN, ESI and bank account numbers are decrypted. Credentials, tokens, keyed hashes and other secrets are omitted (see omittedColumns).",
            "Uploaded files stay in the company's storage folder (tenants/<organization_id>/…); files-manifest lists each object key with its SHA-256 so they can be copied and verified.",
            `Download links expire after ${EXPORT_TTL_DAYS} days; the export files are then deleted.`,
          ],
          tables: counts, omittedColumns: [...omitted].sort(),
          files: written.map(({ name, bytes, sha256, rows }) => ({ name, bytes, sha256, rows })),
        };
        await put("README.json", "json", "application/json", toJson(readme));
        return { files: written, tables: counts };
      });
      await this.database.systemQuery(`UPDATE privacy_brand_exports SET status='READY', manifest=$2, completed_at=now(), expires_at=now() + make_interval(days => $3) WHERE id=$1`,
        [exportId, JSON.stringify(manifest), EXPORT_TTL_DAYS]);
      await this.brandAudit(null, org, await this.runner.systemUserId(), "BRAND_DATA_EXPORT_READY", { exportId, files: manifest.files.length, tables: Object.keys(manifest.tables).length });
      return { ready: true, files: manifest.files.length };
    } catch (error) {
      for (const entry of written) await storageFor(entry.driver).delete(entry.key).catch(() => undefined);
      const message = (error as Error).message;
      this.logger.error(`Brand export ${exportId} failed: ${message}`);
      await this.database.systemQuery(`UPDATE privacy_brand_exports SET status='FAILED', error=$2, completed_at=now() WHERE id=$1`, [exportId, message.slice(0, 500)]);
      return { ready: false };
    }
  }

  private async brandTables(client: PoolClient) {
    return (await client.query(
      `SELECT c.table_name AS name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
        WHERE c.table_schema='public' AND c.column_name='organization_id' AND t.table_type='BASE TABLE' ORDER BY 1`)).rows
      .map((row) => row.name as string).filter((name) => SAFE_IDENT.test(name) && !PLATFORM_TABLES.has(name) && !isBilling(name));
  }

  async exportFiles(identity: AuthIdentity, exportId: string) {
    await this.requirePlatform(identity);
    const row = await this.readyExport(exportId);
    return { id: row.id, organizationId: row.organization_id, expiresAt: row.expires_at, files: (row.manifest.files as FileEntry[]).map(({ name, bytes, sha256, rows }) => ({ name, bytes, sha256, rows })) };
  }

  private async readyExport(exportId: string) {
    if (!UUID.test(exportId)) throw new NotFoundException("Export not found.");
    const row = (await this.database.systemQuery(`SELECT * FROM privacy_brand_exports WHERE id=$1`, [exportId])).rows[0];
    if (!row || row.status !== "READY" || !row.expires_at || new Date(row.expires_at).getTime() < Date.now()) throw new NotFoundException("This export is not available (not ready, or expired after 7 days).");
    return row;
  }

  async download(identity: AuthIdentity, exportId: string, name: string) {
    await this.requirePlatform(identity);
    const row = await this.readyExport(exportId);
    const entry = (row.manifest.files as FileEntry[]).find((file) => file.name === name);
    if (!entry) throw new NotFoundException("File not found in this export.");
    if (!keyBelongsTo(entry.key, row.organization_id)) throw new NotFoundException("File not found in this export.");
    const bytes = await storageFor(entry.driver).get(entry.key);
    if (sha256Hex(bytes) !== entry.sha256) throw new InternalServerErrorException("This file failed its integrity check and was not served.");
    await this.brandAudit(null, row.organization_id, identity.userId, "BRAND_DATA_EXPORT_DOWNLOADED", { exportId, file: name, bytes: bytes.length });
    return { bytes, name: `${row.organization_id.slice(0, 8)}-${name.replace(/\//g, "-")}`, mimeType: name.endsWith(".csv") ? "text/csv; charset=utf-8" : "application/json; charset=utf-8" };
  }

  // ------------------------------------------------------------------ closure

  async requestClosure(identity: AuthIdentity, input: RequestClosureDto) {
    await this.requirePlatform(identity);
    const org = (await this.database.systemQuery(`SELECT id, slug, status FROM organizations WHERE id=$1`, [input.organizationId])).rows[0];
    if (!org) throw new NotFoundException("Brand not found.");
    if (input.confirmSlug.trim() !== org.slug) throw new BadRequestException(`Type the brand's address name “${org.slug}” to confirm.`);
    try {
      const row = (await this.database.systemQuery(
        `INSERT INTO privacy_brand_closures(organization_id, reason, grace_days, requested_by) VALUES($1,$2,$3,$4) RETURNING id, status`,
        [org.id, input.reason.trim(), input.graceDays, identity.userId])).rows[0];
      await this.brandAudit(null, org.id, identity.userId, "BRAND_CLOSURE_REQUESTED", { closureId: row.id, graceDays: input.graceDays, reason: input.reason.trim() });
      return row;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new ConflictException("A closure for this brand is already in progress.");
      throw error;
    }
  }

  async confirmClosure(identity: AuthIdentity, closureId: string, confirmSlug: string) {
    await this.requirePlatform(identity);
    if (!UUID.test(closureId)) throw new NotFoundException("Closure not found.");
    const result = await this.database.platformTransaction(async (client) => {
      const row = (await client.query(`SELECT c.*, o.slug, o.status AS org_status FROM privacy_brand_closures c JOIN organizations o ON o.id=c.organization_id WHERE c.id=$1 FOR UPDATE OF c`, [closureId])).rows[0];
      if (!row) throw new NotFoundException("Closure not found.");
      if (row.status !== "PENDING_CONFIRMATION") throw new ConflictException("This closure is not waiting for confirmation.");
      if (row.requested_by === identity.userId) throw new ForbiddenException("A second platform administrator must confirm. You requested this closure.");
      if (confirmSlug.trim() !== row.slug) throw new BadRequestException(`Type the brand's address name “${row.slug}” to confirm.`);
      await client.query(`UPDATE privacy_brand_closures SET status='SCHEDULED', confirmed_by=$2, confirmed_at=now(), previous_status=$3,
                            delete_after=now() + make_interval(days => grace_days) WHERE id=$1`, [closureId, identity.userId, row.org_status]);
      await client.query(`UPDATE organizations SET status='SUSPENDED' WHERE id=$1`, [row.organization_id]);
      await this.brandAudit(client, row.organization_id, identity.userId, "BRAND_CLOSURE_CONFIRMED", { closureId, graceDays: row.grace_days, suspended: true });
      return { organizationId: row.organization_id as string };
    });
    // Hand-over copy for the customer, taken right after suspension so it is complete.
    const exportRow = await this.queueExport(result.organizationId, identity.userId, "Closure hand-over export").catch(() => null);
    if (exportRow) await this.database.systemQuery(`UPDATE privacy_brand_closures SET export_id=$2 WHERE id=$1`, [closureId, exportRow.id]);
    return (await this.database.systemQuery(`SELECT id, status, delete_after AS "deleteAfter", export_id AS "exportId" FROM privacy_brand_closures WHERE id=$1`, [closureId])).rows[0];
  }

  async cancelClosure(identity: AuthIdentity, closureId: string) {
    await this.requirePlatform(identity);
    if (!UUID.test(closureId)) throw new NotFoundException("Closure not found.");
    return this.database.platformTransaction(async (client) => {
      const row = (await client.query(`SELECT * FROM privacy_brand_closures WHERE id=$1 FOR UPDATE`, [closureId])).rows[0];
      if (!row) throw new NotFoundException("Closure not found.");
      if (!["PENDING_CONFIRMATION", "SCHEDULED"].includes(row.status)) throw new ConflictException("This closure can no longer be cancelled.");
      await client.query(`UPDATE privacy_brand_closures SET status='CANCELLED', cancelled_by=$2, cancelled_at=now() WHERE id=$1`, [closureId, identity.userId]);
      if (row.status === "SCHEDULED" && row.previous_status) await client.query(`UPDATE organizations SET status=$2 WHERE id=$1`, [row.organization_id, row.previous_status]);
      await this.brandAudit(client, row.organization_id, identity.userId, "BRAND_CLOSURE_CANCELLED", { closureId, restoredStatus: row.status === "SCHEDULED" ? row.previous_status : null });
      return { id: closureId, status: "CANCELLED" };
    });
  }

  /** Nightly: expires brand exports past 7 days, then deletes brands whose grace period ended (export must have completed). */
  async sweep() {
    let expired = 0, deleted = 0;
    for (const row of (await this.database.systemQuery(`SELECT id, organization_id, manifest FROM privacy_brand_exports WHERE status='READY' AND expires_at < now() AND purged_at IS NULL`)).rows) {
      for (const entry of (row.manifest.files || []) as FileEntry[]) if (keyBelongsTo(entry.key, row.organization_id)) await storageFor(entry.driver).delete(entry.key).catch(() => undefined);
      await this.database.systemQuery(`UPDATE privacy_brand_exports SET status='EXPIRED', purged_at=now() WHERE id=$1`, [row.id]);
      expired += 1;
    }
    const due = (await this.database.systemQuery(
      `SELECT c.id FROM privacy_brand_closures c LEFT JOIN privacy_brand_exports x ON x.id=c.export_id
        WHERE c.status='SCHEDULED' AND c.delete_after <= now() AND x.status IN ('READY','EXPIRED')`)).rows;
    for (const closure of due) { await this.deleteBrand(closure.id); deleted += 1; }
    return { exportsExpired: expired, brandsDeleted: deleted };
  }

  /** Erases every row of the brand except audit_log (hash chain) and billing_* records, then its storage folder. */
  async deleteBrand(closureId: string) {
    const claimed = (await this.database.systemQuery(`UPDATE privacy_brand_closures SET status='DELETING' WHERE id=$1 AND status='SCHEDULED' RETURNING *`, [closureId])).rows[0];
    if (!claimed) return;
    const org = claimed.organization_id as string;
    try {
      const outcome = await this.database.platformTransaction(async (client) => {
        await client.query(`SELECT set_config('app.organization_id',$1,true)`, [org]);
        await client.query(`SET LOCAL statement_timeout = '300s'`);
        const objects = (await client.query(`SELECT storage_key AS key, storage_driver AS driver FROM stored_files WHERE organization_id=$1 AND storage_key <> ''`, [org])).rows as { key: string; driver: StorageDriverName }[];
        for (const row of (await client.query(`SELECT manifest FROM privacy_brand_exports WHERE organization_id=$1 AND purged_at IS NULL`, [org])).rows)
          for (const entry of (row.manifest.files || []) as FileEntry[]) objects.push({ key: entry.key, driver: entry.driver });
        const members = (await client.query(`SELECT DISTINCT user_id FROM organization_memberships WHERE organization_id=$1`, [org])).rows.map((row) => row.user_id as string);
        // Live surveys block question deletion (immutability trigger); a closed brand's surveys go back to draft first.
        if ((await client.query(`SELECT to_regclass('public.surveys') AS t`)).rows[0].t) {
          await client.query("SAVEPOINT surveys_draft");
          try { await client.query(`UPDATE surveys SET status='DRAFT' WHERE organization_id=$1`, [org]); await client.query("RELEASE SAVEPOINT surveys_draft"); }
          catch { await client.query("ROLLBACK TO SAVEPOINT surveys_draft"); }
        }
        const remaining = new Set(await this.brandTables(client));
        const deletedRows: Record<string, number> = {};
        const errors: Record<string, string> = {};
        // Foreign keys between brand tables: delete in passes until nothing more can be removed.
        for (let pass = 0; pass < 12 && remaining.size; pass += 1) {
          let progress = false;
          for (const table of [...remaining]) {
            await client.query("SAVEPOINT del_table");
            try {
              const result = await client.query(`DELETE FROM "${table}" WHERE organization_id=$1`, [org]);
              await client.query("RELEASE SAVEPOINT del_table");
              deletedRows[table] = (deletedRows[table] || 0) + (result.rowCount || 0);
              remaining.delete(table); progress = true;
            } catch (error) {
              await client.query("ROLLBACK TO SAVEPOINT del_table");
              errors[table] = (error as Error).message.slice(0, 200);
            }
          }
          if (!progress) break;
        }
        for (const table of Object.keys(errors)) if (!remaining.has(table)) delete errors[table];
        // Platform accounts that belonged only to this brand are anonymised (audit rows keep their user id).
        let usersAnonymised = 0;
        for (const userId of members) {
          const result = await client.query(
            `UPDATE users SET email='erased-' || id || '@erased.invalid', full_name='Erased user', password_hash=NULL
              WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM organization_memberships WHERE user_id=$1) AND NOT EXISTS (SELECT 1 FROM employees WHERE user_id=$1)
                AND NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_id=$1)`, [userId]);
          usersAnonymised += result.rowCount || 0;
        }
        await client.query(`UPDATE organizations SET logo_data_url=NULL WHERE id=$1`, [org]);
        return { objects, deletedRows, errors, usersAnonymised };
      });
      let filesDeleted = 0, filesFailed = 0;
      for (const object of outcome.objects) {
        if (!keyBelongsTo(object.key, org)) { filesFailed += 1; continue; }
        try { await storageFor(object.driver || "local").delete(object.key); filesDeleted += 1; } catch { filesFailed += 1; }
      }
      const certificate = {
        certificate: "northstar.brand-deletion-certificate/v1", closureId, organizationId: org, deletedAt: new Date().toISOString(),
        requestedBy: claimed.requested_by, confirmedBy: claimed.confirmed_by, graceDays: claimed.grace_days,
        rowsDeleted: outcome.deletedRows, notDeleted: outcome.errors, objectsDeleted: filesDeleted, objectsFailed: filesFailed, usersAnonymised: outcome.usersAnonymised,
        kept: ["audit_log (append-only hash chain — security and legal evidence)", "organizations row (suspended; name kept for billing and the chain)", "billing_* records (invoices, payments)"],
      };
      const digest = createHash("sha256").update(JSON.stringify(certificate)).digest("hex");
      await this.brandAudit(null, org, await this.runner.systemUserId(), "BRAND_DATA_ERASED", { ...certificate, sha256: digest });
      await this.database.systemQuery(`UPDATE privacy_brand_closures SET status='DELETED', deleted_at=now(), certificate=$2 WHERE id=$1`, [closureId, JSON.stringify({ ...certificate, sha256: digest })]);
      await this.database.systemQuery(`UPDATE privacy_brand_exports SET status='EXPIRED', purged_at=now() WHERE organization_id=$1 AND purged_at IS NULL`, [org]);
    } catch (error) {
      this.logger.error(`Brand deletion ${closureId} failed: ${(error as Error).message}`);
      await this.database.systemQuery(`UPDATE privacy_brand_closures SET status='SCHEDULED', error=$2 WHERE id=$1`, [closureId, (error as Error).message.slice(0, 500)]);
    }
  }
}

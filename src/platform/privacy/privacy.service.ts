import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { FilesService } from "../files/files.service";
import { activeDriver, keyBelongsTo, objectKey, sha256Hex, storageFor, type StorageDriverName } from "../files/storage";
import { JobRegistry } from "../jobs/job-registry";
import { JobsService } from "../jobs/jobs.service";
import { TenantJobRunner, type Counters, type TenantJobContext } from "../jobs/tenant-runner";
import { cleanRow, EXPORT_TTL_DAYS, SAFE_IDENT, toCsv, toJson } from "./export-format";
import { CATEGORY_INFO, DEFAULT_RETENTION, normalizeRetention, RETENTION_CATEGORIES, RETENTION_LIMITS, retentionProblems } from "./retention";
import type { UpdatePrivacySettingsDto } from "./privacy.dto";

export const HR_ROLES = ["HR_ADMIN", "OWNER"];
export const isHr = (identity: AuthIdentity) => identity.roles.some((role) => HR_ROLES.includes(role));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EXPORT_JOB = "privacy.employee_export";
const MAX_EXPORTS_PER_DAY = 3;
/** Tables the curated sections already cover (or that hold only platform plumbing); everything else with employee_id is exported generically. */
const CURATED = new Set(["employees", "payroll_profiles", "attendance_events", "leave_requests", "payslips", "tax_declarations", "onboarding_joiners",
  "attendance_regularizations", "privacy_exports", "privacy_subject_state", "privacy_erasure_runs", "workflow_events", "notification_reads",
  "notification_read_cursors", "push_notifications", "import_batch_changes"]);

export type PrivacySettingsRow = {
  grievance_name: string | null; grievance_email: string | null; grievance_phone: string | null; grievance_address: string | null;
  significant_fiduciary: boolean; dpo_name: string | null; dpo_email: string | null; dpo_phone: string | null;
  retention: Record<string, number>; auto_erase: boolean; version: number; updated_at: string | null; updated_by: string | null;
};

export async function loadPrivacySettings(client: PoolClient, organizationId: string): Promise<PrivacySettingsRow> {
  const row = (await client.query(`SELECT * FROM privacy_settings WHERE organization_id=$1`, [organizationId])).rows[0];
  return row || { grievance_name: null, grievance_email: null, grievance_phone: null, grievance_address: null, significant_fiduciary: false,
    dpo_name: null, dpo_email: null, dpo_phone: null, retention: {}, auto_erase: false, version: 0, updated_at: null, updated_by: null };
}

export function audit(client: PoolClient, organizationId: string, actorUserId: string, action: string, entityType: string, entityId: string, after: unknown, before?: unknown) {
  return client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [organizationId, actorUserId, action, entityType, entityId, before === undefined ? null : JSON.stringify(before), JSON.stringify(after ?? null)]);
}

/**
 * Data-principal rights for employees (DPDP Act ss.11–14): privacy page data, "Download my data" exports, and the
 * brand's privacy settings (grievance officer, DPO, retention schedule). The platform is the Data Processor; each brand
 * (client company) is the Data Fiduciary for its employees.
 */
@Injectable()
export class PrivacyService implements OnModuleInit {
  private readonly logger = new Logger(PrivacyService.name);
  constructor(private readonly database: DatabaseService, private readonly files: FilesService, private readonly registry: JobRegistry,
    private readonly jobs: JobsService, private readonly runner: TenantJobRunner) {}

  onModuleInit() {
    // Export files: only the employee the export belongs to may read them, only while READY and not expired. Nobody can
    // add or remove files through the generic files API ("read" never grants write).
    this.files.registerPolicy("privacy_export", async (identity, id, client) => {
      const row = (await client.query(`SELECT employee_id, status, expires_at FROM privacy_exports WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, id])).rows[0];
      return row && row.employee_id === identity.employeeId && row.status === "READY" && new Date(row.expires_at).getTime() > Date.now() ? "read" : null;
    });
    this.registry.register(EXPORT_JOB, (payload) => this.runExport(payload), undefined,
      { description: "Builds one employee's “Download my data” export (JSON + CSV) and notifies them when it is ready.", timeoutMs: 5 * 60_000 });
  }

  // ------------------------------------------------------------------ my data & privacy

  async overview(identity: AuthIdentity) {
    if (!identity.employeeId) throw new ForbiddenException("Open a brand to see your privacy settings.");
    const notice = (await this.database.systemQuery(
      `SELECT p.id, p.version, p.title, p.summary, p.body, p.published_at AS "publishedAt", a.acknowledged_at AS "acknowledgedAt"
         FROM compliance_policies p LEFT JOIN policy_acknowledgements a ON a.policy_id=p.id AND a.user_id=$1
        WHERE p.key='employee-privacy-notice' AND p.status='PUBLISHED' ORDER BY p.version DESC LIMIT 1`, [identity.userId])).rows[0] || null;
    return this.database.tenantTransaction(identity, async (client) => {
      const org = (await client.query(`SELECT name, coalesce(display_name,name) AS "displayName", legal_name AS "legalName" FROM organizations WHERE id=$1`, [identity.organizationId])).rows[0];
      const settings = await loadPrivacySettings(client, identity.organizationId);
      const years = normalizeRetention(settings.retention);
      const selfieDays = (await client.query(`SELECT selfie_retention_days FROM attendance_policies WHERE organization_id=$1`, [identity.organizationId])).rows[0]?.selfie_retention_days ?? null;
      const exports = await this.listExports(client, identity);
      const requests = (await client.query(
        `SELECT id, case_number AS "caseNumber", category, title, status, created_at AS "createdAt", due_at AS "dueAt", closed_at AS "closedAt"
           FROM hr_cases WHERE organization_id=$1 AND module='privacy_request' AND requester_id=$2 ORDER BY created_at DESC LIMIT 20`,
        [identity.organizationId, identity.employeeId])).rows;
      return {
        brand: { name: org?.displayName || org?.name, legalName: org?.legalName || org?.name },
        grievance: { name: settings.grievance_name, email: settings.grievance_email, phone: settings.grievance_phone, address: settings.grievance_address },
        dpo: settings.significant_fiduciary ? { name: settings.dpo_name, email: settings.dpo_email, phone: settings.dpo_phone } : null,
        notice, exports, requests,
        retention: RETENTION_CATEGORIES.map((key) => ({ key, years: years[key], ...CATEGORY_INFO[key] })),
        selfieRetentionDays: selfieDays,
        exportTtlDays: EXPORT_TTL_DAYS,
      };
    });
  }

  private async listExports(client: PoolClient, identity: AuthIdentity) {
    const rows = (await client.query(
      `SELECT x.id, x.status, x.summary, x.error, x.created_at AS "createdAt", x.completed_at AS "completedAt", x.expires_at AS "expiresAt",
              coalesce((SELECT json_agg(json_build_object('id', f.id, 'name', f.original_name, 'mimeType', f.mime_type, 'byteSize', f.byte_size) ORDER BY f.original_name)
                          FROM stored_files f WHERE f.organization_id=x.organization_id AND f.entity_type='privacy_export' AND f.entity_id=x.id AND f.deleted_at IS NULL), '[]') AS files
         FROM privacy_exports x WHERE x.organization_id=$1 AND x.employee_id=$2 ORDER BY x.created_at DESC LIMIT 10`,
      [identity.organizationId, identity.employeeId])).rows;
    const now = Date.now();
    return rows.map((row) => {
      const live = row.status === "READY" && row.expiresAt && new Date(row.expiresAt).getTime() > now;
      return { ...row, status: row.status === "READY" && !live ? "EXPIRED" : row.status, files: live ? row.files : [] };
    });
  }

  async requestExport(identity: AuthIdentity) {
    if (!identity.employeeId) throw new ForbiddenException("Open a brand to download your data.");
    const created = await this.database.tenantTransaction(identity, async (client) => {
      // One export at a time per person; serialise concurrent clicks.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('privacy_export:' || $1))`, [identity.employeeId]);
      const busy = (await client.query(`SELECT id FROM privacy_exports WHERE organization_id=$1 AND employee_id=$2 AND status IN ('QUEUED','RUNNING') AND created_at > now() - interval '1 hour'`,
        [identity.organizationId, identity.employeeId])).rows[0];
      if (busy) throw new ConflictException("Your previous export is still being prepared. You'll get a notification when it is ready.");
      const today = Number((await client.query(`SELECT count(*) FROM privacy_exports WHERE organization_id=$1 AND employee_id=$2 AND created_at > now() - interval '24 hours'`,
        [identity.organizationId, identity.employeeId])).rows[0].count);
      if (today >= MAX_EXPORTS_PER_DAY) throw new BadRequestException(`You can request up to ${MAX_EXPORTS_PER_DAY} exports a day. Please use the latest one.`);
      const row = (await client.query(`INSERT INTO privacy_exports(organization_id,employee_id,requested_by) VALUES($1,$2,$3) RETURNING id, status, created_at AS "createdAt"`,
        [identity.organizationId, identity.employeeId, identity.userId])).rows[0];
      await audit(client, identity.organizationId, identity.userId, "PRIVACY_EXPORT_REQUESTED", "employee", identity.employeeId, { exportId: row.id });
      return row;
    });
    const queued = await this.jobs.enqueue(EXPORT_JOB, { organizationId: identity.organizationId, exportId: created.id }, { attempts: 2 });
    // Development without Redis: build it right away so the feature still works.
    if (!queued.queued) await this.runExport({ organizationId: identity.organizationId, exportId: created.id });
    return created;
  }

  async exportStatus(identity: AuthIdentity, id: string) {
    if (!UUID.test(id)) throw new NotFoundException("Export not found.");
    return this.database.tenantTransaction(identity, async (client) => {
      const found = (await this.listExports(client, identity)).find((row) => row.id === id);
      if (!found) throw new NotFoundException("Export not found.");
      return found;
    });
  }

  /** Worker: builds and stores the export. Never throws for data problems (the row records FAILED); the employee can retry. */
  async runExport(payload: Record<string, unknown>) {
    const organizationId = String(payload.organizationId || ""), exportId = String(payload.exportId || "");
    if (!UUID.test(organizationId) || !UUID.test(exportId)) throw new Error("privacy.employee_export: invalid payload.");
    const systemUser = await this.runner.systemUserId();
    const system: AuthIdentity = { organizationId, userId: systemUser, employeeId: "", roles: ["SYSTEM"] };
    const claimed = await this.database.tenantTransaction(system, async (client) => {
      const row = (await client.query(`UPDATE privacy_exports SET status='RUNNING' WHERE organization_id=$1 AND id=$2 AND status='QUEUED' RETURNING employee_id, requested_by`,
        [organizationId, exportId])).rows[0];
      return row as { employee_id: string; requested_by: string } | undefined;
    });
    if (!claimed) return { skipped: true };
    const written: { key: string; driver: StorageDriverName }[] = [];
    try {
      const summary = await this.database.tenantTransaction(system, async (client) => {
        const built = await this.buildEmployeeExport(client, organizationId, claimed.employee_id, claimed.requested_by);
        const driver = activeDriver();
        const storage = storageFor(driver);
        const outputs: { name: string; mime: string; ext: string; body: string }[] = [
          { name: "my-data.json", mime: "application/json", ext: "json", body: toJson(built.document) },
          ...Object.entries(built.tables).filter(([, rows]) => rows.length).map(([name, rows]) => ({ name: `${name}.csv`, mime: "text/csv", ext: "csv", body: toCsv(rows) })),
        ];
        for (const output of outputs) {
          const bytes = Buffer.from(output.body, "utf8");
          const fileId = randomUUID();
          const at = new Date();
          const key = objectKey({ organizationId, entityType: "privacy_export", category: "PRIVACY_EXPORT", fileId, ext: output.ext, at });
          const sha256 = sha256Hex(bytes);
          await storage.put(key, bytes, { contentType: output.mime, sha256, organizationId, fileId });
          written.push({ key, driver });
          await client.query(
            `INSERT INTO stored_files(id,organization_id,entity_type,entity_id,category,original_name,mime_type,byte_size,sha256,storage_key,storage_driver,uploaded_by,created_at)
             VALUES($1,$2,'privacy_export',$3,'PRIVACY_EXPORT',$4,$5,$6,$7,$8,$9,$10,$11)`,
            [fileId, organizationId, exportId, output.name, output.mime, bytes.length, sha256, key, driver, claimed.employee_id, at]);
        }
        await client.query(`UPDATE privacy_exports SET status='READY', summary=$3, completed_at=now(), expires_at=now() + make_interval(days => $4), error=NULL WHERE organization_id=$1 AND id=$2`,
          [organizationId, exportId, JSON.stringify(built.summary), EXPORT_TTL_DAYS]);
        await client.query(`INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload) VALUES($1,$2,'PRIVACY_EXPORT_READY','privacy_export',$3,$4)`,
          [organizationId, claimed.employee_id, exportId, JSON.stringify({ message: `Your data export is ready to download for ${EXPORT_TTL_DAYS} days`, href: "/my-space/privacy", automated: true })]);
        await audit(client, organizationId, systemUser, "PRIVACY_EXPORT_READY", "employee", claimed.employee_id, { exportId, files: outputs.length, sections: built.summary });
        return built.summary;
      });
      return { ready: true, sections: Object.keys(summary).length };
    } catch (error) {
      for (const item of written) await storageFor(item.driver).delete(item.key).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Export ${exportId} failed: ${message}`);
      await this.database.tenantTransaction(system, (client) => client.query(
        `UPDATE privacy_exports SET status='FAILED', error=$3, completed_at=now() WHERE organization_id=$1 AND id=$2`,
        [organizationId, exportId, "The export could not be prepared. Please try again, or contact HR if it keeps failing."]));
      return { ready: false };
    }
  }

  /** Everything held about one employee in one brand. Encrypted identifiers are decrypted — this goes only to the employee. */
  async buildEmployeeExport(client: PoolClient, organizationId: string, employeeId: string, userId: string) {
    const q = async (sql: string, values: unknown[] = [organizationId, employeeId]) => (await client.query(sql, values)).rows;
    const omitted = new Set<string>();
    const org = (await q(`SELECT coalesce(display_name,name) AS name, legal_name AS "legalName" FROM organizations WHERE id=$1`, [organizationId]))[0];
    const profile = (await q(
      `SELECT e.employee_number AS "employeeNumber", e.full_name AS "fullName", e.work_email AS "workEmail", e.department, e.designation, e.location,
              to_char(e.joining_date,'YYYY-MM-DD') AS "joiningDate", e.status, e.created_at AS "createdAt", m.full_name AS manager
         FROM employees e LEFT JOIN employees m ON m.id=e.manager_id AND m.organization_id=e.organization_id WHERE e.organization_id=$1 AND e.id=$2`))[0];
    if (!profile) throw new Error("Employee not found.");
    const account = (await q(`SELECT email, full_name AS "fullName", created_at AS "createdAt", last_sign_in_at AS "lastSignInAt" FROM users WHERE id=$1`, [userId]))[0] || null;
    const payrollRow = (await q(`SELECT * FROM payroll_profiles WHERE organization_id=$1 AND employee_id=$2`))[0];
    const payrollProfile = payrollRow ? (() => {
      const clean = cleanRow("payroll_profiles", payrollRow, organizationId, omitted);
      delete clean.organization_id; delete clean.employee_id;
      for (const key of Object.keys(clean)) if (key.endsWith("_last4")) delete clean[key];
      return clean;
    })() : null;
    const attendance = await q(
      `SELECT a.occurred_at AS "occurredAt", a.event_type AS "eventType", a.source, a.timezone, a.latitude, a.longitude, a.accuracy_metres AS "accuracyMetres",
              a.within_geofence AS "withinGeofence", a.distance_metres AS "distanceMetres", s.name AS site, a.note, a.review_status AS "reviewStatus",
              host(a.client_ip) AS "ipAddress", a.wifi_bssid AS "wifi", a.selfie_file_id AS "selfieFileId"
         FROM attendance_events a LEFT JOIN attendance_sites s ON s.id=a.site_id AND s.organization_id=a.organization_id
        WHERE a.organization_id=$1 AND a.employee_id=$2 ORDER BY a.occurred_at`);
    const selfies = await q(
      `SELECT f.id, f.original_name AS name, f.byte_size AS "byteSize", f.created_at AS "takenAt", f.deleted_at AS "deletedAt"
         FROM stored_files f JOIN attendance_events a ON a.selfie_file_id=f.id AND a.organization_id=f.organization_id
        WHERE f.organization_id=$1 AND a.employee_id=$2 ORDER BY f.created_at`);
    const regularizations = await q(
      `SELECT to_char(attendance_date,'YYYY-MM-DD') AS date, expected_in AS "expectedIn", expected_out AS "expectedOut", reason, note, status, decision_note AS "decisionNote", submitted_at AS "submittedAt"
         FROM attendance_regularizations WHERE organization_id=$1 AND employee_id=$2 ORDER BY attendance_date`);
    const leave = await q(
      `SELECT t.name AS "leaveType", to_char(l.start_date,'YYYY-MM-DD') AS "startDate", to_char(l.end_date,'YYYY-MM-DD') AS "endDate", l.days, l.reason, l.status,
              l.decision_note AS "decisionNote", l.submitted_at AS "submittedAt", l.decided_at AS "decidedAt"
         FROM leave_requests l LEFT JOIN leave_types t ON t.id=l.leave_type_id AND t.organization_id=l.organization_id
        WHERE l.organization_id=$1 AND l.employee_id=$2 ORDER BY l.start_date`);
    const payslips = await q(
      `SELECT period, gross, deductions, net, currency, status, published_at AS "publishedAt" FROM payslips WHERE organization_id=$1 AND employee_id=$2 ORDER BY period`);
    const taxDeclarations = await q(
      `SELECT tax_year AS "taxYear", regime, status, items, inputs, calculation, submitted_at AS "submittedAt", review_action AS "reviewAction",
              review_reason AS "reviewReason", reviewed_at AS "reviewedAt" FROM tax_declarations WHERE organization_id=$1 AND employee_id=$2 ORDER BY tax_year`);
    const cases = await q(
      `SELECT case_number AS "caseNumber", module, category, title, status, priority, amount, to_char(start_date,'YYYY-MM-DD') AS "startDate",
              to_char(end_date,'YYYY-MM-DD') AS "endDate", details, created_at AS "createdAt", closed_at AS "closedAt"
         FROM hr_cases WHERE organization_id=$1 AND requester_id=$2 ORDER BY created_at`);
    const onboarding = (await q(`SELECT * FROM onboarding_joiners WHERE organization_id=$1 AND employee_id=$2`)).map((row) => {
      const clean = cleanRow("onboarding_joiners", row, organizationId, omitted);
      for (const key of ["organization_id", "pan_last4", "template_id", "created_by", "version"]) delete clean[key];
      return clean;
    });
    const documents = await q(
      `SELECT f.original_name AS name, f.category, f.entity_type AS "recordType", f.mime_type AS "mimeType", f.byte_size AS "byteSize", f.created_at AS "uploadedAt"
         FROM stored_files f
        WHERE f.organization_id=$1 AND f.deleted_at IS NULL AND f.entity_type NOT IN ('privacy_export','attendance_event') AND (
              f.uploaded_by=$2
           OR (f.entity_type='onboarding_joiner' AND f.entity_id IN (SELECT id FROM onboarding_joiners WHERE organization_id=$1 AND employee_id=$2))
           OR (f.entity_type='hr_case' AND f.entity_id IN (SELECT id FROM hr_cases WHERE organization_id=$1 AND requester_id=$2))
           OR (f.entity_type='tax_declaration' AND f.entity_id IN (SELECT id FROM tax_declarations WHERE organization_id=$1 AND employee_id=$2)))
        ORDER BY f.created_at`);
    // Who opened or changed my records (other people and automations), summarised. Reads of PII are audited in payroll,
    // files and onboarding (PII_READ, PII_REVEALED, *_DOWNLOADED, *_VIEWED).
    const accessLog = await q(
      `WITH mine(t, id) AS (
         SELECT 'employee', $2::uuid
         UNION ALL SELECT 'payslip', id FROM payslips WHERE organization_id=$1 AND employee_id=$2
         UNION ALL SELECT 'attendance_event', id FROM attendance_events WHERE organization_id=$1 AND employee_id=$2
         UNION ALL SELECT 'onboarding_joiner', id FROM onboarding_joiners WHERE organization_id=$1 AND employee_id=$2
         UNION ALL SELECT 'tax_declaration', id FROM tax_declarations WHERE organization_id=$1 AND employee_id=$2
         UNION ALL SELECT 'hr_case', id FROM hr_cases WHERE organization_id=$1 AND requester_id=$2)
       SELECT coalesce(u.full_name, 'Unknown user') AS "who", a.action, a.entity_type AS "record",
              CASE WHEN a.action ~ '(READ|REVEAL|DOWNLOAD|VIEW|EXPORT)' THEN 'viewed' ELSE 'changed' END AS kind,
              count(*)::int AS times, min(a.created_at) AS first, max(a.created_at) AS last
         FROM audit_log a JOIN mine m ON m.t=a.entity_type AND m.id=a.entity_id
         LEFT JOIN users u ON u.id=a.actor_user_id
        WHERE a.organization_id=$1 AND a.actor_user_id <> $3
        GROUP BY 1,2,3,4 ORDER BY max(a.created_at) DESC LIMIT 1000`, [organizationId, employeeId, userId]);
    // Every other table that links rows to this employee (salary structures, leave balances, payroll lines, learning,
    // surveys invitations, devices…) — discovered from the schema so new modules are included automatically.
    const other: Record<string, unknown[]> = {};
    const tables = (await q(
      `SELECT c.table_name AS name FROM information_schema.columns c
        WHERE c.table_schema='public' AND c.column_name='employee_id'
          AND EXISTS (SELECT 1 FROM information_schema.columns o WHERE o.table_schema='public' AND o.table_name=c.table_name AND o.column_name='organization_id')
        ORDER BY 1`, [])).map((row) => row.name as string);
    for (const table of tables) {
      if (CURATED.has(table) || !SAFE_IDENT.test(table)) continue;
      await client.query("SAVEPOINT export_table");
      try {
        const rows = (await client.query(`SELECT * FROM "${table}" WHERE organization_id=$1 AND employee_id=$2 LIMIT 5000`, [organizationId, employeeId])).rows;
        await client.query("RELEASE SAVEPOINT export_table");
        if (rows.length) other[table] = rows.map((row) => { const clean = cleanRow(table, row, organizationId, omitted); delete clean.organization_id; return clean; });
      } catch {
        // A table the runtime role may not read: skip it rather than fail the whole export.
        await client.query("ROLLBACK TO SAVEPOINT export_table");
      }
    }
    const sections = { profile, account, payrollProfile, attendance, selfies, regularizations, leave, payslips, taxDeclarations, cases, onboarding, documents, accessLog, other };
    const summary: Record<string, number> = {};
    for (const [key, value] of Object.entries(sections)) summary[key] = Array.isArray(value) ? value.length : value && typeof value === "object" ? (key === "other" ? Object.keys(value).length : 1) : 0;
    const document = {
      format: "northstar.privacy-export/v1",
      generatedAt: new Date().toISOString(),
      dataFiduciary: org?.legalName || org?.name,
      dataProcessor: "ClanChief platform operator (processes this data on your employer's behalf)",
      about: `${profile.fullName} (${profile.employeeNumber})`,
      notes: [
        "This is a copy of the personal data your employer holds about you in this workspace, provided under section 11 of the Digital Personal Data Protection Act, 2023.",
        "PAN, UAN, ESI and bank account numbers are stored encrypted and have been decrypted for you only. Keep this file safe and delete it when you no longer need it.",
        "Punch selfies and uploaded documents are listed by name; download them from the app or ask HR for copies.",
        "accessLog summarises who opened or changed your records (from the tamper-evident audit trail).",
        "To correct or erase anything, raise a privacy request from My space → My data & privacy.",
      ],
      omittedColumns: [...omitted].sort(),
      sections,
    };
    const tablesForCsv: Record<string, Record<string, unknown>[]> = {
      attendance: attendance.map(({ selfieFileId, ...row }) => ({ ...row, selfie: selfieFileId ? "yes" : "" })),
      leave, payslips, regularizations,
      cases: cases.map(({ details, ...row }) => row),
      "access-log": accessLog,
    };
    return { document, tables: tablesForCsv, summary };
  }

  /** Nightly (from the retention job): removes expired export files — bytes and rows — and marks the export EXPIRED. */
  async purgeExpiredExports(ctx: TenantJobContext): Promise<Counters> {
    const expired = (await ctx.client.query(
      `SELECT id, employee_id FROM privacy_exports WHERE organization_id=$1 AND purged_at IS NULL AND (expires_at < now() OR (status='FAILED' AND created_at < now() - interval '7 days')) LIMIT 200`,
      [ctx.organization.id])).rows;
    let files = 0;
    for (const row of expired) {
      const stored = (await ctx.client.query(`SELECT id, storage_key, storage_driver FROM stored_files WHERE organization_id=$1 AND entity_type='privacy_export' AND entity_id=$2`,
        [ctx.organization.id, row.id])).rows;
      for (const file of stored) {
        if (file.storage_key && keyBelongsTo(file.storage_key, ctx.organization.id))
          await storageFor((file.storage_driver || "local") as StorageDriverName).delete(file.storage_key);
        await ctx.client.query(`DELETE FROM stored_files WHERE organization_id=$1 AND id=$2`, [ctx.organization.id, file.id]);
        files += 1;
      }
      await ctx.client.query(`UPDATE privacy_exports SET status=CASE WHEN status='FAILED' THEN status ELSE 'EXPIRED' END, purged_at=now() WHERE organization_id=$1 AND id=$2`, [ctx.organization.id, row.id]);
      await ctx.audit("PRIVACY_EXPORT_PURGED", "employee", row.employee_id, { exportId: row.id, files });
    }
    return { exportsPurged: expired.length, exportFilesDeleted: files };
  }

  // ------------------------------------------------------------------ brand settings (HR / owner)

  async settings(identity: AuthIdentity) {
    if (!isHr(identity)) throw new ForbiddenException("Only HR and the brand owner can manage privacy settings.");
    return this.database.tenantTransaction(identity, async (client) => {
      const row = await loadPrivacySettings(client, identity.organizationId);
      const selfieDays = (await client.query(`SELECT selfie_retention_days FROM attendance_policies WHERE organization_id=$1`, [identity.organizationId])).rows[0]?.selfie_retention_days ?? null;
      const updatedBy = row.updated_by ? (await client.query(`SELECT full_name FROM users WHERE id=$1`, [row.updated_by])).rows[0]?.full_name : null;
      return {
        grievanceName: row.grievance_name, grievanceEmail: row.grievance_email, grievancePhone: row.grievance_phone, grievanceAddress: row.grievance_address,
        significantFiduciary: row.significant_fiduciary, dpoName: row.dpo_name, dpoEmail: row.dpo_email, dpoPhone: row.dpo_phone,
        retention: normalizeRetention(row.retention), autoErase: row.auto_erase, version: row.version, updatedAt: row.updated_at, updatedBy,
        defaults: DEFAULT_RETENTION, limits: RETENTION_LIMITS, categories: RETENTION_CATEGORIES.map((key) => ({ key, ...CATEGORY_INFO[key] })),
        selfieRetentionDays: selfieDays,
        canEdit: true,
      };
    });
  }

  async updateSettings(identity: AuthIdentity, input: UpdatePrivacySettingsDto) {
    if (!isHr(identity)) throw new ForbiddenException("Only HR and the brand owner can manage privacy settings.");
    if (input.retention) { const problems = retentionProblems(input.retention); if (problems.length) throw new BadRequestException(problems); }
    if (input.autoErase && !identity.roles.includes("OWNER")) throw new ForbiddenException("Only the brand owner can switch on automatic erasure.");
    await this.database.tenantTransaction(identity, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('privacy_settings:' || $1))`, [identity.organizationId]);
      const before = await loadPrivacySettings(client, identity.organizationId);
      if (input.version !== before.version)
        throw new ConflictException("These settings changed since you opened them. Reload and try again.");
      const text = (value: string | undefined, current: string | null) => (value === undefined ? current : value.trim() || null);
      const next = {
        grievance_name: text(input.grievanceName, before.grievance_name), grievance_email: text(input.grievanceEmail, before.grievance_email),
        grievance_phone: text(input.grievancePhone, before.grievance_phone), grievance_address: text(input.grievanceAddress, before.grievance_address),
        significant_fiduciary: input.significantFiduciary ?? before.significant_fiduciary,
        dpo_name: text(input.dpoName, before.dpo_name), dpo_email: text(input.dpoEmail, before.dpo_email), dpo_phone: text(input.dpoPhone, before.dpo_phone),
        retention: input.retention ? normalizeRetention({ ...normalizeRetention(before.retention), ...input.retention }) : normalizeRetention(before.retention),
        auto_erase: input.autoErase ?? before.auto_erase,
      };
      if (next.significant_fiduciary && !(next.dpo_name && next.dpo_email))
        throw new BadRequestException("A Significant Data Fiduciary must name a Data Protection Officer (name and email).");
      await client.query(
        `INSERT INTO privacy_settings(organization_id,grievance_name,grievance_email,grievance_phone,grievance_address,significant_fiduciary,dpo_name,dpo_email,dpo_phone,retention,auto_erase,version,updated_by,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,now())
         ON CONFLICT (organization_id) DO UPDATE SET grievance_name=$2,grievance_email=$3,grievance_phone=$4,grievance_address=$5,significant_fiduciary=$6,dpo_name=$7,
           dpo_email=$8,dpo_phone=$9,retention=$10,auto_erase=$11,version=privacy_settings.version+1,updated_by=$12,updated_at=now()`,
        [identity.organizationId, next.grievance_name, next.grievance_email, next.grievance_phone, next.grievance_address, next.significant_fiduciary,
          next.dpo_name, next.dpo_email, next.dpo_phone, JSON.stringify(next.retention), next.auto_erase, identity.userId]);
      const strip = (row: Record<string, unknown>) => { const { version, updated_at, updated_by, organization_id, ...rest } = row as Record<string, unknown>; return rest; };
      await audit(client, identity.organizationId, identity.userId, "PRIVACY_SETTINGS_UPDATED", "organization", identity.organizationId, strip(next), strip(before as unknown as Record<string, unknown>));
    });
    return this.settings(identity);
  }
}


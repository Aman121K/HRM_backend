import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { JobRegistry } from "../jobs/job-registry";
import { DEFAULT_TIMEZONE } from "../jobs/scheduling";
import { TenantJobRunner, type Counters, type TenantJobContext } from "../jobs/tenant-runner";
import { audit, isHr, loadPrivacySettings, PrivacyService } from "./privacy.service";
import { CATEGORY_INFO, normalizeRetention, planSubject, RETENTION_CATEGORIES, type RetentionCategory, type RetentionYears } from "./retention";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RETENTION_JOB = "privacy.retention";
const ERASED = "[erased]";

type Subject = { id: string; user_id: string | null; status: string; exited_on: string | null; legal_hold: boolean; legal_hold_reason: string | null; erased: Record<string, string>; anonymised_at: string | null };
type Ctx = { client: PoolClient; org: string; employee: Subject; actor: string };
type CategoryImpl = { count(ctx: Ctx): Promise<Record<string, number>>; erase(ctx: Ctx): Promise<Record<string, number>> };
export type ReportSubject = {
  employeeId: string; exitedOn: string | null; status: string; legalHold: boolean; blocked?: string;
  due: { category: RetentionCategory; dueOn: string; counts: Record<string, number> }[];
  later: { category: RetentionCategory; dueOn: string }[];
  anonymise: boolean;
};
export type Report = { generatedAt: string; today: string; retention: RetentionYears; subjects: ReportSubject[]; totals: { people: number; due: number; onHold: number } };

/** A punch still carrying location or device detail. */
const PUNCH_DETAIL = `(client_ip IS NOT NULL OR wifi_bssid IS NOT NULL OR device_id IS NOT NULL OR note IS NOT NULL OR face_check IS NOT NULL OR latitude IS NOT NULL)`;
const n = (result: { rowCount: number | null }) => result.rowCount || 0;
const one = async (client: PoolClient, sql: string, values: unknown[]) => Number((await client.query(sql, values)).rows[0]?.count || 0);
const tableExists = async (client: PoolClient, table: string) => !!(await client.query(`SELECT to_regclass($1) AS t`, [`public.${table}`])).rows[0]?.t;

/** Files of one person in one category, by record type. Soft-deleted here; the files housekeeping job removes the bytes. */
const FILE_SCOPE: Record<"documents" | "payrollTax", string> = {
  documents: `(f.entity_type='onboarding_joiner' AND f.entity_id IN (SELECT id FROM onboarding_joiners WHERE organization_id=$1 AND employee_id=$2))
           OR (f.entity_type='attendance_event' AND f.entity_id IN (SELECT id FROM attendance_events WHERE organization_id=$1 AND employee_id=$2))
           OR (f.entity_type='hr_case' AND f.entity_id IN (SELECT id FROM hr_cases WHERE organization_id=$1 AND requester_id=$2 AND module NOT IN ('expenses','privacy_request')))
           OR (f.entity_type='privacy_export' AND f.entity_id IN (SELECT id FROM privacy_exports WHERE organization_id=$1 AND employee_id=$2))`,
  payrollTax: `(f.entity_type='tax_declaration' AND f.entity_id IN (SELECT id FROM tax_declarations WHERE organization_id=$1 AND employee_id=$2))
           OR (f.entity_type='receipt_scan' AND f.uploaded_by=$2)
           OR (f.entity_type='hr_case' AND f.entity_id IN (SELECT id FROM hr_cases WHERE organization_id=$1 AND requester_id=$2 AND module='expenses'))`,
};
const countFiles = (ctx: Ctx, scope: string) => one(ctx.client, `SELECT count(*) FROM stored_files f WHERE f.organization_id=$1 AND f.deleted_at IS NULL AND (${scope})`, [ctx.org, ctx.employee.id]);
const dropFiles = async (ctx: Ctx, scope: string) => n(await ctx.client.query(
  `UPDATE stored_files f SET deleted_at=now() WHERE f.organization_id=$1 AND f.deleted_at IS NULL AND (${scope})`, [ctx.org, ctx.employee.id]));

/**
 * What each retention category removes. Personal identifiers are overwritten or nulled (irreversible: no copy is kept,
 * encrypted columns are nulled so even the key can't recover them). Statutory amounts (payslips, payroll lines) stay but
 * become anonymous once the employee row itself is anonymised.
 */
const CATEGORIES: Record<RetentionCategory, CategoryImpl> = {
  documents: {
    count: async (ctx) => ({
      files: await countFiles(ctx, FILE_SCOPE.documents),
      joinerRecords: await one(ctx.client, `SELECT count(*) FROM onboarding_joiners WHERE organization_id=$1 AND employee_id=$2 AND full_name<>$3`, [ctx.org, ctx.employee.id, ERASED]),
    }),
    erase: async (ctx) => ({
      files: await dropFiles(ctx, FILE_SCOPE.documents),
      joinerRecords: n(await ctx.client.query(
        `UPDATE onboarding_joiners SET full_name=$3, personal_email='erased-' || id || '@erased.invalid', phone=NULL, pan_enc=NULL, pan_hash=NULL, pan_last4=NULL,
                aadhaar_last4=NULL, notes=NULL, withdrawn_reason=NULL, updated_at=now()
          WHERE organization_id=$1 AND employee_id=$2 AND full_name<>$3`, [ctx.org, ctx.employee.id, ERASED])),
    }),
  },
  attendanceDetail: {
    count: async (ctx) => ({
      punches: await one(ctx.client, `SELECT count(*) FROM attendance_events WHERE organization_id=$1 AND employee_id=$2 AND ${PUNCH_DETAIL}`, [ctx.org, ctx.employee.id]),
    }),
    erase: async (ctx) => ({
      punches: n(await ctx.client.query(
        // Location is removed entirely; location_erased_at exempts the row from the "GPS required" rule (migration 038).
        `UPDATE attendance_events SET latitude=NULL, longitude=NULL, accuracy_metres=NULL, location_captured_at=NULL, location_erased_at=now(),
                distance_metres=NULL, client_ip=NULL, wifi_bssid=NULL, device_id=NULL, note=NULL, face_check=NULL, review_note=NULL
          WHERE organization_id=$1 AND employee_id=$2 AND ${PUNCH_DETAIL}`,
        [ctx.org, ctx.employee.id])),
    }),
  },
  contact: {
    count: async (ctx) => ({
      profileDetails: (await tableExists(ctx.client, "employee_master_details"))
        ? await one(ctx.client, `SELECT count(*) FROM employee_master_details WHERE organization_id=$1 AND employee_id=$2 AND (date_of_birth IS NOT NULL OR gender IS NOT NULL)`, [ctx.org, ctx.employee.id]) : 0,
      pushDevices: await one(ctx.client, `SELECT count(*) FROM push_devices WHERE organization_id=$1 AND employee_id=$2`, [ctx.org, ctx.employee.id]),
      signIn: ctx.employee.user_id ? 1 : 0,
    }),
    erase: async (ctx) => {
      const out: Record<string, number> = { profileDetails: 0, pushDevices: 0, signIn: 0 };
      if (await tableExists(ctx.client, "employee_master_details"))
        out.profileDetails = n(await ctx.client.query(`UPDATE employee_master_details SET date_of_birth=NULL, gender=NULL, updated_at=now() WHERE organization_id=$1 AND employee_id=$2
          AND (date_of_birth IS NOT NULL OR gender IS NOT NULL)`, [ctx.org, ctx.employee.id]));
      out.pushDevices = n(await ctx.client.query(`DELETE FROM push_devices WHERE organization_id=$1 AND employee_id=$2`, [ctx.org, ctx.employee.id]));
      await ctx.client.query(`DELETE FROM notification_preferences WHERE organization_id=$1 AND employee_id=$2`, [ctx.org, ctx.employee.id]);
      if (ctx.employee.user_id) {
        await ctx.client.query(`UPDATE employees SET user_id=NULL, updated_at=now() WHERE organization_id=$1 AND id=$2`, [ctx.org, ctx.employee.id]);
        out.signIn = 1;
      }
      return out;
    },
  },
  casesAndLeave: {
    count: async (ctx) => ({
      requests: await one(ctx.client, `SELECT count(*) FROM hr_cases WHERE organization_id=$1 AND requester_id=$2 AND module NOT IN ('expenses','privacy_request') AND title<>$3`, [ctx.org, ctx.employee.id, ERASED]),
      leaveReasons: await one(ctx.client, `SELECT count(*) FROM leave_requests WHERE organization_id=$1 AND employee_id=$2 AND reason<>$3`, [ctx.org, ctx.employee.id, ERASED]),
      corrections: await one(ctx.client, `SELECT count(*) FROM attendance_regularizations WHERE organization_id=$1 AND employee_id=$2 AND reason<>$3`, [ctx.org, ctx.employee.id, ERASED]),
    }),
    erase: async (ctx) => {
      const values = [ctx.org, ctx.employee.id, ERASED];
      await ctx.client.query(`UPDATE hr_case_events SET note=CASE WHEN note IS NULL THEN NULL ELSE $3 END, data='{}'::jsonb
         WHERE organization_id=$1 AND case_id IN (SELECT id FROM hr_cases WHERE organization_id=$1 AND requester_id=$2 AND module NOT IN ('expenses','privacy_request'))`, values);
      const requests = n(await ctx.client.query(`UPDATE hr_cases SET title=$3, details='{}'::jsonb, updated_at=now()
         WHERE organization_id=$1 AND requester_id=$2 AND module NOT IN ('expenses','privacy_request') AND title<>$3`, values));
      const leaveReasons = n(await ctx.client.query(`UPDATE leave_requests SET reason=$3, decision_note=NULL, updated_at=now() WHERE organization_id=$1 AND employee_id=$2 AND reason<>$3`, values));
      const corrections = n(await ctx.client.query(`UPDATE attendance_regularizations SET reason=$3, note=NULL, decision_note=NULL, evidence=NULL, updated_at=now()
         WHERE organization_id=$1 AND employee_id=$2 AND reason<>$3`, values));
      if (await tableExists(ctx.client, "leave_balance_ledger"))
        await ctx.client.query(`UPDATE leave_balance_ledger SET note=NULL WHERE organization_id=$1 AND employee_id=$2 AND note IS NOT NULL`, [ctx.org, ctx.employee.id]);
      return { requests, leaveReasons, corrections };
    },
  },
  payrollTax: {
    count: async (ctx) => ({
      identifiers: await one(ctx.client, `SELECT count(*) FROM payroll_profiles WHERE organization_id=$1 AND employee_id=$2
        AND (pan_enc IS NOT NULL OR uan_enc IS NOT NULL OR esi_number_enc IS NOT NULL OR bank_account_enc IS NOT NULL OR bank_name IS NOT NULL OR ifsc IS NOT NULL)`, [ctx.org, ctx.employee.id]),
      taxDeclarations: await one(ctx.client, `SELECT count(*) FROM tax_declarations WHERE organization_id=$1 AND employee_id=$2 AND items::text NOT IN ('[]','{}')`, [ctx.org, ctx.employee.id]),
      files: await countFiles(ctx, FILE_SCOPE.payrollTax),
      expenseClaims: await one(ctx.client, `SELECT count(*) FROM hr_cases WHERE organization_id=$1 AND requester_id=$2 AND module='expenses' AND title<>$3`, [ctx.org, ctx.employee.id, ERASED]),
    }),
    erase: async (ctx) => {
      const values = [ctx.org, ctx.employee.id];
      const identifiers = n(await ctx.client.query(
        `UPDATE payroll_profiles SET pan_enc=NULL, pan_hash=NULL, pan_last4=NULL, uan_enc=NULL, uan_hash=NULL, uan_last4=NULL, esi_number_enc=NULL, esi_number_hash=NULL,
                esi_number_last4=NULL, bank_account_enc=NULL, bank_account_hash=NULL, bank_account_last4=NULL, bank_name=NULL, ifsc=NULL, declarations='{}'::jsonb, updated_at=now()
          WHERE organization_id=$1 AND employee_id=$2`, values));
      const taxDeclarations = n(await ctx.client.query(
        `UPDATE tax_declarations SET items=CASE jsonb_typeof(items) WHEN 'array' THEN '[]'::jsonb ELSE '{}'::jsonb END,
                inputs=CASE jsonb_typeof(inputs) WHEN 'array' THEN '[]'::jsonb ELSE '{}'::jsonb END, review_reason=NULL, review_amounts=NULL, updated_at=now()
          WHERE organization_id=$1 AND employee_id=$2 AND items::text NOT IN ('[]','{}')`, values));
      if (await tableExists(ctx.client, "tax_documents")) {
        // Owned by the TDS module; guarded by a savepoint so a schema change there can't abort the whole erasure.
        await ctx.client.query("SAVEPOINT erase_tax_documents");
        try {
          await ctx.client.query(`UPDATE tax_documents SET data='{}'::jsonb WHERE organization_id=$1 AND employee_id=$2`, values);
          await ctx.client.query("RELEASE SAVEPOINT erase_tax_documents");
        } catch { await ctx.client.query("ROLLBACK TO SAVEPOINT erase_tax_documents"); }
      }
      const files = await dropFiles(ctx, FILE_SCOPE.payrollTax);
      await ctx.client.query(`UPDATE hr_case_events SET note=CASE WHEN note IS NULL THEN NULL ELSE $3 END, data='{}'::jsonb
         WHERE organization_id=$1 AND case_id IN (SELECT id FROM hr_cases WHERE organization_id=$1 AND requester_id=$2 AND module='expenses')`, [...values, ERASED]);
      const expenseClaims = n(await ctx.client.query(`UPDATE hr_cases SET title=$3, details='{}'::jsonb, updated_at=now()
         WHERE organization_id=$1 AND requester_id=$2 AND module='expenses' AND title<>$3`, [...values, ERASED]));
      await ctx.client.query(`UPDATE salary_structures SET notes=NULL WHERE organization_id=$1 AND employee_id=$2 AND notes IS NOT NULL`, values);
      return { identifiers, taxDeclarations, files, expenseClaims };
    },
  },
};

/**
 * Retention & erasure engine. Nightly per brand: finds exited employees past each category's retention period,
 * prepares a dry-run report for HR (or erases, when the brand owner switched on automatic erasure), and on execution
 * irreversibly removes identifiers and writes an erasure certificate to the audit chain. audit_log rows are never
 * changed (append-only, hash-chained). Approved erasure requests (privacy_request cases) run the same engine for one person.
 */
@Injectable()
export class ErasureService implements OnModuleInit {
  private readonly logger = new Logger(ErasureService.name);
  constructor(private readonly database: DatabaseService, private readonly registry: JobRegistry, private readonly runner: TenantJobRunner,
    private readonly privacy: PrivacyService) {}

  onModuleInit() {
    this.registry.register(RETENTION_JOB, (payload) => this.runner.forEachTenant(RETENTION_JOB, payload, (ctx) => this.nightly(ctx)), {
      cron: "0 2 * * *", tz: DEFAULT_TIMEZONE, tenantScoped: true, timeoutMs: 15 * 60_000,
      description: "DPDP retention: purges expired data exports, then prepares an erasure dry-run for exited employees past retention (erases only if the owner enabled automatic erasure).",
    });
  }

  // ------------------------------------------------------------------ planning

  /** Records the exit date the first time someone is seen as exited (exit case last day, else today); clears it on rehire. */
  private async syncExited(client: PoolClient, org: string) {
    await client.query(
      `INSERT INTO privacy_subject_state(organization_id, employee_id, exited_on)
       SELECT e.organization_id, e.id, coalesce(
                (SELECT max(c.end_date) FROM hr_cases c WHERE c.organization_id=e.organization_id AND c.module='exit' AND c.requester_id=e.id AND c.status='COMPLETED'),
                least(e.updated_at::date, CURRENT_DATE))
         FROM employees e WHERE e.organization_id=$1 AND e.status<>'ACTIVE'
       ON CONFLICT (organization_id, employee_id) DO UPDATE SET exited_on=coalesce(privacy_subject_state.exited_on, EXCLUDED.exited_on), updated_at=now()
         WHERE privacy_subject_state.exited_on IS NULL`, [org]);
    await client.query(`UPDATE privacy_subject_state s SET exited_on=NULL, updated_at=now() FROM employees e
       WHERE s.organization_id=$1 AND e.organization_id=s.organization_id AND e.id=s.employee_id AND e.status='ACTIVE' AND s.exited_on IS NOT NULL AND s.anonymised_at IS NULL`, [org]);
  }

  private async subjects(client: PoolClient, org: string, employeeId?: string): Promise<Subject[]> {
    const values: unknown[] = [org];
    let filter = `AND s.exited_on IS NOT NULL AND s.anonymised_at IS NULL`;
    if (employeeId) { values.push(employeeId); filter = `AND e.id=$2`; }
    return (await client.query(
      `SELECT e.id, e.user_id, e.status, to_char(s.exited_on,'YYYY-MM-DD') AS exited_on, coalesce(s.legal_hold,false) AS legal_hold, s.legal_hold_reason,
              coalesce(s.erased,'{}'::jsonb) AS erased, s.anonymised_at
         FROM employees e LEFT JOIN privacy_subject_state s ON s.organization_id=e.organization_id AND s.employee_id=e.id
        WHERE e.organization_id=$1 ${filter} ORDER BY s.exited_on, e.id`, values)).rows;
  }

  private async today(client: PoolClient, org: string) {
    const tz = (await client.query(`SELECT timezone FROM organizations WHERE id=$1`, [org])).rows[0]?.timezone || DEFAULT_TIMEZONE;
    return (await client.query(`SELECT to_char((now() AT TIME ZONE $1)::date,'YYYY-MM-DD') AS d`, [tz])).rows[0].d as string;
  }

  /** Builds the report (no names — those are resolved when HR reads it, so a stored report never outlives an erasure). */
  async buildReport(client: PoolClient, org: string, options: { employeeId?: string; request?: boolean } = {}): Promise<Report> {
    await this.syncExited(client, org);
    const settings = await loadPrivacySettings(client, org);
    const years = normalizeRetention(settings.retention);
    const today = await this.today(client, org);
    const subjects: ReportSubject[] = [];
    for (const subject of await this.subjects(client, org, options.employeeId)) {
      const base = { employeeId: subject.id, exitedOn: subject.exited_on, status: subject.status, legalHold: subject.legal_hold };
      if (subject.anonymised_at) { subjects.push({ ...base, blocked: "Already erased and anonymised.", due: [], later: [], anonymise: false }); continue; }
      if (!subject.exited_on || subject.status === "ACTIVE") {
        subjects.push({ ...base, blocked: "Employment is ongoing: data is needed for employment purposes (DPDP Act s.7(i)). Erase specific optional items manually or decline the request with reasons.", due: [], later: [], anonymise: false });
        continue;
      }
      const plan = planSubject({ exitedOn: subject.exited_on, today, years, alreadyErased: Object.keys(subject.erased || {}), request: options.request });
      const ctx: Ctx = { client, org, employee: subject, actor: "" };
      const due = [];
      for (const item of plan.due) due.push({ ...item, counts: await CATEGORIES[item.category].count(ctx) });
      subjects.push({ ...base, blocked: subject.legal_hold ? `Legal hold: ${subject.legal_hold_reason || "records must be kept"}` : undefined, due, later: plan.later, anonymise: plan.anonymise });
    }
    const actionable = subjects.filter((subject) => !subject.blocked && (subject.due.length || subject.anonymise));
    return { generatedAt: new Date().toISOString(), today, retention: years, subjects,
      totals: { people: actionable.length, due: actionable.reduce((sum, subject) => sum + subject.due.length, 0), onHold: subjects.filter((subject) => subject.legalHold).length } };
  }

  private async storeRun(client: PoolClient, org: string, mode: "DRY_RUN" | "EXECUTE", trigger: "SCHEDULE" | "MANUAL" | "REQUEST", report: unknown, actor: string, extra: { caseId?: string; employeeId?: string } = {}) {
    const json = JSON.stringify(report);
    const digest = createHash("sha256").update(json).digest("hex");
    return (await client.query(
      `INSERT INTO privacy_erasure_runs(organization_id,mode,trigger,case_id,employee_id,report,report_sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at AS "createdAt"`,
      [org, mode, trigger, extra.caseId || null, extra.employeeId || null, json, digest, actor])).rows[0] as { id: string; createdAt: string };
  }

  // ------------------------------------------------------------------ execution

  /** Erases the due categories for the given subjects (a subset of a report). Writes one certificate per person. */
  private async execute(client: PoolClient, org: string, actor: string, report: Report, meta: { runLabel: string; caseId?: string }) {
    const done: { employeeId: string; categories: Record<string, Record<string, number>>; anonymised: boolean; certificate: string }[] = [];
    for (const item of report.subjects) {
      if (item.blocked || (!item.due.length && !item.anonymise)) continue;
      const subject = (await this.subjects(client, org, item.employeeId))[0];
      if (!subject || subject.legal_hold || subject.anonymised_at || subject.status === "ACTIVE") continue;
      const ctx: Ctx = { client, org, employee: subject, actor };
      const categories: Record<string, Record<string, number>> = {};
      const erased = { ...(subject.erased || {}) };
      for (const due of item.due) {
        if (erased[due.category]) continue;
        categories[due.category] = await CATEGORIES[due.category].erase(ctx);
        erased[due.category] = new Date().toISOString();
      }
      const anonymise = RETENTION_CATEGORIES.every((category) => erased[category]);
      if (anonymise) {
        await client.query(
          `UPDATE employees SET full_name='Former employee ' || upper(substr(md5(id::text),1,6)), work_email='erased-' || id || '@erased.invalid',
                  employee_number='X' || upper(substr(md5(id::text || ':n'),1,9)), location=NULL, user_id=NULL, updated_at=now()
            WHERE organization_id=$1 AND id=$2`, [org, subject.id]);
      }
      await client.query(
        `INSERT INTO privacy_subject_state(organization_id, employee_id, erased, anonymised_at, updated_at) VALUES($1,$2,$3,$4,now())
         ON CONFLICT (organization_id, employee_id) DO UPDATE SET erased=$3, anonymised_at=coalesce(privacy_subject_state.anonymised_at,$4), updated_at=now()`,
        [org, subject.id, JSON.stringify(erased), anonymise ? new Date() : null]);
      if (subject.user_id && categories.contact)
        await client.query(`UPDATE privacy_subject_state SET pending_account_user=$3 WHERE organization_id=$1 AND employee_id=$2`, [org, subject.id, subject.user_id]);
      // Erasure certificate: what was removed, when, under which rule — and nothing about the person beyond their record id.
      const certificate = {
        certificate: "northstar.erasure-certificate/v1", run: meta.runLabel, caseId: meta.caseId || null, employeeId: subject.id, exitedOn: subject.exited_on,
        categories, basis: Object.fromEntries(Object.keys(categories).map((key) => [key, CATEGORY_INFO[key as RetentionCategory].basis])),
        anonymised: anonymise, keptUntilLater: item.later.map((later) => ({ category: later.category, dueOn: later.dueOn })), erasedAt: new Date().toISOString(),
      };
      const digest = createHash("sha256").update(JSON.stringify(certificate)).digest("hex");
      await audit(client, org, actor, "PRIVACY_ERASURE_CERTIFICATE", "employee", subject.id, { ...certificate, sha256: digest });
      done.push({ employeeId: subject.id, categories, anonymised: anonymise, certificate: digest });
    }
    return done;
  }

  /**
   * Detaches sign-in for erased people, after their erasure committed: removes the membership in this brand (platform
   * table, owner role) and anonymises the platform account only when the person has no other workspace or admin role.
   */
  async releaseAccounts(client: PoolClient, org: string) {
    const pending = (await client.query(`SELECT employee_id, pending_account_user AS user_id FROM privacy_subject_state WHERE organization_id=$1 AND pending_account_user IS NOT NULL`, [org])).rows;
    let accounts = 0;
    for (const row of pending) {
      await this.database.systemQuery(`DELETE FROM organization_memberships WHERE organization_id=$1 AND user_id=$2`, [org, row.user_id]);
      const result = await this.database.systemQuery(
        `UPDATE users SET email='erased-' || id || '@erased.invalid', full_name='Erased user', password_hash=NULL
          WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM organization_memberships WHERE user_id=$1)
            AND NOT EXISTS (SELECT 1 FROM employees WHERE user_id=$1) AND NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_id=$1)`, [row.user_id]).catch((error) => {
        this.logger.warn(`Account anonymisation skipped: ${(error as Error).message}`); return { rowCount: 0 };
      });
      accounts += result.rowCount || 0;
      await client.query(`UPDATE privacy_subject_state SET pending_account_user=NULL WHERE organization_id=$1 AND employee_id=$2`, [org, row.employee_id]);
    }
    return { membershipsRemoved: pending.length, accountsAnonymised: accounts };
  }

  private releaseAfterCommit(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, (client) => this.releaseAccounts(client, identity.organizationId))
      .catch((error) => this.logger.warn(`Account release deferred to the nightly run: ${(error as Error).message}`));
  }

  // ------------------------------------------------------------------ nightly job

  async nightly(ctx: TenantJobContext): Promise<Counters> {
    const purged = { ...(await this.privacy.purgeExpiredExports(ctx)), ...(await this.releaseAccounts(ctx.client, ctx.organization.id)) };
    const settings = await loadPrivacySettings(ctx.client, ctx.organization.id);
    const report = await this.buildReport(ctx.client, ctx.organization.id);
    if (!report.totals.people) return { ...purged, due: 0 };
    if (settings.auto_erase) {
      const run = await this.storeRun(ctx.client, ctx.organization.id, "EXECUTE", "SCHEDULE", report, ctx.identity.userId);
      const done = await this.execute(ctx.client, ctx.organization.id, ctx.identity.userId, report, { runLabel: run.id });
      await ctx.client.query(`UPDATE privacy_erasure_runs SET report = report || jsonb_build_object('executed', $2::jsonb) WHERE id=$1`, [run.id, JSON.stringify(done)]);
      return { ...purged, erasedPeople: done.length };
    }
    const run = await this.storeRun(ctx.client, ctx.organization.id, "DRY_RUN", "SCHEDULE", report, ctx.identity.userId);
    // Tell HR once a day that a report is waiting for review.
    if (await ctx.claim(`privacy.retention:${report.today}`, { entityId: run.id })) {
      const hr = (await ctx.client.query(
        `SELECT e.id FROM organization_memberships m JOIN employees e ON e.organization_id=m.organization_id AND e.user_id=m.user_id
          WHERE m.organization_id=$1 AND m.status='ACTIVE' AND m.role IN ('HR_ADMIN','OWNER') AND e.status='ACTIVE'`, [ctx.organization.id])).rows;
      for (const person of hr) await ctx.notify(person.id, "PRIVACY_RETENTION_REVIEW", "privacy_erasure_run", run.id,
        { message: `${report.totals.people} former employee(s) are past their retention period. Review the erasure report.`, href: "/my-space/privacy?tab=retention" });
    }
    return { ...purged, dueForReview: report.totals.people };
  }

  // ------------------------------------------------------------------ HR API

  private requireHr(identity: AuthIdentity) {
    if (!isHr(identity)) throw new ForbiddenException("Only HR and the brand owner can manage retention and erasure.");
  }

  /** Report with names resolved for HR. */
  private async present(client: PoolClient, org: string, report: Report & { executed?: unknown }) {
    const ids = report.subjects.map((subject) => subject.employeeId);
    const people = new Map((await client.query(`SELECT id, full_name, employee_number, designation FROM employees WHERE organization_id=$1 AND id = ANY($2::uuid[])`, [org, ids])).rows
      .map((row) => [row.id, row]));
    return {
      ...report,
      subjects: report.subjects.map((subject) => ({ ...subject, name: people.get(subject.employeeId)?.full_name || "—", employeeNumber: people.get(subject.employeeId)?.employee_number || "—",
        designation: people.get(subject.employeeId)?.designation || null,
        due: subject.due.map((due) => ({ ...due, label: CATEGORY_INFO[due.category].label })),
        later: subject.later.map((later) => ({ ...later, label: CATEGORY_INFO[later.category].label })) })),
    };
  }

  async runs(identity: AuthIdentity) {
    this.requireHr(identity);
    return this.database.tenantTransaction(identity, async (client) => ({
      items: (await client.query(
        `SELECT r.id, r.mode, r.trigger, r.case_id AS "caseId", r.created_at AS "createdAt", r.report_sha256 AS sha256, coalesce(u.full_name,'Automation') AS "by",
                (r.report->'totals') AS totals, jsonb_array_length(coalesce(r.report->'executed','[]'::jsonb)) AS executed
           FROM privacy_erasure_runs r LEFT JOIN users u ON u.id=r.created_by WHERE r.organization_id=$1 ORDER BY r.created_at DESC LIMIT 30`, [identity.organizationId])).rows,
    }));
  }

  async run(identity: AuthIdentity, id: string) {
    this.requireHr(identity);
    if (!UUID.test(id)) throw new NotFoundException("Report not found.");
    return this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(`SELECT id, mode, trigger, report, created_at AS "createdAt" FROM privacy_erasure_runs WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id])).rows[0];
      if (!row) throw new NotFoundException("Report not found.");
      return { id: row.id, mode: row.mode, trigger: row.trigger, createdAt: row.createdAt, report: await this.present(client, identity.organizationId, row.report) };
    });
  }

  /** HR: "Preview erasure" — builds and stores a dry-run report. Nothing is changed. */
  async dryRun(identity: AuthIdentity) {
    this.requireHr(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const report = await this.buildReport(client, identity.organizationId);
      const run = await this.storeRun(client, identity.organizationId, "DRY_RUN", "MANUAL", report, identity.userId);
      await audit(client, identity.organizationId, identity.userId, "PRIVACY_ERASURE_DRY_RUN", "privacy_erasure_run", run.id, { totals: report.totals });
      return { id: run.id, mode: "DRY_RUN", createdAt: run.createdAt, report: await this.present(client, identity.organizationId, report) };
    });
  }

  /** HR: erase exactly what a reviewed dry-run listed (re-checked now: holds, rehires and earlier erasures are respected). */
  async executeDryRun(identity: AuthIdentity, dryRunId: string) {
    this.requireHr(identity);
    const result = await this.database.tenantTransaction(identity, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('privacy_erasure:' || $1))`, [identity.organizationId]);
      const source = (await client.query(`SELECT report, created_at FROM privacy_erasure_runs WHERE organization_id=$1 AND id=$2 AND mode='DRY_RUN' AND case_id IS NULL`,
        [identity.organizationId, dryRunId])).rows[0];
      if (!source) throw new NotFoundException("Dry-run report not found.");
      if (Date.now() - new Date(source.created_at).getTime() > 7 * 86_400_000) throw new ConflictException("This report is more than 7 days old. Preview again before erasing.");
      const reviewed = source.report as Report;
      const fresh = await this.buildReport(client, identity.organizationId);
      // Intersection: only people and categories that were in the reviewed report AND are still due now.
      const subjects = fresh.subjects.map((subject) => {
        const before = reviewed.subjects.find((item) => item.employeeId === subject.employeeId);
        if (!before || before.blocked) return { ...subject, due: [], anonymise: false, blocked: subject.blocked || "Not in the reviewed report." };
        return { ...subject, due: subject.due.filter((due) => before.due.some((item) => item.category === due.category)) };
      });
      const report: Report = { ...fresh, subjects };
      const run = await this.storeRun(client, identity.organizationId, "EXECUTE", "MANUAL", report, identity.userId);
      const done = await this.execute(client, identity.organizationId, identity.userId, report, { runLabel: run.id });
      await client.query(`UPDATE privacy_erasure_runs SET report = report || jsonb_build_object('executed', $2::jsonb, 'fromDryRun', $3::text) WHERE id=$1`, [run.id, JSON.stringify(done), dryRunId]);
      await audit(client, identity.organizationId, identity.userId, "PRIVACY_ERASURE_EXECUTED", "privacy_erasure_run", run.id, { fromDryRun: dryRunId, people: done.length, certificates: done.map((item) => item.certificate) });
      return { id: run.id, erased: done.length, certificates: done };
    });
    await this.releaseAfterCommit(identity);
    return result;
  }

  async setLegalHold(identity: AuthIdentity, employeeId: string, hold: boolean, reason?: string) {
    this.requireHr(identity);
    if (!UUID.test(employeeId)) throw new NotFoundException("Employee not found.");
    return this.database.tenantTransaction(identity, async (client) => {
      const exists = (await client.query(`SELECT 1 FROM employees WHERE organization_id=$1 AND id=$2`, [identity.organizationId, employeeId])).rowCount;
      if (!exists) throw new NotFoundException("Employee not found.");
      await client.query(
        `INSERT INTO privacy_subject_state(organization_id, employee_id, legal_hold, legal_hold_reason, legal_hold_by, legal_hold_at) VALUES($1,$2,$3,$4,$5,now())
         ON CONFLICT (organization_id, employee_id) DO UPDATE SET legal_hold=$3, legal_hold_reason=$4, legal_hold_by=$5, legal_hold_at=now(), updated_at=now()`,
        [identity.organizationId, employeeId, hold, hold ? reason?.trim() : null, identity.userId]);
      await audit(client, identity.organizationId, identity.userId, hold ? "PRIVACY_LEGAL_HOLD_PLACED" : "PRIVACY_LEGAL_HOLD_RELEASED", "employee", employeeId, { reason: hold ? reason?.trim() : null });
      return { employeeId, legalHold: hold };
    });
  }

  /** Approved erasure requests (privacy_request cases), with any legal hold, for the HR erasure queue. */
  async erasureRequests(identity: AuthIdentity) {
    this.requireHr(identity);
    return this.database.tenantTransaction(identity, async (client) => ({
      items: (await client.query(
        `SELECT c.id, c.case_number AS "caseNumber", c.title, c.status, c.created_at AS "createdAt", c.due_at AS "dueAt", e.id AS "employeeId", e.full_name AS name,
                e.employee_number AS "employeeNumber", e.status AS "employeeStatus", coalesce(s.legal_hold,false) AS "legalHold", s.legal_hold_reason AS "legalHoldReason",
                (SELECT max(r.created_at) FROM privacy_erasure_runs r WHERE r.organization_id=c.organization_id AND r.case_id=c.id AND r.mode='DRY_RUN') AS "previewedAt"
           FROM hr_cases c JOIN employees e ON e.id=c.requester_id AND e.organization_id=c.organization_id
           LEFT JOIN privacy_subject_state s ON s.organization_id=c.organization_id AND s.employee_id=e.id
          WHERE c.organization_id=$1 AND c.module='privacy_request' AND c.category='Erasure' AND c.status IN ('IN_REVIEW','APPROVED')
          ORDER BY c.created_at`, [identity.organizationId])).rows,
    }));
  }

  /** HR: dry-run or execute erasure for the requester of an approved erasure request. Completes the case on execution. */
  async eraseForRequest(identity: AuthIdentity, caseId: string, mode: "DRY_RUN" | "EXECUTE") {
    this.requireHr(identity);
    if (!UUID.test(caseId)) throw new NotFoundException("Request not found.");
    const result = await this.database.tenantTransaction(identity, async (client) => {
      const request = (await client.query(`SELECT id, case_number, requester_id, status, category, version FROM hr_cases WHERE organization_id=$1 AND id=$2 AND module='privacy_request' FOR UPDATE`,
        [identity.organizationId, caseId])).rows[0];
      if (!request) throw new NotFoundException("Request not found.");
      if (request.category !== "Erasure") throw new BadRequestException("This request is not an erasure request.");
      if (mode === "EXECUTE" && request.status !== "APPROVED") throw new ConflictException("Approve the erasure request first (Approve erasure on the request).");
      if (mode === "DRY_RUN" && !["IN_REVIEW", "APPROVED"].includes(request.status)) throw new ConflictException("Start reviewing the request first.");
      const report = await this.buildReport(client, identity.organizationId, { employeeId: request.requester_id, request: true });
      if (mode === "DRY_RUN") {
        const run = await this.storeRun(client, identity.organizationId, "DRY_RUN", "REQUEST", report, identity.userId, { caseId, employeeId: request.requester_id });
        await audit(client, identity.organizationId, identity.userId, "PRIVACY_ERASURE_DRY_RUN", "hr_case", caseId, { runId: run.id, totals: report.totals });
        return { id: run.id, mode, report: await this.present(client, identity.organizationId, report) };
      }
      const subject = report.subjects[0];
      if (!subject || subject.blocked) throw new ConflictException(subject?.blocked || "Nothing can be erased for this person.");
      const run = await this.storeRun(client, identity.organizationId, "EXECUTE", "REQUEST", report, identity.userId, { caseId, employeeId: request.requester_id });
      const done = await this.execute(client, identity.organizationId, identity.userId, report, { runLabel: run.id, caseId });
      await client.query(`UPDATE privacy_erasure_runs SET report = report || jsonb_build_object('executed', $2::jsonb) WHERE id=$1`, [run.id, JSON.stringify(done)]);
      const kept = subject.later.map((later) => `${CATEGORY_INFO[later.category].label} until ${later.dueOn}`);
      const note = `Erasure carried out (${done[0] ? Object.keys(done[0].categories).map((key) => CATEGORY_INFO[key as RetentionCategory].label).join(", ") || "nothing left to erase" : "nothing left to erase"}).`
        + (kept.length ? ` Kept because the law requires it: ${kept.join("; ")}; these will be erased automatically then.` : "");
      // Close the case through the same columns/events the case engine uses.
      await client.query(`UPDATE hr_cases SET status='COMPLETED', version=version+1, updated_at=now(), closed_at=now() WHERE organization_id=$1 AND id=$2`, [identity.organizationId, caseId]);
      await client.query(`INSERT INTO hr_case_events(organization_id,case_id,actor_id,kind,action,from_status,to_status,note,data) VALUES($1,$2,$3,'TRANSITION','complete',$4,'COMPLETED',$5,$6)`,
        [identity.organizationId, caseId, identity.employeeId, request.status, note, JSON.stringify({ erasureRun: run.id })]);
      await client.query(`INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload) VALUES($1,$2,'PRIVACY_REQUEST_COMPLETED','hr_case',$3,$4)`,
        [identity.organizationId, request.requester_id, caseId, JSON.stringify({ module: "privacy_request", caseNumber: request.case_number, message: `${request.case_number} · Erasure completed` })]);
      await audit(client, identity.organizationId, identity.userId, "PRIVACY_REQUEST_COMPLETE", "hr_case", caseId, { runId: run.id, note });
      return { id: run.id, erased: done, note } as Record<string, unknown>;
    });
    if (mode === "EXECUTE") await this.releaseAfterCommit(identity);
    return result;
  }
}

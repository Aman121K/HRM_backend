import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { FilesService } from "../files/files.service";
import { PayrollService } from "../payroll/payroll.service";
import { RULESET, parsePeriod } from "../payroll/statutory";
import { monthLabel } from "../payroll/payroll.shared";
import type { CommitDto, PayslipImportDto, SettingsDto, UndoDto } from "./imports.dto";
import {
  YTD_FIELDS, isDate, isPeriod, reviewLeave, reviewMaster, reviewSalary, reviewYtd,
  type LeaveOp, type MasterOp, type Options, type Review, type ReviewRow, type SalaryOp, type YtdOp,
} from "./reviewers";
import { KIND_LABELS, KIND_ROLES, KIND_SLUGS, slugOf, type ImportKind } from "./templates";
import { ZipError, readZip } from "./zip";

export const IMPORT_ROLES = ["HR_ADMIN", "PAYROLL_ADMIN", "OWNER"];
export const PAYSLIP_ENTITY = "imported_payslip";
const PAYSLIP_WRITERS = ["PAYROLL_ADMIN", "OWNER"];

/** Columns a batch may change per table (the undo log snapshots exactly these). */
const TRACKED: Record<string, { key: string; columns: string[]; versioned?: boolean }> = {
  employees: { key: "id", columns: ["department", "designation", "location", "joining_date", "manager_id"], versioned: true },
  payroll_profiles: {
    key: "employee_id", versioned: true,
    columns: ["state_code", "tax_regime", "bank_name", "ifsc", "pf_applicable", "pt_category", "statutory_flags",
      "pan_enc", "pan_hash", "pan_last4", "uan_enc", "uan_hash", "uan_last4", "esi_number_enc", "esi_number_hash", "esi_number_last4",
      "bank_account_enc", "bank_account_hash", "bank_account_last4"],
  },
  employee_master_details: { key: "employee_id", columns: ["date_of_birth", "gender", "employment_type"] },
  salary_structures: { key: "id", columns: ["effective_from", "annual_ctc"] },
  leave_balance_ledger: { key: "id", columns: ["entry_type", "days", "as_of"] },
  payroll_ytd_opening: { key: "id", columns: ["fiscal_year", "last_paid_period", "gross", "tds"] },
  payroll_ytd_monthly: { key: "id", columns: ["period", "gross", "tds"] },
  stored_files: { key: "id", columns: [] },
};

type Batch = Record<string, any>;
const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

export function kindFromSlug(slug: string): ImportKind {
  const kind = KIND_SLUGS[slug];
  if (!kind) throw new NotFoundException("Unknown import type.");
  return kind;
}
export const canRun = (identity: AuthIdentity, kind: ImportKind) => identity.roles.some((role) => KIND_ROLES[kind].includes(role));
function requireKind(identity: AuthIdentity, kind: ImportKind) {
  if (!canRun(identity, kind)) throw new ForbiddenException(`Only ${KIND_ROLES[kind].join(" / ").replace(/_/g, " ").toLowerCase()} can run the ${KIND_LABELS[kind].title.toLowerCase()} import.`);
}

/** Records every row a batch writes so the batch can be undone exactly. */
class ChangeLog {
  private seq = 0;
  constructor(private readonly client: PoolClient, private readonly organizationId: string, private readonly batchId: string) {}
  async snapshot(table: string, keyValue: string) {
    const spec = TRACKED[table];
    const row = (await this.client.query(`SELECT to_jsonb(t) AS j FROM ${table} t WHERE organization_id=$1 AND ${spec.key}=$2`, [this.organizationId, keyValue])).rows[0]?.j;
    return row ? Object.fromEntries(spec.columns.map((column) => [column, row[column] ?? null])) : null;
  }
  async record(table: string, action: "INSERT" | "UPDATE", keyValue: string, employeeId: string | null, before: unknown) {
    const after = await this.snapshot(table, keyValue);
    await this.client.query(
      `INSERT INTO import_batch_changes(organization_id,batch_id,seq,table_name,action,record_key,employee_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [this.organizationId, this.batchId, ++this.seq, table, action, JSON.stringify({ [TRACKED[table].key]: keyValue }), employeeId,
        before === null || before === undefined ? null : JSON.stringify(before), after ? JSON.stringify(after) : null]);
  }
}

@Injectable()
export class ImportsService implements OnModuleInit {
  constructor(private readonly database: DatabaseService, private readonly files: FilesService, private readonly payroll: PayrollService) {}

  onModuleInit() {
    // Imported payslip PDFs hang off the employee: payroll admins/owner manage them, the employee can read their own.
    this.files.registerPolicy(PAYSLIP_ENTITY, async (identity, employeeId, client) => {
      const exists = await client.query(`SELECT 1 FROM employees WHERE organization_id=$1 AND id=$2`, [identity.organizationId, employeeId]);
      if (!exists.rowCount) return null;
      if (identity.roles.some((role) => PAYSLIP_WRITERS.includes(role))) return "write";
      return employeeId === identity.employeeId ? "read" : null;
    });
  }

  // ------------------------------------------------------------ settings & overview

  private async settingsRow(client: PoolClient, organizationId: string) {
    return (await client.query(
      `SELECT s.*, to_char(s.cutover_date,'YYYY-MM-DD') AS cutover_text, e.full_name AS updated_by_name FROM switchover_settings s
         LEFT JOIN employees e ON e.id=s.updated_by AND e.organization_id=s.organization_id WHERE s.organization_id=$1`, [organizationId])).rows[0];
  }
  private presentSettings(row: any) {
    return {
      cutoverDate: row?.cutover_text || null, fiscalYear: row?.fiscal_year || null, lastPaidPeriod: row?.last_paid_period || null,
      sourceSystem: row?.source_system || null, controlTotals: row?.control_totals || {}, version: row?.version || 0,
      updatedBy: row?.updated_by_name || null, updatedAt: row?.updated_at || null,
    };
  }

  getSettings(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => this.presentSettings(await this.settingsRow(client, identity.organizationId)));
  }

  updateSettings(identity: AuthIdentity, input: SettingsDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const before = await this.settingsRow(client, org);
      if ((before?.version || 0) !== input.version) throw new ConflictException("The switch-over settings changed since you opened them. Reload and try again.");
      if (input.lastPaidPeriod && input.fiscalYear && parsePeriod(input.lastPaidPeriod).fyLabel !== input.fiscalYear)
        throw new BadRequestException(`${input.lastPaidPeriod} is not in FY ${input.fiscalYear}.`);
      if (input.cutoverDate && input.lastPaidPeriod && input.lastPaidPeriod > input.cutoverDate.slice(0, 7))
        throw new BadRequestException("The last month paid by the old system cannot be after the cut-over date.");
      const controls = this.cleanControls(input.controlTotals ?? before?.control_totals ?? {});
      // Payroll control totals are payroll data: HR admins (without payroll) keep the stored ones.
      if (!canRun(identity, "PAYROLL_YTD")) { controls.ytd = before?.control_totals?.ytd; controls.salary = before?.control_totals?.salary; }
      if (!canRun(identity, "LEAVE_OPENING")) { controls.leave = before?.control_totals?.leave; controls.headcount = before?.control_totals?.headcount; }
      const next = {
        cutover: input.cutoverDate === undefined ? before?.cutover_text || null : input.cutoverDate,
        fy: input.fiscalYear === undefined ? before?.fiscal_year || null : input.fiscalYear,
        lastPaid: input.lastPaidPeriod === undefined ? before?.last_paid_period || null : input.lastPaidPeriod,
        source: input.sourceSystem === undefined ? before?.source_system || null : input.sourceSystem?.trim() || null,
      };
      await client.query(
        `INSERT INTO switchover_settings(organization_id,cutover_date,fiscal_year,last_paid_period,source_system,control_totals,version,updated_by,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,1,$7,now())
         ON CONFLICT(organization_id) DO UPDATE SET cutover_date=$2,fiscal_year=$3,last_paid_period=$4,source_system=$5,control_totals=$6,
           version=switchover_settings.version+1,updated_by=$7,updated_at=now()`,
        [org, next.cutover, next.fy, next.lastPaid, next.source, JSON.stringify(Object.fromEntries(Object.entries(controls).filter(([, v]) => v !== undefined))), identity.employeeId]);
      const after = this.presentSettings(await this.settingsRow(client, org));
      await this.audit(client, identity, "SWITCHOVER_SETTINGS_UPDATED", "switchover_settings", org, this.presentSettings(before), after);
      return after;
    });
  }

  private cleanControls(raw: any) {
    const num = (value: unknown) => (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? undefined : Math.round(Number(value) * 100) / 100);
    const obj = (value: any, keys?: string[]) => {
      if (!value || typeof value !== "object") return undefined;
      const entries = Object.entries(value).filter(([key]) => (!keys || keys.includes(key)) && /^[A-Za-z0-9_]{1,40}$/.test(key)).map(([key, v]) => [key, num(v)]).filter(([, v]) => v !== undefined);
      return entries.length ? Object.fromEntries(entries.slice(0, 60)) : undefined;
    };
    return {
      headcount: num(raw?.headcount),
      leave: obj(raw?.leave),
      ytd: obj(raw?.ytd, ["employees", "gross", "taxable", "pf_employee", "pf_employer", "vpf", "esi_employee", "pt", "tds"]),
      salary: obj(raw?.salary, ["structures", "annualCtc"]),
    } as Record<string, any>;
  }

  overview(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const settings = this.presentSettings(await this.settingsRow(client, org));
      const stats = (await client.query(
        `SELECT kind, count(*) FILTER (WHERE status='COMMITTED')::int AS committed, coalesce(sum(total_rows) FILTER (WHERE status='COMMITTED'),0)::int AS records
           FROM import_batches WHERE organization_id=$1 GROUP BY kind`, [org])).rows;
      const last = (await client.query(
        `SELECT DISTINCT ON (b.kind) b.*, c.full_name AS created_by_name, u.full_name AS undone_by_name FROM import_batches b
           LEFT JOIN employees c ON c.id=b.created_by AND c.organization_id=b.organization_id
           LEFT JOIN employees u ON u.id=b.undone_by AND u.organization_id=b.organization_id
          WHERE b.organization_id=$1 ORDER BY b.kind, b.created_at DESC`, [org])).rows;
      const register = (await client.query(`SELECT count(*) FILTER (WHERE status='ACTIVE')::int AS active, count(*)::int AS total FROM employees WHERE organization_id=$1`, [org])).rows[0];
      const steps = (Object.keys(KIND_LABELS) as ImportKind[]).map((kind) => {
        const stat = stats.find((row) => row.kind === kind), lastBatch = last.find((row) => row.kind === kind);
        return {
          kind, slug: slugOf(kind), ...KIND_LABELS[kind], roles: KIND_ROLES[kind], canManage: canRun(identity, kind),
          committedBatches: stat?.committed || 0, records: stat?.records || 0,
          status: stat?.committed ? "DONE" : lastBatch ? "UNDONE" : "NOT_STARTED",
          last: lastBatch ? this.presentBatch(lastBatch) : null,
        };
      });
      return { settings, register, steps, viewer: { roles: identity.roles, canHr: canRun(identity, "LEAVE_OPENING"), canPayroll: canRun(identity, "PAYROLL_YTD") } };
    });
  }

  listBatches(identity: AuthIdentity, kind?: ImportKind) {
    return this.database.tenantTransaction(identity, async (client) => {
      const rows = (await client.query(
        `SELECT b.*, c.full_name AS created_by_name, u.full_name AS undone_by_name FROM import_batches b
           LEFT JOIN employees c ON c.id=b.created_by AND c.organization_id=b.organization_id
           LEFT JOIN employees u ON u.id=b.undone_by AND u.organization_id=b.organization_id
          WHERE b.organization_id=$1 AND ($2::text IS NULL OR b.kind=$2) ORDER BY b.created_at DESC LIMIT 100`, [identity.organizationId, kind || null])).rows;
      return { items: rows.filter((row) => canRun(identity, row.kind)).map((row) => this.presentBatch(row)) };
    });
  }

  batch(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = await this.loadBatch(client, identity, id);
      requireKind(identity, row.kind);
      const changes = (await client.query(
        `SELECT c.seq, c.table_name, c.action, e.employee_number, e.full_name FROM import_batch_changes c
           LEFT JOIN employees e ON e.id=c.employee_id AND e.organization_id=c.organization_id
          WHERE c.organization_id=$1 AND c.batch_id=$2 ORDER BY c.seq LIMIT 2000`, [identity.organizationId, id])).rows;
      return { ...this.presentBatch(row), changes: changes.map((c) => ({ seq: c.seq, table: c.table_name, action: c.action, employeeNumber: c.employee_number, employee: c.full_name })) };
    });
  }

  private presentBatch(row: Batch) {
    return {
      id: row.id, kind: row.kind, slug: slugOf(row.kind), title: KIND_LABELS[row.kind as ImportKind].title, batchKey: row.batch_key, fileName: row.file_name,
      status: row.status, totalRows: row.total_rows, options: row.options, summary: row.summary,
      createdBy: row.created_by_name || null, createdAt: row.created_at, undoneBy: row.undone_by_name || null, undoneAt: row.undone_at, undoReason: row.undo_reason,
    };
  }

  private async loadBatch(client: PoolClient, identity: AuthIdentity, id: string, lock = false) {
    const row = (await client.query(
      `SELECT b.*, c.full_name AS created_by_name, u.full_name AS undone_by_name FROM import_batches b
         LEFT JOIN employees c ON c.id=b.created_by AND c.organization_id=b.organization_id
         LEFT JOIN employees u ON u.id=b.undone_by AND u.organization_id=b.organization_id
        WHERE b.organization_id=$1 AND b.id=$2 ${lock ? "FOR UPDATE OF b" : ""}`, [identity.organizationId, id])).rows[0];
    if (!row) throw new NotFoundException("Import batch not found.");
    return row;
  }

  // ------------------------------------------------------------ CSV imports: dry-run / commit

  private async options(client: PoolClient, identity: AuthIdentity, kind: ImportKind, input: CommitDto): Promise<Options> {
    const stored = this.presentSettings(await this.settingsRow(client, identity.organizationId));
    const options: Options = {
      cutoverDate: input.options?.cutoverDate || stored.cutoverDate, fiscalYear: input.options?.fiscalYear || stored.fiscalYear,
      lastPaidPeriod: input.options?.lastPaidPeriod || stored.lastPaidPeriod,
    };
    if (options.cutoverDate && !isDate(options.cutoverDate)) throw new BadRequestException("Cut-over date must be YYYY-MM-DD.");
    if (options.lastPaidPeriod && !isPeriod(options.lastPaidPeriod)) throw new BadRequestException("Last paid month must be YYYY-MM.");
    if (kind === "PAYROLL_YTD" && options.lastPaidPeriod && !input.options?.fiscalYear) options.fiscalYear = parsePeriod(options.lastPaidPeriod).fyLabel;
    return options;
  }

  private async review(client: PoolClient, identity: AuthIdentity, kind: ImportKind, csv: string, options: Options): Promise<Review<any>> {
    switch (kind) {
      case "EMPLOYEE_MASTER": return reviewMaster(client, identity, csv, options);
      case "SALARY": return reviewSalary(client, identity, csv, this.payroll);
      case "LEAVE_OPENING": return reviewLeave(client, identity, csv, options);
      case "PAYROLL_YTD": return reviewYtd(client, identity, csv, options);
      default: throw new BadRequestException("Payslips are imported as PDF files, not CSV.");
    }
  }

  private batchKey(kind: ImportKind, csv: string, review: Review<unknown>, explicit?: string) {
    if (explicit) return explicit;
    const normalized = csv.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
    return `auto:${sha256(`${kind}\n${JSON.stringify(review.options)}\n${normalized}`).slice(0, 40)}`;
  }

  private summary(rows: ReviewRow[]) {
    const count = (outcome: string) => rows.filter((row) => row.outcome === outcome).length;
    return {
      total: rows.length, valid: rows.filter((row) => !row.errors.length).length, invalid: count("INVALID"),
      create: count("CREATE"), update: count("UPDATE"), unchanged: count("UNCHANGED"), warnings: rows.filter((row) => row.warnings.length).length,
    };
  }

  private async existingBatch(client: PoolClient, identity: AuthIdentity, kind: ImportKind, key: string) {
    return (await client.query(
      `SELECT b.*, c.full_name AS created_by_name FROM import_batches b LEFT JOIN employees c ON c.id=b.created_by AND c.organization_id=b.organization_id
        WHERE b.organization_id=$1 AND b.kind=$2 AND b.batch_key=$3 AND b.status='COMMITTED'`, [identity.organizationId, kind, key])).rows[0];
  }

  dryRun(identity: AuthIdentity, kind: ImportKind, input: CommitDto) {
    requireKind(identity, kind);
    return this.database.tenantTransaction(identity, async (client) => {
      const options = await this.options(client, identity, kind, input);
      const review = await this.review(client, identity, kind, input.csv, options);
      const key = this.batchKey(kind, input.csv, review, input.batchKey);
      const already = await this.existingBatch(client, identity, kind, key);
      return {
        kind, batchKey: key, options: review.options, rows: review.rows, summary: this.summary(review.rows), totals: review.totals,
        alreadyCommitted: already ? this.presentBatch(already) : null,
      };
    });
  }

  commit(identity: AuthIdentity, kind: ImportKind, input: CommitDto) {
    requireKind(identity, kind);
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      // One switch-over import at a time per brand (all kinds share the lock: they read each other's data).
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('switchover_import:' || $1))`, [org]);
      const options = await this.options(client, identity, kind, input);
      const review = await this.review(client, identity, kind, input.csv, options);
      const key = this.batchKey(kind, input.csv, review, input.batchKey);
      const already = await this.existingBatch(client, identity, kind, key);
      // Idempotent: the same batch key (same file + options, or the caller's key) returns the committed batch unchanged.
      if (already) return { idempotent: true, batch: this.presentBatch(already) };
      const summary = this.summary(review.rows);
      if (summary.invalid) throw new BadRequestException({ message: `${summary.invalid} row(s) have errors. Fix them and validate again — nothing was imported.`, rows: review.rows.filter((row) => row.errors.length), summary });
      if (!review.ops.length) throw new BadRequestException("Nothing to import — every row matches what is already on file.");
      const batch = (await client.query(
        `INSERT INTO import_batches(organization_id,kind,batch_key,content_sha256,file_name,total_rows,options,summary,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [org, kind, key, sha256(input.csv), (input.fileName || `${slugOf(kind)}.csv`).slice(0, 200), review.ops.length, JSON.stringify(review.options),
          JSON.stringify({ ...summary, totals: review.totals }), identity.employeeId])).rows[0];
      const log = new ChangeLog(client, org, batch.id);
      if (kind === "EMPLOYEE_MASTER") await this.applyMaster(client, identity, review.ops, log, batch.id);
      if (kind === "SALARY") await this.applySalary(client, identity, review.ops, log, batch.id);
      if (kind === "LEAVE_OPENING") await this.applyLeave(client, identity, review.ops, log, batch.id);
      if (kind === "PAYROLL_YTD") await this.applyYtd(client, identity, review.ops, log, batch.id);
      await this.audit(client, identity, "SWITCHOVER_IMPORT_COMMITTED", "import_batch", batch.id, null,
        { kind, fileName: batch.file_name, batchKey: key, records: review.ops.length, options: review.options, totals: review.totals });
      return { idempotent: false, batch: this.presentBatch({ ...batch, created_by_name: null }), summary, totals: review.totals };
    });
  }

  private async applyMaster(client: PoolClient, identity: AuthIdentity, ops: MasterOp[], log: ChangeLog, batchId: string) {
    const org = identity.organizationId;
    const numbers = new Map((await client.query(`SELECT employee_number, id FROM employees WHERE organization_id=$1`, [org])).rows.map((row) => [row.employee_number, row.id]));
    for (const op of ops) {
      const { manager_number: managerNumber, ...register } = op.employee;
      const employeeSet: Record<string, unknown> = { ...register };
      if (managerNumber !== undefined) employeeSet.manager_id = managerNumber ? numbers.get(managerNumber) : null;
      if (Object.keys(employeeSet).length) {
        const before = await log.snapshot("employees", op.employeeId);
        const columns = Object.keys(employeeSet);
        await client.query(`UPDATE employees SET ${columns.map((column, i) => `${column}=$${i + 3}`).join(",")}, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`,
          [org, op.employeeId, ...columns.map((column) => employeeSet[column])]);
        await log.record("employees", "UPDATE", op.employeeId, op.employeeId, before);
      }
      if (Object.keys(op.details).length) {
        const before = await log.snapshot("employee_master_details", op.employeeId);
        const columns = Object.keys(op.details) as (keyof MasterOp["details"])[];
        await client.query(
          `INSERT INTO employee_master_details(organization_id,employee_id,${columns.join(",")}) VALUES($1,$2,${columns.map((_, i) => `$${i + 3}`).join(",")})
           ON CONFLICT(organization_id,employee_id) DO UPDATE SET ${columns.map((column) => `${column}=excluded.${column}`).join(",")}, updated_at=now()`,
          [org, op.employeeId, ...columns.map((column) => op.details[column])]);
        await log.record("employee_master_details", before ? "UPDATE" : "INSERT", op.employeeId, op.employeeId, before);
      }
      const profileSet: Record<string, unknown> = { ...op.profile };
      if (profileSet.statutory_flags) profileSet.statutory_flags = JSON.stringify(profileSet.statutory_flags);
      for (const [field, sealed] of Object.entries(op.sealed)) {
        const column = { pan: "pan", uan: "uan", esiNumber: "esi_number", bankAccount: "bank_account" }[field as "pan"];
        profileSet[`${column}_enc`] = sealed!.enc; profileSet[`${column}_hash`] = sealed!.hash; profileSet[`${column}_last4`] = sealed!.last4;
      }
      if (Object.keys(profileSet).length) {
        const before = await log.snapshot("payroll_profiles", op.employeeId);
        const columns = Object.keys(profileSet);
        if (before) {
          await client.query(`UPDATE payroll_profiles SET ${columns.map((column, i) => `${column}=$${i + 3}`).join(",")}, version=version+1, updated_at=now() WHERE organization_id=$1 AND employee_id=$2`,
            [org, op.employeeId, ...columns.map((column) => profileSet[column])]);
        } else {
          await client.query(`INSERT INTO payroll_profiles(organization_id,employee_id,${columns.join(",")}) VALUES($1,$2,${columns.map((_, i) => `$${i + 3}`).join(",")})`,
            [org, op.employeeId, ...columns.map((column) => profileSet[column])]);
        }
        await log.record("payroll_profiles", before ? "UPDATE" : "INSERT", op.employeeId, op.employeeId, before);
      }
      // Identifiers appear in the audit trail only as field names (the values are encrypted at rest and masked everywhere).
      await this.audit(client, identity, "EMPLOYEE_MASTER_IMPORTED", "employee", op.employeeId, null, {
        batchId, register: Object.keys(employeeSet), details: op.details, profile: Object.keys(op.profile), identifiersSet: Object.keys(op.sealed),
      });
    }
    await this.markRunsStale(client, org, null);
  }

  private async applySalary(client: PoolClient, identity: AuthIdentity, ops: SalaryOp[], log: ChangeLog, batchId: string) {
    const org = identity.organizationId;
    for (const op of ops) {
      const b = op.built;
      const row = (await client.query(
        `INSERT INTO salary_structures(organization_id,employee_id,effective_from,annual_ctc,is_metro,template,components,fixed_monthly_gross,monthly_ctc,annual_variable,ruleset_version,reason,notes,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [org, op.employeeId, op.effectiveFrom, b.annualCtc, b.isMetro, JSON.stringify(b.template), JSON.stringify(b.components), b.fixedMonthlyGross, b.monthlyCtc, b.annualVariable,
          RULESET.version, op.reason, op.notes || `Switch-over import`, identity.employeeId])).rows[0];
      await log.record("salary_structures", "INSERT", row.id, op.employeeId, null);
      await this.audit(client, identity, "SALARY_STRUCTURE_CREATED", "salary_structure", row.id, null,
        { employeeId: op.employeeId, effectiveFrom: op.effectiveFrom, annualCtc: b.annualCtc, fixedMonthlyGross: b.fixedMonthlyGross, template: b.template, source: "SWITCHOVER_IMPORT", batchId });
    }
    const earliest = ops.map((op) => op.effectiveFrom.slice(0, 7)).sort()[0];
    await this.markRunsStale(client, org, earliest);
  }

  private async applyLeave(client: PoolClient, identity: AuthIdentity, ops: LeaveOp[], log: ChangeLog, batchId: string) {
    const org = identity.organizationId;
    for (const op of ops) {
      const opening = (await client.query(
        `INSERT INTO leave_balance_ledger(organization_id,employee_id,leave_type_id,entry_type,days,as_of,note,batch_id,created_by)
         VALUES($1,$2,$3,'OPENING',$4,$5,'Opening balance (switch-over import)',$6,$7) RETURNING id`,
        [org, op.employeeId, op.leaveTypeId, op.opening, op.asOf, batchId, identity.employeeId])).rows[0];
      await log.record("leave_balance_ledger", "INSERT", opening.id, op.employeeId, null);
      if (op.taken > 0) {
        const taken = (await client.query(
          `INSERT INTO leave_balance_ledger(organization_id,employee_id,leave_type_id,entry_type,days,as_of,note,batch_id,created_by)
           VALUES($1,$2,$3,'TAKEN_BEFORE_CUTOVER',$4,$5,'Taken this year in the previous system (already netted in the opening balance)',$6,$7) RETURNING id`,
          [org, op.employeeId, op.leaveTypeId, op.taken, op.asOf, batchId, identity.employeeId])).rows[0];
        await log.record("leave_balance_ledger", "INSERT", taken.id, op.employeeId, null);
      }
      await this.audit(client, identity, "LEAVE_OPENING_IMPORTED", "employee", op.employeeId, null, { batchId, leaveType: op.code, opening: op.opening, taken: op.taken, asOf: op.asOf });
    }
  }

  private async applyYtd(client: PoolClient, identity: AuthIdentity, ops: YtdOp[], log: ChangeLog, batchId: string) {
    const org = identity.organizationId;
    for (const op of ops) {
      const t = op.totals;
      const row = (await client.query(
        `INSERT INTO payroll_ytd_opening(organization_id,employee_id,fiscal_year,from_period,last_paid_period,months,gross,basic,hra,other_taxable,exempt_allowances,taxable,
            pf_employee,pf_employer,vpf,esi_employee,pt,tds,batch_id,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
        [org, op.employeeId, op.fiscalYear, op.fromPeriod, op.lastPaidPeriod, op.months, t.gross, t.basic, t.hra, t.other_taxable, t.exempt_allowances, t.taxable,
          t.pf_employee, t.pf_employer, t.vpf, t.esi_employee, t.pt, t.tds, batchId, identity.employeeId])).rows[0];
      await log.record("payroll_ytd_opening", "INSERT", row.id, op.employeeId, null);
      for (const month of op.monthly) {
        const history = (await client.query(
          `INSERT INTO payroll_ytd_monthly(organization_id,employee_id,fiscal_year,period,${YTD_FIELDS.join(",")},batch_id)
           VALUES($1,$2,$3,$4,${YTD_FIELDS.map((_, i) => `$${i + 5}`).join(",")},$${YTD_FIELDS.length + 5}) RETURNING id`,
          [org, op.employeeId, op.fiscalYear, month.period, ...YTD_FIELDS.map((field) => month[field]), batchId])).rows[0];
        await log.record("payroll_ytd_monthly", "INSERT", history.id, op.employeeId, null);
      }
      await this.audit(client, identity, "PAYROLL_YTD_IMPORTED", "employee", op.employeeId, null,
        { batchId, fiscalYear: op.fiscalYear, fromPeriod: op.fromPeriod, lastPaidPeriod: op.lastPaidPeriod, months: op.months, gross: t.gross, taxable: t.taxable, tds: t.tds, pf: t.pf_employee + t.vpf, pt: t.pt });
    }
    // Calculated (not yet submitted) runs must pick up the opening year-to-date.
    await this.markRunsStale(client, org, null);
  }

  // ------------------------------------------------------------ undo

  async undo(identity: AuthIdentity, id: string, input: UndoDto) {
    const head = await this.database.tenantTransaction(identity, async (client) => this.loadBatch(client, identity, id));
    requireKind(identity, head.kind);
    if (head.status !== "COMMITTED") throw new ConflictException("This batch was already undone.");
    // Payslip files are removed through FilesService (its own transactions) before the batch is closed.
    if (head.kind === "PAYSLIPS") {
      const fileIds = await this.database.tenantTransaction(identity, async (client) => (await client.query(
        `SELECT record_key->>'id' AS id FROM import_batch_changes WHERE organization_id=$1 AND batch_id=$2 AND table_name='stored_files'`, [identity.organizationId, id])).rows.map((row) => row.id));
      for (const fileId of fileIds) {
        await this.files.remove(identity, fileId).catch((error) => { if (!(error instanceof NotFoundException)) throw error; });
      }
    }
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('switchover_import:' || $1))`, [org]);
      const batch = await this.loadBatch(client, identity, id, true);
      if (batch.status !== "COMMITTED") throw new ConflictException("This batch was already undone.");
      const changes = (await client.query(
        `SELECT c.*, e.employee_number FROM import_batch_changes c LEFT JOIN employees e ON e.id=c.employee_id AND e.organization_id=c.organization_id
          WHERE c.organization_id=$1 AND c.batch_id=$2 ORDER BY c.seq DESC`, [org, id])).rows;
      const blockers = await this.undoBlockers(client, identity, batch, changes);
      if (blockers.length) throw new ConflictException({ message: `This batch can't be undone: ${blockers.slice(0, 5).join("; ")}${blockers.length > 5 ? ` (+${blockers.length - 5} more)` : ""}`, blockers });
      for (const change of changes) {
        if (change.table_name === "stored_files") continue;
        const spec = TRACKED[change.table_name];
        const keyValue = change.record_key[spec.key];
        if (change.action === "INSERT") {
          if (change.table_name === "salary_structures")
            await client.query(`UPDATE payroll_run_lines SET structure_id=NULL WHERE organization_id=$1 AND structure_id=$2`, [org, keyValue]);
          await client.query(`DELETE FROM ${change.table_name} WHERE organization_id=$1 AND ${spec.key}=$2`, [org, keyValue]);
        } else {
          const columns = spec.columns;
          await client.query(
            `UPDATE ${change.table_name} t SET (${columns.join(",")}) = (SELECT ${columns.map((column) => `r.${column}`).join(",")} FROM jsonb_populate_record(null::${change.table_name}, $3::jsonb) r)
                ${spec.versioned ? ", version=t.version+1" : ""}, updated_at=now()
              WHERE t.organization_id=$1 AND t.${spec.key}=$2`, [org, keyValue, JSON.stringify(change.before_data)]);
        }
      }
      await client.query(`UPDATE import_batches SET status='UNDONE', undone_by=$3, undone_at=now(), undo_reason=$4 WHERE organization_id=$1 AND id=$2`,
        [org, id, identity.employeeId, input.reason?.trim() || null]);
      const fromPeriod = batch.kind === "SALARY" ? (await client.query(`SELECT min(after_data->>'effective_from') AS p FROM import_batch_changes WHERE organization_id=$1 AND batch_id=$2`, [org, id])).rows[0]?.p?.slice(0, 7) || null : null;
      if (batch.kind !== "LEAVE_OPENING" && batch.kind !== "PAYSLIPS") await this.markRunsStale(client, org, fromPeriod);
      await this.audit(client, identity, "SWITCHOVER_IMPORT_UNDONE", "import_batch", id, { status: "COMMITTED", kind: batch.kind, records: batch.total_rows },
        { status: "UNDONE", reason: input.reason?.trim() || null, changesReverted: changes.length });
      return this.presentBatch(await this.loadBatch(client, identity, id));
    });
  }

  /** Why a batch cannot be undone: later edits to the same records, or payroll/leave data that already used it. */
  private async undoBlockers(client: PoolClient, identity: AuthIdentity, batch: Batch, changes: any[]) {
    const org = identity.organizationId;
    const blockers: string[] = [];
    for (const change of changes) {
      if (change.table_name === "stored_files") continue;
      const spec = TRACKED[change.table_name];
      const keyValue = change.record_key[spec.key];
      const current = (await client.query(`SELECT to_jsonb(t) AS j FROM ${change.table_name} t WHERE organization_id=$1 AND ${spec.key}=$2`, [org, keyValue])).rows[0]?.j;
      const who = change.employee_number || "a record";
      if (!current) { if (change.action === "UPDATE") blockers.push(`${who}: the record no longer exists`); continue; }
      const edited = spec.columns.filter((column) => JSON.stringify(current[column] ?? null) !== JSON.stringify(change.after_data?.[column] ?? null));
      if (edited.length) blockers.push(`${who}: ${change.table_name.replace(/_/g, " ")} changed after this import (${edited.filter((c) => !/_hash$|_last4$/.test(c)).map((c) => c.replace(/_enc$/, "")).join(", ")})`);
    }
    if (batch.kind === "SALARY") {
      const used = (await client.query(
        `SELECT DISTINCT e.employee_number, r.period, r.status FROM import_batch_changes c
           JOIN payroll_run_lines l ON l.organization_id=c.organization_id AND l.structure_id=(c.record_key->>'id')::uuid
           JOIN payroll_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
           JOIN employees e ON e.id=l.employee_id AND e.organization_id=l.organization_id
          WHERE c.organization_id=$1 AND c.batch_id=$2 AND c.table_name='salary_structures' AND r.status IN ('SUBMITTED','APPROVED','PUBLISHED','LOCKED')`, [org, batch.id])).rows;
      for (const row of used) blockers.push(`${row.employee_number}: structure used by the ${monthLabel(row.period)} run (${row.status.toLowerCase()})`);
    }
    if (batch.kind === "PAYROLL_YTD") {
      const used = (await client.query(
        `SELECT DISTINCT r.period, r.status FROM payroll_ytd_opening o
           JOIN payroll_run_lines l ON l.organization_id=o.organization_id AND l.employee_id=o.employee_id AND l.status='INCLUDED'
           JOIN payroll_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
          WHERE o.organization_id=$1 AND o.batch_id=$2 AND r.period > o.last_paid_period
            AND r.period <= (split_part(o.fiscal_year,'-',1)::int + 1)::text || '-03'
            AND r.status IN ('SUBMITTED','APPROVED','PUBLISHED','LOCKED') AND r.calculated_at >= $3`, [org, batch.id, batch.created_at])).rows;
      for (const row of used) blockers.push(`the ${monthLabel(row.period)} run (${row.status.toLowerCase()}) computed TDS with these figures`);
    }
    return blockers;
  }

  // ------------------------------------------------------------ payslip PDFs

  private async reviewPayslips(client: PoolClient, identity: AuthIdentity, input: PayslipImportDto) {
    const org = identity.organizationId;
    let entries: { name: string; bytes: Buffer }[] = [];
    try {
      if (input.zipBase64) entries.push(...readZip(Buffer.from(input.zipBase64.replace(/^data:[^;]+;base64,/, ""), "base64")));
    } catch (error) { if (error instanceof ZipError) throw new BadRequestException(error.message); throw error; }
    for (const file of input.files || []) entries.push({ name: file.name, bytes: Buffer.from(file.base64.replace(/^data:[^;]+;base64,/, ""), "base64") });
    entries = entries.filter((entry) => { const base = entry.name.split("/").pop() || ""; return !entry.name.startsWith("__MACOSX/") && base && !base.startsWith("."); });
    if (!entries.length) throw new BadRequestException("Upload a .zip of payslip PDFs or choose PDF files.");
    if (entries.length > 600) throw new BadRequestException("Import at most 600 payslips at a time.");
    const employees = new Map((await client.query(`SELECT id, employee_number, full_name, status, to_char(joining_date,'YYYY-MM') AS joined FROM employees WHERE organization_id=$1`, [org])).rows.map((row) => [row.employee_number.toUpperCase(), row]));
    const existing = new Set((await client.query(
      `SELECT entity_id || '|' || category AS k FROM stored_files WHERE organization_id=$1 AND entity_type=$2 AND deleted_at IS NULL`, [org, PAYSLIP_ENTITY])).rows.map((row) => row.k));
    const thisMonth = new Date().toISOString().slice(0, 7);
    const seen = new Set<string>();
    const hashParts: string[] = [];
    const rows: ReviewRow[] = [];
    const ops: { employeeId: string; employeeNumber: string; period: string; name: string; bytes: Buffer }[] = [];
    entries.forEach((entry, index) => {
      const base = entry.name.split("/").pop()!;
      const match = /^(.+?)[\s_-]+(\d{4})-?(0[1-9]|1[0-2])\.pdf$/i.exec(base);
      const number = match?.[1].trim() || base;
      const employee = match ? employees.get(match[1].trim().toUpperCase()) : undefined;
      const item: ReviewRow = { row: index + 1, employeeNumber: number, employeeName: employee?.full_name || null, outcome: "CREATE", changes: { file: base }, errors: [], warnings: [] };
      rows.push(item);
      if (!match) item.errors.push("Name the file <employee number>_<YYYY-MM>.pdf");
      else {
        const period = `${match[2]}-${match[3]}`;
        item.changes.period = period;
        if (!employee) item.errors.push(`Employee ${match[1]} does not exist`);
        if (period > thisMonth || period < "2015-01") item.errors.push("Period must be between 2015-01 and the current month");
        if (employee && period < employee.joined) item.warnings.push("Period is before the joining month");
        if (entry.bytes.subarray(0, 4).toString("latin1") !== "%PDF") item.errors.push("Not a PDF file (content check)");
        if (entry.bytes.length > 8 * 1024 * 1024) item.errors.push("Larger than 8 MB");
        const key = employee ? `${employee.id}|PAYSLIP_${period.replace("-", "_")}` : "";
        if (key && seen.has(key)) item.errors.push("Same employee and month appear twice in this upload");
        seen.add(key);
        if (!item.errors.length && employee) hashParts.push(`${employee.employee_number}|${period}|${sha256(entry.bytes)}`);
        if (!item.errors.length && existing.has(key)) { item.outcome = "UNCHANGED"; item.warnings.push("Already imported for this month — skipped"); return; }
        if (!item.errors.length && employee) ops.push({ employeeId: employee.id, employeeNumber: employee.employee_number, period, name: base, bytes: entry.bytes });
      }
      if (item.errors.length) item.outcome = "INVALID";
    });
    // Batch identity covers every valid file (also ones already on file), so re-sending a committed zip is idempotent.
    const content = sha256(hashParts.sort().join("\n"));
    return { rows, ops, totals: { files: ops.length, employees: new Set(ops.map((op) => op.employeeId)).size, bytes: ops.reduce((sum, op) => sum + op.bytes.length, 0) }, content };
  }

  payslipDryRun(identity: AuthIdentity, input: PayslipImportDto) {
    requireKind(identity, "PAYSLIPS");
    return this.database.tenantTransaction(identity, async (client) => {
      const review = await this.reviewPayslips(client, identity, input);
      const key = input.batchKey || `auto:${review.content.slice(0, 40)}`;
      const already = await this.existingBatch(client, identity, "PAYSLIPS", key);
      return { kind: "PAYSLIPS", batchKey: key, rows: review.rows, summary: this.summary(review.rows), totals: review.totals, alreadyCommitted: already ? this.presentBatch(already) : null };
    });
  }

  async payslipCommit(identity: AuthIdentity, input: PayslipImportDto) {
    requireKind(identity, "PAYSLIPS");
    const prepared = await this.database.tenantTransaction(identity, async (client) => {
      const review = await this.reviewPayslips(client, identity, input);
      const key = input.batchKey || `auto:${review.content.slice(0, 40)}`;
      const already = await this.existingBatch(client, identity, "PAYSLIPS", key);
      return { review, key, already };
    });
    if (prepared.already) return { idempotent: true, batch: this.presentBatch(prepared.already) };
    const summary = this.summary(prepared.review.rows);
    if (summary.invalid) throw new BadRequestException({ message: `${summary.invalid} file(s) have errors. Fix them and validate again — nothing was imported.`, rows: prepared.review.rows.filter((row) => row.errors.length), summary });
    if (!prepared.review.ops.length) throw new BadRequestException("Nothing to import — every payslip is already on file.");
    const uploaded: { id: string; op: (typeof prepared.review.ops)[number] }[] = [];
    try {
      for (const op of prepared.review.ops) {
        const file = await this.files.upload(identity, {
          entityType: PAYSLIP_ENTITY, entityId: op.employeeId, category: `PAYSLIP_${op.period.replace("-", "_")}`,
          originalName: `Payslip ${op.employeeNumber} ${op.period} (imported).pdf`, mimeType: "application/pdf", base64: op.bytes.toString("base64"),
        });
        uploaded.push({ id: file.id, op });
      }
      return await this.database.tenantTransaction(identity, async (client) => {
        const org = identity.organizationId;
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('switchover_import:' || $1))`, [org]);
        const batch = (await client.query(
          `INSERT INTO import_batches(organization_id,kind,batch_key,content_sha256,file_name,total_rows,options,summary,created_by)
           VALUES($1,'PAYSLIPS',$2,$3,$4,$5,'{}',$6,$7) RETURNING *`,
          [org, prepared.key, prepared.review.content, (input.fileName || "payslips.zip").slice(0, 200), uploaded.length, JSON.stringify({ ...summary, totals: prepared.review.totals }), identity.employeeId])).rows[0];
        let seq = 0;
        for (const item of uploaded) {
          await client.query(
            `INSERT INTO import_batch_changes(organization_id,batch_id,seq,table_name,action,record_key,employee_id,after_data) VALUES($1,$2,$3,'stored_files','INSERT',$4,$5,$6)`,
            [org, batch.id, ++seq, JSON.stringify({ id: item.id }), item.op.employeeId, JSON.stringify({ period: item.op.period, name: item.op.name })]);
        }
        await this.audit(client, identity, "SWITCHOVER_IMPORT_COMMITTED", "import_batch", batch.id, null, { kind: "PAYSLIPS", files: uploaded.length, totals: prepared.review.totals });
        return { idempotent: false, batch: this.presentBatch(batch), summary, totals: prepared.review.totals };
      });
    } catch (error) {
      for (const item of uploaded) await this.files.remove(identity, item.id).catch(() => undefined);
      throw error;
    }
  }

  /** Imported payslips of one employee (self, or payroll admin / owner). Downloads go through /api/v2/files/:id/content. */
  async importedPayslips(identity: AuthIdentity, employeeId: string) {
    const listing = await this.files.list(identity, PAYSLIP_ENTITY, employeeId);
    return {
      items: listing.items.map((file: any) => {
        const period = /^PAYSLIP_(\d{4})_(\d{2})$/.exec(file.category);
        const value = period ? `${period[1]}-${period[2]}` : null;
        return { id: file.id, period: value, label: value ? monthLabel(value) : file.originalName, name: file.originalName, byteSize: file.byteSize, importedAt: file.createdAt };
      }).sort((a: any, b: any) => String(b.period).localeCompare(String(a.period))),
    };
  }

  // ------------------------------------------------------------ leave balances & reconciliation

  /** Leave balances for employees that have an imported opening (opening + adjustments − leave approved after as_of). */
  leaveBalances(identity: AuthIdentity, employeeNumber?: string) {
    requireKind(identity, "LEAVE_OPENING");
    return this.database.tenantTransaction(identity, async (client) => ({ items: (await client.query(
      `${BALANCE_SQL} WHERE e.organization_id=$1 AND ($2::text IS NULL OR e.employee_number=$2) ORDER BY e.employee_number, t.code LIMIT 5000`,
      [identity.organizationId, employeeNumber || null])).rows }));
  }

  reconciliation(identity: AuthIdentity) {
    const hr = canRun(identity, "LEAVE_OPENING"), pay = canRun(identity, "PAYROLL_YTD");
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const settings = this.presentSettings(await this.settingsRow(client, org));
      const controls = settings.controlTotals as Record<string, any>;
      const checks: { section: string; label: string; system: number; control: number | null; difference: number | null; ok: boolean | null }[] = [];
      const check = (section: string, label: string, system: number, control: unknown) => {
        const c = control === undefined || control === null ? null : Number(control);
        const difference = c === null ? null : Math.round((system - c) * 100) / 100;
        checks.push({ section, label, system: Math.round(system * 100) / 100, control: c, difference, ok: c === null ? null : Math.abs(difference!) < 0.5 });
      };
      const headcount = (await client.query(
        `SELECT count(*) FILTER (WHERE e.status='ACTIVE')::int AS active, count(*) FILTER (WHERE e.status<>'ACTIVE')::int AS inactive,
                count(d.date_of_birth) FILTER (WHERE e.status='ACTIVE')::int AS with_dob,
                count(p.pan_enc) FILTER (WHERE e.status='ACTIVE')::int AS with_pan, count(p.uan_enc) FILTER (WHERE e.status='ACTIVE')::int AS with_uan,
                count(p.bank_account_enc) FILTER (WHERE e.status='ACTIVE')::int AS with_bank,
                count(*) FILTER (WHERE e.status='ACTIVE' AND EXISTS (SELECT 1 FROM salary_structures s WHERE s.organization_id=e.organization_id AND s.employee_id=e.id))::int AS with_structure,
                count(*) FILTER (WHERE e.status='ACTIVE' AND EXISTS (SELECT 1 FROM leave_balance_ledger l WHERE l.organization_id=e.organization_id AND l.employee_id=e.id AND l.entry_type='OPENING'))::int AS with_leave
           FROM employees e LEFT JOIN employee_master_details d ON d.organization_id=e.organization_id AND d.employee_id=e.id
           LEFT JOIN payroll_profiles p ON p.organization_id=e.organization_id AND p.employee_id=e.id WHERE e.organization_id=$1`, [org])).rows[0];
      check("Headcount", "Active employees", headcount.active, controls.headcount);
      const result: Record<string, unknown> = { settings, headcount: hr || pay ? headcount : null, checks };
      if (hr) {
        const leave = (await client.query(
          `SELECT t.code, t.name, count(DISTINCT l.employee_id) FILTER (WHERE l.entry_type='OPENING')::int AS employees,
                  coalesce(sum(l.days) FILTER (WHERE l.entry_type='OPENING'),0)::float AS opening,
                  coalesce(sum(l.days) FILTER (WHERE l.entry_type='TAKEN_BEFORE_CUTOVER'),0)::float AS taken
             FROM leave_types t LEFT JOIN leave_balance_ledger l ON l.organization_id=t.organization_id AND l.leave_type_id=t.id
            WHERE t.organization_id=$1 AND t.active GROUP BY t.code, t.name ORDER BY t.code`, [org])).rows;
        result.leave = leave;
        for (const row of leave) if (row.employees || controls.leave?.[row.code] !== undefined) check("Leave", `${row.name} (${row.code}) opening days`, row.opening, controls.leave?.[row.code]);
      }
      if (pay) {
        const ytd = (await client.query(
          `SELECT fiscal_year, count(*)::int AS employees, ${[...YTD_FIELDS, "taxable"].map((field) => `coalesce(sum(${field}),0)::float AS ${field}`).join(", ")}
             FROM payroll_ytd_opening WHERE organization_id=$1 GROUP BY fiscal_year ORDER BY fiscal_year DESC`, [org])).rows;
        const current = ytd.find((row) => row.fiscal_year === settings.fiscalYear) || ytd[0] || null;
        result.ytd = current;
        const labels: Record<string, string> = { employees: "Employees with YTD", gross: "YTD gross", taxable: "YTD taxable", pf_employee: "YTD employee PF", pf_employer: "YTD employer PF", vpf: "YTD VPF", esi_employee: "YTD employee ESI", pt: "YTD professional tax", tds: "YTD TDS" };
        for (const [key, label] of Object.entries(labels)) if (current || controls.ytd?.[key] !== undefined) check("Payroll YTD", label, Number(current?.[key] || 0), controls.ytd?.[key]);
        const salary = (await client.query(
          `SELECT count(*)::int AS structures, coalesce(sum(cur.annual_ctc),0)::float AS annual_ctc FROM employees e
             JOIN LATERAL (SELECT annual_ctc FROM salary_structures s WHERE s.organization_id=e.organization_id AND s.employee_id=e.id AND s.effective_from<=current_date ORDER BY s.effective_from DESC LIMIT 1) cur ON true
            WHERE e.organization_id=$1 AND e.status='ACTIVE'`, [org])).rows[0];
        result.salary = salary;
        check("Salary", "Employees with a current structure", salary.structures, controls.salary?.structures);
        check("Salary", "Total annual CTC (current structures)", salary.annual_ctc, controls.salary?.annualCtc);
      }
      result.mismatches = checks.filter((item) => item.ok === false).length;
      return result;
    });
  }

  // ------------------------------------------------------------ helpers

  private markRunsStale(client: PoolClient, organizationId: string, fromPeriod: string | null) {
    return client.query(`UPDATE payroll_runs SET needs_recalc=true, updated_at=now() WHERE organization_id=$1 AND status='CALCULATED' AND ($2::text IS NULL OR period >= $2)`, [organizationId, fromPeriod]);
  }

  private audit(client: PoolClient, identity: AuthIdentity, action: string, entityType: string, entityId: string, before: unknown, after: unknown) {
    return client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [identity.organizationId, identity.userId, action, entityType, entityId, before === null || before === undefined ? null : JSON.stringify(before), after === null || after === undefined ? null : JSON.stringify(after)]);
  }
}

/** Opening-based leave balance (shared shape with leave.service's listTypes). */
export const BALANCE_SQL = `
  SELECT e.employee_number, e.full_name, t.code, t.name AS leave_type, to_char(o.as_of,'YYYY-MM-DD') AS as_of, o.opening::float,
         coalesce(adj.days,0)::float AS adjustments, coalesce(tk.days,0)::float AS taken_before_cutover,
         coalesce(used.days,0)::float AS approved_after, coalesce(pend.days,0)::float AS pending_after,
         (o.opening + coalesce(adj.days,0) - coalesce(used.days,0))::float AS balance
    FROM employees e
    JOIN LATERAL (SELECT l.leave_type_id, l.as_of, l.days AS opening FROM leave_balance_ledger l WHERE l.organization_id=e.organization_id AND l.employee_id=e.id AND l.entry_type='OPENING') o ON true
    JOIN leave_types t ON t.id=o.leave_type_id AND t.organization_id=e.organization_id
    LEFT JOIN LATERAL (SELECT sum(days) AS days FROM leave_balance_ledger a WHERE a.organization_id=e.organization_id AND a.employee_id=e.id AND a.leave_type_id=o.leave_type_id AND a.entry_type='ADJUSTMENT') adj ON true
    LEFT JOIN LATERAL (SELECT sum(days) AS days FROM leave_balance_ledger a WHERE a.organization_id=e.organization_id AND a.employee_id=e.id AND a.leave_type_id=o.leave_type_id AND a.entry_type='TAKEN_BEFORE_CUTOVER') tk ON true
    LEFT JOIN LATERAL (SELECT sum(days) AS days FROM leave_requests r WHERE r.organization_id=e.organization_id AND r.employee_id=e.id AND r.leave_type_id=o.leave_type_id AND r.status='APPROVED' AND r.start_date > o.as_of) used ON true
    LEFT JOIN LATERAL (SELECT sum(days) AS days FROM leave_requests r WHERE r.organization_id=e.organization_id AND r.employee_id=e.id AND r.leave_type_id=o.leave_type_id AND r.status='PENDING' AND r.start_date > o.as_of) pend ON true`;

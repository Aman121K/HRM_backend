import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { FilesService } from "../files/files.service";
import { decryptField, sealField } from "../security/field-crypto";
import {
  BANK_FILE_ROLES, audit, auditRead, decryptProfileField, isPayrollAdmin, loadAcceptedDeclarations, maskedField, notify, requireAdmin, statutoryFlags,
} from "../payroll/payroll.shared";
import { isMetroLocation } from "../payroll/statutory";
import type { Declarations, Regime } from "../payroll/tax-engine";
import { toCsv } from "../payroll/csv";
import {
  allocate, annexureICsv, buildForm138Text, challanTotal, challansCsv, taxPart, validateDeductor, validateQuarter,
  type ChallanIn, type DeducteeIn, type DeductionIn, type Deductor, type Issue,
} from "./form138";
import { ANNEXURE_II_HEADER, annexureIIRow, computeForm16, type Form16Data, type MonthRecord } from "./form16";
import { loadOpeningMonths, loadOpeningYtd } from "./opening-ytd";
import { renderCertificatePdf, renderPerquisitesPdf, renderTdsSummaryPdf } from "./tax-documents-pdf";
import { PdfDocument } from "./pdf";
import { buildZip } from "./zip";
import type { ChallanDto, DeductorDto, PartAUploadDto, QuarterFilingDto, UpdateChallanDto } from "./returns.dto";
import {
  QUARTERS, certificateDueDate, depositDueDate, formNames, fyLabel, fyPeriods, inr, lateDepositInterest, quarterOfPeriod, quarterPeriods, quarterRange,
  statementDueDate, statementPan, type Quarter,
} from "./tds-math";

export const PART_A_ENTITY = "tax_document_part_a";
const PAID = ["PUBLISHED", "LOCKED"];
const GENERATE_BATCH = 20;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const round2 = (n: number) => Math.round(n * 100) / 100;
const iso = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : value ? String(value).slice(0, 10) : null);

type ChallanRow = ChallanIn & { version: number; notes: string | null; createdAt: string; allocatedAt: string | null };

@Injectable()
export class ReturnsService implements OnModuleInit {
  constructor(private readonly database: DatabaseService, private readonly files: FilesService) {}

  onModuleInit() {
    // TRACES Part A: payroll admins read/write; the employee reads their own once the FY's documents are published.
    this.files.registerPolicy(PART_A_ENTITY, async (identity, id, client) => {
      const row = (await client.query(
        `SELECT d.employee_id, s.status FROM tax_documents d JOIN tax_document_sets s ON s.id=d.set_id AND s.organization_id=d.organization_id
          WHERE d.organization_id=$1 AND d.id=$2`, [identity.organizationId, id])).rows[0];
      if (!row) return null;
      if (isPayrollAdmin(identity)) return "write";
      return row.employee_id === identity.employeeId && row.status === "PUBLISHED" ? "read" : null;
    });
  }

  // ================================================================ deductor profile

  private async deductor(client: PoolClient, organizationId: string) {
    const org = (await client.query(`SELECT name, legal_name, display_name FROM organizations WHERE id=$1`, [organizationId])).rows[0];
    const row = (await client.query(`SELECT * FROM tds_deductor_profiles WHERE organization_id=$1`, [organizationId])).rows[0];
    const responsiblePan = row?.responsible_pan_enc
      ? decryptField(row.responsible_pan_enc, { table: "tds_deductor_profiles", column: "responsible_pan", organizationId, rowId: organizationId }) : null;
    const deductor: Deductor = {
      tan: row?.tan || null, pan: row?.deductor_pan || null, name: row?.deductor_name || org?.legal_name || org?.name || null, category: row?.deductor_category || "K",
      gstin: row?.gstin || null, address: row?.address || {}, email: row?.email || null, phone: row?.phone || null,
      responsible: { ...(row?.responsible || {}), pan: responsiblePan },
    };
    return { deductor, version: row?.version || 0, responsiblePanLast4: row?.responsible_pan_last4 || null, organizationName: org?.display_name || org?.name || "" };
  }

  private presentDeductor(d: Awaited<ReturnType<ReturnsService["deductor"]>>) {
    return {
      ...d.deductor, responsible: { ...d.deductor.responsible, pan: undefined, panMasked: d.responsiblePanLast4 ? `XXXXXX${d.responsiblePanLast4}` : null },
      version: d.version, issues: validateDeductor(d.deductor),
    };
  }

  getDeductor(identity: AuthIdentity) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => this.presentDeductor(await this.deductor(client, identity.organizationId)));
  }

  updateDeductor(identity: AuthIdentity, input: DeductorDto) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const current = (await client.query(`SELECT * FROM tds_deductor_profiles WHERE organization_id=$1 FOR UPDATE`, [org])).rows[0];
      if ((current?.version || 0) !== input.version) throw new ConflictException("Deductor details changed since you opened them — reload and try again.");
      const { pan: responsiblePan, ...responsible } = input.responsible || {};
      const sealed = responsiblePan ? sealField("pan", responsiblePan.toUpperCase(), { table: "tds_deductor_profiles", column: "responsible_pan", organizationId: org, rowId: org }) : null;
      const values = [org, input.tan?.toUpperCase() || null, input.pan?.toUpperCase() || null, input.name?.trim() || null, input.category || "K", input.gstin?.toUpperCase() || null,
        JSON.stringify(input.address || {}), input.email || null, input.phone || null, JSON.stringify(responsible), identity.employeeId];
      if (current) {
        await client.query(
          `UPDATE tds_deductor_profiles SET tan=$2, deductor_pan=$3, deductor_name=$4, deductor_category=$5, gstin=$6, address=$7, email=$8, phone=$9, responsible=$10,
                  updated_by=$11, updated_at=now(), version=version+1 ${sealed ? ", responsible_pan_enc=$12, responsible_pan_hash=$13, responsible_pan_last4=$14" : ""}
            WHERE organization_id=$1`, sealed ? [...values, sealed.enc, sealed.hash, sealed.last4] : values);
      } else {
        await client.query(
          `INSERT INTO tds_deductor_profiles(organization_id,tan,deductor_pan,deductor_name,deductor_category,gstin,address,email,phone,responsible,updated_by,responsible_pan_enc,responsible_pan_hash,responsible_pan_last4)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [...values, sealed?.enc || null, sealed?.hash || null, sealed?.last4 || null]);
      }
      await audit(client, identity, "TDS_DEDUCTOR_UPDATED", "tds_deductor_profile", org,
        current ? { tan: current.tan, name: current.deductor_name } : null, { tan: values[1], name: values[3], responsiblePanChanged: Boolean(sealed) });
      return this.presentDeductor(await this.deductor(client, org));
    });
  }

  // ================================================================ challans

  private async challans(client: PoolClient, organizationId: string, fyStart: number, periods?: string[]) {
    const rows = (await client.query(
      `SELECT c.*, to_char(c.deposit_date,'YYYY-MM-DD') AS deposit_text FROM tds_challans c
        WHERE c.organization_id=$1 AND c.fy_start=$2 AND ($3::text[] IS NULL OR c.period = ANY($3)) ORDER BY c.period, c.deposit_date, c.challan_serial`,
      [organizationId, fyStart, periods || null])).rows;
    return rows.map((row): ChallanRow => ({
      id: row.id, period: row.period, bsrCode: row.bsr_code, challanSerial: row.challan_serial, depositDate: row.deposit_text, mode: row.mode, minorHead: row.minor_head,
      tax: Number(row.tax), surcharge: Number(row.surcharge), cess: Number(row.cess), interest: Number(row.interest), fee: Number(row.fee), penalty: Number(row.penalty),
      version: row.version, notes: row.notes, createdAt: row.created_at, allocatedAt: row.allocated_at,
    }));
  }

  private async quarterLocked(client: PoolClient, organizationId: string, fyStart: number, quarter: Quarter) {
    const row = (await client.query(`SELECT status FROM tds_returns WHERE organization_id=$1 AND fy_start=$2 AND quarter=$3`, [organizationId, fyStart, quarter])).rows[0];
    return row?.status === "FILED";
  }

  private checkChallan(input: ChallanDto) {
    const fyStart = Number(input.period.slice(5, 7)) >= 4 ? Number(input.period.slice(0, 4)) : Number(input.period.slice(0, 4)) - 1;
    const deposit = input.depositDate.slice(0, 10);
    if (deposit < `${input.period}-01`) throw new BadRequestException("The deposit date cannot be before the month of deduction.");
    if (deposit > new Date().toISOString().slice(0, 10)) throw new BadRequestException("The deposit date cannot be in the future.");
    if (round2(input.tax + (input.surcharge || 0) + (input.cess || 0)) <= 0) throw new BadRequestException("Enter the tax deposited.");
    return { fyStart, quarter: quarterOfPeriod(input.period), deposit };
  }

  createChallan(identity: AuthIdentity, input: ChallanDto) {
    requireAdmin(identity);
    const { fyStart, quarter, deposit } = this.checkChallan(input);
    return this.database.tenantTransaction(identity, async (client) => {
      if (await this.quarterLocked(client, identity.organizationId, fyStart, quarter)) throw new ConflictException(`${quarter} ${fyLabel(fyStart)} is marked as filed — mark it as draft before changing its challans (a correction statement may be needed).`);
      let row;
      try {
        row = (await client.query(
          `INSERT INTO tds_challans(organization_id,fy_start,quarter,period,mode,minor_head,bsr_code,challan_serial,deposit_date,tax,surcharge,cess,interest,fee,penalty,notes,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
          [identity.organizationId, fyStart, quarter, input.period, input.mode || "C", input.minorHead || "200", input.bsrCode, input.challanSerial, deposit,
            input.tax, input.surcharge || 0, input.cess || 0, input.interest || 0, input.fee || 0, input.penalty || 0, input.notes?.trim() || null, identity.employeeId])).rows[0];
      } catch (error: any) {
        if (error?.code === "23505") throw new ConflictException("A challan with this BSR code, date and serial number is already recorded.");
        throw error;
      }
      await audit(client, identity, "TDS_CHALLAN_CREATED", "tds_challan", row.id, null, { period: input.period, bsr: input.bsrCode, serial: input.challanSerial, date: deposit, tax: input.tax });
      return { id: row.id, fy: fyStart, quarter };
    });
  }

  updateChallan(identity: AuthIdentity, id: string, input: UpdateChallanDto) {
    requireAdmin(identity);
    const { fyStart, quarter, deposit } = this.checkChallan(input);
    return this.database.tenantTransaction(identity, async (client) => {
      const current = (await client.query(`SELECT * FROM tds_challans WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [identity.organizationId, id])).rows[0];
      if (!current) throw new NotFoundException("Challan not found.");
      if (current.version !== input.version) throw new ConflictException("This challan changed since you opened it — reload and try again.");
      for (const q of new Set([current.quarter, quarter]))
        if (await this.quarterLocked(client, identity.organizationId, q === current.quarter ? current.fy_start : fyStart, q)) throw new ConflictException(`${q} is marked as filed — mark it as draft first.`);
      await client.query(`DELETE FROM tds_challan_allocations WHERE organization_id=$1 AND challan_id=$2`, [identity.organizationId, id]);
      await client.query(
        `UPDATE tds_challans SET fy_start=$3, quarter=$4, period=$5, mode=$6, minor_head=$7, bsr_code=$8, challan_serial=$9, deposit_date=$10, tax=$11, surcharge=$12, cess=$13,
                interest=$14, fee=$15, penalty=$16, notes=$17, allocated_at=NULL, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, id, fyStart, quarter, input.period, input.mode || "C", input.minorHead || "200", input.bsrCode, input.challanSerial, deposit,
          input.tax, input.surcharge || 0, input.cess || 0, input.interest || 0, input.fee || 0, input.penalty || 0, input.notes?.trim() || null]);
      await audit(client, identity, "TDS_CHALLAN_UPDATED", "tds_challan", id,
        { period: current.period, bsr: current.bsr_code, serial: current.challan_serial, tax: Number(current.tax) }, { period: input.period, bsr: input.bsrCode, serial: input.challanSerial, tax: input.tax });
      return { id, fy: fyStart, quarter, reallocate: true };
    });
  }

  deleteChallan(identity: AuthIdentity, id: string) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const current = (await client.query(`SELECT * FROM tds_challans WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [identity.organizationId, id])).rows[0];
      if (!current) throw new NotFoundException("Challan not found.");
      if (await this.quarterLocked(client, identity.organizationId, current.fy_start, current.quarter)) throw new ConflictException(`${current.quarter} is marked as filed — mark it as draft first.`);
      await client.query(`DELETE FROM tds_challan_allocations WHERE organization_id=$1 AND challan_id=$2`, [identity.organizationId, id]);
      await client.query(`DELETE FROM tds_challans WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id]);
      await audit(client, identity, "TDS_CHALLAN_DELETED", "tds_challan", id,
        { period: current.period, bsr: current.bsr_code, serial: current.challan_serial, date: iso(current.deposit_date), tax: Number(current.tax) }, null);
      return { id, deleted: true };
    });
  }

  // ================================================================ deductions (source of truth: published/locked payroll + opening months)

  /** TDS deducted per employee per month in the given periods, from paid runs, plus pre-switch-over months. */
  private async deductions(client: PoolClient, organizationId: string, fyStart: number, periods: string[]) {
    const lines = (await client.query(
      `SELECT l.employee_id, l.run_id, r.period, r.status AS run_status, to_char(coalesce(r.pay_date, (r.period||'-01')::date + interval '1 month' - interval '1 day'),'YYYY-MM-DD') AS pay_date,
              l.tds::float AS tds, l.taxable_income::float AS taxable, l.gross::float AS gross
         FROM payroll_run_lines l JOIN payroll_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
        WHERE l.organization_id=$1 AND r.status = ANY($3) AND r.period = ANY($2) AND l.status='INCLUDED' AND (NOT l.held OR l.released_at IS NOT NULL)`,
      [organizationId, periods, PAID])).rows;
    const deductions: (DeductionIn & { source: "PAYROLL" | "OPENING" })[] = lines.map((row) => ({
      employeeId: row.employee_id, runId: row.run_id, period: row.period, paymentDate: row.pay_date, amountPaid: row.taxable || row.gross, tds: row.tds, source: "PAYROLL",
    }));
    const covered = new Set(deductions.map((d) => `${d.employeeId}:${d.period}`));
    for (const m of await loadOpeningMonths(client, organizationId, fyStart))
      if (periods.includes(m.period) && !covered.has(`${m.employeeId}:${m.period}`) && m.tds > 0) {
        const [y, mo] = m.period.split("-").map(Number);
        deductions.push({ employeeId: m.employeeId, runId: null, period: m.period, paymentDate: `${m.period}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0")}`, amountPaid: m.taxable || m.gross, tds: m.tds, source: "OPENING" });
      }
    return deductions;
  }

  private async runsByPeriod(client: PoolClient, organizationId: string, periods: string[]) {
    const rows = (await client.query(
      `SELECT DISTINCT ON (period) period, status, id, to_char(pay_date,'YYYY-MM-DD') AS pay_date FROM payroll_runs
        WHERE organization_id=$1 AND period = ANY($2) AND status <> 'CANCELLED' ORDER BY period, created_at DESC`, [organizationId, periods])).rows;
    return new Map(rows.map((row) => [row.period, row]));
  }

  /** Recomputes the quarter's allocations from scratch: payroll deductions → that month's challans. */
  allocateQuarter(identity: AuthIdentity, fyStart: number, quarter: Quarter) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      if (await this.quarterLocked(client, org, fyStart, quarter)) throw new ConflictException(`${quarter} is marked as filed — allocations are frozen.`);
      const periods = quarterPeriods(fyStart, quarter);
      const challans = await this.challans(client, org, fyStart, periods);
      const deductions = await this.deductions(client, org, fyStart, periods);
      const result = allocate(challans, deductions);
      await client.query(`DELETE FROM tds_challan_allocations a USING tds_challans c WHERE a.organization_id=$1 AND c.organization_id=$1 AND c.id=a.challan_id AND c.fy_start=$2 AND c.period = ANY($3)`, [org, fyStart, periods]);
      for (const a of result.allocations)
        await client.query(
          `INSERT INTO tds_challan_allocations(organization_id,challan_id,employee_id,run_id,period,amount_paid,tds,payment_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (challan_id, employee_id, run_id) DO UPDATE SET tds=tds_challan_allocations.tds+EXCLUDED.tds, amount_paid=tds_challan_allocations.amount_paid+EXCLUDED.amount_paid`,
          [org, a.challanId, a.employeeId, a.runId, a.period, a.amountPaid, a.tds, a.paymentDate]);
      await client.query(`UPDATE tds_challans SET allocated_at=now() WHERE organization_id=$1 AND fy_start=$2 AND period = ANY($3)`, [org, fyStart, periods]);
      const summary = {
        allocations: result.allocations.length, allocated: round2(result.allocations.reduce((t, a) => t + a.tds, 0)),
        unallocated: round2(result.unallocated.reduce((t, d) => t + d.tds, 0)), deducted: round2(deductions.reduce((t, d) => t + d.tds, 0)),
      };
      await audit(client, identity, "TDS_CHALLANS_ALLOCATED", "tds_return", org, null, { fy: fyStart, quarter, ...summary });
      return summary;
    });
  }

  // ================================================================ quarter workspace

  overview(identity: AuthIdentity, fyStart: number, quarter: Quarter) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const today = new Date().toISOString().slice(0, 10);
      const periods = quarterPeriods(fyStart, quarter);
      const deductor = await this.deductor(client, org);
      const challans = await this.challans(client, org, fyStart, periods);
      const deductions = await this.deductions(client, org, fyStart, periods);
      const runs = await this.runsByPeriod(client, org, periods);
      const allocations = (await client.query(
        `SELECT a.challan_id, a.employee_id, a.run_id, a.period, a.amount_paid::float, a.tds::float, to_char(a.payment_date,'YYYY-MM-DD') AS payment_date
           FROM tds_challan_allocations a JOIN tds_challans c ON c.id=a.challan_id AND c.organization_id=a.organization_id
          WHERE a.organization_id=$1 AND c.fy_start=$2 AND c.period = ANY($3)`, [org, fyStart, periods])).rows;
      const challanById = new Map(challans.map((c) => [c.id, c]));
      const months = periods.map((period) => {
        const deducted = round2(deductions.filter((d) => d.period === period).reduce((t, d) => t + d.tds, 0));
        const monthChallans = challans.filter((c) => c.period === period);
        const deposited = round2(monthChallans.reduce((t, c) => t + taxPart(c), 0));
        const allocated = round2(allocations.filter((a) => a.period === period).reduce((t, a) => t + a.tds, 0));
        const due = depositDueDate(period);
        const interest = allocations.filter((a) => a.period === period).reduce((t, a) => t + lateDepositInterest({ tds: a.tds, deductionDate: a.payment_date, depositDate: challanById.get(a.challan_id)!.depositDate, period }).interest, 0);
        const run = runs.get(period);
        const flags: { tone: "danger" | "warning" | "info"; message: string }[] = [];
        if (!run) flags.push({ tone: deductions.some((d) => d.period === period) ? "info" : "warning", message: deductions.some((d) => d.period === period) ? "Paid by the previous payroll system (opening YTD)." : "No payroll run for this month." });
        else if (!PAID.includes(run.status)) flags.push({ tone: "warning", message: `Payroll run is ${run.status.toLowerCase()} — TDS counts once it is published.` });
        else if (run.status !== "LOCKED") flags.push({ tone: "info", message: "Run published but not locked yet." });
        if (deducted > 0 && deposited + 0.5 < deducted) flags.push({ tone: today > due ? "danger" : "warning", message: `Deducted ₹${inr(deducted)} but deposited ₹${inr(deposited)}${today > due ? ` — overdue since ${due}` : ` — due ${due}`}.` });
        if (deposited > deducted + 0.5) flags.push({ tone: "warning", message: `Deposited ₹${inr(round2(deposited - deducted))} more than deducted.` });
        if (Math.abs(allocated - Math.min(deducted, deposited)) > 0.5 && monthChallans.length) flags.push({ tone: "warning", message: "Allocation is out of date — allocate again." });
        if (interest > 0) {
          const paid = monthChallans.reduce((t, c) => t + c.interest, 0);
          flags.push({ tone: paid + 0.5 < interest ? "danger" : "info", message: `Late deposit: estimated interest ₹${inr(interest)} (1.5% per month or part — UNVERIFIED method)${paid ? `; interest paid ₹${inr(paid)}` : ""}.` });
        }
        return {
          period, dueDate: due, run: run ? { id: run.id, status: run.status, payDate: run.pay_date } : null, deducted, deposited, allocated, estimatedInterest: interest, flags,
          employees: new Set(deductions.filter((d) => d.period === period && d.tds > 0).map((d) => d.employeeId)).size,
          challans: monthChallans.map((c) => {
            const used = round2(allocations.filter((a) => a.challan_id === c.id).reduce((t, a) => t + a.tds, 0));
            const late = c.depositDate > due;
            return { ...c, total: challanTotal(c), taxDeposited: taxPart(c), allocated: used, late, daysLate: late ? lateDepositInterest({ tds: 1, deductionDate: `${period}-01`, depositDate: c.depositDate, period }).daysLate : 0 };
          }),
        };
      });
      const validation = await this.validation(client, org, fyStart, quarter, deductor.deductor, challans, deductions, allocations);
      const status = (await client.query(`SELECT * FROM tds_returns WHERE organization_id=$1 AND fy_start=$2 ORDER BY quarter`, [org, fyStart])).rows;
      const quarterRow = status.find((row) => row.quarter === quarter);
      const set = (await client.query(`SELECT * FROM tax_document_sets WHERE organization_id=$1 AND fy_start=$2`, [org, fyStart])).rows[0];
      return {
        fy: fyStart, fyLabel: fyLabel(fyStart), quarter, periods, forms: formNames(fyStart), today,
        dueDates: { statement: statementDueDate(fyStart, quarter), certificate: certificateDueDate(fyStart) },
        deductor: this.presentDeductor(deductor), months,
        totals: { deducted: round2(months.reduce((t, m) => t + m.deducted, 0)), deposited: round2(months.reduce((t, m) => t + m.deposited, 0)), allocated: round2(months.reduce((t, m) => t + m.allocated, 0)), estimatedInterest: months.reduce((t, m) => t + m.estimatedInterest, 0) },
        validation,
        statement: {
          status: quarterRow?.status || "DRAFT", tokenNumber: quarterRow?.token_number || null, filedOn: iso(quarterRow?.filed_on), filedExternally: Boolean(quarterRow?.filed_externally),
          generatedAt: quarterRow?.generated_at || null, version: quarterRow?.version || 0,
          textAvailable: fyStart >= 2026 && quarter !== "Q4",
          textNote: fyStart < 2026 ? "Tax years before 2026-27 use Form 24Q: import the CSV into Protean RPU 6.0." : quarter === "Q4" ? "Protean has not yet published the Form 138 Q4 file format — use the Annexure I/II CSVs with the Protean RPU when it is released." : null,
        },
        quarters: QUARTERS.map((q) => { const row = status.find((r) => r.quarter === q); return { quarter: q, status: row?.status || "DRAFT", tokenNumber: row?.token_number || null, dueDate: statementDueDate(fyStart, q) }; }),
        documents: set ? { status: set.status, total: set.total, generated: set.generated, publishedAt: set.published_at } : { status: "DRAFT", total: 0, generated: 0, publishedAt: null },
      };
    });
  }

  private async validation(client: PoolClient, org: string, fyStart: number, quarter: Quarter, deductor: Deductor, challans: ChallanIn[], deductions: DeductionIn[], allocations: any[]) {
    const employees = await this.employeeInfo(client, org, [...new Set(allocations.map((a) => a.employee_id))]);
    const deductees: DeducteeIn[] = allocations.map((a) => {
      const e = employees.get(a.employee_id);
      // Overview validates PAN presence only (no decryption); the generated file re-validates the decrypted PAN.
      return { challanId: a.challan_id, employeeId: a.employee_id, runId: a.run_id, period: a.period, paymentDate: a.payment_date, amountPaid: a.amount_paid, tds: a.tds,
        employeeNumber: e?.number || "?", name: e?.name || "?", pan: e?.hasPan ? "AAAPA0000A" : null };
    });
    const allocatedKey = new Map<string, number>();
    for (const a of allocations) allocatedKey.set(`${a.employee_id}:${a.period}`, (allocatedKey.get(`${a.employee_id}:${a.period}`) || 0) + a.tds);
    const unallocated = deductions.map((d) => ({ ...d, tds: round2(d.tds - (allocatedKey.get(`${d.employeeId}:${d.period}`) || 0)) })).filter((d) => d.tds > 0.005);
    const issues: Issue[] = [...validateDeductor(deductor), ...validateQuarter({ fyStart, quarter, challans, deductees, deductedTotal: deductions.reduce((t, d) => t + d.tds, 0), unallocated })];
    return {
      errors: issues.filter((i) => i.level === "error"), warnings: issues.filter((i) => i.level === "warning"),
      deducteeRows: deductees.length, deductees: new Set(deductees.map((d) => d.employeeId)).size, challans: challans.length,
      challanTotal: round2(challans.reduce((t, c) => t + taxPart(c), 0)), deducteeTotal: round2(deductees.reduce((t, d) => t + d.tds, 0)),
    };
  }

  private async employeeInfo(client: PoolClient, org: string, ids: string[]) {
    if (!ids.length) return new Map<string, { number: string; name: string; hasPan: boolean; profile: any }>();
    const rows = (await client.query(
      `SELECT e.id, e.employee_number, e.full_name, p.organization_id AS p_org, p.employee_id AS p_emp, p.pan_enc, p.pan_last4
         FROM employees e LEFT JOIN payroll_profiles p ON p.organization_id=e.organization_id AND p.employee_id=e.id
        WHERE e.organization_id=$1 AND e.id = ANY($2)`, [org, ids])).rows;
    return new Map(rows.map((row) => [row.id, { number: row.employee_number, name: row.full_name, hasPan: Boolean(row.pan_enc), profile: row.p_org ? { organization_id: row.p_org, employee_id: row.p_emp, pan_enc: row.pan_enc } : null }]));
  }

  recordFiling(identity: AuthIdentity, fyStart: number, quarter: Quarter, input: QuarterFilingDto) {
    requireAdmin(identity);
    if (input.status === "FILED" && !input.tokenNumber) throw new BadRequestException("Enter the 15-digit token / provisional receipt number of the filed statement.");
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const before = (await client.query(`SELECT status, token_number FROM tds_returns WHERE organization_id=$1 AND fy_start=$2 AND quarter=$3`, [org, fyStart, quarter])).rows[0] || null;
      await client.query(
        `INSERT INTO tds_returns(organization_id,fy_start,quarter,status,token_number,filed_on,filed_externally) VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (organization_id,fy_start,quarter) DO UPDATE SET status=$4, token_number=$5, filed_on=$6, filed_externally=$7, version=tds_returns.version+1, updated_at=now()`,
        [org, fyStart, quarter, input.status === "FILED" ? "FILED" : "DRAFT", input.status === "FILED" ? input.tokenNumber : null, input.status === "FILED" ? (input.filedOn || new Date().toISOString().slice(0, 10)) : null, Boolean(input.filedExternally)]);
      await audit(client, identity, input.status === "FILED" ? "TDS_RETURN_FILED" : "TDS_RETURN_REOPENED", "tds_return", org, before, { fy: fyStart, quarter, status: input.status, token: input.tokenNumber || null });
      return { fy: fyStart, quarter, status: input.status };
    });
  }

  // ================================================================ statement files

  async statementFile(identity: AuthIdentity, fyStart: number, quarter: Quarter, kind: string) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const periods = quarterPeriods(fyStart, quarter);
      const { deductor, organizationName } = await this.deductor(client, org);
      const challans = await this.challans(client, org, fyStart, periods);
      const deductions = await this.deductions(client, org, fyStart, periods);
      const allocations = (await client.query(
        `SELECT a.challan_id, a.employee_id, a.run_id, a.period, a.amount_paid::float, a.tds::float, to_char(a.payment_date,'YYYY-MM-DD') AS payment_date
           FROM tds_challan_allocations a JOIN tds_challans c ON c.id=a.challan_id AND c.organization_id=a.organization_id
          WHERE a.organization_id=$1 AND c.fy_start=$2 AND c.period = ANY($3)`, [org, fyStart, periods])).rows;
      const employees = await this.employeeInfo(client, org, [...new Set([...allocations.map((a) => a.employee_id), ...deductions.map((d) => d.employeeId)])]);
      const needsPan = kind === "form138" || kind === "annexure1" || kind === "annexure2";
      const panOf = (employeeId: string) => { const e = employees.get(employeeId); return needsPan && e?.profile ? decryptProfileField(e.profile, "pan") : null; };
      const deductees: DeducteeIn[] = allocations.map((a) => ({
        challanId: a.challan_id, employeeId: a.employee_id, runId: a.run_id, period: a.period, paymentDate: a.payment_date, amountPaid: a.amount_paid, tds: a.tds,
        employeeNumber: employees.get(a.employee_id)?.number || "?", name: employees.get(a.employee_id)?.name || "?", pan: panOf(a.employee_id),
      }));
      const allocatedKey = new Map<string, number>();
      for (const a of allocations) allocatedKey.set(`${a.employee_id}:${a.period}`, (allocatedKey.get(`${a.employee_id}:${a.period}`) || 0) + a.tds);
      const unallocated = deductions.map((d) => ({ ...d, tds: round2(d.tds - (allocatedKey.get(`${d.employeeId}:${d.period}`) || 0)) })).filter((d) => d.tds > 0.005);
      const issues = [...validateDeductor(deductor), ...validateQuarter({ fyStart, quarter, challans, deductees, deductedTotal: deductions.reduce((t, d) => t + d.tds, 0), unallocated })];
      const errors = issues.filter((i) => i.level === "error");
      const tag = `${fyLabel(fyStart)}-${quarter}`;
      let file: { body: string | Buffer; name: string; type: string; rows: number };
      switch (kind) {
        case "form138": {
          if (fyStart < 2026 || quarter === "Q4") throw new ConflictException(fyStart < 2026 ? "Tax years before 2026-27 use Form 24Q: download the CSVs and prepare the file in Protean RPU 6.0." : "Protean has not yet published the Form 138 Q4 file format — use the Annexure I / II CSVs with the Protean RPU.");
          if (errors.length) throw new ConflictException({ message: `Fix ${errors.length} validation error(s) before generating the statement file.`, errors });
          let previous: string | null = null;
          const prior = QUARTERS.slice(0, QUARTERS.indexOf(quarter)).reverse();
          for (const q of prior) { const row = (await client.query(`SELECT token_number FROM tds_returns WHERE organization_id=$1 AND fy_start=$2 AND quarter=$3 AND status='FILED'`, [org, fyStart, q])).rows[0]; if (row?.token_number) { previous = row.token_number; break; } }
          let text: string;
          try { text = buildForm138Text({ fyStart, quarter, deductor, challans, deductees, previousToken: previous, createdOn: new Date().toISOString().slice(0, 10) }); }
          catch (error) { throw new ConflictException((error as Error).message); }
          file = { body: text, name: `${formNames(fyStart).quarterly.replace(/\s+/g, "")}_${deductor.tan}_${tag}.txt`, type: "text/plain", rows: deductees.length };
          await client.query(
            `INSERT INTO tds_returns(organization_id,fy_start,quarter,status,generated_by,generated_at,file_sha256,validation) VALUES($1,$2,$3,'GENERATED',$4,now(),$5,$6)
             ON CONFLICT (organization_id,fy_start,quarter) DO UPDATE SET status=CASE WHEN tds_returns.status='FILED' THEN 'FILED' ELSE 'GENERATED' END,
               generated_by=$4, generated_at=now(), file_sha256=$5, validation=$6, version=tds_returns.version+1, updated_at=now()`,
            [org, fyStart, quarter, identity.employeeId, sha256(text), JSON.stringify({ warnings: issues.filter((i) => i.level === "warning").length, deductees: deductees.length, challans: challans.length })]);
          break;
        }
        case "annexure1": file = { body: annexureICsv({ fyStart, quarter, challans, deductees }), name: `annexure-I-${tag}.csv`, type: "text/csv", rows: deductees.length }; break;
        case "challans": {
          const withAllocated = challans.map((c) => ({ ...c, allocated: allocations.filter((a) => a.challan_id === c.id).reduce((t, a) => t + a.tds, 0) }));
          file = { body: challansCsv(withAllocated, fyStart, quarter), name: `challans-${tag}.csv`, type: "text/csv", rows: challans.length }; break;
        }
        case "annexure2": {
          if (quarter !== "Q4") throw new BadRequestException("Annexure II (salary details) is part of the Q4 statement only.");
          const docs = (await client.query(`SELECT d.employee_id, d.data FROM tax_documents d WHERE d.organization_id=$1 AND d.fy_start=$2 AND d.generated_at IS NOT NULL`, [org, fyStart])).rows;
          if (!docs.length) throw new ConflictException("Generate the annual certificates first — Annexure II uses the same computation.");
          const all = await this.employeeInfo(client, org, docs.map((d) => d.employee_id));
          const rows: unknown[][] = [[`Annexure II — salary details · ${formNames(fyStart).quarterly} Q4 · ${fyLabel(fyStart)} · CSV template (Protean Q4 layout pending — UNVERIFIED column set)`], [], ANNEXURE_II_HEADER];
          for (const d of docs) { const e = all.get(d.employee_id); rows.push(annexureIIRow(d.data as Form16Data, statementPan(e?.profile ? decryptProfileField(e.profile, "pan") : null).value)); }
          file = { body: toCsv(rows), name: `annexure-II-${tag}.csv`, type: "text/csv", rows: docs.length }; break;
        }
        case "review": file = { body: this.reviewPdf({ fyStart, quarter, organizationName, deductor, challans, deductees, deductions, issues, allocations }), name: `review-${tag}.pdf`, type: "application/pdf", rows: deductees.length }; break;
        default: throw new NotFoundException("Unknown file.");
      }
      const digest = sha256(file.body);
      await auditRead(client, identity, "TDS_RETURN_EXPORTED", "tds_return", org, { fy: fyStart, quarter, kind, rows: file.rows, sha256: digest, containsPan: needsPan });
      return { ...file, sha256: digest };
    });
  }

  private reviewPdf(input: { fyStart: number; quarter: Quarter; organizationName: string; deductor: Deductor; challans: ChallanIn[]; deductees: DeducteeIn[]; deductions: DeductionIn[]; issues: Issue[]; allocations: any[] }) {
    const names = formNames(input.fyStart);
    const doc = new PdfDocument({ title: `${names.quarterly} review ${input.quarter} ${fyLabel(input.fyStart)}`, author: input.organizationName });
    doc.paragraph(input.organizationName, { size: 9, color: "#60757b", gap: 0 });
    doc.paragraph(`${names.quarterly} (formerly ${names.quarterlyOld}) - review report - ${input.quarter} ${names.yearLabel}`, { size: 14, bold: true, color: "#0b615c" });
    doc.paragraph(`TAN ${input.deductor.tan || "not set"} · statement due ${statementDueDate(input.fyStart, input.quarter)} · generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, { size: 8.5, color: "#60757b", gap: 10 });
    const deducted = round2(input.deductions.reduce((t, d) => t + d.tds, 0));
    const deposited = round2(input.challans.reduce((t, c) => t + taxPart(c), 0));
    const mapped = round2(input.deductees.reduce((t, d) => t + d.tds, 0));
    doc.paragraph(`TDS deducted in payroll: Rs. ${inr(deducted)}   ·   tax deposited (challans): Rs. ${inr(deposited)}   ·   mapped to deductees: Rs. ${inr(mapped)}   ·   deductee rows: ${input.deductees.length} (${new Set(input.deductees.map((d) => d.employeeId)).size} employees)`, { size: 9, bold: true, gap: 8 });
    doc.paragraph(`Validation: ${input.issues.filter((i) => i.level === "error").length} error(s), ${input.issues.filter((i) => i.level === "warning").length} warning(s)`, { size: 10.5, bold: true, color: "#0b615c" });
    for (const issue of input.issues) doc.paragraph(`${issue.level === "error" ? "ERROR" : "Warning"} ${issue.code}: ${issue.message}`, { size: 8, color: issue.level === "error" ? "#b42318" : "#8a5a00", gap: 1 });
    if (!input.issues.length) doc.paragraph("No issues found.", { size: 8.5 });
    doc.y -= 6;
    doc.paragraph("Challans", { size: 10.5, bold: true, color: "#0b615c" });
    for (const c of input.challans) {
      const used = round2(input.deductees.filter((d) => d.challanId === c.id).reduce((t, d) => t + d.tds, 0));
      doc.paragraph(`${c.period} · BSR ${c.bsrCode} · serial ${c.challanSerial} · ${c.depositDate}${c.depositDate > depositDueDate(c.period) ? " (LATE)" : ""} · tax Rs. ${inr(taxPart(c))} · interest Rs. ${inr(c.interest)} · fee Rs. ${inr(c.fee)} · mapped Rs. ${inr(used)}`, { size: 8, gap: 1 });
    }
    doc.y -= 6;
    doc.paragraph("Deductees (Annexure I)", { size: 10.5, bold: true, color: "#0b615c" });
    for (const d of [...input.deductees].sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber) || a.period.localeCompare(b.period))) {
      const pan = statementPan(d.pan);
      doc.paragraph(`${d.employeeNumber} ${d.name} · ${pan.valid ? `PAN ending ${pan.value.slice(6)}` : pan.value} · ${d.period} · paid ${d.paymentDate} Rs. ${inr(d.amountPaid)} · TDS Rs. ${inr(d.tds)}${pan.valid ? "" : " · remark C"}`, { size: 7.8, gap: 0.5 });
    }
    doc.y -= 6;
    doc.paragraph(`Before upload: validate the text file with Protean FVU 1.2 (Form 138, TY 2026-27 onward) together with the .csi challan file from the TIN site. File layout per Protean "Form Number 138-24Q - Q1 to Q3" file format; Q4 layout not yet published. ${names.note}`, { size: 7.5, color: "#60757b" });
    return doc.toBuffer({ footer: (p, t) => `${names.quarterly} review ${input.quarter} ${fyLabel(input.fyStart)} · page ${p} of ${t}` });
  }

  // ================================================================ annual certificates

  private async certificateScope(client: PoolClient, org: string, fyStart: number) {
    const periods = fyPeriods(fyStart);
    const rows = (await client.query(
      `SELECT DISTINCT l.employee_id FROM payroll_run_lines l JOIN payroll_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
        WHERE l.organization_id=$1 AND r.status = ANY($3) AND r.period = ANY($2) AND l.status='INCLUDED' AND (NOT l.held OR l.released_at IS NOT NULL)`, [org, periods, PAID])).rows;
    const ids = new Set(rows.map((row) => row.employee_id as string));
    const openingIds = await (async () => {
      await client.query("SAVEPOINT scope_opening");
      try {
        const exists = (await client.query(`SELECT to_regclass('public.payroll_ytd_opening') IS NOT NULL AS ok`)).rows[0]?.ok;
        const found = exists ? (await client.query(`SELECT employee_id FROM payroll_ytd_opening WHERE organization_id=$1 AND fiscal_year=$2`, [org, fyLabel(fyStart)])).rows.map((r) => r.employee_id as string) : [];
        await client.query("RELEASE SAVEPOINT scope_opening"); return found;
      } catch { await client.query("ROLLBACK TO SAVEPOINT scope_opening"); return [] as string[]; }
    })();
    for (const id of openingIds) ids.add(id);
    return [...ids];
  }

  private async buildCertificate(client: PoolClient, org: string, fyStart: number, employeeId: string, context: { deductor: Awaited<ReturnType<ReturnsService["deductor"]>>; receipts: any[] }) {
    const periods = fyPeriods(fyStart);
    const employee = (await client.query(
      `SELECT e.*, to_char(e.joining_date,'YYYY-MM-DD') AS joining_text FROM employees e WHERE e.organization_id=$1 AND e.id=$2`, [org, employeeId])).rows[0];
    if (!employee) throw new NotFoundException("Employee not found.");
    const profile = (await client.query(`SELECT * FROM payroll_profiles WHERE organization_id=$1 AND employee_id=$2`, [org, employeeId])).rows[0];
    const lines = (await client.query(
      `SELECT r.period, to_char(coalesce(r.pay_date,(r.period||'-01')::date + interval '1 month' - interval '1 day'),'YYYY-MM-DD') AS pay_date, l.gross::float, l.taxable_income::float AS taxable,
              l.tds::float, l.pf_employee::float AS pf, l.pt::float, l.breakdown
         FROM payroll_run_lines l JOIN payroll_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
        WHERE l.organization_id=$1 AND l.employee_id=$2 AND r.status = ANY($4) AND r.period = ANY($3) AND l.status='INCLUDED' AND (NOT l.held OR l.released_at IS NOT NULL)
        ORDER BY r.period`, [org, employeeId, periods, PAID])).rows;
    const months: MonthRecord[] = lines.map((row) => {
      const b = row.breakdown || {};
      const earnings = [...(b.earnings || []), ...(b.oneTime || [])].map((e: any) => ({ code: String(e.code), label: String(e.label), amount: Number(e.amount) || 0, taxable: e.taxable !== false }));
      return {
        period: row.period, payDate: row.pay_date, earnings: earnings.length ? earnings : [{ code: "SALARY", label: "Salary", amount: row.taxable, taxable: true }],
        gross: row.gross, taxable: row.taxable, tds: row.tds, pf: row.pf, pt: row.pt,
        employerPf: Number(b.statutory?.pf?.employerTotal) || 0, employerNps: 0,
      };
    });
    const last = lines[lines.length - 1]?.breakdown || {};
    const accepted = (await loadAcceptedDeclarations(client, org, [employeeId], fyLabel(fyStart))).get(employeeId);
    const declarations: Declarations = { ...(profile?.declarations || {}), ...(accepted?.declarations || {}) };
    const regime: Regime = (accepted?.regime || last.statutory?.tds?.regime || last.employee?.regime || profile?.tax_regime || "NEW") === "OLD" ? "OLD" : "NEW";
    const flags = statutoryFlags(profile?.statutory_flags);
    const structure = (await client.query(`SELECT is_metro FROM salary_structures WHERE organization_id=$1 AND employee_id=$2 ORDER BY effective_from DESC LIMIT 1`, [org, employeeId])).rows[0];
    const opening = (await loadOpeningYtd(client, org, fyStart, [employeeId])).get(employeeId) || null;
    const challans = (await client.query(
      `SELECT c.period, c.bsr_code, c.challan_serial, to_char(c.deposit_date,'YYYY-MM-DD') AS deposit_date, c.quarter, sum(a.tds)::float AS tds
         FROM tds_challan_allocations a JOIN tds_challans c ON c.id=a.challan_id AND c.organization_id=a.organization_id
        WHERE a.organization_id=$1 AND a.employee_id=$2 AND c.fy_start=$3 GROUP BY 1,2,3,4,5 ORDER BY 1,4`, [org, employeeId, fyStart])).rows;
    const d = context.deductor;
    const addr = d.deductor.address || {};
    const lastPeriod = months[months.length - 1]?.period || opening?.throughPeriod || null;
    // No exit date is recorded on employees: an inactive employee's period ends with the last month paid (approximation).
    const exitDate = employee.status !== "ACTIVE" && lastPeriod
      ? `${lastPeriod}-${String(new Date(Date.UTC(Number(lastPeriod.slice(0, 4)), Number(lastPeriod.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}` : null;
    const data = computeForm16({
      fyStart, regime, ageCategory: declarations.ageCategory || flags.ageCategory, metro: Boolean(structure?.is_metro) || isMetroLocation(employee.location, lastPeriod || `${fyStart}-04`),
      employee: { id: employeeId, number: employee.employee_number, name: employee.full_name, designation: employee.designation, joiningDate: employee.joining_text, panMasked: maskedField(profile, "pan"), hasPan: Boolean(profile?.pan_enc) },
      employer: {
        name: d.deductor.name || d.organizationName, tan: d.deductor.tan, panMasked: d.deductor.pan ? `${d.deductor.pan.slice(0, 2)}XXXX${d.deductor.pan.slice(6)}` : null,
        address: [addr.line1, addr.line2, addr.line3, addr.line4, addr.line5, addr.pincode].filter(Boolean).join(", "),
        responsibleName: d.deductor.responsible?.name || null, responsibleDesignation: d.deductor.responsible?.designation || null,
      },
      months, opening, declarations, exitDate,
      receipts: context.receipts.map((row) => ({ quarter: row.quarter, token: row.token_number, status: row.status })),
      challans: challans.map((row) => ({ period: row.period, bsrCode: row.bsr_code, challanSerial: row.challan_serial, depositDate: row.deposit_date, tds: row.tds, quarter: row.quarter })),
    });
    return data;
  }

  private async ensureSet(client: PoolClient, org: string, fyStart: number) {
    await client.query(`INSERT INTO tax_document_sets(organization_id,fy_start) VALUES($1,$2) ON CONFLICT (organization_id,fy_start) DO NOTHING`, [org, fyStart]);
    return (await client.query(`SELECT * FROM tax_document_sets WHERE organization_id=$1 AND fy_start=$2 FOR UPDATE`, [org, fyStart])).rows[0];
  }

  /** Generates (a batch of) certificates. Call repeatedly until status is GENERATED; `restart` starts a fresh pass. */
  generate(identity: AuthIdentity, fyStart: number, restart: boolean) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      let set = await this.ensureSet(client, org, fyStart);
      if (set.status === "PUBLISHED") throw new ConflictException(`Certificates for ${fyLabel(fyStart)} are published and frozen.`);
      const scope = await this.certificateScope(client, org, fyStart);
      if (restart || set.status !== "GENERATING") {
        set = (await client.query(
          `UPDATE tax_document_sets SET status='GENERATING', total=$3, generated=0, generated_by=$4, generated_at=clock_timestamp(), version=version+1, updated_at=now()
            WHERE organization_id=$1 AND fy_start=$2 RETURNING *`, [org, fyStart, scope.length, identity.employeeId])).rows[0];
        await audit(client, identity, "TAX_DOCUMENTS_GENERATION_STARTED", "tax_document_set", set.id, null, { fy: fyStart, employees: scope.length });
      } else if (set.generated_by !== identity.employeeId) {
        // Whoever continues the pass becomes the preparer (maker-checker is checked against generated_by).
        await client.query(`UPDATE tax_document_sets SET generated_by=$3 WHERE organization_id=$1 AND fy_start=$2`, [org, fyStart, identity.employeeId]);
      }
      const done = new Set((await client.query(`SELECT employee_id FROM tax_documents WHERE organization_id=$1 AND fy_start=$2 AND generated_at >= $3`, [org, fyStart, set.generated_at])).rows.map((r) => r.employee_id));
      const pending = scope.filter((id) => !done.has(id)).slice(0, GENERATE_BATCH);
      const deductor = await this.deductor(client, org);
      const receipts = (await client.query(`SELECT quarter, token_number, status FROM tds_returns WHERE organization_id=$1 AND fy_start=$2`, [org, fyStart])).rows;
      for (const employeeId of pending) {
        const data = await this.buildCertificate(client, org, fyStart, employeeId, { deductor, receipts });
        const json = JSON.stringify(data);
        await client.query(
          `INSERT INTO tax_documents(organization_id,set_id,fy_start,employee_id,data,warnings,data_sha256,generated_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp())
           ON CONFLICT (organization_id,fy_start,employee_id) DO UPDATE SET data=$5, warnings=$6, data_sha256=$7, generated_at=clock_timestamp(), set_id=$2`,
          [org, set.id, fyStart, employeeId, json, JSON.stringify(data.warnings), sha256(json)]);
      }
      // Documents of employees no longer in scope (e.g. a run was cancelled) are dropped from an unpublished set.
      await client.query(`DELETE FROM tax_documents WHERE organization_id=$1 AND fy_start=$2 AND NOT (employee_id = ANY($3)) AND part_a_file_id IS NULL`, [org, fyStart, scope]);
      const generated = done.size + pending.length;
      const complete = generated >= scope.length;
      await client.query(`UPDATE tax_document_sets SET generated=$3, total=$4, status=$5, updated_at=now() WHERE organization_id=$1 AND fy_start=$2`,
        [org, fyStart, Math.min(generated, scope.length), scope.length, complete ? "GENERATED" : "GENERATING"]);
      if (complete) await audit(client, identity, "TAX_DOCUMENTS_GENERATED", "tax_document_set", set.id, null, { fy: fyStart, employees: scope.length });
      return { fy: fyStart, status: complete ? "GENERATED" : "GENERATING", total: scope.length, generated: Math.min(generated, scope.length) };
    });
  }

  listDocuments(identity: AuthIdentity, fyStart: number) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const set = (await client.query(
        `SELECT s.*, g.full_name AS generated_by_name, p.full_name AS published_by_name FROM tax_document_sets s
           LEFT JOIN employees g ON g.id=s.generated_by AND g.organization_id=s.organization_id LEFT JOIN employees p ON p.id=s.published_by AND p.organization_id=s.organization_id
          WHERE s.organization_id=$1 AND s.fy_start=$2`, [org, fyStart])).rows[0];
      const rows = (await client.query(
        `SELECT d.id, d.employee_id, e.employee_number, e.full_name, e.status AS employee_status, d.warnings, d.generated_at, d.part_a_file_id,
                (d.data->'partB'->>'netTaxPayable')::float AS tax, (d.data->'partB'->>'tdsTotal')::float AS tds, (d.data->'partB'->>'grossSalary')::float AS gross,
                d.data->>'regime' AS regime, f.original_name AS part_a_name
           FROM tax_documents d JOIN employees e ON e.id=d.employee_id AND e.organization_id=d.organization_id
           LEFT JOIN stored_files f ON f.id=d.part_a_file_id AND f.organization_id=d.organization_id AND f.deleted_at IS NULL
          WHERE d.organization_id=$1 AND d.fy_start=$2 ORDER BY e.employee_number`, [org, fyStart])).rows;
      const block = set ? this.publishBlock(identity, set) : { reason: "Generate the certificates first." };
      return {
        fy: fyStart, fyLabel: fyLabel(fyStart), forms: formNames(fyStart), dueDate: certificateDueDate(fyStart),
        set: set ? { id: set.id, status: set.status, total: set.total, generated: set.generated, generatedBy: set.generated_by_name, generatedAt: set.generated_at,
          publishedBy: set.published_by_name, publishedAt: set.published_at, version: set.version } : { status: "DRAFT", total: 0, generated: 0 },
        canPublish: !block, publishBlockedReason: block?.reason || null,
        items: rows.map((row) => ({
          id: row.id, employeeId: row.employee_id, number: row.employee_number, name: row.full_name, employeeStatus: row.employee_status, regime: row.regime,
          gross: row.gross, tax: row.tax, tds: row.tds, balance: (row.tax || 0) - (row.tds || 0), warnings: row.warnings, generatedAt: row.generated_at,
          partA: row.part_a_file_id ? { id: row.part_a_file_id, name: row.part_a_name } : null,
        })),
      };
    });
  }

  /** Maker-checker for publication (mirrors payroll.shared bankFileBlock): payroll admin / owner only, never the preparer. */
  private publishBlock(identity: AuthIdentity, set: any): { status: 403 | 409; reason: string } | null {
    if (!identity.roles.some((role) => BANK_FILE_ROLES.includes(role))) return { status: 403, reason: "Only a payroll administrator or the owner can publish tax certificates." };
    if (set.status === "PUBLISHED") return { status: 409, reason: "Already published." };
    if (set.status !== "GENERATED") return { status: 409, reason: "Generate the certificates for every employee first." };
    if (set.generated_by === identity.employeeId) return { status: 403, reason: "Segregation of duties: the person who generated the certificates cannot publish them. Ask another payroll admin or the owner to review and publish." };
    return null;
  }

  publish(identity: AuthIdentity, fyStart: number, version: number) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const set = (await client.query(`SELECT * FROM tax_document_sets WHERE organization_id=$1 AND fy_start=$2 FOR UPDATE`, [org, fyStart])).rows[0];
      if (!set) throw new NotFoundException("Nothing generated for this year yet.");
      if (set.version !== version) throw new ConflictException("The certificates changed since you opened them — reload and review again.");
      const block = this.publishBlock(identity, set);
      if (block) throw block.status === 403 ? new ForbiddenException(block.reason) : new ConflictException(block.reason);
      await client.query(`UPDATE tax_document_sets SET status='PUBLISHED', published_by=$3, published_at=now(), version=version+1, updated_at=now() WHERE organization_id=$1 AND fy_start=$2`, [org, fyStart, identity.employeeId]);
      const employees = (await client.query(`SELECT employee_id FROM tax_documents WHERE organization_id=$1 AND fy_start=$2`, [org, fyStart])).rows;
      const names = formNames(fyStart);
      for (const row of employees)
        await notify(client, org, row.employee_id, "TAX_DOCUMENTS_PUBLISHED", "tax_document_set", set.id,
          { message: `Your ${names.certificate} (${names.certificateOld}) and TDS summary for ${names.yearLabel} are ready to download.`, link: "/payroll/returns/documents" });
      await audit(client, identity, "TAX_DOCUMENTS_PUBLISHED", "tax_document_set", set.id, { status: set.status, generatedBy: set.generated_by }, { status: "PUBLISHED", employees: employees.length });
      return { fy: fyStart, status: "PUBLISHED", employees: employees.length };
    });
  }

  // ================================================================ downloads (admin: any employee; employee: own, once published)

  async uploadPartA(identity: AuthIdentity, fyStart: number, employeeId: string, input: PartAUploadDto) {
    requireAdmin(identity);
    const doc = await this.database.tenantTransaction(identity, async (client) =>
      (await client.query(`SELECT id, part_a_file_id FROM tax_documents WHERE organization_id=$1 AND fy_start=$2 AND employee_id=$3`, [identity.organizationId, fyStart, employeeId])).rows[0]);
    if (!doc) throw new NotFoundException("Generate this employee's certificate before attaching Part A.");
    const stored = await this.files.upload(identity, { entityType: PART_A_ENTITY, entityId: doc.id, category: "TRACES_PART_A", originalName: input.originalName, mimeType: input.mimeType, base64: input.base64 });
    return this.database.tenantTransaction(identity, async (client) => {
      await client.query(`UPDATE tax_documents SET part_a_file_id=$3 WHERE organization_id=$1 AND id=$2`, [identity.organizationId, doc.id, stored.id]);
      await audit(client, identity, "TAX_PART_A_ATTACHED", "tax_document", doc.id, doc.part_a_file_id ? { fileId: doc.part_a_file_id } : null, { fileId: stored.id, fy: fyStart, employeeId });
      return { id: doc.id, partA: { id: stored.id, name: stored.originalName } };
    });
  }

  async document(identity: AuthIdentity, fyStart: number, employeeId: string, kind: string) {
    if (!["certificate", "perquisites", "tds-summary", "part-a"].includes(kind)) throw new NotFoundException("Document not found.");
    const admin = isPayrollAdmin(identity);
    if (!admin && employeeId !== identity.employeeId) throw new NotFoundException("Document not found.");
    const loaded = await this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const row = (await client.query(
        `SELECT d.*, s.status AS set_status FROM tax_documents d JOIN tax_document_sets s ON s.id=d.set_id AND s.organization_id=d.organization_id
          WHERE d.organization_id=$1 AND d.fy_start=$2 AND d.employee_id=$3 AND d.generated_at IS NOT NULL`, [org, fyStart, employeeId])).rows[0];
      if (!row || (!admin && row.set_status !== "PUBLISHED")) throw new NotFoundException("Document not found.");
      if (kind === "part-a") return { row, data: row.data as Form16Data, pan: "" };
      const profile = (await client.query(`SELECT organization_id, employee_id, pan_enc FROM payroll_profiles WHERE organization_id=$1 AND employee_id=$2`, [org, employeeId])).rows[0];
      const pan = statementPan(profile ? decryptProfileField(profile, "pan") : null).value;
      await auditRead(client, identity, "TAX_DOCUMENT_DOWNLOADED", "tax_document", row.id, { fy: fyStart, kind, employeeId, own: employeeId === identity.employeeId, published: row.set_status === "PUBLISHED" });
      let months: { period: string; taxable: number; tds: number }[] = [];
      if (kind === "tds-summary") months = (await client.query(
        `SELECT r.period, l.taxable_income::float AS taxable, l.tds::float AS tds FROM payroll_run_lines l JOIN payroll_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
          WHERE l.organization_id=$1 AND l.employee_id=$2 AND r.status = ANY($4) AND r.period = ANY($3) AND l.status='INCLUDED' AND (NOT l.held OR l.released_at IS NOT NULL) ORDER BY r.period`,
        [org, employeeId, fyPeriods(fyStart), PAID])).rows;
      return { row, data: row.data as Form16Data, pan, months };
    });
    const { row, data } = loaded;
    const base = `${data.employee.number}_${data.fyLabel}`;
    if (kind === "part-a") {
      if (!row.part_a_file_id) throw new NotFoundException("Part A has not been attached yet.");
      const file = await this.files.download(identity, row.part_a_file_id);
      return { bytes: file.bytes, name: file.name, type: "application/pdf" };
    }
    if (kind === "certificate") {
      let partA = null;
      if (row.part_a_file_id) { const file = await this.files.download(identity, row.part_a_file_id); partA = { name: file.name.endsWith(".pdf") ? file.name : `${file.name}.pdf`, bytes: file.bytes, description: "TRACES Part A (original, digitally signed)" }; }
      return { bytes: renderCertificatePdf(data, loaded.pan, partA), name: `${data.forms.certificate.replace(/\s+/g, "")}_${base}.pdf`, type: "application/pdf" };
    }
    if (kind === "perquisites") return { bytes: renderPerquisitesPdf(data, loaded.pan), name: `${data.fyStart >= 2026 ? "Form130-AnnexureII-Perquisites" : "Form12BA"}_${base}.pdf`, type: "application/pdf" };
    return { bytes: renderTdsSummaryPdf(data, loaded.pan, (loaded as any).months || []), name: `TDS-summary_${base}.pdf`, type: "application/pdf" };
  }

  /** Every generated certificate (and perquisite statement) for the year in one ZIP, for printing or a document portal. */
  async bulkDocuments(identity: AuthIdentity, fyStart: number) {
    requireAdmin(identity);
    const ids = await this.database.tenantTransaction(identity, async (client) => {
      const rows = (await client.query(
        `SELECT d.employee_id FROM tax_documents d JOIN employees e ON e.id=d.employee_id AND e.organization_id=d.organization_id
          WHERE d.organization_id=$1 AND d.fy_start=$2 AND d.generated_at IS NOT NULL ORDER BY e.employee_number`, [identity.organizationId, fyStart])).rows;
      if (!rows.length) throw new NotFoundException("No certificates have been generated for this year yet.");
      const set = (await client.query(`SELECT id FROM tax_document_sets WHERE organization_id=$1 AND fy_start=$2`, [identity.organizationId, fyStart])).rows[0];
      if (set) await auditRead(client, identity, "TAX_DOCUMENTS_BULK_DOWNLOADED", "tax_document_set", set.id, { fy: fyStart, employees: rows.length });
      return rows.map((row) => row.employee_id as string);
    });
    const entries: { name: string; bytes: Buffer }[] = [];
    for (const employeeId of ids) {
      for (const kind of ["certificate", "perquisites"]) {
        const file = await this.document(identity, fyStart, employeeId, kind);
        entries.push({ name: file.name, bytes: file.bytes });
      }
    }
    return { bytes: buildZip(entries), name: `${formNames(fyStart).certificate.replace(/\s+/g, "")}_${fyLabel(fyStart)}_all-employees.zip`, type: "application/zip", count: ids.length };
  }

  /** Employee: published tax documents per year. */
  mine(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const rows = (await client.query(
        `SELECT d.fy_start, d.part_a_file_id, s.published_at, (d.data->'partB'->>'netTaxPayable')::float AS tax, (d.data->'partB'->>'tdsTotal')::float AS tds, d.data->>'regime' AS regime
           FROM tax_documents d JOIN tax_document_sets s ON s.id=d.set_id AND s.organization_id=d.organization_id
          WHERE d.organization_id=$1 AND d.employee_id=$2 AND s.status='PUBLISHED' ORDER BY d.fy_start DESC`, [identity.organizationId, identity.employeeId])).rows;
      return {
        employeeId: identity.employeeId,
        items: rows.map((row) => ({ fy: row.fy_start, fyLabel: fyLabel(row.fy_start), forms: formNames(row.fy_start), publishedAt: row.published_at, tax: row.tax, tds: row.tds, regime: row.regime, partA: Boolean(row.part_a_file_id) })),
      };
    });
  }
}

import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { sha256 } from "./crypto";
import { AccountingPreviewQuery, CreateExportDto, LEDGER_KEYS, LedgerSettingsDto } from "./integrations.dto";
import { audit, istDate, lastDayOfPeriod, paise, requireFinance } from "./shared";
import { DEFAULT_LEDGERS, LEDGER_LABELS, tallyXml, totalsOf, unbalanced, voucherCsv, type Voucher, type VoucherLine } from "./tally";

export const EXPORTABLE_RUN_STATUSES = ["APPROVED", "PUBLISHED", "LOCKED"];
const PF_EMPLOYER_CODES = ["EPF_ER", "EPS_ER", "EDLI", "PF_ADMIN"];

type Settings = { companyName: string; ledgers: Record<string, string>; journalVoucherType: string; paymentVoucherType: string; version: number; configured: boolean };
type Check = { label: string; expected: number; actual: number; ok: boolean };

@Injectable()
export class AccountingService {
  constructor(private readonly database: DatabaseService) {}

  private async loadSettings(client: PoolClient, org: string): Promise<Settings> {
    const row = (await client.query(`SELECT company_name, ledgers, journal_voucher_type, payment_voucher_type, version FROM accounting_settings WHERE organization_id=$1`, [org])).rows[0];
    if (!row) {
      const name = (await client.query(`SELECT name FROM organizations WHERE id=$1`, [org])).rows[0]?.name || "Company";
      return { companyName: name, ledgers: { ...DEFAULT_LEDGERS }, journalVoucherType: "Journal", paymentVoucherType: "Payment", version: 0, configured: false };
    }
    return { companyName: row.company_name, ledgers: { ...DEFAULT_LEDGERS, ...row.ledgers }, journalVoucherType: row.journal_voucher_type, paymentVoucherType: row.payment_voucher_type, version: row.version, configured: true };
  }

  settings(identity: AuthIdentity) {
    requireFinance(identity);
    return this.database.tenantTransaction(identity, async (client) => ({
      ...(await this.loadSettings(client, identity.organizationId)),
      fields: LEDGER_KEYS.map((key) => ({ key, label: LEDGER_LABELS[key] })),
    }));
  }

  saveSettings(identity: AuthIdentity, input: LedgerSettingsDto) {
    requireFinance(identity);
    const ledgers: Record<string, string> = {};
    for (const key of LEDGER_KEYS) {
      const value = String(input.ledgers[key] ?? "").trim();
      if (value.length < 2 || value.length > 120) throw new BadRequestException(`Enter the Tally ledger name for "${LEDGER_LABELS[key]}" (2–120 characters).`);
      if (/[\u0000-\u001f]/.test(value)) throw new BadRequestException(`Ledger names cannot contain control characters (${LEDGER_LABELS[key]}).`);
      ledgers[key] = value;
    }
    const unknown = Object.keys(input.ledgers).filter((key) => !(LEDGER_KEYS as readonly string[]).includes(key));
    if (unknown.length) throw new BadRequestException(`Unknown ledger keys: ${unknown.join(", ")}`);
    return this.database.tenantTransaction(identity, async (client) => {
      const current = (await client.query(`SELECT version, ledgers FROM accounting_settings WHERE organization_id=$1 FOR UPDATE`, [identity.organizationId])).rows[0];
      if ((current?.version ?? 0) !== (input.version ?? 0)) throw new ConflictException("Ledger settings changed since you opened them. Refresh and try again.");
      const row = (await client.query(
        `INSERT INTO accounting_settings(organization_id,company_name,ledgers,journal_voucher_type,payment_voucher_type,updated_by) VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (organization_id) DO UPDATE SET company_name=$2, ledgers=$3, journal_voucher_type=$4, payment_voucher_type=$5, updated_by=$6,
           version=accounting_settings.version+1, updated_at=now() RETURNING version`,
        [identity.organizationId, input.companyName.trim(), JSON.stringify(ledgers), input.journalVoucherType?.trim() || "Journal", input.paymentVoucherType?.trim() || "Payment", identity.employeeId])).rows[0];
      await audit(client, identity, "ACCOUNTING_LEDGERS_UPDATED", "organization", identity.organizationId, { companyName: input.companyName, ledgers }, current ? { ledgers: current.ledgers } : undefined);
      return { version: row.version };
    });
  }

  runs(identity: AuthIdentity) {
    requireFinance(identity);
    return this.database.tenantTransaction(identity, async (client) => ({ items: (await client.query(
      `SELECT r.id, r.period, r.status, r.pay_date AS "payDate", r.totals, (r.status = ANY($2)) AS exportable,
              (SELECT max(x.created_at) FROM accounting_exports x WHERE x.run_id=r.id) AS "lastExportedAt"
         FROM payroll_runs r WHERE r.organization_id=$1 AND r.status <> 'CANCELLED' ORDER BY r.period DESC LIMIT 24`,
      [identity.organizationId, EXPORTABLE_RUN_STATUSES])).rows }));
  }

  preview(identity: AuthIdentity, query: AccountingPreviewQuery) {
    requireFinance(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const { raw: _raw, ...preview } = await this.build(client, identity.organizationId, query);
      return preview;
    });
  }

  private async build(client: PoolClient, org: string, query: AccountingPreviewQuery) {
    const settings = await this.loadSettings(client, org);
    const built = query.kind === "PAYROLL_JOURNAL" ? await this.payrollJournal(client, org, settings, query.runId) : await this.expensePayments(client, org, settings, query.month);
    const totals = totalsOf(built.vouchers);
    const broken = unbalanced(built.vouchers);
    const checks: Check[] = [...built.checks, { label: "Total debits = total credits", expected: totals.debit, actual: totals.credit, ok: totals.debit === totals.credit }];
    for (const voucher of broken) checks.push({ label: `Voucher ${voucher.number} balances`, expected: totalsOf([voucher]).debit, actual: totalsOf([voucher]).credit, ok: false });
    const ok = checks.every((check) => check.ok);
    return {
      kind: query.kind, period: built.period, runId: built.runId, companyName: settings.companyName, settingsConfigured: settings.configured,
      vouchers: built.vouchers.map((voucher) => ({ ...voucher, lines: voucher.lines.map((line) => ({ ...line, debit: line.debit / 100, credit: line.credit / 100 })) })),
      totals: { debit: totals.debit / 100, credit: totals.credit / 100, lines: totals.lines, vouchers: built.vouchers.length },
      checks: checks.map((check) => ({ ...check, expected: check.expected / 100, actual: check.actual / 100 })),
      balanced: ok, notes: built.notes, raw: built.vouchers,
    };
  }

  private async payrollJournal(client: PoolClient, org: string, settings: Settings, runId?: string) {
    if (!runId) throw new BadRequestException("Choose a payroll run.");
    const run = (await client.query(`SELECT id, period, status, pay_date::text, totals FROM payroll_runs WHERE organization_id=$1 AND id=$2`, [org, runId])).rows[0];
    if (!run) throw new NotFoundException("Payroll run not found.");
    if (!EXPORTABLE_RUN_STATUSES.includes(run.status)) throw new ConflictException(`Only approved or published runs can be exported (this run is ${run.status.toLowerCase()}).`);
    const lines = (await client.query(
      `SELECT gross, reimbursements, deductions, net, tds, pf_employee, esi_employee, pt, employer_cost, breakdown->'employer' AS employer
         FROM payroll_run_lines WHERE organization_id=$1 AND run_id=$2 AND status='INCLUDED' AND NOT held`, [org, runId])).rows;
    if (!lines.length) throw new ConflictException("This run has no payable lines.");
    const sum = { gross: 0, reimb: 0, deductions: 0, net: 0, tds: 0, pf: 0, esi: 0, pt: 0, employerCost: 0, erPf: 0, erEsi: 0, erOther: 0 };
    let lineMismatch = 0;
    for (const line of lines) {
      const g = paise(line.gross); const r = paise(line.reimbursements); const d = paise(line.deductions); const n = paise(line.net);
      sum.gross += g; sum.reimb += r; sum.deductions += d; sum.net += n; sum.tds += paise(line.tds); sum.pf += paise(line.pf_employee);
      sum.esi += paise(line.esi_employee); sum.pt += paise(line.pt); sum.employerCost += paise(line.employer_cost);
      if (g + r - d !== n) lineMismatch += 1;
      for (const item of (Array.isArray(line.employer) ? line.employer : []) as { code: string; amount: number }[]) {
        const value = paise(item.amount);
        if (PF_EMPLOYER_CODES.includes(item.code)) sum.erPf += value; else if (item.code === "ESI_ER") sum.erEsi += value; else sum.erOther += value;
      }
    }
    const other = sum.deductions - sum.pf - sum.esi - sum.pt - sum.tds;
    const employerTotal = sum.erPf + sum.erEsi + sum.erOther;
    const t = run.totals || {};
    const checks: Check[] = [
      { label: "Gross = run total", expected: paise(t.gross), actual: sum.gross, ok: paise(t.gross) === sum.gross },
      { label: "Net pay = run total", expected: paise(t.net), actual: sum.net, ok: paise(t.net) === sum.net },
      { label: "Deductions = run total", expected: paise(t.deductions), actual: sum.deductions, ok: paise(t.deductions) === sum.deductions },
      { label: "Reimbursements = run total", expected: paise(t.reimbursements), actual: sum.reimb, ok: paise(t.reimbursements) === sum.reimb },
      { label: "TDS = run total", expected: paise(t.tds), actual: sum.tds, ok: paise(t.tds) === sum.tds },
      { label: "Employer cost = gross + reimbursements + employer contributions", expected: sum.employerCost, actual: sum.gross + sum.reimb + employerTotal, ok: sum.employerCost === sum.gross + sum.reimb + employerTotal },
      { label: "Every line: gross + reimbursements − deductions = net", expected: 0, actual: lineMismatch * 100, ok: lineMismatch === 0 },
      { label: "Other deductions are not negative", expected: 0, actual: Math.min(other, 0), ok: other >= 0 },
    ];
    const L = settings.ledgers;
    const dr = (key: string, value: number, note?: string): VoucherLine => ({ ledgerKey: key, ledger: L[key], debit: value, credit: 0, note });
    const cr = (key: string, value: number, note?: string): VoucherLine => ({ ledgerKey: key, ledger: L[key], debit: 0, credit: value, note });
    const voucherLines = [
      dr("salaryExpense", sum.gross, "Gross earnings"),
      dr("reimbursementExpense", sum.reimb, "Reimbursements paid through payroll"),
      dr("employerContributionExpense", employerTotal, "Employer PF, ESI and gratuity"),
      cr("pfPayable", sum.pf + sum.erPf, "Employee + employer PF, EDLI, admin"),
      cr("esiPayable", sum.esi + sum.erEsi, "Employee + employer ESI"),
      cr("ptPayable", sum.pt, "Professional tax"),
      cr("tdsPayable", sum.tds, "TDS on salary"),
      cr("otherDeductions", other, "Recoveries and loan EMIs"),
      cr("gratuityProvision", sum.erOther, "Gratuity provision"),
      cr("salaryPayable", sum.net, `Net pay, ${lines.length} employees`),
    ].filter((line) => line.debit > 0 || line.credit > 0);
    const [y, m] = run.period.split("-");
    const label = new Date(Date.UTC(+y, +m - 1, 1)).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
    const voucher: Voucher = {
      number: `PAY/${run.period}`, type: settings.journalVoucherType, date: run.pay_date || lastDayOfPeriod(run.period), reference: `NS-RUN-${run.id.slice(0, 8)}`,
      narration: `Salary for ${label} — ${lines.length} employees (ClanChief payroll run ${run.id.slice(0, 8)})`, lines: voucherLines,
    };
    const notes = t.held ? [`${t.held} held salary line(s) are excluded, matching the run totals; book them when released.`] : [];
    return { period: run.period as string, runId: run.id as string, vouchers: [voucher], checks, notes };
  }

  private async expensePayments(client: PoolClient, org: string, settings: Settings, month?: string) {
    if (!month) throw new BadRequestException("Choose a month.");
    const claims = (await client.query(
      `SELECT c.id, c.case_number, c.title, c.category, c.amount, c.closed_at, c.details->>'paymentReference' AS utr, e.employee_number, e.full_name
         FROM hr_cases c JOIN employees e ON e.id=c.requester_id
        WHERE c.organization_id=$1 AND c.module='expenses' AND c.status='PAID' AND c.amount > 0
          AND to_char(c.closed_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM')=$2
          AND NOT EXISTS (SELECT 1 FROM payroll_inputs i WHERE i.organization_id=$1 AND i.source='EXPENSE_CLAIM' AND i.source_ref=c.id AND i.voided_at IS NULL)
        ORDER BY c.closed_at, c.case_number`, [org, month])).rows;
    const L = settings.ledgers;
    const vouchers: Voucher[] = claims.map((claim) => {
      const value = paise(claim.amount);
      return {
        number: claim.case_number, type: settings.paymentVoucherType, date: istDate(claim.closed_at), reference: claim.utr || claim.case_number,
        narration: `${claim.case_number} ${claim.category || "Expense"} reimbursement — ${claim.full_name} (${claim.employee_number})${claim.utr ? `, UTR ${claim.utr}` : ""}`,
        lines: [
          { ledgerKey: "reimbursementExpense", ledger: L.reimbursementExpense, debit: value, credit: 0, note: claim.title },
          { ledgerKey: "bank", ledger: L.bank, debit: 0, credit: value },
        ],
      };
    });
    const total = claims.reduce((sum, claim) => sum + paise(claim.amount), 0);
    const checks: Check[] = [{ label: "Voucher total = paid claims total", expected: total, actual: totalsOf(vouchers).debit, ok: total === totalsOf(vouchers).debit }];
    const notes = ["Claims reimbursed through a payroll run are excluded here — they are already in that run's journal."];
    if (!claims.length) notes.unshift("No expense claims were marked paid in this month.");
    return { period: month, runId: null as string | null, vouchers, checks, notes };
  }

  // ------------------------------------------------------------------ exports

  createExport(identity: AuthIdentity, input: CreateExportDto) {
    requireFinance(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const settings = await this.loadSettings(client, identity.organizationId);
      if (!settings.configured) throw new ConflictException("Save the ledger mapping before exporting.");
      const built = await this.build(client, identity.organizationId, input);
      if (!built.balanced) {
        const failed = built.checks.filter((check) => !check.ok).map((check) => check.label).join("; ");
        throw new UnprocessableEntityException(`Export refused — the vouchers do not reconcile: ${failed}.`);
      }
      if (!built.raw.length) throw new ConflictException("There is nothing to export for this selection.");
      const content = input.format === "TALLY_XML" ? tallyXml(settings.companyName, built.raw) : voucherCsv(built.raw);
      const base = input.kind === "PAYROLL_JOURNAL" ? `payroll-journal-${built.period}` : `expense-payments-${built.period}`;
      const fileName = `${base}${input.format === "TALLY_XML" ? "-tally.xml" : ".csv"}`;
      const checksum = sha256(content);
      const totals = totalsOf(built.raw);
      const row = (await client.query(
        `INSERT INTO accounting_exports(organization_id,kind,format,run_id,period,file_name,content,checksum,voucher_count,line_count,total_debit,total_credit,exported_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, created_at AS "createdAt"`,
        [identity.organizationId, input.kind, input.format, built.runId, built.period, fileName, content, checksum, built.raw.length, totals.lines,
          (totals.debit / 100).toFixed(2), (totals.credit / 100).toFixed(2), identity.employeeId])).rows[0];
      await audit(client, identity, "ACCOUNTING_EXPORTED", "accounting_export", row.id, { kind: input.kind, format: input.format, period: built.period, runId: built.runId, checksum, totalDebit: totals.debit / 100 });
      return { id: row.id, fileName, checksum, totals: built.totals, createdAt: row.createdAt };
    });
  }

  exports(identity: AuthIdentity) {
    requireFinance(identity);
    return this.database.tenantTransaction(identity, async (client) => ({ items: (await client.query(
      `SELECT x.id, x.kind, x.format, x.run_id AS "runId", x.period, x.file_name AS "fileName", x.checksum, x.voucher_count AS "voucherCount",
              x.line_count AS "lineCount", x.total_debit::float AS "totalDebit", x.total_credit::float AS "totalCredit", x.created_at AS "createdAt",
              e.full_name AS "exportedBy"
         FROM accounting_exports x JOIN employees e ON e.id=x.exported_by WHERE x.organization_id=$1 ORDER BY x.created_at DESC LIMIT 100`,
      [identity.organizationId])).rows }));
  }

  download(identity: AuthIdentity, id: string) {
    requireFinance(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(`SELECT file_name, format, content, checksum FROM accounting_exports WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id])).rows[0];
      if (!row) throw new NotFoundException("Export not found.");
      if (sha256(row.content) !== row.checksum) throw new ConflictException("The stored export failed its checksum. Create a new export.");
      await audit(client, identity, "ACCOUNTING_EXPORT_DOWNLOADED", "accounting_export", id);
      return { name: row.file_name as string, type: row.format === "TALLY_XML" ? "application/xml" : "text/csv", content: row.content as string, checksum: row.checksum as string };
    });
  }
}

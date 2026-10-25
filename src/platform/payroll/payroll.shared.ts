import { ConflictException, ForbiddenException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { decryptField, mask as maskSensitive, type SensitiveKind } from "../security/field-crypto";
import type { AgeCategory, Declarations, Regime } from "./tax-engine";
import type { LabourCodeMode } from "./statutory";

/** Roles that manage payroll (structures, runs). Maker-checker is enforced between two such users. */
export const PAYROLL_ROLES = ["PAYROLL_ADMIN", "HR_ADMIN", "OWNER"];
/** Only these roles may download bank transfer / payout files (HR admins prepare payroll but do not release money). */
export const BANK_FILE_ROLES = ["PAYROLL_ADMIN", "OWNER"];
export const isPayrollAdmin = (identity: AuthIdentity) => identity.roles.some((role) => PAYROLL_ROLES.includes(role));
/** Checkers granted "Approve payroll runs" through a custom role can review runs and approve/send back — nothing else. */
export const canApprovePayroll = (identity: AuthIdentity) => isPayrollAdmin(identity) || !!identity.permissions?.includes("payroll.run.approve");
export function requireReviewer(identity: AuthIdentity) {
  if (!canApprovePayroll(identity)) throw new ForbiddenException("Only payroll administrators or approvers can view payroll runs.");
}
export function requireAdmin(identity: AuthIdentity) {
  if (!isPayrollAdmin(identity)) throw new ForbiddenException("Only payroll or HR administrators can do this.");
}

export const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
export const mask = (value: string | null | undefined, visible = 4) =>
  value ? `${"•".repeat(Math.max(0, Math.min(8, value.length - visible)))}${value.slice(-visible)}` : null;
export const monthLabel = (period: string) =>
  new Date(`${period}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

export type Settings = {
  pfWageMode: "CEILING" | "ACTUAL"; defaultState: string; includeExpenses: boolean;
  pfEstablishmentCode: string | null; esiEmployerCode: string | null; debitAccount: string | null; version: number;
  /** payroll_settings.statutory_options (migration 031): Labour Code 50% wage rule, LWF deduction, minimum-wage floor. */
  labourCodeWages: LabourCodeMode; lwfEnabled: boolean; minimumWageMonthly: number | null;
};
export const LABOUR_CODE_MODES: LabourCodeMode[] = ["AUTO", "ON", "OFF"];
export async function loadSettings(client: PoolClient, organizationId: string): Promise<Settings> {
  const row = (await client.query(`SELECT * FROM payroll_settings WHERE organization_id=$1`, [organizationId])).rows[0];
  return {
    pfWageMode: row?.pf_wage_mode || "CEILING", defaultState: row?.default_state || "KA", includeExpenses: row ? row.include_expenses : true,
    pfEstablishmentCode: row?.pf_establishment_code || null, esiEmployerCode: row?.esi_employer_code || null,
    debitAccount: row?.debit_account || null, version: row?.version || 0,
    ...statutoryOptions(row?.statutory_options),
  };
}

export function statutoryOptions(raw: any) {
  const options = raw && typeof raw === "object" ? raw : {};
  const floor = Number(options.minimumWageMonthly);
  return {
    labourCodeWages: (LABOUR_CODE_MODES.includes(options.labourCodeWages) ? options.labourCodeWages : "AUTO") as LabourCodeMode,
    lwfEnabled: options.lwfEnabled === true,
    minimumWageMonthly: options.minimumWageMonthly !== null && options.minimumWageMonthly !== undefined && Number.isFinite(floor) && floor > 0 ? Math.round(floor) : null,
  };
}

/** payroll_profiles.statutory_flags (migration 031) with the engine defaults filled in. */
export type StatutoryFlags = { epsEligible: boolean; disabled: boolean; vpfRate: number; internationalWorker: boolean; ageCategory: AgeCategory };
export const AGE_CATEGORIES: AgeCategory[] = ["BELOW_60", "SENIOR", "SUPER_SENIOR"];
export function statutoryFlags(raw: any): StatutoryFlags {
  const flags = raw && typeof raw === "object" ? raw : {};
  const vpf = Number(flags.vpfRate);
  return {
    epsEligible: flags.epsEligible !== false, disabled: flags.disabled === true,
    vpfRate: Number.isFinite(vpf) && vpf > 0 ? Math.min(vpf, 0.88) : 0, internationalWorker: flags.internationalWorker === true,
    ageCategory: AGE_CATEGORIES.includes(flags.ageCategory) ? flags.ageCategory : "BELOW_60",
  };
}

export type RunGate = { status: string; approved_by: string | null; submitted_by: string | null; calculated_by: string | null };
/**
 * Segregation of duties for money-moving files and payouts (payroll bank file, payout batch release and bank file):
 * only PAYROLL_ADMIN/OWNER, only once a checker approved the run, never the person who prepared (calculated or
 * submitted) it. Returns why it is blocked (with the HTTP status to use), or null.
 */
export function bankFileBlock(identity: AuthIdentity, run: RunGate): { status: 403 | 409; reason: string } | null {
  if (!identity.roles.some((role) => BANK_FILE_ROLES.includes(role))) return { status: 403, reason: "Only a payroll administrator or the owner can release salary payments or download a bank transfer file." };
  if (!["APPROVED", "PUBLISHED", "LOCKED"].includes(run.status)) return { status: 409, reason: "Bank transfer files and payouts are available once the payroll run is approved." };
  if (!run.approved_by) return { status: 409, reason: "This run has no recorded approver — reopen, submit and approve it again." };
  if (run.submitted_by === identity.employeeId || run.calculated_by === identity.employeeId)
    return { status: 403, reason: "Segregation of duties: the person who prepared this payroll run cannot release its payments or download its bank file. Ask the approver or another payroll admin." };
  return null;
}
/** bankFileBlock as a throwable Nest exception (or null). */
export function bankFileError(identity: AuthIdentity, run: RunGate) {
  const blocked = bankFileBlock(identity, run);
  return blocked ? (blocked.status === 409 ? new ConflictException(blocked.reason) : new ForbiddenException(blocked.reason)) : null;
}

export function audit(client: PoolClient, identity: AuthIdentity, action: string, entityType: string, entityId: string, before: unknown, after: unknown) {
  return client.query(
    `INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [identity.organizationId, identity.userId, action, entityType, entityId, before === null || before === undefined ? null : JSON.stringify(before), after === null || after === undefined ? null : JSON.stringify(after)]);
}

export function notify(client: PoolClient, organizationId: string, employeeId: string, eventType: string, entityType: string, entityId: string, payload: Record<string, unknown>) {
  return client.query(
    `INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload) VALUES($1,$2,$3,$4,$5,$6)`,
    [organizationId, employeeId, eventType, entityType, entityId, JSON.stringify(payload)]);
}

// ------------------------------------------------------------ encrypted identifiers (payroll_profiles)

/** Sensitive payroll_profiles fields: API name → column prefix (<col>_enc/_hash/_last4) and mask kind. */
export const PII_FIELDS = {
  pan: { column: "pan", kind: "pan" },
  uan: { column: "uan", kind: "uan" },
  esiNumber: { column: "esi_number", kind: "esi" },
  bankAccount: { column: "bank_account", kind: "bank_account" },
} as const satisfies Record<string, { column: string; kind: SensitiveKind }>;
export type PiiField = keyof typeof PII_FIELDS;

export const profileContext = (organizationId: string, employeeId: string, column: string) =>
  ({ table: "payroll_profiles", column, organizationId, rowId: employeeId });

/** Masked display value from the stored last-4 hint (never decrypts). */
export const maskedField = (row: any, field: PiiField) =>
  row ? maskSensitive(PII_FIELDS[field].kind, row[`${PII_FIELDS[field].column}_last4`]) : null;

/** Decrypts one identifier of a payroll_profiles row. The row must carry organization_id and employee_id. */
export function decryptProfileField(row: any, field: PiiField): string | null {
  if (!row) return null;
  const column = PII_FIELDS[field].column;
  return decryptField(row[`${column}_enc`], profileContext(row.organization_id, row.employee_id, column));
}

export type BankDetails = { bankName: string | null; account: string | null; ifsc: string | null; accountHash: string | null; last4: string | null };
/**
 * Decrypted salary-account details for payout/bank-file builders (integrations/payouts can import this).
 * Call only on paths that are role-checked and audited.
 */
export async function loadBankDetails(client: PoolClient, organizationId: string, employeeIds: string[]) {
  const rows = (await client.query(
    `SELECT organization_id, employee_id, bank_name, ifsc, bank_account_enc, bank_account_hash, bank_account_last4
       FROM payroll_profiles WHERE organization_id=$1 AND employee_id = ANY($2)`, [organizationId, employeeIds])).rows;
  return new Map<string, BankDetails>(rows.map((row) => [row.employee_id, {
    bankName: row.bank_name, ifsc: row.ifsc, account: decryptProfileField(row, "bankAccount"), accountHash: row.bank_account_hash, last4: row.bank_account_last4,
  }]));
}

/** Read-audit (PII_READ / PAYSLIP_VIEWED / PAYROLL_EXPORTED …): one insert, no before-image. */
export const auditRead = (client: PoolClient, identity: AuthIdentity, action: string, entityType: string, entityId: string, details: Record<string, unknown>) =>
  audit(client, identity, action, entityType, entityId, null, details);

// ------------------------------------------------------------ accepted tax declarations (v2 tax module) → payroll TDS

export type AcceptedDeclaration = { id: string; regime: Regime; declarations: Declarations; factor: number; reviewedAt: string | null };
const money = (value: unknown) => Math.max(0, Math.round(Number(value) || 0));
/**
 * Latest ACCEPTED tax_declarations row per employee for the FY (tax_year "2026-27"), mapped onto the payroll Declarations
 * shape the TDS projection already takes. The reviewer's review_amounts {declared, accepted} scale the claimed deductions
 * (accepted/declared, capped at 1); income items (other income, previous employer) are taken as declared.
 */
export async function loadAcceptedDeclarations(client: PoolClient, organizationId: string, employeeIds: string[], taxYear: string) {
  const exists = (await client.query(`SELECT to_regclass('public.tax_declarations') IS NOT NULL AS ok`)).rows[0]?.ok;
  if (!exists || !employeeIds.length) return new Map<string, AcceptedDeclaration>();
  const rows = (await client.query(
    `SELECT DISTINCT ON (employee_id) id, employee_id, regime, inputs, items, review_amounts, reviewed_at
       FROM tax_declarations WHERE organization_id=$1 AND employee_id = ANY($2) AND tax_year=$3 AND status='ACCEPTED'
      ORDER BY employee_id, reviewed_at DESC NULLS LAST, updated_at DESC`, [organizationId, employeeIds, taxYear])).rows;
  return new Map<string, AcceptedDeclaration>(rows.map((row) => {
    const inputs = row.inputs || {};
    const review = row.review_amounts || null;
    const factor = review && Number(review.declared) > 0 ? Math.min(1, Math.max(0, Number(review.accepted) / Number(review.declared))) : 1;
    const scaled = (value: unknown) => Math.round(money(value) * factor);
    const rent = (row.items || []).filter((item: any) => /rent|hra/i.test(String(item.category || ""))).reduce((t: number, item: any) => t + money(item.amount), 0);
    const declarations: Declarations = {
      section80C: scaled(inputs.section80C), section80D: scaled(inputs.section80DSelf ?? inputs.section80D), section80DParents: scaled(inputs.section80DParents),
      parentsSenior: Boolean(inputs.parentsSenior), nps80CCD1B: scaled(inputs.nps80CCD1B), homeLoanInterest: scaled(inputs.homeLoanInterest),
      rentPaidAnnual: rent ? scaled(rent) : undefined, otherIncome: money(inputs.otherIncome), previousEmployerSalary: money(inputs.previousEmployerSalary),
      ...(inputs.ageCategory ? { ageCategory: inputs.ageCategory } : {}),
    };
    for (const key of Object.keys(declarations) as (keyof Declarations)[]) if (declarations[key] === undefined) delete declarations[key];
    return [row.employee_id, { id: row.id, regime: row.regime === "OLD" ? "OLD" : "NEW", declarations, factor, reviewedAt: row.reviewed_at }];
  }));
}

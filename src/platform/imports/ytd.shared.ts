import type { PoolClient } from "pg";

/**
 * Opening payroll year-to-date imported from the previous payroll system (migration 034, switch-over import).
 *
 * Contract (read-only for other modules — payroll runs, statutory returns / Form 16 / 24Q):
 *   payroll_ytd_opening  one row per (organization_id, employee_id, fiscal_year "2026-27"): totals the old system paid
 *                        for months from_period … last_paid_period (inclusive), `months` = number of months covered.
 *                        taxable = gross − exempt_allowances (HRA is included; the annual HRA exemption is computed
 *                        by ClanChief). pf_employee excludes VPF (separate column).
 *   payroll_ytd_monthly  optional month-wise rows (organization_id, employee_id, period "YYYY-MM") stored as given.
 * ClanChief payroll runs for periods AFTER last_paid_period add these totals to their own published year-to-date
 * (TDS projection: prior taxable / TDS / PF / PT). Rows exist only while their import batch is committed (undo deletes them).
 */
export type OpeningYtd = {
  employeeId: string; fiscalYear: string; fromPeriod: string; lastPaidPeriod: string; months: number;
  gross: number; basic: number; hra: number; otherTaxable: number; exemptAllowances: number; taxable: number;
  pfEmployee: number; pfEmployer: number; vpf: number; esiEmployee: number; pt: number; tds: number; batchId: string;
};

const n = (value: unknown) => Number(value) || 0;

/** Openings for the given employees and FY. With `beforePeriod`, only openings whose last paid month is earlier. */
export async function loadOpeningYtd(client: PoolClient, organizationId: string, employeeIds: string[], fiscalYear: string, beforePeriod?: string) {
  if (!employeeIds.length) return new Map<string, OpeningYtd>();
  const exists = (await client.query(`SELECT to_regclass('public.payroll_ytd_opening') IS NOT NULL AS ok`)).rows[0]?.ok;
  if (!exists) return new Map<string, OpeningYtd>();
  const rows = (await client.query(
    `SELECT * FROM payroll_ytd_opening WHERE organization_id=$1 AND employee_id = ANY($2) AND fiscal_year=$3 AND ($4::text IS NULL OR last_paid_period < $4)`,
    [organizationId, employeeIds, fiscalYear, beforePeriod || null])).rows;
  return new Map<string, OpeningYtd>(rows.map((row) => [row.employee_id, {
    employeeId: row.employee_id, fiscalYear: row.fiscal_year, fromPeriod: row.from_period, lastPaidPeriod: row.last_paid_period, months: n(row.months),
    gross: n(row.gross), basic: n(row.basic), hra: n(row.hra), otherTaxable: n(row.other_taxable), exemptAllowances: n(row.exempt_allowances), taxable: n(row.taxable),
    pfEmployee: n(row.pf_employee), pfEmployer: n(row.pf_employer), vpf: n(row.vpf), esiEmployee: n(row.esi_employee), pt: n(row.pt), tds: n(row.tds), batchId: row.batch_id,
  }]));
}

/** Net pay implied by an opening (gross − employee deductions); used for year-to-date display. */
export const openingNet = (o: OpeningYtd) => o.gross - o.pfEmployee - o.vpf - o.esiEmployee - o.pt - o.tds;

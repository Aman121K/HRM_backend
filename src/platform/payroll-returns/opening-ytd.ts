/**
 * Pre-switch-over year-to-date for returns and certificates. Reads the switch-over import contract
 * (imports/ytd.shared.ts, migration 034 — read-only) and degrades to "no opening data" when the tables are absent
 * or unreadable, so returns keep working on databases without the import module.
 */
import type { PoolClient } from "pg";
import { loadOpeningYtd as loadImportedYtd } from "../imports/ytd.shared";
import type { OpeningYtd } from "./form16";
import { fyLabel, quarterOfPeriod, type Quarter } from "./tds-math";

export type OpeningMonth = { employeeId: string; period: string; gross: number; taxable: number; tds: number; pf: number; pt: number };

async function guarded<T>(client: PoolClient, fallback: T, work: () => Promise<T>): Promise<T> {
  await client.query("SAVEPOINT opening_ytd");
  try { const result = await work(); await client.query("RELEASE SAVEPOINT opening_ytd"); return result; }
  catch { await client.query("ROLLBACK TO SAVEPOINT opening_ytd"); return fallback; }
}

/** Month-wise rows the previous system paid (optional part of the import). */
export async function loadOpeningMonths(client: PoolClient, organizationId: string, fyStart: number, employeeIds?: string[]) {
  return guarded(client, [] as OpeningMonth[], async () => {
    const exists = (await client.query(`SELECT to_regclass('public.payroll_ytd_monthly') IS NOT NULL AS ok`)).rows[0]?.ok;
    if (!exists) return [];
    const rows = (await client.query(
      `SELECT employee_id, period, gross::float, exempt_allowances::float, pf_employee::float, vpf::float, pt::float, tds::float
         FROM payroll_ytd_monthly WHERE organization_id=$1 AND fiscal_year=$2 AND ($3::uuid[] IS NULL OR employee_id = ANY($3)) ORDER BY period`,
      [organizationId, fyLabel(fyStart), employeeIds || null])).rows;
    return rows.map((row) => ({ employeeId: row.employee_id, period: row.period, gross: row.gross, taxable: Math.max(0, row.gross - row.exempt_allowances), tds: row.tds, pf: row.pf_employee + row.vpf, pt: row.pt }));
  });
}

/**
 * loadOpeningYtd(client, org, fy): per-employee opening YTD in the certificate's shape. Quarter-wise TDS is derived
 * from the month-wise history only when it reconciles with the opening total (otherwise reported unsplit).
 */
export async function loadOpeningYtd(client: PoolClient, organizationId: string, fyStart: number, employeeIds: string[]) {
  const result = new Map<string, OpeningYtd>();
  const imported = await guarded(client, new Map(), () => loadImportedYtd(client, organizationId, employeeIds, fyLabel(fyStart)));
  if (!imported.size) return result;
  const months = await loadOpeningMonths(client, organizationId, fyStart, employeeIds);
  for (const [employeeId, o] of imported) {
    const own = months.filter((m) => m.employeeId === employeeId && m.period >= o.fromPeriod && m.period <= o.lastPaidPeriod);
    let quarterTds: Partial<Record<Quarter, number>> | undefined;
    if (own.length && Math.abs(own.reduce((t, m) => t + m.tds, 0) - o.tds) < 1) {
      quarterTds = {};
      for (const m of own) quarterTds[quarterOfPeriod(m.period)] = (quarterTds[quarterOfPeriod(m.period)] || 0) + m.tds;
    }
    result.set(employeeId, {
      employeeId, source: "switch-over import", throughPeriod: o.lastPaidPeriod, months: o.months, gross: o.gross, taxable: o.taxable, tds: o.tds,
      pf: o.pfEmployee + o.vpf, pt: o.pt, basic: o.basic, hra: o.hra, employerPf: o.pfEmployer, quarterTds,
    });
  }
  return result;
}

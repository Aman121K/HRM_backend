/**
 * Salary-TDS calendar and arithmetic (pure): quarters, deposit due dates, late-deposit interest, PAN handling and the
 * form names that changed with the Income-tax Act 2025. Sources and confidence: docs/payroll-statutory-review.md §10.
 */

export type Quarter = "Q1" | "Q2" | "Q3" | "Q4";
export const QUARTERS: Quarter[] = ["Q1", "Q2", "Q3", "Q4"];

const pad = (n: number) => String(n).padStart(2, "0");
const lastDayOf = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** FY start year for a pay period "YYYY-MM" (April–March). */
export const fyOfPeriod = (period: string) => { const [y, m] = period.split("-").map(Number); return m >= 4 ? y : y - 1; };
export const fyLabel = (fyStart: number) => `${fyStart}-${String(fyStart + 1).slice(2)}`;
/** Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar. */
export const quarterOfPeriod = (period: string): Quarter => { const m = Number(period.slice(5, 7)); return m >= 4 && m <= 6 ? "Q1" : m >= 7 && m <= 9 ? "Q2" : m >= 10 ? "Q3" : "Q4"; };
export function quarterPeriods(fyStart: number, quarter: Quarter) {
  const start = { Q1: [fyStart, 4], Q2: [fyStart, 7], Q3: [fyStart, 10], Q4: [fyStart + 1, 1] }[quarter];
  return [0, 1, 2].map((i) => `${start[0]}-${pad(start[1] + i)}`);
}
export function quarterRange(fyStart: number, quarter: Quarter) {
  const periods = quarterPeriods(fyStart, quarter);
  const [ly, lm] = periods[2].split("-").map(Number);
  return { from: `${periods[0]}-01`, to: `${periods[2]}-${pad(lastDayOf(ly, lm))}`, periods };
}
export const fyPeriods = (fyStart: number) => QUARTERS.flatMap((q) => quarterPeriods(fyStart, q));

/**
 * Due date for depositing salary TDS deducted in `period` (non-government deductor, challan):
 * 7th of the following month; tax deducted in March: 30 April. Rule 218 of the Income-tax Rules 2026 as reported
 * by secondary sources (formerly rule 30 of the 1962 Rules) — SECONDARY.
 */
export function depositDueDate(period: string) {
  const [y, m] = period.split("-").map(Number);
  if (m === 3) return `${y}-04-30`;
  const next = m === 12 ? [y + 1, 1] : [y, m + 1];
  return `${next[0]}-${pad(next[1])}-07`;
}

/** Due date of the quarterly statement (Q1 31 Jul, Q2 31 Oct, Q3 31 Jan, Q4 31 May) — SECONDARY. */
export function statementDueDate(fyStart: number, quarter: Quarter) {
  return { Q1: `${fyStart}-07-31`, Q2: `${fyStart}-10-31`, Q3: `${fyStart + 1}-01-31`, Q4: `${fyStart + 1}-05-31` }[quarter];
}
/** Annual salary certificate (Form 130 / Form 16) due 15 June after the tax year — SECONDARY. */
export const certificateDueDate = (fyStart: number) => `${fyStart + 1}-06-15`;

/**
 * Interest for late deposit of tax already deducted: 1.5% per month or part of a month from the date of deduction to
 * the date of deposit (s.201(1A)(ii) of the 1961 Act; s.398(3)(a)(ii) of the 2025 Act per secondary sources).
 * Months are counted as calendar months touched (TRACES practice — UNVERIFIED) and the principal is rounded down to
 * a multiple of ₹100 (rule 119A of the 1962 Rules; 2026-Rules equivalent UNVERIFIED). The 1% per month "deductible but
 * not deducted" leg does not arise for salary deducted on payment and is not computed here.
 * Interest is only charged when the deposit is after the due date.
 */
export function lateDepositInterest(input: { tds: number; deductionDate: string; depositDate: string; period?: string }) {
  const due = depositDueDate(input.period || input.deductionDate.slice(0, 7));
  if (input.depositDate <= due || input.tds <= 0) return { late: false, dueDate: due, months: 0, rate: 0.015, interest: 0, daysLate: 0 };
  const [dy, dm] = input.deductionDate.split("-").map(Number);
  const [py, pm] = input.depositDate.split("-").map(Number);
  const months = Math.max(1, (py * 12 + pm) - (dy * 12 + dm) + 1);
  const principal = Math.floor(input.tds / 100) * 100;
  const daysLate = Math.round((Date.parse(`${input.depositDate}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000);
  return { late: true, dueDate: due, months, rate: 0.015, interest: Math.round(principal * 0.015 * months), daysLate };
}

export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const TAN_PATTERN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
/** PAN as it must appear in the statement: the PAN, or PANNOTAVBL when the employee has not furnished one. */
export function statementPan(pan: string | null | undefined) {
  const value = String(pan || "").trim().toUpperCase();
  if (!value) return { value: "PANNOTAVBL", valid: false, reason: "PAN not furnished" };
  if (!PAN_PATTERN.test(value)) return { value: "PANINVALID", valid: false, reason: "PAN is not in the AAAAA9999A format" };
  return { value, valid: true, reason: value[3] !== "P" ? "4th character is not 'P' (individual) — check the PAN" : null };
}
/** No-PAN rate (s.206AA of the 1961 Act; 2025-Act section UNVERIFIED): Annexure 6 code "C" needs TDS ≥ 20% of the amount paid. */
export const NO_PAN_RATE = 0.2;

/** Form names by tax year: the 2025 Act renumbered the salary forms from Tax Year 2026-27 (AY 2027-28). */
export function formNames(fyStart: number) {
  if (fyStart >= 2026) return {
    act: "Income-tax Act, 2025", section: "392", sectionOld: "192", yearLabel: `Tax Year ${fyLabel(fyStart)}`,
    quarterly: "Form 138", quarterlyOld: "Form 24Q", certificate: "Form 130", certificateOld: "Form 16",
    perquisites: "Form 130 Annexure II", perquisitesOld: "Form 12BA",
    note: "From Tax Year 2026-27 the quarterly salary TDS statement is Form 138 (formerly 24Q) and the annual certificate is Form 130 (formerly Form 16, perquisites in its Annexure II — formerly Form 12BA). Form names per Protean (Form 138 file format) and secondary sources for Form 130; the exact Form 130 layout is UNVERIFIED.",
  };
  return {
    act: "Income-tax Act, 1961", section: "192", sectionOld: "192", yearLabel: `FY ${fyLabel(fyStart)} (AY ${fyLabel(fyStart + 1)})`,
    quarterly: "Form 24Q", quarterlyOld: "Form 24Q", certificate: "Form 16", certificateOld: "Form 16", perquisites: "Form 12BA", perquisitesOld: "Form 12BA",
    note: "Income-tax Act, 1961: quarterly statement Form 24Q, certificate Form 16 (Part A from TRACES, Part B by the employer), perquisites Form 12BA.",
  };
}

/** Indian digit grouping (1,46,310). */
export function inr(value: number, decimals = 0) {
  const n = Number(value) || 0;
  const negative = n < 0;
  const fixed = Math.abs(n).toFixed(decimals);
  const [whole, fraction] = fixed.split(".");
  const last3 = whole.slice(-3), rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}
export const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}`;
export const displayDate = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "-");

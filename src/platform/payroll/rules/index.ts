/**
 * Versioned Indian statutory rule tables (data only). Calculators live in ../statutory.ts and ../tax-engine.ts.
 *
 * How to roll the rules forward (e.g. Budget 2027):
 *   - income tax: add TAX_YEARS[2027] in income-tax.ts (copy 2026, change what the Finance Act changed);
 *   - PF / ESI / Labour Code: append a row with the new effectiveFrom date to the relevant *_RULES array;
 *   - a state PT / LWF schedule: append a version to that state's list.
 * Never edit a row that past payroll periods have used — add a new one, so recalculating an old month is stable.
 */
export * from "./types";
export * from "./social-security";
export * from "./income-tax";
export * from "./state-levies";

import { BONUS_RULES, ESI_RULES, GRATUITY_RULES, LABOUR_CODE_RULES, OVERTIME_RULES, PF_RULES } from "./social-security";
import { taxRulesFor } from "./income-tax";
import { LWF_RULES, PT_RULES } from "./state-levies";
import { inForce, lastDayOf } from "./types";

/** Compact "which rule versions apply to this pay period" stamp, stored with every calculated payroll line. */
export function rulesStamp(period: string) {
  const day = lastDayOf(period);
  const [year, month] = period.split("-").map(Number);
  const fy = month >= 4 ? year : year - 1;
  const tax = taxRulesFor(fy);
  return {
    period,
    pf: PF_RULES.filter((row) => row.effectiveFrom <= day && row.effectiveFrom > `${period}-01`).length
      ? `${inForce(PF_RULES, `${period}-01`).version}→${inForce(PF_RULES, day).version}` : inForce(PF_RULES, day).version,
    esi: inForce(ESI_RULES, day).version, labourCode: inForce(LABOUR_CODE_RULES, day).effectiveFrom <= day ? inForce(LABOUR_CODE_RULES, day).version : "pre-code",
    gratuity: inForce(GRATUITY_RULES, day).version, bonus: inForce(BONUS_RULES, day).version, overtime: inForce(OVERTIME_RULES, day).version,
    tax: tax.version + (tax.assumed ? " (assumed — FY not configured)" : ""),
  };
}

export const STATES_WITH_PT = Object.keys(PT_RULES);
export const STATES_WITH_LWF = Object.keys(LWF_RULES);

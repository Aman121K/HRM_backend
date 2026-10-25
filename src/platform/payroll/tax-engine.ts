/**
 * Income-tax on salary (TDS under s.392 of the Income-tax Act 2025, formerly s.192) — FY-versioned via rules/income-tax.ts.
 *
 *  - taxable income rounded to the nearest ₹10 and the final tax liability rounded to the nearest ₹10;
 *  - new-regime rebate (₹60,000 up to ₹12 lakh in FY 2025-26 / 2026-27) with marginal relief just above the limit;
 *  - surcharge 10% / 15% / 25% (old regime 37% above ₹5 cr; capped at 25% in the new regime) with marginal relief;
 *  - 4% health & education cess on tax + surcharge;
 *  - old regime: standard deduction ₹50,000, HRA exemption, PT (max ₹2,500), home-loan interest (max ₹2 lakh),
 *    80C (₹1.5 lakh incl. employee PF), 80D (₹25k/₹50k senior, parents ₹25k/₹50k), 80CCD(1B) ₹50k; age-based slabs;
 *  - employer NPS (80CCD(2) / s.124): added to salary as a perquisite and deducted up to 14% (new) / 10% (old) of
 *    Basic + DA; aggregate employer PF + NPS + superannuation above ₹7.5 lakh is a taxable perquisite.
 *  - monthly TDS projection that spreads the remaining liability over the remaining months of the FY and deducts the
 *    extra tax caused by one-time earnings (bonus, arrears) in the month they are paid.
 * Must be validated by a qualified payroll specialist before real use.
 */
import { roundRupee } from "./statutory";
import { TAX_YEARS, taxRulesFor, todayIst, type AgeCategory, type Slab, type TaxYearRules } from "./rules";

export type Regime = "NEW" | "OLD";
export type { AgeCategory };
export type TaxInputs = {
  regime?: Regime; basic: number; hra: number; specialAllowance: number; bonus: number; taxableAllowances: number;
  previousEmployerSalary: number; otherIncome: number; housePropertyIncome: number; specialRateIncome: number;
  professionalTax: number; hraExemption: number; lta: number; homeLoanInterest: number; section80C: number;
  section80DSelf: number; section80DParents: number; nps80CCD1B: number;
  /** Employer contribution to NPS for the year (perquisite + deduction within the limit). */
  employerNps: number;
  /** Basic + DA for the year, the "salary" on which the employer-NPS limit is computed (defaults to `basic`). */
  npsSalary?: number;
  /** Employer PF + superannuation for the year (with employerNps tested against the ₹7.5 lakh perquisite cap). */
  employerRetirementOther?: number;
  educationLoanInterest: number; donations: number; otherDeductions: number; tdsDeducted: number;
  fyStartYear?: number; ageCategory?: AgeCategory; parentsSenior?: boolean;
};

const CURRENT_FY = (() => { const d = todayIst(); const m = Number(d.slice(5, 7)); return m >= 4 ? Number(d.slice(0, 4)) : Number(d.slice(0, 4)) - 1; })();
const current = taxRulesFor(CURRENT_FY);
/** Current-year summary (kept for the settings API). Use taxRulesFor(fy) for a specific year. */
export const TAX_RULES = {
  version: current.version, taxYear: current.label,
  newStandardDeduction: current.newStandardDeduction, oldStandardDeduction: current.oldStandardDeduction,
  rebateLimit: current.newRebate.limit, rebateMax: current.newRebate.max, oldRebateLimit: current.oldRebate.limit, oldRebateMax: current.oldRebate.max,
  cessRate: current.cessRate, oldCaps: current.oldCaps, newSlabs: current.newSlabs, oldSlabs: current.oldSlabs.BELOW_60, surcharge: current.surcharge,
  employerNpsLimit: current.employerNpsLimit, hraMetroCities: current.hraMetroCities, sections: current.sections, years: Object.keys(TAX_YEARS),
};

const money = (n: unknown) => Math.max(0, Math.round(Number(n) || 0));
export const roundTo10 = (n: number) => Math.round(n / 10 + 1e-9) * 10;
export function normalize(raw: Partial<TaxInputs>): TaxInputs {
  return {
    regime: raw.regime === "OLD" ? "OLD" : "NEW", basic: money(raw.basic), hra: money(raw.hra), specialAllowance: money(raw.specialAllowance),
    bonus: money(raw.bonus), taxableAllowances: money(raw.taxableAllowances), previousEmployerSalary: money(raw.previousEmployerSalary),
    otherIncome: money(raw.otherIncome), housePropertyIncome: Math.round(Number(raw.housePropertyIncome) || 0), specialRateIncome: money(raw.specialRateIncome),
    professionalTax: money(raw.professionalTax), hraExemption: money(raw.hraExemption), lta: money(raw.lta), homeLoanInterest: money(raw.homeLoanInterest),
    section80C: money(raw.section80C), section80DSelf: money(raw.section80DSelf), section80DParents: money(raw.section80DParents),
    nps80CCD1B: money(raw.nps80CCD1B), employerNps: money(raw.employerNps), npsSalary: raw.npsSalary === undefined ? undefined : money(raw.npsSalary),
    employerRetirementOther: money(raw.employerRetirementOther), educationLoanInterest: money(raw.educationLoanInterest),
    donations: money(raw.donations), otherDeductions: money(raw.otherDeductions), tdsDeducted: money(raw.tdsDeducted),
    fyStartYear: raw.fyStartYear, ageCategory: raw.ageCategory || "BELOW_60", parentsSenior: Boolean(raw.parentsSenior),
  };
}

function slabTax(income: number, slabs: Slab[]) {
  let lower = 0, tax = 0;
  const bands: { from: number; to: number | null; rate: number; taxable: number; tax: number }[] = [];
  for (const [upper, rate] of slabs) {
    const taxable = Math.max(0, Math.min(income, upper) - lower), bandTax = Math.round(taxable * rate);
    if (taxable > 0) bands.push({ from: lower, to: Number.isFinite(upper) ? upper : null, rate, taxable, tax: bandTax });
    tax += bandTax;
    if (income <= upper) break;
    lower = upper;
  }
  return { tax, bands };
}

function taxAfterRebate(income: number, regime: Regime, rules: TaxYearRules, age: AgeCategory) {
  const isOld = regime === "OLD";
  const slab = slabTax(income, isOld ? rules.oldSlabs[age] : rules.newSlabs);
  let rebate = 0, marginalRelief = 0;
  if (!isOld && income <= rules.newRebate.limit) rebate = Math.min(slab.tax, rules.newRebate.max);
  else if (isOld && income <= rules.oldRebate.limit) rebate = Math.min(slab.tax, rules.oldRebate.max);
  else if (!isOld && rules.newRebate.marginalRelief) {
    // New regime: tax (before cess) may not exceed the income earned above the rebate limit.
    const excess = income - rules.newRebate.limit;
    if (slab.tax > excess) marginalRelief = slab.tax - excess;
  }
  return { ...slab, rebate, marginalRelief, tax: Math.max(0, slab.tax - rebate - marginalRelief) };
}

function surchargeFor(income: number, tax: number, regime: Regime, rules: TaxYearRules, age: AgeCategory) {
  const bands = rules.surcharge[regime];
  let rate = 0, threshold = 0;
  for (const [limit, r] of bands) if (income > limit) { rate = r; threshold = limit; }
  if (!rate) return { surcharge: 0, rate: 0, marginalRelief: 0 };
  const surcharge = Math.round(tax * rate);
  // Marginal relief: tax + surcharge may not exceed (tax + surcharge at the threshold) + income above the threshold.
  const atThreshold = taxAfterRebate(threshold, regime, rules, age).tax;
  const lowerRate = bands.filter(([limit]) => limit < threshold).map(([, r]) => r).pop() || 0;
  const cap = atThreshold + Math.round(atThreshold * lowerRate) + (income - threshold);
  const allowed = Math.max(0, Math.min(surcharge, cap - tax));
  return { surcharge: allowed, rate, marginalRelief: surcharge - allowed };
}

export function calculateTax(raw: Partial<TaxInputs>, regime: Regime = raw.regime || "NEW") {
  const i = normalize({ ...raw, regime });
  const rules = taxRulesFor(i.fyStartYear ?? CURRENT_FY);
  const age = i.ageCategory || "BELOW_60";
  const isOld = regime === "OLD";
  // Employer retirement contributions above the aggregate cap are a perquisite (s.17(1)(h) 2025 Act / 17(2)(vii) 1961 Act).
  const retirementPerquisite = Math.max(0, i.employerNps + (i.employerRetirementOther || 0) - rules.employerRetirementPerquisiteCap);
  const salary = i.basic + i.hra + i.specialAllowance + i.bonus + i.taxableAllowances + i.employerNps + retirementPerquisite;
  const gross = salary + i.previousEmployerSalary + i.otherIncome + i.housePropertyIncome;
  const hraExempt = isOld ? Math.min(i.hraExemption, i.hra) : 0;
  const ptDeduction = isOld ? Math.min(i.professionalTax, rules.oldCaps.professionalTax) : 0;
  const homeLoan = isOld ? Math.min(i.homeLoanInterest, rules.oldCaps.homeLoanInterest) : 0;
  const exemptions = isOld ? hraExempt + i.lta + ptDeduction + homeLoan : 0;
  const standardDeduction = Math.min(isOld ? rules.oldStandardDeduction : rules.newStandardDeduction, Math.max(0, salary + i.previousEmployerSalary - exemptions));
  const npsLimit = roundRupee((i.npsSalary ?? i.basic) * rules.employerNpsLimit[regime]);
  const employerNpsDeduction = Math.min(i.employerNps, npsLimit);
  const senior = age !== "BELOW_60";
  const deductions = isOld
    ? Math.min(i.section80C, rules.oldCaps.section80C)
      + Math.min(i.section80DSelf, senior ? rules.oldCaps.section80DSelfSenior : rules.oldCaps.section80DSelf)
      + Math.min(i.section80DParents, i.parentsSenior ? rules.oldCaps.section80DParentsSenior : rules.oldCaps.section80DParents)
      + Math.min(i.nps80CCD1B, rules.oldCaps.nps80CCD1B) + employerNpsDeduction + i.educationLoanInterest + i.donations + i.otherDeductions
    : employerNpsDeduction;
  const taxableIncome = roundTo10(Math.max(0, gross - exemptions - standardDeduction - deductions));
  const computed = taxAfterRebate(taxableIncome, regime, rules, age);
  const sc = surchargeFor(taxableIncome, computed.tax, regime, rules, age);
  const cess = Math.round((computed.tax + sc.surcharge) * rules.cessRate);
  const annualLiability = roundTo10(computed.tax + sc.surcharge + cess);
  const remainingTax = Math.max(0, annualLiability - i.tdsDeducted);
  return {
    regime, rulesVersion: rules.version, taxYear: rules.label, rulesAssumed: rules.assumed, ageCategory: age,
    grossIncome: gross, exemptions, hraExemption: hraExempt, standardDeduction, deductions, employerNpsDeduction, retirementPerquisite, taxableIncome,
    bands: computed.bands, taxBeforeRebate: computed.bands.reduce((sum, band) => sum + band.tax, 0), rebate: computed.rebate,
    marginalRelief: computed.marginalRelief, surcharge: sc.surcharge, surchargeRate: sc.rate, surchargeMarginalRelief: sc.marginalRelief,
    cess, annualLiability, tdsDeducted: i.tdsDeducted, remainingTax,
    scopeNotice: i.specialRateIncome > 0 ? "Special-rate income is outside this payroll estimate; consult a tax professional." : null,
  };
}

// ---------------------------------------------------------------- monthly projection

/** Employee declarations (Form 124 — formerly Form 12BB) and previous-employer details (Form 130/16 or salary certificate). */
export type Declarations = {
  section80C?: number; section80D?: number; section80DParents?: number; parentsSenior?: boolean; nps80CCD1B?: number;
  rentPaidAnnual?: number; rentedInMetro?: boolean; homeLoanInterest?: number; otherIncome?: number;
  previousEmployerSalary?: number; previousEmployerTds?: number; previousEmployerPf?: number; previousEmployerPt?: number;
  ageCategory?: AgeCategory;
};
export type TdsProjectionInput = {
  regime: Regime;
  monthsRemainingIncludingCurrent: number;
  /** FY start year (2026 = FY 2026-27). Defaults to the current FY. */
  fyStartYear?: number;
  /** Taxable salary already paid this FY in earlier published runs (and TDS deducted on it). */
  priorTaxable: number; priorTds: number; priorPf: number; priorPt: number;
  /** Current month: regular (recurring) taxable earnings and one-time taxable earnings (bonus/arrears). */
  currentRegular: number; currentOneTime: number; currentPf: number; currentPt: number;
  /** Projected full-month values for each remaining month after this one. */
  futureMonthlyTaxable: number; futureMonthlyPf: number; futurePt: number;
  /** Exact employee PF (+VPF) for all remaining months, when the ceiling changes later in the year; overrides futureMonthlyPf × months. */
  futurePfTotal?: number;
  /** Basic (+DA) and HRA for the months employed in this FY (old-regime HRA exemption). */
  annualBasic: number; annualHra: number; metro: boolean;
  /** Employer NPS / PF for the FY (perquisite + 80CCD(2) deduction). */
  employerNpsAnnual?: number; employerPfAnnual?: number;
  declarations?: Declarations;
};

export function hraExemption(input: { hraReceived: number; rentPaid: number; salary: number; metro: boolean }) {
  if (!input.rentPaid || input.hraReceived <= 0) return 0;
  return roundRupee(Math.max(0, Math.min(input.hraReceived, input.rentPaid - 0.1 * input.salary, (input.metro ? 0.5 : 0.4) * input.salary)));
}

export function projectTds(input: TdsProjectionInput) {
  const future = Math.max(0, input.monthsRemainingIncludingCurrent - 1);
  const d = input.declarations || {};
  const annualPf = input.priorPf + input.currentPf + (input.futurePfTotal ?? input.futureMonthlyPf * future) + (d.previousEmployerPf || 0);
  const annualPt = input.priorPt + input.currentPt + input.futurePt + (d.previousEmployerPt || 0);
  const metro = d.rentedInMetro ?? input.metro;
  const recurringAnnual = input.priorTaxable + input.currentRegular + input.futureMonthlyTaxable * future;
  const hra = Math.min(input.annualHra, recurringAnnual);
  const hraExempt = input.regime === "OLD" ? hraExemption({ hraReceived: hra, rentPaid: d.rentPaidAnnual || 0, salary: input.annualBasic, metro }) : 0;
  const base: Partial<TaxInputs> = {
    fyStartYear: input.fyStartYear, ageCategory: d.ageCategory, parentsSenior: d.parentsSenior,
    hra, specialAllowance: 0, taxableAllowances: 0, previousEmployerSalary: d.previousEmployerSalary || 0, otherIncome: d.otherIncome || 0,
    professionalTax: annualPt, hraExemption: hraExempt, homeLoanInterest: d.homeLoanInterest || 0,
    section80C: annualPf + (d.section80C || 0), section80DSelf: d.section80D || 0, section80DParents: d.section80DParents || 0, nps80CCD1B: d.nps80CCD1B || 0,
    employerNps: input.employerNpsAnnual || 0, npsSalary: input.annualBasic, employerRetirementOther: input.employerPfAnnual || 0,
  };
  const regular = calculateTax({ ...base, basic: recurringAnnual - hra, bonus: 0 }, input.regime);
  const withOneTime = input.currentOneTime > 0 ? calculateTax({ ...base, basic: recurringAnnual - hra, bonus: input.currentOneTime }, input.regime) : regular;
  const priorTds = input.priorTds + (d.previousEmployerTds || 0);
  const months = Math.max(1, input.monthsRemainingIncludingCurrent);
  const regularShare = Math.max(0, roundRupee((regular.annualLiability - priorTds) / months));
  const oneTimeTax = Math.max(0, withOneTime.annualLiability - regular.annualLiability);
  const monthlyTds = regularShare + oneTimeTax;
  return {
    regime: input.regime, projectedAnnualIncome: recurringAnnual + input.currentOneTime + (base.previousEmployerSalary || 0) + (base.otherIncome || 0),
    taxableIncome: withOneTime.taxableIncome, annualLiability: withOneTime.annualLiability, cess: withOneTime.cess, rebate: withOneTime.rebate,
    marginalRelief: withOneTime.marginalRelief, surcharge: withOneTime.surcharge, surchargeMarginalRelief: withOneTime.surchargeMarginalRelief,
    standardDeduction: withOneTime.standardDeduction, exemptions: withOneTime.exemptions, hraExemption: withOneTime.hraExemption,
    deductions: withOneTime.deductions, bands: withOneTime.bands,
    tdsDeductedSoFar: priorTds, monthsRemaining: months, regularShare, oneTimeTax, monthlyTds,
    remainingAfterThisMonth: Math.max(0, withOneTime.annualLiability - priorTds - monthlyTds),
    rulesVersion: withOneTime.rulesVersion, taxYear: withOneTime.taxYear, rulesAssumed: withOneTime.rulesAssumed,
  };
}
export type TdsProjection = ReturnType<typeof projectTds>;

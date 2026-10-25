/**
 * India statutory payroll calculators — PF/EPS/EDLI, ESI, Professional Tax, Labour Welfare Fund, gratuity, bonus,
 * overtime, LOP proration. Rates and thresholds come from the versioned tables in ./rules (effective-dated), so a
 * calculation for a past month uses that month's rules.
 *
 * IMPORTANT: good-faith implementation; it must be reviewed by a Chartered Accountant / payroll specialist before it is
 * used to pay employees or file returns. See docs/payroll-statutory-review.md for sources, open items and sign-off.
 *
 * Money convention: every amount is a whole rupee. PF/EPS/EDLI/admin, PT, LWF and TDS are rounded half-up
 * (Math.round); ESI contributions are rounded up to the next rupee (ESIC practice). Totals are sums of rounded
 * components so payslips always reconcile.
 */
import {
  BONUS_RULES, ESI_RULES, GRATUITY_RULES, LABOUR_CODE_RULES, LWF_RULES, OVERTIME_RULES, PF_RULES, PT_RULES,
  inForce, lastDayOf, segmentsForPeriod, taxRulesFor, todayIst, type PtSlab as RulePtSlab, type PtVersion,
} from "./rules";

export const DISCLAIMER =
  "Statutory calculations (PF, ESI, Professional Tax, LWF, TDS) follow the FY 2026-27 rules documented in docs/payroll-statutory-review.md but must be validated by a qualified payroll specialist / CA before being used to pay employees or file returns.";

export type PtCategory = "STANDARD" | "WOMAN" | "EXEMPT";
export type PtSlab = RulePtSlab;
export type PtRule = {
  code: string; name: string; frequency: "MONTHLY" | "HALF_YEARLY" | "NONE";
  slabs: PtSlab[]; womenSlabs?: PtSlab[]; annualCap?: number; note: string; source: string;
};

export const roundRupee = (value: number) => Math.round((Number(value) || 0) + 1e-9);
/** Round up to the next rupee, ignoring floating-point noise below one paisa. */
export const ceilRupee = (value: number) => Math.ceil(Math.round((Number(value) || 0) * 100) / 100 - 1e-9);
const currentPeriod = () => todayIst().slice(0, 7);

// ---------------------------------------------------------------- periods

export function parsePeriod(period: string) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) throw new Error(`Invalid period ${period}`);
  const year = Number(match[1]), month = Number(match[2]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const fyStartYear = month >= 4 ? year : year - 1;
  const fyIndex = (month + 8) % 12; // April = 0 … March = 11
  return {
    year, month, daysInMonth, fyStartYear, fyIndex,
    fyLabel: `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}`,
    firstDay: `${period}-01`, lastDay: `${period}-${String(daysInMonth).padStart(2, "0")}`,
    fyFirstPeriod: `${fyStartYear}-04`, fyLastPeriod: `${fyStartYear + 1}-03`,
    remainingMonthsIncludingCurrent: 12 - fyIndex,
  };
}
export function addMonths(period: string, delta: number) {
  const { year, month } = parsePeriod(period);
  const index = year * 12 + (month - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}
/** ESI contribution period (Apr–Sep or Oct–Mar) containing the pay period. */
export function esiContributionPeriod(period: string) {
  const { year, month } = parsePeriod(period);
  if (month >= 4 && month <= 9) return { from: `${year}-04`, to: `${year}-09` };
  const start = month >= 10 ? year : year - 1;
  return { from: `${start}-10`, to: `${start + 1}-03` };
}

// ---------------------------------------------------------------- rule set summary (current period)

const ptView = (code: string, version: PtVersion): PtRule => ({
  code, name: PT_RULES[code].name, frequency: version.frequency, slabs: version.slabs, womenSlabs: version.womenSlabs,
  annualCap: version.annualCap, note: version.note, source: version.sources.map((s) => `${s.ref}${s.status !== "OFFICIAL" ? ` [${s.status}]` : ""}`).join("; "),
});
/** PT rule in force for a state on a date (defaults to today). */
export function ptRuleFor(state: string, date = todayIst()): PtRule | null {
  const rule = PT_RULES[state];
  return rule ? ptView(state, inForce(rule.versions, date)) : null;
}
/** Current PT schedule per state — also the list of state codes the API accepts. */
export const PT_STATES: Record<string, PtRule> = Object.fromEntries(Object.keys(PT_RULES).map((code) => [code, ptRuleFor(code)!]));

function buildRuleset(date: string) {
  const pf = inForce(PF_RULES, date), esi = inForce(ESI_RULES, date), lc = inForce(LABOUR_CODE_RULES, date);
  const fy = Number(date.slice(5, 7)) >= 4 ? Number(date.slice(0, 4)) : Number(date.slice(0, 4)) - 1;
  const tax = taxRulesFor(fy);
  return {
    version: `IN-FY${tax.label}.2 (${pf.version}, ${esi.version}, ${tax.version})`,
    fiscalYear: tax.label, effectiveFrom: `${fy}-04-01`, asOf: date, disclaimer: DISCLAIMER,
    pf: {
      employeeRate: pf.employeeRate, employerRate: pf.employerRate, epsRate: pf.epsRate, wageCeiling: pf.wageCeiling,
      epsMax: roundRupee(pf.wageCeiling * pf.epsRate), edliRate: pf.edliRate, edliMax: roundRupee(pf.wageCeiling * pf.edliRate), adminRate: pf.adminRate,
      effectiveFrom: pf.effectiveFrom,
      note: `PF wages = earned Basic (+ DA) plus, under the Labour Code wage definition (from ${lc.effectiveFrom}), any excess of excluded allowances over ${lc.excludedLimit * 100}% of total remuneration. Wage ceiling ₹${pf.wageCeiling.toLocaleString("en-IN")} from ${pf.effectiveFrom} (September 2026 is split 1–16 at ₹15,000 and 17–30 at ₹25,000 per EPFO FAQ). Default: contributions on wages capped at the ceiling (org option: actual wages). Employer 12% = EPS 8.33% on wages up to the ceiling + EPF balance. EDLI 0.5% and admin charges 0.5% are employer costs (₹500/month establishment minimum applied at challan level, not per employee).`,
      sources: pf.sources.map((s) => `${s.ref} [${s.status}]`),
    },
    esi: {
      employeeRate: esi.employeeRate, employerRate: esi.employerRate, wageThreshold: esi.wageThreshold, disabledWageThreshold: esi.disabledWageThreshold, lowWageDailyLimit: esi.lowWageDailyLimit,
      note: `Covered when the monthly rate of wages is ≤ ₹${esi.wageThreshold.toLocaleString("en-IN")} (₹${esi.disabledWageThreshold.toLocaleString("en-IN")} for persons with disability). Coverage continues to the end of the contribution period (Apr–Sep / Oct–Mar). Contributions on wages paid (excl. annual bonus, reimbursements), rounded up to the next rupee; average daily wage ≤ ₹${esi.lowWageDailyLimit} pays no employee share.`,
      sources: esi.sources.map((s) => `${s.ref} [${s.status}]`),
    },
    pt: { states: PT_STATES, note: "State is taken from the employee's payroll profile, else inferred from their work location, else the organisation default." },
    labourCodes: `Code on Social Security 2020 / Code on Wages 2019 in force from ${lc.effectiveFrom}: excluded allowances above ${lc.excludedLimit * 100}% of total remuneration are added back to 'wages' for PF (switchable per organisation: AUTO/ON/OFF). Gratuity: 15/26 × last drawn wages × years, cap ₹${(GRATUITY_RULES[0].cap / 100000).toFixed(0)} lakh, fixed-term employees after 1 year. Bonus: eligibility ₹${BONUS_RULES[0].eligibilityWage.toLocaleString("en-IN")}, calculation ceiling ₹${BONUS_RULES[0].calculationCeiling.toLocaleString("en-IN")} or minimum wage. Overtime: ${OVERTIME_RULES[0].multiplier}× normal rate.`,
    rounding: "Whole rupees. PF, EPS, EDLI, admin charges, PT, LWF and TDS round half-up; ESI rounds up; taxable income is rounded to the nearest ₹10 and the annual tax liability to the nearest ₹10; LOP proration rounds half-up; the special allowance absorbs rounding so structures sum to CTC.",
  };
}
/** Rule set in force today (shape kept stable for the settings / ruleset API). */
export const RULESET = buildRuleset(todayIst());
export const rulesetFor = (period: string) => buildRuleset(lastDayOf(period));

// ---------------------------------------------------------------- state resolution

const LOCATION_STATES: [RegExp, string][] = [
  [/bengaluru|bangalore|chikmagalur|chikkamagaluru|mysuru|mysore|mangalore|mangaluru|hubli|karnataka|coorg/i, "KA"],
  [/mumbai|pune|thane|nagpur|nashik|navi mumbai|maharashtra/i, "MH"],
  [/chennai|coimbatore|madurai|tamil nadu/i, "TN"],
  [/hyderabad|secunderabad|telangana/i, "TS"],
  [/kolkata|calcutta|west bengal/i, "WB"],
  [/noida|ghaziabad|lucknow|kanpur|varanasi|uttar pradesh/i, "UP"],
  [/gurugram|gurgaon|haryana|faridabad/i, "HR"],
  [/delhi/i, "DL"],
  [/ahmedabad|surat|vadodara|gujarat/i, "GJ"],
  [/visakhapatnam|vijayawada|andhra/i, "AP"],
  [/kochi|cochin|thiruvananthapuram|trivandrum|kozhikode|calicut|kerala/i, "KL"],
  [/jaipur|jodhpur|udaipur|rajasthan/i, "RJ"],
  [/ludhiana|amritsar|mohali|jalandhar|punjab/i, "PB"],
  [/\bgoa\b|panaji|panjim|margao/i, "GA"],
];

export function stateFromLocation(location: string | null | undefined) {
  if (!location) return null;
  return LOCATION_STATES.find(([pattern]) => pattern.test(location))?.[1] || null;
}
export function resolveState(profileState: string | null | undefined, location: string | null | undefined, orgDefault: string) {
  if (profileState) return { state: profileState, source: "profile" as const };
  const inferred = stateFromLocation(location);
  if (inferred) return { state: inferred, source: "location" as const };
  return { state: orgDefault, source: "organisation default" as const };
}
/** HRA 50% city for the tax year containing `period` (FY 2026-27 onwards: 8 cities; before: Delhi/Mumbai/Kolkata/Chennai). */
export const isMetroLocation = (location: string | null | undefined, period = currentPeriod()) =>
  Boolean(location && taxRulesFor(parsePeriod(period).fyStartYear).hraMetroPattern.test(location));

// ---------------------------------------------------------------- Labour Code wages

export type LabourCodeMode = "AUTO" | "ON" | "OFF";
/**
 * Code on Social Security 2020 s.2(88) proviso: where excluded payments (HRA, conveyance, other allowances, overtime,
 * commission …) exceed 50% of total remuneration, the excess is deemed wages. Returns the add-back (₹, rounded).
 * AUTO applies it to periods on/after the Codes' commencement (21 Nov 2025 → from the November 2025 wage month).
 */
export function labourCodeAddBack(input: { includedWages: number; totalRemuneration: number; period?: string; mode?: LabourCodeMode }) {
  const period = input.period || currentPeriod();
  const rule = inForce(LABOUR_CODE_RULES, lastDayOf(period));
  const mode = input.mode || "AUTO";
  const active = mode === "ON" || (mode === "AUTO" && rule.effectiveFrom <= lastDayOf(period));
  if (!active || input.totalRemuneration <= 0) return { active, addBack: 0, excluded: 0, limit: 0 };
  const excluded = Math.max(0, input.totalRemuneration - input.includedWages);
  const limit = input.totalRemuneration * rule.excludedLimit;
  return { active, addBack: Math.max(0, roundRupee(excluded - limit)), excluded, limit: roundRupee(limit) };
}

// ---------------------------------------------------------------- PF

export type PfResult = {
  applicable: boolean; basicEarned: number; pfWage: number; epsWage: number;
  employee: number; employerTotal: number; employerEps: number; employerEpf: number; edli: number; admin: number;
  /** Extra fields (always present). */
  wages: number; labourCodeAddBack: number; edliWage: number; vpf: number; ceiling: number; ceilingSegments: { fromDay: number; toDay: number; ceiling: number }[]; rulesVersion: string;
};
/**
 * PF / EPS / EDLI / admin for one month. `basicEarned` = earned Basic + DA (+ retaining allowance).
 * Where the wage ceiling changes inside the month (17 Sep 2026), wages and ceiling are apportioned by calendar days
 * per segment — EPFO FAQ Q7/Q9: 1–16 Sep at ₹15,000, 17–30 Sep at ₹25,000, one ECR.
 */
export function computePf(input: {
  basicEarned: number; applicable: boolean; wageMode: "CEILING" | "ACTUAL"; period?: string;
  /** Total remuneration for the Labour Code 50% test (earned gross excl. reimbursements). Omit to skip the test. */
  totalRemuneration?: number; labourCodeMode?: LabourCodeMode;
  /** false for members not eligible for EPS (joined above the ceiling after 1 Sep 2014, or past 58). Default true. */
  epsEligible?: boolean; vpfRate?: number; internationalWorker?: boolean;
}): PfResult {
  const period = input.period || currentPeriod();
  const basicEarned = Math.max(0, roundRupee(input.basicEarned));
  const lc = input.totalRemuneration !== undefined
    ? labourCodeAddBack({ includedWages: basicEarned, totalRemuneration: roundRupee(input.totalRemuneration), period, mode: input.labourCodeMode })
    : { addBack: 0 };
  const wages = basicEarned + lc.addBack;
  const { daysInMonth, segments } = segmentsForPeriod(PF_RULES, period);
  const rule = segments[segments.length - 1].rule;
  const ceilingSegments = segments.map((s) => ({ fromDay: s.fromDay, toDay: s.toDay, ceiling: s.rule.wageCeiling }));
  const zero: PfResult = {
    applicable: false, basicEarned, pfWage: 0, epsWage: 0, employee: 0, employerTotal: 0, employerEps: 0, employerEpf: 0, edli: 0, admin: 0,
    wages, labourCodeAddBack: lc.addBack, edliWage: 0, vpf: 0, ceiling: rule.wageCeiling, ceilingSegments, rulesVersion: segments.map((s) => s.rule.version).join("→"),
  };
  if (!input.applicable || wages === 0) return { ...zero, applicable: input.applicable };
  const capped = input.wageMode === "CEILING" && !input.internationalWorker;
  let pfWage = 0, cappedWage = 0;
  for (const segment of segments) {
    const share = segment.days / daysInMonth;
    const segmentWage = wages * share, segmentCeiling = segment.rule.wageCeiling * share;
    cappedWage += Math.min(segmentWage, segmentCeiling);
    pfWage += capped ? Math.min(segmentWage, segmentCeiling) : segmentWage;
  }
  // International workers: no ceiling on PF wages; EPS/EDLI still use the capped wage (CA to confirm EPS treatment).
  const epsWage = input.epsEligible === false ? 0 : cappedWage;
  const employee = roundRupee(pfWage * rule.employeeRate);
  const employerTotal = roundRupee(pfWage * rule.employerRate);
  const employerEps = Math.min(roundRupee(epsWage * rule.epsRate), employerTotal);
  const vpf = input.vpfRate && input.vpfRate > 0 ? roundRupee(wages * Math.min(input.vpfRate, 0.88)) : 0;
  return {
    ...zero, applicable: true, pfWage: roundRupee(pfWage), epsWage: roundRupee(epsWage), employee, employerTotal, employerEps,
    employerEpf: employerTotal - employerEps, edliWage: roundRupee(cappedWage),
    edli: roundRupee(cappedWage * rule.edliRate), admin: roundRupee(pfWage * rule.adminRate), vpf,
  };
}
/** True when an employee marked "PF not applicable" has PF wages within the ceiling — they must be enrolled. */
export function pfEnrolmentRequired(pfWages: number, period?: string) {
  return pfWages > 0 && pfWages <= inForce(PF_RULES, lastDayOf(period || currentPeriod())).wageCeiling;
}
export const pfRuleFor = (period?: string) => inForce(PF_RULES, lastDayOf(period || currentPeriod()));

// ---------------------------------------------------------------- ESI

export type EsiResult = { covered: boolean; reason: string; wages: number; employee: number; employer: number; lowWageExempt: boolean };
/** Coverage uses the rate of wages (fixed monthly gross from the salary structure), plus the contribution-period rule. */
export function esiCoverage(fixedMonthlyGross: number, coveredEarlierInPeriod: boolean, options: { disabled?: boolean; period?: string } = {}) {
  const rule = inForce(ESI_RULES, lastDayOf(options.period || currentPeriod()));
  const threshold = options.disabled ? rule.disabledWageThreshold : rule.wageThreshold;
  if (fixedMonthlyGross <= threshold) return { covered: true, reason: `Monthly gross ₹${fixedMonthlyGross.toLocaleString("en-IN")} ≤ ₹${threshold.toLocaleString("en-IN")}${options.disabled ? " (person with disability)" : ""}` };
  if (coveredEarlierInPeriod) return { covered: true, reason: "Covered earlier in this contribution period — continues until the period ends" };
  return { covered: false, reason: `Monthly gross above ₹${threshold.toLocaleString("en-IN")}` };
}
export function computeEsi(input: { covered: boolean; reason?: string; wages: number; payableDays: number; period?: string }): EsiResult {
  const rule = inForce(ESI_RULES, lastDayOf(input.period || currentPeriod()));
  const wages = Math.max(0, roundRupee(input.wages));
  if (!input.covered || wages === 0) return { covered: input.covered, reason: input.reason || "", wages: input.covered ? wages : 0, employee: 0, employer: 0, lowWageExempt: false };
  const dailyWage = input.payableDays > 0 ? wages / input.payableDays : 0;
  const lowWageExempt = dailyWage > 0 && dailyWage <= rule.lowWageDailyLimit;
  return {
    covered: true, reason: input.reason || "", wages, lowWageExempt,
    employee: lowWageExempt ? 0 : ceilRupee(wages * rule.employeeRate),
    employer: ceilRupee(wages * rule.employerRate),
  };
}

// ---------------------------------------------------------------- Professional Tax

const slabAmount = (slabs: PtSlab[], income: number, february: boolean) => {
  const slab = slabs.find((item) => item.upTo === null || income <= item.upTo);
  if (!slab) return 0;
  return february && slab.february !== undefined ? slab.february : slab.amount;
};
export type PtResult = { state: string; stateName: string; amount: number; rule: string; version?: string };
/**
 * PT for one month. `period` selects the schedule in force (defaults to the current month); `month` (1–12) drives the
 * February / half-year timing and is taken from `period` when given.
 */
export function computePt(state: string, monthlyGross: number, month: number, category: PtCategory = "STANDARD", period?: string): PtResult {
  const rule = PT_RULES[state];
  if (!rule) return { state, stateName: state, amount: 0, rule: "State not configured — no PT deducted; add it to rules/state-levies.ts." };
  const version = inForce(rule.versions, lastDayOf(period || currentPeriod()));
  const m = period ? Number(period.slice(5, 7)) : month;
  const base = { state, stateName: rule.name, rule: version.note, version: version.version };
  if (category === "EXEMPT") return { ...base, amount: 0, rule: "Employee marked PT-exempt" };
  if (version.frequency === "NONE" || monthlyGross <= 0) return { ...base, amount: 0 };
  const gross = roundRupee(monthlyGross);
  if (version.frequency === "HALF_YEARLY") {
    const halfYearTax = slabAmount(version.slabs, gross * 6, false);
    const sixth = Math.floor(halfYearTax / 6);
    return { ...base, amount: m === 9 || m === 3 ? halfYearTax - sixth * 5 : sixth };
  }
  if (version.basis === "ANNUAL_INCOME") return { ...base, amount: slabAmount(version.slabs, gross * 12, m === 2) };
  const slabs = category === "WOMAN" && version.womenSlabs ? version.womenSlabs : version.slabs;
  return { ...base, amount: slabAmount(slabs, gross, m === 2) };
}

// ---------------------------------------------------------------- Labour Welfare Fund

export type LwfResult = { state: string; applicable: boolean; employee: number; employer: number; frequency: string; note: string; version: string };
/** LWF deduction for the month (0 outside the state's deduction months). Amounts in paise round half-up to rupees. */
export function computeLwf(state: string, monthlyGross: number, period: string): LwfResult {
  const versions = LWF_RULES[state];
  if (!versions) return { state, applicable: false, employee: 0, employer: 0, frequency: "NONE", note: "No LWF configured for this state.", version: "NONE" };
  const v = inForce(versions, lastDayOf(period));
  const month = Number(period.slice(5, 7));
  if (v.frequency === "NONE" || !v.months.includes(month) || monthlyGross <= 0)
    return { state, applicable: v.frequency !== "NONE", employee: 0, employer: 0, frequency: v.frequency, note: v.note, version: v.version };
  if (v.employeeRate) {
    const employee = Math.min(roundRupee(monthlyGross * v.employeeRate), v.employee);
    return { state, applicable: true, employee, employer: Math.min(employee * (v.employerMultiple || 1), v.employer), frequency: v.frequency, note: v.note, version: v.version };
  }
  return { state, applicable: true, employee: roundRupee(v.employee), employer: roundRupee(v.employer), frequency: v.frequency, note: v.note, version: v.version };
}

// ---------------------------------------------------------------- Gratuity, bonus, overtime (helpers for F&F / annual runs)

/**
 * Gratuity = 15/26 × last drawn monthly wages × completed years (a final part-year above 6 months counts as a year).
 * Eligibility: 5 years' continuous service (permanent) or 1 year (fixed-term, Code on Social Security s.53); none
 * needed on death/disablement. Capped at ₹20 lakh. Returns 0 when not eligible.
 */
export function computeGratuity(input: { lastDrawnWages: number; serviceYears: number; serviceMonths: number; fixedTerm?: boolean; deathOrDisablement?: boolean; asOf?: string }) {
  const rule = inForce(GRATUITY_RULES, input.asOf || todayIst());
  const exact = input.serviceYears + input.serviceMonths / 12;
  const minYears = input.fixedTerm ? rule.fixedTermMinYears : rule.permanentMinYears;
  const eligible = Boolean(input.deathOrDisablement) || exact >= minYears;
  const years = input.serviceYears + (input.serviceMonths > rule.roundUpMonths ? 1 : 0);
  if (!eligible) return { eligible: false, years, amount: 0, capped: false, rule: rule.version };
  const raw = roundRupee(input.lastDrawnWages * rule.factor * years);
  return { eligible: true, years, amount: Math.min(raw, rule.cap), capped: raw > rule.cap, rule: rule.version };
}

/**
 * Statutory bonus for an accounting year: rate (8.33%–20%) × Σ min(monthly wages, max(₹7,000, minimum wage)) over
 * months worked; eligible only if monthly wages ≤ ₹21,000 and ≥ 30 working days. Minimum bonus is the higher of
 * 8.33% and ₹100.
 */
export function computeBonus(input: { monthlyWages: number[]; rate: number; minimumWage?: number; daysWorked: number; asOf?: string }) {
  const rule = inForce(BONUS_RULES, input.asOf || todayIst());
  const rate = Math.min(rule.maxRate, Math.max(rule.minRate, input.rate));
  const ceiling = Math.max(rule.calculationCeiling, input.minimumWage || 0);
  const eligibleMonths = input.monthlyWages.filter((wage) => wage <= rule.eligibilityWage);
  if (input.daysWorked < rule.minDaysWorked || !eligibleMonths.length) return { eligible: false, rate, ceiling, bonusWages: 0, amount: 0, rule: rule.version };
  const bonusWages = eligibleMonths.reduce((sum, wage) => sum + Math.min(wage, ceiling), 0);
  return { eligible: true, rate, ceiling, bonusWages, amount: Math.max(rule.minAmount, roundRupee(bonusWages * rate)), rule: rule.version };
}

/**
 * Overtime = hours × multiplier (2×) × ordinary hourly rate. Ordinary hourly rate = monthly wages ÷ (days × hours);
 * the 26 × 8 divisor is a configurable convention — confirm the basis used by your State rules / standing orders.
 */
export function overtimePay(input: { monthlyWages: number; hours: number; daysPerMonth?: number; hoursPerDay?: number; asOf?: string }) {
  const rule = inForce(OVERTIME_RULES, input.asOf || todayIst());
  const hourly = input.monthlyWages / ((input.daysPerMonth || 26) * (input.hoursPerDay || 8));
  return roundRupee(hourly * rule.multiplier * Math.max(0, input.hours));
}

// ---------------------------------------------------------------- LOP / payable days

export type LeaveSpan = { startDate: string; endDate: string; days: number };
const dayNumber = (date: string) => Math.floor(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000);

/**
 * Unpaid leave days falling in the month. A request entirely inside the month counts its recorded `days` (keeps
 * half-days); one spanning months is split in proportion to its calendar days, rounded to the nearest half day.
 */
export function lopDaysInPeriod(period: string, leaves: LeaveSpan[]) {
  const { firstDay, lastDay } = parsePeriod(period);
  const monthStart = dayNumber(firstDay), monthEnd = dayNumber(lastDay);
  let total = 0;
  for (const leave of leaves) {
    const start = dayNumber(leave.startDate), end = dayNumber(leave.endDate);
    const overlap = Math.min(end, monthEnd) - Math.max(start, monthStart) + 1;
    if (overlap <= 0) continue;
    const span = end - start + 1;
    total += overlap === span ? Number(leave.days) : Math.round((Number(leave.days) * overlap / span) * 2) / 2;
  }
  return total;
}

/** Calendar-day proration: days before joining are not payable; LOP days are deducted from the employed days. */
export function payableDays(period: string, joiningDate: string | null, lopDays: number) {
  const { daysInMonth, firstDay, lastDay } = parsePeriod(period);
  let employedDays = daysInMonth;
  if (joiningDate && joiningDate > lastDay) employedDays = 0;
  else if (joiningDate && joiningDate > firstDay) employedDays = daysInMonth - (Number(joiningDate.slice(8, 10)) - 1);
  const lop = Math.min(Math.max(0, lopDays), employedDays);
  const payable = Math.max(0, employedDays - lop);
  return { daysInMonth, employedDays, lopDays: lop, payableDays: payable, ratio: payable / daysInMonth, joinedThisMonth: Boolean(joiningDate && joiningDate >= firstDay && joiningDate <= lastDay) };
}
export const prorate = (monthly: number, payable: number, daysInMonth: number) => roundRupee(monthly * payable / daysInMonth);

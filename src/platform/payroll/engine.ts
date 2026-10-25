/**
 * Per-employee monthly payroll calculation (pure — no database access, so it is unit-testable).
 * Order: payable days (joining + LOP) → prorated fixed earnings → one-time inputs → PF → ESI → PT → TDS projection
 * → net pay → employer cost → review flags.
 */
import {
  addMonths, computeEsi, computeLwf, computePf, computePt, esiCoverage, isMetroLocation, parsePeriod, payableDays, pfEnrolmentRequired, prorate, roundRupee,
  type LabourCodeMode, type PtCategory,
} from "./statutory";
import { projectTds, type AgeCategory, type Declarations, type Regime, type TdsProjection } from "./tax-engine";
import { MINIMUM_WAGES, rulesStamp, taxRulesFor } from "./rules";
import type { StructureComponent } from "./structure";

export type InputKind = "EARNING" | "DEDUCTION" | "REIMBURSEMENT" | "LOP";
export type RunInput = { id?: string; kind: InputKind; code: string; label: string; amount: number; days?: number | null; taxable: boolean; esiWage: boolean; source?: string };
export type Flag = { code: string; tone: "info" | "warning" | "danger"; message: string; blocking?: boolean };
export type Line = { code: string; label: string; amount: number; full?: number; note?: string; taxable?: boolean };

export type LineContext = {
  period: string;
  employee: { joiningDate: string | null; location: string | null };
  structure: { components: StructureComponent[]; fixedMonthlyGross: number; isMetro: boolean } | null;
  profile: {
    regime: Regime; pfApplicable: boolean; ptCategory: PtCategory; state: string; stateSource: string; declarations: Declarations; hasPan: boolean; hasBank: boolean;
    /** UAN / ESI IP number on file (undefined = unknown, no flag). Needed for the PF ECR and ESI return lines. */
    hasUan?: boolean; hasEsiNumber?: boolean;
    /** Optional statutory flags (default: EPS member, not disabled, no VPF, domestic worker, age < 60). */
    epsEligible?: boolean; disabled?: boolean; vpfRate?: number; internationalWorker?: boolean; ageCategory?: AgeCategory;
  };
  settings: {
    pfWageMode: "CEILING" | "ACTUAL";
    /** Labour Code 50% wage rule for PF: AUTO = from the Codes' commencement (Nov 2025 wage month). Default AUTO. */
    labourCodeWages?: LabourCodeMode;
    /** Deduct Labour Welfare Fund (only once the establishment's LWF registration / rates are confirmed). Default false. */
    lwfEnabled?: boolean;
    /** Monthly minimum wage floor (Basic + DA) for the employee's State / skill, if configured. */
    minimumWageMonthly?: number | null;
  };
  leaveLopDays: number;
  inputs: RunInput[];
  ytd: { taxable: number; tds: number; pf: number; pt: number; gross: number; net: number; months: number };
  esiCoveredEarlierInPeriod: boolean;
  previous: { net: number; period: string } | null;
};

export type LineResult = ReturnType<typeof calculateLine>;

const sum = (lines: { amount: number }[]) => lines.reduce((total, line) => total + line.amount, 0);

export function calculateLine(ctx: LineContext) {
  const flags: Flag[] = [];
  const p = parsePeriod(ctx.period);
  const manualLop = ctx.inputs.filter((input) => input.kind === "LOP").reduce((total, input) => total + Number(input.days || 0), 0);
  const days = payableDays(ctx.period, ctx.employee.joiningDate, ctx.leaveLopDays + manualLop);
  if (!ctx.structure) {
    flags.push({ code: "MISSING_STRUCTURE", tone: "danger", message: "No salary structure in effect for this month — employee excluded from the run." });
    return { included: false as const, days, flags };
  }
  const component = (code: string) => ctx.structure!.components.find((item) => item.code === code)?.monthly || 0;

  // Fixed earnings, prorated by payable calendar days.
  const earnings: Line[] = ctx.structure.components
    .filter((item) => item.kind === "EARNING" && item.monthly > 0)
    .map((item) => ({ code: item.code, label: item.label, full: item.monthly, amount: prorate(item.monthly, days.payableDays, days.daysInMonth), taxable: true }));
  const regularGross = sum(earnings);
  const oneTime: Line[] = ctx.inputs.filter((input) => input.kind === "EARNING")
    .map((input) => ({ code: input.code, label: input.label, amount: roundRupee(input.amount), taxable: input.taxable, note: input.source === "EXPENSE_CLAIM" ? "Expense claim" : undefined }));
  const reimbursements: Line[] = ctx.inputs.filter((input) => input.kind === "REIMBURSEMENT")
    .map((input) => ({ code: input.code, label: input.label, amount: roundRupee(input.amount), taxable: false, note: input.source === "EXPENSE_CLAIM" ? "Approved expense claim" : undefined }));
  const gross = regularGross + sum(oneTime);
  const oneTimeTaxable = sum(oneTime.filter((line) => line.taxable));
  const oneTimeEsi = ctx.inputs.filter((input) => input.kind === "EARNING" && input.esiWage).reduce((total, input) => total + roundRupee(input.amount), 0);

  // PF on earned Basic (+ Labour Code add-back when excluded allowances exceed 50% of remuneration).
  const basicEarned = earnings.find((line) => line.code === "BASIC")?.amount || 0;
  const pfOptions = {
    wageMode: ctx.settings.pfWageMode, labourCodeMode: ctx.settings.labourCodeWages || "AUTO" as LabourCodeMode,
    epsEligible: ctx.profile.epsEligible, vpfRate: ctx.profile.vpfRate, internationalWorker: ctx.profile.internationalWorker,
  };
  const pf = computePf({ ...pfOptions, basicEarned, applicable: ctx.profile.pfApplicable, period: ctx.period, totalRemuneration: regularGross });
  // ESI: coverage from rate of wages; contribution on wages paid (excludes bonus and reimbursements).
  const coverage = esiCoverage(ctx.structure.fixedMonthlyGross, ctx.esiCoveredEarlierInPeriod, { disabled: ctx.profile.disabled, period: ctx.period });
  const esi = computeEsi({ covered: coverage.covered, reason: coverage.reason, wages: regularGross + oneTimeEsi, payableDays: days.payableDays, period: ctx.period });
  // PT on the month's gross salary; LWF in the state's deduction months.
  const pt = computePt(ctx.profile.state, gross, p.month, ctx.profile.ptCategory, ctx.period);
  const lwfDue = computeLwf(ctx.profile.state, gross, ctx.period);
  const lwf = ctx.settings.lwfEnabled ? lwfDue : { ...lwfDue, employee: 0, employer: 0 };

  // TDS: annual projection.
  const futureMonths = p.remainingMonthsIncludingCurrent - 1;
  const fullGross = ctx.structure.fixedMonthlyGross;
  // Future months use the rules of the next period (e.g. the ₹25,000 PF ceiling from October 2026).
  const nextPeriod = addMonths(ctx.period, 1);
  const futurePfResult = computePf({ ...pfOptions, basicEarned: component("BASIC"), applicable: ctx.profile.pfApplicable, period: nextPeriod, totalRemuneration: fullGross });
  const futurePf = futurePfResult.employee + futurePfResult.vpf;
  let futurePt = 0, futurePfTotal = 0, futureEmployerPf = 0;
  for (let i = 1; i <= futureMonths; i++) {
    const futurePeriod = addMonths(ctx.period, i);
    futurePt += computePt(ctx.profile.state, fullGross, Number(futurePeriod.slice(5, 7)), ctx.profile.ptCategory, futurePeriod).amount;
    // Each future month with its own PF rules (a ceiling change later in the FY changes the 80C projection).
    const monthPf = i === 1 ? futurePfResult : computePf({ ...pfOptions, basicEarned: component("BASIC"), applicable: ctx.profile.pfApplicable, period: futurePeriod, totalRemuneration: fullGross });
    futurePfTotal += monthPf.employee + monthPf.vpf; futureEmployerPf += monthPf.employerTotal;
  }
  // HRA exemption uses Basic/HRA for the months actually paid in this FY (earlier runs + this month + projection).
  const monthsCounted = ctx.ytd.months + 1 + futureMonths;
  const metro = ctx.structure.isMetro || isMetroLocation(ctx.employee.location, ctx.period);
  const tax: TdsProjection = projectTds({
    regime: ctx.profile.regime, monthsRemainingIncludingCurrent: p.remainingMonthsIncludingCurrent, fyStartYear: p.fyStartYear,
    priorTaxable: ctx.ytd.taxable, priorTds: ctx.ytd.tds, priorPf: ctx.ytd.pf, priorPt: ctx.ytd.pt,
    currentRegular: regularGross, currentOneTime: oneTimeTaxable, currentPf: pf.employee + pf.vpf, currentPt: pt.amount,
    futureMonthlyTaxable: fullGross, futureMonthlyPf: futurePf, futurePt, futurePfTotal,
    annualBasic: component("BASIC") * monthsCounted, annualHra: component("HRA") * monthsCounted, metro,
    employerPfAnnual: pf.employerTotal + futureEmployerPf,
    declarations: { ...ctx.profile.declarations, ageCategory: ctx.profile.ageCategory ?? ctx.profile.declarations?.ageCategory },
  });
  let tds = days.payableDays > 0 || oneTimeTaxable > 0 ? tax.monthlyTds : 0;
  // No PAN: TDS at the higher of the average rate and 20% (s.206AA of the 1961 Act / corresponding 2025-Act provision).
  const taxRules = taxRulesFor(p.fyStartYear);
  let noPanApplied = false;
  if (!ctx.profile.hasPan && tax.annualLiability > 0 && (days.payableDays > 0 || oneTimeTaxable > 0)) {
    const floor = roundRupee((regularGross + oneTimeTaxable) * taxRules.noPanRate);
    if (floor > tds) { tds = floor; noPanApplied = true; }
  }

  const deductions: Line[] = [];
  if (pf.employee) deductions.push({ code: "PF", label: "Provident fund (employee 12%)", amount: pf.employee, note: `12% of PF wage ₹${pf.pfWage.toLocaleString("en-IN")}${pf.labourCodeAddBack ? ` (incl. ₹${pf.labourCodeAddBack.toLocaleString("en-IN")} Labour Code add-back)` : ""}` });
  if (pf.vpf) deductions.push({ code: "VPF", label: "Voluntary provident fund", amount: pf.vpf });
  if (esi.employee) deductions.push({ code: "ESI", label: "ESI (employee 0.75%)", amount: esi.employee, note: `0.75% of ₹${esi.wages.toLocaleString("en-IN")}` });
  if (pt.amount) deductions.push({ code: "PT", label: `Professional tax — ${pt.stateName}`, amount: pt.amount });
  if (lwf.employee) deductions.push({ code: "LWF", label: `Labour welfare fund — ${pt.stateName}`, amount: lwf.employee });
  if (tds) deductions.push({ code: "TDS", label: "Income tax (TDS)", amount: tds, note: noPanApplied ? "20% — PAN not furnished" : `${ctx.profile.regime === "NEW" ? "New" : "Old"} regime projection` });
  for (const input of ctx.inputs.filter((item) => item.kind === "DEDUCTION"))
    deductions.push({ code: input.code, label: input.label, amount: roundRupee(input.amount) });
  const totalDeductions = sum(deductions);
  const totalReimbursements = sum(reimbursements);
  const net = gross + totalReimbursements - totalDeductions;

  const employer: Line[] = [];
  if (pf.applicable && pf.employerTotal) {
    employer.push({ code: "EPF_ER", label: "Employer EPF (3.67%)", amount: pf.employerEpf });
    employer.push({ code: "EPS_ER", label: "Employer EPS (8.33%)", amount: pf.employerEps, note: pf.epsWage ? `8.33% of ₹${pf.epsWage.toLocaleString("en-IN")} (wages up to the ₹${pf.ceiling.toLocaleString("en-IN")} ceiling)` : "Not an EPS member — full 12% to EPF" });
    employer.push({ code: "EDLI", label: "EDLI (0.5%)", amount: pf.edli });
    employer.push({ code: "PF_ADMIN", label: "EPF admin charges (0.5%)", amount: pf.admin });
  }
  if (esi.employer) employer.push({ code: "ESI_ER", label: "Employer ESI (3.25%)", amount: esi.employer });
  if (lwf.employer) employer.push({ code: "LWF_ER", label: "Employer labour welfare fund", amount: lwf.employer });
  const gratuity = component("GRATUITY");
  if (gratuity) employer.push({ code: "GRATUITY", label: "Gratuity provision", amount: prorate(gratuity, days.payableDays, days.daysInMonth) });
  const employerTotal = sum(employer);

  // Review flags.
  if (days.joinedThisMonth) flags.push({ code: "NEW_JOINER", tone: "info", message: `Joined on ${ctx.employee.joiningDate} — paid for ${days.employedDays} of ${days.daysInMonth} days.` });
  if (days.lopDays > 0) flags.push({ code: "LOP", tone: "info", message: `${days.lopDays} loss-of-pay day${days.lopDays === 1 ? "" : "s"} (${ctx.leaveLopDays} from approved unpaid leave, ${manualLop} entered manually).` });
  if (days.payableDays === 0) flags.push({ code: "ZERO_PAYABLE", tone: "warning", message: "No payable days this month." });
  if (net < 0) flags.push({ code: "NEGATIVE_NET", tone: "danger", message: `Deductions exceed earnings by ₹${Math.abs(net).toLocaleString("en-IN")} — hold the employee or adjust recoveries.`, blocking: true });
  let variancePct: number | null = null;
  if (ctx.previous && ctx.previous.net > 0) {
    variancePct = Math.round(((net - ctx.previous.net) / ctx.previous.net) * 10000) / 100;
    if (Math.abs(variancePct) > 10) flags.push({ code: "VARIANCE", tone: "warning", message: `Net pay ${variancePct > 0 ? "up" : "down"} ${Math.abs(variancePct).toFixed(1)}% vs ${ctx.previous.period} (₹${ctx.previous.net.toLocaleString("en-IN")}).` });
  }
  if (!ctx.profile.hasBank) flags.push({ code: "MISSING_BANK", tone: "warning", message: "No bank account on file — excluded from the bank transfer file." });
  if (!ctx.profile.hasPan && tds > 0) flags.push({ code: "MISSING_PAN", tone: "warning", message: "PAN missing — s.206AA may require TDS at 20%; collect PAN before publishing." });
  if (pf.employee > 0 && ctx.profile.hasUan === false)
    flags.push({ code: "MISSING_UAN", tone: "warning", message: "No UAN on file — the PF ECR line for this employee can't be uploaded to EPFO until the UAN is added (generate one on the EPFO portal for new joiners)." });
  if (esi.employee > 0 && ctx.profile.hasEsiNumber === false)
    flags.push({ code: "MISSING_ESI_IP", tone: "warning", message: "Covered by ESI but no ESI IP number on file — register the employee on the ESIC portal and add the IP number before filing the ESI return." });
  if (esi.covered && coverage.reason.startsWith("Covered earlier")) flags.push({ code: "ESI_CONTINUED", tone: "info", message: coverage.reason });
  if (noPanApplied) flags.push({ code: "NO_PAN_TDS", tone: "warning", message: `PAN not furnished — TDS deducted at 20% (₹${tds.toLocaleString("en-IN")}) instead of the slab projection.` });
  const fullPfWage = component("BASIC") + futurePfResult.labourCodeAddBack;
  if (!ctx.profile.pfApplicable && pfEnrolmentRequired(fullPfWage, ctx.period))
    flags.push({ code: "PF_ENROLMENT_REQUIRED", tone: "danger", message: `PF wages ₹${fullPfWage.toLocaleString("en-IN")} are within the ₹${pf.ceiling.toLocaleString("en-IN")} ceiling — this employee must be enrolled in EPF/EPS/EDLI (marked "PF not applicable").` });
  if (pf.ceilingSegments.length > 1) flags.push({ code: "PF_CEILING_SPLIT", tone: "info", message: `PF wage ceiling changed during the month (${pf.ceilingSegments.map((s) => `${s.fromDay}–${s.toDay}: ₹${s.ceiling.toLocaleString("en-IN")}`).join(", ")}); wages apportioned by days per EPFO FAQ.` });
  if (pf.labourCodeAddBack) flags.push({ code: "LABOUR_CODE_WAGES", tone: "info", message: `Allowances exceed 50% of remuneration — ₹${pf.labourCodeAddBack.toLocaleString("en-IN")} added to PF wages (Code on Social Security s.2(88)).` });
  if (!ctx.settings.lwfEnabled && (lwfDue.employee || lwfDue.employer)) flags.push({ code: "LWF_NOT_DEDUCTED", tone: "info", message: `${pt.stateName} Labour Welfare Fund is due this month (₹${lwfDue.employee} employee / ₹${lwfDue.employer} employer) but LWF deduction is not enabled for the organisation.` });
  if (tax.rulesAssumed) flags.push({ code: "TAX_RULES_ASSUMED", tone: "warning", message: `Income-tax rules for FY ${p.fyLabel} are not configured — the nearest configured year (${tax.rulesVersion}) was used.` });
  const minimumWage = ctx.settings.minimumWageMonthly ?? MINIMUM_WAGES[ctx.profile.state]?.monthlyFloor ?? null;
  if (minimumWage && component("BASIC") < minimumWage) flags.push({ code: "BELOW_MINIMUM_WAGE", tone: "danger", message: `Monthly Basic ₹${component("BASIC").toLocaleString("en-IN")} is below the configured minimum wage ₹${minimumWage.toLocaleString("en-IN")}.` });

  return {
    included: true as const, days, flags, variancePct,
    earnings, oneTime, reimbursements, deductions, employer,
    totals: { regularGross, gross, reimbursements: totalReimbursements, deductions: totalDeductions, net, employerContributions: employerTotal, employerCost: gross + totalReimbursements + employerTotal, taxable: regularGross + oneTimeTaxable },
    statutory: {
      pf, esi: { ...esi, rateOfWages: ctx.structure.fixedMonthlyGross }, pt: { ...pt, category: ctx.profile.ptCategory, source: ctx.profile.stateSource },
      lwf: { ...lwf, enabled: Boolean(ctx.settings.lwfEnabled) },
      tds: { amount: tds, regime: ctx.profile.regime, noPanApplied },
      rules: rulesStamp(ctx.period),
    },
    tax,
    ytd: { gross: ctx.ytd.gross + gross, taxable: ctx.ytd.taxable + regularGross + oneTimeTaxable, tds: ctx.ytd.tds + tds, pf: ctx.ytd.pf + pf.employee + pf.vpf, pt: ctx.ytd.pt + pt.amount, net: ctx.ytd.net + net },
  };
}

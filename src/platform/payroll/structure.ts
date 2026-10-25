/**
 * Annual CTC → monthly salary structure (default Indian template).
 *
 * Fixed CTC = annual CTC − annual variable pay. Monthly fixed CTC is split into:
 *   Basic            = basicPct × monthly fixed CTC (default 50%)
 *   HRA              = hraPct × Basic (default 50% for metro cities, 40% otherwise — the s.10(13A) exemption limits)
 *   Conveyance       = fixed monthly amount (default ₹1,600)
 *   Other allowance  = fixed monthly amount (default ₹0)
 *   Employer PF      = 12% of PF wage (Basic, capped at the EPF wage ceiling in force on `asOf` — ₹25,000 from
 *                      17 Sep 2026, ₹15,000 before — unless the org pays on actual Basic)
 *   Gratuity         = 4.81% of Basic when the org includes the gratuity provision in CTC
 *   Employer ESI     = 3.25% of gross when the monthly gross is ≤ ₹21,000
 *   Special allowance= balancing figure so that the components sum exactly to monthly fixed CTC.
 * Monthly amounts are whole rupees; the only residue vs the annual CTC is the ≤ ₹6/year from rounding monthly fixed
 * CTC to the rupee, which is reported in `check`.
 */
import { ceilRupee, pfRuleFor, roundRupee } from "./statutory";
import { ESI_RULES, GRATUITY_RULES, inForce, todayIst } from "./rules";

export type StructureTemplate = {
  basicPct: number; hraPct: number; conveyance: number; otherAllowance: number; variablePct: number; includeGratuity: boolean;
};
export type ComponentCode = "BASIC" | "HRA" | "CONVEYANCE" | "OTHER_ALLOWANCE" | "SPECIAL" | "EMPLOYER_PF" | "EMPLOYER_ESI" | "GRATUITY" | "VARIABLE";
export type StructureComponent = {
  code: ComponentCode; label: string; kind: "EARNING" | "EMPLOYER" | "VARIABLE"; monthly: number; annual: number;
  taxable: boolean; pfWage: boolean; esiWage: boolean; note?: string;
};
export type BuiltStructure = {
  annualCtc: number; annualVariable: number; monthlyCtc: number; fixedMonthlyGross: number; esiApplicable: boolean;
  components: StructureComponent[]; monthly: Record<ComponentCode, number>;
  check: { componentsAnnual: number; difference: number; ok: boolean };
  errors: string[]; warnings: string[]; template: StructureTemplate; isMetro: boolean; pfWageMode: "CEILING" | "ACTUAL"; pfApplicable: boolean;
};

export const defaultTemplate = (isMetro: boolean): StructureTemplate => ({
  basicPct: 0.5, hraPct: isMetro ? 0.5 : 0.4, conveyance: 1600, otherAllowance: 0, variablePct: 0, includeGratuity: false,
});

export function buildStructure(input: {
  annualCtc: number; template?: Partial<StructureTemplate>; isMetro: boolean; pfWageMode: "CEILING" | "ACTUAL"; pfApplicable: boolean;
  /** Date (YYYY-MM-DD) whose statutory rules apply — normally the structure's effective-from date. Defaults to today. */
  asOf?: string;
}): BuiltStructure {
  const asOf = input.asOf || todayIst();
  const pfRule = pfRuleFor(asOf.slice(0, 7)), esiRule = inForce(ESI_RULES, asOf), gratuityRule = inForce(GRATUITY_RULES, asOf);
  // Ignore absent/undefined overrides (DTO instances carry undefined fields) and non-finite numbers.
  const overrides = Object.fromEntries(Object.entries(input.template || {}).filter(([, value]) => value !== undefined && value !== null && (typeof value !== "number" || Number.isFinite(value))));
  const template: StructureTemplate = { ...defaultTemplate(input.isMetro), ...overrides };
  const errors: string[] = [], warnings: string[] = [];
  const annualCtc = roundRupee(input.annualCtc);
  if (!(annualCtc > 0)) errors.push("Annual CTC must be greater than zero.");
  if (template.basicPct < 0.3 || template.basicPct > 0.8) errors.push("Basic must be between 30% and 80% of fixed pay.");
  if (template.hraPct < 0 || template.hraPct > 0.5) errors.push("HRA must be between 0% and 50% of Basic.");
  if (template.variablePct < 0 || template.variablePct > 0.4) errors.push("Variable pay must be between 0% and 40% of CTC.");
  if (template.conveyance < 0 || template.otherAllowance < 0) errors.push("Allowances cannot be negative.");

  const annualVariable = roundRupee(annualCtc * template.variablePct);
  const fixedAnnual = annualCtc - annualVariable;
  const monthlyCtc = roundRupee(fixedAnnual / 12);
  const basic = roundRupee(monthlyCtc * template.basicPct);
  const hra = roundRupee(basic * template.hraPct);
  const conveyance = roundRupee(template.conveyance), other = roundRupee(template.otherAllowance);
  const pfWage = input.pfWageMode === "CEILING" ? Math.min(basic, pfRule.wageCeiling) : basic;
  const employerPf = input.pfApplicable ? roundRupee(pfWage * pfRule.employerRate) : 0;
  const gratuity = template.includeGratuity ? roundRupee(basic * gratuityRule.provisionRate) : 0;
  const available = monthlyCtc - employerPf - gratuity; // gross + employer ESI

  let gross = available, employerEsi = 0;
  if (available / (1 + esiRule.employerRate) <= esiRule.wageThreshold) {
    gross = Math.floor(available / (1 + esiRule.employerRate));
    for (let i = 0; i < 6; i++) {
      employerEsi = ceilRupee(gross * esiRule.employerRate);
      const next = available - employerEsi;
      if (next === gross) break;
      gross = next;
    }
    // Keep the invariant employerEsi == ceil(3.25% × gross) even after the balancing step.
    while (gross > 0 && ceilRupee(gross * esiRule.employerRate) + gross > available) gross -= 1;
    employerEsi = available - gross;
  }
  const esiApplicable = employerEsi > 0;
  const special = gross - basic - hra - conveyance - other;
  if (special < 0) errors.push(`Basic, HRA and allowances exceed the fixed pay by ₹${Math.abs(special).toLocaleString("en-IN")}/month — lower the percentages or allowances.`);
  if (gross > 0 && basic < gross * 0.5 - 0.5) warnings.push("Basic is below 50% of gross pay: under the Code on Social Security 2020 wage definition, allowances above 50% may count as PF wages.");
  if (esiApplicable) warnings.push(`Monthly gross is within the ₹${esiRule.wageThreshold.toLocaleString("en-IN")} ESI limit — employee (0.75%) and employer (3.25%) ESI apply.`);
  if (!input.pfApplicable && basic <= pfRule.wageCeiling) warnings.push(`PF should not be switched off: Basic ₹${basic.toLocaleString("en-IN")} is within the ₹${pfRule.wageCeiling.toLocaleString("en-IN")} EPF wage ceiling, so EPF/EPS/EDLI membership is mandatory — payroll runs will flag this employee.`);
  else if (!input.pfApplicable) warnings.push(`PF is switched off for this employee (excluded employee) — confirm their PF wages exceeded ₹${pfRule.wageCeiling.toLocaleString("en-IN")} when they joined and that they were never a member.`);

  const components: StructureComponent[] = [
    { code: "BASIC", label: "Basic salary", kind: "EARNING", monthly: basic, annual: basic * 12, taxable: true, pfWage: true, esiWage: true, note: `${Math.round(template.basicPct * 100)}% of fixed pay` },
    { code: "HRA", label: "House rent allowance", kind: "EARNING", monthly: hra, annual: hra * 12, taxable: true, pfWage: false, esiWage: true, note: `${Math.round(template.hraPct * 100)}% of Basic${input.isMetro ? " (metro)" : ""}` },
    { code: "CONVEYANCE", label: "Conveyance allowance", kind: "EARNING", monthly: conveyance, annual: conveyance * 12, taxable: true, pfWage: false, esiWage: true },
    { code: "OTHER_ALLOWANCE", label: "Other allowance", kind: "EARNING", monthly: other, annual: other * 12, taxable: true, pfWage: false, esiWage: true },
    { code: "SPECIAL", label: "Special allowance", kind: "EARNING", monthly: special, annual: special * 12, taxable: true, pfWage: false, esiWage: true, note: "Balancing component" },
    { code: "EMPLOYER_PF", label: "Employer PF", kind: "EMPLOYER", monthly: employerPf, annual: employerPf * 12, taxable: false, pfWage: false, esiWage: false, note: input.pfApplicable ? `12% of ₹${pfWage.toLocaleString("en-IN")}` : "Not applicable" },
    { code: "EMPLOYER_ESI", label: "Employer ESI", kind: "EMPLOYER", monthly: employerEsi, annual: employerEsi * 12, taxable: false, pfWage: false, esiWage: false, note: esiApplicable ? "3.25% of gross" : `Gross above ₹${esiRule.wageThreshold.toLocaleString("en-IN")}` },
    { code: "GRATUITY", label: "Gratuity provision", kind: "EMPLOYER", monthly: gratuity, annual: gratuity * 12, taxable: false, pfWage: false, esiWage: false, note: template.includeGratuity ? "4.81% of Basic" : "Not included in CTC" },
    { code: "VARIABLE", label: "Variable pay (annual)", kind: "VARIABLE", monthly: 0, annual: annualVariable, taxable: true, pfWage: false, esiWage: false, note: annualVariable ? "Paid as one-time earnings when awarded" : "None" },
  ];
  const monthly = Object.fromEntries(components.map((item) => [item.code, item.monthly])) as Record<ComponentCode, number>;
  const componentsAnnual = components.reduce((sum, item) => sum + item.annual, 0);
  const difference = annualCtc - componentsAnnual;
  const ok = Math.abs(difference) <= 12 && !errors.length;
  if (Math.abs(difference) > 12) errors.push(`Components add up to ₹${componentsAnnual.toLocaleString("en-IN")}, not the CTC of ₹${annualCtc.toLocaleString("en-IN")}.`);
  return {
    annualCtc, annualVariable, monthlyCtc, fixedMonthlyGross: gross, esiApplicable, components, monthly,
    check: { componentsAnnual, difference, ok }, errors, warnings, template, isMetro: input.isMetro, pfWageMode: input.pfWageMode, pfApplicable: input.pfApplicable,
  };
}

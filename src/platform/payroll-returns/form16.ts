/**
 * Annual salary TDS certificate data (pure): Form 130 / Form 16 Part B salary computation, the perquisite statement
 * (Form 12BA / Form 130 Annexure II) and the Annexure II salary-detail row of the Q4 statement.
 *
 * The computation mirrors the payroll engine's final-month projection (tax-engine.ts projectTds → calculateTax) on the
 * actual figures of the year — published/locked payroll lines plus switch-over opening YTD plus previous-employer
 * income — so the certificate's "tax on total income" equals what the engine deducted when nothing changed mid-year.
 */
import { calculateTax, hraExemption, type AgeCategory, type Declarations, type Regime } from "../payroll/tax-engine";
import { taxRulesFor } from "../payroll/rules";
import { formNames, fyLabel, quarterOfPeriod, type Quarter } from "./tds-math";

export type MonthRecord = {
  period: string; payDate: string; earnings: { code: string; label: string; amount: number; taxable: boolean }[];
  gross: number; taxable: number; tds: number; pf: number; pt: number; employerPf: number; employerNps: number;
};
export type OpeningYtd = {
  employeeId: string; source: string; throughPeriod: string | null; months: number;
  gross: number; taxable: number; tds: number; pf: number; pt: number; basic: number; hra: number; employerPf: number;
  quarterTds?: Partial<Record<Quarter, number>>;
};
export type QuarterReceipt = { quarter: Quarter; token: string | null; status: string };
export type ChallanLine = { period: string; bsrCode: string; challanSerial: string; depositDate: string; tds: number; quarter: Quarter };

export type Form16Input = {
  fyStart: number; regime: Regime; ageCategory?: AgeCategory; metro: boolean;
  employee: { id: string; number: string; name: string; designation: string | null; joiningDate: string | null; panMasked: string | null; hasPan: boolean };
  employer: { name: string; tan: string | null; panMasked: string | null; address: string; responsibleName: string | null; responsibleDesignation: string | null };
  months: MonthRecord[]; opening: OpeningYtd | null; declarations: Declarations; receipts: QuarterReceipt[]; challans: ChallanLine[];
  /** Relief for arrears (s.89 of the 1961 Act) as computed in Form 10E, if any — not computed by payroll. */
  relief89?: number; exitDate?: string | null;
};

const sum = <T>(rows: T[], pick: (row: T) => number) => Math.round(rows.reduce((t, row) => t + (Number(pick(row)) || 0), 0) * 100) / 100;
const r0 = (n: number) => Math.round(n);

export function computeForm16(input: Form16Input) {
  const names = formNames(input.fyStart);
  const rules = taxRulesFor(input.fyStart);
  const d = input.declarations || {};
  const isOld = input.regime === "OLD";
  const opening = input.opening;
  const months = [...input.months].sort((a, b) => a.period.localeCompare(b.period));

  // Salary u/s 17(1) by component (taxable earnings only; reimbursements are not salary).
  const components = new Map<string, { code: string; label: string; amount: number }>();
  for (const month of months) for (const line of month.earnings.filter((item) => item.taxable)) {
    const key = line.code === "BASIC" || line.code === "HRA" ? line.code : `${line.code}:${line.label}`;
    const current = components.get(key) || { code: line.code, label: line.label, amount: 0 };
    current.amount += line.amount; components.set(key, current);
  }
  const salaryLines = [...components.values()].map((line) => ({ ...line, amount: r0(line.amount) }));
  const nonTaxable = r0(sum(months, (m) => m.gross) - sum(months, (m) => m.taxable));
  if (opening && opening.taxable) salaryLines.push({ code: "OPENING_YTD", label: `Salary paid before switch-over (${opening.source}${opening.throughPeriod ? `, to ${opening.throughPeriod}` : ""})`, amount: r0(opening.taxable) });

  const taxable = r0(sum(months, (m) => m.taxable) + (opening?.taxable || 0));
  const basic = r0(sum(months, (m) => m.earnings.filter((e) => e.code === "BASIC").reduce((t, e) => t + e.amount, 0)) + (opening?.basic || 0));
  const hra = Math.min(taxable, r0(sum(months, (m) => m.earnings.filter((e) => e.code === "HRA" && e.taxable).reduce((t, e) => t + e.amount, 0)) + (opening?.hra || 0)));
  const pf = r0(sum(months, (m) => m.pf) + (opening?.pf || 0));
  const pt = r0(sum(months, (m) => m.pt) + (opening?.pt || 0));
  const employerPf = r0(sum(months, (m) => m.employerPf) + (opening?.employerPf || 0));
  const employerNps = r0(sum(months, (m) => m.employerNps));
  const tdsCurrent = r0(sum(months, (m) => m.tds) + (opening?.tds || 0));
  const prevSalary = r0(d.previousEmployerSalary || 0), prevTds = r0(d.previousEmployerTds || 0), prevPf = r0(d.previousEmployerPf || 0), prevPt = r0(d.previousEmployerPt || 0);
  const hraExempt = isOld ? hraExemption({ hraReceived: hra, rentPaid: d.rentPaidAnnual || 0, salary: basic, metro: d.rentedInMetro ?? input.metro }) : 0;

  const tax = calculateTax({
    fyStartYear: input.fyStart, ageCategory: input.ageCategory || d.ageCategory, parentsSenior: d.parentsSenior,
    basic: taxable - hra, hra, bonus: 0, specialAllowance: 0, taxableAllowances: 0,
    previousEmployerSalary: prevSalary, otherIncome: d.otherIncome || 0, professionalTax: pt + prevPt, hraExemption: hraExempt,
    homeLoanInterest: d.homeLoanInterest || 0, section80C: pf + prevPf + (d.section80C || 0), section80DSelf: d.section80D || 0,
    section80DParents: d.section80DParents || 0, nps80CCD1B: d.nps80CCD1B || 0, employerNps, npsSalary: basic, employerRetirementOther: employerPf,
  }, input.regime);

  const perquisites = employerNps + tax.retirementPerquisite;
  const grossSalary = taxable + perquisites;
  const ptDeduction = isOld ? Math.min(pt + prevPt, rules.oldCaps.professionalTax) : 0;
  const homeLoan = isOld ? Math.min(d.homeLoanInterest || 0, rules.oldCaps.homeLoanInterest) : 0;
  const totalSalaryAfterExemptions = grossSalary + prevSalary - hraExempt;
  const incomeFromSalary = totalSalaryAfterExemptions - tax.standardDeduction - ptDeduction;
  const otherIncome = r0(d.otherIncome || 0) - homeLoan;
  const grossTotalIncome = incomeFromSalary + otherIncome;
  const senior = (input.ageCategory || d.ageCategory || "BELOW_60") !== "BELOW_60";
  const chapter: { section: string; label: string; gross: number; deductible: number }[] = isOld ? [
    { section: "80C / s.123", label: "Provident fund, life insurance, ELSS, tuition fees etc. (incl. employee PF)", gross: pf + prevPf + (d.section80C || 0), deductible: Math.min(pf + prevPf + (d.section80C || 0), rules.oldCaps.section80C) },
    { section: "80CCD(1B)", label: "Own contribution to NPS", gross: d.nps80CCD1B || 0, deductible: Math.min(d.nps80CCD1B || 0, rules.oldCaps.nps80CCD1B) },
    { section: "80D / s.126", label: "Health insurance — self and family", gross: d.section80D || 0, deductible: Math.min(d.section80D || 0, senior ? rules.oldCaps.section80DSelfSenior : rules.oldCaps.section80DSelf) },
    { section: "80D / s.126", label: "Health insurance — parents", gross: d.section80DParents || 0, deductible: Math.min(d.section80DParents || 0, d.parentsSenior ? rules.oldCaps.section80DParentsSenior : rules.oldCaps.section80DParents) },
    { section: "80CCD(2) / s.124", label: "Employer contribution to NPS", gross: employerNps, deductible: tax.employerNpsDeduction },
  ] : [{ section: "80CCD(2) / s.124", label: "Employer contribution to NPS", gross: employerNps, deductible: tax.employerNpsDeduction }];
  const relief89 = r0(input.relief89 || 0);
  const taxPayable = Math.max(0, tax.annualLiability - relief89);
  const tdsTotal = tdsCurrent + prevTds;

  // Quarterly TDS (Part A summary / quarterly statement receipts).
  const quarters = (["Q1", "Q2", "Q3", "Q4"] as Quarter[]).map((quarter) => {
    const inQuarter = months.filter((m) => quarterOfPeriod(m.period) === quarter);
    const challans = input.challans.filter((c) => c.quarter === quarter);
    const receipt = input.receipts.find((r) => r.quarter === quarter);
    const openingTds = opening?.quarterTds?.[quarter] || 0;
    return {
      quarter, token: receipt?.token || null, statementStatus: receipt?.status || "NOT_FILED",
      amountPaid: r0(sum(inQuarter, (m) => m.taxable)), deducted: r0(sum(inQuarter, (m) => m.tds) + openingTds), deposited: r0(sum(challans, (c) => c.tds) + openingTds),
    };
  });
  const openingUnsplit = opening && opening.tds && !opening.quarterTds ? r0(opening.tds) : 0;

  const warnings: string[] = [];
  const lastPaid = months[months.length - 1]?.period || opening?.throughPeriod || null;
  const provisional = !input.exitDate && (!lastPaid || lastPaid < `${input.fyStart + 1}-03`);
  if (provisional) warnings.push(`Provisional: payroll for ${fyLabel(input.fyStart)} is complete only up to ${lastPaid || "—"}; the computation uses year-to-date income, so tax payable vs TDS is not final. Regenerate after the March payroll.`);
  else if (Math.abs(taxPayable - tdsTotal) > 10) warnings.push(tdsTotal < taxPayable
    ? `Shortfall: tax payable ₹${taxPayable} but TDS ₹${tdsTotal} (difference ₹${taxPayable - tdsTotal}) — recover in the final payroll or the employee pays self-assessment tax.`
    : `Excess deduction: TDS ₹${tdsTotal} is ₹${tdsTotal - taxPayable} more than tax payable ₹${taxPayable} — the employee claims the refund in the return.`);
  const depositedCurrent = r0(sum(input.challans, (c) => c.tds));
  const deductedHere = r0(sum(months, (m) => m.tds));
  if (Math.abs(depositedCurrent - deductedHere) > 0.5) warnings.push(`TDS deducted in payroll (₹${deductedHere}) ≠ TDS mapped to challans (₹${depositedCurrent}) — allocate challans for every month before issuing.`);
  if (!input.employee.hasPan) warnings.push("PAN not on file — the certificate will show PANNOTAVBL; TRACES will not issue Part A without a valid PAN.");
  if (tax.rulesAssumed) warnings.push(`Income-tax rules for ${fyLabel(input.fyStart)} are not configured; ${tax.rulesVersion} was used.`);
  if (opening) warnings.push(`Includes opening YTD from ${opening.source} (${opening.months} month(s)); its quarter-wise TDS ${opening.quarterTds ? "is" : "is not"} available.`);

  const firstPeriod = months[0]?.period, lastPeriod = months[months.length - 1]?.period;
  const fyFrom = `${input.fyStart}-04-01`, fyTo = `${input.fyStart + 1}-03-31`;
  const periodFrom = input.employee.joiningDate && input.employee.joiningDate > fyFrom ? input.employee.joiningDate : fyFrom;
  const periodTo = input.exitDate && input.exitDate < fyTo ? input.exitDate : fyTo;

  return {
    kind: "SALARY_TDS_CERTIFICATE", version: 1, provisional, fyStart: input.fyStart, fyLabel: fyLabel(input.fyStart), forms: names, regime: input.regime,
    rulesVersion: tax.rulesVersion, employee: input.employee, employer: input.employer,
    period: { from: periodFrom, to: periodTo, firstPayroll: firstPeriod || null, lastPayroll: lastPeriod || null, monthsInPayroll: months.length, openingMonths: opening?.months || 0 },
    partB: {
      salary17_1: taxable, salaryLines, perquisites17_2: perquisites, profitsInLieu17_3: 0, grossSalary, nonTaxableReimbursements: nonTaxable,
      previousEmployerSalary: prevSalary,
      exemptions10: [{ section: "10(13A)", label: "House rent allowance", amount: hraExempt }], totalExemptions: hraExempt,
      totalSalary: totalSalaryAfterExemptions, standardDeduction: tax.standardDeduction, entertainmentAllowance: 0, professionalTax: ptDeduction,
      incomeFromSalary, otherIncome: r0(d.otherIncome || 0), housePropertyLoss: homeLoan ? -homeLoan : 0, grossTotalIncome,
      chapterVIA: chapter, totalDeductions: tax.deductions, totalIncome: tax.taxableIncome,
      taxOnTotalIncome: tax.taxBeforeRebate, rebate87A: tax.rebate + tax.marginalRelief, surcharge: tax.surcharge, cess: tax.cess,
      taxPayable: tax.annualLiability, relief89, netTaxPayable: taxPayable,
      tdsCurrentEmployer: tdsCurrent, tdsPreviousEmployer: prevTds, tdsTotal, balance: taxPayable - tdsTotal,
      bands: tax.bands,
    },
    perquisites: {
      employerNps, retirementPerquisite: tax.retirementPerquisite, employerPf, total: perquisites,
      items: PERQUISITE_ITEMS.map((label, index) => {
        const value = index === 16 ? tax.retirementPerquisite + employerNps : 0;
        return { sr: index + 1, label, value, recovered: 0, chargeable: value };
      }),
      profitsInLieu: 0, taxDeductedFromSalary: tdsCurrent, taxPaidByEmployer: 0,
    },
    quarters, openingUnsplitTds: openingUnsplit, challans: input.challans, warnings,
  };
}
export type Form16Data = ReturnType<typeof computeForm16>;

/** Form 12BA rows (rule 26A of the 1962 Rules). Payroll records only the employer retirement contributions (row 17). */
export const PERQUISITE_ITEMS = [
  "Accommodation", "Cars / other automotive", "Sweeper, gardener, watchman or personal attendant", "Gas, electricity, water",
  "Interest-free or concessional loans", "Holiday expenses", "Free or concessional travel", "Free meals", "Free education", "Gifts, vouchers etc.",
  "Credit card expenses", "Club expenses", "Use of movable assets by employees", "Transfer of assets to employees", "Value of any other benefit / amenity / service / privilege",
  "Stock options allotted or transferred by employer", "Contribution by employer to fund and scheme taxable u/s 17(2)(vii) (PF + NPS + superannuation above ₹7.5 lakh, incl. employer NPS)",
  "Annual accretion by way of interest, dividend etc. to the balance at the credit of fund and scheme referred to in 17(2)(vii)", "Other benefits or amenities",
];

/** Q4 Annexure II (salary details) row — the CSV template until Protean publishes the Form 138 Q4 layout. */
export function annexureIIRow(data: Form16Data, pan: string) {
  const b = data.partB;
  return [data.employee.number, pan, data.employee.name, "Employee (other than Govt.)", data.period.from, data.period.to, data.regime === "NEW" ? "N (new regime, s.202)" : "Y (opted out of s.202)",
    b.salary17_1, b.perquisites17_2, b.profitsInLieu17_3, b.grossSalary, b.previousEmployerSalary, b.totalExemptions, b.standardDeduction, b.professionalTax,
    b.incomeFromSalary, b.otherIncome, b.housePropertyLoss, b.grossTotalIncome,
    ...["80C / s.123", "80CCD(1B)", "80CCD(2) / s.124"].map((s) => b.chapterVIA.filter((c) => c.section === s).reduce((t, c) => t + c.deductible, 0)),
    b.chapterVIA.filter((c) => c.section === "80D / s.126").reduce((t, c) => t + c.deductible, 0),
    b.totalDeductions, b.totalIncome, b.taxOnTotalIncome, b.rebate87A, b.surcharge, b.cess, b.relief89, b.netTaxPayable,
    b.tdsCurrentEmployer, b.tdsPreviousEmployer, b.tdsTotal, b.balance];
}
export const ANNEXURE_II_HEADER = ["Employee ID", "PAN", "Name", "Category", "Employed from", "Employed to", "Opted out of new regime",
  "Salary 17(1)", "Perquisites 17(2)", "Profits in lieu 17(3)", "Gross salary (this employer)", "Salary from previous employer(s)", "Exemptions u/s 10", "Standard deduction", "Professional tax",
  "Income chargeable under Salaries", "Other income reported", "House property (loss)", "Gross total income",
  "80C / s.123 deductible", "80CCD(1B) deductible", "80CCD(2) / s.124 deductible", "80D / s.126 deductible", "Total Chapter VI-A / VIII deductions", "Total taxable income",
  "Tax on total income", "Rebate 87A / s.156 (incl. marginal relief)", "Surcharge", "Health & education cess", "Relief u/s 89", "Net tax payable",
  "TDS — this employer", "TDS — previous employer(s)", "Total TDS", "Shortfall (+) / excess (-)"];

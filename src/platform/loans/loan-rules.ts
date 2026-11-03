// Pure loan/advance rules: limits, EMI schedule and the perquisite flag. No database access, so they are unit-tested.

export const PURPOSES = ["Medical", "Education", "Housing", "Vehicle", "Wedding", "Family emergency", "Relocation", "Other"] as const;

/** Policy defaults: an advance is at most one month's fixed gross recovered within 3 months; a loan up to 6× over 24 months. */
export const POLICY = {
  ADVANCE: { maxGrossMultiple: 1, maxTenure: 3 },
  LOAN: { maxGrossMultiple: 6, maxTenure: 24 },
  /** Interest-free / concessional loans above this aggregate are a taxable perquisite (Rule 3(7)(i)); medical loans are exempt. */
  perquisiteThreshold: 200000,
} as const;

export const addMonths = (period: string, months: number) => {
  const [year, month] = period.split("-").map(Number);
  const index = year * 12 + (month - 1) + months;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
};

/** Equal monthly installments in whole rupees; the last one absorbs the rounding so the schedule sums to the principal. */
export function schedule(principal: number, tenure: number, firstPeriod: string) {
  const emi = Math.ceil(principal / tenure);
  const rows: { seq: number; period: string; amount: number }[] = [];
  let left = principal;
  for (let seq = 1; seq <= tenure && left > 0; seq++) {
    const amount = Math.min(emi, Math.round(left * 100) / 100);
    rows.push({ seq, period: addMonths(firstPeriod, seq - 1), amount });
    left = Math.round((left - amount) * 100) / 100;
  }
  return { emi, rows };
}

/** Errors for a request against the policy and the employee's current fixed monthly gross (null = no salary structure). */
export function validateRequest(kind: "LOAN" | "ADVANCE", principal: number, tenure: number, monthlyGross: number | null, outstanding: number) {
  const errors: string[] = [], warnings: string[] = [];
  const policy = POLICY[kind];
  if (tenure > policy.maxTenure) errors.push(`${kind === "ADVANCE" ? "A salary advance" : "A loan"} can be recovered over at most ${policy.maxTenure} months.`);
  if (monthlyGross === null) warnings.push("No salary structure on file — HR will check eligibility manually.");
  else {
    const cap = Math.floor(monthlyGross * policy.maxGrossMultiple);
    if (principal > cap) errors.push(`The most you can request is ₹${cap.toLocaleString("en-IN")} (${policy.maxGrossMultiple}× your monthly gross).`);
    const emi = Math.ceil(principal / tenure);
    if (emi > monthlyGross * 0.5) warnings.push("The monthly recovery is more than half of your gross pay — consider a longer tenure.");
  }
  if (outstanding > 0) warnings.push(`You already have ₹${outstanding.toLocaleString("en-IN")} outstanding on another loan or advance.`);
  return { errors, warnings };
}

/** Perquisite warning for interest-free loans (the payroll engine does not compute the perquisite value yet). */
export function perquisiteFlag(purpose: string, aggregatePrincipal: number) {
  if (purpose === "Medical" || aggregatePrincipal <= POLICY.perquisiteThreshold) return null;
  return `Interest-free loans above ₹2,00,000 in aggregate are a taxable perquisite (Rule 3(7)(i), SBI rate). Add the perquisite value to payroll manually until it is automated.`;
}

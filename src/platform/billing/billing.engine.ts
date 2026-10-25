/**
 * Billing calculations. Pure functions (no database), unit-tested in billing.engine.test.ts.
 * All money is integer paise. Dates are ISO "YYYY-MM-DD" strings in India time (IST); no time-of-day maths.
 */

// ---- GST state codes (first two digits of a GSTIN; also used as "place of supply") -------------------------------------
export const GST_STATES: Record<string, { code: string; name: string }> = {
  JK: { code: "01", name: "Jammu and Kashmir" }, HP: { code: "02", name: "Himachal Pradesh" }, PB: { code: "03", name: "Punjab" },
  CH: { code: "04", name: "Chandigarh" }, UK: { code: "05", name: "Uttarakhand" }, HR: { code: "06", name: "Haryana" }, DL: { code: "07", name: "Delhi" },
  RJ: { code: "08", name: "Rajasthan" }, UP: { code: "09", name: "Uttar Pradesh" }, BR: { code: "10", name: "Bihar" }, SK: { code: "11", name: "Sikkim" },
  AR: { code: "12", name: "Arunachal Pradesh" }, NL: { code: "13", name: "Nagaland" }, MN: { code: "14", name: "Manipur" }, MZ: { code: "15", name: "Mizoram" },
  TR: { code: "16", name: "Tripura" }, ML: { code: "17", name: "Meghalaya" }, AS: { code: "18", name: "Assam" }, WB: { code: "19", name: "West Bengal" },
  JH: { code: "20", name: "Jharkhand" }, OD: { code: "21", name: "Odisha" }, CG: { code: "22", name: "Chhattisgarh" }, MP: { code: "23", name: "Madhya Pradesh" },
  GJ: { code: "24", name: "Gujarat" }, DN: { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu" }, MH: { code: "27", name: "Maharashtra" },
  KA: { code: "29", name: "Karnataka" }, GA: { code: "30", name: "Goa" }, LD: { code: "31", name: "Lakshadweep" }, KL: { code: "32", name: "Kerala" },
  TN: { code: "33", name: "Tamil Nadu" }, PY: { code: "34", name: "Puducherry" }, AN: { code: "35", name: "Andaman and Nicobar Islands" },
  TS: { code: "36", name: "Telangana" }, AP: { code: "37", name: "Andhra Pradesh" }, LA: { code: "38", name: "Ladakh" },
};
export const stateLabel = (state: string) => (GST_STATES[state] ? `${GST_STATES[state].name} (${GST_STATES[state].code})` : state);

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Mod-36 check character of a 15-character GSTIN (computed over the first 14). */
export function gstinCheckChar(first14: string) {
  let sum = 0;
  for (let index = 0; index < 14; index++) {
    const value = GSTIN_CHARS.indexOf(first14[index]);
    if (value < 0) return "";
    const product = value * (index % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}
/** Returns an error message, or null when the GSTIN is well-formed, has a valid check digit and belongs to `state`. */
export function gstinProblem(gstin: string, state?: string): string | null {
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) return "GSTIN must be 15 characters: state code, PAN, entity number, Z, check digit.";
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) return "GSTIN check digit is wrong — please re-check the number.";
  if (state && GST_STATES[state] && GST_STATES[state].code !== gstin.slice(0, 2)) return `GSTIN state code ${gstin.slice(0, 2)} does not match ${GST_STATES[state].name} (${GST_STATES[state].code}).`;
  return null;
}

// ---- dates -------------------------------------------------------------------------------------------------------------
const toUtc = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
export const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso: string, days: number) => isoOf(toUtc(iso) + days * 86_400_000);
export const daysBetween = (from: string, to: string) => Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
export const daysInclusive = (from: string, to: string) => daysBetween(from, to) + 1;
export const maxIso = (a: string, b: string) => (a > b ? a : b);
export const minIso = (a: string, b: string) => (a < b ? a : b);
export function monthRange(period: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("Period must look like 2026-09.");
  const start = `${period}-01`;
  const next = Number(period.slice(5, 7)) === 12 ? `${Number(period.slice(0, 4)) + 1}-01-01` : `${period.slice(0, 4)}-${String(Number(period.slice(5, 7)) + 1).padStart(2, "0")}-01`;
  return { start, end: addDays(next, -1), days: daysBetween(start, next) };
}
export function addYears(iso: string, years: number) {
  const year = Number(iso.slice(0, 4)) + years;
  const md = iso.slice(5);
  return md === "02-29" && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? `${year}-02-28` : `${year}-${md}`;
}
/** Today in India (the job runs on IST calendar days). */
export const todayIst = (now = new Date()) => new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);

// ---- numbering (CGST Rules, rule 46(b): consecutive serial, max 16 chars, letters/digits/"-"/"/", unique per FY) ----------
/** Indian financial year (April–March) of a date, e.g. 2027-03-31 → "2026-27", 2027-04-01 → "2027-28". */
export function fiscalYear(iso: string) {
  const year = Number(iso.slice(0, 4));
  const start = Number(iso.slice(5, 7)) >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}
export function formatDocumentNumber(prefix: string, fy: string, sequence: number) {
  const number = `${prefix}/${fy}/${String(sequence).padStart(4, "0")}`;
  if (number.length > 16) throw new Error(`Document number ${number} exceeds the 16-character GST limit.`);
  if (!/^[A-Za-z0-9/-]+$/.test(number)) throw new Error(`Document number ${number} has characters GST does not allow.`);
  return number;
}

// ---- GST -------------------------------------------------------------------------------------------------------------
export type TaxSplit = { supplyType: "INTRA" | "INTER"; cgst: number; sgst: number; igst: number; total: number };
/**
 * B2B services: place of supply = the recipient's location (IGST Act s.12(2)). Same state as the supplier → CGST + SGST
 * (half the rate each); otherwise IGST at the full rate. Each tax is rounded to the paisa.
 */
export function gstSplit(taxablePaise: number, ratePct: number, supplierState: string, placeOfSupply: string): TaxSplit {
  if (supplierState === placeOfSupply) {
    const half = Math.round((taxablePaise * ratePct) / 200);
    return { supplyType: "INTRA", cgst: half, sgst: half, igst: 0, total: taxablePaise + 2 * half };
  }
  const igst = Math.round((taxablePaise * ratePct) / 100);
  return { supplyType: "INTER", cgst: 0, sgst: 0, igst, total: taxablePaise + igst };
}

// ---- usage -------------------------------------------------------------------------------------------------------------
export type UsageBasis = "PEAK" | "AVERAGE";
/**
 * Billable count of one brand for [from, to] from daily snapshots (date → count). PEAK = highest daily count;
 * AVERAGE = mean of the days that have a snapshot, rounded up. No snapshot in the range → `fallback` (marked estimated).
 */
export function billableCount(daily: Record<string, number>, from: string, to: string, basis: UsageBasis, fallback: number) {
  const values = Object.entries(daily).filter(([day]) => day >= from && day <= to).map(([, count]) => count);
  if (!values.length) return { count: fallback, days: 0, estimated: true };
  const count = basis === "PEAK" ? Math.max(...values) : Math.ceil(values.reduce((sum, value) => sum + value, 0) / values.length);
  return { count, days: values.length, estimated: false };
}

// ---- invoice composition -------------------------------------------------------------------------------------------
export type SubscriptionTerms = {
  id: string; planName: string; pepmPaise: number; minimumPaise: number; setupFeePaise: number; discountPct: number;
  cycle: "MONTHLY" | "ANNUAL"; annualDiscountPct: number; usageBasis: UsageBasis; trialDays: number;
  contractStart: string; contractEnd: string | null; committedSeats: number | null;
};
export type Brand = { organizationId: string; name: string };
export type Adjustment = { id: string; kind: "CREDIT" | "CHARGE"; description: string; amountPaise: number };
export type Line = {
  kind: "SUBSCRIPTION" | "MINIMUM_TOPUP" | "ANNUAL" | "OVERAGE" | "SETUP" | "TRIAL" | "CREDIT" | "CHARGE";
  description: string; organizationId?: string; quantity?: number; unitPricePaise?: number; amountPaise: number; meta?: Record<string, unknown>;
};
export type InvoiceInput = {
  period: string; brands: Brand[]; subscriptions: SubscriptionTerms[];
  usage: Record<string, Record<string, number>>; liveCounts: Record<string, number>;
  setupFeeAlreadyBilled: boolean; annualAlreadyBilled?: string[]; adjustments: Adjustment[];
};
export type InvoiceDraft = { lines: Line[]; subtotalPaise: number; appliedAdjustments: { id: string; amountPaise: number }[]; warnings: string[]; usage: Record<string, unknown> };

const rupees = (paise: number) => `Rs. ${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(iso.slice(5, 7)) - 1]}`;
/** Effective per-employee price after the custom discount (and the annual-cycle discount for ANNUAL contracts). */
export const effectivePepm = (terms: SubscriptionTerms) =>
  Math.round(terms.pepmPaise * (1 - terms.discountPct / 100) * (terms.cycle === "ANNUAL" ? 1 - terms.annualDiscountPct / 100 : 1));

/**
 * Builds the lines for one account and one calendar month.
 *
 * MONTHLY subscriptions (per subscription segment active in the month, after any free trial):
 *   per brand  : billable count × effective PEPM × (billed days / days in month)
 *   minimum    : if the brand lines total less than minimum × (billed days / days in month), a top-up line makes up the
 *                difference — i.e. subscription = max(PEPM × billable, minimum), prorated for partial months.
 * ANNUAL subscriptions: the first invoice of each contract year (counted from the end of the trial) carries
 *   max(committed seats × PEPM × 12 × (1 − annual discount), minimum × 12); every month bills overage
 *   (billable above committed seats) at the discounted PEPM, prorated the same way.
 * Setup fee: once per account, on the first invoice. Credits/charges queued for the account follow; credits never take
 * the taxable value below zero (the unused part stays queued).
 */
export function composeInvoice(input: InvoiceInput): InvoiceDraft {
  const { start: periodStart, end: periodEnd, days: monthDays } = monthRange(input.period);
  const lines: Line[] = [];
  const warnings: string[] = [];
  const usage: Record<string, unknown> = {};
  let setupBilled = input.setupFeeAlreadyBilled;
  const annualBilled = new Set(input.annualAlreadyBilled || []);

  for (const terms of [...input.subscriptions].sort((a, b) => a.contractStart.localeCompare(b.contractStart))) {
    const segStart = maxIso(periodStart, terms.contractStart);
    const segEnd = minIso(periodEnd, terms.contractEnd || periodEnd);
    if (segStart > segEnd) continue;
    const trialEnd = terms.trialDays > 0 ? addDays(terms.contractStart, terms.trialDays - 1) : addDays(terms.contractStart, -1);
    const billedStart = maxIso(segStart, addDays(trialEnd, 1));
    if (trialEnd >= segStart) {
      const to = minIso(trialEnd, segEnd);
      lines.push({ kind: "TRIAL", amountPaise: 0, description: `${terms.planName} — free trial ${shortDate(segStart)}–${shortDate(to)} (${daysInclusive(segStart, to)} days, no charge)`,
        meta: { subscriptionId: terms.id, from: segStart, to } });
    }
    if (billedStart > segEnd) continue;
    const billedDays = daysInclusive(billedStart, segEnd);
    const fraction = billedDays / monthDays;
    const prorated = billedDays < monthDays;
    const pepm = effectivePepm(terms);
    const range = `${shortDate(billedStart)}–${shortDate(segEnd)}`;
    const prorationNote = prorated ? ` · prorated ${billedDays}/${monthDays} days` : "";
    const counts = input.brands.map((brand) => {
      const result = billableCount(input.usage[brand.organizationId] || {}, billedStart, segEnd, terms.usageBasis, input.liveCounts[brand.organizationId] || 0);
      if (result.estimated) warnings.push(`${brand.name}: no usage snapshots for ${range}; used today's live count (${result.count}).`);
      usage[brand.organizationId] = { name: brand.name, ...result, basis: terms.usageBasis, from: billedStart, to: segEnd };
      return { brand, ...result };
    });

    if (terms.cycle === "MONTHLY") {
      let usageTotal = 0;
      for (const item of counts) {
        const amount = Math.round(pepm * item.count * fraction);
        usageTotal += amount;
        lines.push({ kind: "SUBSCRIPTION", organizationId: item.brand.organizationId, quantity: item.count, unitPricePaise: pepm, amountPaise: amount,
          description: `${terms.planName} — ${item.brand.name}: ${item.count} employees × ${rupees(pepm)} PEPM (${terms.usageBasis === "PEAK" ? "peak" : "average"} ${range})${prorationNote}`,
          meta: { subscriptionId: terms.id, from: billedStart, to: segEnd, billedDays, monthDays, basis: terms.usageBasis, estimated: item.estimated } });
      }
      const minimum = Math.round(terms.minimumPaise * fraction);
      if (minimum > usageTotal)
        lines.push({ kind: "MINIMUM_TOPUP", amountPaise: minimum - usageTotal,
          description: `Minimum monthly fee top-up (${rupees(terms.minimumPaise)} minimum${prorated ? `, prorated to ${rupees(minimum)}` : ""}; usage ${rupees(usageTotal)})`,
          meta: { subscriptionId: terms.id, minimumPaise: terms.minimumPaise, proratedMinimumPaise: minimum, usagePaise: usageTotal } });
    } else {
      const committed = terms.committedSeats || 0;
      const yearBase = addDays(trialEnd, 1);
      for (let year = 0; year < 100; year++) {
        const anniversary = addYears(yearBase, year);
        if (anniversary > segEnd) break;
        if (anniversary < billedStart || annualBilled.has(`${terms.id}:${anniversary}`)) continue;
        const annual = Math.max(committed * pepm * 12, terms.minimumPaise * 12);
        lines.push({ kind: "ANNUAL", quantity: committed, unitPricePaise: pepm * 12, amountPaise: annual,
          description: `${terms.planName} — annual subscription from ${anniversary}: ${committed} committed seats × ${rupees(pepm)} PEPM × 12` +
            `${terms.annualDiscountPct ? ` (incl. ${terms.annualDiscountPct}% annual discount)` : ""}${annual > committed * pepm * 12 ? ` · annual minimum ${rupees(terms.minimumPaise * 12)} applies` : ""}`,
          meta: { subscriptionId: terms.id, contractYearStart: anniversary } });
      }
      const total = counts.reduce((sum, item) => sum + item.count, 0);
      if (total > committed) {
        const extra = total - committed;
        lines.push({ kind: "OVERAGE", quantity: extra, unitPricePaise: pepm, amountPaise: Math.round(pepm * extra * fraction),
          description: `${terms.planName} — ${extra} employees above ${committed} committed seats × ${rupees(pepm)} PEPM (${range})${prorationNote}`,
          meta: { subscriptionId: terms.id, billable: total, committed, billedDays, monthDays } });
      }
    }
    if (!setupBilled && terms.setupFeePaise > 0) {
      lines.push({ kind: "SETUP", quantity: 1, unitPricePaise: terms.setupFeePaise, amountPaise: terms.setupFeePaise,
        description: `One-time setup and onboarding fee (${terms.planName})`, meta: { subscriptionId: terms.id } });
      setupBilled = true;
    }
  }

  const applied: { id: string; amountPaise: number }[] = [];
  for (const adjustment of input.adjustments.filter((item) => item.kind === "CHARGE")) {
    lines.push({ kind: "CHARGE", amountPaise: adjustment.amountPaise, description: adjustment.description, meta: { adjustmentId: adjustment.id } });
    applied.push({ id: adjustment.id, amountPaise: adjustment.amountPaise });
  }
  for (const adjustment of input.adjustments.filter((item) => item.kind === "CREDIT")) {
    const room = lines.reduce((sum, line) => sum + line.amountPaise, 0);
    const amount = Math.min(adjustment.amountPaise, room);
    if (amount <= 0) { warnings.push(`Credit "${adjustment.description}" carried forward: nothing left to discount on this invoice.`); continue; }
    lines.push({ kind: "CREDIT", amountPaise: -amount, description: `${adjustment.description}${amount < adjustment.amountPaise ? ` (partial — ${rupees(adjustment.amountPaise - amount)} carried forward)` : ""}`,
      meta: { adjustmentId: adjustment.id } });
    applied.push({ id: adjustment.id, amountPaise: amount });
  }
  const subtotalPaise = lines.reduce((sum, line) => sum + line.amountPaise, 0);
  return { lines, subtotalPaise, appliedAdjustments: applied, warnings, usage };
}

// ---- receivables -----------------------------------------------------------------------------------------------------
export type PaymentState = "UNPAID" | "PARTIALLY_PAID" | "PAID" | "CREDITED";
export function paymentState(totalPaise: number, paidPaise: number, creditedPaise: number): { state: PaymentState; outstandingPaise: number } {
  const outstandingPaise = Math.max(0, totalPaise - paidPaise - creditedPaise);
  if (outstandingPaise === 0) return { state: paidPaise === 0 && creditedPaise > 0 ? "CREDITED" : "PAID", outstandingPaise };
  return { state: paidPaise > 0 || creditedPaise > 0 ? "PARTIALLY_PAID" : "UNPAID", outstandingPaise };
}
export function agingBucket(dueDate: string, today: string) {
  const late = daysBetween(dueDate, today);
  if (late <= 0) return "current";
  if (late <= 30) return "d1_30";
  if (late <= 60) return "d31_60";
  if (late <= 90) return "d61_90";
  return "d90_plus";
}
/** Which reminder (if any) is due today for an invoice with this due date. */
export function reminderFor(dueDate: string, today: string): "DUE_IN_3" | "DUE_TODAY" | "OVERDUE_7" | null {
  const diff = daysBetween(today, dueDate);
  if (diff === 3) return "DUE_IN_3";
  if (diff === 0) return "DUE_TODAY";
  if (diff === -7) return "OVERDUE_7";
  return null;
}

// ---- words -----------------------------------------------------------------------------------------------------------
export function rupeesInWords(paise: number) {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (n: number) => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ""}`);
  const three = (n: number) => (n < 100 ? two(n) : `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${two(n % 100)}` : ""}`);
  const words = (value: number) => {
    if (!value) return "Zero";
    const parts: string[] = [];
    let rest = value;
    if (rest >= 10_000_000) { parts.push(`${words(Math.floor(rest / 10_000_000))} Crore`); rest %= 10_000_000; }
    if (rest >= 100_000) { parts.push(`${two(Math.floor(rest / 100_000))} Lakh`); rest %= 100_000; }
    if (rest >= 1000) { parts.push(`${two(Math.floor(rest / 1000))} Thousand`); rest %= 1000; }
    if (rest) parts.push(three(rest));
    return parts.join(" ");
  };
  const whole = Math.floor(Math.abs(paise) / 100);
  const fraction = Math.abs(paise) % 100;
  return `Indian Rupees ${words(whole)}${fraction ? ` and ${two(fraction)} Paise` : ""} Only`;
}
export const formatInr = (paise: number) =>
  `${paise < 0 ? "-" : ""}${(Math.abs(paise) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

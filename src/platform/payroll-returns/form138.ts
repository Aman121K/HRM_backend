/**
 * Quarterly salary TDS statement (pure): challan allocation, validation and the RPU/FVU text file.
 *
 * Text layout: Protean "File Format for Salary TDS File - Form Number 138 (24Q) - Q1 to Q3" for Tax Year 2026-27
 * onwards (downloaded 20 Oct 2026 from tinpan.proteantech.in, file "Form Number 138-24Q - Q1 to Q3_22072026.xlsx",
 * sheet title Version 1.1, listed as 1.2): ^-delimited, CRLF, records FH (18 fields) / BH (72) / CD (30) / DD (45).
 * The Q4 layout (Annexure II salary details) was "expected to be released soon" — no Q4 text file is produced; Q4
 * data is exported as CSV templates. Every generated file must still pass Protean's FVU 1.2 together with the .csi
 * challan file downloaded from the TIN site before it is uploaded.
 */
import { toCsv } from "../payroll/csv";
import { NO_PAN_RATE, PAN_PATTERN, TAN_PATTERN, ddmmyyyy, fyLabel, quarterRange, statementPan, type Quarter } from "./tds-math";

export type Address = { line1?: string; line2?: string; line3?: string; line4?: string; line5?: string; stateCode?: string; pincode?: string; country?: string };
export type Deductor = {
  tan: string | null; pan: string | null; name: string | null; category: string; gstin: string | null; address: Address; email: string | null; phone: string | null;
  responsible: { name?: string; designation?: string; email?: string; phone?: string; address?: Address; pan?: string | null };
};
export type ChallanIn = {
  id: string; period: string; bsrCode: string; challanSerial: string; depositDate: string; mode: "C" | "B"; minorHead: string;
  tax: number; surcharge: number; cess: number; interest: number; fee: number; penalty: number;
};
/** TDS deducted from one employee in one published/locked run (the source for allocation). */
export type DeductionIn = { employeeId: string; runId: string | null; period: string; paymentDate: string; amountPaid: number; tds: number };
export type AllocationOut = { challanId: string; employeeId: string; runId: string | null; period: string; paymentDate: string; amountPaid: number; tds: number };
export type DeducteeIn = AllocationOut & { employeeNumber: string; name: string; pan: string | null };

export const taxPart = (c: Pick<ChallanIn, "tax" | "surcharge" | "cess">) => round2(c.tax + c.surcharge + c.cess);
export const challanTotal = (c: ChallanIn) => round2(taxPart(c) + c.interest + c.fee + c.penalty);
const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const whole = (n: number) => `${Math.round(n)}.00`;

/**
 * Maps each month's deducted TDS onto that month's challans (earliest deposit first). An employee's deduction is split
 * across challans only when one challan cannot hold it. Returns the allocations plus what stayed unallocated per period.
 */
export function allocate(challans: ChallanIn[], deductions: DeductionIn[]) {
  const allocations: AllocationOut[] = [];
  const unallocated: DeductionIn[] = [];
  const byPeriod = new Map<string, ChallanIn[]>();
  for (const challan of [...challans].sort((a, b) => a.depositDate.localeCompare(b.depositDate) || a.challanSerial.localeCompare(b.challanSerial)))
    byPeriod.set(challan.period, [...(byPeriod.get(challan.period) || []), challan]);
  const capacity = new Map(challans.map((c) => [c.id, taxPart(c)]));
  for (const deduction of [...deductions].sort((a, b) => a.period.localeCompare(b.period) || b.tds - a.tds || a.employeeId.localeCompare(b.employeeId))) {
    if (deduction.tds <= 0) continue;
    let remaining = round2(deduction.tds);
    for (const challan of byPeriod.get(deduction.period) || []) {
      const room = capacity.get(challan.id) || 0;
      if (room <= 0 || remaining <= 0) continue;
      const part = Math.min(room, remaining);
      allocations.push({ challanId: challan.id, employeeId: deduction.employeeId, runId: deduction.runId, period: deduction.period, paymentDate: deduction.paymentDate,
        amountPaid: round2(deduction.amountPaid * (part / deduction.tds)), tds: round2(part) });
      capacity.set(challan.id, round2(room - part)); remaining = round2(remaining - part);
    }
    if (remaining > 0) unallocated.push({ ...deduction, amountPaid: round2(deduction.amountPaid * (remaining / deduction.tds)), tds: remaining });
  }
  return { allocations, unallocated, unusedByChallan: Object.fromEntries([...capacity.entries()]) };
}

export type Issue = { level: "error" | "warning"; code: string; message: string; ref?: string };

export function validateDeductor(d: Deductor): Issue[] {
  const issues: Issue[] = [];
  const need = (ok: unknown, code: string, message: string) => { if (!ok) issues.push({ level: "error", code, message }); };
  need(d.tan && TAN_PATTERN.test(d.tan), "TAN", "Deductor TAN is missing or not in the AAAA99999A format.");
  need(d.pan && (PAN_PATTERN.test(d.pan) || d.pan === "PANNOTREQD"), "DEDUCTOR_PAN", "Deductor PAN is missing or invalid.");
  need(d.name && /[A-Za-z0-9]/.test(d.name), "DEDUCTOR_NAME", "Deductor name is required.");
  need(d.address?.line1, "ADDRESS", "Deductor address line 1 (flat / door / block) is required.");
  need(/^[0-9]{2}$/.test(d.address?.stateCode || ""), "STATE", "Deductor state code (2 digits, Protean Annexure 1) is required.");
  need(/^[1-9][0-9]{5}$/.test(d.address?.pincode || ""), "PINCODE", "Deductor PIN code must be 6 digits.");
  need(/^[^@\s^]+@[^@\s^]+\.[^@\s^]+$/.test(d.email || d.responsible?.email || ""), "EMAIL", "A valid deductor or responsible-person e-mail is required.");
  need(/^[0-9]{6,10}$/.test(d.phone || ""), "PHONE", "Deductor contact number (up to 10 digits) is required.");
  need(d.responsible?.name, "RESPONSIBLE_NAME", "Name of the person responsible for deduction is required.");
  need(d.responsible?.designation, "RESPONSIBLE_DESIGNATION", "Designation of the person responsible is required.");
  need(d.responsible?.address?.line1 && /^[0-9]{2}$/.test(d.responsible.address.stateCode || "") && /^[1-9][0-9]{5}$/.test(d.responsible.address.pincode || ""),
    "RESPONSIBLE_ADDRESS", "Responsible person's address line 1, state code and PIN are required.");
  need(/^[0-9]{6,10}$/.test(d.responsible?.phone || ""), "RESPONSIBLE_PHONE", "Responsible person's contact number is required.");
  need(d.responsible?.pan && PAN_PATTERN.test(d.responsible.pan), "RESPONSIBLE_PAN", "PAN of the person responsible for deduction is required (Form 138 BH field 59).");
  if (d.gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(d.gstin)) issues.push({ level: "warning", code: "GSTIN", message: "GSTIN does not look valid; it is optional and will be left out." });
  return issues;
}

/** Validates one quarter: challans vs allocations vs deductions (deducted ≠ deposited), PAN handling, dates. */
export function validateQuarter(input: { fyStart: number; quarter: Quarter; challans: ChallanIn[]; deductees: DeducteeIn[]; deductedTotal: number; unallocated: DeductionIn[] }) {
  const issues: Issue[] = [];
  const range = quarterRange(input.fyStart, input.quarter);
  if (!input.deductees.length) issues.push({ level: "error", code: "NO_DEDUCTEES", message: "No deductee rows: a regular statement needs at least one deductee (allocate challans first)." });
  const earliest = `${input.fyStart - 1}-04-01`;
  for (const c of input.challans) {
    const allocated = round2(input.deductees.filter((d) => d.challanId === c.id).reduce((t, d) => t + d.tds, 0));
    const ref = `${c.bsrCode}/${c.challanSerial} ${c.depositDate}`;
    if (allocated > taxPart(c) + 0.005) issues.push({ level: "error", code: "OVER_ALLOCATED", ref, message: `Challan ${ref}: ₹${allocated} allocated but only ₹${taxPart(c)} tax deposited.` });
    else if (allocated < taxPart(c) - 0.005) issues.push({ level: "warning", code: "CHALLAN_UNUSED", ref, message: `Challan ${ref}: ₹${round2(taxPart(c) - allocated)} of the deposited tax is not mapped to any employee (excess deposit or deductions missing).` });
    if (c.depositDate < earliest) issues.push({ level: "error", code: "CHALLAN_DATE", ref, message: `Challan ${ref}: deposit date is before 1 April of the previous year.` });
    if (!/^[0-9]{7}$/.test(c.bsrCode)) issues.push({ level: "error", code: "BSR", ref, message: `Challan ${ref}: BSR code must be 7 digits.` });
  }
  const unallocatedTotal = round2(input.unallocated.reduce((t, d) => t + d.tds, 0));
  if (unallocatedTotal > 0)
    issues.push({ level: "error", code: "NOT_DEPOSITED", message: `₹${unallocatedTotal} TDS deducted from ${new Set(input.unallocated.map((d) => d.employeeId)).size} employee(s) is not covered by any challan (${[...new Set(input.unallocated.map((d) => d.period))].join(", ")}). Record the challan(s) and allocate again.` });
  const deductedInRows = round2(input.deductees.reduce((t, d) => t + d.tds, 0));
  if (Math.abs(round2(deductedInRows + unallocatedTotal) - round2(input.deductedTotal)) > 0.01)
    issues.push({ level: "error", code: "TOTAL_MISMATCH", message: `Deductee rows (₹${deductedInRows}) + unallocated (₹${unallocatedTotal}) ≠ TDS deducted in payroll (₹${round2(input.deductedTotal)}) — re-run allocation after the latest payroll changes.` });
  const seenNoPan = new Set<string>();
  for (const d of input.deductees) {
    const ref = `${d.employeeNumber} ${d.period}`;
    if (d.paymentDate < range.from || d.paymentDate > range.to) issues.push({ level: "error", code: "PAYMENT_DATE", ref, message: `${ref}: payment date ${d.paymentDate} is outside ${input.quarter}.` });
    if (d.amountPaid <= 0) issues.push({ level: "error", code: "AMOUNT_PAID", ref, message: `${ref}: amount paid must be greater than zero.` });
    const pan = statementPan(d.pan);
    if (!pan.valid) {
      if (d.tds + 0.5 < d.amountPaid * NO_PAN_RATE) issues.push({ level: "error", code: "NO_PAN_RATE", ref, message: `${ref}: ${pan.reason} — TDS must be at least 20% of the amount paid for remark "C" (₹${d.tds} on ₹${d.amountPaid}).` });
      else if (!seenNoPan.has(d.employeeId)) {
        issues.push({ level: "warning", code: "NO_PAN", ref, message: `${d.employeeNumber} ${d.name}: reported as ${pan.value} with remark C (higher deduction for no PAN).` });
        seenNoPan.add(d.employeeId);
      }
    } else if (pan.reason) issues.push({ level: "warning", code: "PAN_TYPE", ref, message: `${ref}: ${pan.reason}.` });
  }
  return issues;
}

const clean = (value: unknown, max: number) => String(value ?? "").replace(/\^/g, " ").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const record = (count: number, values: Record<number, string | number | undefined | null>) => {
  const fields = Array.from({ length: count }, () => "");
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null) fields[Number(key) - 1] = String(value);
  return fields.join("^");
};

/** Form 138 Q1–Q3 regular statement text (one batch). Throws for Q4 or for tax years before 2026-27 (use the RPU). */
export function buildForm138Text(input: { fyStart: number; quarter: Quarter; deductor: Deductor; challans: ChallanIn[]; deductees: DeducteeIn[]; previousToken: string | null; createdOn: string; software?: string }) {
  if (input.fyStart < 2026) throw new Error("Form 138 applies from Tax Year 2026-27; earlier years use Form 24Q via the Protean RPU 6.0.");
  if (input.quarter === "Q4") throw new Error("Protean has not yet published the Form 138 Q4 file format (Annexure II).");
  const d = input.deductor, r = d.responsible || {}, a = d.address || {}, ra = r.address || {};
  const used = input.challans.filter((c) => input.deductees.some((x) => x.challanId === c.id));
  const lines: string[] = [];
  let n = 0;
  lines.push(record(18, { 1: ++n, 2: "FH", 3: "SL1", 4: "R", 5: ddmmyyyy(input.createdOn), 6: 1, 7: "D", 8: d.tan, 9: 1, 10: clean(input.software || "Northstar HRM", 75) }));
  const batchTotal = used.reduce((t, c) => t + Math.round(challanTotal(c)), 0);
  lines.push(record(72, {
    1: ++n, 2: "BH", 3: 1, 4: used.length, 5: "138", 9: input.previousToken || undefined, 13: d.tan, 15: d.pan,
    16: `${input.fyStart + 1}${String(input.fyStart + 2).slice(2)}`, 17: `${input.fyStart}${String(input.fyStart + 1).slice(2)}`, 18: input.quarter,
    19: clean(d.name, 75), 20: clean(a.country || "INDIA", 25), 21: clean(a.line1, 25), 22: clean(a.line2, 25), 23: clean(a.line3, 25), 24: clean(a.line4, 25), 25: clean(a.line5, 25),
    26: a.stateCode, 27: a.pincode, 28: clean(d.email, 75), 29: "91", 30: d.phone, 32: d.category || "K",
    33: clean(r.name, 75), 34: clean(r.designation, 20), 35: clean(ra.line1, 25), 36: clean(ra.line2, 25), 37: clean(ra.line3, 25), 38: clean(ra.line4, 25), 39: clean(ra.line5, 25),
    40: ra.stateCode, 41: ra.pincode, 42: clean(r.email, 75), 43: clean(ra.country || "INDIA", 25), 44: "91", 45: r.phone,
    47: `${batchTotal}.00`, 52: input.previousToken ? "Y" : "N", 59: r.pan, 69: d.gstin && /^[0-9]{2}[A-Z0-9]{13}$/.test(d.gstin) ? d.gstin : undefined,
  }));
  used.forEach((c, index) => {
    const rows = input.deductees.filter((x) => x.challanId === c.id).sort((x, y) => x.employeeNumber.localeCompare(y.employeeNumber) || x.period.localeCompare(y.period));
    const deposited = rows.reduce((t, x) => t + x.tds, 0);
    lines.push(record(30, {
      1: ++n, 2: "CD", 3: 1, 4: index + 1, 5: rows.length, 6: "N", 8: whole(taxPart(c)), 9: whole(c.interest), 10: whole(c.fee), 11: whole(c.penalty),
      12: whole(challanTotal(c)), 13: c.mode, 15: c.bsrCode, 17: c.challanSerial, 19: ddmmyyyy(c.depositDate), 21: money(deposited), 22: money(deposited),
      23: c.minorHead || "200", 24: whole(c.interest), 25: whole(c.penalty),
    }));
    rows.forEach((x, rowIndex) => {
      const pan = statementPan(x.pan);
      lines.push(record(45, {
        1: ++n, 2: "DD", 3: 1, 4: rowIndex + 1, 5: index + 1, 6: "O", 8: pan.value, 9: clean(x.name, 75), 15: "1002", 18: "Y",
        19: ddmmyyyy(x.paymentDate), 20: money(x.amountPaid), 24: money(x.tds), 25: money(x.tds), 27: x.tds > 0 ? ddmmyyyy(x.paymentDate) : undefined,
        29: x.tds > 0 ? ddmmyyyy(c.depositDate) : undefined, 32: pan.valid ? undefined : "C",
      }));
    });
  });
  return `${lines.join("\r\n")}\r\n`;
}

/** Human-readable / RPU-entry CSV: Annexure I (one row per deductee row, grouped by challan). */
export function annexureICsv(input: { fyStart: number; quarter: Quarter; challans: ChallanIn[]; deductees: DeducteeIn[]; maskPan?: boolean }) {
  const rows: unknown[][] = [[`Annexure I — deductee-wise salary TDS · ${input.quarter} · Tax Year ${fyLabel(input.fyStart)}`], [],
    ["Challan Sr", "BSR code", "Challan serial", "Deposit date", "Deductee Sr", "Employee ID", "Employee name", "PAN", "Section code", "Date of payment", "Amount paid/credited", "Date of deduction", "TDS deducted", "TDS deposited", "Date of deposit", "Remark"]];
  const used = input.challans.filter((c) => input.deductees.some((x) => x.challanId === c.id));
  used.forEach((c, index) => {
    input.deductees.filter((x) => x.challanId === c.id).sort((x, y) => x.employeeNumber.localeCompare(y.employeeNumber) || x.period.localeCompare(y.period)).forEach((x, i) => {
      const pan = statementPan(x.pan);
      rows.push([index + 1, c.bsrCode, c.challanSerial, c.depositDate, i + 1, x.employeeNumber, x.name, input.maskPan && pan.valid ? `XXXXXX${pan.value.slice(6)}` : pan.value, "1002 (s.392)", x.paymentDate,
        round2(x.amountPaid), x.paymentDate, round2(x.tds), round2(x.tds), c.depositDate, pan.valid ? "" : "C"]);
    });
  });
  return toCsv(rows);
}

export function challansCsv(challans: (ChallanIn & { allocated: number })[], fyStart: number, quarter: Quarter) {
  const rows: unknown[][] = [[`Challan details · ${quarter} · Tax Year ${fyLabel(fyStart)}`], [],
    ["Sr", "Month of deduction", "BSR code", "Challan serial", "Deposit date", "Mode", "Minor head", "Tax", "Surcharge", "Cess", "Interest", "Fee", "Penalty / others", "Total deposited", "Allocated to employees", "Unallocated"]];
  challans.forEach((c, i) => rows.push([i + 1, c.period, c.bsrCode, c.challanSerial, c.depositDate, c.mode === "C" ? "Challan" : "Book adjustment", c.minorHead,
    c.tax, c.surcharge, c.cess, c.interest, c.fee, c.penalty, challanTotal(c), round2(c.allocated), round2(taxPart(c) - c.allocated)]));
  return toCsv(rows);
}

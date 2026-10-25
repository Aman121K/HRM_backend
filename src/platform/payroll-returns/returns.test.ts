/**
 * Statutory returns — Form 138/24Q totals and validation, challan allocation, late-deposit interest, and the annual
 * certificate (Form 130/16 Part B) against the payroll engine's own full-year TDS for the ₹6L / ₹12L / ₹18L examples
 * of payroll/statutory.test.ts. Run: npx tsx --test src/platform/payroll-returns/returns.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addMonths } from "../payroll/statutory";
import { buildStructure } from "../payroll/structure";
import { calculateLine, type LineContext } from "../payroll/engine";
import { allocate, buildForm138Text, challanTotal, validateDeductor, validateQuarter, type ChallanIn, type Deductor, type DeducteeIn, type DeductionIn } from "./form138";
import { computeForm16, type Form16Input, type MonthRecord } from "./form16";
import { depositDueDate, formNames, inr, lateDepositInterest, quarterOfPeriod, statementPan } from "./tds-math";
import { renderCertificatePdf, renderPerquisitesPdf } from "./tax-documents-pdf";
import { PdfDocument } from "./pdf";

// ---------------------------------------------------------------- engine full year → certificate

function fullYear(annualCtc: number, regime: "NEW" | "OLD", joining = "2020-04-01") {
  const structure = buildStructure({ annualCtc, isMetro: false, pfWageMode: "CEILING", pfApplicable: true, asOf: "2026-04-01" });
  const ctx: LineContext = {
    period: "2026-04", employee: { joiningDate: joining, location: "Chikmagalur estate" },
    structure: { components: structure.components, fixedMonthlyGross: structure.fixedMonthlyGross, isMetro: false },
    profile: { regime, pfApplicable: true, ptCategory: "STANDARD", state: "KA", stateSource: "profile", declarations: {}, hasPan: true, hasBank: true },
    settings: { pfWageMode: "CEILING" }, leaveLopDays: 0, inputs: [],
    ytd: { taxable: 0, tds: 0, pf: 0, pt: 0, gross: 0, net: 0, months: 0 }, esiCoveredEarlierInPeriod: false, previous: null,
  };
  const ytd = { ...ctx.ytd };
  const months: MonthRecord[] = [];
  let lastLiability = 0;
  for (let i = 0; i < 12; i++) {
    const period = addMonths("2026-04", i);
    const line = calculateLine({ ...ctx, period, ytd: { ...ytd } });
    if (!line.included) throw new Error("excluded");
    if (line.days.payableDays === 0) continue;
    lastLiability = line.tax.annualLiability;
    months.push({
      period, payDate: `${period}-28`, earnings: [...line.earnings, ...line.oneTime].map((e) => ({ code: e.code, label: e.label, amount: e.amount, taxable: e.taxable !== false })),
      gross: line.totals.gross, taxable: line.totals.taxable, tds: line.statutory.tds.amount, pf: line.statutory.pf.employee + line.statutory.pf.vpf, pt: line.statutory.pt.amount,
      employerPf: line.statutory.pf.employerTotal, employerNps: 0,
    });
    Object.assign(ytd, { taxable: ytd.taxable + line.totals.taxable, tds: ytd.tds + line.statutory.tds.amount, pf: ytd.pf + line.statutory.pf.employee, pt: ytd.pt + line.statutory.pt.amount, gross: ytd.gross + line.totals.gross, months: ytd.months + 1 });
  }
  return { months, tds: ytd.tds, lastLiability };
}

const employer = { name: "Blue Tokai Coffee Roasters", tan: "BLRB12345C", panMasked: "XXXXXX234K", address: "Bengaluru", responsibleName: "Neha Gupta", responsibleDesignation: "Payroll lead" };
function certificateInput(months: MonthRecord[], regime: "NEW" | "OLD", extra: Partial<Form16Input> = {}): Form16Input {
  return {
    fyStart: 2026, regime, metro: false, employee: { id: "e1", number: "BT100", name: "Test Employee", designation: "Roaster", joiningDate: "2020-04-01", panMasked: "XXXXXX123F", hasPan: true },
    employer, months, opening: null, declarations: {}, receipts: [], challans: months.filter((m) => m.tds > 0).map((m) => ({ period: m.period, bsrCode: "0510308", challanSerial: "12345", depositDate: depositDueDate(m.period), tds: m.tds, quarter: quarterOfPeriod(m.period) })),
    ...extra,
  };
}

for (const [ctc, regime, expected] of [[600000, "NEW", 0], [600000, "OLD", 0], [1200000, "NEW", 0], [1200000, "OLD", 147120], [1800000, "NEW", 146310], [1800000, "OLD", 334320]] as const) {
  test(`F16-${ctc / 100000}L-${regime}: certificate tax = engine annual liability = TDS deducted (₹${inr(expected)})`, () => {
    const year = fullYear(ctc, regime);
    assert.equal(year.tds, expected, "engine full-year TDS (same as statutory.test.ts YEAR-*)");
    const data = computeForm16(certificateInput(year.months, regime));
    assert.equal(data.partB.netTaxPayable, expected);
    assert.equal(data.partB.taxPayable, year.lastLiability, "matches the engine's final-month annual liability");
    assert.equal(data.partB.tdsTotal, expected);
    assert.equal(data.partB.balance, 0);
    assert.equal(data.quarters.reduce((t, q) => t + q.deducted, 0), expected);
    assert.equal(data.quarters.reduce((t, q) => t + q.deposited, 0), expected);
    assert.equal(data.warnings.filter((w) => /Shortfall|Excess|≠/.test(w)).length, 0, data.warnings.join(" | "));
  });
}

test("F16-STRUCTURE ₹18L new regime: Part B lines add up", () => {
  const data = computeForm16(certificateInput(fullYear(1800000, "NEW").months, "NEW"));
  const b = data.partB;
  // Gross 17,78,400 − SD 75,000 = 17,03,400 (no exemptions or PT in the new regime) → tax 1,40,680 + cess 5,627 → 1,46,310.
  assert.deepEqual([b.grossSalary, b.standardDeduction, b.professionalTax, b.incomeFromSalary, b.totalIncome, b.taxOnTotalIncome, b.cess, b.taxPayable],
    [1778400, 75000, 0, 1703400, 1703400, 140680, 5627, 146310]);
  assert.equal(b.salaryLines.reduce((t, l) => t + l.amount, 0), b.salary17_1);
});

test("F16-OLD ₹12L: PT and PF (80C) deductions appear in Part B", () => {
  const b = computeForm16(certificateInput(fullYear(1200000, "OLD").months, "OLD")).partB;
  // 11,78,400 − 50,000 − 2,500 = 11,25,900; 80C 29,360 → 10,96,540.
  assert.deepEqual([b.incomeFromSalary, b.chapterVIA[0].deductible, b.totalIncome, b.taxPayable], [1125900, 29360, 1096540, 147120]);
});

test("F16-JOINER mid-year joiner + switch-over opening YTD + previous employer", () => {
  const year = fullYear(1800000, "NEW");
  // Months Apr–Jul were paid by the old system (opening YTD); Aug–Mar here.
  const here = year.months.filter((m) => m.period >= "2026-08");
  const before = year.months.filter((m) => m.period < "2026-08");
  const opening = { employeeId: "e1", source: "switch-over import", throughPeriod: "2026-07", months: 4,
    gross: before.reduce((t, m) => t + m.gross, 0), taxable: before.reduce((t, m) => t + m.taxable, 0), tds: before.reduce((t, m) => t + m.tds, 0),
    pf: before.reduce((t, m) => t + m.pf, 0), pt: before.reduce((t, m) => t + m.pt, 0), employerPf: before.reduce((t, m) => t + m.employerPf, 0),
    basic: before.reduce((t, m) => t + m.earnings.filter((e) => e.code === "BASIC").reduce((s, e) => s + e.amount, 0), 0),
    hra: before.reduce((t, m) => t + m.earnings.filter((e) => e.code === "HRA").reduce((s, e) => s + e.amount, 0), 0) };
  const data = computeForm16(certificateInput(here, "NEW", { opening, challans: certificateInput(here, "NEW").challans }));
  assert.equal(data.partB.taxPayable, 146310, "same annual tax as the uninterrupted year");
  assert.equal(data.partB.tdsTotal, 146310);
  assert.equal(data.openingUnsplitTds, opening.tds);
  assert.ok(data.partB.salaryLines.some((l) => l.code === "OPENING_YTD"));
  // Previous employer salary 3,00,000 with TDS 30,000 → taxable 20,03,400 → 20,000+40,000+60,000+80,000+3,400×25% = 2,00,850 + cess 8,034 → 2,08,880.
  const prev = computeForm16(certificateInput(year.months, "NEW", { declarations: { previousEmployerSalary: 300000, previousEmployerTds: 30000 } }));
  assert.equal(prev.partB.taxPayable, 208880);
  assert.equal(prev.partB.balance, 208880 - 146310 - 30000);
  assert.ok(prev.warnings.some((w) => w.startsWith("Shortfall")));
});

test("F16-NEW-JOINER joined 20 Sep: period of employment starts on the joining date", () => {
  const year = fullYear(1200000, "NEW", "2026-09-20");
  const data = computeForm16(certificateInput(year.months, "NEW", { employee: { ...certificateInput([], "NEW").employee, joiningDate: "2026-09-20" }, exitDate: "2027-02-15" }));
  assert.equal(data.period.from, "2026-09-20");
  assert.equal(data.period.to, "2027-02-15");
  assert.equal(data.partB.netTaxPayable, 0);
});

// ---------------------------------------------------------------- Form 138 / 24Q

const deductor: Deductor = {
  tan: "BLRB12345C", pan: "AABCB1234K", name: "Blue Tokai Coffee Roasters Pvt Ltd", category: "K", gstin: null,
  address: { line1: "12 Roastery Road", line3: "Indiranagar", line5: "Bengaluru", stateCode: "15", pincode: "560038" }, email: "payroll@example.com", phone: "8040000000",
  responsible: { name: "Neha Gupta", designation: "Payroll lead", email: "neha@example.com", phone: "9800000000", address: { line1: "12 Roastery Road", stateCode: "15", pincode: "560038" }, pan: "ABCPG1234Q" },
};
const challan = (id: string, period: string, tax: number, depositDate = depositDueDate(period), serial = "10001"): ChallanIn =>
  ({ id, period, bsrCode: "0510308", challanSerial: serial, depositDate, mode: "C", minorHead: "200", tax, surcharge: 0, cess: 0, interest: 0, fee: 0, penalty: 0 });
const deduction = (employeeId: string, period: string, tds: number, amountPaid = 100000): DeductionIn => ({ employeeId, runId: `run-${period}`, period, paymentDate: `${period}-28`, amountPaid, tds });

test("24Q-ALLOC deducted TDS maps onto that month's challans; shortfall stays unallocated", () => {
  const challans = [challan("c4", "2026-04", 30000), challan("c5a", "2026-05", 10000, "2026-06-05", "1"), challan("c5b", "2026-05", 15000, "2026-06-06", "2")];
  const deductions = [deduction("a", "2026-04", 20000), deduction("b", "2026-04", 10000), deduction("a", "2026-05", 20000), deduction("b", "2026-05", 10000)];
  const result = allocate(challans, deductions);
  assert.equal(result.allocations.filter((a) => a.challanId === "c4").reduce((t, a) => t + a.tds, 0), 30000);
  // May: 30,000 deducted, 25,000 deposited: a's 20,000 split 10,000 + 10,000; b gets 5,000; 5,000 unallocated.
  assert.deepEqual(result.allocations.filter((a) => a.period === "2026-05").map((a) => [a.challanId, a.employeeId, a.tds]), [["c5a", "a", 10000], ["c5b", "a", 10000], ["c5b", "b", 5000]]);
  assert.deepEqual(result.unallocated.map((d) => [d.employeeId, d.tds]), [["b", 5000]]);
});

test("24Q-TOTALS Q1 file: record counts, challan totals = deductee totals, PAN handling, CRLF", () => {
  const challans = [challan("c4", "2026-04", 30000), challan("c5", "2026-05", 30000), challan("c6", "2026-06", 36000)];
  const deductions = ["2026-04", "2026-05", "2026-06"].flatMap((p) => [deduction("a", p, 20000), deduction("b", p, p === "2026-06" ? 16000 : 10000, p === "2026-06" ? 80000 : 100000)]);
  const { allocations, unallocated } = allocate(challans, deductions);
  const deductees: DeducteeIn[] = allocations.map((a) => ({ ...a, employeeNumber: a.employeeId === "a" ? "BT001" : "BT002", name: a.employeeId === "a" ? "Ananya Sharma" : "Ravi Kumar", pan: a.employeeId === "a" ? "ABCPS1234D" : null }));
  const issues = validateQuarter({ fyStart: 2026, quarter: "Q1", challans, deductees, deductedTotal: deductions.reduce((t, d) => t + d.tds, 0), unallocated });
  assert.deepEqual(issues.filter((i) => i.level === "error").map((i) => i.code), ["NO_PAN_RATE", "NO_PAN_RATE"], "₹10,000 on ₹1,00,000 is below 20% for a no-PAN employee");
  assert.ok(issues.some((i) => i.code === "NO_PAN"), "June ₹16,000 on ₹80,000 = 20% → remark C is fine");
  assert.deepEqual(validateDeductor(deductor), []);
  const text = buildForm138Text({ fyStart: 2026, quarter: "Q1", deductor, challans, deductees, previousToken: null, createdOn: "2026-10-20" });
  assert.ok(text.endsWith("\r\n"));
  const lines = text.trimEnd().split("\r\n").map((l) => l.split("^"));
  const byType = (t: string) => lines.filter((l) => l[1] === t);
  assert.deepEqual([byType("FH")[0].length, byType("BH")[0].length, byType("CD")[0].length, byType("DD")[0].length], [18, 72, 30, 45], "Protean field counts");
  assert.deepEqual(lines.map((l) => Number(l[0])), lines.map((_, i) => i + 1), "running line numbers");
  const bh = byType("BH")[0];
  assert.deepEqual([bh[3], bh[4], bh[15], bh[16], bh[17], bh[46], bh[51]], ["3", "138", "202728", "202627", "Q1", "96000.00", "N"]);
  for (const cd of byType("CD")) {
    const rows = byType("DD").filter((dd) => dd[4] === cd[3]);
    assert.equal(Number(cd[4]), rows.length, "CD deductee count");
    assert.equal(Number(cd[20]), rows.reduce((t, dd) => t + Number(dd[24]), 0), "challan field 21 = Σ deductee deposited");
    assert.equal(Number(cd[21]), rows.reduce((t, dd) => t + Number(dd[23]), 0), "challan field 22 = Σ deductee deducted");
    assert.ok(Number(cd[11]) >= Number(cd[20]), "deposit ≥ allocated");
  }
  assert.equal(byType("CD").reduce((t, cd) => t + Number(cd[11]), 0), Number(bh[46]), "batch total = Σ challan totals");
  const noPan = byType("DD").filter((dd) => dd[7] === "PANNOTAVBL");
  assert.equal(noPan.length, 3);
  assert.ok(noPan.every((dd) => dd[31] === "C" && dd[14] === "1002"));
  assert.throws(() => buildForm138Text({ fyStart: 2026, quarter: "Q4", deductor, challans, deductees, previousToken: null, createdOn: "2026-10-20" }), /Q4/);
});

test("24Q-VALIDATION deducted ≠ deposited, missing deductor data, out-of-quarter date", () => {
  const challans = [challan("c7", "2026-07", 5000)];
  const { allocations, unallocated } = allocate(challans, [deduction("a", "2026-07", 8000)]);
  const deductees = allocations.map((a) => ({ ...a, employeeNumber: "BT001", name: "A", pan: "ABCPS1234D", paymentDate: "2026-06-30" }));
  const codes = validateQuarter({ fyStart: 2026, quarter: "Q2", challans, deductees, deductedTotal: 8000, unallocated }).map((i) => i.code);
  assert.ok(codes.includes("NOT_DEPOSITED") && codes.includes("PAYMENT_DATE"));
  assert.ok(validateQuarter({ fyStart: 2026, quarter: "Q2", challans, deductees: [], deductedTotal: 0, unallocated: [] }).some((i) => i.code === "NO_DEDUCTEES"));
  assert.ok(validateQuarter({ fyStart: 2026, quarter: "Q2", challans, deductees, deductedTotal: 9000, unallocated }).some((i) => i.code === "TOTAL_MISMATCH"));
  assert.deepEqual(validateDeductor({ ...deductor, tan: "BAD", responsible: { ...deductor.responsible, pan: null } }).map((i) => i.code), ["TAN", "RESPONSIBLE_PAN"]);
  assert.equal(challanTotal({ ...challan("x", "2026-07", 1000), interest: 15, fee: 200 }), 1215);
});

test("TDS-DUE due dates, March → 30 April, interest 1.5% per month or part", () => {
  assert.equal(depositDueDate("2026-09"), "2026-10-07");
  assert.equal(depositDueDate("2026-12"), "2027-01-07");
  assert.equal(depositDueDate("2027-03"), "2027-04-30");
  assert.equal(lateDepositInterest({ tds: 50000, deductionDate: "2026-09-30", depositDate: "2026-10-07" }).interest, 0);
  // Deducted 30 Sep, deposited 8 Oct: Sep + Oct = 2 months × 1.5% × 50,000 = 1,500.
  assert.deepEqual((({ late, months, interest }) => ({ late, months, interest }))(lateDepositInterest({ tds: 50000, deductionDate: "2026-09-30", depositDate: "2026-10-08" })), { late: true, months: 2, interest: 1500 });
  // Principal rounded down to ₹100: 12,345 → 12,300 × 1.5% × 3 = 553.5 → 554.
  assert.equal(lateDepositInterest({ tds: 12345, deductionDate: "2026-07-31", depositDate: "2026-09-02" }).interest, 554);
  assert.equal(lateDepositInterest({ tds: 1000, deductionDate: "2027-03-31", depositDate: "2027-04-30" }).late, false);
});

test("PAN-1 PANNOTAVBL / PANINVALID handling and form names by year", () => {
  assert.equal(statementPan(null).value, "PANNOTAVBL");
  assert.equal(statementPan("abc").value, "PANINVALID");
  assert.equal(statementPan("ABCPS1234D").valid, true);
  assert.match(statementPan("AABCS1234D").reason || "", /4th character/);
  assert.equal(formNames(2026).quarterly, "Form 138");
  assert.equal(formNames(2026).certificate, "Form 130");
  assert.equal(formNames(2025).certificate, "Form 16");
});

// ---------------------------------------------------------------- PDFs

test("PDF-1 certificate and 12BA are valid PDFs with extractable text; Part A is embedded unchanged", async () => {
  const data = computeForm16(certificateInput(fullYear(1800000, "NEW").months, "NEW"));
  const partA = new PdfDocument({ title: "Part A" }); partA.paragraph("TRACES PART A SAMPLE"); const partABytes = partA.toBuffer();
  const pdf = renderCertificatePdf(data, "ABCPS1234D", { name: "Form16_PartA.pdf", bytes: partABytes });
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(pdf.includes(partABytes), "attachment carried byte-for-byte");
  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  const text = (await parser.getText()).text as string;
  await parser.destroy();
  for (const needle of ["Form 130", "ABCPS1234D", "1,46,310", "17,03,400", "Standard deduction", "Health and education cess"]) assert.ok(text.includes(needle), `missing ${needle}`);
  const perqs = renderPerquisitesPdf(data, "ABCPS1234D");
  assert.equal(perqs.subarray(0, 5).toString("latin1"), "%PDF-");
});

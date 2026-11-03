// npx tsx --test src/platform/billing/billing.engine.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agingBucket, billableCount, composeInvoice, fiscalYear, formatDocumentNumber, gstinCheckChar, gstinProblem, gstSplit, monthRange,
  paymentState, reminderFor, rupeesInWords, type SubscriptionTerms,
} from "./billing.engine";
import { renderBillingPdf } from "./invoice-pdf";

const terms = (over: Partial<SubscriptionTerms> = {}): SubscriptionTerms => ({
  id: "s1", planName: "Growth", pepmPaise: 9900, minimumPaise: 750000, setupFeePaise: 0, discountPct: 0, cycle: "MONTHLY",
  annualDiscountPct: 0, usageBasis: "PEAK", trialDays: 0, contractStart: "2026-01-01", contractEnd: null, committedSeats: null, ...over,
});
const brand = { organizationId: "o1", name: "Blue Tokai" };
const flatUsage = (count: number, from = "2026-09-01", to = "2026-09-30") => {
  const days: Record<string, number> = {};
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) days[d.toISOString().slice(0, 10)] = count;
  return days;
};

test("GST split: same state → CGST 9% + SGST 9%", () => {
  assert.deepEqual(gstSplit(1_000_000, 18, "KA", "KA"), { supplyType: "INTRA", cgst: 90_000, sgst: 90_000, igst: 0, total: 1_180_000 });
});
test("GST split: different state → IGST 18%", () => {
  assert.deepEqual(gstSplit(1_000_000, 18, "KA", "MH"), { supplyType: "INTER", cgst: 0, sgst: 0, igst: 180_000, total: 1_180_000 });
});
test("GST split rounds each tax to the paisa and CGST == SGST", () => {
  const split = gstSplit(12_345, 18, "KA", "KA"); // 9% of 123.45 = 11.1105 → 11.11
  assert.equal(split.cgst, 1111); assert.equal(split.sgst, 1111); assert.equal(split.total, 12_345 + 2222);
  assert.equal(gstSplit(12_345, 18, "KA", "TN").igst, 2222);
});

test("minimum fee: usage below the minimum adds a top-up line to exactly the minimum", () => {
  const draft = composeInvoice({ period: "2026-09", brands: [brand], subscriptions: [terms()], usage: { o1: flatUsage(5) }, liveCounts: {}, setupFeeAlreadyBilled: true, adjustments: [] });
  assert.equal(draft.lines[0].amountPaise, 5 * 9900);
  assert.equal(draft.lines[1].kind, "MINIMUM_TOPUP");
  assert.equal(draft.lines[1].amountPaise, 750000 - 49500);
  assert.equal(draft.subtotalPaise, 750000);
});
test("minimum fee: usage above the minimum → no top-up", () => {
  const draft = composeInvoice({ period: "2026-09", brands: [brand], subscriptions: [terms()], usage: { o1: flatUsage(100) }, liveCounts: {}, setupFeeAlreadyBilled: true, adjustments: [] });
  assert.equal(draft.lines.length, 1);
  assert.equal(draft.subtotalPaise, 990000);
});

test("usage basis: PEAK takes the highest day, AVERAGE rounds the mean up", () => {
  const daily = { "2026-09-01": 10, "2026-09-02": 14, "2026-09-03": 11 };
  assert.equal(billableCount(daily, "2026-09-01", "2026-09-30", "PEAK", 0).count, 14);
  assert.equal(billableCount(daily, "2026-09-01", "2026-09-30", "AVERAGE", 0).count, 12); // 35/3 = 11.67 → 12
  assert.deepEqual(billableCount({}, "2026-09-01", "2026-09-30", "PEAK", 7), { count: 7, days: 0, estimated: true });
});

test("proration: contract starting mid-month bills the remaining days and a prorated minimum", () => {
  const draft = composeInvoice({ period: "2026-09", brands: [brand], subscriptions: [terms({ contractStart: "2026-09-16", setupFeePaise: 1_500_000 })],
    usage: { o1: { ...flatUsage(2, "2026-09-01", "2026-09-15"), ...flatUsage(100, "2026-09-16", "2026-09-30") } }, liveCounts: {}, setupFeeAlreadyBilled: false, adjustments: [] });
  const sub = draft.lines.find((line) => line.kind === "SUBSCRIPTION")!;
  assert.equal(sub.quantity, 100); // usage before the contract start is ignored
  assert.equal(sub.amountPaise, Math.round(9900 * 100 * 15 / 30));
  assert.ok(!draft.lines.some((line) => line.kind === "MINIMUM_TOPUP")); // 4,95,000 > 3,75,000 prorated minimum
  assert.equal(draft.lines.find((line) => line.kind === "SETUP")!.amountPaise, 1_500_000);
  const small = composeInvoice({ period: "2026-09", brands: [brand], subscriptions: [terms({ contractStart: "2026-09-21" })], usage: { o1: flatUsage(3) }, liveCounts: {}, setupFeeAlreadyBilled: true, adjustments: [] });
  assert.equal(small.subtotalPaise, Math.round(750000 * 10 / 30)); // minimum prorated to 10/30 days
});
test("proration: plan change mid-month splits into two priced segments", () => {
  const draft = composeInvoice({ period: "2026-09", brands: [brand], usage: { o1: flatUsage(200) }, liveCounts: {}, setupFeeAlreadyBilled: true, adjustments: [],
    subscriptions: [terms({ id: "a", planName: "Starter", pepmPaise: 4900, minimumPaise: 0, contractEnd: "2026-09-10" }),
      terms({ id: "b", planName: "Enterprise", pepmPaise: 14900, minimumPaise: 0, contractStart: "2026-09-11" })] });
  const [starter, enterprise] = draft.lines;
  assert.equal(starter.amountPaise, Math.round(4900 * 200 * 10 / 30));
  assert.equal(enterprise.amountPaise, Math.round(14900 * 200 * 20 / 30));
  assert.match(enterprise.description, /11 Sep–30 Sep/);
});
test("free trial days are not billed", () => {
  const draft = composeInvoice({ period: "2026-09", brands: [brand], subscriptions: [terms({ contractStart: "2026-09-01", trialDays: 14, minimumPaise: 0 })],
    usage: { o1: flatUsage(30) }, liveCounts: {}, setupFeeAlreadyBilled: true, adjustments: [] });
  assert.equal(draft.lines[0].kind, "TRIAL");
  assert.equal(draft.lines[1].amountPaise, Math.round(9900 * 30 * 16 / 30));
});
test("discounts and queued credits: custom discount on PEPM, credit cannot push the invoice below zero", () => {
  const draft = composeInvoice({ period: "2026-09", brands: [brand], subscriptions: [terms({ discountPct: 10, minimumPaise: 0 })], usage: { o1: flatUsage(10) }, liveCounts: {},
    setupFeeAlreadyBilled: true, adjustments: [{ id: "c1", kind: "CREDIT", description: "Goodwill credit", amountPaise: 200_000 }] });
  assert.equal(draft.lines[0].unitPricePaise, 8910);
  assert.equal(draft.lines[1].amountPaise, -89100); // capped at the 89,100 subtotal
  assert.equal(draft.subtotalPaise, 0);
  assert.deepEqual(draft.appliedAdjustments, [{ id: "c1", amountPaise: 89100 }]);
});
test("annual cycle: contract-year fee on the anniversary month, overage monthly", () => {
  const annual = terms({ cycle: "ANNUAL", annualDiscountPct: 10, committedSeats: 50, minimumPaise: 0, contractStart: "2026-09-01" });
  const first = composeInvoice({ period: "2026-09", brands: [brand], subscriptions: [annual], usage: { o1: flatUsage(60) }, liveCounts: {}, setupFeeAlreadyBilled: true, adjustments: [] });
  assert.equal(first.lines[0].kind, "ANNUAL");
  assert.equal(first.lines[0].amountPaise, 50 * 8910 * 12);
  assert.equal(first.lines[1].kind, "OVERAGE");
  assert.equal(first.lines[1].amountPaise, 10 * 8910);
  const later = composeInvoice({ period: "2026-10", brands: [brand], subscriptions: [annual], usage: { o1: flatUsage(40, "2026-10-01", "2026-10-31") }, liveCounts: {}, setupFeeAlreadyBilled: true, adjustments: [] });
  assert.equal(later.lines.length, 0);
});
test("group account: one line per brand", () => {
  const draft = composeInvoice({ period: "2026-09", brands: [brand, { organizationId: "o2", name: "Got Tea" }], subscriptions: [terms({ minimumPaise: 0 })],
    usage: { o1: flatUsage(5), o2: flatUsage(7) }, liveCounts: {}, setupFeeAlreadyBilled: true, adjustments: [] });
  assert.deepEqual(draft.lines.map((line) => line.quantity), [5, 7]);
});

test("numbering: FY boundary — 31 Mar stays in the old series, 1 Apr starts the new one", () => {
  assert.equal(fiscalYear("2027-03-31"), "2026-27");
  assert.equal(fiscalYear("2027-04-01"), "2027-28");
  assert.equal(fiscalYear("2026-10-20"), "2026-27");
  assert.equal(fiscalYear("2099-12-31"), "2099-00");
  assert.equal(formatDocumentNumber("NS", "2026-27", 1), "NS/2026-27/0001");
  assert.ok(formatDocumentNumber("NS", "2026-27", 1).length <= 16);
});
test("numbering: rejects numbers over 16 characters or with characters GST does not allow", () => {
  assert.throws(() => formatDocumentNumber("ABCDE", "2026-27", 1), /16-character/);
  assert.throws(() => formatDocumentNumber("N_S", "2026-27", 1), /not allow/);
});

test("GSTIN: check digit and state code", () => {
  assert.equal(gstinCheckChar("27AAPFU0939F1Z"), "V"); // widely published sample GSTIN 27AAPFU0939F1ZV
  assert.equal(gstinProblem("27AAPFU0939F1ZV", "MH"), null);
  assert.match(gstinProblem("27AAPFU0939F1ZX", "MH")!, /check digit/);
  assert.match(gstinProblem("27AAPFU0939F1ZV", "KA")!, /does not match/);
});

test("receivables: payment state, aging and reminder days", () => {
  assert.deepEqual(paymentState(118_000, 50_000, 0), { state: "PARTIALLY_PAID", outstandingPaise: 68_000 });
  assert.deepEqual(paymentState(118_000, 0, 118_000), { state: "CREDITED", outstandingPaise: 0 });
  assert.deepEqual(paymentState(118_000, 100_000, 18_000), { state: "PAID", outstandingPaise: 0 });
  assert.equal(agingBucket("2026-10-01", "2026-10-01"), "current");
  assert.equal(agingBucket("2026-10-01", "2026-11-15"), "d31_60");
  assert.equal(reminderFor("2026-11-04", "2026-11-01"), "DUE_IN_3");
  assert.equal(reminderFor("2026-11-04", "2026-11-04"), "DUE_TODAY");
  assert.equal(reminderFor("2026-11-04", "2026-11-11"), "OVERDUE_7");
  assert.equal(reminderFor("2026-11-04", "2026-11-05"), null);
  assert.equal(monthRange("2028-02").days, 29);
});

test("amount in words with paise", () => {
  assert.equal(rupeesInWords(885_000), "Indian Rupees Eight Thousand Eight Hundred Fifty Only");
  assert.equal(rupeesInWords(12_345_678_90), "Indian Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Ninety Paise Only");
});

test("PDF: starts with %PDF and the text is extractable", async () => {
  const buffer = renderBillingPdf({
    kind: "INVOICE", number: "NS/2026-27/0001", issueDate: "2026-10-01", dueDate: "2026-10-16", periodStart: "2026-09-01", periodEnd: "2026-09-30",
    placeOfSupply: "MH", supplyType: "INTER", sacCode: "998315", gstRate: 18,
    seller: { legalName: "ClanChief Software Pvt Ltd", gstin: "29ABCDE1234F1Z5", address: "1 MG Road, Bengaluru 560001", stateCode: "KA" },
    buyer: { legalName: "Got Tea (Ruchi & Sons)", gstin: "27AAPFU0939F1ZV", address: "Lower Parel, Mumbai", stateCode: "MH" },
    lines: [{ description: "Growth — Got Tea: 4 employees × Rs. 99.00 PEPM", quantity: 4, unitPricePaise: 9900, amountPaise: 39600 }],
    subtotalPaise: 39600, cgstPaise: 0, sgstPaise: 0, igstPaise: 7128, totalPaise: 46728,
  });
  assert.equal(buffer.subarray(0, 5).toString("latin1"), "%PDF-");
  const { PDFParse } = await import("pdf-parse").then((module) => module as unknown as { PDFParse?: new (input: { data: Buffer }) => { getText(): Promise<{ text: string }> } });
  let text: string;
  if (PDFParse) text = (await new PDFParse({ data: buffer }).getText()).text;
  else { const legacy = (await import("pdf-parse")) as unknown as { default: (data: Buffer) => Promise<{ text: string }> }; text = (await legacy.default(buffer)).text; }
  for (const expected of ["TAX INVOICE", "NS/2026-27/0001", "27AAPFU0939F1ZV", "Maharashtra (27)", "IGST @ 18%", "998315", "Got Tea (Ruchi & Sons)", "467.28", "Reverse charge"])
    assert.ok(text.includes(expected), `PDF text should contain ${expected}`);
});

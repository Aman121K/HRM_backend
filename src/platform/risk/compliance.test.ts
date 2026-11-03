// npx tsx --test src/platform/risk/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  complianceCalendar, complianceSignals, evaluateObligation, fiscalYear, gratuityAmount, gratuitySignals, noPayrollSignal, obligationsBetween, serviceYears, type ComplianceFacts, type RunFact,
} from "./compliance";

const byKey = (from: string, to: string, states: string[] = ["KA"]) => new Map(obligationsBetween(from, to, states).map((item) => [item.key, item]));
const run = (period: string, extra: Partial<RunFact> = {}): RunFact => ({
  id: `run-${period}`, period, status: "LOCKED", totals: { pfEmployee: 18000, pfEmployer: 18000, esiEmployee: 400, esiEmployer: 1700, tds: 73000, pt: 1600 },
  ptByState: { KA: 1600 }, exports: [], ...extra,
});
const facts = (runs: RunFact[], marks: ComplianceFacts["marks"] = {}): ComplianceFacts => ({ runs, marks, firstRunPeriod: runs.map((r) => r.period).sort()[0] || null });

test("monthly due dates: PF/ESI on the 15th, TDS on the 7th, March TDS on 30 April", () => {
  const items = byKey("2026-04-01", "2026-10-31");
  assert.equal(items.get("PF:2026-08")!.dueDate, "2026-09-15");
  assert.equal(items.get("ESI:2026-08")!.dueDate, "2026-09-15");
  assert.equal(items.get("TDS:2026-08")!.dueDate, "2026-09-07");
  assert.equal(items.get("TDS:2026-03")!.dueDate, "2026-04-30");
  assert.equal(items.get("PF:2026-12"), undefined, "outside the range");
});

test("quarterly 24Q and Form 16 due dates follow the Indian FY", () => {
  const items = byKey("2026-05-01", "2027-06-30");
  assert.equal(items.get("24Q:2026-27:Q1")!.dueDate, "2026-07-31");
  assert.equal(items.get("24Q:2026-27:Q2")!.dueDate, "2026-10-31");
  assert.equal(items.get("24Q:2026-27:Q3")!.dueDate, "2027-01-31");
  assert.equal(items.get("24Q:2025-26:Q4")!.dueDate, "2026-05-31");
  assert.equal(items.get("FORM16:2026-27")!.dueDate, "2027-06-15");
  assert.deepEqual(items.get("24Q:2026-27:Q2")!.months, ["2026-09", "2026-08", "2026-07"]);
  assert.equal(fiscalYear("2027-02"), "2026-27");
});

test("state PT: Karnataka 20th, Maharashtra last day of next month, Delhi none; all marked verify", () => {
  const items = byKey("2026-09-01", "2026-10-31", ["KA", "MH", "DL"]);
  assert.equal(items.get("PT:KA:2026-08")!.dueDate, "2026-09-20");
  assert.equal(items.get("PT:MH:2026-08")!.dueDate, "2026-09-30");
  assert.equal(items.get("PT:MH:2026-09")!.dueDate, "2026-10-31");
  assert.ok(items.get("PT:KA:2026-08")!.verify);
  assert.equal([...items.keys()].filter((key) => key.startsWith("PT:DL")).length, 0);
});

test("LWF: Maharashtra June deduction due 15 July, Karnataka annual due 15 January (verify)", () => {
  const items = byKey("2026-07-01", "2027-01-31", ["KA", "MH"]);
  assert.equal(items.get("LWF:MH:2026-06")!.dueDate, "2026-07-15");
  assert.equal(items.get("LWF:MH:2026-12")!.dueDate, "2027-01-15");
  assert.equal(items.get("LWF:KA:2026-12")!.dueDate, "2027-01-15");
  assert.ok(items.get("LWF:KA:2026-12")!.verify);
});

test("status is tied to data: ECR exported → READY, marked → FILED, no run → NO_PAYROLL, zero ESI → NOT_APPLICABLE", () => {
  const items = byKey("2026-09-01", "2026-09-30");
  const withExport = facts([run("2026-07"), run("2026-08", { exports: [{ kind: "pf-ecr", at: "2026-09-05T10:00:00Z" }], totals: { pfEmployee: 19770, pfEmployer: 19770, esiEmployee: 0, esiEmployer: 0, tds: 80435 } })]);
  const pf = evaluateObligation(items.get("PF:2026-08")!, withExport, "2026-09-10");
  assert.equal(pf.status, "READY");
  assert.equal(pf.amount, 39540);
  assert.equal(pf.daysLeft, 5);
  assert.equal(pf.bucket, "this_week");
  assert.equal(evaluateObligation(items.get("ESI:2026-08")!, withExport, "2026-09-10").status, "NOT_APPLICABLE");
  const tds = evaluateObligation(items.get("TDS:2026-08")!, withExport, "2026-09-10");
  assert.equal(tds.status, "PENDING");
  assert.equal(tds.bucket, "overdue");
  assert.match(tds.detail, /₹80,435/);
  const marked = facts([run("2026-08")], { "PF:2026-08": { status: "FILED", reference: "TRRN123", note: null, markedAt: "2026-09-14T00:00:00Z", markedBy: "HR" } });
  assert.equal(evaluateObligation(items.get("PF:2026-08")!, marked, "2026-09-20").status, "FILED");
  const gap = evaluateObligation(items.get("PF:2026-08")!, facts([run("2026-07")]), "2026-09-10");
  assert.equal(gap.status, "NO_PAYROLL");
  assert.match(gap.detail, /processed outside ClanChief/);
  assert.equal(evaluateObligation(items.get("PF:2026-08")!, facts([run("2026-08", { status: "CANCELLED" })]), "2026-09-10").status, "NO_PAYROLL");
  const future = evaluateObligation(byKey("2026-11-01", "2026-11-30").get("TDS:2026-10")!, facts([run("2026-09")]), "2026-10-20");
  assert.equal(future.status, "AWAITING_PAYROLL", "the October payroll can't exist before October ends");
});

test("signals: overdue money filings >7 days are critical, due tomorrow is high, filed items are cleared", () => {
  const data = facts([run("2026-07"), run("2026-08")], { "ESI:2026-08": { status: "FILED", reference: null, note: null, markedAt: "", markedBy: null } });
  const calendar = complianceCalendar("2026-08-01", "2026-10-31", ["KA"], data, "2026-09-25");
  const { drafts, cleared } = complianceSignals(calendar.items, data);
  const pf = drafts.find((draft) => draft.subjectKey === "PF:2026-08")!;
  assert.equal(pf.severity, "critical");
  assert.match(pf.explanation, /10 days overdue/);
  assert.ok(cleared.includes("ESI:2026-08"));
  assert.ok(!drafts.some((draft) => draft.subjectKey === "PF:2026-09"), "PF for September is due 15 Oct — more than a week away");
  const soon = complianceSignals(complianceCalendar("2026-10-01", "2026-10-31", ["KA"], data, "2026-10-14").items, data).drafts.find((draft) => draft.subjectKey === "PF:2026-09");
  assert.equal(soon?.severity, "high");
  assert.ok(pf.audiences.includes("PAYROLL"));
  assert.equal(pf.action.href, "/payroll/admin/run-2026-08");
});

test("no payroll in ClanChief: no per-item signals, one low summary signal", () => {
  const data = facts([]);
  const calendar = complianceCalendar("2026-08-01", "2026-10-31", ["MH"], data, "2026-09-25");
  assert.equal(complianceSignals(calendar.items, data).drafts.length, 0);
  const summary = noPayrollSignal(data, calendar.items)!;
  assert.equal(summary.severity, "low");
  assert.match(summary.title, /can't be checked/);
  assert.equal(noPayrollSignal(facts([run("2026-08")]), calendar.items), null);
});

test("items before the first payroll run are not raised", () => {
  const data = facts([run("2026-09")]);
  const calendar = complianceCalendar("2026-08-01", "2026-10-31", ["KA"], data, "2026-09-25");
  assert.ok(!complianceSignals(calendar.items, data).drafts.some((draft) => draft.subjectKey === "PF:2026-08"));
});

test("gratuity: service years round a part-year over 6 months up; amount = basic × 15/26 × years, capped", () => {
  assert.deepEqual(serviceYears("2021-10-01", "2026-09-29").rounded, 5);
  assert.equal(serviceYears("2021-10-01", "2026-09-29").exact.toFixed(2), "4.92");
  assert.equal(gratuityAmount(26000, 5), 75000);
  assert.equal(gratuityAmount(5_000_000, 30), 2_000_000);
  const drafts = gratuitySignals([
    { id: "a", joiningDate: "2021-11-15", basicMonthly: 26000, lastWorkingDay: null },
    { id: "b", joiningDate: "2021-01-10", basicMonthly: 30000, lastWorkingDay: "2026-10-31" },
    { id: "c", joiningDate: "2024-01-10", basicMonthly: 30000, lastWorkingDay: "2026-10-31" },
  ], "2026-09-29", 90);
  assert.equal(drafts.length, 2);
  assert.equal(drafts.find((draft) => draft.employeeIds[0] === "a")!.severity, "low");
  const exit = drafts.find((draft) => draft.employeeIds[0] === "b")!;
  assert.equal(exit.severity, "high");
  assert.match(exit.explanation, /₹1,03,846/); // 30000 × 15 × 6 / 26
});

// npx tsx --test src/platform/risk/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { ETHICS_NOTE, checkInSignals, leaveLiability, leaveLiabilitySignal, slaBreaches, stuckApprovals, type PeopleInput } from "./people-service";
import { DEFAULT_SETTINGS } from "./risk.settings";

const people = (extra: Partial<PeopleInput> = {}): PeopleInput => ({
  joiners: [{ id: "isha", joiningDate: "2026-09-20" }], rejected: new Map(), overdueOnboarding: new Map(), attendanceDays: new Map(), today: "2026-09-29", ...extra,
});

test("check-in needs two independent observable signals and carries the ethics note", () => {
  const rejected = new Map([["isha", [{ label: "Leave: Casual Leave", date: "2026-09-24" }, { label: "Leave: Sick Leave", date: "2026-09-26" }]]]);
  const overdue = new Map([["isha", { count: 2, oldestDue: "2026-09-22", joinerId: "j1" }]]);
  assert.equal(checkInSignals(people({ rejected }), DEFAULT_SETTINGS).length, 0, "one signal alone is not enough");
  const drafts = checkInSignals(people({ rejected, overdueOnboarding: overdue }), DEFAULT_SETTINGS);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].severity, "low");
  assert.match(drafts[0].title, /day 9/);
  assert.equal(drafts[0].evidence.note, ETHICS_NOTE);
  assert.deepEqual(drafts[0].audiences, ["MANAGER"]);
  assert.equal(drafts[0].action.href, "/onboarding/j1");
  assert.equal(checkInSignals(people({ joiners: [{ id: "isha", joiningDate: "2026-05-01" }], rejected, overdueOnboarding: overdue }), DEFAULT_SETTINGS).length, 0, "tenure ≥ 90 days");
});

test("falling attendance counts only with a meaningful baseline", () => {
  const overdue = new Map([["isha", { count: 1, oldestDue: "2026-09-22", joinerId: "j1" }]]);
  assert.equal(checkInSignals(people({ overdueOnboarding: overdue, attendanceDays: new Map([["isha", { recent: 2, prior: 9 }]]) }), DEFAULT_SETTINGS).length, 1);
  assert.equal(checkInSignals(people({ overdueOnboarding: overdue, attendanceDays: new Map([["isha", { recent: 0, prior: 2 }]]) }), DEFAULT_SETTINGS).length, 0);
});

test("earned-leave liability: pro-rated quota minus used, at basic ÷ 26", () => {
  const input = { holders: [{ id: "a", joiningDate: "2020-01-01", basicMonthly: 26000 }, { id: "b", joiningDate: "2026-07-01", basicMonthly: 13000 }, { id: "c", joiningDate: "2020-01-01", basicMonthly: null }],
    quota: 18, used: new Map([["a", 3]]), year: 2026, today: "2026-09-29" };
  const { rows, total } = leaveLiability(input, DEFAULT_SETTINGS);
  assert.deepEqual(rows.map((row) => [row.employeeId, row.balance, row.exposure]), [["a", 15, 15000], ["b", 9, 4500]]);
  assert.equal(total, 19500);
  assert.equal(leaveLiabilitySignal(input, DEFAULT_SETTINGS).length, 0, "below the ₹1,00,000 alert level");
  const signal = leaveLiabilitySignal(input, { ...DEFAULT_SETTINGS, people: { ...DEFAULT_SETTINGS.people, liabilityAlertAmount: 10000 } })[0];
  assert.match(signal.title, /₹19,500 \(24 days\)/);
});

test("SLA breaches per category, including still-open overdue tickets", () => {
  const now = new Date("2026-09-29T10:00:00Z");
  const drafts = slaBreaches([
    { id: "1", caseNumber: "HD-1", category: "Payroll & tax", dueAt: "2026-09-27T00:00:00Z", closedAt: null, createdAt: "2026-09-26T00:00:00Z" },
    { id: "2", caseNumber: "HD-2", category: "Payroll & tax", dueAt: "2026-09-20T00:00:00Z", closedAt: "2026-09-21T06:00:00Z", createdAt: "2026-09-19T00:00:00Z" },
    { id: "3", caseNumber: "HD-3", category: "IT & systems", dueAt: "2026-09-28T00:00:00Z", closedAt: "2026-09-27T00:00:00Z", createdAt: "2026-09-26T00:00:00Z" },
  ], DEFAULT_SETTINGS, now);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].subjectKey, "Payroll & tax");
  assert.match(drafts[0].explanation, /\(1 still open\)/);
});

test("approvals stuck > 3 days are grouped by approver", () => {
  const now = new Date("2026-09-29T10:00:00Z");
  const drafts = stuckApprovals([
    { kind: "leave", id: "l1", label: "Casual Leave from 01 Oct", approverId: "ananya", since: "2026-09-20T10:00:00Z" },
    { kind: "case", id: "c1", label: "EXP-0002 · Expenses", approverId: "ananya", since: "2026-09-25T09:00:00Z" },
    { kind: "case", id: "c2", label: "EXP-0009 · Expenses", approverId: "rahul", since: "2026-09-28T09:00:00Z" },
  ], DEFAULT_SETTINGS, now);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].employeeIds[0], "ananya");
  assert.equal(drafts[0].severity, "high"); // oldest 9 days ≥ 3 × limit
  assert.match(drafts[0].explanation, /1 leave, 1 other/);
});

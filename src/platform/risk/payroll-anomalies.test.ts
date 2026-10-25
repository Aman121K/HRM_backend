// npx tsx --test src/platform/risk/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { belowMinimumWage, duplicateBankAccounts, netPayChanges, paidAfterExit, presenceWithoutStructure, statutoryFlips, type PayrollInput, type RunLine } from "./payroll-anomalies";
import { DEFAULT_SETTINGS, EXAMPLE_MINIMUM_WAGES, minimumWageFor } from "./risk.settings";

const line = (employeeId: string, extra: Partial<RunLine> = {}): RunLine => ({
  runId: "run-sep", period: "2026-09", runStatus: "CALCULATED", employeeId, status: "INCLUDED", gross: 20000, net: 18000, previousNet: 18000,
  lopDays: 0, payableDays: 30, daysInMonth: 30, oneTime: 0, pfApplicable: true, esiCovered: true, ...extra,
});
const base = (extra: Partial<PayrollInput> = {}): PayrollInput => ({
  latest: [], previous: [], structures: [], employees: [], presence: new Map(), banks: [], minimumWages: EXAMPLE_MINIMUM_WAGES, today: "2026-09-29", ...extra,
});

test("net pay −23.8% with no revision is flagged; a revised employee is not", () => {
  const input = base({
    latest: [line("ananya", { net: 121796, previousNet: 159776 }), line("kavya", { net: 137607, previousNet: 100000 }), line("ravi", { net: 18111, previousNet: 16371 })],
    structures: [{ employeeId: "kavya", effectiveFrom: "2026-09-01", fixedMonthlyGross: 152367 }, { employeeId: "ananya", effectiveFrom: "2026-04-01", fixedMonthlyGross: 133200 }],
  });
  const drafts = netPayChanges(input, DEFAULT_SETTINGS);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].employeeIds[0], "ananya");
  assert.match(drafts[0].title, /down 23\.8%/);
  assert.match(drafts[0].explanation, /₹1,59,776 to ₹1,21,796/);
  assert.equal(drafts[0].severity, "medium");
  assert.deepEqual(drafts[0].audiences, ["PAYROLL"]);
});

test("minimum wage uses the latest row in force and says when the value is an EXAMPLE", () => {
  assert.equal(minimumWageFor(EXAMPLE_MINIMUM_WAGES, "KA", "UNSKILLED", "2026-09-29")!.monthlyAmount, 17000);
  assert.equal(minimumWageFor(EXAMPLE_MINIMUM_WAGES, "KA", "UNSKILLED", "2026-03-01"), null);
  const input = base({
    employees: [{ id: "arjun", status: "ACTIVE", state: "KA", lastWorkingDay: null, joiningDate: "2024-04-01" }, { id: "ravi", status: "ACTIVE", state: "KA", lastWorkingDay: null, joiningDate: "2024-04-01" }],
    structures: [{ employeeId: "arjun", effectiveFrom: "2026-04-01", fixedMonthlyGross: 16387 }, { employeeId: "ravi", effectiveFrom: "2026-04-01", fixedMonthlyGross: 18208 }],
  });
  const drafts = belowMinimumWage(input, DEFAULT_SETTINGS);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].severity, "medium", "example values never produce a high-severity legal claim");
  assert.match(drafts[0].explanation, /EXAMPLE value/);
  const real = belowMinimumWage({ ...input, minimumWages: [{ ...EXAMPLE_MINIMUM_WAGES[0], isExample: false }] }, DEFAULT_SETTINGS);
  assert.equal(real[0].severity, "high");
});

test("working without a salary structure", () => {
  const drafts = presenceWithoutStructure(base({
    employees: [{ id: "new", status: "ACTIVE", state: "KA", lastWorkingDay: null, joiningDate: "2026-09-20" }],
    presence: new Map([["new", { days: 6, last: "2026-09-28" }]]),
  }));
  assert.equal(drafts.length, 1);
  assert.match(drafts[0].title, /6 days/);
});

test("salary for someone who left before the period, or is inactive, is critical", () => {
  const drafts = paidAfterExit(base({
    latest: [line("gone", { net: 15000 }), line("serving", { net: 15000 }), line("inactive", { net: 9000 })],
    employees: [
      { id: "gone", status: "ACTIVE", state: "KA", lastWorkingDay: "2026-08-20", joiningDate: "2024-01-01" },
      { id: "serving", status: "ACTIVE", state: "KA", lastWorkingDay: "2026-09-30", joiningDate: "2024-01-01" },
      { id: "inactive", status: "INACTIVE", state: "KA", lastWorkingDay: null, joiningDate: "2024-01-01" },
    ],
  }));
  assert.deepEqual(drafts.map((draft) => draft.employeeIds[0]).sort(), ["gone", "inactive"]);
  assert.ok(drafts.every((draft) => draft.severity === "critical"));
});

test("duplicate bank accounts are matched by fingerprint and only last 4 digits are shown", () => {
  const drafts = duplicateBankAccounts(base({ banks: [
    { employeeId: "a", fingerprint: "f1", last4: "0142", bankName: "HDFC Bank", ifsc: "HDFC0000123" },
    { employeeId: "b", fingerprint: "f1", last4: "0142", bankName: "HDFC Bank", ifsc: "HDFC0000123" },
    { employeeId: "c", fingerprint: "f2", last4: "9999", bankName: "SBI", ifsc: "SBIN0001234" },
  ] }));
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0].employeeIds, ["a", "b"]);
  assert.equal(drafts[0].evidence.rows![0].account, "•••• 0142");
  assert.equal(drafts[0].severity, "critical");
});

test("ESI stopping mid contribution period is high; PF becoming applicable is medium", () => {
  const drafts = statutoryFlips(base({
    previous: [line("a", { period: "2026-08", gross: 20500 }), line("b", { period: "2026-08", pfApplicable: false })],
    latest: [line("a", { gross: 21500, esiCovered: false }), line("b")],
  }));
  const esi = drafts.find((draft) => draft.subjectKey.endsWith(":ESI"))!;
  assert.equal(esi.severity, "high");
  assert.match(esi.explanation, /continues until the end of the contribution period/);
  assert.equal(drafts.find((draft) => draft.subjectKey.endsWith(":PF"))!.severity, "medium");
  const october = statutoryFlips(base({ previous: [line("a", { period: "2026-09" })], latest: [line("a", { period: "2026-10", esiCovered: false })] }));
  assert.equal(october[0].severity, "low");
});

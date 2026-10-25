// npx tsx --test src/platform/risk/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { expenseSignals, lateClaims, normalizeMerchant, offDayClaims, roundNumbers, sameMerchantAcrossPeople, splitClaims, type Claim, type ExpenseInput } from "./expense-fraud";
import { DEFAULT_SETTINGS } from "./risk.settings";

let n = 0;
const claim = (requesterId: string, amount: number, date: string, extra: Partial<Claim> = {}): Claim => ({
  id: `c${++n}`, caseNumber: `EXP-${String(n).padStart(4, "0")}`, requesterId, category: "Meals", amount, date, submittedOn: date, status: "SUBMITTED",
  merchant: "Third Wave Coffee", ocrDate: null, ocrTotal: null, duplicateReason: null, ...extra,
});
const S = DEFAULT_SETTINGS.expenses;
const LIMITS = { Meals: 1500, "Local travel": 8000 };

test("split claims: two Meals claims of ₹1,400 on the same day against a ₹1,500 limit", () => {
  const drafts = splitClaims([claim("ravi", 1400, "2026-09-25"), claim("ravi", 1400, "2026-09-25", { merchant: "Chai Point" }), claim("ravi", 400, "2026-09-10")], LIMITS, S);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].severity, "high");
  assert.match(drafts[0].explanation, /add up to ₹2,800/);
  assert.equal(drafts[0].records!.length, 2);
});

test("round-number claims repeated 3+ times", () => {
  const rows = [claim("ravi", 1000, "2026-09-01"), claim("ravi", 1500, "2026-09-08"), claim("ravi", 2000, "2026-09-15"), claim("ravi", 412.63, "2026-09-16")];
  const drafts = roundNumbers(rows, S);
  assert.equal(drafts.length, 1);
  assert.match(drafts[0].title, /^3 round-number claims/);
  assert.equal(roundNumbers(rows.slice(0, 2), S).length, 0);
});

test("claims on a rostered weekly off; weekends only for people without a roster", () => {
  const drafts = offDayClaims([claim("ravi", 500, "2026-09-25"), claim("ravi", 500, "2026-09-26"), claim("hq", 800, "2026-09-27")],
    { weeklyOffs: new Set(["ravi:2026-09-25"]), rostered: new Set(["ravi"]) });
  assert.deepEqual(drafts.map((draft) => draft.employeeIds[0]).sort(), ["hq", "ravi"]);
  assert.match(drafts.find((draft) => draft.employeeIds[0] === "hq")!.explanation, /Sunday/);
});

test("late claims: submitted 75 days after the receipt date", () => {
  const drafts = lateClaims([claim("ravi", 900, "2026-09-20", { ocrDate: "2026-07-10", submittedOn: "2026-09-23" }), claim("ravi", 900, "2026-09-20")], S);
  assert.equal(drafts.length, 1);
  assert.match(drafts[0].title, /75 days after the receipt date/);
});

test("same merchant, amount and day claimed by two people", () => {
  assert.equal(normalizeMerchant("Uber India Pvt Ltd"), normalizeMerchant("UBER"));
  const drafts = sameMerchantAcrossPeople([claim("a", 412.63, "2026-09-24", { merchant: "Uber India" }), claim("b", 412.63, "2026-09-24", { merchant: "UBER" }), claim("c", 412.63, "2026-09-25", { merchant: "Uber" })]);
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0].employeeIds, ["a", "b"]);
});

test("withdrawn claims are ignored; duplicate receipts and on-leave claims are raised", () => {
  const input: ExpenseInput = {
    claims: [
      claim("ravi", 1500, "2026-09-25", { status: "WITHDRAWN", duplicateReason: "Same bytes" }),
      claim("ravi", 780, "2026-09-22", { duplicateReason: "This exact receipt was already submitted on claim EXP-0003 by a colleague." }),
      claim("arjun", 600, "2026-09-14", { category: "Local travel", merchant: "Rapido" }),
    ],
    limits: LIMITS, leaveDays: new Map([["arjun", new Set(["2026-09-14", "2026-09-15"])]]), weeklyOffs: new Set(), rostered: new Set(["ravi", "arjun"]),
  };
  const drafts = expenseSignals(input, DEFAULT_SETTINGS);
  const detectors = drafts.map((draft) => draft.detector).sort();
  assert.deepEqual(detectors, ["expenses.duplicate_receipt", "expenses.on_leave"]);
  assert.match(drafts.find((draft) => draft.detector === "expenses.duplicate_receipt")!.explanation, /by someone else/);
});

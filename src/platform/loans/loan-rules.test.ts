import assert from "node:assert/strict";
import { test } from "node:test";
import { addMonths, perquisiteFlag, schedule, validateRequest } from "./loan-rules";

test("LOAN-1 schedule sums to the principal and the last EMI absorbs rounding", () => {
  const plan = schedule(10000, 3, "2026-11");
  assert.equal(plan.emi, 3334);
  assert.deepEqual(plan.rows.map((r) => [r.period, r.amount]), [["2026-11", 3334], ["2026-12", 3334], ["2027-01", 3332]]);
  assert.equal(plan.rows.reduce((t, r) => t + r.amount, 0), 10000);
});

test("LOAN-2 month arithmetic crosses years", () => {
  assert.equal(addMonths("2026-12", 1), "2027-01");
  assert.equal(addMonths("2027-01", -1), "2026-12");
  assert.equal(addMonths("2026-03", 24), "2028-03");
});

test("LOAN-3 policy limits against monthly gross", () => {
  assert.deepEqual(validateRequest("ADVANCE", 30000, 2, 30000, 0).errors, []);
  assert.match(validateRequest("ADVANCE", 30001, 2, 30000, 0).errors[0], /most you can request/);
  assert.match(validateRequest("ADVANCE", 10000, 4, 30000, 0).errors[0], /at most 3 months/);
  assert.deepEqual(validateRequest("LOAN", 180000, 24, 30000, 0).errors, []);
  assert.ok(validateRequest("LOAN", 50000, 1, 30000, 5000).warnings.length === 2);
  assert.deepEqual(validateRequest("LOAN", 50000, 12, null, 0).errors, []);
});

test("LOAN-4 perquisite flag above ₹2 lakh, never for medical loans", () => {
  assert.equal(perquisiteFlag("Housing", 200000), null);
  assert.ok(perquisiteFlag("Housing", 200001));
  assert.equal(perquisiteFlag("Medical", 900000), null);
});

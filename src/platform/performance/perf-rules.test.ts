import assert from "node:assert/strict";
import { test } from "node:test";
import { computeScore, distribution, firstOfMonthOnOrAfter, goalProgress, suggestedIncrement, toRating, validateGoals } from "./perf-rules";

test("PERF-1 goal progress averages key results, capped at 100%", () => {
  assert.equal(goalProgress([{ title: "Sales", target: 100, current: 50, unit: "%" }, { title: "NPS", target: 10, current: 15, unit: "pts" }]), 75);
  assert.equal(goalProgress([]), null);
});

test("PERF-2 goal weights must total 100", () => {
  assert.deepEqual(validateGoals([{ weight: 60 }, { weight: 40 }]), []);
  assert.match(validateGoals([{ weight: 60 }, { weight: 30 }])[0], /currently 90%/);
  assert.match(validateGoals([])[0], /at least one/);
});

test("PERF-3 weighted score blends goals and competencies", () => {
  // goals: (60×4 + 40×3)/100 = 3.6; competencies avg 4 → 0.7×3.6 + 0.3×4 = 3.72
  assert.equal(computeScore(70, [{ weight: 60, rating: 4 }, { weight: 40, rating: 3 }], [4, 4, 4]), 3.72);
  assert.equal(computeScore(70, [], [5, 3]), 4);
  assert.equal(computeScore(70, [{ weight: 100, rating: 2 }], []), 2);
  assert.equal(computeScore(70, [{ weight: 100, rating: null }], []), null);
});

test("PERF-4 ratings, bands, increments and distribution", () => {
  assert.equal(toRating(3.72), 3.5);
  assert.equal(toRating(3.76), 4);
  assert.equal(suggestedIncrement(4), 10);
  const d = distribution([3, 3, 4, 5]);
  assert.deepEqual(d.map((b) => b.count), [0, 0, 2, 1, 1]);
  assert.equal(d[2].pct, 50);
});

test("PERF-5 revisions start on the 1st of a month", () => {
  assert.equal(firstOfMonthOnOrAfter("2026-11-01"), "2026-11-01");
  assert.equal(firstOfMonthOnOrAfter("2026-11-14"), "2026-12-01");
  assert.equal(firstOfMonthOnOrAfter("2026-12-14"), "2027-01-01");
});

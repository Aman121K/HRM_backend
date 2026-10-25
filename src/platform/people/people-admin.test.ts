// npx tsx --test src/platform/people/people-admin.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDate, parseCsv, templateCsv } from "./people-admin.service";

test("dates in the formats Indian spreadsheets produce", () => {
  assert.equal(normalizeDate("2026-10-05"), "2026-10-05");
  assert.equal(normalizeDate("05/10/2026"), "2026-10-05");
  assert.equal(normalizeDate("5-10-2026"), "2026-10-05");
  assert.equal(normalizeDate("05.10.2026"), "2026-10-05");
  assert.equal(normalizeDate("5 Oct 2026"), "2026-10-05");
  assert.equal(normalizeDate("05-Oct-26"), "2026-10-05");
  assert.equal(normalizeDate("5 October 2026"), "2026-10-05");
});

test("impossible or ambiguous dates are rejected", () => {
  assert.equal(normalizeDate("31/02/2026"), null);
  assert.equal(normalizeDate("2026-13-01"), null);
  assert.equal(normalizeDate("10/2026"), null);
  assert.equal(normalizeDate("5 Foo 2026"), null);
  assert.equal(normalizeDate(""), null);
});

test("template uses the brand's prefix and parses back to the expected columns", () => {
  const rows = parseCsv(templateCsv("GT", "GT001"));
  assert.equal(rows[0][0], "employee_number");
  assert.equal(rows[1][0], "GT101");
  assert.equal(rows[1][6], "GT001");
  assert.equal(rows[2][0], "", "second example row leaves the number blank");
});

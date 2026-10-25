import assert from "node:assert/strict";
import { test } from "node:test";
import { breachClocks, principalNotice } from "./breach-rules";
import { toCsv } from "./export-format";
import { DEFAULT_RETENTION, dueOn, normalizeRetention, planSubject, retentionProblems } from "./retention";

test("retention defaults are clamped and payroll/tax can't go below 6 years", () => {
  assert.deepEqual(normalizeRetention({}), DEFAULT_RETENTION);
  assert.equal(normalizeRetention({ payrollTax: 2 }).payrollTax, 6);
  assert.equal(normalizeRetention({ documents: 99 }).documents, 15);
  assert.deepEqual(retentionProblems({ payrollTax: 5 }).length, 1);
  assert.deepEqual(retentionProblems({ nonsense: 1 }).length, 1);
  assert.deepEqual(retentionProblems({ documents: 2, casesAndLeave: 3 }), []);
});

test("due dates count whole years from the exit date (leap day rolls to 1 March)", () => {
  assert.equal(dueOn("2024-06-30", 1), "2025-06-30");
  assert.equal(dueOn("2024-02-29", 1), "2025-03-01");
});

test("scheduled plan erases only categories past retention; anonymises when nothing is left", () => {
  const plan = planSubject({ exitedOn: "2024-06-30", today: "2026-10-20", years: DEFAULT_RETENTION, alreadyErased: [] });
  assert.deepEqual(plan.due.map((item) => item.category), ["documents", "attendanceDetail", "contact"]);
  assert.deepEqual(plan.later.map((item) => item.category), ["casesAndLeave", "payrollTax"]);
  assert.equal(plan.anonymise, false);
  const old = planSubject({ exitedOn: "2017-03-31", today: "2026-10-20", years: DEFAULT_RETENTION, alreadyErased: ["documents"] });
  assert.equal(old.due.length, 4);
  assert.equal(old.anonymise, true);
});

test("an approved erasure request erases non-statutory data now but keeps payroll/tax for the legal period", () => {
  const plan = planSubject({ exitedOn: "2026-09-30", today: "2026-10-20", years: DEFAULT_RETENTION, alreadyErased: [], request: true });
  assert.deepEqual(plan.due.map((item) => item.category), ["documents", "attendanceDetail", "contact", "casesAndLeave"]);
  assert.deepEqual(plan.later.map((item) => [item.category, item.dueOn]), [["payrollTax", "2034-09-30"]]);
});

test("breach clocks: CERT-In 6 h, Board report 72 h, done/late states", () => {
  const detected = new Date("2026-10-20T00:00:00Z");
  const clocks = breachClocks({ cert_in_reportable: true, cert_in_notified_at: "2026-10-20T03:00:00Z" }, detected, new Date("2026-10-20T10:00:00Z"));
  const by = Object.fromEntries(clocks.map((clock) => [clock.key, clock]));
  assert.equal(by.certIn.state, "done");
  assert.equal(by.boardReport.dueAt, "2026-10-23T00:00:00.000Z");
  assert.equal(by.boardReport.state, "open");
  const late = breachClocks({ cert_in_reportable: true }, detected, new Date("2026-10-20T07:00:00Z"));
  assert.equal(late.find((clock) => clock.key === "certIn")!.state, "late");
  assert.equal(breachClocks({ cert_in_reportable: false }, detected).some((clock) => clock.key === "certIn"), false);
});

test("breach notice and CSV export are safe", () => {
  const notice = principalNotice({ brand: "Acme", reference: "BR-2026-0001", nature: "Laptop stolen.", detectedAt: "2026-10-20T00:00:00Z", categories: ["Bank account"] });
  assert.match(notice.body, /BR-2026-0001/);
  assert.match(notice.body, /Data Protection Board/);
  assert.equal(toCsv([{ a: "=HYPERLINK(1)", b: "x,y" }]), "a,b\r\n'=HYPERLINK(1),\"x,y\"\r\n");
});

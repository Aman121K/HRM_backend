import assert from "node:assert/strict";
import test from "node:test";
import { caseModules } from "../cases/case-modules";
import { renderEmail, htmlToText, escapeHtml } from "./email-layout";
import { JobRegistry } from "./job-registry";
import {
  addDays, anniversaryYears, approverPendingStatuses, daysBetween, dedupeKey, describeSchedule, isOwnTenantJob, isTenantNeutralJob,
  localClock, mailRetryDelayMs, nextWeekStart, overdueStage, slaActiveStatuses, slaState, withinSendWindow,
} from "./scheduling";

test("localClock converts to the tenant timezone", () => {
  const clock = localClock(new Date("2026-09-25T20:00:00Z"), "Asia/Kolkata"); // 01:30 IST next day
  assert.deepEqual(clock, { date: "2026-09-26", hour: 1, minute: 30, isoDow: 6 });
  assert.equal(localClock(new Date("2026-09-26T04:00:00Z"), "Not/AZone").date, "2026-09-26"); // falls back to IST
});

test("date arithmetic and next ISO week start", () => {
  assert.equal(addDays("2026-02-27", 2), "2026-03-01");
  assert.equal(daysBetween("2026-09-20", "2026-09-26"), 6);
  assert.equal(nextWeekStart("2026-09-25"), "2026-09-28"); // Friday -> next Monday
  assert.equal(nextWeekStart("2026-09-28"), "2026-10-05"); // Monday -> the Monday after
  assert.equal(nextWeekStart("2026-09-27"), "2026-09-28"); // Sunday -> tomorrow
});

test("send window keeps reminders to working hours", () => {
  assert.equal(withinSendWindow({ date: "", hour: 7, minute: 59, isoDow: 1 }), false);
  assert.equal(withinSendWindow({ date: "", hour: 8, minute: 0, isoDow: 1 }), true);
  assert.equal(withinSendWindow({ date: "", hour: 21, minute: 0, isoDow: 1 }), false);
});

test("dedupe keys are stable and bounded", () => {
  assert.equal(dedupeKey("lms.overdue", "abc", "2026-09-01", "d3"), "lms.overdue:abc:2026-09-01:d3");
  assert.equal(dedupeKey("x", null, undefined, ""), "x:-:-:-");
  assert.throws(() => dedupeKey("x", "y".repeat(400)));
});

test("overdue cadence fires once per stage: day 1, 3, 7, then weekly", () => {
  const stages = Array.from({ length: 30 }, (_, index) => overdueStage(index));
  assert.equal(stages[0], null);
  assert.deepEqual([...new Set(stages.filter(Boolean))], ["d1", "d3", "d7", "w2", "w3", "w4"]);
  assert.equal(overdueStage(-2), null);
});

test("SLA classification and active statuses", () => {
  const now = new Date("2026-09-26T10:00:00Z");
  assert.equal(slaState("2026-09-26T13:00:00Z", now), "OK");
  assert.equal(slaState("2026-09-26T11:30:00Z", now), "DUE_SOON");
  assert.equal(slaState("2026-09-26T10:00:00Z", now), "BREACHED");
  const helpdesk = caseModules.find((module) => module.key === "helpdesk")!;
  assert.deepEqual(slaActiveStatuses(helpdesk), ["OPEN", "IN_PROGRESS"]);
  assert.deepEqual(slaActiveStatuses(caseModules.find((module) => module.key === "expenses")!), []);
});

test("approver pending statuses come from the case state machines", () => {
  const pending = approverPendingStatuses(caseModules);
  assert.deepEqual(pending.expenses, ["SUBMITTED"]);
  assert.deepEqual(pending.exit, ["SUBMITTED"]);
  assert.equal(pending.helpdesk, undefined); // HR/assignee work, not approvals
});

test("work anniversaries, including Feb-29 joiners", () => {
  assert.equal(anniversaryYears("2023-09-26", "2026-09-26"), 3);
  assert.equal(anniversaryYears("2026-09-26", "2026-09-26"), 0);
  assert.equal(anniversaryYears("2023-09-25", "2026-09-26"), 0);
  assert.equal(anniversaryYears("2024-02-29", "2025-02-28"), 1);
  assert.equal(anniversaryYears("2024-02-29", "2028-02-28"), 0); // leap year: celebrate on the 29th
  assert.equal(anniversaryYears("2024-02-29", "2028-02-29"), 4);
});

test("mail retry backoff doubles and caps at 6 h", () => {
  assert.equal(mailRetryDelayMs(1), 60_000);
  assert.equal(mailRetryDelayMs(3), 4 * 60_000);
  assert.equal(mailRetryDelayMs(20), 360 * 60_000);
});

test("schedules are described for humans", () => {
  assert.equal(describeSchedule({ every: 30_000 }), "Every 30 s");
  assert.equal(describeSchedule({ every: 15 * 60_000 }), "Every 15 min");
  assert.equal(describeSchedule({ cron: "30 9 * * *", tz: "Asia/Kolkata" }), "Daily 09:30 (Asia/Kolkata)");
  assert.equal(describeSchedule({ cron: "0 11 * * 5" }), "Fridays 11:00");
});

test("console tenant filters", () => {
  assert.equal(isOwnTenantJob({ organizationId: "a" }, "a"), true);
  assert.equal(isOwnTenantJob({ organizationId: "b" }, "a"), false);
  assert.equal(isTenantNeutralJob({ scheduled: true }), true);
  assert.equal(isTenantNeutralJob({}), true);
  assert.equal(isTenantNeutralJob({ organizationId: "b" }), false);
  assert.equal(isTenantNeutralJob({ runId: "x" }), false);
});

test("email layout wraps fragments, escapes, and leaves full documents alone", () => {
  const html = renderEmail({ subject: "Hi <there>", html: "<p>Body</p>", organizationName: "Blue & Co" });
  assert.match(html, /CLANCHIEF/);
  assert.match(html, /Hi &lt;there&gt;/);
  assert.match(html, /Blue &amp; Co/);
  assert.equal(renderEmail({ subject: "x", html: "<html><body>raw</body></html>" }), "<html><body>raw</body></html>");
  assert.equal(htmlToText('<p>Hello</p><a href="https://x.test/a">Open</a>'), "Hello\nOpen (https://x.test/a)");
  assert.equal(escapeHtml(`"'`), "&quot;&#39;");
});

test("JobRegistry stays backward compatible", () => {
  const registry = new JobRegistry();
  const handler = async () => 1;
  registry.register("b.job", handler, { every: 1000 });
  registry.register("a.job", handler);
  assert.deepEqual(registry.names(), ["a.job", "b.job"]);
  assert.equal(registry.handler("a.job"), handler);
  assert.deepEqual(registry.schedules(), [{ name: "b.job", every: 1000 }]);
  registry.register("c.job", handler, { cron: "0 9 * * *", description: "Morning" }, { timeoutMs: 5000 });
  assert.deepEqual(registry.describe("c.job"), { description: "Morning", timeoutMs: 5000 });
});

test("per-job timeout rejects slow work and aborts its signal; fast work passes through", async () => {
  const { runWithTimeout, runWithJobContext, throwIfAborted, currentJob } = await import("./job-context");
  assert.equal(await runWithTimeout(async () => 42, 1000), 42);
  let seen: AbortSignal | undefined;
  await assert.rejects(runWithTimeout((signal) => { seen = signal; return new Promise((resolve) => setTimeout(resolve, 200)); }, 20), /Timed out/);
  assert.equal(seen?.aborted, true);
  const controller = new AbortController();
  await runWithJobContext({ id: "1", name: "x.job", attempt: 1, signal: controller.signal, startedAt: new Date() }, async () => {
    assert.equal(currentJob()?.name, "x.job");
    throwIfAborted();
    controller.abort("timeout");
    assert.throws(() => throwIfAborted(), /aborted/);
  });
});

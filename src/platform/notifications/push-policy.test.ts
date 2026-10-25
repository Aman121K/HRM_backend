// npx tsx --test src/platform/notifications/push-policy.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  apnsPayload, categoryFor, classifyApns, classifyFcm, contentFor, decide, defaultPreferences, fcmMessage, hrefFor, maskToken,
  quietHoursEnd, retryDelayMs, shouldCollapse, summaryContent,
} from "./push-policy";

const ev = (eventType: string, entityType: string, payload: Record<string, unknown> = {}) => ({ id: 1, eventType, entityType, entityId: "e1", payload });

test("categories from event_type / entity_type", () => {
  assert.equal(categoryFor(ev("LEAVE_SUBMITTED", "leave")), "approvals");
  assert.equal(categoryFor(ev("EXPENSES_CREATED", "hr_case", { module: "expenses" })), "approvals");
  assert.equal(categoryFor(ev("RECOGNITION_CREATED", "hr_case", { module: "recognition" })), "engagement");
  assert.equal(categoryFor(ev("EXPENSES_APPROVED", "hr_case", { module: "expenses" })), "requests");
  assert.equal(categoryFor(ev("SHIFTS_APPROVED", "hr_case", { module: "shifts" })), "time");
  assert.equal(categoryFor(ev("PAYROLL_APPROVAL_REQUESTED", "payroll_run")), "approvals");
  assert.equal(categoryFor(ev("PAYSLIP_PUBLISHED", "payslip")), "payroll");
  assert.equal(categoryFor(ev("LEAVE_APPROVED", "leave")), "time");
  assert.equal(categoryFor(ev("ROSTER_PUBLISHED", "roster_publication")), "time");
  assert.equal(categoryFor(ev("LMS_DUE_SOON", "lms_enrollment")), "learning");
  assert.equal(categoryFor(ev("SURVEY_LIVE", "survey")), "engagement");
  assert.equal(categoryFor(ev("ACCESS_ROLE_ASSIGNED", "access_assignment")), "announcements");
  assert.equal(categoryFor(ev("ONBOARDING_TASKS_ASSIGNED", "onboarding_joiner")), "requests");
});

test("deep links: payload href/link first, then derived; never protocol-relative", () => {
  assert.equal(hrefFor(ev("X", "survey", { href: "/surveys/1" })), "/surveys/1");
  assert.equal(hrefFor(ev("PAYOUT_RELEASED", "payout_batch", { link: "/settings/integrations?tab=payouts" })), "/settings/integrations?tab=payouts");
  assert.equal(hrefFor(ev("X", "survey", { href: "//evil.example" })), "/surveys");
  assert.equal(hrefFor(ev("EXPENSES_APPROVED", "hr_case", { module: "expenses" })), "/expenses?case=e1");
  assert.equal(hrefFor(ev("LEAVE_SUBMITTED", "leave")), "/approvals");
  assert.equal(hrefFor(ev("PAYSLIP_PUBLISHED", "payslip")), "/payroll");
});

test("content: title per category, body from message (+ case title), truncated", () => {
  const content = contentFor(ev("EXPENSES_APPROVED", "hr_case", { module: "expenses", message: "EXP-0005 · Approved", title: "Cab to roastery" }));
  assert.equal(content.title, "Your requests");
  assert.equal(content.body, "EXP-0005 · Approved — Cab to roastery");
  assert.equal(contentFor(ev("SOMETHING_HAPPENED", "misc")).body, "Something happened");
  assert.ok(contentFor(ev("X", "misc", { message: "a".repeat(500) })).body.length <= 240);
});

test("preferences: push off, category off", () => {
  const now = new Date("2026-09-26T06:00:00Z");
  const prefs = defaultPreferences();
  assert.equal(decide(prefs, "payroll", now).status, "PENDING");
  prefs.categories.payroll = false;
  assert.deepEqual([decide(prefs, "payroll", now).status, decide(prefs, "payroll", now).reason], ["SUPPRESSED", "category_disabled:payroll"]);
  prefs.channels.push = false;
  assert.equal(decide(prefs, "approvals", now).reason, "push_disabled");
});

test("quiet hours wrap midnight in the recipient's zone; approvals deferred to the end, others dropped", () => {
  const prefs = defaultPreferences();
  prefs.quietHours = { enabled: true, start: "22:00", end: "07:00", timezone: "Asia/Kolkata" };
  const lateNight = new Date("2026-09-26T18:15:00Z"); // 23:45 IST
  const deferred = decide(prefs, "approvals", lateNight);
  assert.equal(deferred.status, "PENDING");
  assert.equal(deferred.reason, "deferred_quiet_hours");
  assert.equal(deferred.sendAfter.toISOString(), "2026-09-27T01:30:00.000Z"); // 07:00 IST next day
  assert.deepEqual([decide(prefs, "payroll", lateNight).status, decide(prefs, "payroll", lateNight).reason], ["SUPPRESSED", "quiet_hours"]);
  const earlyMorning = new Date("2026-09-26T00:30:00Z"); // 06:00 IST
  assert.equal(quietHoursEnd(prefs.quietHours, earlyMorning)?.toISOString(), "2026-09-26T01:30:00.000Z");
  assert.equal(quietHoursEnd(prefs.quietHours, new Date("2026-09-26T06:00:00Z")), null); // 11:30 IST
  prefs.quietHours = { enabled: true, start: "13:00", end: "14:00", timezone: "Asia/Kolkata" };
  assert.ok(quietHoursEnd(prefs.quietHours, new Date("2026-09-26T07:40:00Z"))); // 13:10 IST
  prefs.quietHours.enabled = false;
  assert.equal(quietHoursEnd(prefs.quietHours, new Date("2026-09-26T07:40:00Z")), null);
});

test("burst collapsing and retry backoff", () => {
  assert.equal(shouldCollapse(1, 10), false);
  assert.equal(shouldCollapse(5, 0), false);
  assert.equal(shouldCollapse(6, 0), true);
  assert.equal(shouldCollapse(3, 3), true);
  const summary = summaryContent([{ title: "t", body: "one", category: "time" }, { title: "t", body: "two", category: "time" }, { title: "t", body: "three", category: "time" }, { title: "t", body: "four", category: "time" }]);
  assert.equal(summary.title, "4 new notifications");
  assert.equal(summary.body, "one · two · three · +1 more");
  assert.equal(summary.category, "time");
  assert.deepEqual([1, 2, 3].map(retryDelayMs), [30_000, 120_000, 480_000]);
});

test("APNs response handling: 410/BadDeviceToken deactivate, 429/5xx retry, expired provider token refreshes", () => {
  assert.equal(classifyApns(200, null).outcome, "SENT");
  assert.deepEqual(classifyApns(410, { reason: "Unregistered", timestamp: 1 }), { outcome: "INVALID_TOKEN", reason: "Unregistered" });
  assert.equal(classifyApns(400, { reason: "BadDeviceToken" }).outcome, "INVALID_TOKEN");
  assert.equal(classifyApns(400, { reason: "DeviceTokenNotForTopic" }).outcome, "INVALID_TOKEN");
  assert.equal(classifyApns(400, { reason: "PayloadTooLarge" }).outcome, "FAILED");
  assert.deepEqual(classifyApns(403, { reason: "ExpiredProviderToken" }), { outcome: "RETRY", reason: "ExpiredProviderToken", refreshAuth: true });
  assert.equal(classifyApns(403, { reason: "InvalidProviderToken" }).outcome, "FAILED");
  assert.equal(classifyApns(429, { reason: "TooManyRequests" }).outcome, "RETRY");
  assert.equal(classifyApns(503, { reason: "ServiceUnavailable" }).outcome, "RETRY");
});

test("FCM response handling: UNREGISTERED / SENDER_ID_MISMATCH deactivate, 401 refreshes, quota retries", () => {
  assert.equal(classifyFcm(200, { name: "projects/p/messages/1" }).outcome, "SENT");
  assert.equal(classifyFcm(404, { error: { status: "NOT_FOUND", details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }] } }).outcome, "INVALID_TOKEN");
  assert.equal(classifyFcm(403, { error: { status: "PERMISSION_DENIED", details: [{ errorCode: "SENDER_ID_MISMATCH" }] } }).outcome, "INVALID_TOKEN");
  assert.equal(classifyFcm(400, { error: { status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token", details: [{ errorCode: "INVALID_ARGUMENT" }] } }).outcome, "INVALID_TOKEN");
  assert.equal(classifyFcm(400, { error: { status: "INVALID_ARGUMENT", message: "Invalid JSON payload", details: [{ errorCode: "INVALID_ARGUMENT" }] } }).outcome, "FAILED");
  assert.equal(classifyFcm(401, { error: { status: "UNAUTHENTICATED" } }).refreshAuth, true);
  assert.equal(classifyFcm(429, { error: { status: "RESOURCE_EXHAUSTED", details: [{ errorCode: "QUOTA_EXCEEDED" }] } }).outcome, "RETRY");
  assert.equal(classifyFcm(503, null).outcome, "RETRY");
});

test("payload shapes and token masking", () => {
  const message = { notificationId: "9", title: "T", body: "B", badge: 3, category: "payroll",
    data: { href: "/payroll", eventType: "PAYSLIP_PUBLISHED", entityType: "payslip", entityId: "x", notificationId: "9" } };
  const apns = apnsPayload(message);
  assert.deepEqual(apns.aps, { alert: { title: "T", body: "B" }, badge: 3, sound: "default", "thread-id": "payroll" });
  assert.equal(apns.northstar.href, "/payroll");
  const fcm = fcmMessage(message, "tok");
  assert.equal(fcm.message.android.collapse_key, "payroll");
  assert.ok(Object.values(fcm.message.data).every((value) => typeof value === "string"));
  assert.equal(maskToken("80097a94aabbccddeeff43aa"), "80097a…43aa");
  assert.ok(!maskToken("abcdefghijklmnopqrstuvwxyz").includes("klmn"));
});

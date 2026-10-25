// npx tsx --test src/platform/risk/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { LABOUR_SKIPPED, labourSignals, paidMinutes, spanMinutes, type LabourInput, type RosterDay } from "./labour";
import { DEFAULT_SETTINGS, limitsFor, validateSettings } from "./risk.settings";

const shift = (employeeId: string, date: string, start: string, end: string, breakMinutes = 30): RosterDay => ({ employeeId, date, kind: "SHIFT", shift: { employeeId, date, start, end, breakMinutes } });
const off = (employeeId: string, date: string): RosterDay => ({ employeeId, date, kind: "WEEKLY_OFF" });
const input = (roster: RosterDay[], extra: Partial<LabourInput> = {}): LabourInput => ({ roster, worked: [], leaveDays: new Map(), regularized: new Set(), states: new Map(), ...extra });
const week = (start: string) => Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

test("shift arithmetic handles overnight shifts", () => {
  assert.equal(spanMinutes({ start: "22:00", end: "06:00" }), 480);
  assert.equal(paidMinutes({ employeeId: "a", date: "2026-09-28", start: "09:30", end: "18:30", breakMinutes: 60 }), 480);
});

test("56 h week (7 × 8 h general shifts) → weekly-hours and 7-days-in-a-row signals", () => {
  const drafts = labourSignals(input(week("2026-09-28").map((date) => shift("imran", date, "09:30", "18:30", 60))), DEFAULT_SETTINGS);
  const weekly = drafts.find((draft) => draft.detector === "labour.weekly_hours")!;
  assert.equal(weekly.subjectKey, "imran:2026-09-28");
  assert.match(weekly.title, /^56 h rostered/);
  assert.equal(weekly.severity, "high"); // 8 h over
  const streak = drafts.find((draft) => draft.detector === "labour.consecutive_days")!;
  assert.match(streak.title, /^7 working days in a row/);
  assert.ok(!drafts.some((draft) => draft.detector === "labour.daily_hours"), "9 h spread-over is within limits");
});

test("clopen: close at 23:00 then open at 07:00 → only 8 h rest", () => {
  const drafts = labourSignals(input([shift("ravi", "2026-09-22", "15:00", "23:00"), shift("ravi", "2026-09-23", "07:00", "15:00"), off("ravi", "2026-09-24")]), DEFAULT_SETTINGS);
  const rest = drafts.find((draft) => draft.detector === "labour.rest")!;
  assert.match(rest.title, /Only 8 h rest/);
  assert.equal(rest.severity, "medium");
});

test("daily and spread-over limits come from the state override", () => {
  const roster = [shift("a", "2026-09-28", "08:00", "19:30", 90)]; // 10 h worked, 11.5 h spread
  const mh = labourSignals(input(roster, { states: new Map([["a", "MH"]]) }), DEFAULT_SETTINGS).find((draft) => draft.detector === "labour.daily_hours")!;
  assert.match(mh.explanation, /10\.5 h spread-over/);
  assert.equal(limitsFor(DEFAULT_SETTINGS, "KA").spreadOverHours, 12);
  const custom = validateSettings({ labour: { default: { weeklyHours: 48, dailyHours: 10, spreadOverHours: 12, minRestHours: 11, maxConsecutiveDays: 6 }, states: {} } });
  assert.equal(labourSignals(input(roster), custom).filter((draft) => draft.detector === "labour.daily_hours").length, 0);
});

test("approved leave breaks a working streak and removes hours", () => {
  const roster = week("2026-09-28").map((date) => shift("imran", date, "09:30", "18:30", 60));
  const drafts = labourSignals(input(roster, { leaveDays: new Map([["imran", new Set(["2026-10-01"])]]) }), DEFAULT_SETTINGS);
  assert.ok(!drafts.some((draft) => draft.detector === "labour.consecutive_days"));
  assert.ok(!drafts.some((draft) => draft.detector === "labour.weekly_hours"), "48 h is at, not above, the limit");
});

test("overtime beyond the roster without an approved regularization", () => {
  const worked = [{ employeeId: "a", date: "2026-09-28", minutes: 11 * 60, firstIn: "2026-09-28T03:30:00Z", lastOut: "2026-09-28T14:30:00Z" }];
  const roster = [shift("a", "2026-09-28", "09:00", "17:30", 30)];
  const drafts = labourSignals(input(roster, { worked }), DEFAULT_SETTINGS).filter((draft) => draft.detector === "labour.overtime_unapproved");
  assert.equal(drafts.length, 1);
  assert.match(drafts[0].title, /^3 h worked beyond the roster without approval \(week of 28 Sept?\)/);
  assert.equal(labourSignals(input(roster, { worked, regularized: new Set(["a:2026-09-28"]) }), DEFAULT_SETTINGS).filter((draft) => draft.detector === "labour.overtime_unapproved").length, 0);
});

test("minors and women-on-night-shift checks are explicitly skipped with a reason", () => {
  assert.deepEqual(LABOUR_SKIPPED.map((row) => row.key), ["labour.minors", "labour.women_night_shift"]);
  assert.match(LABOUR_SKIPPED[1].reason, /does not store gender/);
});

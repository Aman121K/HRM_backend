// npx tsx --test src/platform/risk/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTransition, fingerprint, onCleared, onDetected, stableJson } from "./signal-lifecycle";
import { DEFAULT_SETTINGS, SettingsError, mergeSettings, validateMinimumWages, validateSettings } from "./risk.settings";

test("fingerprints ignore key order but not values", () => {
  assert.equal(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] }), `{"a":[2,{"c":2,"d":1}],"b":1}`);
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
});

test("re-detection: open refreshes, dismissed stays closed until evidence changes, auto-resolved re-opens", () => {
  assert.deepEqual(onDetected(null, "x"), { kind: "insert" });
  assert.deepEqual(onDetected({ status: "ACKNOWLEDGED", fingerprint: "x", statusFingerprint: null }, "y"), { kind: "refresh" });
  assert.deepEqual(onDetected({ status: "DISMISSED", fingerprint: "x", statusFingerprint: "x" }, "x"), { kind: "suppressed" });
  const changed = onDetected({ status: "DISMISSED", fingerprint: "x", statusFingerprint: "x" }, "y");
  assert.equal(changed.kind, "reopen");
  assert.match((changed as { reason: string }).reason, /changed after it was dismissed/);
  assert.equal(onDetected({ status: "RESOLVED", fingerprint: "x", statusFingerprint: null }, "x").kind, "reopen");
});

test("clearing: auto-resolve only open signals of self-healing detectors", () => {
  assert.equal(onCleared("OPEN", true), "resolve");
  assert.equal(onCleared("ACKNOWLEDGED", false), "mark-cleared");
  assert.equal(onCleared("DISMISSED", true), "none");
});

test("manual transitions: dismiss needs a reason; resolved can't be acknowledged", () => {
  assert.equal(checkTransition("acknowledge", "OPEN", undefined), null);
  assert.match(checkTransition("dismiss", "OPEN", "ok")!, /Say why/);
  assert.equal(checkTransition("dismiss", "ACKNOWLEDGED", "Registered store kiosk phone"), null);
  assert.match(checkTransition("acknowledge", "RESOLVED", undefined)!, /can't be acknowledged/);
  assert.equal(checkTransition("reopen", "DISMISSED", undefined), null);
});

test("settings: partial documents merge onto defaults; out-of-range and unknown keys are rejected", () => {
  const merged = validateSettings({ attendance: { maxSpeedKmh: 120 }, payroll: { netChangePct: 30 } });
  assert.equal(merged.attendance.maxSpeedKmh, 120);
  assert.equal(merged.attendance.minTravelKm, DEFAULT_SETTINGS.attendance.minTravelKm);
  assert.throws(() => validateSettings({ attendance: { maxSpeedKmh: 5 } }), SettingsError);
  assert.throws(() => validateSettings({ attendance: { bogus: 1 } }), /not a known threshold/);
  assert.throws(() => validateSettings({ nope: {} }), /Unknown settings section/);
  assert.throws(() => validateSettings({ labour: { states: { Karnataka: {} } } }), /two-letter/);
  assert.deepEqual(validateSettings({ compliance: { reminderDays: [1, 5, 5] } }).compliance.reminderDays, [5, 1]);
  assert.equal(mergeSettings({ attendance: { maxSpeedKmh: "fast" } }).attendance.maxSpeedKmh, 80, "bad stored values fall back");
});

test("minimum-wage rows are validated and de-duplicated", () => {
  const rows = validateMinimumWages([{ stateCode: "ka", category: "UNSKILLED", monthlyAmount: 18000.4, effectiveFrom: "2026-10-01", isExample: false }]);
  assert.deepEqual(rows[0], { stateCode: "KA", category: "UNSKILLED", monthlyAmount: 18000, effectiveFrom: "2026-10-01", isExample: false, note: null });
  assert.throws(() => validateMinimumWages([rows[0], rows[0]]), /duplicates/);
  assert.throws(() => validateMinimumWages([{ ...rows[0], category: "EXPERT" }]), /category/);
  assert.throws(() => validateMinimumWages([{ ...rows[0], monthlyAmount: 10 }]), /between/);
});

// npx tsx --test src/platform/risk/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { crossSourceConflict, haversineKm, impossibleTravel, isRealDeviceId, outsideGeofence, rejectedSelfies, selfieBacklog, sharedDevice, spoofedGps, type Punch, type Site } from "./attendance-integrity";
import { DEFAULT_SETTINGS } from "./risk.settings";

const TZ = "Asia/Kolkata";
const S = DEFAULT_SETTINGS.attendance;
let seq = 0;
const punch = (employeeId: string, at: string, extra: Partial<Punch> = {}): Punch => ({
  id: `p${++seq}`, employeeId, at, type: "IN", source: "MOBILE", deviceId: null, lat: 12.9721, lng: 77.641, accuracy: 15, siteId: null, withinGeofence: true, reviewStatus: "NONE", ...extra,
});
const INDIRANAGAR: Site = { id: "site-ind", name: "Indiranagar", lat: 12.9719, lng: 77.6412, radius: 150 };

test("haversine: Bengaluru → Delhi is ~1,740 km", () => {
  const km = haversineKm(12.9716, 77.5946, 28.6139, 77.209);
  assert.ok(km > 1700 && km < 1780, String(km));
});

test("shared device: same phone for two people on one day; browser user agents and kiosks ignored", () => {
  assert.equal(isRealDeviceId("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"), false);
  assert.equal(isRealDeviceId("ios-7f3a9c2e-5b1d"), true);
  const drafts = sharedDevice([
    punch("ravi", "2026-09-26T03:10:00Z", { deviceId: "ios-7f3a9c2e-5b1d" }),
    punch("priya", "2026-09-26T03:14:00Z", { deviceId: "ios-7f3a9c2e-5b1d" }),
    punch("priya", "2026-09-27T03:14:00Z", { deviceId: "ios-7f3a9c2e-5b1d" }),
    punch("a", "2026-09-26T03:00:00Z", { deviceId: "Mozilla/5.0 (X11) AppleWebKit/537.36", source: "WEB" }),
    punch("b", "2026-09-26T03:01:00Z", { deviceId: "Mozilla/5.0 (X11) AppleWebKit/537.36", source: "WEB" }),
    punch("c", "2026-09-26T03:00:00Z", { deviceId: "BTK-ZK-IND01", source: "BIOMETRIC", lat: null, lng: null }),
    punch("d", "2026-09-26T03:02:00Z", { deviceId: "BTK-ZK-IND01", source: "BIOMETRIC", lat: null, lng: null }),
  ], TZ);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].severity, "high");
  assert.deepEqual(drafts[0].employeeIds, ["priya", "ravi"]);
  assert.match(drafts[0].explanation, /4 min apart/);
  assert.doesNotMatch(drafts[0].title + drafts[0].explanation, /ravi|priya/i, "no names in text");
  assert.equal(drafts[0].subjectKey, "ios-7f3a9c2e-5b1d:2026-09-26");
});

test("impossible travel: Delhi → Bengaluru in 6 minutes is flagged; a 3 km hop in 30 min is not", () => {
  const drafts = impossibleTravel([
    punch("ravi", "2026-09-26T08:55:00Z", { lat: 28.6731, lng: 77.3739, accuracy: 45 }),
    punch("ravi", "2026-09-26T09:01:00Z", { lat: 12.9721, lng: 77.641, accuracy: 5, type: "OUT" }),
    punch("asha", "2026-09-26T04:00:00Z", { lat: 12.9721, lng: 77.641 }),
    punch("asha", "2026-09-26T04:30:00Z", { lat: 12.9985, lng: 77.6525 }),
  ], S, TZ);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].employeeIds[0], "ravi");
  assert.equal(drafts[0].severity, "critical"); // > 900 km/h
  assert.match(drafts[0].explanation, /km\/h against a 80 km\/h limit/);
});

test("impossible travel respects GPS accuracy: 2.5 km apart with 1.5 km accuracy each is not a jump", () => {
  const drafts = impossibleTravel([
    punch("x", "2026-09-26T04:00:00Z", { lat: 12.97, lng: 77.64, accuracy: 1500 }),
    punch("x", "2026-09-26T04:01:00Z", { lat: 12.9925, lng: 77.64, accuracy: 1500 }),
  ], S, TZ);
  assert.equal(drafts.length, 0);
});

test("outside geofence: 3+ outside punches in 14 days", () => {
  const rows = ["2026-09-20", "2026-09-22", "2026-09-26", "2026-08-01"].map((day) => punch("ravi", `${day}T05:00:00Z`, { withinGeofence: false, reviewStatus: "PENDING" }));
  const drafts = outsideGeofence(rows, S, "2026-09-29", TZ);
  assert.equal(drafts.length, 1);
  assert.match(drafts[0].title, /^3 punches/);
  assert.equal(drafts[0].severity, "medium");
  assert.equal(outsideGeofence(rows.slice(0, 2), S, "2026-09-29", TZ).length, 0);
});

test("spoofed GPS: identical coordinates on 2+ days, matching a geofence centre", () => {
  const drafts = spoofedGps([
    punch("ravi", "2026-09-24T04:00:00Z", { lat: 12.9719, lng: 77.6412, accuracy: 150 }),
    punch("ravi", "2026-09-25T04:00:00Z", { lat: 12.9719, lng: 77.6412, accuracy: 150 }),
    punch("ravi", "2026-09-26T04:00:00Z", { lat: 12.9719, lng: 77.6412, accuracy: 150 }),
    punch("asha", "2026-09-26T04:00:00Z", { lat: 12.97201, lng: 77.64125 }),
  ], [INDIRANAGAR], S, TZ);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].severity, "high");
  assert.match(drafts[0].explanation, /centre of the Indiranagar geofence/);
  assert.match(drafts[0].explanation, /3 with accuracy worse than 100 m/);
});

test("spoofed GPS: three identical points on a single day by one person is not enough", () => {
  const rows = [1, 2, 3].map((minute) => punch("ravi", `2026-09-26T04:0${minute}:00Z`, { lat: 12.95, lng: 77.6 }));
  assert.equal(spoofedGps(rows, [INDIRANAGAR], S, TZ).length, 0);
});

test("selfie backlog and rejected-selfie repeaters", () => {
  const now = new Date("2026-09-29T10:00:00Z");
  const backlog = selfieBacklog([
    { id: "1", employeeId: "a", at: "2026-09-26T10:00:00Z" }, { id: "2", employeeId: "b", at: "2026-09-29T09:00:00Z" },
  ], S, now);
  assert.equal(backlog.length, 1);
  assert.match(backlog[0].title, /^1 selfie punch waiting over 48 h/);
  assert.deepEqual(backlog[0].employeeIds, ["a"]);
  assert.equal(selfieBacklog([{ id: "2", employeeId: "b", at: "2026-09-29T09:00:00Z" }], S, now).length, 0);
  const rejected = rejectedSelfies([{ id: "1", employeeId: "a", at: "2026-09-20T04:00:00Z", note: "Not the employee" }, { id: "2", employeeId: "a", at: "2026-09-22T04:00:00Z", note: null }], S);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].severity, "high");
});

test("biometric at one site and a phone punch 4 km away within 20 minutes", () => {
  const drafts = crossSourceConflict([
    punch("ravi", "2026-09-26T03:10:00Z", { source: "BIOMETRIC", deviceId: "BTK-ZK-IND01", lat: null, lng: null, siteId: "site-ind" }),
    punch("ravi", "2026-09-26T03:30:00Z", { lat: 12.9352, lng: 77.6245, accuracy: 20 }),
    punch("asha", "2026-09-26T03:10:00Z", { source: "BIOMETRIC", deviceId: "BTK-ZK-IND01", lat: null, lng: null, siteId: "site-ind" }),
    punch("asha", "2026-09-26T03:20:00Z", { lat: 12.972, lng: 77.6411, accuracy: 10 }),
  ], [INDIRANAGAR], S, TZ);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].employeeIds[0], "ravi");
  assert.match(drafts[0].title, /Biometric at Indiranagar and phone punch 4\.\d km away/);
});

// Attendance integrity (buddy punching / location fraud) detectors. Pure functions over punches loaded per organization.
import { dayLabel, localDate, plural, round, timeLabel, uniq, type SignalDraft } from "./risk.types";
import type { RiskSettings } from "./risk.settings";

export type Punch = {
  id: string; employeeId: string; at: string; type: "IN" | "OUT"; source: "WEB" | "MOBILE" | "BIOMETRIC" | "MANUAL";
  deviceId: string | null; lat: number | null; lng: number | null; accuracy: number | null;
  siteId: string | null; withinGeofence: boolean | null; reviewStatus: string;
};
export type Site = { id: string; name: string; lat: number; lng: number; radius: number };
type Settings = RiskSettings["attendance"];

/** Great-circle distance in km. */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Browser user-agent strings are not device identifiers (thousands of phones share one), so they are never compared. */
export const isRealDeviceId = (value: string | null): value is string =>
  !!value && value.length >= 6 && value.length <= 200 && !/mozilla\/|applewebkit|dalvik\/|okhttp|gecko\//i.test(value);
const maskDevice = (value: string) => `…${value.slice(-6)}`;
const located = (punch: Punch): punch is Punch & { lat: number; lng: number } => punch.lat !== null && punch.lng !== null;
const gps = (punch: Punch) => (punch.source === "MOBILE" || punch.source === "WEB") && located(punch);
const minutesApart = (a: string, b: string) => Math.abs(Date.parse(b) - Date.parse(a)) / 60000;
const personRef = (id: string) => ({ label: "Review attendance", href: `/attendance?employee=${id}` });

/** 1. The same (real) phone/device recorded punches for two or more people on the same day. */
export function sharedDevice(punches: Punch[], timeZone: string): SignalDraft[] {
  const groups = new Map<string, Punch[]>();
  for (const punch of punches) {
    if (punch.source === "BIOMETRIC" || punch.source === "MANUAL" || !isRealDeviceId(punch.deviceId)) continue;
    const key = `${punch.deviceId}|${localDate(punch.at, timeZone)}`;
    (groups.get(key) || groups.set(key, []).get(key)!).push(punch);
  }
  const drafts: SignalDraft[] = [];
  for (const [key, rows] of groups) {
    const people = uniq(rows.map((row) => row.employeeId)).sort();
    if (people.length < 2) continue;
    const [device, date] = key.split("|");
    rows.sort((a, b) => a.at.localeCompare(b.at));
    // Closest gap between punches of different people — minutes apart makes a shared-phone story implausible.
    let closest = Infinity;
    for (let i = 1; i < rows.length; i += 1) if (rows[i].employeeId !== rows[i - 1].employeeId) closest = Math.min(closest, minutesApart(rows[i - 1].at, rows[i].at));
    drafts.push({
      detector: "attendance.shared_device", area: "attendance", subjectKey: `${device}:${date}`, severity: people.length >= 3 ? "critical" : "high",
      title: `One phone punched for ${people.length} people on ${dayLabel(date)}`,
      explanation: `Device ${maskDevice(device)} recorded ${plural(rows.length, "punch", "punches")} for ${people.length} different employees on ${dayLabel(date)}${Number.isFinite(closest) ? `, the closest two only ${round(closest, 0)} min apart` : ""}. One phone punching for several people is the classic buddy-punching pattern — unless it is a registered shared store device.`,
      employeeIds: people,
      evidence: {
        facts: [{ label: "Device", value: maskDevice(device) }, { label: "Date", value: date }, { label: "Employees", value: String(people.length) }],
        columns: [{ key: "person", label: "Employee", kind: "person" }, { key: "at", label: "Time", kind: "datetime" }, { key: "type", label: "Punch" }, { key: "source", label: "Source" }, { key: "geofence", label: "Geofence" }],
        rows: rows.map((row) => ({ person: row.employeeId, at: row.at, type: row.type, source: row.source, geofence: row.withinGeofence === null ? "—" : row.withinGeofence ? "Inside" : "Outside" })),
      },
      action: { label: "Review punches", href: "/attendance" }, audiences: ["MANAGER"],
      basis: { device, date, people },
    });
  }
  return drafts;
}

/** 2. Two consecutive GPS punches by one person imply faster-than-possible travel. One signal per person per day. */
export function impossibleTravel(punches: Punch[], settings: Settings, timeZone: string): SignalDraft[] {
  const byPerson = new Map<string, Punch[]>();
  for (const punch of punches) if (gps(punch)) (byPerson.get(punch.employeeId) || byPerson.set(punch.employeeId, []).get(punch.employeeId)!).push(punch);
  const drafts: SignalDraft[] = [];
  for (const [employeeId, rows] of byPerson) {
    rows.sort((a, b) => a.at.localeCompare(b.at));
    const byDay = new Map<string, { from: Punch; to: Punch; km: number; minutes: number; speed: number }[]>();
    for (let i = 1; i < rows.length; i += 1) {
      const a = rows[i - 1], b = rows[i];
      const minutes = minutesApart(a.at, b.at);
      if (minutes > 12 * 60) continue;
      const raw = haversineKm(a.lat!, a.lng!, b.lat!, b.lng!);
      // Give the benefit of the doubt: subtract both GPS accuracy radii before judging the distance.
      const km = Math.max(0, raw - ((a.accuracy || 0) + (b.accuracy || 0)) / 1000);
      if (km < settings.minTravelKm) continue;
      const speed = km / Math.max(minutes / 60, 1 / 60);
      if (speed <= settings.maxSpeedKmh) continue;
      const day = localDate(b.at, timeZone);
      (byDay.get(day) || byDay.set(day, []).get(day)!).push({ from: a, to: b, km: raw, minutes, speed });
    }
    for (const [day, pairs] of byDay) {
      const worst = pairs.reduce((max, pair) => (pair.speed > max.speed ? pair : max));
      drafts.push({
        detector: "attendance.impossible_travel", area: "attendance", subjectKey: `${employeeId}:${day}`, severity: worst.speed > 900 || pairs.length >= 3 ? "critical" : "high",
        title: `Punches ${round(worst.km, 0)} km apart within ${Math.max(1, round(worst.minutes, 0))} min on ${dayLabel(day)}`,
        explanation: `On ${dayLabel(day)} consecutive punches were ${round(worst.km, 1)} km apart but only ${round(worst.minutes, 1)} minutes apart (${timeLabel(worst.from.at, timeZone)} → ${timeLabel(worst.to.at, timeZone)}) — an implied ${Math.round(worst.speed).toLocaleString("en-IN")} km/h against a ${settings.maxSpeedKmh} km/h limit${pairs.length > 1 ? `; ${pairs.length} such jumps that day` : ""}. This usually means a spoofed location or someone else punching with the person's login.`,
        employeeIds: [employeeId],
        evidence: {
          columns: [{ key: "from", label: "From", kind: "datetime" }, { key: "to", label: "To", kind: "datetime" }, { key: "km", label: "Distance", kind: "km" }, { key: "minutes", label: "Minutes", kind: "number" }, { key: "speed", label: "Implied km/h", kind: "number" }, { key: "accuracy", label: "GPS accuracy (m)" }],
          rows: pairs.map((pair) => ({ from: pair.from.at, to: pair.to.at, km: round(pair.km, 1), minutes: round(pair.minutes, 1), speed: Math.round(pair.speed), accuracy: `${pair.from.accuracy ?? "?"} / ${pair.to.accuracy ?? "?"}` })),
          note: `Distances already subtract both GPS accuracy radii. Threshold: ${settings.maxSpeedKmh} km/h and at least ${settings.minTravelKm} km.`,
        },
        action: personRef(employeeId), audiences: ["MANAGER"],
        basis: { employeeId, day, jumps: pairs.length, km: Math.round(worst.km / 5) * 5 },
      });
    }
  }
  return drafts;
}

/** 3. Repeated punches outside the geofence in the last N days. */
export function outsideGeofence(punches: Punch[], settings: Settings, today: string, timeZone: string): SignalDraft[] {
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - settings.outsideGeofenceDays * 86_400_000).toISOString().slice(0, 10);
  const byPerson = new Map<string, Punch[]>();
  for (const punch of punches) if (punch.withinGeofence === false && localDate(punch.at, timeZone) >= since)
    (byPerson.get(punch.employeeId) || byPerson.set(punch.employeeId, []).get(punch.employeeId)!).push(punch);
  const drafts: SignalDraft[] = [];
  for (const [employeeId, rows] of byPerson) {
    if (rows.length < settings.outsideGeofenceCount) continue;
    const days = uniq(rows.map((row) => localDate(row.at, timeZone)));
    const pending = rows.filter((row) => row.reviewStatus === "PENDING").length;
    drafts.push({
      detector: "attendance.outside_geofence", area: "attendance", subjectKey: employeeId, severity: rows.length >= settings.outsideGeofenceCount * 2 ? "high" : "medium",
      title: `${rows.length} punches outside the geofence in ${settings.outsideGeofenceDays} days`,
      explanation: `${plural(rows.length, "punch", "punches")} on ${plural(days.length, "day")} in the last ${settings.outsideGeofenceDays} days were outside every store geofence (limit ${settings.outsideGeofenceCount})${pending ? `; ${pending} still await review` : ""}. Check whether this person works off-site (deliveries, events) or is punching from home.`,
      employeeIds: [employeeId],
      evidence: {
        columns: [{ key: "at", label: "Time", kind: "datetime" }, { key: "type", label: "Punch" }, { key: "source", label: "Source" }, { key: "accuracy", label: "Accuracy (m)", kind: "number" }, { key: "review", label: "Review" }],
        rows: rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30).map((row) => ({ at: row.at, type: row.type, source: row.source, accuracy: row.accuracy, review: row.reviewStatus === "NONE" ? "—" : row.reviewStatus })),
      },
      action: personRef(employeeId), audiences: ["MANAGER"],
      basis: { employeeId, bucket: Math.floor(rows.length / settings.outsideGeofenceCount) },
    });
  }
  return drafts;
}

/**
 * 4. Spoofed GPS: real receivers jitter, so the exact same coordinates (to ~10 cm) on several days — or shared by
 * several people, or matching a geofence centre exactly — point to a mock-location app. Poor accuracy raises severity.
 */
export function spoofedGps(punches: Punch[], sites: Site[], settings: Settings, timeZone: string): SignalDraft[] {
  const groups = new Map<string, Punch[]>();
  for (const punch of punches) if (gps(punch)) {
    const key = `${punch.lat!.toFixed(6)},${punch.lng!.toFixed(6)}`;
    (groups.get(key) || groups.set(key, []).get(key)!).push(punch);
  }
  const drafts: SignalDraft[] = [];
  for (const [coordinate, rows] of groups) {
    if (rows.length < settings.identicalCoordinateCount) continue;
    const days = uniq(rows.map((row) => localDate(row.at, timeZone)));
    const people = uniq(rows.map((row) => row.employeeId)).sort();
    const [lat, lng] = coordinate.split(",").map(Number);
    const centre = sites.find((site) => site.lat.toFixed(6) === lat.toFixed(6) && site.lng.toFixed(6) === lng.toFixed(6));
    if (days.length < 2 && people.length < 2 && !centre) continue;
    const poor = rows.filter((row) => (row.accuracy || 0) >= settings.poorAccuracyMetres).length;
    const reasons = [
      days.length >= 2 ? `on ${plural(days.length, "different day")}` : null,
      people.length >= 2 ? `by ${people.length} different employees` : null,
      centre ? `exactly at the centre of the ${centre.name} geofence` : null,
      poor ? `${poor} with accuracy worse than ${settings.poorAccuracyMetres} m` : null,
    ].filter(Boolean);
    drafts.push({
      detector: "attendance.spoofed_gps", area: "attendance", subjectKey: coordinate, severity: poor || people.length >= 2 ? "high" : "medium",
      title: `${rows.length} punches at the identical GPS point`,
      explanation: `${plural(rows.length, "punch", "punches")} reported exactly the same coordinates (${coordinate}) ${reasons.join(", ")}. A real phone's GPS never repeats to the centimetre — this pattern is typical of mock-location apps.`,
      employeeIds: people,
      evidence: {
        facts: [{ label: "Coordinates", value: coordinate }, { label: "Days", value: String(days.length) }, { label: "Employees", value: String(people.length) }, ...(centre ? [{ label: "Matches geofence centre", value: centre.name }] : [])],
        columns: [{ key: "person", label: "Employee", kind: "person" }, { key: "at", label: "Time", kind: "datetime" }, { key: "type", label: "Punch" }, { key: "source", label: "Source" }, { key: "accuracy", label: "Accuracy (m)", kind: "number" }],
        rows: rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30).map((row) => ({ person: row.employeeId, at: row.at, type: row.type, source: row.source, accuracy: row.accuracy })),
        note: "If this is a fixed kiosk phone at the store, register it as a shared device or switch that store to biometric punching, then dismiss with that reason.",
      },
      action: { label: "Review punches", href: "/attendance" }, audiences: ["MANAGER"],
      basis: { coordinate, people, days: Math.min(days.length, 10) },
    });
  }
  return drafts;
}

/** 5a. Selfie punches waiting for review longer than the backlog limit (one signal for the organization). */
export function selfieBacklog(pending: { id: string; employeeId: string; at: string }[], settings: Settings, now: Date): SignalDraft[] {
  const cutoff = now.getTime() - settings.selfieBacklogHours * 3_600_000;
  const stale = pending.filter((row) => Date.parse(row.at) < cutoff).sort((a, b) => a.at.localeCompare(b.at));
  if (!stale.length) return [];
  const oldestDays = round((now.getTime() - Date.parse(stale[0].at)) / 86_400_000, 1);
  return [{
    detector: "attendance.selfie_backlog", area: "attendance", subjectKey: "backlog", severity: stale.length >= 10 || oldestDays >= 7 ? "high" : "medium",
    title: `${plural(stale.length, "selfie punch", "selfie punches")} waiting over ${settings.selfieBacklogHours} h for review`,
    explanation: `${plural(stale.length, "punch", "punches")} flagged for selfie review have waited more than ${settings.selfieBacklogHours} hours; the oldest is ${oldestDays} days old. Unreviewed punches flow into payroll as-is, so a backlog defeats the point of selfie checks.`,
    employeeIds: uniq(stale.map((row) => row.employeeId)),
    evidence: { columns: [{ key: "person", label: "Employee", kind: "person" }, { key: "at", label: "Punched", kind: "datetime" }], rows: stale.slice(0, 40).map((row) => ({ person: row.employeeId, at: row.at })) },
    action: { label: "Open review queue", href: "/attendance" }, audiences: ["MANAGER"],
    basis: { bucket: stale.length >= 10 ? "10+" : stale.length >= 5 ? "5+" : "1+" },
  }];
}

/** 5b. People whose selfie punches were rejected repeatedly. */
export function rejectedSelfies(rejected: { id: string; employeeId: string; at: string; note: string | null }[], settings: Settings): SignalDraft[] {
  const byPerson = new Map<string, typeof rejected>();
  for (const row of rejected) (byPerson.get(row.employeeId) || byPerson.set(row.employeeId, []).get(row.employeeId)!).push(row);
  const drafts: SignalDraft[] = [];
  for (const [employeeId, rows] of byPerson) {
    if (rows.length < settings.rejectedSelfieCount) continue;
    drafts.push({
      detector: "attendance.rejected_selfies", area: "attendance", subjectKey: employeeId, severity: rows.length >= settings.rejectedSelfieCount * 2 ? "critical" : "high",
      title: `${rows.length} selfie punches rejected in ${settings.lookbackDays} days`,
      explanation: `Reviewers rejected ${plural(rows.length, "selfie punch", "selfie punches")} from this person in the last ${settings.lookbackDays} days (limit ${settings.rejectedSelfieCount}). Repeated rejections usually mean someone else is punching, or a photo of a photo.`,
      employeeIds: [employeeId],
      evidence: { columns: [{ key: "at", label: "Punched", kind: "datetime" }, { key: "note", label: "Reviewer note" }], rows: rows.map((row) => ({ at: row.at, note: row.note || "—" })) },
      action: personRef(employeeId), audiences: ["MANAGER"],
      basis: { employeeId, count: rows.length },
    });
  }
  return drafts;
}

/** 6. A biometric punch at one site and a phone punch somewhere else within minutes. */
export function crossSourceConflict(punches: Punch[], sites: Site[], settings: Settings, timeZone: string): SignalDraft[] {
  const siteById = new Map(sites.map((site) => [site.id, site]));
  const byPerson = new Map<string, Punch[]>();
  for (const punch of punches) (byPerson.get(punch.employeeId) || byPerson.set(punch.employeeId, []).get(punch.employeeId)!).push(punch);
  const drafts: SignalDraft[] = [];
  for (const [employeeId, rows] of byPerson) {
    const biometric = rows.filter((row) => row.source === "BIOMETRIC" && row.siteId && siteById.has(row.siteId));
    const phone = rows.filter(gps);
    const conflicts: { bio: Punch; other: Punch; km: number; minutes: number; site: Site }[] = [];
    for (const bio of biometric) for (const other of phone) {
      const minutes = minutesApart(bio.at, other.at);
      if (minutes > settings.crossSourceMinutes) continue;
      const site = siteById.get(bio.siteId!)!;
      const km = haversineKm(site.lat, site.lng, other.lat!, other.lng!);
      const beyond = km * 1000 - site.radius - (other.accuracy || 0);
      if (beyond <= 1000 && (!other.siteId || other.siteId === bio.siteId)) continue;
      conflicts.push({ bio, other, km, minutes, site });
    }
    const byDay = new Map<string, typeof conflicts>();
    for (const conflict of conflicts) { const day = localDate(conflict.bio.at, timeZone); (byDay.get(day) || byDay.set(day, []).get(day)!).push(conflict); }
    for (const [day, list] of byDay) {
      const first = list[0];
      drafts.push({
        detector: "attendance.cross_source", area: "attendance", subjectKey: `${employeeId}:${day}`, severity: "high",
        title: `Biometric at ${first.site.name} and phone punch ${round(first.km, 1)} km away within ${Math.max(1, round(first.minutes, 0))} min`,
        explanation: `On ${dayLabel(day)} the fingerprint/face device at ${first.site.name} recorded this person at ${timeLabel(first.bio.at, timeZone)}, and a phone punch ${round(first.km, 1)} km away came ${round(first.minutes, 0)} minutes ${Date.parse(first.other.at) >= Date.parse(first.bio.at) ? "later" : "earlier"}. Both can't be the same person — one of them was punched on their behalf.`,
        employeeIds: [employeeId],
        evidence: {
          columns: [{ key: "bio", label: "Biometric", kind: "datetime" }, { key: "site", label: "Device site" }, { key: "phone", label: "Phone punch", kind: "datetime" }, { key: "km", label: "Distance", kind: "km" }, { key: "minutes", label: "Minutes apart", kind: "number" }],
          rows: list.map((row) => ({ bio: row.bio.at, site: row.site.name, phone: row.other.at, km: round(row.km, 1), minutes: round(row.minutes, 0) })),
        },
        action: personRef(employeeId), audiences: ["MANAGER"],
        basis: { employeeId, day, count: list.length },
      });
    }
  }
  return drafts;
}

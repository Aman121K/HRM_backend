// Pure helpers for scheduling, idempotency keys and reminder policy. No I/O here, so it is unit-tested
// in scheduling.test.ts (npx tsx --test src/platform/jobs/scheduling.test.ts).
import type { CaseModule } from "../cases/case-modules";

export const QUEUE_NAME = "northstar-platform";
export const DEFAULT_TIMEZONE = "Asia/Kolkata";

// ---- time in a tenant's timezone ------------------------------------------------------------------

export type LocalClock = { date: string; hour: number; minute: number; isoDow: number };

/** Wall-clock date/hour in `timeZone` (falls back to IST for unknown zones). isoDow: Monday=1 … Sunday=7. */
export function localClock(now: Date, timeZone = DEFAULT_TIMEZONE): LocalClock {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(now);
  } catch {
    return localClock(now, DEFAULT_TIMEZONE);
  }
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) + 1;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24, minute: Number(get("minute")), isoDow: dow || 1 };
}

/** Adds whole days to a YYYY-MM-DD date (calendar arithmetic, timezone-free). */
export function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The Monday that starts the week after the one containing `date` (ISO weeks). */
export function nextWeekStart(date: string) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  return addDays(date, 8 - dow);
}

/**
 * Reminder jobs run hourly but only talk to people during working hours in the tenant's timezone.
 * Manual "Run now" from the console bypasses the window.
 */
export function withinSendWindow(clock: LocalClock, startHour = 8, endHour = 21) {
  return clock.hour >= startHour && clock.hour < endHour;
}

// ---- idempotency ----------------------------------------------------------------------------------

/** Stable ledger key: `job:part:part…`. Parts are trimmed so keys stay short and deterministic. */
export function dedupeKey(job: string, ...parts: (string | number | null | undefined)[]) {
  const key = [job, ...parts.map((part) => (part === null || part === undefined || part === "" ? "-" : String(part)))].join(":");
  if (key.length > 300) throw new Error(`Dedupe key too long for ${job}`);
  return key;
}

/**
 * Escalating cadence for overdue items: remind on day 1, day 3, day 7, then weekly. Returns the stage label
 * (used in the dedupe key, so each stage fires once) or null when not overdue.
 */
export function overdueStage(daysOverdue: number): string | null {
  if (!Number.isFinite(daysOverdue) || daysOverdue < 1) return null;
  if (daysOverdue < 3) return "d1";
  if (daysOverdue < 7) return "d3";
  if (daysOverdue < 14) return "d7";
  return `w${Math.floor(daysOverdue / 7)}`;
}

// ---- helpdesk SLA ---------------------------------------------------------------------------------

/** Statuses where the SLA clock is paused (waiting on the employee) or already met (resolved). */
export const SLA_PAUSED_STATUSES = ["WAITING", "RESOLVED"];

/** Non-terminal statuses whose SLA is running, for modules that define slaHours. */
export function slaActiveStatuses(module: CaseModule) {
  if (!module.slaHours) return [];
  return module.statuses.filter((status) => !status.terminal && !SLA_PAUSED_STATUSES.includes(status.key)).map((status) => status.key);
}

export type SlaState = "OK" | "DUE_SOON" | "BREACHED";
export function slaState(dueAt: Date | string, now: Date, warnMs = 2 * 3_600_000): SlaState {
  const due = new Date(dueAt).getTime();
  if (due <= now.getTime()) return "BREACHED";
  if (due - now.getTime() <= warnMs) return "DUE_SOON";
  return "OK";
}
export const ESCALATE_PRIORITIES = ["HIGH", "URGENT"];

// ---- approvals ------------------------------------------------------------------------------------

/** For each case module, the statuses in which the approver (manager) owes a decision. */
export function approverPendingStatuses(modules: CaseModule[]) {
  const result: Record<string, string[]> = {};
  for (const module of modules) {
    const statuses = new Set<string>();
    for (const transition of module.transitions)
      if (!transition.optional && transition.by.includes("approver")) transition.from.forEach((status) => statuses.add(status));
    if (statuses.size) result[module.key] = [...statuses].sort();
  }
  return result;
}

// ---- anniversaries --------------------------------------------------------------------------------

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * Completed years if `today` is the work anniversary of `joiningDate`, else 0. Feb-29 joiners celebrate on
 * Feb 28 in non-leap years. The joining day itself (0 years) is not an anniversary.
 */
export function anniversaryYears(joiningDate: string, today: string) {
  const [jy, jm, jd] = joiningDate.slice(0, 10).split("-").map(Number);
  const [ty, tm, td] = today.slice(0, 10).split("-").map(Number);
  const years = ty - jy;
  if (years < 1) return 0;
  if (jm === tm && jd === td) return years;
  if (jm === 2 && jd === 29 && !isLeap(ty) && tm === 2 && td === 28) return years;
  return 0;
}

// ---- email delivery -------------------------------------------------------------------------------

/** Delay before retrying a failed email: 1, 2, 4, 8 … minutes, capped at 6 hours. */
export function mailRetryDelayMs(attempts: number) {
  const minutes = Math.min(2 ** Math.max(0, attempts - 1), 360);
  return minutes * 60_000;
}

// ---- console presentation -------------------------------------------------------------------------

/** Human description of a schedule, e.g. "Every 15 min" or "Daily 09:30 (Asia/Kolkata)". */
export function describeSchedule(schedule: { every?: number; cron?: string; tz?: string }) {
  if (schedule.every) {
    const s = schedule.every / 1000;
    if (s < 60) return `Every ${s} s`;
    if (s < 3600) return `Every ${Math.round(s / 60)} min`;
    if (s < 86400) return `Every ${Math.round(s / 3600)} h`;
    return `Every ${Math.round(s / 86400)} d`;
  }
  if (!schedule.cron) return "On demand";
  const parts = schedule.cron.trim().split(/\s+/);
  const tz = schedule.tz ? ` (${schedule.tz})` : "";
  if (parts.length === 5) {
    const [minute, hour, dom, month, dow] = parts;
    const time = /^\d+$/.test(minute) && /^\d+$/.test(hour) ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}` : "";
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    if (time && dom === "*" && month === "*" && dow === "*") return `Daily ${time}${tz}`;
    if (time && dom === "*" && month === "*" && /^[0-7]$/.test(dow)) return `${days[Number(dow)]}s ${time}${tz}`;
    if (time && dom === "*" && month === "*" && dow === "1-5") return `Weekdays ${time}${tz}`;
  }
  return `Cron ${schedule.cron}${tz}`;
}

/** Only keys we are willing to show in the console for a job payload (never tenant data). */
export function isOwnTenantJob(data: unknown, organizationId: string) {
  return !!data && typeof data === "object" && (data as Record<string, unknown>).organizationId === organizationId;
}
export function isTenantNeutralJob(data: unknown) {
  if (!data || typeof data !== "object") return true;
  const keys = Object.keys(data as Record<string, unknown>);
  return keys.every((key) => key === "trigger" || key === "scheduled");
}

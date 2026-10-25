// Pure date/shift arithmetic and roster rule evaluation (no database access) so the rules stay easy to reason about.

export const DAY_MS = 86_400_000;
export const ROSTER_TIME_ZONE = "Asia/Kolkata";

export type Template = {
  id: string; code: string; name: string; startTime: string; endTime: string; breakMinutes: number;
  color: string; minHeadcount: number; active: boolean; sortOrder: number; version: number;
};
export type Entry = { date: string; kind: "SHIFT" | "WEEKLY_OFF"; templateId: string | null; location: string | null; note: string | null };
export type Warning = { code: string; severity: "warning" | "danger"; message: string };
export type RuleSettings = { minRestHours: number; maxWeeklyHours: number; maxConsecutiveDays: number };

export const isoDate = (date: Date) => date.toISOString().slice(0, 10);
export const addDays = (iso: string, days: number) => isoDate(new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS));
export const dayIndex = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
/** Monday of the ISO week containing the date. */
export function mondayOf(iso: string) {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return addDays(iso, -((dow + 6) % 7));
}
export function todayLocal(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ROSTER_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function validDate(iso: string) {
  const time = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(time) && isoDate(new Date(time)) === iso && iso >= "2000-01-01" && iso <= "2100-12-31";
}
export const weekDates = (start: string) => Array.from({ length: 7 }, (_, index) => addDays(start, index));

const minutesOf = (time: string) => { const [h, m] = time.split(":").map(Number); return h * 60 + m; };
/** Gross length in minutes; an end at or before the start means the shift runs past midnight. */
export function grossMinutes(template: Pick<Template, "startTime" | "endTime">) {
  const span = (minutesOf(template.endTime) - minutesOf(template.startTime) + 1440) % 1440;
  return span || 1440;
}
export const paidMinutes = (template: Pick<Template, "startTime" | "endTime" | "breakMinutes">) =>
  Math.max(0, grossMinutes(template) - template.breakMinutes);
export const overnight = (template: Pick<Template, "startTime" | "endTime">) => minutesOf(template.endTime) <= minutesOf(template.startTime);
/** Absolute minute offsets (since epoch day 0) for a shift worked on `date`. */
export function span(template: Template, date: string) {
  const start = dayIndex(date) * 1440 + minutesOf(template.startTime);
  return { start, end: start + grossMinutes(template) };
}
export const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/**
 * Evaluates one person's week. `entries` may include up to 6 days before the week (for rest gaps and
 * consecutive-day streaks); `restDays` are dates covered by approved leave.
 */
export function evaluatePerson(week: string[], entries: Map<string, Entry>, leaveDays: Set<string>, templates: Map<string, Template>, settings: RuleSettings) {
  const cellWarnings = new Map<string, Warning[]>(week.map((date) => [date, []]));
  const rowWarnings: Warning[] = [];
  let paid = 0, shifts = 0, offs = 0;
  for (const date of week) {
    const entry = entries.get(date);
    const template = entry?.templateId ? templates.get(entry.templateId) : undefined;
    if (entry?.kind === "SHIFT" && template) { paid += paidMinutes(template); shifts += 1; }
    if (entry?.kind === "WEEKLY_OFF") offs += 1;
    if (entry && leaveDays.has(date))
      cellWarnings.get(date)!.push({ code: "LEAVE_CONFLICT", severity: "danger", message: `${entry.kind === "SHIFT" ? "Shift" : "Weekly off"} planned on a day of approved leave — clear it or reassign cover.` });
  }

  // Rest between consecutive shifts: look at the closest earlier shift (yesterday, or the day before for overnight work).
  const minRest = settings.minRestHours * 60;
  for (const date of week) {
    const entry = entries.get(date);
    const template = entry?.kind === "SHIFT" && entry.templateId ? templates.get(entry.templateId) : undefined;
    if (!template) continue;
    const current = span(template, date);
    for (const back of [1, 2]) {
      const previousDate = addDays(date, -back);
      const previous = entries.get(previousDate);
      const previousTemplate = previous?.kind === "SHIFT" && previous.templateId ? templates.get(previous.templateId) : undefined;
      if (!previousTemplate) continue;
      const gap = current.start - span(previousTemplate, previousDate).end;
      if (gap < minRest) {
        const gapHours = Math.max(0, Math.round((gap / 60) * 10) / 10);
        cellWarnings.get(date)!.push({
          code: gap < 0 ? "OVERLAP" : "REST",
          severity: gap < 0 ? "danger" : "warning",
          message: gap < 0 ? `Overlaps the ${previousTemplate.name} shift on ${dayLabel(previousDate)}.`
            : `Only ${gapHours} h rest after ${previousTemplate.name} on ${dayLabel(previousDate)} (minimum ${settings.minRestHours} h).`,
        });
      }
      break;
    }
  }

  // Consecutive working days (a weekly off is required at least once in every run of maxConsecutiveDays + 1).
  let streak = 0;
  const first = addDays(week[0], -6);
  for (let date = first; date <= week[6]; date = addDays(date, 1)) {
    const entry = entries.get(date);
    const worked = entry?.kind === "SHIFT" && !leaveDays.has(date);
    streak = worked ? streak + 1 : 0;
    if (worked && streak > settings.maxConsecutiveDays && cellWarnings.has(date))
      cellWarnings.get(date)!.push({ code: "CONSECUTIVE", severity: "warning", message: `Day ${streak} in a row without a weekly off (limit ${settings.maxConsecutiveDays}).` });
  }

  const rested = week.some((date) => entries.get(date)?.kind === "WEEKLY_OFF" || leaveDays.has(date));
  if (!rested && shifts > 0) rowWarnings.push({ code: "NO_WEEKLY_OFF", severity: "warning", message: "No weekly off planned this week." });
  if (hours(paid) > settings.maxWeeklyHours)
    rowWarnings.push({ code: "HOURS", severity: "danger", message: `${hours(paid)} h scheduled — above the ${settings.maxWeeklyHours} h weekly limit.` });
  return { cellWarnings, rowWarnings, paidMinutes: paid, shifts, offs };
}

/** Maps a shift-request category such as "Closing · 15:00–23:00" or "Weekly off" onto a template. */
export function matchCategory(category: string | null, templates: Template[]): { kind: "SHIFT" | "WEEKLY_OFF"; templateId: string | null; label: string } | null {
  if (!category) return null;
  const text = category.trim();
  if (/weekly\s*off|day\s*off|^off$/i.test(text)) return { kind: "WEEKLY_OFF", templateId: null, label: "Weekly off" };
  const [namePart, timePart] = text.split("·").map((part) => part?.trim());
  const active = templates.filter((template) => template.active);
  const byName = active.find((template) => template.name.toLowerCase() === namePart?.toLowerCase() || template.code.toLowerCase() === namePart?.toLowerCase());
  const times = /(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})/.exec(timePart || text);
  const pad = (value: string) => value.padStart(5, "0");
  const byTime = times ? active.find((template) => template.startTime === pad(times[1]) && template.endTime === pad(times[2])) : undefined;
  const template = byName || byTime;
  return template ? { kind: "SHIFT", templateId: template.id, label: `${template.name} · ${template.startTime}–${template.endTime}` } : null;
}

export const sameEntry = (a: Partial<Entry> | undefined, b: Partial<Entry> | undefined) =>
  (a?.kind || null) === (b?.kind || null) && (a?.templateId || null) === (b?.templateId || null)
  && (a?.location || null) === (b?.location || null) && (a?.note || null) === (b?.note || null);

export { dayLabel };

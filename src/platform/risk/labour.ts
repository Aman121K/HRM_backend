// Labour-law & roster risk (Shops & Establishments style working-hour limits). Pure functions, unit-tested.
// Limits are configurable per state (settings.labour) because every state's Shops & Establishments Act differs.
import { addDays, dayLabel, mondayOf, plural, round, type SignalDraft, type SkippedCheck } from "./risk.types";
import { limitsFor, type LabourLimits, type RiskSettings } from "./risk.settings";

export type Shift = { employeeId: string; date: string; start: string; end: string; breakMinutes: number };
export type RosterDay = { employeeId: string; date: string; kind: "SHIFT" | "WEEKLY_OFF"; shift?: Shift };
export type WorkedDay = { employeeId: string; date: string; minutes: number; firstIn: string; lastOut: string };
export type LabourInput = {
  roster: RosterDay[];
  worked: WorkedDay[];
  leaveDays: Map<string, Set<string>>;          // employeeId → dates on approved leave
  regularized: Set<string>;                      // `${employeeId}:${date}` with an approved regularization (treated as approved overtime)
  states: Map<string, string | null>;            // employeeId → state code
};

export const LABOUR_SKIPPED: SkippedCheck[] = [
  { key: "labour.minors", area: "labour", label: "Employment of minors / adolescents", reason: "Not checked: Northstar does not store employees' dates of birth. Add date of birth to employee records to enable this check." },
  { key: "labour.women_night_shift", area: "labour", label: "Women on night shifts (consent & safeguards)", reason: "Not checked: Northstar does not store gender, and we will not infer it from names. Track night-shift consent and transport safeguards outside this tool." },
];

const minutesOf = (time: string) => { const [h, m] = time.split(":").map(Number); return h * 60 + m; };
/** Gross span in minutes (overnight when the end is at or before the start). */
export const spanMinutes = (shift: Pick<Shift, "start" | "end">) => ((minutesOf(shift.end) - minutesOf(shift.start) + 1440) % 1440) || 1440;
export const paidMinutes = (shift: Shift) => Math.max(0, spanMinutes(shift) - shift.breakMinutes);
const absoluteStart = (shift: Shift) => Date.parse(`${shift.date}T00:00:00Z`) / 60000 + minutesOf(shift.start);
const absoluteEnd = (shift: Shift) => absoluteStart(shift) + spanMinutes(shift);
const hours = (minutes: number) => round(minutes / 60, 1);
const rosterHref = (date: string) => `/roster?start=${mondayOf(date)}`;

function byEmployee<T extends { employeeId: string }>(rows: T[]) {
  const map = new Map<string, T[]>();
  for (const row of rows) (map.get(row.employeeId) || map.set(row.employeeId, []).get(row.employeeId)!).push(row);
  return map;
}

export function labourSignals(input: LabourInput, settings: RiskSettings): SignalDraft[] {
  const drafts: SignalDraft[] = [];
  const rosterBy = byEmployee(input.roster);
  for (const [employeeId, days] of rosterBy) {
    const state = input.states.get(employeeId) || null;
    const limits = limitsFor(settings, state);
    const leave = input.leaveDays.get(employeeId) || new Set<string>();
    const shifts = days.filter((day) => day.kind === "SHIFT" && day.shift && !leave.has(day.date)).map((day) => day.shift!).sort((a, b) => a.date.localeCompare(b.date));
    drafts.push(...weeklyHours(employeeId, shifts, limits, state), ...dailyLimits(employeeId, shifts, limits, state), ...restGaps(employeeId, shifts, limits, state),
      ...consecutiveDays(employeeId, days, leave, limits, state));
  }
  drafts.push(...overtime(input, settings));
  return drafts;
}

const stateNote = (state: string | null, limits: LabourLimits) =>
  `Limits used${state ? ` for ${state}` : ""}: ${limits.weeklyHours} h/week, ${limits.dailyHours} h/day, ${limits.spreadOverHours} h spread-over, ${limits.minRestHours} h rest, ${limits.maxConsecutiveDays} days in a row. They vary by state and establishment — confirm them in Risk settings.`;

function weeklyHours(employeeId: string, shifts: Shift[], limits: LabourLimits, state: string | null): SignalDraft[] {
  const weeks = new Map<string, Shift[]>();
  for (const shift of shifts) { const week = mondayOf(shift.date); (weeks.get(week) || weeks.set(week, []).get(week)!).push(shift); }
  const drafts: SignalDraft[] = [];
  for (const [week, list] of weeks) {
    const total = list.reduce((sum, shift) => sum + paidMinutes(shift), 0);
    if (total / 60 <= limits.weeklyHours) continue;
    const over = hours(total - limits.weeklyHours * 60);
    drafts.push({
      detector: "labour.weekly_hours", area: "labour", subjectKey: `${employeeId}:${week}`, severity: over >= 8 ? "high" : "medium",
      title: `${hours(total)} h rostered in the week of ${dayLabel(week)}`,
      explanation: `The roster for the week of ${dayLabel(week)} has ${hours(total)} paid hours across ${plural(list.length, "shift")} — ${over} h over the ${limits.weeklyHours} h weekly limit. Hours beyond the limit are overtime (usually at twice the ordinary rate) and need to be approved and recorded in the overtime register.`,
      employeeIds: [employeeId],
      evidence: {
        columns: [{ key: "date", label: "Date", kind: "date" }, { key: "shift", label: "Shift" }, { key: "paid", label: "Paid hours", kind: "hours" }],
        rows: list.map((shift) => ({ date: shift.date, shift: `${shift.start}–${shift.end} (${shift.breakMinutes} min break)`, paid: hours(paidMinutes(shift)) })),
        note: stateNote(state, limits),
      },
      action: { label: "Open roster", href: rosterHref(week) }, audiences: ["MANAGER"],
      basis: { employeeId, week, hours: Math.round(total / 60) },
    });
  }
  return drafts;
}

function dailyLimits(employeeId: string, shifts: Shift[], limits: LabourLimits, state: string | null): SignalDraft[] {
  const weeks = new Map<string, { shift: Shift; paid: number; spread: number }[]>();
  for (const shift of shifts) {
    const paid = paidMinutes(shift), spread = spanMinutes(shift);
    if (paid / 60 <= limits.dailyHours && spread / 60 <= limits.spreadOverHours) continue;
    const week = mondayOf(shift.date);
    (weeks.get(week) || weeks.set(week, []).get(week)!).push({ shift, paid, spread });
  }
  return [...weeks].map(([week, list]) => ({
    detector: "labour.daily_hours", area: "labour" as const, subjectKey: `${employeeId}:${week}`, severity: list.length >= 3 ? "high" as const : "medium" as const,
    title: `${plural(list.length, "shift")} over the daily or spread-over limit (week of ${dayLabel(week)})`,
    explanation: `${plural(list.length, "shift")} in the week of ${dayLabel(week)} exceed ${limits.dailyHours} h of work or a ${limits.spreadOverHours} h spread-over (start to finish including breaks). The longest is ${hours(Math.max(...list.map((row) => row.paid)))} h worked over ${hours(Math.max(...list.map((row) => row.spread)))} h.`,
    employeeIds: [employeeId],
    evidence: {
      columns: [{ key: "date", label: "Date", kind: "date" }, { key: "shift", label: "Shift" }, { key: "paid", label: "Worked", kind: "hours" }, { key: "spread", label: "Spread-over", kind: "hours" }],
      rows: list.map((row) => ({ date: row.shift.date, shift: `${row.shift.start}–${row.shift.end}`, paid: hours(row.paid), spread: hours(row.spread) })),
      note: stateNote(state, limits),
    },
    action: { label: "Open roster", href: rosterHref(week) }, audiences: ["MANAGER" as const],
    basis: { employeeId, week, dates: list.map((row) => row.shift.date) },
  }));
}

function restGaps(employeeId: string, shifts: Shift[], limits: LabourLimits, state: string | null): SignalDraft[] {
  const weeks = new Map<string, { previous: Shift; next: Shift; gap: number }[]>();
  for (let i = 1; i < shifts.length; i += 1) {
    const previous = shifts[i - 1], next = shifts[i];
    const gap = absoluteStart(next) - absoluteEnd(previous);
    if (gap >= limits.minRestHours * 60 || gap > 48 * 60) continue;
    const week = mondayOf(next.date);
    (weeks.get(week) || weeks.set(week, []).get(week)!).push({ previous, next, gap });
  }
  return [...weeks].map(([week, list]) => {
    const shortest = Math.min(...list.map((row) => row.gap));
    return {
      detector: "labour.rest", area: "labour" as const, subjectKey: `${employeeId}:${week}`, severity: shortest < 8 * 60 ? "high" as const : "medium" as const,
      title: `Only ${hours(Math.max(0, shortest))} h rest between shifts (week of ${dayLabel(week)})`,
      explanation: `${plural(list.length, "turnaround")} in the week of ${dayLabel(week)} leave less than ${limits.minRestHours} h between the end of one shift and the start of the next — the shortest is ${hours(Math.max(0, shortest))} h. Close-then-open ("clopen") patterns are a fatigue and compliance risk.`,
      employeeIds: [employeeId],
      evidence: {
        columns: [{ key: "ended", label: "Shift ended" }, { key: "started", label: "Next started" }, { key: "gap", label: "Rest", kind: "hours" }],
        rows: list.map((row) => ({ ended: `${dayLabel(row.previous.date)} ${row.previous.end}`, started: `${dayLabel(row.next.date)} ${row.next.start}`, gap: hours(Math.max(0, row.gap)) })),
        note: stateNote(state, limits),
      },
      action: { label: "Open roster", href: rosterHref(week) }, audiences: ["MANAGER" as const],
      basis: { employeeId, week, gaps: list.map((row) => `${row.previous.date}>${row.next.date}`) },
    };
  });
}

function consecutiveDays(employeeId: string, days: RosterDay[], leave: Set<string>, limits: LabourLimits, state: string | null): SignalDraft[] {
  const worked = new Set(days.filter((day) => day.kind === "SHIFT" && !leave.has(day.date)).map((day) => day.date));
  const dates = [...worked].sort();
  const drafts: SignalDraft[] = [];
  let runStart: string | null = null, previous: string | null = null, length = 0;
  const flush = () => {
    if (runStart && length > limits.maxConsecutiveDays)
      drafts.push({
        detector: "labour.consecutive_days", area: "labour", subjectKey: `${employeeId}:${runStart}`, severity: length >= limits.maxConsecutiveDays + 3 ? "critical" : "high",
        title: `${length} working days in a row without a weekly off`,
        explanation: `The roster has ${length} consecutive working days from ${dayLabel(runStart)} to ${dayLabel(previous!)} with no weekly off or leave (limit ${limits.maxConsecutiveDays}). Shops & Establishments laws require at least one full day of rest in every seven.`,
        employeeIds: [employeeId],
        evidence: { facts: [{ label: "From", value: runStart }, { label: "To", value: previous! }, { label: "Days in a row", value: String(length) }], note: stateNote(state, limits) },
        action: { label: "Open roster", href: rosterHref(runStart) }, audiences: ["MANAGER"],
        basis: { employeeId, runStart, length },
      });
  };
  for (const date of dates) {
    if (previous && addDays(previous, 1) === date) length += 1;
    else { flush(); runStart = date; length = 1; }
    previous = date;
  }
  flush();
  return drafts;
}

/** Actual attendance longer than the rostered shift (or the daily limit when nothing was rostered) without an approved regularization. */
function overtime(input: LabourInput, settings: RiskSettings): SignalDraft[] {
  const planned = new Map<string, number>();
  for (const day of input.roster) if (day.kind === "SHIFT" && day.shift) planned.set(`${day.employeeId}:${day.date}`, paidMinutes(day.shift));
  const byPerson = new Map<string, { day: WorkedDay; plannedMinutes: number | null; extra: number }[]>();
  for (const day of input.worked) {
    const key = `${day.employeeId}:${day.date}`;
    if (input.regularized.has(key)) continue;
    const limits = limitsFor(settings, input.states.get(day.employeeId) || null);
    const plan = planned.get(key) ?? null;
    const allowed = (plan ?? limits.dailyHours * 60) + settings.labour.overtimeGraceMinutes;
    if (day.minutes <= allowed) continue;
    const group = `${day.employeeId}|${mondayOf(day.date)}`;
    (byPerson.get(group) || byPerson.set(group, []).get(group)!).push({ day, plannedMinutes: plan, extra: day.minutes - (plan ?? limits.dailyHours * 60) });
  }
  const drafts: SignalDraft[] = [];
  for (const [group, list] of byPerson) {
    const [employeeId, week] = group.split("|");
    const total = list.reduce((sum, row) => sum + row.extra, 0);
    drafts.push({
      detector: "labour.overtime_unapproved", area: "labour", subjectKey: `${employeeId}:${week}`, severity: total >= 8 * 60 ? "high" : "medium",
      title: `${hours(total)} h worked beyond the roster without approval (week of ${dayLabel(week)})`,
      explanation: `On ${plural(list.length, "day")} the punches show more time at work than rostered (by ${hours(total)} h in total, grace ${settings.labour.overtimeGraceMinutes} min), and no approved regularization or overtime approval exists. Unapproved overtime is still payable — approve and pay it, or correct the punches.`,
      employeeIds: [employeeId],
      evidence: {
        columns: [{ key: "date", label: "Date", kind: "date" }, { key: "in", label: "First in", kind: "datetime" }, { key: "out", label: "Last out", kind: "datetime" }, { key: "worked", label: "Worked", kind: "hours" }, { key: "planned", label: "Rostered", kind: "hours" }],
        rows: list.map((row) => ({ date: row.day.date, in: row.day.firstIn, out: row.day.lastOut, worked: hours(row.day.minutes), planned: row.plannedMinutes === null ? null : hours(row.plannedMinutes) })),
        note: "Northstar has no separate overtime approval yet; an approved attendance regularization for the day counts as approval.",
      },
      action: { label: "Review attendance", href: `/attendance?employee=${employeeId}` }, audiences: ["MANAGER"],
      basis: { employeeId, dates: list.map((row) => row.day.date).sort(), hours: Math.round(total / 60) },
    });
  }
  return drafts;
}

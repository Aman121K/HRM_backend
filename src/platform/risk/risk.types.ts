// Shared types for the Risk & Compliance Center. Detectors are pure functions: (loaded data, settings, clock) → SignalDraft[].
// Rule for every detector: titles and explanations never contain people's names — only numbers, dates and places — so the
// same signal can be shown to a manager with colleagues outside their team redacted. People are listed in employeeIds and
// evidence cells of kind "person" (employee ids), which the service resolves (or redacts) at read time.

export const AREAS = ["compliance", "attendance", "labour", "payroll", "expenses", "people", "service"] as const;
export type Area = (typeof AREAS)[number];
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED", "DISMISSED"] as const;
export type SignalStatus = (typeof STATUSES)[number];
/** Who besides HR_ADMIN/OWNER may see a signal. MANAGER = the direct manager of an affected employee. */
export type Audience = "PAYROLL" | "MANAGER";

export type CellKind = "text" | "person" | "money" | "date" | "datetime" | "number" | "km" | "hours" | "percent";
export type EvidenceColumn = { key: string; label: string; kind?: CellKind };
export type Evidence = {
  facts?: { label: string; value: string }[];
  columns?: EvidenceColumn[];
  rows?: Record<string, string | number | boolean | null>[];
  note?: string;
};

export type SignalDraft = {
  detector: string;
  area: Area;
  /** Stable identity of the problem (e.g. "device:abc:2026-09-26"); one signal row per detector + subjectKey. */
  subjectKey: string;
  severity: Severity;
  title: string;
  explanation: string;
  employeeIds: string[];
  evidence: Evidence;
  action: { label: string; href: string };
  audiences: Audience[];
  /** Only the facts that matter; hashed into the fingerprint. A dismissed/resolved signal re-opens only when it changes. */
  basis: unknown;
  /** Affected records (claims, runs, tickets…) for deep links and audit. */
  records?: { type: string; id: string; label: string }[];
  dueDate?: string | null;
};

export type DetectorMeta = {
  key: string; area: Area; label: string; description: string;
  /** When the condition disappears on a later scan, OPEN/ACKNOWLEDGED signals are resolved automatically. */
  autoResolve: boolean;
};

/** A check we deliberately do not run, shown in the UI so nobody assumes it is covered. */
export type SkippedCheck = { key: string; area: Area; label: string; reason: string };

export const round = (value: number, digits = 1) => { const f = 10 ** digits; return Math.round(value * f) / f; };
export const inr = (value: number) => `₹${Math.round(value).toLocaleString("en-IN")}`;
export const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
export const uniq = <T>(values: T[]) => [...new Set(values)];

const DAY_MS = 86_400_000;
export const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
/** Calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(value: string | Date, timeZone = "Asia/Kolkata") {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}
/** "26 Sep" style label for a YYYY-MM-DD date. */
export function dayLabel(iso: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
}
export function timeLabel(value: string | Date, timeZone = "Asia/Kolkata") {
  return new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(new Date(value));
}
export const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = Sunday
export function mondayOf(iso: string) { return addDays(iso, -((weekday(iso) + 6) % 7)); }
export function monthLabel(period: string) {
  const [y, m] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

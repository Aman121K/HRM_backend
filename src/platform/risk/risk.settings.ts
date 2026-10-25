// Detector thresholds (per organization) and the minimum-wage table. Pure: defaults, merge and validation.

export type LabourLimits = { weeklyHours: number; dailyHours: number; spreadOverHours: number; minRestHours: number; maxConsecutiveDays: number };

export type RiskSettings = {
  compliance: { horizonDays: number; lookbackDays: number; reminderDays: number[]; gratuityWindowDays: number };
  attendance: {
    lookbackDays: number; maxSpeedKmh: number; minTravelKm: number; outsideGeofenceCount: number; outsideGeofenceDays: number;
    identicalCoordinateCount: number; poorAccuracyMetres: number; selfieBacklogHours: number; rejectedSelfieCount: number; crossSourceMinutes: number;
  };
  labour: { lookbackDays: number; overtimeGraceMinutes: number; default: LabourLimits; states: Record<string, Partial<LabourLimits>> };
  payroll: { netChangePct: number; minimumWageCategory: string };
  expenses: { lookbackDays: number; roundAmountStep: number; roundClaimCount: number; splitWindowDays: number; lateReceiptDays: number };
  people: { newJoinerDays: number; rejectedRequests: number; attendanceDropPct: number; encashmentDivisor: number; liabilityAlertAmount: number };
  service: { slaBreachCount: number; slaWindowDays: number; approvalStuckDays: number };
  /** Detector keys switched off for this organization. */
  disabled: string[];
};

export const DEFAULT_SETTINGS: RiskSettings = {
  compliance: { horizonDays: 45, lookbackDays: 75, reminderDays: [5, 1], gratuityWindowDays: 90 },
  attendance: {
    lookbackDays: 30, maxSpeedKmh: 80, minTravelKm: 2, outsideGeofenceCount: 3, outsideGeofenceDays: 14,
    identicalCoordinateCount: 3, poorAccuracyMetres: 100, selfieBacklogHours: 48, rejectedSelfieCount: 2, crossSourceMinutes: 30,
  },
  // Shops & Establishments style limits. They differ by state and by establishment type — the defaults are a common
  // baseline (48 h/week, 9 h/day, 10.5 h spread-over, 11 h rest, 6 days in a row), not legal advice.
  labour: {
    lookbackDays: 21, overtimeGraceMinutes: 30,
    default: { weeklyHours: 48, dailyHours: 9, spreadOverHours: 10.5, minRestHours: 11, maxConsecutiveDays: 6 },
    states: { KA: { spreadOverHours: 12 }, MH: { spreadOverHours: 10.5 } },
  },
  payroll: { netChangePct: 20, minimumWageCategory: "UNSKILLED" },
  expenses: { lookbackDays: 90, roundAmountStep: 500, roundClaimCount: 3, splitWindowDays: 1, lateReceiptDays: 60 },
  people: { newJoinerDays: 90, rejectedRequests: 2, attendanceDropPct: 40, encashmentDivisor: 26, liabilityAlertAmount: 100000 },
  service: { slaBreachCount: 2, slaWindowDays: 30, approvalStuckDays: 3 },
  disabled: [],
};

/** [min, max] for every numeric threshold; anything else in a PUT is rejected. */
const RANGES: Record<string, Record<string, [number, number]>> = {
  compliance: { horizonDays: [7, 120], lookbackDays: [15, 400], gratuityWindowDays: [7, 365] },
  attendance: {
    lookbackDays: [3, 120], maxSpeedKmh: [20, 1000], minTravelKm: [0.5, 100], outsideGeofenceCount: [2, 50], outsideGeofenceDays: [3, 60],
    identicalCoordinateCount: [2, 50], poorAccuracyMetres: [20, 5000], selfieBacklogHours: [4, 336], rejectedSelfieCount: [1, 20], crossSourceMinutes: [5, 240],
  },
  labour: { lookbackDays: [7, 60], overtimeGraceMinutes: [0, 240] },
  payroll: { netChangePct: [5, 200] },
  expenses: { lookbackDays: [14, 365], roundAmountStep: [50, 10000], roundClaimCount: [2, 30], splitWindowDays: [0, 7], lateReceiptDays: [15, 365] },
  people: { newJoinerDays: [30, 365], rejectedRequests: [1, 20], attendanceDropPct: [10, 100], encashmentDivisor: [26, 31], liabilityAlertAmount: [1000, 100000000] },
  service: { slaBreachCount: [2, 50], slaWindowDays: [7, 180], approvalStuckDays: [1, 30] },
};
const LABOUR_RANGES: Record<keyof LabourLimits, [number, number]> = {
  weeklyHours: [30, 72], dailyHours: [6, 14], spreadOverHours: [8, 16], minRestHours: [6, 16], maxConsecutiveDays: [3, 13],
};
export const MIN_WAGE_CATEGORIES = ["UNSKILLED", "SEMI_SKILLED", "SKILLED", "HIGHLY_SKILLED"] as const;

export class SettingsError extends Error {}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }

function checkNumber(path: string, value: unknown, [min, max]: [number, number]) {
  const n = Number(value);
  if (typeof value === "boolean" || value === null || value === "" || !Number.isFinite(n)) throw new SettingsError(`${path} must be a number.`);
  if (n < min || n > max) throw new SettingsError(`${path} must be between ${min} and ${max}.`);
  return n;
}

function checkLimits(path: string, input: unknown, partial: boolean): Partial<LabourLimits> {
  if (!input || typeof input !== "object") throw new SettingsError(`${path} must be an object.`);
  const out: Partial<LabourLimits> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(key in LABOUR_RANGES)) throw new SettingsError(`${path}.${key} is not a known limit.`);
    if (value === null || value === undefined) continue;
    out[key as keyof LabourLimits] = checkNumber(`${path}.${key}`, value, LABOUR_RANGES[key as keyof LabourLimits]);
  }
  if (!partial) for (const key of Object.keys(LABOUR_RANGES)) if (!(key in out)) throw new SettingsError(`${path}.${key} is required.`);
  return out;
}

/** Stored JSON (possibly from an older version) → complete settings. Unknown keys are dropped; bad values fall back. */
export function mergeSettings(stored: unknown): RiskSettings {
  const result = clone(DEFAULT_SETTINGS);
  if (!stored || typeof stored !== "object") return result;
  try { return validateSettings(stored, true); } catch { /* fall through to a lenient merge */ }
  const source = stored as Record<string, Record<string, unknown>>;
  for (const [section, ranges] of Object.entries(RANGES))
    for (const [key, range] of Object.entries(ranges)) {
      const value = source[section]?.[key];
      if (value === undefined) continue;
      try { (result as any)[section][key] = checkNumber(key, value, range); } catch { /* keep default */ }
    }
  return result;
}

/**
 * Validates a settings document (full or partial) and returns the complete merged settings. `lenient` accepts a
 * partial document (missing sections keep their defaults).
 */
export function validateSettings(input: unknown, lenient = true): RiskSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SettingsError("Settings must be an object.");
  const result = clone(DEFAULT_SETTINGS);
  const source = input as Record<string, unknown>;
  for (const key of Object.keys(source)) if (!(key in DEFAULT_SETTINGS)) throw new SettingsError(`Unknown settings section "${key}".`);
  for (const [section, ranges] of Object.entries(RANGES)) {
    const value = source[section];
    if (value === undefined) { if (!lenient) throw new SettingsError(`${section} is required.`); continue; }
    if (!value || typeof value !== "object") throw new SettingsError(`${section} must be an object.`);
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (section === "compliance" && key === "reminderDays") {
        if (!Array.isArray(raw) || raw.length < 1 || raw.length > 5) throw new SettingsError("compliance.reminderDays must list 1–5 day counts.");
        result.compliance.reminderDays = [...new Set(raw.map((day) => checkNumber("compliance.reminderDays", day, [0, 30])))].sort((a, b) => b - a);
        continue;
      }
      if (section === "labour" && key === "default") { result.labour.default = checkLimits("labour.default", raw, false) as LabourLimits; continue; }
      if (section === "labour" && key === "states") {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SettingsError("labour.states must be an object keyed by state code.");
        result.labour.states = {};
        for (const [state, limits] of Object.entries(raw as Record<string, unknown>)) {
          if (!/^[A-Z]{2}$/.test(state)) throw new SettingsError(`labour.states: "${state}" is not a two-letter state code.`);
          result.labour.states[state] = checkLimits(`labour.states.${state}`, limits, true);
        }
        continue;
      }
      if (section === "payroll" && key === "minimumWageCategory") {
        if (!MIN_WAGE_CATEGORIES.includes(raw as never)) throw new SettingsError(`payroll.minimumWageCategory must be one of ${MIN_WAGE_CATEGORIES.join(", ")}.`);
        result.payroll.minimumWageCategory = raw as string;
        continue;
      }
      const range = ranges[key];
      if (!range) throw new SettingsError(`${section}.${key} is not a known threshold.`);
      (result as any)[section][key] = checkNumber(`${section}.${key}`, raw, range);
    }
  }
  if (source.disabled !== undefined) {
    if (!Array.isArray(source.disabled) || source.disabled.some((key) => typeof key !== "string" || key.length > 80)) throw new SettingsError("disabled must be a list of detector keys.");
    result.disabled = [...new Set(source.disabled as string[])];
  }
  return result;
}

/** Effective labour limits for a state: default overlaid with the state's overrides. */
export function limitsFor(settings: RiskSettings, state: string | null | undefined): LabourLimits {
  return { ...settings.labour.default, ...(state ? settings.labour.states[state] || {} : {}) };
}

export type MinimumWage = { stateCode: string; category: string; monthlyAmount: number; effectiveFrom: string; isExample: boolean; note: string | null };

/**
 * EXAMPLE minimum wages — deliberately NOT presented as current law. Minimum wages are notified per state, per scheduled
 * employment, per skill category and often per zone, and are revised (with variable DA) every six months. Replace these
 * with the notification that applies to each establishment before relying on the check.
 */
export const EXAMPLE_MINIMUM_WAGES: MinimumWage[] = [
  { stateCode: "KA", category: "UNSKILLED", monthlyAmount: 17000, effectiveFrom: "2026-04-01", isExample: true, note: "EXAMPLE value — replace with the Karnataka notification for shops & commercial establishments (zone-wise)." },
  { stateCode: "KA", category: "SKILLED", monthlyAmount: 19500, effectiveFrom: "2026-04-01", isExample: true, note: "EXAMPLE value — verify." },
  { stateCode: "MH", category: "UNSKILLED", monthlyAmount: 16500, effectiveFrom: "2026-04-01", isExample: true, note: "EXAMPLE value — replace with the Maharashtra notification (zone I/II/III, basic + special allowance)." },
  { stateCode: "MH", category: "SKILLED", monthlyAmount: 19000, effectiveFrom: "2026-04-01", isExample: true, note: "EXAMPLE value — verify." },
  { stateCode: "DL", category: "UNSKILLED", monthlyAmount: 18000, effectiveFrom: "2026-04-01", isExample: true, note: "EXAMPLE value — verify against the current Delhi order." },
  { stateCode: "TN", category: "UNSKILLED", monthlyAmount: 15000, effectiveFrom: "2026-04-01", isExample: true, note: "EXAMPLE value — verify." },
];

export function validateMinimumWages(input: unknown): MinimumWage[] {
  if (!Array.isArray(input)) throw new SettingsError("minimumWages must be a list.");
  if (input.length > 200) throw new SettingsError("At most 200 minimum-wage rows.");
  const seen = new Set<string>();
  return input.map((raw, index) => {
    const row = raw as Record<string, unknown>;
    const at = `minimumWages[${index}]`;
    const stateCode = String(row?.stateCode || "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(stateCode)) throw new SettingsError(`${at}.stateCode must be a two-letter state code.`);
    const category = String(row.category || "");
    if (!MIN_WAGE_CATEGORIES.includes(category as never)) throw new SettingsError(`${at}.category must be one of ${MIN_WAGE_CATEGORIES.join(", ")}.`);
    const monthlyAmount = checkNumber(`${at}.monthlyAmount`, row.monthlyAmount, [1000, 500000]);
    const effectiveFrom = String(row.effectiveFrom || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) || Number.isNaN(Date.parse(effectiveFrom))) throw new SettingsError(`${at}.effectiveFrom must be a YYYY-MM-DD date.`);
    const key = `${stateCode}:${category}:${effectiveFrom}`;
    if (seen.has(key)) throw new SettingsError(`${at} duplicates ${stateCode} ${category} from ${effectiveFrom}.`);
    seen.add(key);
    const note = row.note === undefined || row.note === null ? null : String(row.note).slice(0, 300);
    return { stateCode, category, monthlyAmount: Math.round(monthlyAmount), effectiveFrom, isExample: row.isExample === true, note };
  });
}

/** The row in force on `date` for a state + category (latest effectiveFrom ≤ date). */
export function minimumWageFor(table: MinimumWage[], state: string, category: string, date: string) {
  return table.filter((row) => row.stateCode === state && row.category === category && row.effectiveFrom <= date)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] || null;
}

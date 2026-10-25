// Retention schedule for exited employees' data. Pure functions (no database) so the rules are unit-tested.
//
// Periods are counted in whole years from the day the person left. The defaults are conservative starting points for an
// Indian employer and MUST be confirmed with the client's counsel / CA before go-live:
//   - payrollTax 8 years: Companies Act 2013 s.128(5) keeps books of account 8 years; Income-tax Rule 6F / s.44AA and
//     TDS records (Form 16/24Q) need at least 6–8 years. Labour codes ask for wage registers for several years.
//   - casesAndLeave 3 years: Limitation Act 1963 — most civil/employment claims within 3 years.
//   - documents / attendanceDetail / contact 1 year: not needed once the person has left and final settlement is done;
//     1 year also matches the DPDP Rules 2025 minimum retention of processing logs.

export const RETENTION_CATEGORIES = ["documents", "attendanceDetail", "contact", "casesAndLeave", "payrollTax"] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];
export type RetentionYears = Record<RetentionCategory, number>;

export const DEFAULT_RETENTION: RetentionYears = { documents: 1, attendanceDetail: 1, contact: 1, casesAndLeave: 3, payrollTax: 8 };
/** Floors and ceilings HR can set. Statutory payroll/tax records can't be set below 6 years. */
export const RETENTION_LIMITS: Record<RetentionCategory, { min: number; max: number }> = {
  documents: { min: 0, max: 15 }, attendanceDetail: { min: 0, max: 15 }, contact: { min: 0, max: 15 },
  casesAndLeave: { min: 0, max: 15 }, payrollTax: { min: 6, max: 15 },
};

export const CATEGORY_INFO: Record<RetentionCategory, { label: string; what: string; basis: string; statutory: boolean }> = {
  documents: {
    label: "Documents & ID proofs", statutory: false,
    what: "Onboarding documents (PAN/Aadhaar/bank proofs, photos), joiner personal contact details, request attachments and any remaining punch selfies.",
    basis: "Not required after exit and full & final settlement.",
  },
  attendanceDetail: {
    label: "Attendance location & device detail", statutory: false,
    what: "GPS coordinates, IP address, Wi-Fi, device ids and notes on punches. Punch times are kept with payroll records.",
    basis: "Only needed to verify attendance while employed.",
  },
  contact: {
    label: "Personal profile & sign-in", statutory: false,
    what: "Date of birth, gender, workspace sign-in (membership) and registered push devices.",
    basis: "No longer needed once the person can't sign in or be contacted for work.",
  },
  casesAndLeave: {
    label: "Requests, grievances & leave reasons", statutory: false,
    what: "Narrative of helpdesk/HR requests, comments, leave and regularisation reasons.",
    basis: "Kept for the limitation period for employment claims (Limitation Act, 1963 — 3 years). Confirm with counsel.",
  },
  payrollTax: {
    label: "Payroll, tax & expense records", statutory: true,
    what: "PAN, UAN, ESI and bank details, tax declarations and proofs, expense claims and receipts. After this the person is fully anonymised.",
    basis: "Companies Act s.128(5) (8 years), Income-tax Act / Rule 6F, TDS and labour-code wage registers. Confirm with counsel/CA.",
  },
};

/** Settings stored as JSON → a complete, clamped schedule. Unknown keys are ignored. */
export function normalizeRetention(raw: unknown): RetentionYears {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_RETENTION };
  for (const category of RETENTION_CATEGORIES) {
    const value = Number(input[category]);
    if (Number.isFinite(value)) out[category] = Math.min(RETENTION_LIMITS[category].max, Math.max(RETENTION_LIMITS[category].min, Math.round(value)));
  }
  return out;
}

/** Validation for an update: returns human-readable problems (empty = ok). */
export function retentionProblems(raw: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!(RETENTION_CATEGORIES as readonly string[]).includes(key)) { problems.push(`Unknown retention category “${key}”.`); continue; }
    const limits = RETENTION_LIMITS[key as RetentionCategory];
    const number = Number(value);
    if (!Number.isInteger(number) || number < limits.min || number > limits.max)
      problems.push(`${CATEGORY_INFO[key as RetentionCategory].label}: choose a whole number of years between ${limits.min} and ${limits.max}.`);
  }
  return problems;
}

/** The date (YYYY-MM-DD) a category becomes due for erasure: exit date + N years. */
export function dueOn(exitedOn: string, years: number) {
  const [y, m, d] = exitedOn.split("-").map(Number);
  const due = new Date(Date.UTC(y + years, m - 1, d));
  // 29 Feb + N years → 1 Mar when the target year isn't a leap year (Date rolls over by itself).
  return due.toISOString().slice(0, 10);
}

export type SubjectPlan = {
  due: { category: RetentionCategory; dueOn: string }[];
  later: { category: RetentionCategory; dueOn: string }[];
  /** All categories are (or will be after this run) erased → replace name, email and employee number. */
  anonymise: boolean;
};

/**
 * Which categories are due for one exited person.
 * - `today` YYYY-MM-DD in the brand's timezone.
 * - `alreadyErased` categories done in an earlier run are skipped.
 * - `request` (an approved erasure request): every non-statutory category is due now; statutory records still wait for
 *   their legal period (DPDP Act s.8(7) / s.12(3): erase unless retention is necessary for compliance with law).
 */
export function planSubject(input: { exitedOn: string; today: string; years: RetentionYears; alreadyErased: string[]; request?: boolean }): SubjectPlan {
  const due: SubjectPlan["due"] = [];
  const later: SubjectPlan["later"] = [];
  for (const category of RETENTION_CATEGORIES) {
    if (input.alreadyErased.includes(category)) continue;
    const date = dueOn(input.exitedOn, input.years[category]);
    const now = input.request && !CATEGORY_INFO[category].statutory ? true : date <= input.today;
    (now ? due : later).push({ category, dueOn: date });
  }
  return { due, later, anonymise: later.length === 0 && due.length + input.alreadyErased.length > 0 };
}

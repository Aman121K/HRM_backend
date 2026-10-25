/**
 * State levies: Professional Tax (Art. 276 — max ₹2,500/year) and Labour Welfare Fund, plus a minimum-wage placeholder.
 * Each state has a list of versions (effectiveFrom ascending). State schedules change often and many are only
 * published as state gazettes — status is recorded per row and everything not OFFICIAL must be confirmed by the CA.
 */
import type { Source } from "./types";

const CHECKED = "2026-10-19";

export type PtSlab = { upTo: number | null; amount: number; february?: number };
export type PtVersion = {
  effectiveFrom: string; version: string;
  frequency: "MONTHLY" | "HALF_YEARLY" | "NONE";
  /** MONTHLY: monthly gross; HALF_YEARLY: half-year gross; ANNUAL_INCOME: annualised gross (Punjab development tax). */
  basis?: "MONTHLY" | "HALF_YEAR" | "ANNUAL_INCOME";
  slabs: PtSlab[]; womenSlabs?: PtSlab[]; annualCap?: number; note: string; sources: Source[];
};
export type PtState = { code: string; name: string; versions: PtVersion[] };

const none = (name: string, status: Source["status"] = "SECONDARY", extra = ""): PtVersion => ({
  effectiveFrom: "2000-04-01", version: "NONE", frequency: "NONE", slabs: [],
  note: `${name} does not levy professional tax on salaried employees.${extra}`,
  sources: [{ ref: `No ${name} professional-tax legislation applicable to salary found`, checked: CHECKED, status }],
});

export const PT_RULES: Record<string, PtState> = {
  KA: {
    code: "KA", name: "Karnataka", versions: [
      {
        effectiveFrom: "2025-04-01", version: "KA-2025", frequency: "MONTHLY", annualCap: 2500,
        slabs: [{ upTo: 24999, amount: 0 }, { upTo: null, amount: 200, february: 300 }],
        note: "₹200/month when monthly gross ≥ ₹25,000; ₹300 in February (annual ₹2,500). Nil below ₹25,000.",
        sources: [{ ref: "Karnataka Tax on Professions, Trades, Callings and Employments (Amendment) Act 2025 — Karnataka Act 33 of 2025, Notification 232 dated 15 Apr 2025, w.e.f. 1 Apr 2025", url: "https://lexplosion.in/karnataka-govt-notifies-revised-professional-tax-rate-under-karnataka-tax-on-profession-trades-callings-and-employments-amendment-act-2025/", checked: CHECKED, status: "SECONDARY" }],
      },
    ],
  },
  MH: {
    code: "MH", name: "Maharashtra", versions: [
      {
        effectiveFrom: "2023-07-01", version: "MH-2023", frequency: "MONTHLY", annualCap: 2500,
        slabs: [{ upTo: 7500, amount: 0 }, { upTo: 10000, amount: 175 }, { upTo: null, amount: 200, february: 300 }],
        womenSlabs: [{ upTo: 25000, amount: 0 }, { upTo: null, amount: 200, february: 300 }],
        note: "Men: nil ≤ ₹7,500, ₹175 up to ₹10,000, then ₹200 (₹300 in February). Women: nil ≤ ₹25,000, then ₹200 (₹300 in February).",
        sources: [{ ref: "Maharashtra State Tax on Professions, Trades, Callings and Employments Act 1975, Schedule I entry 1 (women's threshold ₹25,000 from 1 Jul 2023)", checked: CHECKED, status: "SECONDARY" }],
      },
    ],
  },
  TN: {
    code: "TN", name: "Tamil Nadu", versions: [
      {
        effectiveFrom: "2024-04-01", version: "TN-2024", frequency: "HALF_YEARLY", basis: "HALF_YEAR", annualCap: 2500,
        slabs: [{ upTo: 21000, amount: 0 }, { upTo: 30000, amount: 180 }, { upTo: 45000, amount: 425 }, { upTo: 60000, amount: 930 }, { upTo: 75000, amount: 1025 }, { upTo: null, amount: 1250 }],
        note: "Half-yearly tax on half-year salary (Apr–Sep, Oct–Mar). Engine projects monthly gross × 6 and deducts sixths, with September and March carrying the remainder.",
        sources: [{ ref: "Tamil Nadu Urban Local Bodies Act 1998 / Greater Chennai Corporation PT schedule revised w.e.f. 2024-25", checked: CHECKED, status: "SECONDARY", note: "Other TN local bodies may notify different schedules — UNVERIFIED outside Chennai." }],
      },
    ],
  },
  TS: {
    code: "TS", name: "Telangana", versions: [{
      effectiveFrom: "2013-04-01", version: "TS-2013", frequency: "MONTHLY",
      slabs: [{ upTo: 15000, amount: 0 }, { upTo: 20000, amount: 150 }, { upTo: null, amount: 200 }],
      note: "Nil ≤ ₹15,000, ₹150 up to ₹20,000, ₹200 above.",
      sources: [{ ref: "Telangana Tax on Professions, Trades, Callings and Employments Act 1987 (Schedule)", checked: CHECKED, status: "SECONDARY" }],
    }],
  },
  AP: {
    code: "AP", name: "Andhra Pradesh", versions: [{
      effectiveFrom: "2013-04-01", version: "AP-2013", frequency: "MONTHLY",
      slabs: [{ upTo: 15000, amount: 0 }, { upTo: 20000, amount: 150 }, { upTo: null, amount: 200 }],
      note: "Nil ≤ ₹15,000, ₹150 up to ₹20,000, ₹200 above.",
      sources: [{ ref: "Andhra Pradesh Tax on Professions, Trades, Callings and Employments Act 1987 (Schedule)", checked: CHECKED, status: "SECONDARY" }],
    }],
  },
  WB: {
    code: "WB", name: "West Bengal", versions: [{
      effectiveFrom: "2015-04-01", version: "WB-2015", frequency: "MONTHLY",
      slabs: [{ upTo: 10000, amount: 0 }, { upTo: 15000, amount: 110 }, { upTo: 25000, amount: 130 }, { upTo: 40000, amount: 150 }, { upTo: null, amount: 200 }],
      note: "Nil ≤ ₹10,000; ₹110 / ₹130 / ₹150 up to ₹15k / ₹25k / ₹40k; ₹200 above.",
      sources: [{ ref: "West Bengal State Tax on Professions, Trades, Callings and Employments Act 1979 (Schedule)", checked: CHECKED, status: "SECONDARY" }],
    }],
  },
  GJ: {
    code: "GJ", name: "Gujarat", versions: [{
      effectiveFrom: "2023-04-01", version: "GJ-2023", frequency: "MONTHLY",
      slabs: [{ upTo: 11999, amount: 0 }, { upTo: null, amount: 200 }],
      note: "Nil below ₹12,000, ₹200 at or above.",
      sources: [{ ref: "Gujarat State Tax on Professions, Traders, Callings and Employments Act 1976 (as amended)", checked: CHECKED, status: "SECONDARY" }],
    }],
  },
  KL: {
    code: "KL", name: "Kerala", versions: [{
      effectiveFrom: "2024-10-01", version: "KL-2024", frequency: "HALF_YEARLY", basis: "HALF_YEAR", annualCap: 2500,
      slabs: [{ upTo: 11999, amount: 0 }, { upTo: 17999, amount: 320 }, { upTo: 29999, amount: 450 }, { upTo: 44999, amount: 600 }, { upTo: 99999, amount: 750 }, { upTo: 124999, amount: 1000 }, { upTo: null, amount: 1250 }],
      note: "Half-yearly tax on half-year salary, levied by the local body (Kerala Municipality / Panchayat Raj Acts). Engine deducts sixths like Tamil Nadu.",
      sources: [{ ref: "Kerala LSGD Notification 1149/2024/LSGD (27 Jun 2024) as summarised by taxgarden.in", url: "https://taxgarden.in/blog/professional-tax-kerala-rates-slabs-registration-payment-2026", checked: CHECKED, status: "UNVERIFIED", note: "Published slab tables conflict (₹120…₹1,250 vs ₹320…₹1,250). All agree on ₹1,250 per half-year at ≥ ₹1,25,000 half-year salary." }],
    }],
  },
  PB: {
    code: "PB", name: "Punjab", versions: [{
      effectiveFrom: "2018-04-01", version: "PB-2018", frequency: "MONTHLY", basis: "ANNUAL_INCOME", annualCap: 2400,
      slabs: [{ upTo: 250000, amount: 0 }, { upTo: null, amount: 200 }],
      note: "Punjab State Development Tax: ₹200/month for employees whose annual income exceeds ₹2.5 lakh (engine uses monthly gross × 12 as the income proxy).",
      sources: [{ ref: "Punjab State Development Tax Act 2018", checked: CHECKED, status: "UNVERIFIED", note: "Act ties the levy to income chargeable to income-tax; proxy needs CA confirmation." }],
    }],
  },
  DL: { code: "DL", name: "Delhi", versions: [none("Delhi")] },
  HR: { code: "HR", name: "Haryana", versions: [none("Haryana")] },
  UP: { code: "UP", name: "Uttar Pradesh", versions: [none("Uttar Pradesh")] },
  RJ: { code: "RJ", name: "Rajasthan", versions: [none("Rajasthan")] },
  GA: { code: "GA", name: "Goa", versions: [none("Goa", "UNVERIFIED", " Sources conflict — some list a monthly Goa schedule; confirm with CA before relying on nil.")] },
};

// ------------------------------------------------------------------ Labour Welfare Fund

export type LwfVersion = {
  effectiveFrom: string; version: string;
  /** Months (1–12) in whose payroll the contribution is deducted. */
  months: number[];
  frequency: "MONTHLY" | "HALF_YEARLY" | "ANNUAL" | "NONE";
  employee: number; employer: number;
  /** Percentage-based states (Haryana): employee = rate × gross capped at employee; employer = multiple × employee. */
  employeeRate?: number; employerMultiple?: number;
  note: string; sources: Source[];
};
const lwf = (v: Omit<LwfVersion, "sources"> & { status?: Source["status"]; ref: string; url?: string; extra?: string }): LwfVersion => ({
  effectiveFrom: v.effectiveFrom, version: v.version, months: v.months, frequency: v.frequency, employee: v.employee, employer: v.employer,
  employeeRate: v.employeeRate, employerMultiple: v.employerMultiple, note: v.note,
  sources: [{ ref: v.ref, url: v.url, checked: CHECKED, status: v.status || "SECONDARY", note: v.extra }],
});
const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export const LWF_RULES: Record<string, LwfVersion[]> = {
  KA: [lwf({ effectiveFrom: "2024-01-01", version: "KA-LWF-2024", months: [12], frequency: "ANNUAL", employee: 50, employer: 100, note: "Annual — deducted in December payroll, remitted by 15 January.", ref: "Karnataka Labour Welfare Fund (Amendment) 2024 — ₹50 employee / ₹100 employer (+₹50 State)", extra: "One source still lists ₹20/₹40." })],
  MH: [lwf({ effectiveFrom: "2024-06-01", version: "MH-LWF-2024", months: [6, 12], frequency: "HALF_YEARLY", employee: 25, employer: 75, note: "Half-yearly — June and December payroll (remit by 15 Jul / 15 Jan).", ref: "Bombay Labour Welfare Fund Act 1953 s.6BB — ₹25 employee / ₹75 employer", extra: "Lower band for wages ≤ ₹3,000 and the managerial-employee exclusion not modelled." })],
  TN: [lwf({ effectiveFrom: "2022-01-01", version: "TN-LWF-2022", months: [12], frequency: "ANNUAL", employee: 20, employer: 40, note: "Annual — December payroll, remit by 31 January.", ref: "Tamil Nadu Labour Welfare Fund Act 1972", status: "UNVERIFIED", extra: "Sources conflict: ₹20/₹40 vs ₹30/₹70." })],
  TS: [lwf({ effectiveFrom: "2015-01-01", version: "TS-LWF", months: [12], frequency: "ANNUAL", employee: 2, employer: 5, note: "Annual — December payroll.", ref: "Telangana Labour Welfare Fund Act 1987", status: "UNVERIFIED", extra: "Single secondary source." })],
  AP: [lwf({ effectiveFrom: "2015-01-01", version: "AP-LWF", months: [12], frequency: "ANNUAL", employee: 30, employer: 70, note: "Annual — December payroll.", ref: "Andhra Pradesh Labour Welfare Fund Act 1987" })],
  WB: [lwf({ effectiveFrom: "2015-01-01", version: "WB-LWF", months: [6, 12], frequency: "HALF_YEARLY", employee: 3, employer: 30, note: "Half-yearly — June and December payroll.", ref: "West Bengal Labour Welfare Fund Act 1974", status: "UNVERIFIED", extra: "Employer share reported as ₹15 in older tables, ₹30 in 2026 tables." })],
  GJ: [lwf({ effectiveFrom: "2015-01-01", version: "GJ-LWF", months: [6, 12], frequency: "HALF_YEARLY", employee: 6, employer: 12, note: "Half-yearly — June and December payroll.", ref: "Gujarat Labour Welfare Fund Act 1953" })],
  DL: [lwf({ effectiveFrom: "2015-01-01", version: "DL-LWF", months: [6, 12], frequency: "HALF_YEARLY", employee: 0.75, employer: 2.25, note: "Half-yearly — June and December payroll (paise amounts are remitted, payslip shows ₹1/₹2 after rounding).", ref: "Delhi Labour Welfare Fund Act 1997" })],
  HR: [
    lwf({ effectiveFrom: "2019-01-01", version: "HR-LWF-2019", months: ALL, frequency: "MONTHLY", employee: 34, employer: 68, employeeRate: 0.002, employerMultiple: 2, note: "Monthly — 0.2% of wages capped at ₹34, employer twice the employee share.", ref: "Punjab Labour Welfare Fund Act 1965 as applicable to Haryana" }),
    lwf({ effectiveFrom: "2026-01-01", version: "HR-LWF-2026", months: ALL, frequency: "MONTHLY", employee: 35, employer: 70, employeeRate: 0.002, employerMultiple: 2, note: "Monthly — 0.2% of wages capped at ₹35, employer twice the employee share.", ref: "Haryana Labour Welfare Board Notification HLWB/REV/2026/3436 — cap ₹35 from 1 Jan 2026", url: "https://innbuilt.com/insights/india/compliance/labour-welfare-fund/haryana" }),
  ],
  KL: [lwf({ effectiveFrom: "2015-01-01", version: "KL-LWF", months: ALL, frequency: "MONTHLY", employee: 50, employer: 50, note: "Monthly — Kerala Shops & Commercial Establishments Workers Welfare Fund.", ref: "Kerala Shops and Commercial Establishments Workers Welfare Fund Act 2006", status: "UNVERIFIED", extra: "Amounts differ by establishment type and source." })],
  PB: [lwf({ effectiveFrom: "2015-01-01", version: "PB-LWF", months: ALL, frequency: "MONTHLY", employee: 5, employer: 20, note: "Monthly.", ref: "Punjab Labour Welfare Fund Act 1965", status: "UNVERIFIED", extra: "A revision to ₹10/₹40 was reported (June 2025) but not confirmed." })],
  GA: [lwf({ effectiveFrom: "2015-01-01", version: "GA-LWF", months: [6, 12], frequency: "HALF_YEARLY", employee: 60, employer: 180, note: "Half-yearly — June and December payroll.", ref: "Goa Labour Welfare Fund Act 1986" })],
  UP: [lwf({ effectiveFrom: "2000-01-01", version: "NONE", months: [], frequency: "NONE", employee: 0, employer: 0, note: "No Labour Welfare Fund levy on salaried employees.", ref: "No UP LWF levy found" })],
  RJ: [lwf({ effectiveFrom: "2000-01-01", version: "NONE", months: [], frequency: "NONE", employee: 0, employer: 0, note: "No Labour Welfare Fund levy on salaried employees.", ref: "No Rajasthan LWF levy found" })],
};

// ------------------------------------------------------------------ Minimum wages (placeholder — client must configure)

/**
 * Minimum wages are notified per State, per scheduled employment, per skill level and revised twice a year (VDA).
 * They are deliberately NOT hard-coded. Configure the applicable monthly floor for your establishments here (or in a
 * future org-level table) — the engine raises a warning when the earned Basic + DA falls below it.
 */
export type MinimumWage = { state: string; monthlyFloor: number | null; skill: string; effectiveFrom: string | null; status: "VERIFY_FOR_YOUR_STATE"; note: string };
export const MINIMUM_WAGES: Record<string, MinimumWage> = Object.fromEntries(
  ["KA", "MH", "TN", "TS", "AP", "WB", "GJ", "DL", "HR", "KL", "UP", "RJ", "PB", "GA"].map((state) => [state, {
    state, monthlyFloor: null, skill: "UNSKILLED", effectiveFrom: null, status: "VERIFY_FOR_YOUR_STATE" as const,
    note: "Not configured — take the current notification (basic + VDA) for your scheduled employment and zone from the State Labour Department.",
  }]),
);

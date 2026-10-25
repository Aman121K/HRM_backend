/**
 * Income-tax rule tables per financial (tax) year, keyed by the FY start year (2026 = FY 2026-27 = Tax Year 2026-27).
 * A new Budget = add a new entry; earlier years stay untouched so past months recompute with their own year's rules.
 *
 * From 1 April 2026 salary TDS is governed by the Income-tax Act, 2025 (s.392 replaces s.192 of the 1961 Act).
 * Section references below give both numbers where known.
 */
import type { Source } from "./types";

export type Slab = [upTo: number, rate: number];
export type AgeCategory = "BELOW_60" | "SENIOR" | "SUPER_SENIOR";
export type TaxYearRules = {
  fyStartYear: number; label: string; version: string; act: "1961" | "2025";
  newSlabs: Slab[]; oldSlabs: Record<AgeCategory, Slab[]>;
  newStandardDeduction: number; oldStandardDeduction: number;
  newRebate: { limit: number; max: number; marginalRelief: boolean }; oldRebate: { limit: number; max: number };
  surcharge: { NEW: Slab[]; OLD: Slab[] }; cessRate: number;
  /** Employer contribution to NPS deductible: % of salary (Basic + DA). */
  employerNpsLimit: { NEW: number; OLD: number };
  /** Aggregate employer PF + NPS + superannuation above this is a taxable perquisite. */
  employerRetirementPerquisiteCap: number;
  oldCaps: { section80C: number; section80DSelf: number; section80DSelfSenior: number; section80DParents: number; section80DParentsSenior: number; nps80CCD1B: number; homeLoanInterest: number; professionalTax: number };
  /** Cities where HRA exemption limit is 50% of salary (else 40%). */
  hraMetroPattern: RegExp; hraMetroCities: string[];
  noPanRate: number;
  sections: Record<string, string>;
  sources: Source[];
};

const CHECKED = "2026-10-19";
const OLD_SLABS: Record<AgeCategory, Slab[]> = {
  BELOW_60: [[250000, 0], [500000, 0.05], [1000000, 0.2], [Infinity, 0.3]],
  SENIOR: [[300000, 0], [500000, 0.05], [1000000, 0.2], [Infinity, 0.3]],
  SUPER_SENIOR: [[500000, 0], [1000000, 0.2], [Infinity, 0.3]],
};
const SURCHARGE_NEW: Slab[] = [[5000000, 0.10], [10000000, 0.15], [20000000, 0.25]];
const SURCHARGE_OLD: Slab[] = [[5000000, 0.10], [10000000, 0.15], [20000000, 0.25], [50000000, 0.37]];
const OLD_CAPS = { section80C: 150000, section80DSelf: 25000, section80DSelfSenior: 50000, section80DParents: 25000, section80DParentsSenior: 50000, nps80CCD1B: 50000, homeLoanInterest: 200000, professionalTax: 2500 };
const METRO_4 = { hraMetroPattern: /mumbai|bombay|delhi|kolkata|calcutta|chennai|madras/i, hraMetroCities: ["Delhi", "Mumbai", "Kolkata", "Chennai"] };
const METRO_8 = {
  hraMetroPattern: /mumbai|bombay|delhi|kolkata|calcutta|chennai|madras|bengaluru|bangalore|hyderabad|secunderabad|pune|ahmedabad/i,
  hraMetroCities: ["Delhi", "Mumbai", "Kolkata", "Chennai", "Bengaluru", "Hyderabad", "Pune", "Ahmedabad"],
};
const SECTIONS_1961 = {
  tds: "s.192", rebate: "s.87A", standardDeduction: "s.16(ia)", newRegime: "s.115BAC", hra: "s.10(13A) r/w rule 2A", deduction80C: "s.80C",
  nps: "s.80CCD(2)", health: "s.80D", roundingIncome: "s.288A", roundingTax: "s.288B", noPan: "s.206AA", declaration: "Form 12BB (rule 26C)", certificate: "Form 16",
};
const SECTIONS_2025 = {
  tds: "s.392 (was s.192)", rebate: "s.156 (was s.87A)", standardDeduction: "s.19 (was s.16)", newRegime: "s.202 (was s.115BAC)",
  hra: "s.11 r/w Schedule (was s.10(13A)); rule 279 of Income-tax Rules 2026 (UNVERIFIED rule number)", deduction80C: "s.123 (was s.80C)", nps: "s.124 (was s.80CCD)",
  health: "s.126 (was s.80D)", roundingIncome: "corresponding provision to s.288A — section number UNVERIFIED", roundingTax: "corresponding provision to s.288B — section number UNVERIFIED",
  noPan: "corresponding provision to s.206AA — section number UNVERIFIED", declaration: "Form 124 (was Form 12BB), s.392(5)(b) r/w rule 205", certificate: "Form 130 (was Form 16) — UNVERIFIED",
};

export const TAX_YEARS: Record<number, TaxYearRules> = {
  2024: {
    fyStartYear: 2024, label: "2024-25", version: "IT-FY2024-25.1", act: "1961",
    newSlabs: [[300000, 0], [700000, 0.05], [1000000, 0.1], [1200000, 0.15], [1500000, 0.2], [Infinity, 0.3]], oldSlabs: OLD_SLABS,
    newStandardDeduction: 75000, oldStandardDeduction: 50000,
    newRebate: { limit: 700000, max: 25000, marginalRelief: true }, oldRebate: { limit: 500000, max: 12500 },
    surcharge: { NEW: SURCHARGE_NEW, OLD: SURCHARGE_OLD }, cessRate: 0.04, employerNpsLimit: { NEW: 0.14, OLD: 0.10 }, employerRetirementPerquisiteCap: 750000,
    oldCaps: OLD_CAPS, ...METRO_4, noPanRate: 0.2, sections: SECTIONS_1961,
    sources: [{ ref: "Finance (No. 2) Act 2024 — new-regime slabs, standard deduction ₹75,000, s.80CCD(2) 14% under new regime", checked: CHECKED, status: "SECONDARY" }],
  },
  2025: {
    fyStartYear: 2025, label: "2025-26", version: "IT-FY2025-26.1", act: "1961",
    newSlabs: [[400000, 0], [800000, 0.05], [1200000, 0.1], [1600000, 0.15], [2000000, 0.2], [2400000, 0.25], [Infinity, 0.3]], oldSlabs: OLD_SLABS,
    newStandardDeduction: 75000, oldStandardDeduction: 50000,
    newRebate: { limit: 1200000, max: 60000, marginalRelief: true }, oldRebate: { limit: 500000, max: 12500 },
    surcharge: { NEW: SURCHARGE_NEW, OLD: SURCHARGE_OLD }, cessRate: 0.04, employerNpsLimit: { NEW: 0.14, OLD: 0.10 }, employerRetirementPerquisiteCap: 750000,
    oldCaps: OLD_CAPS, ...METRO_4, noPanRate: 0.2, sections: SECTIONS_1961,
    sources: [{ ref: "Finance Act 2025 — s.115BAC slabs (₹4L/8L/12L/16L/20L/24L), s.87A rebate ₹60,000 up to ₹12 lakh", checked: CHECKED, status: "SECONDARY" }],
  },
  2026: {
    fyStartYear: 2026, label: "2026-27", version: "IT-FY2026-27.2", act: "2025",
    newSlabs: [[400000, 0], [800000, 0.05], [1200000, 0.1], [1600000, 0.15], [2000000, 0.2], [2400000, 0.25], [Infinity, 0.3]], oldSlabs: OLD_SLABS,
    newStandardDeduction: 75000, oldStandardDeduction: 50000,
    newRebate: { limit: 1200000, max: 60000, marginalRelief: true }, oldRebate: { limit: 500000, max: 12500 },
    surcharge: { NEW: SURCHARGE_NEW, OLD: SURCHARGE_OLD }, cessRate: 0.04, employerNpsLimit: { NEW: 0.14, OLD: 0.10 }, employerRetirementPerquisiteCap: 750000,
    oldCaps: OLD_CAPS, ...METRO_8, noPanRate: 0.2, sections: SECTIONS_2025,
    sources: [
      { ref: "Finance Bill 2026 — Memorandum, Part A.IV: TDS-on-salary rates for FY 2026-27 = s.202 slabs (nil to ₹4L … 30% above ₹24L); old-regime rates in Part III First Schedule incl. 60–80 / 80+ slabs; surcharge 10%/15%/25%/37%, 37% not applicable under s.202 (restricted to 25%); marginal relief; 4% cess", url: "https://www.indiabudget.gov.in/doc/memo.pdf", checked: CHECKED, status: "OFFICIAL" },
      { ref: "Finance Bill 2026 Memorandum — employer PF/NPS/superannuation aggregate ceiling ₹7.5 lakh under s.17(1)(h) of the 2025 Act", url: "https://www.indiabudget.gov.in/doc/memo.pdf", checked: CHECKED, status: "OFFICIAL" },
      { ref: "CBDT press release 1 Apr 2026 — Income-tax Act 2025 in force from 1 Apr 2026; Income-tax Rules 2026 notified 20 Mar 2026 (G.S.R. 198(E), Notification 22/2026)", url: "https://www.incometaxindia.gov.in/documents/d/guest/press-release-income-tax-act-2025-comes-into-force-from-01-april-2026-pdf", checked: CHECKED, status: "SECONDARY", note: "Listed in official search index; page blocked (HTTP 403) during review." },
      { ref: "Income-tax Rules 2026 — HRA 50% limit extended to Bengaluru, Hyderabad, Pune, Ahmedabad from 1 Apr 2026", url: "https://taxguru.in/income-tax/hra-exemption-8-cities-qualify-50-percent-exemption-practical-guide.html", checked: CHECKED, status: "SECONDARY", note: "Rule text not retrieved from CBDT — confirm with CA." },
      { ref: "Section mapping 1961 → 2025 Act (s.192→392, 87A→156, 16→19, 80C→123, 80CCD→124, 80D→126, 115BAC→202)", url: "https://taxguru.in/income-tax/income-tax-act-2025-1961-section-mapping-cheat-sheet-sections-day.html", checked: CHECKED, status: "SECONDARY" },
      { ref: "Form 124 replaces Form 12BB (s.392(5)(b) r/w rule 205)", url: "https://www.incometaxindia.gov.in/documents/d/guest/fn-124", checked: CHECKED, status: "SECONDARY" },
    ],
  },
};

export function taxRulesFor(fyStartYear: number): TaxYearRules & { assumed: boolean } {
  if (TAX_YEARS[fyStartYear]) return { ...TAX_YEARS[fyStartYear], assumed: false };
  const years = Object.keys(TAX_YEARS).map(Number).sort((a, b) => a - b);
  const fallback = fyStartYear < years[0] ? years[0] : years[years.length - 1];
  // A year not yet configured falls back to the nearest configured one; callers surface `assumed` as a warning.
  return { ...TAX_YEARS[fallback], assumed: true };
}

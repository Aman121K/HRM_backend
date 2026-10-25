/**
 * EPF / EPS / EDLI, ESI, Labour Code wage definition, gratuity, bonus and overtime — versioned rule rows.
 * Next change (e.g. a new ESI ceiling) = append a row with its effectiveFrom date; past periods keep the old row.
 */
import type { Source, Versioned } from "./types";

const CHECKED = "2026-10-19";

export type PfRule = Versioned<{
  employeeRate: number; employerRate: number; epsRate: number; edliRate: number; adminRate: number;
  /** Statutory wage ceiling (₹/month) for mandatory coverage, EPS pensionable wage and EDLI. */
  wageCeiling: number;
  /** Establishment-level minimum admin charges per wage month (not applied per employee). */
  adminMinPerEstablishment: number; adminMinNoContributor: number;
}>;

const PF_COMMON = { employeeRate: 0.12, employerRate: 0.12, epsRate: 0.0833, edliRate: 0.005, adminRate: 0.005, adminMinPerEstablishment: 500, adminMinNoContributor: 75 };

export const PF_RULES: PfRule[] = [
  {
    ...PF_COMMON, wageCeiling: 15000, effectiveFrom: "2014-09-01", version: "PF-2014.09",
    sources: [
      { ref: "EPF & MP Act 1952; EPF Scheme 1952 para 2(f)/26A; EPS 1995 para 3 & 11 (ceiling ₹15,000 w.e.f. 1 Sep 2014, G.S.R. 609(E))", checked: CHECKED, status: "SECONDARY" },
      { ref: "EPFO admin charges 0.50% w.e.f. 1 Jun 2018 (min ₹500 / ₹75 per establishment)", checked: CHECKED, status: "SECONDARY" },
    ],
  },
  {
    ...PF_COMMON, wageCeiling: 25000, effectiveFrom: "2026-09-17", version: "PF-2026.09",
    sources: [
      { ref: "PIB (Ministry of Labour & Employment) 16 Sep 2026 — Cabinet approves EPFO wage ceiling ₹25,000 w.e.f. 17 Sep 2026", url: "https://www.pib.gov.in/PressReleasePage.aspx?PRID=2310973&reg=48&lang=2", checked: CHECKED, status: "OFFICIAL" },
      { ref: "PIB Kolkata 23 Sep 2026 — Gazette S.O. 5109(E); EPS max 8.33% rises from ₹1,250 to ₹2,083", url: "https://www.pib.gov.in/PressReleasePage.aspx?PRID=2313829&reg=48&lang=2", checked: CHECKED, status: "OFFICIAL" },
      { ref: "PIB Imphal 23 Sep 2026 — ceiling ₹25,000 or actual wages, whichever lower; EPS 8.33% of ₹25,000", url: "https://www.pib.gov.in/PressReleasePage.aspx?PRID=2314111&reg=48&lang=2", checked: CHECKED, status: "OFFICIAL" },
      { ref: "EPFO FAQs on revised wage ceiling (Q7–Q13: September 2026 wage month split 1–16 Sep at ₹15,000 and 17–30 Sep at ₹25,000, single ECR; ₹500 admin minimum)", url: "https://www.sgcms.com/regulatory-updates/faqs-by-epfo-wage-ceiling-raised-to-25000/", checked: CHECKED, status: "SECONDARY", note: "EPFO FAQ text as reproduced by SGCMS (24 Sep 2026); primary EPFO copy not retrieved." },
    ],
  },
];

export type EsiRule = Versioned<{
  employeeRate: number; employerRate: number; wageThreshold: number; disabledWageThreshold: number; lowWageDailyLimit: number;
}>;
export const ESI_RULES: EsiRule[] = [
  {
    employeeRate: 0.0075, employerRate: 0.0325, wageThreshold: 21000, disabledWageThreshold: 25000, lowWageDailyLimit: 176,
    effectiveFrom: "2019-07-01", version: "ESI-2019.07",
    sources: [
      { ref: "ESIC — Contribution page: 0.75% / 3.25% w.e.f. 01.07.2019; daily average wage up to ₹176 exempt from employee share; contribution periods Apr–Sep, Oct–Mar", url: "https://www.esic.gov.in/contribution", checked: CHECKED, status: "OFFICIAL" },
      { ref: "ESIC — Coverage page: wage limit ₹21,000/month w.e.f. 01.01.2017 (₹25,000 for persons with disability)", url: "https://esic.gov.in/coverage", checked: CHECKED, status: "OFFICIAL" },
      { ref: "No revision of the ₹21,000 ceiling found as of the check date (proposals for ₹25,000/₹30,000 not notified)", checked: CHECKED, status: "SECONDARY" },
    ],
  },
];

/** Code on Social Security 2020 s.2(88) / Code on Wages 2019 s.2(y): excluded components above 50% are deemed wages. */
export type LabourCodeRule = Versioned<{ excludedLimit: number }>;
export const LABOUR_CODE_RULES: LabourCodeRule[] = [
  {
    excludedLimit: 0.5, effectiveFrom: "2025-11-21", version: "LC-2025.11",
    sources: [
      { ref: "Ministry of Labour notifications S.O. 5319(E)–5322(E) — four Labour Codes in force from 21 Nov 2025", checked: CHECKED, status: "SECONDARY", note: "Cited by EY alert of 10 May 2026; gazette not retrieved." },
      { ref: "Central Rules under all four Codes notified 8 May 2026 (G.S.R. 342(E)–345(E)); most States yet to notify State Rules", url: "https://www.ey.com/content/dam/ey-unified-site/ey-com/en-in/technical/alerts-hub/documents/2026/05/final-rules-published-by-central-government-under-new-labour-codes.pdf", checked: CHECKED, status: "SECONDARY" },
      { ref: "EPFO FAQ Q25: PF wage ceiling tested on 'wages as defined under section 2(88) of the Code on Social Security, 2020'", url: "https://www.sgcms.com/regulatory-updates/faqs-by-epfo-wage-ceiling-raised-to-25000/", checked: CHECKED, status: "SECONDARY" },
    ],
  },
];

export const GRATUITY_RULES = [
  {
    factor: 15 / 26, cap: 2000000, permanentMinYears: 5, fixedTermMinYears: 1, roundUpMonths: 6, provisionRate: 0.0481,
    effectiveFrom: "2025-11-21", version: "GRAT-2025.11",
    sources: [
      { ref: "Code on Social Security 2020 s.53 — 15 days' wages per completed year (15/26 × last drawn wages); fixed-term employees eligible pro-rata after 1 year; ceiling ₹20 lakh (as carried over from S.O. 1420(E), 29 Mar 2018)", checked: CHECKED, status: "SECONDARY", note: "No notification raising the private-sector ceiling above ₹20 lakh was found." },
    ] as Source[],
  },
];

export const BONUS_RULES = [
  {
    eligibilityWage: 21000, calculationCeiling: 7000, minRate: 0.0833, maxRate: 0.2, minAmount: 100, minDaysWorked: 30,
    effectiveFrom: "2025-11-21", version: "BONUS-2025.11",
    sources: [
      { ref: "Code on Wages 2019 ss.26–27 (Payment of Bonus subsumed); eligibility ₹21,000/month and calculation ceiling ₹7,000 or minimum wage, whichever higher — reported as S.O. 4710(E)/4711(E) of 25 Aug 2026 w.e.f. 21 Nov 2025", checked: CHECKED, status: "UNVERIFIED", note: "Only secondary payroll-vendor sources; gazette text not retrieved." },
    ] as Source[],
  },
];

export const OVERTIME_RULES = [
  {
    multiplier: 2, weeklyHours: 48, effectiveFrom: "2025-11-21", version: "OT-2025.11",
    sources: [
      { ref: "OSH&WC (Central) Rules 2026 / Code on Wages (Central) Rules 2026 — overtime beyond 48 h/week at not less than twice the normal rate of wages", url: "https://www.ey.com/content/dam/ey-unified-site/ey-com/en-in/technical/alerts-hub/documents/2026/05/final-rules-published-by-central-government-under-new-labour-codes.pdf", checked: CHECKED, status: "SECONDARY" },
    ] as Source[],
  },
];

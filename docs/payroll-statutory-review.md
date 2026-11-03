# ClanChief — Payroll Statutory Review Pack (FY 2026-27 / Tax Year 2026-27)

Prepared: 20 Oct 2026 (sources checked 19–20 Oct 2026) · Engine rule versions: `IT-FY2026-27.2`, `PF-2026.09`, `ESI-2019.07`, `LC-2025.11`

> **Status: NOT CA-verified.** This pack was prepared by an engineering agent, not a Chartered Accountant. It records
> what the law says, with the source and how strong that source is, how the engine implements each rule, and which test proves it.
> A CA needs to review it and tick the last column of the sign-off table (§9). Anything marked **UNVERIFIED — confirm with CA**
> could not be confirmed from an official source. Anything marked SECONDARY was taken from professional publications
> because the official page could not be retrieved (several government sites returned HTTP 403 to automated fetches).

**Source status legend:** OFFICIAL = read on a government or statutory-body page (PIB, ESIC, indiabudget.gov.in) · SECONDARY = professional or vendor publication only · UNVERIFIED = sources conflict or none found.

## 0. Where things live

| Concern | File |
|---|---|
| Rate / threshold tables, versioned by effective date, with sources | `src/platform/payroll/rules/` (`income-tax.ts`, `social-security.ts`, `state-levies.ts`, `types.ts`, `index.ts`) |
| PF, ESI, PT, LWF, gratuity, bonus, overtime and LOP calculators | `src/platform/payroll/statutory.ts` |
| Income tax and the monthly TDS projection | `src/platform/payroll/tax-engine.ts` |
| Per-employee monthly line (order of calculation, flags) | `src/platform/payroll/engine.ts` → `calculateLine` |
| CTC → salary structure | `src/platform/payroll/structure.ts` → `buildStructure` |
| Worked-example tests (38) | `src/platform/payroll/statutory.test.ts` |
| Per-org and per-employee switches (DB) | `migrations/031_statutory_rules.sql` (`payroll_settings.statutory_options`, `payroll_profiles.statutory_flags`) |

**Versioning.** Every row has an `effectiveFrom` date and the calculators look up the row in force for the pay period. `segmentsForPeriod` splits a month when a rule changes mid-month. Income-tax tables are keyed by FY: 2024-25, 2025-26 and 2026-27 are configured. An FY that is not configured falls back to the nearest configured year and raises the `TAX_RULES_ASSUMED` flag. Next year's Budget means adding `TAX_YEARS[2027]`; a new PF/ESI/PT rate means appending a row. Past months are therefore recalculated with their own rules. Each line stores the rule versions it used (`breakdown.statutory.rules`).

**Rounding.** All amounts are whole rupees.
- PF, EPS, EDLI, admin charges, PT, LWF and TDS round half-up.
- ESI rounds up to the next rupee. This follows ESIC practice; the CA should confirm it.
- Taxable income is rounded to the nearest ₹10 (s.288A of the 1961 Act).
- The final tax liability is rounded to the nearest ₹10 (s.288B of the 1961 Act). The corresponding section numbers in the 2025 Act are **UNVERIFIED**.

**Run:** `npx tsx --test src/platform/payroll/statutory.test.ts` gives 38 pass, 0 fail (20 Oct 2026).

---

## 1. Income tax and TDS on salary

**Governing law.** From 1 Apr 2026 the **Income-tax Act, 2025** applies (Tax Year 2026-27). Salary TDS is **s.392**, formerly s.192. The Income-tax Rules 2026 were notified on 20 Mar 2026 (G.S.R. 198(E), Notification 22/2026).

**Sources:**
- CBDT press release, 1 Apr 2026 (SECONDARY: listed on incometaxindia.gov.in, page blocked).
- Section mapping: [taxguru cheat sheet](https://taxguru.in/income-tax/income-tax-act-2025-1961-section-mapping-cheat-sheet-sections-day.html) (SECONDARY).

| # | Rule (law) | Source / status | Implementation | Tests |
|---|---|---|---|---|
| T1 | **New regime (s.202, formerly s.115BAC) slabs, FY 2026-27:** 0–4L nil; 4–8L 5%; 8–12L 10%; 12–16L 15%; 16–20L 20%; 20–24L 25%; above 24L 30%. Unchanged from FY 2025-26. | Finance Bill 2026 Memorandum, Part A-IV, p.12 — [indiabudget.gov.in/doc/memo.pdf](https://www.indiabudget.gov.in/doc/memo.pdf) — **OFFICIAL** (bill text; the CA should confirm the enacted Finance Act 2026 has no change) | `rules/income-tax.ts` `TAX_YEARS[2026].newSlabs`; `tax-engine.ts` `slabTax` | TAX-1, TAX-2, YEAR-1…5 |
| T2 | **Rebate (s.156, formerly 87A), new regime:** up to ₹60,000 when total income ≤ ₹12 lakh. Marginal relief just above: tax ≤ income above ₹12 lakh. Old regime: ₹12,500 up to ₹5 lakh, no marginal relief. Residents only. | Memo 2026 / [incometax.gov.in AY 2026-27 help](https://www.incometax.gov.in/iec/foportal/help/individual/return-applicable-1) — OFFICIAL for amounts | `taxAfterRebate` | TAX-1 (₹12,00,000 → 0; ₹12,10,000 → ₹10,400; ₹12,70,500 → ₹73,320; ₹12,70,600 → ₹73,410), TAX-3 (₹5,00,000 / ₹5,00,010) |
| T3 | **Old regime slabs** (Part III, First Schedule): below 60: 2.5L / 5L / 10L at 0 / 5 / 20 / 30%. 60–80: nil to 3L. 80+: nil to 5L, then 20% / 30%. | Memo 2026, p.13 — **OFFICIAL** | `oldSlabs[ageCategory]` | TAX-3 |
| T4 | **Standard deduction (s.19, formerly 16(ia)):** ₹75,000 new regime; ₹50,000 old regime; limited to salary. | Memo 2026 (no change) / secondary — SECONDARY | `calculateTax` | YEAR-*, TAX-1 |
| T5 | **Surcharge:** 10% above ₹50L; 15% above ₹1 cr; 25% above ₹2 cr; 37% above ₹5 cr (old regime only — restricted to 25% under s.202). Marginal relief at each threshold. 4% cess on tax + surcharge. | Memo 2026, pp.13–14 — **OFFICIAL** | `surchargeFor` (marginal relief: tax + surcharge ≤ tax and surcharge at the threshold + income above it) | TAX-2 (₹50,00,000 → 0 surcharge; ₹50,00,010 → surcharge ₹7; ₹1,00,00,010 → ₹2,58,007; 25% cap new / 37% old), YEAR-5 |
| T6 | **Employer NPS (s.124, formerly 80CCD(2)):** added to salary as a perquisite and deductible up to 14% of Basic + DA (new regime) or 10% (old regime). | Finance (No.2) Act 2024 — SECONDARY | `calculateTax` (`employerNps`, `npsSalary`) | TAX-4 |
| T7 | **Employer PF + NPS + superannuation above ₹7.5 lakh/yr** is a taxable perquisite (s.17(1)(h) of the 2025 Act). | Memo 2026 (Schedule XI rationalisation) — **OFFICIAL** | `retirementPerquisite` (interest/accretion on the excess is **not** computed) | TAX-4 |
| T8 | **HRA exemption** (old regime only): least of HRA received; rent − 10% of salary; 50% of salary (metro) or 40% (others). Salary = Basic + DA. **From FY 2026-27 the 50% limit covers 8 cities** (Delhi, Mumbai, Kolkata, Chennai, Bengaluru, Hyderabad, Pune, Ahmedabad). | Income-tax Rules 2026 as reported by [taxguru](https://taxguru.in/income-tax/hra-exemption-8-cities-qualify-50-percent-exemption-practical-guide.html) — **SECONDARY: confirm rule text with CA** | `hraExemption`, `projectTds`; city list `TAX_YEARS[*].hraMetroPattern`; `statutory.ts isMetroLocation(location, period)` | TAX-6, TAX-7 |
| T9 | **Old-regime deductions:** 80C/s.123 ₹1.5L (includes employee PF + VPF); 80D/s.126 self ₹25k (₹50k senior), parents ₹25k (₹50k senior parents); 80CCD(1B) ₹50k; home-loan interest ₹2L; PT up to ₹2,500. | Statute — SECONDARY | `calculateTax` | TAX-3, YEAR-2…5 |
| T10 | **Monthly TDS (s.392):** estimate the year's salary income and spread the tax evenly. The engine uses (annual liability − TDS already deducted, including the previous employer's) ÷ months remaining. Tax on one-time payments (bonus, arrears) is deducted in the month paid. Over-deduction is corrected in later months and never goes negative. Future months use their own PF ceiling and PT schedule. | Memo 2026 Part A-IV; CBDT annual salary-TDS circular (FY 2026-27 circular **not retrieved — UNVERIFIED**) | `projectTds`; `engine.ts` | TAX-8, YEAR-1…5 (12-month simulations: total TDS = hand-computed annual liability) |
| T11 | **Previous employer (Form 130/Form 16, or a certificate):** salary, TDS, PF and PT are added to the projection. | — | `Declarations.previousEmployer*` | TAX-8 |
| T12 | **No PAN:** TDS at the higher of the average rate and 20%, when tax is payable (s.206AA of the 1961 Act; **the 2025-Act section number is UNVERIFIED**). | Statute — SECONDARY | `engine.ts` `noPanApplied` (20% of the month's taxable earnings vs the slab share) | ENGINE-3 |
| T13 | **Rounding:** taxable income to the nearest ₹10; tax to the nearest ₹10; monthly TDS to the nearest rupee. | 1961 Act ss.288A/288B — SECONDARY for the 2025-Act equivalents | `roundTo10`, `roundRupee` | TAX-1 (₹73,414 → ₹73,410) |
| T14 | **Form 124** (formerly Form 12BB) holds the employee's declarations (s.392(5)(b), rule 205). It now requires landlord details for HRA claims. **Form 130** replaces Form 16 (**UNVERIFIED**). | [incometaxindia fn-124](https://www.incometaxindia.gov.in/documents/d/guest/fn-124) — SECONDARY | Declarations come from accepted tax declarations (`payroll.shared.ts loadAcceptedDeclarations`, owned by another module) | — |

**Form 124 / Form 130 data points the engine produces or consumes:**
- Regime and age category.
- Rent paid, landlord PAN (outside the engine) and whether the rented home is in a metro (`rentedInMetro`).
- Home-loan interest.
- 80C, 80D self, 80D parents, 80CCD(1B).
- Other income.
- Previous-employer salary, TDS, PF and PT.
- Per-month taxable income and TDS (payroll lines) feeding Form 130 Part B and the quarterly TDS return.

## 2. EPF / EPS / EDLI

| # | Rule (law) | Source / status | Implementation | Tests |
|---|---|---|---|---|
| P1 | **Wage ceiling ₹25,000/month from 17 Sep 2026** (S.O. 5109(E)), previously ₹15,000 from 1 Sep 2014. It applies to EPF, EPS (pensionable wage) and EDLI. | [PIB 16 Sep 2026](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2310973&reg=48&lang=2), [PIB Kolkata 23 Sep 2026](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2313829&reg=48&lang=2), [PIB Imphal 23 Sep 2026](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2314111&reg=48&lang=2) — **OFFICIAL** | `rules/social-security.ts PF_RULES` | PF-1, PF-4, STRUCT-1 |
| P2 | **September 2026 split:** wages and ceiling are apportioned by days — 1–16 Sep at ₹15,000, 17–30 Sep at ₹25,000 — reported in one ECR. For ₹20,000 wages: EE ₹2,080, EPS ₹1,443.87, EPF ₹636.13, EDLI ₹86.67. | EPFO FAQ Q7–Q10 as reproduced by [SGCMS](https://www.sgcms.com/regulatory-updates/faqs-by-epfo-wage-ceiling-raised-to-25000/) — SECONDARY (EPFO copy not retrieved) | `computePf` segment loop + `segmentsForPeriod`; flag `PF_CEILING_SPLIT` | PF-5 (₹2,080 / ₹1,444 / ₹636 / ₹87 / ₹87) |
| P3 | **Contributions:** employee 12%. Employer 12%, split EPS 8.33% on wages up to the ceiling (max ₹2,083 now, ₹1,250 before) and EPF the balance (3.67%+). EDLI 0.5% (max ₹125). Admin 0.5% of EPF wages, minimum ₹500 per establishment per month (₹75 with no contributing member). | EPFO FAQ Q13 — SECONDARY; PIB (₹2,083) — OFFICIAL | `computePf` | PF-1…PF-4 (all five rows of the FAQ Q13 table) |
| P4 | **Optional actual-wage contribution** above the ceiling (org setting `CEILING`/`ACTUAL`); EPS and EDLI stay capped. | EPF Scheme para 26(6) — SECONDARY | `wageMode` | PF-2 |
| P5 | **Mandatory membership:** an employee whose PF wages are ≤ ₹25,000 must be enrolled, and previously excluded employees are covered from 17 Sep 2026. Members whose wages exceeded the ceiling at joining (after 1 Sep 2014) are not EPS members, so the whole employer 12% goes to EPF. | EPFO FAQ Q13 footnote, Q28–Q31 — SECONDARY | Flag `PF_ENROLMENT_REQUIRED` (danger); structure warning; `epsEligible` flag | ENGINE-2, PF-4 |
| P6 | **VPF** (employee only, on PF wages); **international workers** (no ceiling on PF wages). | Statute — SECONDARY | `vpfRate`, `internationalWorker` | PF-7 |
| P7 | **Labour Code "wages"** (Code on Social Security s.2(88)): when excluded payments (HRA, conveyance, overtime, commission and similar) exceed 50% of total remuneration, the excess is deemed wages. EPFO's FAQ (Q25) tests the ceiling on s.2(88) wages. | Codes in force 21 Nov 2025 (S.O. 5319–5322(E)); Central Rules notified 8 May 2026 — [EY alert](https://www.ey.com/content/dam/ey-unified-site/ey-com/en-in/technical/alerts-hub/documents/2026/05/final-rules-published-by-central-government-under-new-labour-codes.pdf) — SECONDARY | `labourCodeAddBack`; `computePf({totalRemuneration, labourCodeMode})`. Org switch AUTO (default: from the Nov-2025 wage month) / ON / OFF. Flag `LABOUR_CODE_WAGES` | PF-6, ENGINE-5 (Basic 30%: EE PF ₹1,800 → ₹2,892) |

## 3. ESI

| # | Rule | Source / status | Implementation | Tests |
|---|---|---|---|---|
| E1 | Employee 0.75%, employer 3.25% (w.e.f. 1 Jul 2019). | [esic.gov.in/contribution](https://www.esic.gov.in/contribution) — **OFFICIAL** | `ESI_RULES`, `computeEsi` | ESI-1 |
| E2 | Coverage when wages ≤ ₹21,000/month (₹25,000 for persons with disability), w.e.f. 1 Jan 2017. No revision found as of Oct 2026. | [esic.gov.in/coverage](https://esic.gov.in/coverage) — **OFFICIAL** | `esiCoverage(…, {disabled})`, using the structure's rate of wages | ESI-1, ENGINE-5 |
| E3 | Contribution periods Apr–Sep and Oct–Mar: an employee covered at the start of a period stays covered until it ends. | esic.gov.in/contribution — **OFFICIAL** | `esiContributionPeriod`; `esiCoveredEarlierInPeriod` (fed from published runs) | ESI-2 |
| E4 | Average daily wage ≤ ₹176: no employee share; the employer still pays. | esic.gov.in/contribution — **OFFICIAL** | `computeEsi` (wages ÷ payable days) | ESI-3 (₹5,280 → exempt; ₹5,310 → ₹40) |
| E5 | Contributions are on wages paid. Annual bonus and reimbursements are excluded; overtime is included in contributions but not in the coverage test. Rounded up to the next rupee. | ESI Act s.2(22) — SECONDARY; rounding — **UNVERIFIED** | `INPUT_CODES.esiWage`, `ceilRupee` | ESI-1 |

## 4. Professional Tax (Art. 276: max ₹2,500/year)

| State | Current schedule in the engine | Source / status | Tests |
|---|---|---|---|
| KA | Nil below ₹25,000; ₹200; ₹300 in February (w.e.f. 1 Apr 2025) | Karnataka Act 33 of 2025, Notification 232 (15 Apr 2025) — SECONDARY ([lexplosion](https://lexplosion.in/karnataka-govt-notifies-revised-professional-tax-rate-under-karnataka-tax-on-profession-trades-callings-and-employments-amendment-act-2025/)) | PT-1 |
| MH | Men: nil ≤ ₹7,500; ₹175 up to ₹10,000; ₹200 (₹300 Feb). Women: nil ≤ ₹25,000, then ₹200/₹300 | MH PT Act 1975 Sch. I — SECONDARY | PT-2 |
| TN | Half-yearly, on half-year salary: ≤21k nil; 180; 425; 930; 1,025; 1,250 | Greater Chennai Corporation 2024 schedule — SECONDARY; other TN local bodies **UNVERIFIED** | PT-3 |
| KL | Half-yearly: ≤11,999 nil; 320; 450; 600; 750; 1,000; 1,250 | LSGD notification 1149/2024 per taxgarden — **UNVERIFIED** (tables conflict below the top slab) | PT-3 |
| TS / AP | Nil ≤ ₹15,000; ₹150 up to ₹20,000; ₹200 | State Acts 1987 — SECONDARY | PT-4 |
| WB | Nil ≤ ₹10k; ₹110 / ₹130 / ₹150 / ₹200 | WB Act 1979 — SECONDARY | PT-4 |
| GJ | Nil below ₹12,000; ₹200 | GJ Act 1976 — SECONDARY | PT-4 |
| PB | Punjab State Development Tax ₹200/month when annual income > ₹2.5L (proxy: gross × 12) | PB SDT Act 2018 — **UNVERIFIED** (the Act refers to taxable income) | PT-4 |
| DL, HR, UP, RJ | No PT | SECONDARY | PT-4 |
| GA | No PT on salary | **UNVERIFIED** (one vendor lists a Goa schedule) | PT-4 |

**Implementation:**
- `rules/state-levies.ts PT_RULES` holds the schedules. `statutory.ts computePt(state, gross, month, category, period)` applies them.
- Half-yearly states (TN, KL) are deducted in sixths. September and March carry the remainder.
- The state comes from the payroll profile, then the work location, then the organisation default (`resolveState`).

## 5. Labour Welfare Fund

The engine now calculates LWF in each state's deduction months, but **deducts only when the organisation enables it** (`settings.lwfEnabled`, default false). Otherwise it raises the `LWF_NOT_DEDUCTED` info flag in the deduction month. Tests: LWF-1, ENGINE-4.

| State | Employee / Employer · timing | Status |
|---|---|---|
| KA | ₹50 / ₹100 · annual (December) | SECONDARY (one source lists ₹20/₹40) |
| MH | ₹25 / ₹75 · June and December | SECONDARY (≤ ₹3,000 band and managerial exclusion not modelled) |
| TN | ₹20 / ₹40 · annual | **UNVERIFIED** (₹30/₹70 also reported) |
| TS | ₹2 / ₹5 · annual | **UNVERIFIED** |
| AP | ₹30 / ₹70 · annual | SECONDARY |
| WB | ₹3 / ₹30 · June and December | **UNVERIFIED** (employer ₹15 in older tables) |
| GJ | ₹6 / ₹12 · June and December | SECONDARY |
| DL | ₹0.75 / ₹2.25 · June and December (rounded to ₹1 / ₹2 on the payslip) | SECONDARY |
| HR | 0.2% of wages, capped at ₹35 (₹34 before 1 Jan 2026); employer 2× · monthly | SECONDARY (HLWB/REV/2026/3436) |
| KL | ₹50 / ₹50 · monthly | **UNVERIFIED** |
| PB | ₹5 / ₹20 · monthly | **UNVERIFIED** (₹10/₹40 revision reported) |
| GA | ₹60 / ₹180 · June and December | SECONDARY |
| UP, RJ | None | SECONDARY |

## 6. Gratuity, bonus, overtime, minimum wages, LOP, arrears

| # | Rule | Source / status | Implementation | Tests |
|---|---|---|---|---|
| G1 | **Gratuity** = 15/26 × last drawn wages × completed years. A final part-year of more than 6 months counts as a year. Eligibility: 5 years (permanent) or 1 year (fixed-term, Code on Social Security s.53); none needed on death or disablement. Cap ₹20 lakh. | SS Code; cap from S.O. 1420(E) 2018 — SECONDARY (no higher ceiling found) | `computeGratuity`. Monthly provision 4.81% of Basic in `buildStructure`. **Not yet wired into F&F (no F&F module).** | GRAT-1 |
| B1 | **Bonus:** 8.33%–20% of wages capped at max(₹7,000, minimum wage). Eligible if wages ≤ ₹21,000 and at least 30 days worked. Minimum ₹100. | Code on Wages ss.26–27; S.O. 4710/4711(E) of 25 Aug 2026 — **UNVERIFIED** | `computeBonus` (helper; annual bonus is entered as a BONUS input) | BONUS-1 |
| O1 | **Overtime** at 2× the ordinary rate for work beyond 48 h/week. | OSH&WC / Wages Central Rules 2026 (EY alert) — SECONDARY | `overtimePay` helper (26 × 8 divisor is a convention); runs take OT as an amount input (`OVERTIME`, taxable, ESI wage) | OT-1 |
| M1 | **Minimum wages** vary by State, scheduled employment, zone and skill, with half-yearly VDA. **Deliberately not hard-coded.** | — | `MINIMUM_WAGES` placeholder (`VERIFY_FOR_YOUR_STATE`); `settings.minimumWageMonthly` raises the `BELOW_MINIMUM_WAGE` flag | — |
| L1 | **LOP / joiners:** calendar-day proration. A leave spanning two months is split by calendar days and rounded to half days. | Practice — CA to confirm the 26-day or 30-day alternative is not required by contract | `payableDays`, `lopDaysInPeriod`, `prorate` | ENGINE-1, MISC-1 |
| A1 | **Arrears / bonus:** taxed in the month paid through incremental tax. | — | `projectTds` `currentOneTime` | TAX-8 |

**Not implemented for arrears / bonus:**
- s.89 relief (Form 10E) for arrears.
- PF on arrears of Basic.

## 7. Deviations found and fixed (before → after)

| # | Deviation | Before | After |
|---|---|---|---|
| 1 | PF ceiling hard-coded at ₹15,000 | Basic ₹40,000, Oct 2026: EE ₹1,800, EPS ₹1,250, EPF ₹550, EDLI ₹75, admin ₹75 | EE ₹3,000, EPS ₹2,083, EPF ₹917, EDLI ₹125, admin ₹125. September 2026 split by days: ₹20,000 wages → EE ₹2,080 |
| 2 | Old-regime **HRA exemption was never applied** in the TDS projection (HRA was passed as 0, so min(exemption, 0) = 0) | Annual ₹12L salary (HRA ₹2.4L, rent ₹3L): taxable ₹11,50,000, liability ₹1,63,800, TDS ₹13,650/month | Taxable ₹9,10,000, liability ₹98,280, TDS ₹8,190/month |
| 3 | 80D self cap was ₹50,000 for everyone | 80D ₹40,000 declared → ₹40,000 deducted | ₹25,000 (₹50,000 if senior); parents capped separately |
| 4 | Employer NPS deducted without a cap and never added to income | Basic ₹10L + NPS ₹1.5L (new regime): taxable ₹7,75,000 | ₹11,50,000 − 75,000 − 1,40,000 (14% cap) = ₹9,35,000 |
| 5 | Tax not rounded to ₹10 | ₹73,414 | ₹73,410 |
| 6 | HRA metro list had 4 cities | Bengaluru treated as 40% | 8 cities from FY 2026-27, still 4 for earlier years. New structures for Bengaluru, Hyderabad, Pune and Ahmedabad now default HRA to 50% of Basic |
| 7 | Kerala and Punjab had no PT ("State not configured" → ₹0); UP, RJ and GA had no rule | KL employee on ₹50k: PT ₹0 | ₹1,250 per half-year |
| 8 | No LWF | — | Calculated; deducted when enabled |
| 9 | ESI ₹25,000 threshold for persons with disability not supported | Gross ₹24,167 → not covered | Covered when the `disabled` flag is set |
| 10 | Labour Code 50% wage rule only raised a warning | Basic 30% of ₹50k CTC: EE PF ₹1,800 | ₹2,892 (add-back ₹9,100) |
| 11 | Employees marked "PF not applicable" were never challenged | — | Danger flag when PF wages are within the ceiling |
| 12 | No-PAN employees were only flagged | Slab TDS | 20% when tax is payable (₹18L CTC, October: ₹29,640) |
| 13 | No age-based old-regime slabs | Senior on ₹10L taxable: ₹1,17,000 | ₹1,14,400 |
| 14 | The TDS projection assumed this month's PF ceiling for the whole year | ₹6L CTC, old regime: ₹5,686 TDS over-deducted early in the year, then the rebate made liability 0 | Each future month uses its own ceiling → ₹0 TDS |
| 15 | Single-FY rule constants (no effective dates) | Recalculating an old month used the current rules | Versioned tables. FY 2024-25 and 2025-26 are kept (e.g. the ₹7L rebate in 2024-25) |
| 16 | Structure employer PF and ESI used fixed constants | Employer PF ₹1,800 | Rules for the `asOf` date (₹3,000 from 17 Sep 2026) |

## 8. Known limitations and items needing a CA or client decision

1. **Labour Code wage definition.** The engine treats Basic (+DA) as wages and every other component as "excluded" for the 50% test. The denominator is the month's earned fixed gross; one-time items are left out.
   - **Alternative reading (CA decision):** special and other allowances that are not in the s.2(88) exclusion list are wages in their own right. That reading follows the Supreme Court's 2019 *Vivekananda Vidyamandir* ruling on universally paid allowances.
   - **ESI and gratuity:** the 50% rule is applied to PF only. ESI wages stay as gross wages paid, and gratuity uses Basic. The CA should decide whether to extend the rule.
   - **Start date:** AUTO starts from the November 2025 wage month. Under the Code it applies from 21 Nov 2025.
2. **September 2026 PF split** follows the EPFO FAQ as reproduced by a secondary site; please confirm against EPFO's own circular. Not modelled:
   - Deferred recovery of the September employee share (FAQ Q10/Q11).
   - EPS enrolment starting from 17 Sep for previously excluded members (FAQ Scenario B).
3. **CTC overrun after the ceiling change.** Structures built before 17 Sep 2026 priced employer PF at ₹1,800; actual employer PF is now up to ₹3,000. EPFO FAQ Q15 says employers cannot recover this from wages. The client must decide whether to restructure CTC.
4. **EPS eligibility and age 58 / international workers.** These are per-employee flags (`epsEligible`, `internationalWorker`), default true / false. The DB column exists (031) but is not yet wired. EPS stopping at age 58 is not automatic because there is no DOB in payroll. The EPS treatment for international workers needs CA confirmation.
5. **PF admin ₹500 minimum** is an establishment-level challan item and is not applied per employee.
6. **Unverified state data** must be checked against State gazettes before LWF is enabled or KL/PB/GA PT is relied on:
   - PT: Kerala, Punjab, Goa (nil), Tamil Nadu outside Chennai.
   - LWF: TN, TS, WB, KL, PB.
7. **LWF registration and applicability** (establishment type, managerial exclusions) is a client decision, so LWF is off by default.
8. **Minimum wages** need the client to supply the notified rates per State, employment and skill.
9. **HRA 8-city rule, Form 130 and 2025-Act section numbers** for ss.206AA/288A/288B are SECONDARY or UNVERIFIED.
10. **Gratuity "4 years 240 days" continuous-service case law** is not applied; the engine requires a full 5 years.
11. **Not implemented:**
    - s.89 relief on arrears.
    - Perquisite valuation (car, accommodation, ESOPs).
    - LTA exemption claims.
    - Interest on excess employer retirement contributions.
    - Special-rate income.
    - Non-resident employees (87A rebate is residents only; residency is not captured).
    - Lower-deduction certificates.
12. **The new-regime rebate** is applied to all slab income; special-rate income is out of scope.
13. **Calendar-day LOP proration** — confirm it matches employment contracts.
14. **PT** is computed on the month's gross including one-time earnings. Some states use salary excluding bonus — confirm.

## 9. Sign-off checklist

| Rule | Implemented | Tested | Source status | CA verified |
|---|---|---|---|---|
| T1 New-regime slabs FY 2026-27 | Yes | TAX-1/2, YEAR-1…5 | OFFICIAL (Bill memo) | ☐ |
| T2 Rebate ₹60k / ₹12L + marginal relief; old ₹12.5k / ₹5L | Yes | TAX-1, TAX-3 | OFFICIAL | ☐ |
| T3 Old-regime slabs incl. senior / super-senior | Yes | TAX-3 | OFFICIAL | ☐ |
| T4 Standard deduction ₹75k / ₹50k | Yes | YEAR-* | SECONDARY | ☐ |
| T5 Surcharge, marginal relief, 25% cap, 4% cess | Yes | TAX-2, YEAR-5 | OFFICIAL | ☐ |
| T6 Employer NPS 14% / 10% | Yes | TAX-4 | SECONDARY | ☐ |
| T7 ₹7.5L retirement perquisite | Partial (no interest) | TAX-4 | OFFICIAL | ☐ |
| T8 HRA exemption, 8 metros | Yes | TAX-6/7 | SECONDARY | ☐ |
| T9 Old-regime deduction caps | Yes | TAX-3 | SECONDARY | ☐ |
| T10 Monthly TDS projection (s.392) | Yes | TAX-8, YEAR-* | UNVERIFIED (CBDT circular) | ☐ |
| T11 Previous-employer income / TDS | Yes | TAX-8 | — | ☐ |
| T12 No-PAN 20% | Yes | ENGINE-3 | SECONDARY | ☐ |
| T13 ₹10 rounding | Yes | TAX-1 | SECONDARY | ☐ |
| P1 PF ceiling ₹25,000 from 17 Sep 2026 | Yes | PF-1/4, STRUCT-1 | OFFICIAL | ☐ |
| P2 September 2026 day-split | Yes | PF-5 | SECONDARY | ☐ |
| P3 EE / EPS / EPF / EDLI / admin split | Yes | PF-1…4 | SECONDARY | ☐ |
| P4 Actual-wage option | Yes | PF-2 | SECONDARY | ☐ |
| P5 Mandatory enrolment / EPS eligibility | Flag + switch | ENGINE-2, PF-4 | SECONDARY | ☐ |
| P6 VPF / international worker | Yes (flag not wired) | PF-7 | SECONDARY | ☐ |
| P7 Labour Code 50% wage rule (PF) | Yes (AUTO switch) | PF-6, ENGINE-5 | SECONDARY — **interpretation needed** | ☐ |
| E1–E4 ESI rates, threshold, period, ₹176 | Yes | ESI-1/2/3, ENGINE-5 | OFFICIAL | ☐ |
| E5 ESI rounding up | Yes | ESI-1 | UNVERIFIED | ☐ |
| PT KA / MH / TN / TS / AP / WB / GJ | Yes | PT-1…4 | SECONDARY | ☐ |
| PT KL / PB / GA | Yes | PT-3/4 | UNVERIFIED | ☐ |
| PT DL / HR / UP / RJ (nil) | Yes | PT-4 | SECONDARY | ☐ |
| LWF (all states) | Yes (opt-in) | LWF-1, ENGINE-4 | SECONDARY / UNVERIFIED | ☐ |
| G1 Gratuity | Helper + provision | GRAT-1 | SECONDARY | ☐ |
| B1 Bonus | Helper | BONUS-1 | UNVERIFIED | ☐ |
| O1 Overtime 2× | Helper | OT-1 | SECONDARY | ☐ |
| M1 Minimum wages | Placeholder + flag | — | Client to configure | ☐ |
| L1 LOP / joiner proration | Yes | ENGINE-1, MISC-1 | Practice | ☐ |

CA name / membership no.: ____________ Signature / date: ____________

---

## 10. Returns — TDS deposits, quarterly statement, annual certificate (added 20–24 Oct 2026)

> Same status as the rest of this pack: **not CA-verified**. Code: `src/platform/payroll-returns/` (migration `035_tds_returns.sql`), UI `/payroll/returns` (admin) and `/payroll/returns/documents` (employee). Tests: `npx tsx --test src/platform/payroll-returns/returns.test.ts` → 16 pass.

**Form names (Income-tax Act 2025).** From Tax Year 2026-27 (AY 2027-28) the quarterly salary TDS statement is **Form 138** (formerly 24Q) and the annual certificate is **Form 130** (formerly Form 16). Form 130 has Part A (basic details), Part B (quarterly TDS summary) and Part C (computation, Annexure I salary, **Annexure II perquisites — formerly Form 12BA**). Form 138: **OFFICIAL** (Protean file format and RPU/FVU 1.2 "for TY 2026-27 onward"). Form 130 structure and the 15 June due date: **SECONDARY** ([taxguru](https://taxguru.in/income-tax/form-130-tds-certificate-salary-replacing-form-16.html); the incometaxindia Form 130 FAQ returned HTTP 403). Whether TRACES still issues a separate "Part A" for Form 130 is **UNVERIFIED** — the product keeps the TRACES upload and labels the documents "Form 130 (formerly Form 16)". Years before 2026-27 are labelled Form 24Q / Form 16 / Form 12BA.

| # | Rule | Source / status | Implementation | Tests |
|---|---|---|---|---|
| R1 | **Deposit due date:** 7th of the following month; tax deducted in March: 30 April (non-government deductor, challan). Rule 218 of the Income-tax Rules 2026. | SECONDARY (taxguru / tdsman compliance calendars) | `tds-math.ts depositDueDate` | TDS-DUE |
| R2 | **Interest on late deposit:** 1.5% per month or part of a month from the date of deduction to the date of deposit (s.201(1A)(ii) of the 1961 Act; s.398(3)(a)(ii) of the 2025 Act per secondary source). Months counted as calendar months touched (TRACES practice) and principal rounded down to ₹100 (rule 119A of the 1962 Rules). The 1% "deductible but not deducted" leg does not arise for salary deducted on payment. | Rate SECONDARY; **counting method and rounding UNVERIFIED** | `lateDepositInterest`; flagged per month in the workspace (estimate vs interest paid on the challan) | TDS-DUE |
| R3 | **Statement due dates:** Q1 31 Jul, Q2 31 Oct, Q3 31 Jan, Q4 31 May. Late-filing fee (old s.234E, ₹200/day) is not computed. | SECONDARY | `statementDueDate` | — |
| R4 | **Form 138 Q1–Q3 text file** for FVU: `^`-delimited, CRLF; FH 18 / BH 72 / CD 30 / DD 45 fields; FH file type `SL1`, BH form `138`, AY `202728`, TY `202627`; CD tax = tax + surcharge + cess, interest / fee / penalty separate, minor head 200; DD section code **1002** (s.392, non-Govt employees); deductee deposited = deducted; no PAN → `PANNOTAVBL` with remark **C**, which needs TDS ≥ 20% of the amount paid; BH field 9/52 previous token when an earlier quarter is marked filed. | **OFFICIAL** — Protean "File Format … Form Number 138 (24Q) – Q1 to Q3" (`Form Number 138-24Q - Q1 to Q3_22072026.xlsx`, sheet says Version 1.1, page lists 1.2) read 20 Oct 2026 | `form138.ts buildForm138Text` | 24Q-TOTALS (field counts, line numbers, challan = Σ deductee, batch total = Σ challans, no-PAN rows) |
| R5 | **Q4 (Annexure II salary details):** Protean lists the Form 138 Q4 format as "expected to be released soon". No Q4 text file is produced; Annexure I/II are exported as CSV templates (column set follows the 24Q Q4 Annexure II items — **UNVERIFIED**). | OFFICIAL (not yet published) | `annexureIIRow`, `/files/annexure2` | — |
| R6 | **Validation:** deductor TAN/PAN/address/state code/PIN/e-mail/phone and responsible person incl. PAN (BH field 59); ≥ 1 deductee; deducted (published/locked payroll + pre-switch-over months) = allocated + unallocated; unallocated TDS = "deducted, not deposited" (error); challan over-allocation (error) / unused deposit (warning); payment date inside the quarter; challan date ≥ 1 April of the previous year; no-PAN 20% check. | OFFICIAL file-format remarks | `validateDeductor`, `validateQuarter` | 24Q-VALIDATION, 24Q-TOTALS |
| R7 | **Annual certificate computation** = the engine's year-end projection on actual figures: published/locked lines + switch-over opening YTD (`imports/ytd.shared.ts`) + previous-employer income/TDS from declarations. Gross 17(1) by component, perquisites 17(2) (employer PF+NPS+superannuation above ₹7.5 lakh, employer NPS), HRA exemption (old regime), standard deduction, PT, Chapter VI-A/VIII, rebate incl. marginal relief, surcharge, cess, relief u/s 89 (input only — **not computed**), TDS this/previous employer, quarterly deducted/deposited with statement token numbers and challan BSR/date/serial. | Per §1 rows T1–T13 | `form16.ts computeForm16` | F16-6L/12L/18L × NEW/OLD = engine liability = TDS deducted (₹0 / ₹0 / ₹0 / ₹1,47,120 / ₹1,46,310 / ₹3,34,320), F16-STRUCTURE, F16-OLD, F16-JOINER (opening YTD + previous employer), F16-NEW-JOINER |
| R8 | **Perquisite statement** (12BA rows). Payroll records only employer retirement contributions; non-cash perquisites (accommodation, car, ESOP…) and interest accretion on the ₹7.5 lakh excess are shown as nil. | Rule 26A of the 1962 Rules (2026-Rules equivalent UNVERIFIED) | `PERQUISITE_ITEMS`, `renderPerquisitesPdf` | PDF-1 |
| R9 | **Mid-year generation** is labelled PROVISIONAL (year-to-date figures, not a certificate) until the March payroll is published or the employee has left. | Product rule | `computeForm16.provisional` | — |

**Controls.**
- Challans and allocations of a quarter are frozen once the quarter is marked FILED with its 15-digit token.
- Certificates: maker-checker. Only PAYROLL_ADMIN/OWNER can publish, never the person who generated them (DB CHECK too). Published sets are frozen.
- The employee sees only their own documents, and only after publishing; other employees' documents return 404.
- PAN is decrypted only when a file or PDF is built, and every download is audited (`TDS_RETURN_EXPORTED`, `TAX_DOCUMENT_DOWNLOADED`, `FILE_DOWNLOADED`).
- The TRACES Part A is stored through FilesService (entity `tax_document_part_a`) and embedded unchanged as a PDF attachment, so its digital signature stays valid. Re-paginating a signed PDF would break it.

**Needs a CA / client:**
- Confirm R1–R3 (Rules 2026 text), the interest counting method (R2) and the Form 130 layout.
- Run every generated file through Protean FVU 1.2 together with the .csi challan file before upload. This was not done here: FVU is a Java utility downloaded from Protean and was not run.
- Book-adjustment (government) deductors, lower-deduction certificates (remark A), and correction statements are not supported.

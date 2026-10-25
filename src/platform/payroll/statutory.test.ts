/**
 * Statutory payroll rules — worked examples. Every expected number is computed by hand in the comment above the
 * assertion (₹, whole rupees). Run: npx tsx --test src/platform/payroll/statutory.test.ts
 * Test names are referenced from docs/payroll-statutory-review.md.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  computeBonus, computeEsi, computeGratuity, computeLwf, computePf, computePt, esiContributionPeriod, esiCoverage, isMetroLocation,
  labourCodeAddBack, lopDaysInPeriod, overtimePay, parsePeriod, payableDays, prorate, resolveState, RULESET, PT_STATES, addMonths,
} from "./statutory";
import { calculateTax, hraExemption, projectTds } from "./tax-engine";
import { buildStructure } from "./structure";
import { calculateLine, type LineContext } from "./engine";
import { PF_RULES, segmentsForPeriod, taxRulesFor } from "./rules";

const FY = 2026; // FY 2026-27 (Tax Year 2026-27, AY 2027-28)

// ================================================================ PF / EPS / EDLI

test("PF-1 pre-Sep-2026: contributions capped at the ₹15,000 wage ceiling", () => {
  // Basic 40,000, Aug 2026: PF wage = 15,000 → 12% = 1,800; EPS 8.33% × 15,000 = 1,249.5 → 1,250; EPF ER 1,800 − 1,250 = 550;
  // EDLI 0.5% × 15,000 = 75; admin 0.5% × 15,000 = 75.
  const pf = computePf({ basicEarned: 40000, applicable: true, wageMode: "CEILING", period: "2026-08" });
  assert.deepEqual([pf.pfWage, pf.employee, pf.employerTotal, pf.employerEps, pf.employerEpf, pf.edli, pf.admin], [15000, 1800, 1800, 1250, 550, 75, 75]);
});

test("PF-2 pre-Sep-2026: actual-Basic option keeps EPS capped at ₹1,250 and EDLI at ₹75", () => {
  // PF wage 40,000 → 4,800 each side; EPS 1,250; EPF ER 3,550; EDLI 75; admin 0.5% × 40,000 = 200.
  const pf = computePf({ basicEarned: 40000, applicable: true, wageMode: "ACTUAL", period: "2026-08" });
  assert.deepEqual([pf.pfWage, pf.employee, pf.employerEps, pf.employerEpf, pf.edli, pf.admin], [40000, 4800, 1250, 3550, 75, 200]);
});

test("PF-3 below the ceiling uses earned Basic; EPS rounding; excluded employee pays nothing", () => {
  // 9,000 × 12% = 1,080; EPS 8.33% × 9,000 = 749.7 → 750; EPF ER 330.
  const pf = computePf({ basicEarned: 9000, applicable: true, wageMode: "CEILING", period: "2026-08" });
  assert.deepEqual([pf.employee, pf.employerEps, pf.employerEpf], [1080, 750, 330]);
  assert.equal(computePf({ basicEarned: 9000, applicable: false, wageMode: "CEILING", period: "2026-08" }).employee, 0);
});

test("PF-4 ceiling ₹25,000 from Oct 2026 — EPFO FAQ Q13 table", () => {
  // EPFO FAQ Q13 (wage month October 2026 onwards):
  //  wage   EE 12%  EPS 8.33%  EPF ER  EDLI  Admin
  //  10,000  1,200    833       367     50    50
  //  15,000  1,800  1,250       550     75    75
  //  20,000  2,400  1,666       734    100   100
  //  25,000  3,000  2,083       917    125   125   (8.33% × 25,000 = 2,082.5 → 2,083)
  //  35,000  3,000  2,083       917    125   125   (ceiling; Q13 shows EPS 0 only for members not eligible for EPS)
  const rows: [number, number[]][] = [[10000, [1200, 833, 367, 50, 50]], [15000, [1800, 1250, 550, 75, 75]], [20000, [2400, 1666, 734, 100, 100]], [25000, [3000, 2083, 917, 125, 125]], [35000, [3000, 2083, 917, 125, 125]]];
  for (const [wage, expected] of rows) {
    const pf = computePf({ basicEarned: wage, applicable: true, wageMode: "CEILING", period: "2026-10" });
    assert.deepEqual([pf.employee, pf.employerEps, pf.employerEpf, pf.edli, pf.admin], expected, `wage ${wage}`);
  }
  // Not an EPS member (joined above the ceiling after Sep 2014): whole 12% employer share goes to EPF (FAQ Q13 footnote).
  const noEps = computePf({ basicEarned: 35000, applicable: true, wageMode: "CEILING", period: "2026-10", epsEligible: false });
  assert.deepEqual([noEps.employerEps, noEps.employerEpf], [0, 3000]);
});

test("PF-5 September 2026 split month — EPFO FAQ Q7 scenario C (₹20,000 wages)", () => {
  // 1–16 Sep at ₹15,000 ceiling, 17–30 Sep at ₹25,000, apportioned by days (30-day month):
  //  period 1: min(20,000 × 16/30 = 10,666.67, 15,000 × 16/30 = 8,000) = 8,000
  //  period 2: min(20,000 × 14/30 = 9,333.33, 25,000 × 14/30 = 11,666.67) = 9,333.33
  //  EPF wage = EPS wage = 17,333.33 → EE 12% = 2,080; EPS 8.33% = 1,443.87 → 1,444; EPF ER 2,080 − 1,444 = 636
  //  EDLI 0.5% = 86.67 → 87; admin 0.5% = 87.  (FAQ shows paise: 2,080.00 / 1,443.87 / 636.13 / 86.67 / 86.67.)
  const pf = computePf({ basicEarned: 20000, applicable: true, wageMode: "CEILING", period: "2026-09" });
  assert.deepEqual([pf.pfWage, pf.employee, pf.employerEps, pf.employerEpf, pf.edli, pf.admin], [17333, 2080, 1444, 636, 87, 87]);
  assert.equal(pf.ceilingSegments.length, 2);
  // Wages above both ceilings: 8,000 + 11,666.67 = 19,666.67 → EE 2,360; EPS 1,638.23 → 1,638.
  const high = computePf({ basicEarned: 60000, applicable: true, wageMode: "CEILING", period: "2026-09" });
  assert.deepEqual([high.pfWage, high.employee, high.employerEps], [19667, 2360, 1638]);
  const seg = segmentsForPeriod(PF_RULES, "2026-09");
  assert.deepEqual(seg.segments.map((s) => [s.fromDay, s.toDay, s.rule.wageCeiling]), [[1, 16, 15000], [17, 30, 25000]]);
});

test("PF-6 Labour Code wage definition: allowances above 50% of remuneration added back", () => {
  // Remuneration 1,00,000, Basic 30,000 → excluded 70,000; limit 50% = 50,000; add-back 20,000 → wages 50,000.
  assert.equal(labourCodeAddBack({ includedWages: 30000, totalRemuneration: 100000, period: "2026-10" }).addBack, 20000);
  const actual = computePf({ basicEarned: 30000, applicable: true, wageMode: "ACTUAL", period: "2026-10", totalRemuneration: 100000 });
  assert.deepEqual([actual.wages, actual.pfWage, actual.employee], [50000, 50000, 6000]);
  // With the ceiling the PF wage is still ₹25,000 (wages above it).
  assert.equal(computePf({ basicEarned: 30000, applicable: true, wageMode: "CEILING", period: "2026-10", totalRemuneration: 100000 }).pfWage, 25000);
  // Before the Codes (Oct 2025) and with the org switch OFF: no add-back.
  assert.equal(labourCodeAddBack({ includedWages: 30000, totalRemuneration: 100000, period: "2025-10" }).addBack, 0);
  assert.equal(labourCodeAddBack({ includedWages: 30000, totalRemuneration: 100000, period: "2026-10", mode: "OFF" }).addBack, 0);
  // Basic exactly 50% → nothing added.
  assert.equal(labourCodeAddBack({ includedWages: 50000, totalRemuneration: 100000, period: "2026-10" }).addBack, 0);
});

test("PF-7 VPF and international worker", () => {
  // VPF 10% of PF wages (actual Basic 40,000) = 4,000 on top of statutory 12%.
  const vpf = computePf({ basicEarned: 40000, applicable: true, wageMode: "CEILING", period: "2026-10", vpfRate: 0.1 });
  assert.deepEqual([vpf.employee, vpf.vpf], [3000, 4000]);
  // International worker: no ceiling on PF wages (12% × 80,000 = 9,600); EPS on capped wage 25,000 → 2,083.
  const iw = computePf({ basicEarned: 80000, applicable: true, wageMode: "CEILING", period: "2026-10", internationalWorker: true });
  assert.deepEqual([iw.pfWage, iw.employee, iw.employerEps], [80000, 9600, 2083]);
});

// ================================================================ ESI

test("ESI-1 threshold ₹21,000 inclusive; ₹25,000 for persons with disability; rounding up", () => {
  assert.equal(esiCoverage(21000, false, { period: "2026-10" }).covered, true);
  assert.equal(esiCoverage(21001, false, { period: "2026-10" }).covered, false);
  assert.equal(esiCoverage(25000, false, { disabled: true, period: "2026-10" }).covered, true);
  assert.equal(esiCoverage(25001, false, { disabled: true, period: "2026-10" }).covered, false);
  // 18,500 × 0.75% = 138.75 → 139; × 3.25% = 601.25 → 602.
  const esi = computeEsi({ covered: true, wages: 18500, payableDays: 30, period: "2026-10" });
  assert.deepEqual([esi.employee, esi.employer], [139, 602]);
  assert.equal(computeEsi({ covered: false, wages: 25000, payableDays: 30 }).employer, 0);
});

test("ESI-2 contribution period continuation (Apr–Sep / Oct–Mar)", () => {
  // Covered in April at ₹20,000; increment to ₹24,000 in July → still covered until September.
  assert.equal(esiCoverage(24000, true, { period: "2026-07" }).covered, true);
  assert.deepEqual(esiContributionPeriod("2026-09"), { from: "2026-04", to: "2026-09" });
  assert.deepEqual(esiContributionPeriod("2027-02"), { from: "2026-10", to: "2027-03" });
});

test("ESI-3 average daily wage ≤ ₹176 pays no employee share", () => {
  // 5,000 / 30 = 166.67 ≤ 176 → employee 0; employer 3.25% × 5,000 = 162.5 → 163.
  const esi = computeEsi({ covered: true, wages: 5000, payableDays: 30 });
  assert.deepEqual([esi.lowWageExempt, esi.employee, esi.employer], [true, 0, 163]);
  // 5,280 / 30 = 176.00 → still exempt; 5,310 / 30 = 177 → employee 0.75% = 39.825 → 40.
  assert.equal(computeEsi({ covered: true, wages: 5280, payableDays: 30 }).employee, 0);
  assert.equal(computeEsi({ covered: true, wages: 5310, payableDays: 30 }).employee, 40);
});

// ================================================================ Professional Tax

test("PT-1 Karnataka: nil below ₹25,000, ₹200, ₹300 in February (₹2,500/yr)", () => {
  assert.equal(computePt("KA", 24999, 9, "STANDARD", "2026-09").amount, 0);
  assert.equal(computePt("KA", 25000, 9, "STANDARD", "2026-09").amount, 200);
  assert.equal(computePt("KA", 60000, 2, "STANDARD", "2027-02").amount, 300);
  let year = 0;
  for (let i = 0; i < 12; i++) { const period = addMonths("2026-04", i); year += computePt("KA", 60000, 0, "STANDARD", period).amount; }
  assert.equal(year, 2500);
});

test("PT-2 Maharashtra: men's slabs, women's ₹25,000 threshold, February ₹300", () => {
  assert.equal(computePt("MH", 7500, 9, "STANDARD", "2026-09").amount, 0);
  assert.equal(computePt("MH", 9000, 9, "STANDARD", "2026-09").amount, 175);
  assert.equal(computePt("MH", 9000, 2, "STANDARD", "2027-02").amount, 175, "₹175 slab has no February top-up");
  assert.equal(computePt("MH", 30000, 9, "STANDARD", "2026-09").amount, 200);
  assert.equal(computePt("MH", 30000, 2, "STANDARD", "2027-02").amount, 300);
  assert.equal(computePt("MH", 25000, 9, "WOMAN", "2026-09").amount, 0);
  assert.equal(computePt("MH", 25001, 9, "WOMAN", "2026-09").amount, 200);
  assert.equal(computePt("MH", 30000, 2, "WOMAN", "2027-02").amount, 300);
});

test("PT-3 half-yearly states (Tamil Nadu, Kerala) deduct sixths with the remainder in Sep/Mar", () => {
  // TN: ₹20,000/month → ₹1,20,000 half-year → ₹1,250: 208 × 5 + 210.
  assert.equal(computePt("TN", 20000, 8, "STANDARD", "2026-08").amount, 208);
  assert.equal(computePt("TN", 20000, 9, "STANDARD", "2026-09").amount, 210);
  // TN: ₹3,400/month → ₹20,400 half-year ≤ ₹21,000 → nil.
  assert.equal(computePt("TN", 3400, 9, "STANDARD", "2026-09").amount, 0);
  // KL: ₹4,000/month → ₹24,000 half-year → slab ₹18,000–29,999 = ₹450 → 75 × 6.
  assert.equal(computePt("KL", 4000, 10, "STANDARD", "2026-10").amount, 75);
  assert.equal(computePt("KL", 4000, 3, "STANDARD", "2027-03").amount, 75);
  // KL: ₹50,000/month → ₹3,00,000 half-year → ₹1,250.
  assert.equal(computePt("KL", 50000, 3, "STANDARD", "2027-03").amount, 210);
});

test("PT-4 monthly states and states without PT", () => {
  assert.equal(computePt("TS", 15000, 9, "STANDARD", "2026-09").amount, 0);
  assert.equal(computePt("TS", 18000, 9, "STANDARD", "2026-09").amount, 150);
  assert.equal(computePt("TS", 30000, 9, "STANDARD", "2026-09").amount, 200);
  assert.equal(computePt("AP", 20001, 9, "STANDARD", "2026-09").amount, 200);
  assert.equal(computePt("WB", 12000, 9, "STANDARD", "2026-09").amount, 110);
  assert.equal(computePt("WB", 30000, 9, "STANDARD", "2026-09").amount, 150);
  assert.equal(computePt("WB", 50000, 9, "STANDARD", "2026-09").amount, 200);
  assert.equal(computePt("GJ", 11999, 9, "STANDARD", "2026-09").amount, 0);
  assert.equal(computePt("GJ", 12000, 9, "STANDARD", "2026-09").amount, 200);
  // Punjab development tax: ₹200 when annualised income > ₹2.5 lakh (₹21,000 × 12 = 2,52,000).
  assert.equal(computePt("PB", 21000, 9, "STANDARD", "2026-09").amount, 200);
  assert.equal(computePt("PB", 20000, 9, "STANDARD", "2026-09").amount, 0);
  for (const state of ["DL", "HR", "UP", "RJ", "GA"]) assert.equal(computePt(state, 90000, 2, "STANDARD", "2027-02").amount, 0, state);
  assert.equal(computePt("KA", 90000, 2, "EXEMPT", "2027-02").amount, 0);
  // Every state in INDIAN_STATES (except OTHER) has a PT rule.
  for (const state of ["KA", "MH", "TN", "TS", "AP", "WB", "GJ", "DL", "HR", "KL", "UP", "RJ", "PB", "GA"]) assert.ok(PT_STATES[state], state);
});

// ================================================================ LWF

test("LWF-1 deduction months, amounts and Haryana percentage cap", () => {
  // Karnataka: annual, December: ₹50 / ₹100; nothing in November.
  assert.deepEqual([computeLwf("KA", 50000, "2026-12").employee, computeLwf("KA", 50000, "2026-12").employer], [50, 100]);
  assert.equal(computeLwf("KA", 50000, "2026-11").employee, 0);
  // Maharashtra: June and December ₹25 / ₹75.
  assert.deepEqual([computeLwf("MH", 40000, "2026-06").employee, computeLwf("MH", 40000, "2026-06").employer], [25, 75]);
  // Haryana: 0.2% of ₹10,000 = ₹20, employer ₹40; ₹50,000 → 0.2% = ₹100 capped at ₹35 (2026) / ₹34 (2025).
  assert.deepEqual([computeLwf("HR", 10000, "2026-10").employee, computeLwf("HR", 10000, "2026-10").employer], [20, 40]);
  assert.deepEqual([computeLwf("HR", 50000, "2026-10").employee, computeLwf("HR", 50000, "2026-10").employer], [35, 70]);
  assert.equal(computeLwf("HR", 50000, "2025-12").employee, 34);
  assert.equal(computeLwf("UP", 50000, "2026-12").employee, 0);
});

// ================================================================ Gratuity / bonus / overtime / minimum wages

test("GRAT-1 gratuity 15/26 × wages × years, 6-month round-up, fixed-term after 1 year, ₹20 lakh cap", () => {
  // 50,000 × 15/26 × 5 = 1,44,230.77 → 1,44,231 (5 years 2 months: 2 months ≤ 6 → 5 years).
  assert.equal(computeGratuity({ lastDrawnWages: 50000, serviceYears: 5, serviceMonths: 2 }).amount, 144231);
  // 5 years 7 months → 6 years: 50,000 × 15/26 × 6 = 1,73,076.92 → 1,73,077.
  assert.equal(computeGratuity({ lastDrawnWages: 50000, serviceYears: 5, serviceMonths: 7 }).amount, 173077);
  // Permanent employee with 4 years 7 months: not eligible (see CA item on 4 years 240 days).
  assert.equal(computeGratuity({ lastDrawnWages: 50000, serviceYears: 4, serviceMonths: 7 }).eligible, false);
  // Fixed-term, 1 year 7 months → 2 years: 50,000 × 15/26 × 2 = 57,692.31 → 57,692.
  assert.equal(computeGratuity({ lastDrawnWages: 50000, serviceYears: 1, serviceMonths: 7, fixedTerm: true }).amount, 57692);
  // 5,00,000 × 15/26 × 30 = 86,53,846 → capped at 20,00,000.
  const capped = computeGratuity({ lastDrawnWages: 500000, serviceYears: 30, serviceMonths: 0 });
  assert.deepEqual([capped.amount, capped.capped], [2000000, true]);
});

test("BONUS-1 statutory bonus: ₹21,000 eligibility, ₹7,000 / minimum-wage calculation ceiling, 8.33%–20%", () => {
  // Wages 15,000 × 12; ceiling 7,000 → bonus wages 84,000 × 8.33% = 6,997.2 → 6,997.
  assert.equal(computeBonus({ monthlyWages: Array(12).fill(15000), rate: 0.0833, daysWorked: 300 }).amount, 6997);
  // Minimum wage 12,000 > 7,000 → 1,44,000 × 8.33% = 11,995.2 → 11,995; rate above 20% is capped at 20% → 28,800.
  assert.equal(computeBonus({ monthlyWages: Array(12).fill(15000), rate: 0.0833, minimumWage: 12000, daysWorked: 300 }).amount, 11995);
  assert.equal(computeBonus({ monthlyWages: Array(12).fill(15000), rate: 0.3, minimumWage: 12000, daysWorked: 300 }).amount, 28800);
  assert.equal(computeBonus({ monthlyWages: Array(12).fill(25000), rate: 0.0833, daysWorked: 300 }).eligible, false);
  assert.equal(computeBonus({ monthlyWages: Array(12).fill(15000), rate: 0.0833, daysWorked: 20 }).eligible, false);
});

test("OT-1 overtime at twice the ordinary rate", () => {
  // 26,000 / (26 × 8) = ₹125/hour × 2 × 10 h = ₹2,500.
  assert.equal(overtimePay({ monthlyWages: 26000, hours: 10 }), 2500);
});

// ================================================================ Income tax — annual

test("TAX-1 new regime ₹12 lakh rebate edge with marginal relief", () => {
  // Gross 12,75,000 − SD 75,000 = 12,00,000 → slab tax 60,000 − rebate 60,000 = 0.
  assert.equal(calculateTax({ basic: 1275000, fyStartYear: FY }, "NEW").annualLiability, 0);
  // Taxable 12,10,000: slab tax 60,000 + 1,500 = 61,500 > income above 12L (10,000) → relief 51,500 → 10,000 + cess 400 = 10,400.
  const above = calculateTax({ basic: 1285000, fyStartYear: FY }, "NEW");
  assert.deepEqual([above.taxableIncome, above.marginalRelief, above.annualLiability], [1210000, 51500, 10400]);
  // Taxable 12,70,500: slab 60,000 + 10,575 = 70,575 > 70,500 → tax 70,500; cess 2,820 → 73,320.
  assert.equal(calculateTax({ basic: 1345500, fyStartYear: FY }, "NEW").annualLiability, 73320);
  // Taxable 12,70,600: slab 70,590 < 70,600 → no relief; cess 2,823.6 → 2,824 → 73,414 → rounded to ₹10 = 73,410.
  const past = calculateTax({ basic: 1345600, fyStartYear: FY }, "NEW");
  assert.deepEqual([past.marginalRelief, past.annualLiability], [0, 73410]);
});

test("TAX-2 new regime surcharge edges at ₹50 lakh and ₹1 crore with marginal relief; 25% cap", () => {
  // Taxable 50,00,000 (no surcharge — "exceeding" ₹50 lakh): slabs to 24L = 20,000 + 40,000 + 60,000 + 80,000 + 1,00,000
  //   = 3,00,000; 26,00,000 × 30% = 7,80,000 → 10,80,000.
  const at50 = calculateTax({ basic: 5075000, fyStartYear: FY }, "NEW");
  assert.deepEqual([at50.taxableIncome, at50.surcharge, at50.annualLiability], [5000000, 0, 1123200]); // 10,80,000 + 4% 43,200
  // Taxable 50,00,010: tax 10,80,003; 10% surcharge 1,08,000 capped by marginal relief to (10,80,000 + 10) − 10,80,003 = 7.
  const over50 = calculateTax({ basic: 5075010, fyStartYear: FY }, "NEW");
  assert.deepEqual([over50.surcharge, over50.annualLiability], [7, 1123210]); // 10,80,010 + cess 43,200.4 → 43,200 → 11,23,210
  // Taxable 1,00,00,010: tax 3,00,000 + 76,00,010 × 30% = 25,80,003; 15% = 3,87,000; cap = 25,80,000 + 10% (2,58,000) + 10
  //   → surcharge 28,38,010 − 25,80,003 = 2,58,007; cess 4% × 28,38,010 = 1,13,520.4 → 1,13,520; total 29,51,530.
  const over1cr = calculateTax({ basic: 10075010, fyStartYear: FY }, "NEW");
  assert.deepEqual([over1cr.surcharge, over1cr.annualLiability], [258007, 2951530]);
  // New regime is capped at 25% even above ₹5 crore; old regime 37%.
  assert.equal(calculateTax({ basic: 60075000, fyStartYear: FY }, "NEW").surchargeRate, 0.25);
  assert.equal(calculateTax({ basic: 60050000, fyStartYear: FY }, "OLD").surchargeRate, 0.37);
});

test("TAX-3 old regime ₹5 lakh rebate edge, age-based slabs, 80D caps", () => {
  // Gross 5,50,000 − SD 50,000 = 5,00,000 → tax 12,500 − rebate 12,500 = 0.
  assert.equal(calculateTax({ basic: 550000, fyStartYear: FY }, "OLD").annualLiability, 0);
  // Taxable 5,00,010 → 12,500 + 2 = 12,502, no rebate, cess 500 → 13,002 → ₹10 rounding = 13,000.
  assert.equal(calculateTax({ basic: 550010, fyStartYear: FY }, "OLD").annualLiability, 13000);
  // Senior (60–80): taxable 10,00,000 → 10,000 + 1,00,000 = 1,10,000 + 4,400 = 1,14,400; below 60: 1,12,500 + 4,500 = 1,17,000.
  assert.equal(calculateTax({ basic: 1050000, fyStartYear: FY, ageCategory: "SENIOR" }, "OLD").annualLiability, 114400);
  assert.equal(calculateTax({ basic: 1050000, fyStartYear: FY }, "OLD").annualLiability, 117000);
  // 80D: self capped at 25,000 (50,000 if senior); parents 25,000 (50,000 if senior parents).
  assert.equal(calculateTax({ basic: 1050000, section80DSelf: 40000, section80DParents: 60000, fyStartYear: FY }, "OLD").deductions, 50000);
  assert.equal(calculateTax({ basic: 1050000, section80DSelf: 40000, section80DParents: 60000, parentsSenior: true, ageCategory: "SENIOR", fyStartYear: FY }, "OLD").deductions, 90000);
});

test("TAX-4 employer NPS 14% / 10% of Basic and ₹7.5 lakh retirement perquisite", () => {
  // Basic 10,00,000; employer NPS 1,50,000 (perquisite): new regime deduction min(1,50,000, 14% = 1,40,000) = 1,40,000.
  const n = calculateTax({ basic: 1000000, employerNps: 150000, fyStartYear: FY }, "NEW");
  assert.deepEqual([n.grossIncome, n.employerNpsDeduction, n.taxableIncome], [1150000, 140000, 935000]);
  assert.equal(calculateTax({ basic: 1000000, employerNps: 150000, fyStartYear: FY }, "OLD").employerNpsDeduction, 100000);
  // Employer PF 6,00,000 + NPS 2,00,000 = 8,00,000 → 50,000 above ₹7.5 lakh is a perquisite.
  assert.equal(calculateTax({ basic: 5000000, employerNps: 200000, employerRetirementOther: 600000, fyStartYear: FY }, "NEW").retirementPerquisite, 50000);
});

test("TAX-5 previous FY tables are kept (FY 2024-25 ₹7 lakh rebate)", () => {
  // FY 2024-25 new regime: taxable 7,00,000 → 20,000 − rebate 25,000 cap → 0; 7,10,000 → 21,000 > 10,000 → MR → 10,000 + 400.
  assert.equal(calculateTax({ basic: 775000, fyStartYear: 2024 }, "NEW").annualLiability, 0);
  assert.equal(calculateTax({ basic: 785000, fyStartYear: 2024 }, "NEW").annualLiability, 10400);
  assert.equal(taxRulesFor(2030).assumed, true);
});

test("TAX-6 HRA exemption: 8 metro cities from FY 2026-27 (Bengaluru 50%), 4 before", () => {
  assert.equal(isMetroLocation("Bengaluru — Indiranagar", "2026-05"), true);
  assert.equal(isMetroLocation("Bengaluru — Indiranagar", "2026-02"), false);
  assert.equal(isMetroLocation("Chikmagalur estate", "2026-05"), false);
  // Basic 6,00,000, HRA 3,00,000, rent 3,60,000: rent − 10% salary = 3,00,000; metro 50% = 3,00,000 → 3,00,000;
  // non-metro 40% = 2,40,000 → 2,40,000.
  assert.equal(hraExemption({ hraReceived: 300000, rentPaid: 360000, salary: 600000, metro: true }), 300000);
  assert.equal(hraExemption({ hraReceived: 300000, rentPaid: 360000, salary: 600000, metro: false }), 240000);
});

test("TAX-7 old-regime projection applies the HRA exemption (regression: it used to be dropped)", () => {
  // Annual salary 12,00,000 of which HRA 2,40,000, Basic 6,00,000, rent 3,00,000 non-metro:
  //   exemption = min(2,40,000, 3,00,000 − 60,000 = 2,40,000, 40% × 6,00,000 = 2,40,000) = 2,40,000.
  //   taxable = 12,00,000 − 2,40,000 − SD 50,000 = 9,10,000 → 12,500 + 82,000 = 94,500 + 3,780 cess = 98,280.
  const projection = projectTds({
    regime: "OLD", fyStartYear: FY, monthsRemainingIncludingCurrent: 12, priorTaxable: 0, priorTds: 0, priorPf: 0, priorPt: 0,
    currentRegular: 100000, currentOneTime: 0, currentPf: 0, currentPt: 0, futureMonthlyTaxable: 100000, futureMonthlyPf: 0, futurePt: 0,
    annualBasic: 600000, annualHra: 240000, metro: false, declarations: { rentPaidAnnual: 300000 },
  });
  assert.deepEqual([projection.hraExemption, projection.taxableIncome, projection.annualLiability], [240000, 910000, 98280]);
  assert.equal(projection.monthlyTds, 8190); // 98,280 / 12
});

test("TAX-8 TDS projection: spreads the balance, nets prior and previous-employer TDS, one-time items", () => {
  const input = {
    regime: "NEW" as const, fyStartYear: FY, monthsRemainingIncludingCurrent: 7, priorTaxable: 5 * 200000, priorTds: 5 * 20000, priorPf: 9000, priorPt: 1000,
    currentRegular: 200000, currentOneTime: 0, currentPf: 1800, currentPt: 200, futureMonthlyTaxable: 200000, futureMonthlyPf: 1800, futurePt: 1300,
    annualBasic: 1200000, annualHra: 480000, metro: false,
  };
  // Annual salary 24,00,000 − SD 75,000 = 23,25,000 → 3,00,000 − (75,000 × 25%) = 2,81,250 + cess 11,250 = 2,92,500.
  const projection = projectTds(input);
  assert.equal(projection.annualLiability, 292500);
  assert.equal(projection.monthlyTds, Math.round((292500 - 100000) / 7)); // 27,500
  assert.equal(projectTds({ ...input, priorTds: 10_000_000 }).monthlyTds, 0, "never negative");
  // Previous employer: salary 3,00,000 and TDS 40,000 declared → annual 27,00,000 → taxable 26,25,000:
  //   3,00,000 + 2,25,000 × 30% = 3,67,500 + cess 14,700 = 3,82,200; monthly (3,82,200 − 1,40,000) / 7 = 34,600.
  const withPrev = projectTds({ ...input, declarations: { previousEmployerSalary: 300000, previousEmployerTds: 40000 } });
  assert.deepEqual([withPrev.annualLiability, withPrev.monthlyTds], [382200, 34600]);
  // One-time bonus 1,00,000 in the month: ₹75k at 25% + ₹25k at 30% = 26,250 + cess 1,050 = 27,300 extra this month.
  const withBonus = projectTds({ ...input, currentOneTime: 100000 });
  assert.equal(withBonus.oneTimeTax, 27300);
  assert.equal(withBonus.monthlyTds, projection.monthlyTds + 27300);
});

// ================================================================ Full-year salary examples (engine, both regimes)

function baseContext(annualCtc: number, regime: "NEW" | "OLD"): LineContext {
  const structure = buildStructure({ annualCtc, isMetro: false, pfWageMode: "CEILING", pfApplicable: true, asOf: "2026-04-01" });
  return {
    period: "2026-04", employee: { joiningDate: "2020-04-01", location: "Chikmagalur estate" },
    structure: { components: structure.components, fixedMonthlyGross: structure.fixedMonthlyGross, isMetro: false },
    profile: { regime, pfApplicable: true, ptCategory: "STANDARD", state: "KA", stateSource: "profile", declarations: {}, hasPan: true, hasBank: true },
    settings: { pfWageMode: "CEILING" }, leaveLopDays: 0, inputs: [],
    ytd: { taxable: 0, tds: 0, pf: 0, pt: 0, gross: 0, net: 0, months: 0 }, esiCoveredEarlierInPeriod: false, previous: null,
  };
}
/** Run Apr 2026 → Mar 2027 feeding each month's YTD into the next, like published runs do. */
function fullYear(annualCtc: number, regime: "NEW" | "OLD") {
  const ctx = baseContext(annualCtc, regime);
  const ytd = { ...ctx.ytd };
  const months: { period: string; tds: number; pf: number; pt: number; gross: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const period = addMonths("2026-04", i);
    const line = calculateLine({ ...ctx, period, ytd: { ...ytd } });
    assert.ok(line.included);
    if (!line.included) throw new Error("excluded");
    months.push({ period, tds: line.statutory.tds.amount, pf: line.statutory.pf.employee, pt: line.statutory.pt.amount, gross: line.totals.gross });
    Object.assign(ytd, { taxable: ytd.taxable + line.totals.taxable, tds: ytd.tds + line.statutory.tds.amount, pf: ytd.pf + line.statutory.pf.employee, pt: ytd.pt + line.statutory.pt.amount, gross: ytd.gross + line.totals.gross, months: ytd.months + 1 });
  }
  const total = (key: "tds" | "pf" | "pt" | "gross") => months.reduce((sum, row) => sum + row[key], 0);
  return { months, tds: total("tds"), pf: total("pf"), pt: total("pt"), gross: total("gross") };
}
// PF for any employee with Basic ≥ ₹25,000 in FY 2026-27 (Karnataka, CEILING mode):
//   Apr–Aug 5 × 1,800 = 9,000; Sep split 8,000 + 11,666.67 = 19,666.67 × 12% = 2,360; Oct–Mar 6 × 3,000 = 18,000 → 29,360.
// PT Karnataka: 11 × 200 + 300 (Feb) = 2,500.

test("YEAR-1 ₹6 lakh CTC: zero tax under both regimes", () => {
  // Structure (Apr 2026): monthly CTC 50,000; Basic 25,000; HRA 10,000; conveyance 1,600; employer PF 1,800 → gross 48,200 (× 12 = 5,78,400).
  // New: 5,78,400 − 75,000 = 5,03,400 → 5,170 tax → rebate → 0. Old: 5,78,400 − 50,000 − 2,500 PT − 29,360 PF = 4,96,540 → 12,327 → rebate → 0.
  for (const regime of ["NEW", "OLD"] as const) {
    const y = fullYear(600000, regime);
    assert.deepEqual([y.gross, y.pf, y.pt, y.tds], [578400, 29360, 2500, 0], regime);
  }
});

test("YEAR-2 ₹12 lakh CTC: new regime nil (rebate), old regime ₹1,47,120", () => {
  // Gross 98,200 × 12 = 11,78,400 (Basic 50,000; HRA 20,000; conveyance 1,600; special 26,600).
  // New: 11,78,400 − 75,000 = 11,03,400 → 50,340 → rebate → 0.
  // Old: 11,78,400 − 50,000 − 2,500 − 29,360 = 10,96,540 → 1,12,500 + 96,540 × 30% = 1,41,462 + cess 5,658 = 1,47,120.
  const n = fullYear(1200000, "NEW"), o = fullYear(1200000, "OLD");
  assert.deepEqual([n.gross, n.tds], [1178400, 0]);
  assert.deepEqual([o.gross, o.pf, o.tds], [1178400, 29360, 147120]);
});

test("YEAR-3 ₹12.5 lakh CTC: new regime nil, old regime ₹1,62,720", () => {
  // Monthly CTC 1,04,167; Basic 52,084; HRA 20,834; conveyance 1,600; employer PF 1,800 → gross 1,02,367 × 12 = 12,28,404.
  // New: 12,28,404 − 75,000 = 11,53,404 → 11,53,400 (₹10) → 55,340 → rebate → 0.
  // Old: 12,28,404 − 50,000 − 2,500 − 29,360 = 11,46,544 → 11,46,540 → 1,12,500 + 43,962 = 1,56,462 + cess 6,258 = 1,62,720.
  const n = fullYear(1250000, "NEW"), o = fullYear(1250000, "OLD");
  assert.deepEqual([n.gross, n.tds], [1228404, 0]);
  assert.deepEqual([o.gross, o.tds], [1228404, 162720]);
});

test("YEAR-4 ₹18 lakh CTC: new ₹1,46,310, old ₹3,34,320", () => {
  // Gross 1,48,200 × 12 = 17,78,400.
  // New: 17,78,400 − 75,000 = 17,03,400 → 20,000 + 40,000 + 60,000 + 1,03,400 × 20% = 1,40,680 + cess 5,627 = 1,46,307 → 1,46,310.
  // Old: 17,78,400 − 50,000 − 2,500 − 29,360 = 16,96,540 → 1,12,500 + 6,96,540 × 30% = 3,21,462 + cess 12,858 = 3,34,320.
  const n = fullYear(1800000, "NEW"), o = fullYear(1800000, "OLD");
  assert.deepEqual([n.gross, n.tds], [1778400, 146310]);
  assert.deepEqual([o.gross, o.tds], [1778400, 334320]);
  // Monthly TDS is spread: April = 1,46,310 / 12 = 12,192.5 → 12,193 (new regime).
  assert.equal(n.months[0].tds, 12193);
});

test("YEAR-5 ₹60 lakh CTC: surcharge 10%; new ₹15,45,570, old ₹18,09,190", () => {
  // Gross 4,98,200 × 12 = 59,78,400.
  // New: taxable 59,03,400 → 3,00,000 + 35,03,400 × 30% = 13,51,020; surcharge 1,35,102; cess 4% × 14,86,122 = 59,445 → 15,45,567 → 15,45,570.
  // Old: taxable 58,96,540 → 1,12,500 + 48,96,540 × 30% = 15,81,462; surcharge 1,58,146; cess 69,584 → 18,09,192 → 18,09,190.
  const n = fullYear(6000000, "NEW"), o = fullYear(6000000, "OLD");
  assert.deepEqual([n.gross, n.tds], [5978400, 1545570]);
  assert.deepEqual([o.gross, o.tds], [5978400, 1809190]);
});

// ================================================================ Engine behaviour

test("ENGINE-1 LOP prorates earnings and PF; variance and negative-net flags", () => {
  const structure = buildStructure({ annualCtc: 360000, isMetro: false, pfWageMode: "CEILING", pfApplicable: true, asOf: "2026-08-01" });
  const base: LineContext = {
    period: "2026-08", employee: { joiningDate: "2024-04-01", location: "Bengaluru" },
    structure: { components: structure.components, fixedMonthlyGross: structure.fixedMonthlyGross, isMetro: false },
    profile: { regime: "NEW", pfApplicable: true, ptCategory: "STANDARD", state: "KA", stateSource: "location", declarations: {}, hasPan: true, hasBank: true },
    settings: { pfWageMode: "CEILING" }, leaveLopDays: 0, inputs: [],
    ytd: { taxable: 0, tds: 0, pf: 0, pt: 0, gross: 0, net: 0, months: 0 }, esiCoveredEarlierInPeriod: false, previous: null,
  };
  const full = calculateLine(base);
  const lop = calculateLine({ ...base, leaveLopDays: 3 });
  assert.ok(lop.included && full.included);
  if (!lop.included || !full.included) return;
  assert.equal(lop.days.payableDays, 28);
  assert.equal(lop.earnings.find((line) => line.code === "BASIC")!.amount, Math.round(structure.monthly.BASIC * 28 / 31));
  assert.ok(lop.statutory.pf.employee < full.statutory.pf.employee);
  assert.equal(full.totals.net, full.totals.gross - full.totals.deductions);
  const variance = calculateLine({ ...base, previous: { net: full.totals.net * 1.3, period: "2026-07" } });
  assert.ok(variance.flags.some((flag) => flag.code === "VARIANCE"));
  const negative = calculateLine({ ...base, inputs: [{ kind: "DEDUCTION", code: "RECOVERY", label: "Advance recovery", amount: 90000, taxable: false, esiWage: false }] });
  assert.ok(negative.flags.some((flag) => flag.code === "NEGATIVE_NET" && flag.blocking));
  const missing = calculateLine({ ...base, structure: null });
  assert.equal(missing.included, false);
});

test("ENGINE-2 excluded employee within the new ₹25,000 ceiling is flagged for mandatory enrolment", () => {
  // Basic 20,000: excluded under the ₹15,000 ceiling, mandatory from 17 Sep 2026 (EPFO FAQ Q28/Q29).
  const s = buildStructure({ annualCtc: 500000, isMetro: false, pfWageMode: "CEILING", pfApplicable: false, asOf: "2026-10-01" });
  const ctx: LineContext = { ...baseContext(500000, "NEW"), period: "2026-10", structure: { components: s.components, fixedMonthlyGross: s.fixedMonthlyGross, isMetro: false } };
  const line = calculateLine({ ...ctx, profile: { ...ctx.profile, pfApplicable: false } });
  assert.ok(line.flags.some((flag) => flag.code === "PF_ENROLMENT_REQUIRED"));
  assert.ok(s.warnings.some((w) => w.includes("mandatory")));
  const before = calculateLine({ ...ctx, period: "2026-08", profile: { ...ctx.profile, pfApplicable: false } });
  assert.ok(!before.flags.some((flag) => flag.code === "PF_ENROLMENT_REQUIRED"), "₹20,000 was above the old ₹15,000 ceiling");
});

test("ENGINE-3 no PAN: TDS at 20% when tax is payable", () => {
  // ₹18 lakh CTC, new regime, October after six paid months (taxable 8,89,200, TDS 73,158 so far):
  //   annual liability 1,46,310 → slab share (1,46,310 − 73,158) / 6 = 12,192; 20% × gross 1,48,200 = 29,640 is higher → 29,640.
  const ctx = { ...baseContext(1800000, "NEW"), period: "2026-10", ytd: { taxable: 889200, tds: 73158, pf: 11160, pt: 1200, gross: 889200, net: 0, months: 6 } };
  const line = calculateLine({ ...ctx, profile: { ...ctx.profile, hasPan: false } });
  assert.ok(line.included);
  if (!line.included) return;
  assert.equal(line.statutory.tds.amount, 29640);
  assert.ok(line.flags.some((flag) => flag.code === "NO_PAN_TDS"));
  // ₹6 lakh CTC: no tax payable → no 20% deduction.
  const low = calculateLine({ ...baseContext(600000, "NEW"), period: "2026-10", profile: { ...baseContext(600000, "NEW").profile, hasPan: false } });
  assert.ok(low.included && low.statutory.tds.amount === 0);
});

test("ENGINE-4 LWF is reported but deducted only when the organisation enables it", () => {
  const ctx = { ...baseContext(1200000, "NEW"), period: "2026-12" };
  const off = calculateLine(ctx), on = calculateLine({ ...ctx, settings: { ...ctx.settings, lwfEnabled: true } });
  assert.ok(off.included && on.included);
  if (!off.included || !on.included) return;
  assert.ok(off.flags.some((flag) => flag.code === "LWF_NOT_DEDUCTED"));
  assert.equal(on.deductions.find((line) => line.code === "LWF")?.amount, 50);
  assert.equal(on.employer.find((line) => line.code === "LWF_ER")?.amount, 100);
  assert.equal(on.totals.net, off.totals.net - 50);
});

test("ENGINE-5 Labour Code add-back in a run; ESI for a person with disability", () => {
  // Basic 30% of fixed pay: monthly CTC 50,000 → Basic 15,000; gross 50,000 − 1,800 = 48,200 → excluded 33,200 > 24,100
  //   → add-back round(33,200 − 24,100) = 9,100 → PF wage 24,100 (≤ 25,000) → EE 12% = 2,892.
  const s = buildStructure({ annualCtc: 600000, template: { basicPct: 0.3 }, isMetro: false, pfWageMode: "CEILING", pfApplicable: true, asOf: "2026-04-01" });
  const ctx: LineContext = { ...baseContext(600000, "NEW"), period: "2026-10", structure: { components: s.components, fixedMonthlyGross: s.fixedMonthlyGross, isMetro: false } };
  const line = calculateLine(ctx);
  assert.ok(line.included);
  if (!line.included) return;
  assert.deepEqual([line.statutory.pf.labourCodeAddBack, line.statutory.pf.pfWage, line.statutory.pf.employee], [9100, 24100, 2892]);
  const off = calculateLine({ ...ctx, settings: { ...ctx.settings, labourCodeWages: "OFF" } });
  assert.ok(off.included && off.statutory.pf.employee === 1800);
  // ESI: rate of wages 23,000 → not covered normally, covered for a person with disability (≤ 25,000).
  const esiStructure = buildStructure({ annualCtc: 290000, isMetro: false, pfWageMode: "CEILING", pfApplicable: false, asOf: "2026-10-01" });
  const ectx: LineContext = { ...ctx, structure: { components: esiStructure.components, fixedMonthlyGross: esiStructure.fixedMonthlyGross, isMetro: false } };
  assert.ok(esiStructure.fixedMonthlyGross > 21000 && esiStructure.fixedMonthlyGross <= 25000);
  const normal = calculateLine(ectx), disabled = calculateLine({ ...ectx, profile: { ...ectx.profile, disabled: true } });
  assert.ok(normal.included && disabled.included);
  if (!normal.included || !disabled.included) return;
  assert.equal(normal.statutory.esi.covered, false);
  assert.equal(disabled.statutory.esi.covered, true);
});

// ================================================================ Structures, periods, misc (pre-existing behaviour)

test("STRUCT-1 default template sums to CTC; employer PF uses the ceiling in force; low CTC gets ESI", () => {
  const before = buildStructure({ annualCtc: 1200000, isMetro: false, pfWageMode: "CEILING", pfApplicable: true, asOf: "2026-08-01" });
  assert.deepEqual([before.monthly.BASIC, before.monthly.HRA, before.monthly.EMPLOYER_PF, before.check.difference], [50000, 20000, 1800, 0]);
  const after = buildStructure({ annualCtc: 1200000, isMetro: false, pfWageMode: "CEILING", pfApplicable: true, asOf: "2026-10-01" });
  assert.equal(after.monthly.EMPLOYER_PF, 3000); // 12% × 25,000
  assert.equal(after.check.difference, 0);
  const low = buildStructure({ annualCtc: 240000, isMetro: false, pfWageMode: "CEILING", pfApplicable: true, asOf: "2026-10-01" });
  assert.equal(low.esiApplicable, true);
  assert.ok(low.fixedMonthlyGross <= 21000);
  assert.ok(Math.abs(low.check.difference) <= 12);
  assert.equal(low.monthly.BASIC + low.monthly.HRA + low.monthly.CONVEYANCE + low.monthly.SPECIAL, low.fixedMonthlyGross);
  assert.ok(buildStructure({ annualCtc: 100000, template: { conveyance: 20000 }, isMetro: false, pfWageMode: "CEILING", pfApplicable: true }).errors.length > 0);
  const s = buildStructure({ annualCtc: 600000, template: { basicPct: undefined, hraPct: undefined } as never, isMetro: true, pfWageMode: "CEILING", pfApplicable: true });
  assert.deepEqual([s.monthly.BASIC, s.monthly.HRA], [25000, 12500]);
});

test("MISC-1 state resolution, LOP proration, fiscal-year helpers, ruleset summary", () => {
  assert.equal(resolveState("TN", "Mumbai — Bandra", "KA").state, "TN");
  assert.equal(resolveState(null, "Mumbai — Bandra", "KA").state, "MH");
  assert.equal(resolveState(null, "Chikmagalur", "MH").state, "KA");
  assert.equal(resolveState(null, "Noida (Delhi NCR)", "KA").state, "UP");
  assert.equal(resolveState(null, "Kochi", "KA").state, "KL");
  assert.equal(resolveState(null, null, "KA").source, "organisation default");
  assert.equal(lopDaysInPeriod("2026-09", [{ startDate: "2026-09-10", endDate: "2026-09-11", days: 1.5 }]), 1.5);
  assert.equal(lopDaysInPeriod("2026-09", [{ startDate: "2026-09-29", endDate: "2026-10-02", days: 4 }]), 2);
  const d = payableDays("2026-09", "2024-04-01", 3);
  assert.deepEqual([d.daysInMonth, d.payableDays, prorate(30000, d.payableDays, d.daysInMonth)], [30, 27, 27000]);
  const joiner = payableDays("2026-09", "2026-09-16", 0);
  assert.deepEqual([joiner.employedDays, joiner.joinedThisMonth], [15, true]);
  assert.equal(payableDays("2026-09", "2026-10-01", 0).payableDays, 0);
  assert.equal(payableDays("2026-09", null, 40).payableDays, 0);
  const p = parsePeriod("2026-09");
  assert.deepEqual([p.fyIndex, p.remainingMonthsIncludingCurrent, parsePeriod("2027-03").remainingMonthsIncludingCurrent, parsePeriod("2026-04").fyLabel], [5, 7, 1, "2026-27"]);
  assert.equal(RULESET.fiscalYear, "2026-27");
  assert.equal(RULESET.pf.wageCeiling, 25000);
  assert.equal(RULESET.pf.epsMax, 2083);
});

test("missing UAN / ESI IP number are flagged so PF and ESI returns aren't filed with blank IDs", () => {
  const low = { ...baseContext(240000, "NEW"), period: "2026-10" };
  const flagged = calculateLine({ ...low, profile: { ...low.profile, hasUan: false, hasEsiNumber: false } });
  assert.ok(flagged.included);
  const codes = flagged.flags.map((flag) => flag.code);
  assert.ok(codes.includes("MISSING_UAN"));
  assert.ok(codes.includes("MISSING_ESI_IP"), "₹20k/month is ESI-covered");
  const clean = calculateLine({ ...low, profile: { ...low.profile, hasUan: true, hasEsiNumber: true } });
  assert.ok(!clean.flags.some((flag) => flag.code === "MISSING_UAN" || flag.code === "MISSING_ESI_IP"));
  const unknown = calculateLine(low);
  assert.ok(!unknown.flags.some((flag) => flag.code === "MISSING_UAN"), "no flag when the caller doesn't know");
  const high = calculateLine({ ...baseContext(1200000, "NEW"), period: "2026-10", profile: { ...baseContext(1200000, "NEW").profile, hasEsiNumber: false } });
  assert.ok(!high.flags.some((flag) => flag.code === "MISSING_ESI_IP"), "₹1L/month is not ESI-covered");
});

import { hr, payroll, log } from "./lib.mjs";
const label = process.argv[2] || "TDS";
const runs = (await payroll("GET", "/payroll/runs")).j.items;
const run = runs.find((x) => x.period === "2026-09" && x.status !== "CANCELLED");
let r = await payroll("POST", `/payroll/runs/${run.id}/calculate`, { version: run.version }); log(`recalculate Sep 2026 run (${run.status})`, r, (j) => ({ status: j.status, net: j.totals?.net, msg: j.message }));
for (const n of ["BTS501", "BTS502"]) {
  const emp = (await hr("GET", `/employees?search=${n}`)).j.items.find((x) => x.employeeNumber === n);
  if (!emp) continue;
  const line = await payroll("GET", `/payroll/runs/${run.id}/lines/${emp.id}`);
  const b = line.j.breakdown || line.j;
  log(`${label} ${n}`, line, () => ({ tds: b.statutory?.tds?.amount, ytdBefore: b.tax ? { prior: b.tax.tdsDeductedSoFar, annualLiability: b.tax.annualLiability, projectedIncome: b.tax.projectedAnnualIncome, monthsRemaining: b.tax.monthsRemaining } : null, ytdAfter: b.ytd, flags: (b.flags || line.j.flags || []).map((f) => f.code) }));
}

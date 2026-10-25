import { hr, owner, payroll, log } from "./lib.mjs";
for (const n of ["BTS501", "BTS502"]) {
  const e = (await hr("GET", `/employees?search=${n}`)).j.items.find((x) => x.employeeNumber === n);
  if (e && e.status === "ACTIVE") { const r = await hr("PATCH", `/employees/${e.id}`, { version: e.version, status: "INACTIVE" }); log(`deactivate ${n}`, r, (j) => [j.status, j.designation]); }
}
const s = (await owner("GET", "/imports/settings")).j;
let r = await owner("PUT", "/imports/settings", { version: s.version, cutoverDate: null, fiscalYear: null, lastPaidPeriod: null, sourceSystem: null, controlTotals: {} }); log("reset switch-over settings", r, (j) => [j.cutoverDate, j.controlTotals]);
const run = (await payroll("GET", "/payroll/runs")).j.items.find((x) => x.period === "2026-09" && x.status !== "CANCELLED");
r = await payroll("POST", `/payroll/runs/${run.id}/calculate`, { version: run.version }); log("recalculate Sep run (test employees drop out)", r, (j) => [j.status, j.totals?.headcount, j.totals?.net]);

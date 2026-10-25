import { csv, hr, payroll, owner, log } from "./lib.mjs";
let r = await owner("GET", "/imports/settings");
r = await owner("PUT", "/imports/settings", { version: r.j.version, cutoverDate: "2026-08-31", fiscalYear: "2026-27", lastPaidPeriod: "2026-08", sourceSystem: "PeopleStrong",
  controlTotals: { headcount: 16, leave: { EL: 32.5, CL: 10, SL: 5 }, ytd: { employees: 2, gross: 850000, tds: 52500, pf_employee: 18000, pt: 2000 }, salary: { annualCtc: 2100000 } } });
log("owner saves cut-over settings + control totals", r, (j) => ({ cutover: j.cutoverDate, lastPaid: j.lastPaidPeriod, v: j.version, controls: j.controlTotals }));
r = await hr("PUT", "/imports/settings", { version: 0, cutoverDate: "2026-08-31" }); log("stale settings version (expect 409)", r, (j) => j.message);
r = await hr("POST", "/imports/salary/dry-run", { csv: csv("02-salary.csv") }); log("HR salary dry-run (expect 403)", r, (j) => j.message);
r = await payroll("POST", "/imports/salary/dry-run", { csv: csv("02-salary-errors.csv") }); log("salary errors dry-run", r, (j) => j.rows?.map((x) => [x.row, x.employeeNumber, x.errors]) || j);
r = await payroll("POST", "/imports/salary/dry-run", { csv: csv("02-salary.csv") }); log("salary dry-run", r, (j) => ({ summary: j.summary, totals: j.totals, rows: j.rows.map((x) => [x.employeeNumber, x.changes, x.warnings]) }));
r = await payroll("POST", "/imports/salary/commit", { csv: csv("02-salary.csv"), fileName: "02-salary.csv" }); log("salary commit", r, (j) => ({ idempotent: j.idempotent, id: j.batch?.id, msg: j.message }));
r = await payroll("POST", "/imports/salary/commit", { csv: csv("02-salary.csv"), fileName: "02-salary.csv" }); log("salary re-commit (idempotent)", r, (j) => ({ idempotent: j.idempotent }));

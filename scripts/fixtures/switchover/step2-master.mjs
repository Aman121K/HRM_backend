import { csv, hr, payroll, ravi, log } from "./lib.mjs";
const rows = (j) => j.rows?.map((x) => [x.row, x.employeeNumber, x.outcome, x.errors, x.warnings]) || j;
let r = await ravi("POST", "/imports/employee-master/dry-run", { csv: csv("01-employee-master.csv") }); log("employee dry-run (expect 403)", r, (j) => j.message);
r = await payroll("POST", "/imports/employee-master/dry-run", { csv: csv("01-employee-master.csv") }); log("payroll admin master dry-run (expect 403)", r, (j) => j.message);
r = await hr("POST", "/imports/employee-master/dry-run", { csv: "foo,bar\n1,2\n" }); log("bad header (expect 400)", r, (j) => j.message);
r = await hr("POST", "/imports/employee-master/dry-run", { csv: csv("01-employee-master-errors.csv") }); log("errors dry-run", r, rows);
r = await hr("POST", "/imports/employee-master/commit", { csv: csv("01-employee-master-errors.csv") }); log("errors commit (expect 400)", r, (j) => j.message);
r = await hr("POST", "/imports/employee-master/dry-run", { csv: csv("01-employee-master.csv"), fileName: "01-employee-master.csv" }); log("good dry-run", r, (j) => ({ summary: j.summary, totals: j.totals, rows: j.rows.map((x) => [x.employeeNumber, x.outcome, x.changes, x.warnings]) }));

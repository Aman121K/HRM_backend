import { hr, payroll, owner, log } from "./lib.mjs";
const batches = (await owner("GET", "/imports/batches")).j.items.filter((b) => b.status === "COMMITTED");
const byKind = Object.fromEntries(batches.map((b) => [b.kind, b]));
let r = await owner("GET", "/imports/reconciliation"); log("reconciliation (owner)", r, (j) => ({ headcount: j.headcount, leave: j.leave?.filter((x) => x.employees), ytd: j.ytd && { employees: j.ytd.employees, gross: j.ytd.gross, tds: j.ytd.tds }, mismatches: j.mismatches, checks: j.checks.map((c) => `${c.label}: ${c.system} vs ${c.control} ${c.ok === false ? "MISMATCH" : c.ok ? "ok" : "-"}`) }));
r = await hr("GET", "/imports/reconciliation"); log("reconciliation (HR) has no payroll sections", r, (j) => ({ ytd: j.ytd ?? "hidden", salary: j.salary ?? "hidden", leave: !!j.leave }));
// Undo blocked while a submitted run used the figures.
const run = (await payroll("GET", "/payroll/runs")).j.items.find((x) => x.period === "2026-09" && x.status !== "CANCELLED");
r = await payroll("POST", `/payroll/runs/${run.id}/transitions`, { action: "submit", version: run.version }); log("submit Sep run", r, (j) => j.status || j.message);
r = await payroll("POST", `/imports/batches/${byKind.PAYROLL_YTD.id}/undo`, { reason: "test" }); log("undo YTD while Sep run submitted (expect 409)", r, (j) => j.message);
r = await payroll("POST", `/imports/batches/${byKind.SALARY.id}/undo`, { reason: "test" }); log("undo salary while Sep run submitted (expect 409)", r, (j) => j.message);
const sub = (await payroll("GET", `/payroll/runs/${run.id}`)).j;
r = await owner("POST", `/payroll/runs/${run.id}/transitions`, { action: "reject", version: sub.version, note: "switch-over test: send back" }); log("owner sends Sep run back", r, (j) => j.status || j.message);
// Undo blocked by a later manual edit.
const emp = (await hr("GET", "/employees?search=BTS501")).j.items[0];
r = await hr("PATCH", `/employees/${emp.id}`, { version: emp.version, department: "Edited After Import" }); log("HR edits BTS501 department after import", r, (j) => j.department);
r = await hr("POST", `/imports/batches/${byKind.EMPLOYEE_MASTER.id}/undo`, { reason: "test" }); log("undo master after later edit (expect 409)", r, (j) => j.message);
r = await hr("PATCH", `/employees/${emp.id}`, { version: r.j?.version || emp.version + 1, department: "Operations" }); log("HR restores department", r, (j) => j.department || j.message);
r = await payroll("POST", `/imports/batches/${byKind.EMPLOYEE_MASTER.id}/undo`, {}); log("payroll admin undoes HR master batch (expect 403)", r, (j) => j.message);

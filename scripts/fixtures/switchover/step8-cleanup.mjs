import { hr, payroll, owner, log, zip, pdf, as } from "./lib.mjs";
const good = zip([{ name: "payslips/BTS501_2026-07.pdf", bytes: pdf("BTS501 July") }, { name: "payslips/BTS501_2026-08.pdf", bytes: pdf("BTS501 Aug") }, { name: "payslips/BTS502-202608.pdf", bytes: pdf("BTS502 Aug") }]);
const order = ["PAYSLIPS", "PAYROLL_YTD", "LEAVE_OPENING", "SALARY", "EMPLOYEE_MASTER"];
const undoAll = async () => {
  const batches = (await owner("GET", "/imports/batches")).j.items.filter((b) => b.status === "COMMITTED");
  for (const kind of order) for (const b of batches.filter((x) => x.kind === kind)) {
    const who = ["EMPLOYEE_MASTER", "LEAVE_OPENING"].includes(kind) ? hr : payroll;
    const r = await who("POST", `/imports/batches/${b.id}/undo`, { reason: "switch-over e2e cleanup" }); log(`undo ${kind}`, r, (j) => j.status || j.message);
  }
};
await undoAll();
let r = await payroll("POST", "/imports/payslips/commit", { zipBase64: good.toString("base64"), fileName: "payslips.zip" }); log("payslips re-import after undo", r, (j) => ({ idempotent: j.idempotent, id: j.batch?.id }));
r = await payroll("POST", "/imports/payslips/commit", { zipBase64: good.toString("base64"), fileName: "payslips.zip" }); log("payslips re-commit same zip (idempotent)", r, (j) => ({ idempotent: j.idempotent, id: j.batch?.id }));
r = await payroll("POST", `/imports/batches/${r.j.batch.id}/undo`, {}); log("undo payslips again", r, (j) => j.status);
r = await payroll("POST", `/imports/batches/${r.j.id}/undo`, {}); log("undo twice (expect 409)", r, (j) => j.message);
r = await as("blue-tokai", "BTS501")("GET", "/imports/payslips/mine"); log("BTS501 imported payslips after undo", r, (j) => j.items?.length);
r = await as("blue-tokai", "BTS501")("GET", "/leave-types"); log("BTS501 leave balances after undo", r, (j) => j.items?.filter((x) => x.opening_balance !== null).length);
r = await owner("GET", "/imports/overview"); log("overview after undo", r, (j) => j.steps.map((s) => [s.slug, s.status, s.committedBatches, s.last?.status, s.last?.undoneBy]));

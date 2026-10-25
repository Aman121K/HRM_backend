import './lib/dev-only.mjs'; // refuses to run in production — see the file
// Seeds the payroll engine through the platform API so every rule (structure validation, statutory maths,
// maker-checker, publishing, notifications, audit) runs exactly as in the UI.
//   - payroll profiles (state, regime, PAN/UAN/bank) and salary structures for every active employee
//     (varied CTCs, some ≤ ₹21k gross for ESI, Karnataka + Maharashtra + Delhi locations, one Sept revision)
//   - published runs for Apr–Aug 2026 (Apr–Jul locked) and a CALCULATED run for Sept 2026 with review flags
// Usage: npm run db:seed:payroll            (requires the platform API on BACKEND_V2_PORT; re-runnable)
//        npm run db:seed:payroll -- --reset (local only: deletes payroll runs, structures, profiles and run payslips first)
import "dotenv/config";
import pg from "pg";

const api = `http://localhost:${process.env.BACKEND_V2_PORT || 4100}/api/v2`;
const MAKER = "BT009"; // Neha Gupta — PAYROLL_ADMIN
const CHECKER = "BT000"; // Blue Tokai HR — HR_ADMIN
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function call(actor, method, path, body) {
  const response = await fetch(`${api}${path}`, {
    method, headers: { "content-type": "application/json", "x-tenant-id": "tenant-demo-001", "x-employee-id": actor },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${actor} ${method} ${path}: ${response.status} ${JSON.stringify(data.message)}`);
  return data;
}

const org = (await pool.query("SELECT id FROM organizations WHERE slug='blue-tokai'")).rows[0];
if (!org) throw new Error("Run npm run db:seed first — the demo organization is missing.");
if (process.argv.includes("--reset")) {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset in production.");
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.organization_id',$1,true)", [org.id]);
  await client.query("DELETE FROM workflow_events WHERE organization_id=$1 AND (entity_type='payroll_run' OR (entity_type='payslip' AND event_type='PAYSLIP_PUBLISHED'))", [org.id]);
  await client.query("UPDATE payroll_run_lines SET payslip_id=NULL WHERE organization_id=$1", [org.id]);
  await client.query("DELETE FROM payslips WHERE organization_id=$1 AND payroll_run_id IS NOT NULL", [org.id]);
  for (const table of ["payroll_inputs", "payroll_run_lines", "payroll_runs", "salary_structures", "payroll_profiles", "payroll_settings"])
    await client.query(`DELETE FROM ${table} WHERE organization_id=$1`, [org.id]);
  await client.query("COMMIT");
  client.release();
  console.log("Cleared existing payroll data.");
}
const employees = new Map((await pool.query("SELECT id, employee_number, full_name, joining_date::text AS joining FROM employees WHERE organization_id=$1 AND status='ACTIVE'", [org.id])).rows.map((row) => [row.employee_number, row]));

// number: [annual CTC, profile, template overrides, extra]
const plan = {
  BT000: [1400000, { pan: "AABPH1234C", uan: "100900000001", bankName: "HDFC Bank", bankAccount: "50100012340001", ifsc: "HDFC0000123", ptCategory: "WOMAN" }],
  BT001: [1800000, { pan: "BCDPS5678K", uan: "100900000002", bankName: "ICICI Bank", bankAccount: "002101234567", ifsc: "ICIC0000021", ptCategory: "WOMAN" }, { variablePct: 0.1 }],
  BT002: [240000, { pan: "CKLPK4321M", uan: "100900000003", esiNumber: "3100123456", bankName: "State Bank of India", bankAccount: "32145678901", ifsc: "SBIN0001234" }],
  BT003: [258000, { pan: "DMNPM8765Q", uan: "100900000004", esiNumber: "3100123457", bankName: "Axis Bank", bankAccount: "918010012345678", ifsc: "UTIB0000456", ptCategory: "WOMAN" }],
  BT004: [216000, { uan: "100900000005", esiNumber: "3100123458", bankName: "Canara Bank", bankAccount: "0123456789012", ifsc: "CNRB0000789" }],
  BT005: [900000, { pan: "EKLPK1111A", uan: "100900000006", bankName: "HDFC Bank", bankAccount: "50100012340006", ifsc: "HDFC0000123", ptCategory: "WOMAN" }],
  BT006: [1100000, { pan: "FQRPQ2222B", uan: "100900000007", bankName: "Karnataka Bank", bankAccount: "4152500100123401", ifsc: "KARB0000415" }],
  BT007: [1600000, { pan: "GIYPI3333C", uan: "100900000008", bankName: "Kotak Mahindra Bank", bankAccount: "1234567890", ifsc: "KKBK0000958", ptCategory: "WOMAN" }, {}, { revision: ["2026-09-01", 1850000, "PROMOTION", "Promoted to Senior Brand Manager"] }],
  BT008: [2800000, { pan: "HBNPB4444D", uan: "100900000009", bankName: "HDFC Bank", bankAccount: "50100012340009", ifsc: "HDFC0000123", taxRegime: "OLD",
    declarations: { section80C: 150000, section80D: 25000, rentPaidAnnual: 420000 } }, { includeGratuity: true }],
  BT009: [720000, { pan: "JGUPG5555E", uan: "100900000010", bankName: "ICICI Bank", bankAccount: "002101234510", ifsc: "ICIC0000021", ptCategory: "WOMAN" }],
  BT010: [840000, { pan: "KSHPS6666F", uan: "100900000011", bankName: "Bank of Baroda", bankAccount: "12340100023456", ifsc: "BARB0BANDRA" }],
  BT900: [480000, { pan: "LPLPP7777G", uan: "100900000012", bankName: "Yes Bank", bankAccount: "001234567890", ifsc: "YESB0000001", ptCategory: "WOMAN" }],
  BT901: [228000, { esiNumber: "3100123459", ptCategory: "WOMAN" }], // new joiner, no bank yet → flagged
};

// 1. Payroll profiles + salary structures.
let structuresCreated = 0;
for (const [number, [ctc, profile, template = {}, extra = {}]] of Object.entries(plan)) {
  const employee = employees.get(number);
  if (!employee) { console.log(`skip ${number} (not an active employee)`); continue; }
  const current = await call(MAKER, "GET", `/payroll/employees/${employee.id}`);
  await call(MAKER, "PUT", `/payroll/employees/${employee.id}/profile`, { ...profile, version: current.profile.version });
  if (!current.structures.length) {
    const effectiveFrom = employee.joining > "2026-04-01" ? employee.joining : "2026-04-01";
    await call(MAKER, "POST", "/payroll/structures", { employeeId: employee.id, effectiveFrom, annualCtc: ctc, template, reason: employee.joining > "2026-04-01" ? "JOINING" : "REVISION", notes: "FY 2026-27 annual structure" });
    structuresCreated++;
  }
  if (extra.revision && !current.structures.some((item) => item.effectiveFrom === extra.revision[0])) {
    const [effectiveFrom, annualCtc, reason, notes] = extra.revision;
    await call(MAKER, "POST", "/payroll/structures", { employeeId: employee.id, effectiveFrom, annualCtc, template, reason, notes });
    structuresCreated++;
  }
}
console.log(`Profiles updated, ${structuresCreated} salary structures created.`);

// 2. Demo LOP leave (approved, unpaid) for Arjun in September, and an approved expense claim for Ravi.
{
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.organization_id',$1,true)", [org.id]);
  const lop = (await client.query("SELECT id FROM leave_types WHERE organization_id=$1 AND code='LOP'", [org.id])).rows[0];
  const arjun = employees.get("BT004"), manager = employees.get("BT001");
  if (lop && arjun && manager) {
    const exists = await client.query("SELECT 1 FROM leave_requests WHERE organization_id=$1 AND employee_id=$2 AND leave_type_id=$3 AND start_date='2026-09-14'", [org.id, arjun.id, lop.id]);
    if (!exists.rowCount)
      await client.query(
        `INSERT INTO leave_requests(organization_id,employee_id,approver_id,leave_type_id,start_date,end_date,days,reason,status,decided_at,decision_note)
         VALUES($1,$2,$3,$4,'2026-09-14','2026-09-15',2,'Family function out of town (unpaid)','APPROVED',now(),'Approved as loss of pay — no leave balance')`,
        [org.id, arjun.id, manager.id, lop.id]);
  }
  await client.query("COMMIT");
  client.release();
}
const claimTitle = "Milk & pastry supplier run — Indiranagar";
const existingClaim = (await pool.query("SELECT c.id FROM hr_cases c JOIN employees e ON e.id=c.requester_id WHERE c.organization_id=$1 AND c.module='expenses' AND c.title=$2", [org.id, claimTitle])).rows[0];
if (!existingClaim) {
  const claim = await call("BT002", "POST", "/cases", { module: "expenses", values: { category: "Local travel", title: claimTitle, amount: 1240, startDate: "2026-09-08", merchant: "Rapido", description: "Two supplier pickups while the van was in service." } });
  await call("BT001", "POST", `/cases/${claim.id}/transitions`, { action: "approve", version: claim.version, note: "Approved — reimburse through September payroll." });
  console.log(`Expense claim ${claim.caseNumber} approved (will be reimbursed via payroll).`);
}

// 3. Runs: Apr–Aug published (Apr–Jul locked), Sept calculated.
const runs = (await call(MAKER, "GET", "/payroll/runs")).items;
const liveRun = (period) => runs.find((run) => run.period === period && run.status !== "CANCELLED");
const id = (number) => employees.get(number)?.id;
const inputsFor = {
  "2026-05": [["BT010", "INCENTIVE", 4000, "Store sales incentive — April"]],
  "2026-06": [["BT005", "BONUS", 25000, "Roast quality award"], ["BT002", "OVERTIME", 1800, "Weekend overtime"]],
  "2026-07": [["BT010", "INCENTIVE", 6000, "Store sales incentive — June"], ["BT004", "LOP_DAYS", 1, "Unauthorised absence 18 Jul", true]],
  "2026-08": [["BT001", "VARIABLE_PAY", 45000, "Q1 variable pay"], ["BT002", "RECOVERY", 500, "Uniform recovery"], ["BT010", "INCENTIVE", 5500, "Store sales incentive — July"]],
  "2026-09": [["BT008", "ARREARS", 12000, "Shift allowance arrears (Jun–Aug)"], ["BT003", "LOP_DAYS", 1, "Absent without leave 5 Sep", true], ["BT010", "INCENTIVE", 7000, "Store sales incentive — August"], ["BT006", "LOAN_EMI", 5000, "Salary advance EMI 2/6"]],
};
async function addInputs(run, period) {
  const detail = await call(MAKER, "GET", `/payroll/runs/${run.id}`);
  for (const [number, code, value, label, isDays] of inputsFor[period] || []) {
    if (!id(number) || detail.inputs.some((input) => input.employeeId === id(number) && input.label === label)) continue;
    await call(MAKER, "POST", `/payroll/runs/${run.id}/inputs`, { employeeId: id(number), code, label, ...(isDays ? { days: value } : { amount: value }) });
  }
}
const refresh = (run) => call(MAKER, "GET", `/payroll/runs/${run.id}`);

for (const period of ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]) {
  let run = liveRun(period);
  if (run && ["PUBLISHED", "LOCKED"].includes(run.status)) { console.log(`${period}: already ${run.status.toLowerCase()}`); continue; }
  if (!run) run = await call(MAKER, "POST", "/payroll/runs", { period, includeExpenses: false, notes: "Seeded demo run" });
  if (["DRAFT", "CALCULATED"].includes(run.status)) {
    await addInputs(run, period);
    run = await call(MAKER, "POST", `/payroll/runs/${run.id}/calculate`, { version: (await refresh(run)).version });
    run = await call(MAKER, "POST", `/payroll/runs/${run.id}/transitions`, { action: "submit", version: run.version });
  }
  if (run.status === "SUBMITTED") run = await call(CHECKER, "POST", `/payroll/runs/${run.id}/transitions`, { action: "approve", version: run.version, note: "Reviewed variance report" });
  if (run.status === "APPROVED") run = await call(MAKER, "POST", `/payroll/runs/${run.id}/transitions`, { action: "publish", version: run.version });
  if (period < "2026-08" && run.status === "PUBLISHED") run = await call(CHECKER, "POST", `/payroll/runs/${run.id}/transitions`, { action: "lock", version: run.version });
  console.log(`${period}: ${run.status.toLowerCase()} — ${run.totals.payable} paid, net ₹${Math.round(run.totals.net).toLocaleString("en-IN")}`);
}

{
  const period = "2026-09";
  let run = liveRun(period);
  if (!run) run = await call(MAKER, "POST", "/payroll/runs", { period, includeExpenses: true, notes: "September payroll — pay date 30 Sep" });
  if (["DRAFT", "CALCULATED"].includes(run.status)) {
    await addInputs(run, period);
    run = await call(MAKER, "POST", `/payroll/runs/${run.id}/calculate`, { version: (await refresh(run)).version });
    const detail = await refresh(run);
    const farhan = detail.lines.find((line) => line.number === "BT006");
    if (farhan && !farhan.held) await call(MAKER, "POST", `/payroll/runs/${run.id}/lines/${farhan.employeeId}/hold`, { hold: true, reason: "Bank account change pending verification" });
    run = await refresh(run);
  }
  console.log(`${period}: ${run.status.toLowerCase()} — ${run.totals.payable} payable, ${run.totals.held} held, ${run.totals.flagged} flagged, net ₹${Math.round(run.totals.net || 0).toLocaleString("en-IN")}`);
}
await pool.end();

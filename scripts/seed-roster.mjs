import './lib/dev-only.mjs'; // refuses to run in production — see the file
// Seeds the shift roster through the platform API so validation, authorization, publishing and notifications run
// exactly as in the UI: default café shift templates, a published roster for the week of 21 Sep 2026 and a draft for
// the week of 28 Sep 2026 for Ananya Sharma's (BT001) team — with a clopen rest warning, a 7-day/56 h week, an
// approved leave that collides with a planned shift and an approved (not yet applied) shift-swap request.
// Usage: npm run db:seed:roster     (requires the platform API on BACKEND_V2_PORT; re-runnable)
import "dotenv/config";
import pg from "pg";

const api = `http://localhost:${process.env.BACKEND_V2_PORT || 4100}/api/v2`;
const actors = { employee: "BT002", manager: "BT001", hr: "BT000" };
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const THIS_WEEK = "2026-09-21";
const NEXT_WEEK = "2026-09-28";
const REQUEST_TITLE = "Roster demo — college exam on Friday morning";

async function call(actor, path, body, method) {
  const response = await fetch(`${api}${path}`, {
    method: method || (body ? "POST" : "GET"),
    headers: { "content-type": "application/json", "x-tenant-id": "tenant-demo-001", "x-employee-id": actors[actor] },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${actor} ${method || (body ? "POST" : "GET")} ${path}: ${response.status} ${JSON.stringify(data.message)}`);
  return data;
}
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const org = (await pool.query("SELECT id FROM organizations WHERE slug='blue-tokai'")).rows[0];
if (!org) throw new Error("Run npm run db:seed first — the demo organization is missing.");
const team = new Map((await pool.query(
  `SELECT e.employee_number, e.id FROM employees e JOIN employees m ON m.id=e.manager_id
    WHERE e.organization_id=$1 AND m.employee_number='BT001' AND e.status='ACTIVE' AND e.employee_number IN ('BT002','BT003','BT004','BT010','BT900')`,
  [org.id])).rows.map((row) => [row.employee_number, row.id]));
if (team.size < 3) throw new Error("BT001's team is missing — run npm run db:seed:cases first.");

const context = await call("hr", "/roster/context");
const tpl = Object.fromEntries(context.templates.map((template) => [template.code, template.id]));
for (const code of ["OPEN", "MID", "CLOSE", "GEN"]) if (!tpl[code]) throw new Error(`Template ${code} is missing.`);
const ids = [...team.values()];

// Start from a clean slate for these two weeks (roster data only; created by this feature).
{
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.organization_id',$1,true)", [org.id]);
  await client.query(`DELETE FROM roster_assignments WHERE organization_id=$1 AND employee_id = ANY($2) AND work_date BETWEEN $3 AND $4`, [org.id, ids, THIS_WEEK, addDays(NEXT_WEEK, 6)]);
  await client.query(`DELETE FROM roster_publications WHERE organization_id=$1 AND employee_id = ANY($2) AND week_start IN ($3,$4)`, [org.id, ids, THIS_WEEK, NEXT_WEEK]);
  await client.query("COMMIT");
  client.release();
}

// Patterns: one code per day Mon→Sun. OFF = weekly off, "" = leave unplanned.
const thisWeek = {
  BT002: ["OPEN", "CLOSE", "OPEN", "MID", "OFF", "CLOSE", "CLOSE"], // Tue close → Wed open: only 8 h rest (warning)
  BT003: ["MID", "MID", "CLOSE", "CLOSE", "CLOSE", "OFF", "OPEN"],
  BT004: ["CLOSE", "OFF", "MID", "OPEN", "OPEN", "OPEN", "MID"],
  BT010: ["GEN", "GEN", "GEN", "GEN", "GEN", "GEN", "OFF"],
  BT900: ["OPEN", "OPEN", "OFF", "CLOSE", "MID", "MID", "OFF"],
};
const nextWeek = {
  BT002: ["MID", "MID", "OFF", "OPEN", "OPEN", "CLOSE", "CLOSE"], // Thu 1 Oct collides with approved leave below
  BT003: ["OPEN", "OPEN", "OPEN", "OFF", "CLOSE", "CLOSE", "MID"],
  BT004: ["CLOSE", "OFF", "MID", "MID", "OPEN", "OPEN", "CLOSE"],
  BT010: ["GEN", "GEN", "GEN", "GEN", "GEN", "GEN", "GEN"], // 7 days, 56 h, no weekly off (warnings)
  BT900: ["OFF", "MID", "CLOSE", "CLOSE", "MID", "OFF", ""],
};
const location = { BT002: "Bengaluru — Indiranagar", BT003: "Bengaluru — Indiranagar", BT004: "Bengaluru — Indiranagar", BT010: "Mumbai — Bandra", BT900: "Delhi — Khan Market" };
const items = (week, plan) => Object.entries(plan).filter(([number]) => team.has(number)).flatMap(([number, codes]) => codes.map((code, index) => (
  !code ? null : { employeeId: team.get(number), date: addDays(week, index), kind: code === "OFF" ? "WEEKLY_OFF" : "SHIFT", templateId: code === "OFF" ? undefined : tpl[code], location: location[number] }
)).filter(Boolean));

const first = await call("manager", "/roster/assignments", { items: items(THIS_WEEK, thisWeek), skipConflicts: true }, "PUT");
first.note = "this week";
const published = await call("manager", "/roster/weeks/publish", { start: THIS_WEEK, employeeIds: ids });
const draft = await call("manager", "/roster/assignments", { items: items(NEXT_WEEK, nextWeek), skipConflicts: true }, "PUT");
console.log(`This week: ${first.saved} cells saved, ${published.notified} employees notified. Next week draft: ${draft.saved} cells.`);

// Approved leave on Thu 1 Oct for Ravi (BT002) — decided after the shift was planned, so the planner shows a conflict.
const ravi = team.get("BT002");
if (ravi) {
  const leaveDate = addDays(NEXT_WEEK, 3);
  const existing = (await pool.query(
    `SELECT id, status FROM leave_requests WHERE organization_id=$1 AND employee_id=$2 AND status IN ('PENDING','APPROVED') AND start_date <= $3 AND end_date >= $3`,
    [org.id, ravi, leaveDate])).rows[0];
  let leaveId = existing?.id;
  if (!existing) {
    const casual = (await call("employee", "/leave-types")).items?.find((type) => type.code === "CL") || (await call("employee", "/leave-types")).find?.((type) => type.code === "CL");
    const leave = await call("employee", "/leaves", { leaveTypeId: casual.id, startDate: leaveDate, endDate: leaveDate, days: 1, reason: "Sister's graduation ceremony" });
    leaveId = leave.id;
  }
  if (existing?.status !== "APPROVED" && leaveId) await call("manager", `/approvals/leaves/${leaveId}/decision`, { decision: "APPROVED", note: "Enjoy the day — I'll rework Thursday's opening." });
  // On re-runs the leave already exists, so the API (correctly) refuses to plan over it. Recreate the
  // "shift planned before the leave was approved" situation directly so the planner shows the conflict.
  const manager = (await pool.query(`SELECT id FROM employees WHERE organization_id=$1 AND employee_number='BT001'`, [org.id])).rows[0];
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.organization_id',$1,true)", [org.id]);
  await client.query(
    `INSERT INTO roster_assignments(organization_id,employee_id,work_date,kind,template_id,location,created_by,updated_by)
     VALUES($1,$2,$3,'SHIFT',$4,$5,$6,$6) ON CONFLICT (organization_id,employee_id,work_date) DO NOTHING`,
    [org.id, ravi, leaveDate, tpl.OPEN, location.BT002, manager.id]);
  await client.query("COMMIT");
  client.release();
  console.log(`Leave on ${leaveDate} for Ravi: approved (conflicts with his planned Opening shift).`);
}

// An approved shift swap for Fri 2 Oct (Ravi takes Closing, swapping with Priya) waiting to be applied.
const priya = team.get("BT003");
if (ravi && priya) {
  const found = (await pool.query(`SELECT id, status, version FROM hr_cases WHERE organization_id=$1 AND module='shifts' AND title=$2 LIMIT 1`, [org.id, REQUEST_TITLE])).rows[0];
  let request = found;
  if (!request) request = await call("employee", "/cases", { module: "shifts", values: {
    category: "Closing · 15:00–23:00", startDate: addDays(NEXT_WEEK, 4), endDate: addDays(NEXT_WEEK, 4), subjectEmployeeId: priya, title: REQUEST_TITLE } });
  if (request.status === "SUBMITTED") await call("manager", `/cases/${request.id}/transitions`, { action: "approve", version: request.version, note: "Approved — Priya confirmed the swap." });
  console.log("Shift swap request approved (apply it from the roster planner).");
}

const summary = await call("manager", `/roster/week?start=${NEXT_WEEK}`);
console.log(`Next week: ${summary.summary.warnings} warnings, ${summary.summary.gaps} coverage gaps, ${summary.summary.pendingRequests} shift request(s) to apply.`);
await pool.end();

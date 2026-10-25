import './lib/dev-only.mjs'; // refuses to run in production — see the file
// Seeds demo custom roles through the platform API (so validation, guardrails and audit run exactly as in the UI).
// Re-runnable: existing roles (matched by name) and live assignments are left alone.
// Usage: node scripts/seed-access.mjs      (requires the platform API on BACKEND_V2_PORT)
import "dotenv/config";

const api = `http://localhost:${process.env.BACKEND_V2_PORT || 4100}/api/v2/access`;
const HR = "BT000";

async function call(path, body, method = body ? "POST" : "GET") {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-tenant-id": "tenant-demo-001", "x-employee-id": HR },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data.message)}`);
  return data;
}

const roles = [
  {
    name: "Store Manager",
    description: "Runs a café: plans the weekly roster and approves leave for the baristas who report to them.",
    permissions: [{ key: "roster.plan", scope: "DIRECT_REPORTS" }, { key: "leave.approve", scope: "DIRECT_REPORTS" }, { key: "attendance.view", scope: "DIRECT_REPORTS" }],
    basedOn: "system:MANAGER",
  },
  {
    name: "Payroll Checker",
    description: "Second pair of eyes on payroll: can approve or send back a submitted run, nothing else.",
    permissions: [{ key: "payroll.run.approve", scope: "ORGANIZATION" }],
    confirm: true, reason: "Maker-checker: finance controller approves runs prepared by payroll.",
  },
  {
    name: "Auditor (read-only)",
    description: "Internal or statutory auditor: reads the audit trail and workforce reports, changes nothing.",
    permissions: [{ key: "audit.view", scope: "ORGANIZATION" }, { key: "reports.view", scope: "ORGANIZATION" }],
  },
];

const existing = await call("/roles");
const byName = new Map(existing.custom.map((role) => [role.name.toLowerCase(), role]));
for (const role of roles) {
  if (byName.has(role.name.toLowerCase())) { console.log(`• ${role.name} already exists`); continue; }
  const created = await call("/roles", role);
  byName.set(role.name.toLowerCase(), created);
  console.log(`✓ created ${role.name}`);
}

// Visible demo effect: Ananya (BT001, manager) gets the Auditor role, so the Audit log tab and access review open for her.
const people = await call("/people?search=BT001");
const ananya = people.items.find((person) => person.number === "BT001");
const auditor = byName.get("auditor (read-only)");
if (ananya && auditor && !ananya.customRoles.some((role) => role.roleId === auditor.id)) {
  await call("/assignments", { employeeId: ananya.id, roleId: auditor.id, reason: "Quarterly internal audit of the retail region (demo)" });
  console.log("✓ assigned Auditor (read-only) to Ananya Sharma (BT001)");
} else console.log("• Ananya already holds Auditor (read-only)");
console.log("Done.");

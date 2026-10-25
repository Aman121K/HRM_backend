/**
 * Permission catalogue, data scopes and built-in (system) roles.
 *
 * Built-in roles mirror what the base membership roles can do today, so turning permissions on changes nothing for
 * existing users. Organizations layer custom roles on top (see access.service.ts); a person's effective permissions
 * are the union of their base role and every live custom-role assignment (see effective.ts).
 */

export const SCOPES = ["OWN", "DIRECT_REPORTS", "ALL_REPORTS", "DEPARTMENT", "LOCATION", "ORGANIZATION"] as const;
export type Scope = (typeof SCOPES)[number];
export const SCOPE_LABELS: Record<Scope, string> = {
  OWN: "Own records",
  DIRECT_REPORTS: "Direct reports",
  ALL_REPORTS: "All reports (whole reporting tree)",
  DEPARTMENT: "Own department",
  LOCATION: "Own location",
  ORGANIZATION: "Whole organization",
};
export const scopeRank = (scope: Scope) => SCOPES.indexOf(scope);

export type Risk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type PermissionDef = {
  key: string;
  label: string;
  description: string;
  risk: Risk;
  /** Scopable permissions carry a data scope; the rest are organization-wide capabilities. */
  scopable: boolean;
  /** Where the platform already enforces this permission (shown to admins so grants are never "decorative"). */
  enforcedAt?: string[];
};
export type PermissionGroup = { key: string; label: string; description: string; permissions: PermissionDef[] };

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    key: "self", label: "Self-service", description: "What every employee does for themselves.",
    permissions: [
      { key: "self.profile", label: "Own profile", description: "View and update their own profile, documents and requests.", risk: "LOW", scopable: false },
      { key: "leave.apply", label: "Apply for leave", description: "Submit and withdraw their own leave requests.", risk: "LOW", scopable: false, enforcedAt: ["POST /api/v2/leaves"] },
      { key: "attendance.punch", label: "Punch attendance", description: "Punch in / out from web or mobile with location.", risk: "LOW", scopable: false },
      { key: "cases.raise", label: "Raise requests", description: "Raise helpdesk tickets, expense claims, travel and asset requests.", risk: "LOW", scopable: false },
    ],
  },
  {
    key: "people", label: "People & organization", description: "Employee records and the organization structure.",
    permissions: [
      { key: "people.view", label: "View employee records", description: "See employee profiles, job details and reporting lines beyond the public directory.", risk: "MEDIUM", scopable: true },
      { key: "people.edit", label: "Edit employee records", description: "Change job details, reporting managers, departments and locations.", risk: "HIGH", scopable: true },
      { key: "people.sensitive.view", label: "View sensitive personal data", description: "See PAN, Aadhaar, bank, address and family details.", risk: "HIGH", scopable: true },
      { key: "onboarding.manage", label: "Manage onboarding", description: "Create joiners, run onboarding checklists and verify joining documents.", risk: "MEDIUM", scopable: true },
      { key: "recruiting.manage", label: "Manage job openings", description: "Publish openings, move candidates and make offers.", risk: "MEDIUM", scopable: false },
    ],
  },
  {
    key: "time", label: "Time, leave & rosters", description: "Leave approvals, attendance and shift planning.",
    permissions: [
      { key: "leave.approve", label: "Approve leave", description: "Open the leave approval queue and approve or reject requests routed to them.", risk: "MEDIUM", scopable: true, enforcedAt: ["GET /api/v2/approvals/leaves", "POST /api/v2/approvals/leaves/:id/decision"] },
      { key: "leave.policy.manage", label: "Manage leave policies", description: "Configure leave types, quotas and holiday calendars.", risk: "MEDIUM", scopable: false },
      { key: "attendance.view", label: "View attendance", description: "See punches, worked hours and geofence exceptions of others.", risk: "MEDIUM", scopable: true },
      { key: "attendance.sites.manage", label: "Manage attendance sites", description: "Add work sites and change geofence radius or status.", risk: "MEDIUM", scopable: false, enforcedAt: ["POST /api/v2/attendance/sites", "PATCH /api/v2/attendance/sites/:id"] },
      { key: "roster.plan", label: "Plan rosters", description: "Assign shifts, copy and publish weekly rosters, apply shift-change requests.", risk: "MEDIUM", scopable: true, enforcedAt: ["PUT /api/v2/roster/assignments", "POST /api/v2/roster/weeks/*", "POST /api/v2/roster/shift-requests/:id/apply"] },
      { key: "roster.settings.manage", label: "Manage shift templates", description: "Create shift templates and roster rules for the organization.", risk: "MEDIUM", scopable: false },
    ],
  },
  {
    key: "payroll", label: "Payroll", description: "Salary data and the monthly payroll cycle.",
    permissions: [
      { key: "payroll.view", label: "View pay data", description: "See salary structures, payslips and CTC of others.", risk: "HIGH", scopable: true },
      { key: "payroll.run.prepare", label: "Prepare payroll runs", description: "Create and calculate runs, add one-time inputs, hold lines and submit for approval.", risk: "HIGH", scopable: false },
      { key: "payroll.run.approve", label: "Approve payroll runs", description: "Approve or send back a submitted payroll run (maker-checker).", risk: "CRITICAL", scopable: false },
      { key: "payroll.structure.edit", label: "Edit salary structures", description: "Create and change salary structures and CTC.", risk: "HIGH", scopable: false },
      { key: "payroll.profile.edit", label: "Edit payroll profiles", description: "Change bank accounts, PAN, UAN and tax regime used for payouts.", risk: "CRITICAL", scopable: true },
      { key: "payroll.export", label: "Export bank & statutory files", description: "Download bank transfer, PF ECR, ESI and PT files.", risk: "HIGH", scopable: false },
      { key: "payroll.settings.edit", label: "Payroll settings", description: "Statutory codes, PF wage mode and the debit account.", risk: "HIGH", scopable: false },
    ],
  },
  {
    key: "services", label: "Requests & helpdesk", description: "The case engine: helpdesk, expenses, travel, assets, letters.",
    permissions: [
      { key: "cases.helpdesk.handle", label: "Handle helpdesk tickets", description: "Pick up, respond to and resolve helpdesk tickets.", risk: "MEDIUM", scopable: true },
      { key: "cases.approve", label: "Approve requests", description: "Approve expense, travel, asset and letter requests routed to them.", risk: "MEDIUM", scopable: true },
      { key: "cases.admin", label: "Administer requests", description: "See and act on every request across modules.", risk: "HIGH", scopable: false },
    ],
  },
  {
    key: "talent", label: "Learning & engagement", description: "Courses, surveys and polls.",
    permissions: [
      { key: "lms.author", label: "Author courses", description: "Create courses and lessons and assign learning.", risk: "LOW", scopable: true },
      { key: "lms.analytics", label: "Learning analytics", description: "Company-wide completion analytics and exports.", risk: "MEDIUM", scopable: false },
      { key: "surveys.manage", label: "Run surveys & polls", description: "Build, launch and close surveys and polls.", risk: "MEDIUM", scopable: true },
      { key: "surveys.results", label: "View survey results", description: "See anonymised survey results and comments.", risk: "MEDIUM", scopable: true },
    ],
  },
  {
    key: "reports", label: "Reports & analytics", description: "Workforce dashboards and exports.",
    permissions: [
      { key: "reports.view", label: "View reports", description: "Headcount, attrition, leave and attendance analytics.", risk: "MEDIUM", scopable: true },
      { key: "reports.payroll", label: "Payroll reports", description: "Cost, CTC and payroll variance analytics.", risk: "HIGH", scopable: false },
      { key: "reports.export", label: "Export reports", description: "Download report data as CSV.", risk: "MEDIUM", scopable: false },
    ],
  },
  {
    key: "admin", label: "Administration", description: "Access control, integrations and platform operations.",
    permissions: [
      { key: "settings.access", label: "Manage roles & access", description: "Create roles, assign access and change base roles.", risk: "CRITICAL", scopable: false, enforcedAt: ["/api/v2/access/* (write)"] },
      { key: "settings.organization", label: "Organization settings", description: "Organization profile, branding and policies.", risk: "HIGH", scopable: false },
      { key: "integrations.manage", label: "Manage integrations", description: "Connect biometric devices, SSO, accounting and webhooks.", risk: "HIGH", scopable: false },
      { key: "jobs.manage", label: "Background jobs", description: "View, retry and pause scheduled platform jobs.", risk: "MEDIUM", scopable: false },
      { key: "audit.view", label: "View audit log", description: "Read the audit trail of every change in the organization and run access reviews.", risk: "HIGH", scopable: false, enforcedAt: ["GET /api/v2/access/audit", "GET /api/v2/access/review/*"] },
    ],
  },
];

export const PERMISSIONS: PermissionDef[] = PERMISSION_GROUPS.flatMap((group) => group.permissions);
export const PERMISSION_KEYS = PERMISSIONS.map((permission) => permission.key);
export const PERMISSION_INDEX = new Map(PERMISSIONS.map((permission) => [permission.key, permission]));
export const groupOf = (key: string) => PERMISSION_GROUPS.find((group) => group.permissions.some((permission) => permission.key === key));
/** Grants of these permissions (in a role or an assignment) need an explicit confirmation and a written reason. */
export const needsConfirmation = (key: string) => PERMISSION_INDEX.get(key)?.risk === "CRITICAL";

export type Grant = { key: string; scope: Scope };

export const BASE_ROLES = ["OWNER", "HR_ADMIN", "PAYROLL_ADMIN", "MANAGER", "EMPLOYEE"] as const;
export type BaseRole = (typeof BASE_ROLES)[number];

const all = (): Grant[] => PERMISSIONS.map((permission) => ({ key: permission.key, scope: "ORGANIZATION" }));
const selfService: Grant[] = [
  { key: "self.profile", scope: "ORGANIZATION" }, { key: "leave.apply", scope: "ORGANIZATION" },
  { key: "attendance.punch", scope: "ORGANIZATION" }, { key: "cases.raise", scope: "ORGANIZATION" },
  { key: "people.view", scope: "OWN" }, { key: "attendance.view", scope: "OWN" }, { key: "payroll.view", scope: "OWN" },
];
const withSelf = (grants: Grant[]): Grant[] => {
  const map = new Map(selfService.map((grant) => [grant.key, grant]));
  for (const grant of grants) map.set(grant.key, grant);
  return [...map.values()];
};

export type SystemRole = { id: string; baseRole: BaseRole; name: string; description: string; grants: Grant[]; note?: string };
export const SYSTEM_ROLES: SystemRole[] = [
  { id: "system:OWNER", baseRole: "OWNER", name: "Owner", description: "Full control of the organization, including who else is an owner.", grants: all() },
  { id: "system:HR_ADMIN", baseRole: "HR_ADMIN", name: "HR administrator", description: "Runs the people function end to end: records, policies, payroll, access and audit.", grants: all() },
  {
    id: "system:PAYROLL_ADMIN", baseRole: "PAYROLL_ADMIN", name: "Payroll administrator", description: "Owns salary data and the monthly payroll cycle.",
    note: "Holds both prepare and approve; the payroll engine still blocks approving a run you submitted (maker-checker).",
    grants: withSelf([
      { key: "people.view", scope: "ORGANIZATION" }, { key: "payroll.view", scope: "ORGANIZATION" },
      { key: "payroll.run.prepare", scope: "ORGANIZATION" }, { key: "payroll.run.approve", scope: "ORGANIZATION" },
      { key: "payroll.structure.edit", scope: "ORGANIZATION" }, { key: "payroll.profile.edit", scope: "ORGANIZATION" },
      { key: "payroll.export", scope: "ORGANIZATION" }, { key: "payroll.settings.edit", scope: "ORGANIZATION" },
      { key: "reports.view", scope: "ORGANIZATION" }, { key: "reports.payroll", scope: "ORGANIZATION" },
    ]),
  },
  {
    id: "system:MANAGER", baseRole: "MANAGER", name: "People manager", description: "Leads a team: approvals, rosters, team learning and surveys for direct reports.",
    grants: withSelf([
      { key: "people.view", scope: "DIRECT_REPORTS" }, { key: "attendance.view", scope: "DIRECT_REPORTS" },
      { key: "leave.approve", scope: "DIRECT_REPORTS" }, { key: "roster.plan", scope: "DIRECT_REPORTS" },
      { key: "cases.approve", scope: "DIRECT_REPORTS" }, { key: "lms.author", scope: "DIRECT_REPORTS" },
      { key: "surveys.manage", scope: "DIRECT_REPORTS" }, { key: "surveys.results", scope: "DIRECT_REPORTS" },
      { key: "onboarding.manage", scope: "DIRECT_REPORTS" }, { key: "reports.view", scope: "DIRECT_REPORTS" },
    ]),
  },
  { id: "system:EMPLOYEE", baseRole: "EMPLOYEE", name: "Employee", description: "Self-service for their own profile, leave, attendance, pay and requests.", grants: withSelf([]) },
];
export const systemRole = (baseRole: string) => SYSTEM_ROLES.find((role) => role.baseRole === baseRole);

/** Separation-of-duties rules: holding both sides (from any mix of roles) raises a warning. */
export const SOD_RULES: { id: string; permissions: [string, string]; message: string }[] = [
  { id: "payroll-maker-checker", permissions: ["payroll.run.prepare", "payroll.run.approve"], message: "Can both prepare and approve payroll runs. Keep a second approver; the engine blocks approving a run you submitted." },
  { id: "payroll-structure-approve", permissions: ["payroll.structure.edit", "payroll.run.approve"], message: "Can change salaries and approve the run that pays them." },
  { id: "payroll-bank-approve", permissions: ["payroll.profile.edit", "payroll.run.approve"], message: "Can change bank accounts and approve payouts to them — a classic payroll-fraud path." },
  { id: "access-audit", permissions: ["settings.access", "integrations.manage"], message: "Can grant access and connect external systems; review these grants regularly." },
];
export const sodWarnings = (keys: Iterable<string>) => {
  const set = new Set(keys);
  return SOD_RULES.filter((rule) => rule.permissions.every((key) => set.has(key)));
};

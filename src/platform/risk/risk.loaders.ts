// Data loaders for the detectors. Every query runs inside a tenant transaction AND filters organization_id = $1
// explicitly (defence in depth on top of row-level security). Loaders shape rows for the pure detector functions.
import type { PoolClient } from "pg";
import { caseModuleMap, caseModules } from "../cases/case-modules";
import { approverPendingStatuses } from "../jobs/scheduling";
import type { Punch, Site } from "./attendance-integrity";
import type { ComplianceFacts, GratuityEmployee, Mark, RunFact } from "./compliance";
import type { Claim, ExpenseInput } from "./expense-fraud";
import type { LabourInput, RosterDay, WorkedDay } from "./labour";
import type { PayrollInput, RunLine } from "./payroll-anomalies";
import type { LiabilityInput, PendingApproval, PeopleInput, Ticket } from "./people-service";
import { addDays, localDate } from "./risk.types";
import type { MinimumWage, RiskSettings } from "./risk.settings";

export type OrgContext = { id: string; timezone: string; defaultState: string; today: string; now: Date };
const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
const numOrNull = (value: unknown) => (value === null || value === undefined ? null : Number(value));

export async function loadOrg(client: PoolClient, organizationId: string, now = new Date()): Promise<OrgContext> {
  const row = (await client.query(`SELECT id, timezone, default_state FROM organizations WHERE id=$1`, [organizationId])).rows[0];
  const timezone = row?.timezone || "Asia/Kolkata";
  return { id: organizationId, timezone, defaultState: row?.default_state || "KA", today: localDate(now, timezone), now };
}

/** Employee → state code: payroll profile, else the PT state payroll derived from location, else the brand default. */
export async function employeeStates(client: PoolClient, org: OrgContext) {
  const rows = (await client.query(
    `SELECT e.id, pp.state_code,
            (SELECT l.breakdown->'statutory'->'pt'->>'state' FROM payroll_run_lines l JOIN payroll_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
              WHERE l.organization_id=$1 AND l.employee_id=e.id AND r.status<>'CANCELLED' ORDER BY r.period DESC LIMIT 1) AS pt_state
       FROM employees e LEFT JOIN payroll_profiles pp ON pp.organization_id=e.organization_id AND pp.employee_id=e.id
      WHERE e.organization_id=$1`, [org.id])).rows;
  return new Map<string, string | null>(rows.map((row) => [row.id, row.state_code || row.pt_state || org.defaultState]));
}

async function approvedLeaveDays(client: PoolClient, org: OrgContext, from: string, to: string) {
  const rows = (await client.query(
    `SELECT employee_id, to_char(d::date,'YYYY-MM-DD') AS day
       FROM leave_requests l, generate_series(greatest(l.start_date,$2::date), least(l.end_date,$3::date), interval '1 day') d
      WHERE l.organization_id=$1 AND l.status='APPROVED' AND l.end_date >= $2::date AND l.start_date <= $3::date`, [org.id, from, to])).rows;
  const map = new Map<string, Set<string>>();
  for (const row of rows) (map.get(row.employee_id) || map.set(row.employee_id, new Set()).get(row.employee_id)!).add(row.day);
  return map;
}

// --------------------------------------------------------------------------------------------------------- compliance

export async function loadCompliance(client: PoolClient, org: OrgContext) {
  const runs = (await client.query(
    `SELECT id, period, status, totals FROM payroll_runs WHERE organization_id=$1 AND status<>'CANCELLED' ORDER BY period`, [org.id])).rows;
  const pt = (await client.query(
    `SELECT l.run_id, l.breakdown->'statutory'->'pt'->>'state' AS state, sum(l.pt) AS amount
       FROM payroll_run_lines l WHERE l.organization_id=$1 AND l.status='INCLUDED' GROUP BY 1,2`, [org.id])).rows;
  const exports = (await client.query(
    `SELECT entity_id AS run_id, after_data->>'kind' AS kind, max(created_at) AS at FROM audit_log
      WHERE organization_id=$1 AND action='PAYROLL_EXPORTED' AND entity_type='payroll_run' GROUP BY 1,2`, [org.id])).rows;
  const marks = (await client.query(
    `SELECT obligation_key, status, reference, note, marked_at, u.full_name AS marked_by
       FROM risk_compliance_marks m LEFT JOIN users u ON u.id=m.marked_by WHERE m.organization_id=$1`, [org.id])).rows;
  const facts: ComplianceFacts = {
    runs: runs.map((run): RunFact => ({
      id: run.id, period: run.period, status: run.status, totals: run.totals || {},
      ptByState: Object.fromEntries(pt.filter((row) => row.run_id === run.id && row.state).map((row) => [row.state, num(row.amount)])),
      exports: exports.filter((row) => row.run_id === run.id).map((row) => ({ kind: row.kind, at: iso(row.at) })),
    })),
    marks: Object.fromEntries(marks.map((row) => [row.obligation_key, { status: "FILED", reference: row.reference, note: row.note, markedAt: iso(row.marked_at), markedBy: row.marked_by } satisfies Mark])),
    firstRunPeriod: runs[0]?.period || null,
  };
  const stateRows = (await client.query(
    `SELECT DISTINCT state_code AS state FROM payroll_profiles WHERE organization_id=$1 AND state_code IS NOT NULL
     UNION SELECT DISTINCT breakdown->'statutory'->'pt'->>'state' FROM payroll_run_lines WHERE organization_id=$1 AND breakdown->'statutory'->'pt'->>'state' IS NOT NULL`, [org.id])).rows;
  const states = [...new Set([org.defaultState, ...stateRows.map((row) => row.state as string)])].filter(Boolean).sort();
  return { facts, states };
}

async function basicByEmployee(client: PoolClient, org: OrgContext) {
  const rows = (await client.query(
    `SELECT DISTINCT ON (employee_id) employee_id, fixed_monthly_gross,
            (SELECT (c->>'monthly')::numeric FROM jsonb_array_elements(components) c WHERE c->>'code'='BASIC' LIMIT 1) AS basic
       FROM salary_structures WHERE organization_id=$1 AND effective_from <= $2::date ORDER BY employee_id, effective_from DESC, created_at DESC`, [org.id, org.today])).rows;
  return new Map<string, { basic: number | null; gross: number }>(rows.map((row) => [row.employee_id, { basic: numOrNull(row.basic), gross: num(row.fixed_monthly_gross) }]));
}

async function exitDays(client: PoolClient, org: OrgContext) {
  const rows = (await client.query(
    `SELECT DISTINCT ON (coalesce(subject_employee_id, requester_id)) coalesce(subject_employee_id, requester_id) AS employee_id, to_char(end_date,'YYYY-MM-DD') AS last_day
       FROM hr_cases WHERE organization_id=$1 AND module='exit' AND end_date IS NOT NULL AND status NOT IN ('WITHDRAWN','REJECTED','CANCELLED')
      ORDER BY coalesce(subject_employee_id, requester_id), created_at DESC`, [org.id])).rows;
  return new Map<string, string>(rows.map((row) => [row.employee_id, row.last_day]));
}

export async function loadGratuity(client: PoolClient, org: OrgContext): Promise<GratuityEmployee[]> {
  const [basics, exits] = [await basicByEmployee(client, org), await exitDays(client, org)];
  const rows = (await client.query(`SELECT id, to_char(joining_date,'YYYY-MM-DD') AS joining FROM employees WHERE organization_id=$1 AND status='ACTIVE'`, [org.id])).rows;
  return rows.map((row) => ({ id: row.id, joiningDate: row.joining, basicMonthly: basics.get(row.id)?.basic ?? null, lastWorkingDay: exits.get(row.id) || null }));
}

// --------------------------------------------------------------------------------------------------------- attendance

export async function loadAttendance(client: PoolClient, org: OrgContext, settings: RiskSettings) {
  const rows = (await client.query(
    `SELECT a.id, a.employee_id, a.event_type, a.occurred_at, a.source, a.device_id, a.latitude, a.longitude, a.accuracy_metres,
            coalesce(a.site_id, d.site_id) AS site_id, a.within_geofence, a.review_status, a.review_note
       FROM attendance_events a
       LEFT JOIN integration_devices d ON d.organization_id=a.organization_id AND d.serial_number=a.device_id AND a.source='BIOMETRIC'
      WHERE a.organization_id=$1 AND a.occurred_at >= now() - make_interval(days => $2)
      ORDER BY a.occurred_at LIMIT 50000`, [org.id, settings.attendance.lookbackDays])).rows;
  const punches: Punch[] = rows.map((row) => ({
    id: row.id, employeeId: row.employee_id, at: iso(row.occurred_at), type: row.event_type, source: row.source, deviceId: row.device_id,
    lat: numOrNull(row.latitude), lng: numOrNull(row.longitude), accuracy: numOrNull(row.accuracy_metres), siteId: row.site_id,
    withinGeofence: row.within_geofence, reviewStatus: row.review_status,
  }));
  const sites: Site[] = (await client.query(`SELECT id, name, latitude, longitude, radius_metres FROM attendance_sites WHERE organization_id=$1 AND active`, [org.id])).rows
    .map((row) => ({ id: row.id, name: row.name, lat: Number(row.latitude), lng: Number(row.longitude), radius: Number(row.radius_metres) }));
  const pending = (await client.query(
    `SELECT id, employee_id, occurred_at FROM attendance_events WHERE organization_id=$1 AND review_status='PENDING' ORDER BY occurred_at LIMIT 2000`, [org.id])).rows
    .map((row) => ({ id: row.id, employeeId: row.employee_id, at: iso(row.occurred_at) }));
  const rejected = rows.filter((row) => row.review_status === "REJECTED").map((row) => ({ id: row.id, employeeId: row.employee_id, at: iso(row.occurred_at), note: row.review_note }));
  return { punches, sites, pending, rejected };
}

/** Pairs IN → next OUT (within 16 h) per person and local day. */
export function workedDays(punches: Pick<Punch, "employeeId" | "at" | "type">[], timeZone: string): WorkedDay[] {
  const byPerson = new Map<string, typeof punches>();
  for (const punch of punches) (byPerson.get(punch.employeeId) || byPerson.set(punch.employeeId, []).get(punch.employeeId)!).push(punch);
  const days = new Map<string, WorkedDay>();
  for (const [employeeId, list] of byPerson) {
    list.sort((a, b) => a.at.localeCompare(b.at));
    let open: string | null = null;
    for (const punch of list) {
      if (punch.type === "IN") { open = open ?? punch.at; continue; }
      if (!open) continue;
      const minutes = (Date.parse(punch.at) - Date.parse(open)) / 60000;
      if (minutes > 0 && minutes <= 16 * 60) {
        const date = localDate(open, timeZone);
        const key = `${employeeId}:${date}`;
        const day = days.get(key) || { employeeId, date, minutes: 0, firstIn: open, lastOut: punch.at };
        day.minutes += minutes; if (open < day.firstIn) day.firstIn = open; if (punch.at > day.lastOut) day.lastOut = punch.at;
        days.set(key, day);
      }
      open = null;
    }
  }
  return [...days.values()].map((day) => ({ ...day, minutes: Math.round(day.minutes) }));
}

// --------------------------------------------------------------------------------------------------------- labour

export async function loadLabour(client: PoolClient, org: OrgContext, settings: RiskSettings): Promise<LabourInput> {
  const from = addDays(org.today, -settings.labour.lookbackDays), to = addDays(org.today, 14);
  const roster: RosterDay[] = (await client.query(
    `SELECT r.employee_id, to_char(r.work_date,'YYYY-MM-DD') AS date, r.kind, to_char(t.start_time,'HH24:MI') AS start, to_char(t.end_time,'HH24:MI') AS "end", t.break_minutes
       FROM roster_assignments r
       JOIN employees e ON e.id=r.employee_id AND e.organization_id=r.organization_id AND e.status='ACTIVE'
       LEFT JOIN roster_shift_templates t ON t.id=r.template_id AND t.organization_id=r.organization_id
      WHERE r.organization_id=$1 AND r.work_date BETWEEN $2::date - 6 AND $3::date`, [org.id, from, to])).rows
    .map((row) => ({ employeeId: row.employee_id, date: row.date, kind: row.kind,
      shift: row.kind === "SHIFT" && row.start ? { employeeId: row.employee_id, date: row.date, start: row.start, end: row.end, breakMinutes: Number(row.break_minutes) || 0 } : undefined }));
  const events = (await client.query(
    `SELECT employee_id, occurred_at, event_type FROM attendance_events WHERE organization_id=$1 AND occurred_at >= $2::date - 1 ORDER BY occurred_at LIMIT 50000`, [org.id, from])).rows;
  const worked = workedDays(events.map((row) => ({ employeeId: row.employee_id, at: iso(row.occurred_at), type: row.event_type })), org.timezone).filter((day) => day.date >= from);
  const regularized = new Set<string>((await client.query(
    `SELECT employee_id || ':' || to_char(attendance_date,'YYYY-MM-DD') AS key FROM attendance_regularizations WHERE organization_id=$1 AND status='APPROVED' AND attendance_date >= $2::date`, [org.id, from])).rows.map((row) => row.key));
  return { roster, worked, leaveDays: await approvedLeaveDays(client, org, addDays(from, -6), to), regularized, states: await employeeStates(client, org) };
}

// --------------------------------------------------------------------------------------------------------- payroll

const lineSelect = `SELECT l.run_id, r.period, r.status AS run_status, l.employee_id, l.status, l.gross, l.net, l.previous_net, l.lop_days, l.payable_days, l.days_in_month,
       (SELECT coalesce(sum(abs((x->>'amount')::numeric)),0) FROM jsonb_array_elements(coalesce(l.breakdown->'oneTime','[]'::jsonb)) x) AS one_time,
       (l.breakdown->'statutory'->'pf'->>'applicable')::boolean AS pf, (l.breakdown->'statutory'->'esi'->>'covered')::boolean AS esi
  FROM payroll_run_lines l JOIN payroll_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
 WHERE l.organization_id=$1 AND l.run_id=$2`;
const toLine = (row: any): RunLine => ({
  runId: row.run_id, period: row.period, runStatus: row.run_status, employeeId: row.employee_id, status: row.status, gross: num(row.gross), net: num(row.net),
  previousNet: numOrNull(row.previous_net), lopDays: num(row.lop_days), payableDays: num(row.payable_days), daysInMonth: num(row.days_in_month), oneTime: num(row.one_time),
  pfApplicable: row.pf, esiCovered: row.esi,
});

export async function loadPayroll(client: PoolClient, org: OrgContext, minimumWages: MinimumWage[]): Promise<PayrollInput> {
  const runs = (await client.query(`SELECT id FROM payroll_runs WHERE organization_id=$1 AND status<>'CANCELLED' ORDER BY period DESC, created_at DESC LIMIT 2`, [org.id])).rows;
  const latest = runs[0] ? (await client.query(lineSelect, [org.id, runs[0].id])).rows.map(toLine) : [];
  const previous = runs[1] ? (await client.query(lineSelect, [org.id, runs[1].id])).rows.map(toLine) : [];
  const structures = (await client.query(`SELECT employee_id, to_char(effective_from,'YYYY-MM-DD') AS effective_from, fixed_monthly_gross FROM salary_structures WHERE organization_id=$1`, [org.id])).rows
    .map((row) => ({ employeeId: row.employee_id, effectiveFrom: row.effective_from, fixedMonthlyGross: num(row.fixed_monthly_gross) }));
  const states = await employeeStates(client, org);
  const exits = await exitDays(client, org);
  const employees = (await client.query(`SELECT id, status, to_char(joining_date,'YYYY-MM-DD') AS joining FROM employees WHERE organization_id=$1`, [org.id])).rows
    .map((row) => ({ id: row.id, status: row.status, state: states.get(row.id) || null, lastWorkingDay: exits.get(row.id) || null, joiningDate: row.joining }));
  const presenceRows = (await client.query(
    `SELECT employee_id, count(DISTINCT day) AS days, max(day) AS last FROM (
       SELECT employee_id, to_char((occurred_at AT TIME ZONE $3)::date,'YYYY-MM-DD') AS day FROM attendance_events WHERE organization_id=$1 AND occurred_at >= $2::date - 30
       UNION SELECT employee_id, to_char(work_date,'YYYY-MM-DD') FROM roster_assignments WHERE organization_id=$1 AND kind='SHIFT' AND work_date BETWEEN $2::date - 30 AND $2::date
     ) x GROUP BY employee_id`, [org.id, org.today, org.timezone])).rows;
  // Bank accounts are compared by the per-brand keyed blind index written with the encrypted value (field-crypto):
  // neither the raw number nor its ciphertext ever reaches this detector.
  const banks = (await client.query(
    `SELECT employee_id, bank_account_hash || ':' || upper(coalesce(ifsc,'')) AS fingerprint, bank_account_last4 AS last4, bank_name, ifsc
       FROM payroll_profiles WHERE organization_id=$1 AND bank_account_hash IS NOT NULL`, [org.id])).rows
    .map((row) => ({ employeeId: row.employee_id, fingerprint: row.fingerprint, last4: row.last4, bankName: row.bank_name, ifsc: row.ifsc }));
  return {
    latest, previous, structures, employees, banks, minimumWages, today: org.today,
    presence: new Map(presenceRows.map((row) => [row.employee_id, { days: Number(row.days), last: row.last }])),
  };
}

export async function loadMinimumWages(client: PoolClient, organizationId: string): Promise<MinimumWage[]> {
  return (await client.query(
    `SELECT state_code, category, monthly_amount, to_char(effective_from,'YYYY-MM-DD') AS effective_from, is_example, note FROM risk_minimum_wages
      WHERE organization_id=$1 ORDER BY state_code, category, effective_from`, [organizationId])).rows
    .map((row) => ({ stateCode: row.state_code, category: row.category, monthlyAmount: num(row.monthly_amount), effectiveFrom: row.effective_from, isExample: row.is_example, note: row.note }));
}

// --------------------------------------------------------------------------------------------------------- expenses

export async function loadExpenses(client: PoolClient, org: OrgContext, settings: RiskSettings): Promise<ExpenseInput> {
  const from = addDays(org.today, -settings.expenses.lookbackDays);
  const rows = (await client.query(
    `SELECT c.id, c.case_number, c.requester_id, c.category, c.amount, to_char(c.start_date,'YYYY-MM-DD') AS date,
            to_char((c.created_at AT TIME ZONE $3)::date,'YYYY-MM-DD') AS submitted_on, c.status, c.details,
            (SELECT s.duplicate_of->>'reason' FROM receipt_scans s WHERE s.organization_id=c.organization_id AND s.attached_case_id=c.id AND s.duplicate_of IS NOT NULL LIMIT 1) AS scan_duplicate
       FROM hr_cases c
      WHERE c.organization_id=$1 AND c.module='expenses' AND c.amount IS NOT NULL AND c.start_date IS NOT NULL AND (c.start_date >= $2::date OR c.created_at >= $2::date)
      ORDER BY c.start_date LIMIT 20000`, [org.id, from, org.timezone])).rows;
  const claims: Claim[] = rows.map((row) => {
    const details = row.details || {};
    const flags: { code: string; message: string }[] = details.ocrFlag?.reasons || [];
    return {
      id: row.id, caseNumber: row.case_number, requesterId: row.requester_id, category: row.category, amount: num(row.amount), date: row.date, submittedOn: row.submitted_on,
      status: row.status, merchant: details.merchant || details.ocr?.merchant || null, ocrDate: details.ocr?.date || null, ocrTotal: numOrNull(details.ocr?.total),
      duplicateReason: row.scan_duplicate || flags.find((flag) => flag.code === "DUPLICATE")?.message || null,
    };
  });
  const roster = (await client.query(
    `SELECT employee_id, to_char(work_date,'YYYY-MM-DD') AS date, kind FROM roster_assignments WHERE organization_id=$1 AND work_date >= $2::date`, [org.id, from])).rows;
  return {
    claims, limits: caseModuleMap.get("expenses")?.limits || {},
    leaveDays: await approvedLeaveDays(client, org, from, addDays(org.today, 30)),
    weeklyOffs: new Set(roster.filter((row) => row.kind === "WEEKLY_OFF").map((row) => `${row.employee_id}:${row.date}`)),
    rostered: new Set(roster.map((row) => row.employee_id as string)),
  };
}

// --------------------------------------------------------------------------------------------------------- people

export async function loadPeople(client: PoolClient, org: OrgContext, settings: RiskSettings): Promise<{ people: PeopleInput; liability: LiabilityInput | null }> {
  const joiners = (await client.query(
    `SELECT id, to_char(joining_date,'YYYY-MM-DD') AS joining FROM employees WHERE organization_id=$1 AND status='ACTIVE' AND joining_date > $2::date - $3::int AND joining_date <= $2::date`,
    [org.id, org.today, settings.people.newJoinerDays])).rows.map((row) => ({ id: row.id as string, joiningDate: row.joining as string }));
  const ids = joiners.map((row) => row.id);
  const rejected = new Map<string, { label: string; date: string }[]>();
  const overdue = new Map<string, { count: number; oldestDue: string; joinerId: string }>();
  const attendanceDays = new Map<string, { recent: number; prior: number }>();
  if (ids.length) {
    const declined = (await client.query(
      `SELECT l.employee_id, 'Leave: ' || t.name AS label, to_char(coalesce(l.decided_at,l.updated_at),'YYYY-MM-DD') AS date
         FROM leave_requests l JOIN leave_types t ON t.id=l.leave_type_id AND t.organization_id=l.organization_id
        WHERE l.organization_id=$1 AND l.employee_id = ANY($2) AND l.status='REJECTED' AND coalesce(l.decided_at,l.updated_at) >= now() - interval '60 days'
       UNION ALL
       SELECT requester_id, initcap(module) || ' ' || case_number, to_char(updated_at,'YYYY-MM-DD')
         FROM hr_cases WHERE organization_id=$1 AND requester_id = ANY($2) AND status IN ('REJECTED','DECLINED') AND updated_at >= now() - interval '60 days'`, [org.id, ids])).rows;
    for (const row of declined) (rejected.get(row.employee_id) || rejected.set(row.employee_id, []).get(row.employee_id)!).push({ label: row.label, date: row.date });
    for (const row of (await client.query(
      `SELECT j.employee_id, j.id AS joiner_id, count(*) AS count, to_char(min(t.due_date),'YYYY-MM-DD') AS oldest
         FROM onboarding_tasks t JOIN onboarding_joiners j ON j.id=t.joiner_id AND j.organization_id=t.organization_id
        WHERE t.organization_id=$1 AND j.employee_id = ANY($2) AND t.status NOT IN ('DONE','SKIPPED','COMPLETED') AND t.due_date < $3::date
        GROUP BY j.employee_id, j.id`, [org.id, ids, org.today])).rows)
      overdue.set(row.employee_id, { count: Number(row.count), oldestDue: row.oldest, joinerId: row.joiner_id });
    for (const row of (await client.query(
      `SELECT employee_id,
              count(DISTINCT (occurred_at AT TIME ZONE $4)::date) FILTER (WHERE (occurred_at AT TIME ZONE $4)::date > $3::date - 14) AS recent,
              count(DISTINCT (occurred_at AT TIME ZONE $4)::date) FILTER (WHERE (occurred_at AT TIME ZONE $4)::date <= $3::date - 14) AS prior
         FROM attendance_events WHERE organization_id=$1 AND employee_id = ANY($2) AND occurred_at >= $3::date - 28 GROUP BY employee_id`, [org.id, ids, org.today, org.timezone])).rows)
      attendanceDays.set(row.employee_id, { recent: Number(row.recent), prior: Number(row.prior) });
  }
  const people: PeopleInput = { joiners, rejected, overdueOnboarding: overdue, attendanceDays, today: org.today };

  const el = (await client.query(
    `SELECT id, annual_quota FROM leave_types WHERE organization_id=$1 AND active AND (code IN ('EL','PL') OR name ILIKE '%earned%' OR name ILIKE '%privilege%') ORDER BY code LIMIT 1`, [org.id])).rows[0];
  if (!el) return { people, liability: null };
  const year = Number(org.today.slice(0, 4));
  const used = (await client.query(
    `SELECT employee_id, sum(days) AS days FROM leave_requests WHERE organization_id=$1 AND leave_type_id=$2 AND status='APPROVED' AND extract(year FROM start_date)=$3 GROUP BY employee_id`,
    [org.id, el.id, year])).rows;
  const basics = await basicByEmployee(client, org);
  const holders = (await client.query(`SELECT id, to_char(joining_date,'YYYY-MM-DD') AS joining FROM employees WHERE organization_id=$1 AND status='ACTIVE'`, [org.id])).rows
    .map((row) => ({ id: row.id as string, joiningDate: row.joining as string, basicMonthly: basics.get(row.id)?.basic ?? null }));
  return { people, liability: { holders, quota: num(el.annual_quota), used: new Map(used.map((row) => [row.employee_id, num(row.days)])), year, today: org.today } };
}

// --------------------------------------------------------------------------------------------------------- service

export async function loadService(client: PoolClient, org: OrgContext, settings: RiskSettings): Promise<{ tickets: Ticket[]; approvals: PendingApproval[] }> {
  const tickets = (await client.query(
    `SELECT id, case_number, category, due_at, closed_at, created_at FROM hr_cases
      WHERE organization_id=$1 AND module='helpdesk' AND due_at IS NOT NULL AND created_at >= now() - make_interval(days => $2) AND status NOT IN ('WITHDRAWN','CANCELLED')`,
    [org.id, settings.service.slaWindowDays])).rows
    .map((row) => ({ id: row.id, caseNumber: row.case_number, category: row.category, dueAt: iso(row.due_at), closedAt: row.closed_at ? iso(row.closed_at) : null, createdAt: iso(row.created_at) }));
  const pending = approverPendingStatuses(caseModules);
  const pairs = Object.entries(pending).flatMap(([module, statuses]) => statuses.map((status) => `${module}:${status}`));
  const cases = (await client.query(
    `SELECT id, case_number, module, approver_id, updated_at FROM hr_cases
      WHERE organization_id=$1 AND approver_id IS NOT NULL AND (module || ':' || status) = ANY($2) AND updated_at < now() - make_interval(days => $3)`,
    [org.id, pairs, settings.service.approvalStuckDays])).rows;
  const leaves = (await client.query(
    `SELECT l.id, l.approver_id, l.submitted_at, t.name, to_char(l.start_date,'DD Mon') AS start FROM leave_requests l
       JOIN leave_types t ON t.id=l.leave_type_id AND t.organization_id=l.organization_id
      WHERE l.organization_id=$1 AND l.status='PENDING' AND l.submitted_at < now() - make_interval(days => $2)`, [org.id, settings.service.approvalStuckDays])).rows;
  return {
    tickets,
    approvals: [
      ...cases.map((row) => ({ kind: "case" as const, id: row.id, label: `${row.case_number} · ${caseModuleMap.get(row.module)?.label || row.module}`, approverId: row.approver_id, since: iso(row.updated_at) })),
      ...leaves.map((row) => ({ kind: "leave" as const, id: row.id, label: `${row.name} from ${row.start}`, approverId: row.approver_id, since: iso(row.submitted_at) })),
    ],
  };
}

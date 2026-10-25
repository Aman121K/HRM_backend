// SQL aggregations behind every report. Each function runs a bounded, set-based query (no per-row round trips);
// the comment above each names the index it relies on.
import { Ctx, ORG_TZ, type Range, num, numOrNull, round } from "./analytics.context";

// ---- workforce -----------------------------------------------------------------------------------
export type MonthMovement = { month: string; opening: number; headcount: number; joiners: number; leavers: number };

/** Month-end headcount, joiners and leavers. Scans `pop` once per month (pop is already org/team-bounded). */
export async function workforceMonthly(ctx: Ctx, range: Range = ctx.range): Promise<MonthMovement[]> {
  const rows = await ctx.pop(`
    SELECT to_char(mo.month,'YYYY-MM') AS month,
           count(p.id) FILTER (WHERE p.joining_date < mo.month AND (p.exit_date IS NULL OR p.exit_date >= mo.month))::int AS opening,
           count(p.id) FILTER (WHERE p.joining_date <= mo.month_end AND (p.exit_date IS NULL OR p.exit_date > mo.month_end))::int AS headcount,
           count(p.id) FILTER (WHERE p.joining_date BETWEEN mo.month AND mo.month_end)::int AS joiners,
           count(p.id) FILTER (WHERE p.exit_date BETWEEN mo.month AND mo.month_end)::int AS leavers
      FROM months mo LEFT JOIN pop p ON true
     GROUP BY mo.month ORDER BY mo.month`, range);
  return rows as MonthMovement[];
}

export type DimensionRow = { label: string; headcount: number; opening: number; joiners: number; leavers: number; avgTenureMonths: number | null };
const DIMENSIONS = { department: "p.department", location: "p.location", designation: "p.designation" } as const;

/** Headcount at range end plus movement within the range, grouped by a whitelisted dimension. */
export async function workforceBy(ctx: Ctx, dimension: keyof typeof DIMENSIONS, range: Range = ctx.range): Promise<DimensionRow[]> {
  const column = DIMENSIONS[dimension];
  const rows = await ctx.pop(`
    SELECT ${column} AS label,
           count(*) FILTER (WHERE p.joining_date <= $3 AND (p.exit_date IS NULL OR p.exit_date > $3))::int AS headcount,
           count(*) FILTER (WHERE p.joining_date < $2 AND (p.exit_date IS NULL OR p.exit_date >= $2))::int AS opening,
           count(*) FILTER (WHERE p.joining_date BETWEEN $2 AND $3)::int AS joiners,
           count(*) FILTER (WHERE p.exit_date BETWEEN $2 AND $3)::int AS leavers,
           avg(($3::date - p.joining_date) / 30.4375) FILTER (WHERE p.joining_date <= $3 AND (p.exit_date IS NULL OR p.exit_date > $3)) AS tenure
      FROM pop p GROUP BY 1 ORDER BY 2 DESC, 1`, range);
  return rows
    .map((row) => ({ label: row.label, headcount: row.headcount, opening: row.opening, joiners: row.joiners, leavers: row.leavers, avgTenureMonths: round(numOrNull(row.tenure)) }))
    .filter((row) => row.headcount || row.opening || row.joiners || row.leavers);
}

/** Leavers in the range with reason and tenure at exit (aggregated, never listed by name). */
export async function exitReasons(ctx: Ctx, range: Range = ctx.range) {
  return ctx.pop(`
    SELECT p.exit_reason AS reason, count(*)::int AS leavers,
           avg((p.exit_date - p.joining_date) / 30.4375) AS tenure,
           count(*) FILTER (WHERE p.exit_date - p.joining_date < 183)::int AS early
      FROM pop p WHERE p.exit_date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 2 DESC`, range);
}

export const TENURE_BANDS = ["Under 6 months", "6–12 months", "1–2 years", "2–5 years", "5+ years"];
/** Tenure distribution of people employed at the end of the range. */
export async function tenureBands(ctx: Ctx) {
  const rows = await ctx.pop(`
    , active AS (SELECT p.*, ($3::date - p.joining_date) AS days FROM pop p
                 WHERE p.joining_date <= $3 AND (p.exit_date IS NULL OR p.exit_date > $3))
    SELECT CASE WHEN days < 183 THEN 0 WHEN days < 365 THEN 1 WHEN days < 730 THEN 2 WHEN days < 1826 THEN 3 ELSE 4 END AS band,
           department, count(*)::int AS people, avg(days / 30.4375) AS tenure
      FROM active GROUP BY 1,2 ORDER BY 1,2`);
  return rows.map((row) => ({ band: TENURE_BANDS[row.band], bandIndex: row.band as number, department: row.department as string, people: row.people as number, tenure: num(row.tenure) }));
}

/**
 * Span of control for managers inside the population, with total (indirect) org size and management layers.
 * employees_manager_directory (organization_id, manager_id, status, …) serves both the direct-report join and each
 * step of the recursive closure.
 */
export async function spanOfControl(ctx: Ctx) {
  return ctx.pop(`
    , chain AS (
        SELECT r.manager_id AS ancestor, r.id AS descendant, 1 AS depth FROM employees r
         WHERE r.organization_id=$1 AND r.status='ACTIVE' AND r.manager_id IS NOT NULL
        UNION ALL
        SELECT c.ancestor, r.id, c.depth + 1 FROM chain c JOIN employees r ON r.manager_id=c.descendant AND r.organization_id=$1 AND r.status='ACTIVE'
         WHERE c.depth < 15)
    , totals AS (SELECT ancestor, count(DISTINCT descendant)::int AS total, max(depth)::int AS layers FROM chain GROUP BY ancestor)
    SELECT m.id, m.full_name AS name, m.department, m.designation,
           count(r.id)::int AS direct, coalesce(t.total,0) AS total, coalesce(t.layers,0) AS layers
      FROM pop m JOIN employees r ON r.organization_id=$1 AND r.manager_id=m.id AND r.status='ACTIVE'
      LEFT JOIN totals t ON t.ancestor=m.id
     WHERE m.status='ACTIVE'
     GROUP BY m.id, m.full_name, m.department, m.designation, t.total, t.layers
     ORDER BY direct DESC, name`);
}

/** Composition of the active population by gender, if (and only if) the employee record captures it. */
export async function genderSplit(ctx: Ctx) {
  if (!(await ctx.hasColumn("employees", "gender"))) return null;
  return ctx.pop(`
    SELECT coalesce(nullif(e.gender::text,''),'Not disclosed') AS label, count(*)::int AS people
      FROM pop p JOIN employees e ON e.id=p.id
     WHERE p.joining_date <= $3 AND (p.exit_date IS NULL OR p.exit_date > $3) GROUP BY 1 ORDER BY 2 DESC`);
}

// ---- leave ---------------------------------------------------------------------------------------
/**
 * Leave requests overlapping the range, prorated to the days inside it. "Unplanned" = sick leave, or applied on/after
 * the first day of absence. leave_overlap_check (organization_id, employee_id, start_date, end_date) WHERE status IN
 * (PENDING, APPROVED) is probed per population member.
 */
const LEAVE_CTE = `
  , lr AS (
      SELECT l.id, l.employee_id, l.leave_type_id, l.status, l.start_date, l.end_date, l.days, p.department,
             (least(l.end_date,$3::date) - greatest(l.start_date,$2::date) + 1)::numeric / (l.end_date - l.start_date + 1) * l.days AS days_in_range,
             (lt.code IN ('SL','SICK') OR lt.name ILIKE '%sick%' OR (l.submitted_at AT TIME ZONE '${ORG_TZ}')::date >= l.start_date) AS unplanned,
             (l.start_date - (l.submitted_at AT TIME ZONE '${ORG_TZ}')::date) AS notice_days
        FROM leave_requests l JOIN pop p ON p.id=l.employee_id
        JOIN leave_types lt ON lt.id=l.leave_type_id AND lt.organization_id=$1
       WHERE l.organization_id=$1 AND l.status IN ('APPROVED','PENDING') AND l.start_date <= $3 AND l.end_date >= $2)`;

export async function leaveByType(ctx: Ctx, range: Range = ctx.range) {
  return ctx.pop(`${LEAVE_CTE}
    SELECT lt.name, lt.code, lt.annual_quota::float AS quota,
           count(lr.id) FILTER (WHERE lr.status='APPROVED')::int AS requests,
           coalesce(sum(lr.days_in_range) FILTER (WHERE lr.status='APPROVED'),0)::float AS days,
           coalesce(sum(lr.days_in_range) FILTER (WHERE lr.status='APPROVED' AND lr.unplanned),0)::float AS unplanned_days,
           coalesce(sum(lr.days_in_range) FILTER (WHERE lr.status='PENDING'),0)::float AS pending_days,
           count(DISTINCT lr.employee_id) FILTER (WHERE lr.status='APPROVED')::int AS employees,
           avg(lr.notice_days) FILTER (WHERE lr.status='APPROVED' AND NOT lr.unplanned)::float AS notice
      FROM leave_types lt LEFT JOIN lr ON lr.leave_type_id=lt.id
     WHERE lt.organization_id=$1 AND (lt.active OR lr.id IS NOT NULL)
     GROUP BY lt.id, lt.name, lt.code, lt.annual_quota ORDER BY days DESC, lt.name`, range);
}

/** Approved leave expanded to calendar days (bounded by the range) → month × ISO weekday, with unplanned share. */
export async function leaveByDay(ctx: Ctx, range: Range = ctx.range) {
  const rows = await ctx.pop(`${LEAVE_CTE}
    SELECT to_char(d,'YYYY-MM') AS month, extract(isodow FROM d)::int AS dow,
           sum(lr.days / (lr.end_date - lr.start_date + 1))::float AS days,
           coalesce(sum(lr.days / (lr.end_date - lr.start_date + 1)) FILTER (WHERE lr.unplanned),0)::float AS unplanned
      FROM lr CROSS JOIN LATERAL generate_series(greatest(lr.start_date,$2::date), least(lr.end_date,$3::date), interval '1 day') d
     WHERE lr.status='APPROVED' GROUP BY 1,2 ORDER BY 1,2`, range);
  return rows as { month: string; dow: number; days: number; unplanned: number }[];
}

// ---- attendance ----------------------------------------------------------------------------------
/**
 * Expected working days (Mon–Sat while employed and since the organisation's first recorded punch, minus approved
 * leave), days with a punch-in, and late first punches,
 * per month × department. attendance_daily_reporting (organization_id, occurred_at, event_type, employee_id) serves
 * the punch scan; roster_assignments' UNIQUE(organization_id, employee_id, work_date) serves the shift lookup.
 */
export async function attendanceMonthly(ctx: Ctx, range: Range = ctx.range) {
  const roster = await ctx.hasTables("roster_assignments", "roster_shift_templates");
  const threshold = roster
    ? `coalesce(st.start_time, time '09:30') + interval '10 minutes'`
    : `time '09:40'`;
  const rosterJoin = roster
    ? `LEFT JOIN roster_assignments ra ON ra.organization_id=$1 AND ra.employee_id=f.employee_id AND ra.work_date=f.day AND ra.kind='SHIFT'
       LEFT JOIN roster_shift_templates st ON st.id=ra.template_id AND st.organization_id=$1`
    : "";
  const rows = await ctx.pop(`
    , cal AS (SELECT d::date AS day, (count(*) FILTER (WHERE extract(isodow FROM d) < 7) OVER (ORDER BY d))::int AS cum
                FROM generate_series($2::date - 1, $3::date, interval '1 day') d)
    , tracking AS (SELECT min((a.occurred_at AT TIME ZONE '${ORG_TZ}')::date) AS since FROM attendance_events a WHERE a.organization_id=$1)
    , exp AS (
        SELECT mo.month, p.department, sum(ce.cum - cs.cum)::numeric AS expected
          FROM months mo CROSS JOIN tracking tr
          JOIN pop p ON p.joining_date <= mo.month_end AND (p.exit_date IS NULL OR p.exit_date >= mo.month)
           AND greatest(mo.month, p.joining_date, tr.since) <= least(mo.month_end, coalesce(p.exit_date, mo.month_end))
          JOIN cal cs ON cs.day = greatest(mo.month, p.joining_date, tr.since) - 1
          JOIN cal ce ON ce.day = least(mo.month_end, coalesce(p.exit_date, mo.month_end))
         GROUP BY 1,2)
    , lv AS (
        SELECT date_trunc('month', d)::date AS month, p.department, sum(l.days / (l.end_date - l.start_date + 1)) AS leave_days
          FROM leave_requests l JOIN pop p ON p.id=l.employee_id
          CROSS JOIN LATERAL generate_series(greatest(l.start_date,$2::date), least(l.end_date,$3::date), interval '1 day') d
         WHERE l.organization_id=$1 AND l.status='APPROVED' AND l.start_date <= $3 AND l.end_date >= $2 AND extract(isodow FROM d) < 7
         GROUP BY 1,2)
    , f AS (
        SELECT a.employee_id, (a.occurred_at AT TIME ZONE '${ORG_TZ}')::date AS day, min((a.occurred_at AT TIME ZONE '${ORG_TZ}')::time) AS first_in
          FROM attendance_events a
         WHERE a.organization_id=$1 AND a.event_type='IN' AND a.occurred_at >= $7 AND a.occurred_at < $8
           AND a.employee_id IN (SELECT id FROM pop)
         GROUP BY 1,2)
    , pa AS (
        SELECT date_trunc('month', f.day)::date AS month, p.department, count(*)::int AS punched,
               count(*) FILTER (WHERE f.first_in > ${threshold})::int AS late
          FROM f JOIN pop p ON p.id=f.employee_id ${rosterJoin}
         GROUP BY 1,2)
    SELECT to_char(x.month,'YYYY-MM') AS month, x.department, x.expected::float AS expected,
           coalesce(lv.leave_days,0)::float AS leave_days, coalesce(pa.punched,0) AS punched, coalesce(pa.late,0) AS late
      FROM exp x
      LEFT JOIN lv ON lv.month=x.month AND lv.department=x.department
      LEFT JOIN pa ON pa.month=x.month AND pa.department=x.department
     ORDER BY 1,2`, range);
  return { roster, rows: rows as { month: string; department: string; expected: number; leave_days: number; punched: number; late: number }[] };
}

/** Regularization requests by attendance month and status. regularization_employee_history (organization_id, employee_id, attendance_date DESC). */
export async function regularizations(ctx: Ctx, range: Range = ctx.range) {
  return ctx.pop(`
    SELECT to_char(r.attendance_date,'YYYY-MM') AS month, r.status, count(*)::int AS requests,
           avg(extract(epoch FROM r.decided_at - r.submitted_at) / 3600) FILTER (WHERE r.decided_at IS NOT NULL)::float AS decision_hours
      FROM attendance_regularizations r JOIN pop p ON p.id=r.employee_id
     WHERE r.organization_id=$1 AND r.attendance_date BETWEEN $2 AND $3
     GROUP BY 1,2 ORDER BY 1,2`, range) as Promise<{ month: string; status: string; requests: number; decision_hours: number | null }[]>;
}

// ---- service desk (case engine) ------------------------------------------------------------------
/**
 * Volume, time to close, SLA and live backlog per case module, for requests raised by the population.
 * hr_cases_requester_history (organization_id, module, requester_id, created_at DESC) is probed per population member.
 */
export async function serviceDesk(ctx: Ctx, range: Range = ctx.range) {
  return ctx.pop(`
    , cs AS (
        SELECT c.* FROM hr_cases c JOIN pop p ON p.id=c.requester_id
         WHERE c.organization_id=$1 AND c.module NOT IN ('recognition')
           AND (c.closed_at IS NULL OR c.closed_at >= $7) AND c.created_at < $8)
    SELECT module,
           count(*) FILTER (WHERE created_at >= $7)::int AS created,
           count(*) FILTER (WHERE closed_at >= $7 AND closed_at < $8)::int AS closed,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at - created_at) / 3600)
             FILTER (WHERE closed_at >= $7 AND closed_at < $8) AS median_hours,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at - created_at) / 3600)
             FILTER (WHERE closed_at >= $7 AND closed_at < $8) AS p90_hours,
           count(*) FILTER (WHERE closed_at >= $7 AND closed_at < $8 AND due_at IS NOT NULL)::int AS sla_eligible,
           count(*) FILTER (WHERE closed_at >= $7 AND closed_at < $8 AND due_at IS NOT NULL AND closed_at <= due_at)::int AS sla_met,
           count(*) FILTER (WHERE closed_at IS NULL)::int AS open_now,
           count(*) FILTER (WHERE closed_at IS NULL AND due_at < now())::int AS overdue,
           count(*) FILTER (WHERE closed_at IS NULL AND created_at > now() - interval '2 days')::int AS age_0_2,
           count(*) FILTER (WHERE closed_at IS NULL AND created_at <= now() - interval '2 days' AND created_at > now() - interval '7 days')::int AS age_2_7,
           count(*) FILTER (WHERE closed_at IS NULL AND created_at <= now() - interval '7 days' AND created_at > now() - interval '30 days')::int AS age_7_30,
           count(*) FILTER (WHERE closed_at IS NULL AND created_at <= now() - interval '30 days')::int AS age_30,
           max(extract(epoch FROM now() - created_at) / 86400) FILTER (WHERE closed_at IS NULL) AS oldest_days
      FROM cs GROUP BY module ORDER BY created DESC, module`, range);
}

/** Requests raised per month per module (same index as above). */
export async function serviceDeskMonthly(ctx: Ctx, range: Range = ctx.range) {
  return ctx.pop(`
    SELECT to_char(c.created_at AT TIME ZONE '${ORG_TZ}','YYYY-MM') AS month, c.module, count(*)::int AS created
      FROM hr_cases c JOIN pop p ON p.id=c.requester_id
     WHERE c.organization_id=$1 AND c.module NOT IN ('recognition') AND c.created_at >= $7 AND c.created_at < $8
     GROUP BY 1,2`, range) as Promise<{ month: string; module: string; created: number }[]>;
}

/** Helpdesk tickets by category. */
export async function helpdeskCategories(ctx: Ctx, range: Range = ctx.range) {
  return ctx.pop(`
    SELECT coalesce(c.category,'Other') AS category, count(*)::int AS tickets,
           count(*) FILTER (WHERE c.closed_at IS NULL)::int AS open_now,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM c.closed_at - c.created_at) / 3600) FILTER (WHERE c.closed_at IS NOT NULL) AS median_hours,
           count(*) FILTER (WHERE c.closed_at IS NOT NULL AND c.due_at IS NOT NULL)::int AS sla_eligible,
           count(*) FILTER (WHERE c.closed_at IS NOT NULL AND c.due_at IS NOT NULL AND c.closed_at <= c.due_at)::int AS sla_met
      FROM hr_cases c JOIN pop p ON p.id=c.requester_id
     WHERE c.organization_id=$1 AND c.module='helpdesk' AND c.created_at >= $7 AND c.created_at < $8
     GROUP BY 1 ORDER BY 2 DESC`, range);
}

// ---- expenses ------------------------------------------------------------------------------------
/** Claimed spend by expense month × category (excludes rejected/withdrawn). hr_cases_requester_history per member. */
export async function expenses(ctx: Ctx, range: Range = ctx.range) {
  return ctx.pop(`
    SELECT to_char(coalesce(c.start_date, (c.created_at AT TIME ZONE '${ORG_TZ}')::date),'YYYY-MM') AS month,
           coalesce(c.category,'Other') AS category, p.department,
           count(*)::int AS claims, coalesce(sum(c.amount),0)::float AS amount,
           coalesce(sum(c.amount) FILTER (WHERE c.status='PAID'),0)::float AS paid,
           coalesce(sum(c.amount) FILTER (WHERE c.status IN ('SUBMITTED','SENT_BACK','APPROVED')),0)::float AS outstanding,
           count(*) FILTER (WHERE c.details ? 'policyFlag')::int AS flagged,
           sum(extract(epoch FROM c.closed_at - c.created_at) / 86400) FILTER (WHERE c.status='PAID')::float AS pay_days_total,
           count(*) FILTER (WHERE c.status='PAID')::int AS paid_claims
      FROM hr_cases c JOIN pop p ON p.id=c.requester_id
     WHERE c.organization_id=$1 AND c.module='expenses' AND c.status NOT IN ('REJECTED','WITHDRAWN')
       AND coalesce(c.start_date, (c.created_at AT TIME ZONE '${ORG_TZ}')::date) BETWEEN $2 AND $3
     GROUP BY 1,2,3`, range) as Promise<{ month: string; category: string; department: string; claims: number; amount: number; paid: number; outstanding: number; flagged: number; pay_days_total: number | null; paid_claims: number }[]>;
}

// ---- recruitment ---------------------------------------------------------------------------------
export const FUNNEL = ["APPLIED", "SCREENING", "INTERVIEW", "OFFERED", "HIRED"];
const stageSql = (column: string) => `CASE ${column} WHEN 'APPLIED' THEN 1 WHEN 'SCREENING' THEN 2 WHEN 'INTERVIEW' THEN 3 WHEN 'OFFERED' THEN 4 WHEN 'HIRED' THEN 5 ELSE 0 END`;
/**
 * Candidates added in the range with the furthest funnel stage reached (from the case timeline).
 * hr_cases_module_board (organization_id, module, status, created_at DESC); hr_case_events_timeline (organization_id, case_id, id).
 * Candidates are not employees, so department/location filters and team scope do not apply.
 */
export async function candidates(ctx: Ctx, range: Range = ctx.range) {
  return ctx.rows(`
    SELECT c.id, c.status, coalesce(c.category,'Not recorded') AS source,
           to_char(c.created_at AT TIME ZONE '${ORG_TZ}','YYYY-MM') AS month,
           extract(epoch FROM c.closed_at - c.created_at) / 86400 AS days_open,
           greatest(${stageSql("c.status")}, coalesce(max(${stageSql("ev.to_status")}),0), 1) AS stage
      FROM hr_cases c
      LEFT JOIN hr_case_events ev ON ev.organization_id=c.organization_id AND ev.case_id=c.id AND ev.kind='TRANSITION'
     WHERE c.organization_id=$1 AND c.module='candidates' AND c.created_at >= $2 AND c.created_at < $3
     GROUP BY c.id`, [ctx.org, range.fromTs, range.toTs]) as Promise<{ id: string; status: string; source: string; month: string; days_open: number | null; stage: number }[]>;
}

/** Requisitions currently open, with the number of openings. hr_cases_module_board. */
export async function openRequisitions(ctx: Ctx) {
  const rows = await ctx.rows(`
    SELECT coalesce(c.category,'Unassigned') AS department, count(*)::int AS requisitions,
           coalesce(sum(CASE WHEN c.details->>'openings' ~ '^[0-9]+$' THEN (c.details->>'openings')::int ELSE 1 END),0)::int AS openings,
           avg(extract(epoch FROM now() - c.created_at) / 86400)::float AS age_days
      FROM hr_cases c WHERE c.organization_id=$1 AND c.module='requisitions' AND c.status IN ('OPEN','PENDING_APPROVAL','ON_HOLD')
       AND ($2::text IS NULL OR c.category=$2)
     GROUP BY 1 ORDER BY 3 DESC`, [ctx.org, ctx.filters.department || null]);
  return rows as { department: string; requisitions: number; openings: number; age_days: number }[];
}

// ---- payroll cost --------------------------------------------------------------------------------
export type PayRow = { period: string; department: string; employees: number; gross: number; deductions: number; net: number; employer: number | null };

/**
 * Pay cost by period × department. Uses the payroll engine's run tables when they exist (with employer contributions),
 * otherwise published payslips. payslip_period_admin (organization_id, period, status, employee_id).
 */
export async function payrollCost(ctx: Ctx, range: Range = ctx.range): Promise<{ source: "payroll_engine" | "payslips"; rows: PayRow[] }> {
  const engine = await payrollEngineSql(ctx);
  if (engine) {
    const rows = await ctx.pop(engine, range, [range.fromMonth, range.toMonth]);
    return { source: "payroll_engine", rows: rows.map(mapPay) };
  }
  const rows = await ctx.pop(`
    SELECT s.period, p.department, count(DISTINCT s.employee_id)::int AS employees,
           sum(s.gross)::float AS gross, sum(s.deductions)::float AS deductions, sum(s.net)::float AS net, NULL::float AS employer
      FROM payslips s JOIN pop p ON p.id=s.employee_id
     WHERE s.organization_id=$1 AND s.status='PUBLISHED' AND s.period BETWEEN $9 AND $10
     GROUP BY 1,2 ORDER BY 1,2`, range, [range.fromMonth, range.toMonth]);
  return { source: "payslips", rows: rows.map(mapPay) };
}
const mapPay = (row: Record<string, any>): PayRow => ({
  period: row.period, department: row.department, employees: num(row.employees), gross: num(row.gross), deductions: num(row.deductions), net: num(row.net), employer: numOrNull(row.employer),
});

/**
 * Payroll engine (migration 006): approved/published/locked runs, included lines only (with employer cost).
 * payroll_runs_list (organization_id, period DESC, …) bounds the runs; payroll_run_lines_employee
 * (organization_id, employee_id, run_id) joins lines per population member.
 */
async function payrollEngineSql(ctx: Ctx): Promise<string | null> {
  if (!(await ctx.hasTables("payroll_runs", "payroll_run_lines"))) return null;
  if (!(await ctx.hasColumn("payroll_run_lines", "employer_cost"))) return null;
  const has = (await ctx.rows(`SELECT 1 FROM payroll_runs WHERE organization_id=$1 AND status IN ('APPROVED','PUBLISHED','LOCKED') LIMIT 1`, [ctx.org])).length;
  if (!has) return null; // no finalised runs yet: fall back to payslips
  return `
    SELECT r.period, p.department, count(DISTINCT l.employee_id)::int AS employees,
           sum(l.gross)::float AS gross, sum(l.deductions)::float AS deductions, sum(l.net)::float AS net, sum(l.employer_cost)::float AS employer
      FROM payroll_runs r
      JOIN payroll_run_lines l ON l.organization_id=$1 AND l.run_id=r.id AND l.status='INCLUDED'
      JOIN pop p ON p.id=l.employee_id
     WHERE r.organization_id=$1 AND r.status IN ('APPROVED','PUBLISHED','LOCKED') AND r.period BETWEEN $9 AND $10
     GROUP BY 1,2 ORDER BY 1,2`;
}

// ---- roster --------------------------------------------------------------------------------------
/**
 * Shift adherence from the roster (migration 008): rostered shifts up to today and whether a punch-in happened that day.
 * roster_assignments UNIQUE(organization_id, employee_id, work_date) is probed per population member;
 * attendance_employee_timeline (organization_id, employee_id, occurred_at DESC) serves the punch lookup.
 */
export async function rosterAdherence(ctx: Ctx, range: Range = ctx.range) {
  if (!(await ctx.hasTables("roster_assignments", "roster_shift_templates"))) return null;
  return ctx.pop(`
    , ra AS (
        SELECT r.employee_id, r.work_date, r.kind, p.department, t.name AS shift
          FROM roster_assignments r JOIN pop p ON p.id=r.employee_id
          LEFT JOIN roster_shift_templates t ON t.id=r.template_id AND t.organization_id=$1
         WHERE r.organization_id=$1 AND r.work_date BETWEEN $2 AND least($3::date, current_date))
    SELECT to_char(ra.work_date,'YYYY-MM') AS month, coalesce(ra.shift,'Weekly off') AS shift, ra.kind,
           count(*)::int AS assignments,
           count(*) FILTER (WHERE ra.kind='SHIFT' AND EXISTS (
             SELECT 1 FROM attendance_events a WHERE a.organization_id=$1 AND a.employee_id=ra.employee_id AND a.event_type='IN'
                AND a.occurred_at >= (ra.work_date::timestamp AT TIME ZONE '${ORG_TZ}') AND a.occurred_at < ((ra.work_date + 1)::timestamp AT TIME ZONE '${ORG_TZ}')))::int AS attended
      FROM ra GROUP BY 1,2,3`, range) as Promise<{ month: string; shift: string; kind: string; assignments: number; attended: number }[]>;
}

// ---- onboarding ----------------------------------------------------------------------------------
/**
 * New-joiner onboarding (migration 010) for joiners whose joining date falls in the range, plus everyone still in
 * pre-boarding (the live pipeline). Joiners are not employees
 * yet, so scope uses their manager (team) and their own department/location fields.
 * onboarding_joiners_pipeline (organization_id, status, joining_date, id); onboarding_tasks_joiner (organization_id, joiner_id, …).
 */
export async function onboarding(ctx: Ctx, range: Range = ctx.range) {
  if (!(await ctx.hasTables("onboarding_joiners", "onboarding_tasks"))) return null;
  const joinerScope = `j.organization_id=$1 AND (j.joining_date BETWEEN $2 AND $3 OR j.status IN ('PRE_BOARDING','READY_TO_JOIN'))
       AND ($4::text IS NULL OR j.department=$4) AND ($5::text IS NULL OR coalesce(nullif(j.location,''),'Unassigned')=$5)
       AND ($6::uuid IS NULL OR j.manager_id=$6::uuid OR j.manager_id IN (SELECT id FROM team))`;
  const joiners = await ctx.pop(`
    SELECT to_char(j.joining_date,'YYYY-MM') AS month, j.status, j.department, j.employment_type,
           count(*)::int AS joiners,
           avg(extract(epoch FROM j.completed_at - j.joining_date::timestamp) / 86400) FILTER (WHERE j.completed_at IS NOT NULL)::float AS days_to_complete
      FROM onboarding_joiners j WHERE ${joinerScope}
     GROUP BY 1,2,3,4`, range);
  const tasks = await ctx.pop(`
    SELECT t.owner_type, t.phase, count(*)::int AS tasks,
           count(*) FILTER (WHERE t.status='DONE')::int AS done,
           count(*) FILTER (WHERE t.status='SKIPPED')::int AS skipped,
           count(*) FILTER (WHERE t.status='PENDING' AND t.due_date < current_date)::int AS overdue,
           count(*) FILTER (WHERE t.status='DONE' AND t.completed_at <= (t.due_date + 1)::timestamp AT TIME ZONE '${ORG_TZ}')::int AS on_time
      FROM onboarding_joiners j JOIN onboarding_tasks t ON t.organization_id=$1 AND t.joiner_id=j.id
     WHERE ${joinerScope} AND j.status <> 'WITHDRAWN'
     GROUP BY 1,2`, range);
  return {
    joiners: joiners as { month: string; status: string; department: string; employment_type: string; joiners: number; days_to_complete: number | null }[],
    tasks: tasks as { owner_type: string; phase: string; tasks: number; done: number; skipped: number; overdue: number; on_time: number }[],
  };
}

// ---- learning ------------------------------------------------------------------------------------
/** LMS enrolments active in the range by course category. lms_enrollments_learner (organization_id, employee_id, status, due_date). */
export async function lmsLearning(ctx: Ctx, range: Range = ctx.range) {
  if (!(await ctx.hasTables("lms_enrollments", "lms_courses"))) return null;
  const categories = await ctx.pop(`
    SELECT c.category, count(*)::int AS enrolled,
           count(*) FILTER (WHERE en.status='COMPLETED')::int AS completed,
           count(*) FILTER (WHERE en.status='IN_PROGRESS')::int AS in_progress,
           count(*) FILTER (WHERE c.mandatory OR en.source='MANDATORY')::int AS mandatory,
           count(*) FILTER (WHERE (c.mandatory OR en.source='MANDATORY') AND en.status='COMPLETED')::int AS mandatory_completed,
           count(*) FILTER (WHERE en.status<>'COMPLETED' AND en.due_date < current_date)::int AS overdue,
           avg(extract(epoch FROM en.completed_at - coalesce(en.started_at, en.created_at)) / 86400) FILTER (WHERE en.status='COMPLETED')::float AS days_to_complete
      FROM lms_enrollments en JOIN pop p ON p.id=en.employee_id
      JOIN lms_courses c ON c.id=en.course_id AND c.organization_id=$1
     WHERE en.organization_id=$1 AND en.created_at < $8 AND (en.completed_at IS NULL OR en.completed_at >= $7)
     GROUP BY 1 ORDER BY 2 DESC`, range);
  const monthly = await ctx.pop(`
    SELECT to_char(en.completed_at AT TIME ZONE '${ORG_TZ}','YYYY-MM') AS month, count(*)::int AS completions
      FROM lms_enrollments en JOIN pop p ON p.id=en.employee_id
     WHERE en.organization_id=$1 AND en.status='COMPLETED' AND en.completed_at >= $7 AND en.completed_at < $8
     GROUP BY 1`, range);
  return { categories, monthly: monthly as { month: string; completions: number }[] };
}

/** Training requests raised through the case engine (always available). hr_cases_requester_history. */
export async function trainingRequests(ctx: Ctx, range: Range = ctx.range) {
  return ctx.pop(`
    SELECT coalesce(c.category,'Other') AS category, count(*)::int AS requests,
           count(*) FILTER (WHERE c.status IN ('APPROVED','ENROLLED','COMPLETED'))::int AS approved,
           count(*) FILTER (WHERE c.status='COMPLETED')::int AS completed,
           coalesce(sum(c.amount) FILTER (WHERE c.status IN ('APPROVED','ENROLLED','COMPLETED')),0)::float AS spend
      FROM hr_cases c JOIN pop p ON p.id=c.requester_id
     WHERE c.organization_id=$1 AND c.module='learning' AND c.created_at >= $7 AND c.created_at < $8
     GROUP BY 1 ORDER BY 2 DESC`, range);
}

// ---- engagement ----------------------------------------------------------------------------------
/**
 * eNPS answers submitted in the range. Anonymous responses carry only department/location, so team scope uses
 * identified responses from the reporting line. survey_answers_by_question (organization_id, question_id);
 * survey_responses_by_survey (organization_id, survey_id).
 */
export async function enps(ctx: Ctx, range: Range = ctx.range) {
  if (!(await ctx.hasTables("surveys", "survey_questions", "survey_responses", "survey_answers"))) return null;
  const rows = await ctx.pop(`
    SELECT s.id AS survey_id, s.title, s.status, s.min_group_size, to_char(r.submitted_on,'YYYY-MM') AS month,
           coalesce(r.department,'Not recorded') AS department,
           count(*)::int AS responses,
           count(*) FILTER (WHERE a.numeric_value >= 9)::int AS promoters,
           count(*) FILTER (WHERE a.numeric_value <= 6)::int AS detractors
      FROM survey_questions q
      JOIN surveys s ON s.id=q.survey_id AND s.organization_id=$1 AND s.status IN ('LIVE','CLOSED')
      JOIN survey_answers a ON a.organization_id=$1 AND a.question_id=q.id AND a.numeric_value IS NOT NULL
      JOIN survey_responses r ON r.id=a.response_id AND r.organization_id=$1
     WHERE q.organization_id=$1 AND q.type='ENPS' AND r.submitted_on BETWEEN $2 AND $3
       AND ($4::text IS NULL OR r.department=$4) AND ($5::text IS NULL OR r.location=$5)
       AND ($6::uuid IS NULL OR r.employee_id IN (SELECT id FROM pop))
     GROUP BY 1,2,3,4,5,6`, range);
  return rows as { survey_id: string; title: string; status: string; min_group_size: number; month: string; department: string; responses: number; promoters: number; detractors: number }[];
}

// ---- performance ---------------------------------------------------------------------------------
/** KPI goals whose period starts inside the range; attainment = actual / target, capped at 150%. kpi_employee_period. */
export async function goals(ctx: Ctx, range: Range = ctx.range) {
  return ctx.pop(`
    , k AS (
        SELECT g.*, p.department,
               CASE WHEN g.period ~ '^[0-9]{4}-Q[1-4]$' THEN make_date(left(g.period,4)::int, (right(g.period,1)::int - 1) * 3 + 1, 1)
                    WHEN g.period ~ '^[0-9]{4}-[0-9]{2}$' THEN to_date(g.period || '-01','YYYY-MM-DD')
                    WHEN g.period ~ '^[0-9]{4}$' THEN make_date(g.period::int,1,1)
                    WHEN g.period ~ '^FY[0-9]{2,4}' THEN NULL END AS period_start
          FROM kpis g JOIN pop p ON p.id=g.employee_id WHERE g.organization_id=$1)
    SELECT department, period, status, count(*)::int AS goals, count(DISTINCT employee_id)::int AS people,
           sum(weight * least(CASE WHEN target > 0 THEN actual / target ELSE NULL END, 1.5))::float AS weighted,
           sum(weight) FILTER (WHERE target > 0)::float AS weight
      FROM k WHERE period_start BETWEEN date_trunc('quarter',$2::date) AND $3
     GROUP BY 1,2,3`, range) as Promise<{ department: string; period: string; status: string; goals: number; people: number; weighted: number | null; weight: number | null }[]>;
}

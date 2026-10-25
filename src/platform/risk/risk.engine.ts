// Runs every detector for one organization inside the caller's tenant transaction and upserts signals idempotently by
// (detector, subject) with fingerprint-aware lifecycle rules. Used by POST /risk/scan and the hourly risk.scan job.
import type { PoolClient } from "pg";
import { crossSourceConflict, impossibleTravel, outsideGeofence, rejectedSelfies, selfieBacklog, sharedDevice, spoofedGps } from "./attendance-integrity";
import { complianceCalendar, complianceSignals, gratuitySignals, noPayrollSignal } from "./compliance";
import { expenseSignals } from "./expense-fraud";
import { labourSignals, LABOUR_SKIPPED } from "./labour";
import { EXPENSE_SKIPPED } from "./expense-fraud";
import { payrollSignals } from "./payroll-anomalies";
import { checkInSignals, leaveLiabilitySignal, slaBreaches, stuckApprovals } from "./people-service";
import {
  loadAttendance, loadCompliance, loadExpenses, loadGratuity, loadLabour, loadMinimumWages, loadOrg, loadPayroll, loadPeople, loadService, type OrgContext,
} from "./risk.loaders";
import { mondayOf, SEVERITIES, type Area, type DetectorMeta, type SignalDraft, type SkippedCheck } from "./risk.types";
import { EXAMPLE_MINIMUM_WAGES, mergeSettings, type RiskSettings } from "./risk.settings";
import { fingerprint, onCleared, onDetected, type ExistingSignal } from "./signal-lifecycle";

type AutoResolve = "absent" | "explicit" | "never";
type Meta = DetectorMeta & { mode: AutoResolve };
const d = (key: string, area: Area, label: string, mode: AutoResolve, description: string): Meta => ({ key, area, label, description, mode, autoResolve: mode !== "never" });

export const DETECTORS: Meta[] = [
  d("compliance.calendar", "compliance", "Statutory due dates", "explicit", "PF, ESI, TDS, 24Q, Form 16, state PT and LWF due dates tied to payroll runs and exports."),
  d("compliance.gratuity", "compliance", "Gratuity eligibility", "absent", "People reaching 5 years of service, and exits where gratuity is likely payable."),
  d("attendance.shared_device", "attendance", "Shared phone", "never", "The same phone punching for two or more people on one day."),
  d("attendance.impossible_travel", "attendance", "Impossible travel", "never", "Consecutive punches too far apart for the time between them."),
  d("attendance.outside_geofence", "attendance", "Outside geofence", "absent", "Repeated punches outside every store geofence."),
  d("attendance.spoofed_gps", "attendance", "Spoofed GPS", "never", "Identical coordinates across days/people — typical of mock-location apps."),
  d("attendance.selfie_backlog", "attendance", "Selfie review backlog", "absent", "Selfie punches waiting too long for review."),
  d("attendance.rejected_selfies", "attendance", "Rejected selfies", "absent", "People whose selfie punches are rejected repeatedly."),
  d("attendance.cross_source", "attendance", "Biometric vs phone", "never", "Biometric and phone punches from different places within minutes."),
  d("labour.weekly_hours", "labour", "Weekly hours", "explicit", "Rostered hours above the weekly limit."),
  d("labour.daily_hours", "labour", "Daily hours & spread-over", "explicit", "Shifts above the daily working-hour or spread-over limit."),
  d("labour.rest", "labour", "Rest between shifts", "explicit", "Less than the minimum rest between two shifts."),
  d("labour.consecutive_days", "labour", "Weekly off", "never", "More consecutive working days than allowed (no weekly off in 7 days)."),
  d("labour.overtime_unapproved", "labour", "Unapproved overtime", "never", "Punches show work beyond the roster without an approval."),
  d("payroll.net_change", "payroll", "Net pay swing", "explicit", "Net pay change above the threshold without a salary revision."),
  d("payroll.minimum_wage", "payroll", "Minimum wage", "absent", "Fixed gross below the configured state minimum wage."),
  d("payroll.missing_structure", "payroll", "No salary structure", "absent", "People working without a salary structure."),
  d("payroll.paid_after_exit", "payroll", "Paid after exit", "explicit", "Salary included for someone who has left."),
  d("payroll.duplicate_bank", "payroll", "Shared bank account", "absent", "Two or more employees paid into one account."),
  d("payroll.statutory_flip", "payroll", "PF/ESI flips", "explicit", "PF applicability or ESI coverage changed month-on-month."),
  d("expenses.duplicate_receipt", "expenses", "Duplicate receipt", "never", "A receipt already used on another claim."),
  d("expenses.round_amounts", "expenses", "Round amounts", "never", "Repeated round-number claims."),
  d("expenses.split_claims", "expenses", "Split claims", "never", "Several claims just under a policy limit that together exceed it."),
  d("expenses.off_day", "expenses", "Claims on days off", "never", "Claims dated on a rostered weekly off (or weekend)."),
  d("expenses.on_leave", "expenses", "Claims during leave", "never", "Claims dated during approved leave."),
  d("expenses.late_claim", "expenses", "Late claims", "never", "Claims submitted long after the receipt date."),
  d("expenses.same_merchant", "expenses", "Same bill, many people", "never", "Same merchant, amount and day claimed by several people."),
  d("people.check_in", "people", "New-joiner check-in", "absent", "New joiners with two or more observable friction signals."),
  d("people.leave_liability", "people", "Leave encashment exposure", "absent", "Unused earned leave valued at basic pay."),
  d("service.sla_breaches", "service", "Repeated SLA breaches", "absent", "Helpdesk categories that breach SLA repeatedly."),
  d("service.stuck_approvals", "service", "Stuck approvals", "absent", "Requests waiting on one approver for days."),
];
export const DETECTOR_MAP = new Map(DETECTORS.map((meta) => [meta.key, meta]));
export const SKIPPED_CHECKS: SkippedCheck[] = [...LABOUR_SKIPPED, ...EXPENSE_SKIPPED];

type AreaResult = { ran: string[]; drafts: SignalDraft[]; cleared: Map<string, Set<string>>; error?: string };

export async function loadSettings(client: PoolClient, organizationId: string): Promise<{ settings: RiskSettings; version: number }> {
  const row = (await client.query(`SELECT thresholds, version FROM risk_settings WHERE organization_id=$1`, [organizationId])).rows[0];
  const { minimumWagesSeeded: _seeded, ...thresholds } = (row?.thresholds || {}) as Record<string, unknown>;
  return { settings: mergeSettings(thresholds), version: row?.version || 0 };
}

/** Seeds the EXAMPLE minimum-wage rows the first time an organization's table is read. */
export async function ensureMinimumWages(client: PoolClient, organizationId: string) {
  const existing = await loadMinimumWages(client, organizationId);
  if (existing.length) return existing;
  const marker = (await client.query(`SELECT thresholds ? 'minimumWagesSeeded' AS seeded FROM risk_settings WHERE organization_id=$1`, [organizationId])).rows[0];
  if (marker?.seeded) return existing; // an admin deliberately emptied the table
  for (const row of EXAMPLE_MINIMUM_WAGES)
    await client.query(
      `INSERT INTO risk_minimum_wages(organization_id,state_code,category,monthly_amount,effective_from,is_example,note) VALUES($1,$2,$3,$4,$5,true,$6) ON CONFLICT DO NOTHING`,
      [organizationId, row.stateCode, row.category, row.monthlyAmount, row.effectiveFrom, row.note]);
  await client.query(
    `INSERT INTO risk_settings(organization_id,thresholds) VALUES($1,'{"minimumWagesSeeded":true}') ON CONFLICT (organization_id) DO UPDATE SET thresholds = risk_settings.thresholds || '{"minimumWagesSeeded":true}'`, [organizationId]);
  return loadMinimumWages(client, organizationId);
}

async function runArea(area: Area, keys: string[], work: () => Promise<{ drafts: SignalDraft[]; cleared?: [string, string[]][] }>): Promise<AreaResult> {
  try {
    const result = await work();
    return { ran: keys, drafts: result.drafts, cleared: new Map((result.cleared || []).map(([key, list]) => [key, new Set(list)])) };
  } catch (error) {
    return { ran: [], drafts: [], cleared: new Map(), error: `${area}: ${(error as Error).message}` };
  }
}
const keysOf = (area: Area) => DETECTORS.filter((meta) => meta.area === area).map((meta) => meta.key);
/** Subjects a detector evaluated this scan but did not flag (for "explicit" auto-resolution). */
const evaluatedMinusFlagged = (detector: string, evaluated: Iterable<string>, drafts: SignalDraft[]) => {
  const flagged = new Set(drafts.filter((draft) => draft.detector === detector).map((draft) => draft.subjectKey));
  return [detector, [...evaluated].filter((key) => !flagged.has(key))] as [string, string[]];
};

/** Runs all detectors (pure) over freshly loaded data. Area failures are isolated and reported. */
export async function detectAll(client: PoolClient, org: OrgContext, settings: RiskSettings) {
  const results: AreaResult[] = [];
  // Savepoints keep one failing area (e.g. a table not migrated yet) from aborting the whole transaction.
  const guarded = async (area: Area, work: () => Promise<{ drafts: SignalDraft[]; cleared?: [string, string[]][] }>) => {
    await client.query(`SAVEPOINT risk_area`);
    const result = await runArea(area, keysOf(area), work);
    await client.query(result.error ? `ROLLBACK TO SAVEPOINT risk_area` : `RELEASE SAVEPOINT risk_area`);
    results.push(result);
  };
  let calendar: ReturnType<typeof complianceCalendar> | null = null;

  await guarded("compliance", async () => {
    const { facts, states } = await loadCompliance(client, org);
    calendar = complianceCalendar(addDaysIso(org.today, -settings.compliance.lookbackDays), addDaysIso(org.today, settings.compliance.horizonDays), states, facts, org.today);
    const { drafts, cleared } = complianceSignals(calendar.items, facts);
    const summary = noPayrollSignal(facts, calendar.items);
    const gratuity = gratuitySignals(await loadGratuity(client, org), org.today, settings.compliance.gratuityWindowDays);
    return { drafts: [...drafts, ...(summary ? [summary] : []), ...gratuity], cleared: [["compliance.calendar", [...cleared, ...(summary ? [] : ["no-payroll-data"])]]] };
  });
  await guarded("attendance", async () => {
    const data = await loadAttendance(client, org, settings);
    const s = settings.attendance;
    return { drafts: [
      ...sharedDevice(data.punches, org.timezone), ...impossibleTravel(data.punches, s, org.timezone), ...outsideGeofence(data.punches, s, org.today, org.timezone),
      ...spoofedGps(data.punches, data.sites, s, org.timezone), ...selfieBacklog(data.pending, s, org.now), ...rejectedSelfies(data.rejected, s),
      ...crossSourceConflict(data.punches, data.sites, s, org.timezone),
    ] };
  });
  await guarded("labour", async () => {
    const input = await loadLabour(client, org, settings);
    const drafts = labourSignals(input, settings);
    const weeks = new Set(input.roster.filter((day) => day.kind === "SHIFT").map((day) => `${day.employeeId}:${mondayOf(day.date)}`));
    return { drafts, cleared: ["labour.weekly_hours", "labour.daily_hours", "labour.rest"].map((key) => evaluatedMinusFlagged(key, weeks, drafts)) };
  });
  await guarded("payroll", async () => {
    const input = await loadPayroll(client, org, await ensureMinimumWages(client, org.id));
    const drafts = payrollSignals(input, settings);
    const lines = input.latest.map((line) => `${line.period}:${line.employeeId}`);
    const flips = input.latest.flatMap((line) => ["PF", "ESI"].map((kind) => `${line.period}:${line.employeeId}:${kind}`));
    return { drafts, cleared: [evaluatedMinusFlagged("payroll.net_change", lines, drafts), evaluatedMinusFlagged("payroll.paid_after_exit", lines, drafts), evaluatedMinusFlagged("payroll.statutory_flip", flips, drafts)] };
  });
  await guarded("expenses", async () => ({ drafts: expenseSignals(await loadExpenses(client, org, settings), settings) }));
  await guarded("people", async () => {
    const { people, liability } = await loadPeople(client, org, settings);
    return { drafts: [...checkInSignals(people, settings), ...(liability ? leaveLiabilitySignal(liability, settings) : [])] };
  });
  await guarded("service", async () => {
    const data = await loadService(client, org, settings);
    return { drafts: [...slaBreaches(data.tickets, settings, org.now), ...stuckApprovals(data.approvals, settings, org.now)] };
  });
  return { results, calendar: calendar as ReturnType<typeof complianceCalendar> | null };
}
const addDaysIso = (isoDate: string, days: number) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export type ScanSummary = { detectors: number; signals: number; created: number; reopened: number; refreshed: number; autoResolved: number; cleared: number; errors: string[]; newUrgent: string[] };

/**
 * Detect + upsert for one organization. Serialized per organization with an advisory lock so the hourly job and a
 * manual scan never race. `actorUserId` is recorded on audit rows (the automation user for the job).
 */
export async function runScan(client: PoolClient, organizationId: string, actorUserId: string, now = new Date()): Promise<ScanSummary> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('risk.scan:' || $1))`, [organizationId]);
  const org = await loadOrg(client, organizationId, now);
  const { settings } = await loadSettings(client, organizationId);
  const disabled = new Set(settings.disabled);
  const { results } = await detectAll(client, org, settings);
  const ran = new Set(results.flatMap((result) => result.ran).filter((key) => !disabled.has(key)));
  const drafts = results.flatMap((result) => result.drafts).filter((draft) => ran.has(draft.detector) && DETECTOR_MAP.has(draft.detector));
  const cleared = new Map<string, Set<string>>();
  for (const result of results) for (const [key, set] of result.cleared) cleared.set(key, set);
  const summary: ScanSummary = { detectors: ran.size, signals: drafts.length, created: 0, reopened: 0, refreshed: 0, autoResolved: 0, cleared: 0, errors: results.flatMap((result) => (result.error ? [result.error] : [])), newUrgent: [] };

  const existingRows = (await client.query(
    `SELECT id, detector, subject_key, status, fingerprint, status_fingerprint, severity, cleared_at FROM risk_signals WHERE organization_id=$1 AND detector = ANY($2) FOR UPDATE`,
    [organizationId, [...ran]])).rows;
  const existing = new Map(existingRows.map((row) => [`${row.detector}|${row.subject_key}`, row]));
  const seen = new Set<string>();
  const event = (signalId: string, action: string, from: string | null, to: string | null, note: string | null, data: unknown = {}, actor: string | null = null) =>
    client.query(`INSERT INTO risk_signal_events(organization_id,signal_id,actor_user_id,action,from_status,to_status,note,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [organizationId, signalId, actor, action, from, to, note, JSON.stringify(data)]);

  for (const draft of drafts) {
    const key = `${draft.detector}|${draft.subjectKey}`;
    if (seen.has(key)) continue; // a detector must not emit the same subject twice; keep the first
    seen.add(key);
    const fp = fingerprint(draft.basis);
    const row = existing.get(key);
    const outcome = onDetected(row ? { status: row.status, fingerprint: row.fingerprint, statusFingerprint: row.status_fingerprint } as ExistingSignal : null, fp);
    const content = [draft.severity, draft.title.slice(0, 300), draft.explanation, JSON.stringify(draft.evidence), draft.employeeIds, JSON.stringify(draft.records || []), JSON.stringify(draft.action), draft.audiences, draft.dueDate || null, fp];
    if (outcome.kind === "insert") {
      const inserted = (await client.query(
        `INSERT INTO risk_signals(organization_id,detector,area,subject_key,severity,title,explanation,evidence,employee_ids,records,action,audiences,due_date,fingerprint)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [organizationId, draft.detector, draft.area, draft.subjectKey.slice(0, 300), ...content])).rows[0];
      await event(inserted.id, "DETECTED", null, "OPEN", null, { severity: draft.severity });
      summary.created += 1;
      if (draft.severity === "critical" || draft.severity === "high") summary.newUrgent.push(inserted.id);
      continue;
    }
    await client.query(
      `UPDATE risk_signals SET severity=$3, title=$4, explanation=$5, evidence=$6, employee_ids=$7, records=$8, action=$9, audiences=$10, due_date=$11, fingerprint=$12,
              last_detected_at=now(), cleared_at=NULL, detections=detections+1, updated_at=now()
        WHERE organization_id=$1 AND id=$2`, [organizationId, row.id, ...content]);
    if (outcome.kind === "reopen") {
      await client.query(`UPDATE risk_signals SET status='OPEN', status_note=$3, status_by=NULL, status_at=now(), status_fingerprint=NULL, version=version+1 WHERE organization_id=$1 AND id=$2`,
        [organizationId, row.id, outcome.reason]);
      await event(row.id, "REOPENED", row.status, "OPEN", outcome.reason, { fingerprint: fp });
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,'RISK_SIGNAL_REOPENED','risk_signal',$3,$4,$5)`,
        [organizationId, actorUserId, row.id, JSON.stringify({ status: row.status }), JSON.stringify({ status: "OPEN", reason: outcome.reason, automated: true })]);
      summary.reopened += 1;
    } else {
      summary.refreshed += 1;
      if (outcome.kind === "refresh" && SEVERITIES.indexOf(draft.severity) > SEVERITIES.indexOf(row.severity))
        await event(row.id, "ESCALATED", row.status, row.status, `Severity rose from ${row.severity} to ${draft.severity}.`, { from: row.severity, to: draft.severity });
    }
  }

  for (const row of existingRows) {
    if (seen.has(`${row.detector}|${row.subject_key}`)) continue;
    const meta = DETECTOR_MAP.get(row.detector)!;
    const confirmedClear = meta.mode === "absent" || (meta.mode === "explicit" && cleared.get(row.detector)?.has(row.subject_key));
    const action = onCleared(row.status, !!confirmedClear);
    if (action === "resolve") {
      await client.query(
        `UPDATE risk_signals SET status='RESOLVED', status_note='The condition is no longer detected (resolved automatically).', status_by=NULL, status_at=now(), status_fingerprint=NULL,
                cleared_at=now(), version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`, [organizationId, row.id]);
      await event(row.id, "AUTO_RESOLVED", row.status, "RESOLVED", "The condition is no longer detected.");
      summary.autoResolved += 1;
    } else if (action === "mark-cleared" && !row.cleared_at) {
      await client.query(`UPDATE risk_signals SET cleared_at=now(), updated_at=now() WHERE organization_id=$1 AND id=$2`, [organizationId, row.id]);
      await event(row.id, "CLEARED", row.status, row.status, "No longer detected in the latest scan; review and resolve if handled.");
      summary.cleared += 1;
    }
  }
  const { newUrgent: _ids, ...stored } = summary;
  await client.query(
    `INSERT INTO risk_settings(organization_id,last_scan_at,last_scan_result) VALUES($1,now(),$2)
     ON CONFLICT (organization_id) DO UPDATE SET last_scan_at=now(), last_scan_result=$2`, [organizationId, JSON.stringify(stored)]);
  return summary;
}

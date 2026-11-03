import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { COMPLIANCE_DISCLAIMER, complianceCalendar } from "./compliance";
import { ComplianceMarkDto, OBLIGATION_KEY, SignalActionDto, SignalsQuery, UpdateRiskSettingsDto } from "./risk.dto";
import { DETECTORS, DETECTOR_MAP, SKIPPED_CHECKS, ensureMinimumWages, loadSettings, runScan } from "./risk.engine";
import { loadCompliance, loadOrg } from "./risk.loaders";
import { AREAS, addDays, type EvidenceColumn } from "./risk.types";
import { DEFAULT_SETTINGS, MIN_WAGE_CATEGORIES, SettingsError, validateMinimumWages, validateSettings } from "./risk.settings";
import { checkTransition, TRANSITIONS, type LifecycleAction } from "./signal-lifecycle";

const HR_ROLES = ["HR_ADMIN", "OWNER"];
type Viewer = { isHr: boolean; isPayroll: boolean; isManager: boolean; reports: string[] };
type Person = { id: string | null; name: string; number?: string; designation?: string | null; location?: string | null; redacted?: boolean };

@Injectable()
export class RiskService {
  constructor(private readonly database: DatabaseService) {}

  // ----------------------------------------------------------------------------------------------------- access

  private async viewer(client: PoolClient, identity: AuthIdentity): Promise<Viewer> {
    const isHr = identity.roles.some((role) => HR_ROLES.includes(role));
    const isPayroll = identity.roles.includes("PAYROLL_ADMIN");
    const isManager = identity.roles.includes("MANAGER");
    const reports = isManager && identity.employeeId
      ? (await client.query(`SELECT id FROM employees WHERE organization_id=$1 AND manager_id=$2`, [identity.organizationId, identity.employeeId])).rows.map((row) => row.id as string)
      : [];
    if (!isHr && !isPayroll && !isManager) throw new ForbiddenException("The Risk & Compliance Center is available to HR, payroll admins and managers.");
    return { isHr, isPayroll, isManager, reports };
  }

  /** SQL visibility predicate (alias s) and its parameters, appended after `baseParams`. */
  private scope(viewer: Viewer, baseParams: unknown[]) {
    if (viewer.isHr) return { sql: "TRUE", params: [] as unknown[] };
    const parts: string[] = [], params: unknown[] = [];
    if (viewer.isPayroll) parts.push(`'PAYROLL' = ANY(s.audiences)`);
    if (viewer.isManager) { params.push(viewer.reports); parts.push(`('MANAGER' = ANY(s.audiences) AND s.employee_ids && $${baseParams.length + params.length}::uuid[])`); }
    return { sql: parts.length ? `(${parts.join(" OR ")})` : "FALSE", params };
  }

  private canSee(viewer: Viewer, row: { audiences: string[]; employee_ids: string[] }) {
    if (viewer.isHr) return true;
    if (viewer.isPayroll && row.audiences.includes("PAYROLL")) return true;
    return viewer.isManager && row.audiences.includes("MANAGER") && row.employee_ids.some((id) => viewer.reports.includes(id));
  }
  /** Dismissing/re-opening hides or revives a signal for everyone: HR, or payroll admins for payroll/statutory items. */
  private canClose(viewer: Viewer, row: { audiences: string[] }) {
    return viewer.isHr || (viewer.isPayroll && row.audiences.includes("PAYROLL"));
  }
  /** Managers see colleagues outside their team as redacted (unless they also see the signal as payroll/HR). */
  private redacts(viewer: Viewer, row: { audiences: string[] }) {
    return !viewer.isHr && !(viewer.isPayroll && row.audiences.includes("PAYROLL"));
  }

  private async people(client: PoolClient, organizationId: string, ids: string[]) {
    if (!ids.length) return new Map<string, Person>();
    const rows = (await client.query(
      `SELECT id, full_name, employee_number, designation, location, department FROM employees WHERE organization_id=$1 AND id = ANY($2::uuid[])`, [organizationId, [...new Set(ids)]])).rows;
    return new Map<string, Person>(rows.map((row) => [row.id, { id: row.id, name: row.full_name, number: row.employee_number, designation: row.designation, location: row.location || row.department }]));
  }

  private present(row: any, directory: Map<string, Person>, viewer: Viewer, detail = false) {
    const redact = this.redacts(viewer, row);
    const person = (id: string): Person => {
      if (redact && !viewer.reports.includes(id)) return { id: null, name: "Someone outside your team", redacted: true };
      return directory.get(id) || { id, name: "Former employee" };
    };
    const evidence = row.evidence || {};
    const personColumns = ((evidence.columns || []) as EvidenceColumn[]).filter((column) => column.kind === "person").map((column) => column.key);
    const rows = personColumns.length
      ? (evidence.rows || []).map((cell: Record<string, unknown>) => ({ ...cell, ...Object.fromEntries(personColumns.map((key) => [key, typeof cell[key] === "string" ? person(cell[key] as string) : null])) }))
      : evidence.rows;
    const meta = DETECTOR_MAP.get(row.detector);
    return {
      id: row.id, detector: row.detector, detectorLabel: meta?.label || row.detector, area: row.area, severity: row.severity, status: row.status,
      title: row.title, explanation: row.explanation, people: (row.employee_ids as string[]).map(person), action: row.action, dueDate: row.due_date,
      firstDetectedAt: row.first_detected_at, lastDetectedAt: row.last_detected_at, clearedAt: row.cleared_at, detections: row.detections,
      statusNote: row.status_note, statusAt: row.status_at, statusBy: row.status_by_name || null, version: row.version,
      canClose: this.canClose(viewer, row), autoResolves: meta?.autoResolve ?? false,
      ...(detail ? { evidence: { ...evidence, rows }, records: row.records } : {}),
    };
  }

  // ----------------------------------------------------------------------------------------------------- reads

  overview(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const viewer = await this.viewer(client, identity);
      let state = (await client.query(`SELECT last_scan_at, last_scan_result FROM risk_settings WHERE organization_id=$1`, [org])).rows[0];
      // First visit by HR: run the detectors now so the page is never empty just because the hourly job hasn't run yet.
      if (viewer.isHr && !state?.last_scan_at) {
        await runScan(client, org, identity.userId);
        state = (await client.query(`SELECT last_scan_at, last_scan_result FROM risk_settings WHERE organization_id=$1`, [org])).rows[0];
      }
      const scope = this.scope(viewer, [org]);
      const counts = (await client.query(
        `SELECT s.area, s.severity, s.status, count(*)::int AS n FROM risk_signals s
          WHERE s.organization_id=$1 AND ${scope.sql} AND (s.status IN ('OPEN','ACKNOWLEDGED') OR s.status_at > now() - interval '30 days')
          GROUP BY 1,2,3`, [org, ...scope.params])).rows;
      const byArea = Object.fromEntries(AREAS.map((area) => [area, { total: 0, critical: 0, high: 0, medium: 0, low: 0 }]));
      const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 } as Record<string, number>;
      const byStatus = { OPEN: 0, ACKNOWLEDGED: 0, RESOLVED: 0, DISMISSED: 0 } as Record<string, number>;
      for (const row of counts) {
        byStatus[row.status] += row.n;
        if (row.status !== "OPEN" && row.status !== "ACKNOWLEDGED") continue;
        byArea[row.area][row.severity as "low"] += row.n; byArea[row.area].total += row.n; bySeverity[row.severity] += row.n;
      }
      const top = (await client.query(
        `SELECT s.* FROM risk_signals s WHERE s.organization_id=$1 AND ${scope.sql} AND s.status IN ('OPEN','ACKNOWLEDGED')
          ORDER BY array_position(ARRAY['critical','high','medium','low'], s.severity), (s.status='OPEN') DESC, s.last_detected_at DESC LIMIT 6`, [org, ...scope.params])).rows;
      const directory = await this.people(client, org, top.flatMap((row) => row.employee_ids));
      let calendar = null;
      if (viewer.isHr || viewer.isPayroll) {
        const ctx = await loadOrg(client, org);
        const { settings } = await loadSettings(client, org);
        const { facts, states } = await loadCompliance(client, ctx);
        const summary = complianceCalendar(addDays(ctx.today, -settings.compliance.lookbackDays), addDays(ctx.today, settings.compliance.horizonDays), states, facts, ctx.today);
        calendar = { today: ctx.today, states, disclaimer: COMPLIANCE_DISCLAIMER, counts: summary.counts, horizonDays: settings.compliance.horizonDays,
          items: summary.items.filter((item) => item.bucket !== "done" || item.daysLeft >= -30) };
      }
      const { settings } = await loadSettings(client, org);
      return {
        viewer: { isHr: viewer.isHr, isPayroll: viewer.isPayroll, isManager: viewer.isManager, reportCount: viewer.reports.length, canScan: viewer.isHr, canConfigure: viewer.isHr },
        lastScan: state ? { at: state.last_scan_at, result: state.last_scan_result } : null,
        counts: { byArea, bySeverity, byStatus, active: byStatus.OPEN + byStatus.ACKNOWLEDGED },
        top: top.map((row) => this.present(row, directory, viewer)),
        calendar,
        detectors: DETECTORS.filter((meta) => viewer.isHr || (viewer.isPayroll && ["compliance", "payroll"].includes(meta.area)) || (viewer.isManager && !["compliance", "payroll", "service"].includes(meta.area)))
          .map(({ key, area, label, description, autoResolve }) => ({ key, area, label, description, autoResolve, enabled: !settings.disabled.includes(key) })),
        skipped: SKIPPED_CHECKS,
      };
    });
  }

  list(identity: AuthIdentity, query: SignalsQuery) {
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const viewer = await this.viewer(client, identity);
      const params: unknown[] = [org];
      const where = [`s.organization_id=$1`];
      const status = query.status || "active";
      if (status === "active") where.push(`s.status IN ('OPEN','ACKNOWLEDGED')`);
      else if (status === "closed") where.push(`s.status IN ('RESOLVED','DISMISSED')`);
      else if (status !== "all") { params.push(status); where.push(`s.status=$${params.length}`); }
      if (query.area) { params.push(query.area); where.push(`s.area=$${params.length}`); }
      if (query.severity) { params.push(query.severity); where.push(`s.severity=$${params.length}`); }
      if (query.detector) { params.push(query.detector); where.push(`s.detector=$${params.length}`); }
      if (query.search) { params.push(`%${query.search.replace(/[%_\\]/g, "\\$&")}%`); where.push(`(s.title ILIKE $${params.length} OR s.explanation ILIKE $${params.length})`); }
      const scope = this.scope(viewer, params);
      params.push(...scope.params);
      where.push(scope.sql);
      const total = (await client.query(`SELECT count(*)::int AS n FROM risk_signals s WHERE ${where.join(" AND ")}`, params)).rows[0].n;
      params.push(query.limit || 50, query.offset || 0);
      const rows = (await client.query(
        `SELECT s.*, u.full_name AS status_by_name FROM risk_signals s LEFT JOIN users u ON u.id=s.status_by
          WHERE ${where.join(" AND ")}
          ORDER BY (s.status IN ('OPEN','ACKNOWLEDGED')) DESC, array_position(ARRAY['critical','high','medium','low'], s.severity), s.last_detected_at DESC, s.id
          LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
      const directory = await this.people(client, org, rows.flatMap((row) => row.employee_ids));
      return { items: rows.map((row) => this.present(row, directory, viewer)), total };
    });
  }

  get(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const viewer = await this.viewer(client, identity);
      const row = await this.load(client, identity, viewer, id);
      const personIds = [...row.employee_ids, ...((row.evidence?.rows || []) as Record<string, unknown>[]).flatMap((cell) =>
        ((row.evidence?.columns || []) as EvidenceColumn[]).filter((column) => column.kind === "person").map((column) => cell[column.key]).filter((value): value is string => typeof value === "string"))];
      const directory = await this.people(client, identity.organizationId, personIds);
      const events = (await client.query(
        `SELECT e.action, e.from_status, e.to_status, e.note, e.created_at, coalesce(u.full_name, 'ClanChief automation') AS actor, e.actor_user_id IS NULL AS automated
           FROM risk_signal_events e LEFT JOIN users u ON u.id=e.actor_user_id WHERE e.organization_id=$1 AND e.signal_id=$2 ORDER BY e.created_at, e.id`, [identity.organizationId, id])).rows;
      return { ...this.present(row, directory, viewer, true), events: events.map((event) => ({ ...event, actor: event.automated ? "ClanChief automation" : event.actor })) };
    });
  }

  private async load(client: PoolClient, identity: AuthIdentity, viewer: Viewer, id: string, lock = false) {
    const row = (await client.query(
      `SELECT s.*, u.full_name AS status_by_name FROM risk_signals s LEFT JOIN users u ON u.id=s.status_by WHERE s.organization_id=$1 AND s.id=$2${lock ? " FOR UPDATE OF s" : ""}`,
      [identity.organizationId, id])).rows[0];
    if (!row || !this.canSee(viewer, row)) throw new NotFoundException("Signal not found.");
    return row;
  }

  // ----------------------------------------------------------------------------------------------------- lifecycle

  act(identity: AuthIdentity, id: string, action: string, input: SignalActionDto) {
    if (!(action in TRANSITIONS)) throw new NotFoundException("Unknown action.");
    const verb = action as LifecycleAction;
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const viewer = await this.viewer(client, identity);
      const row = await this.load(client, identity, viewer, id, true);
      if ((verb === "dismiss" || verb === "reopen") && !this.canClose(viewer, row))
        throw new ForbiddenException(verb === "dismiss" ? "Only HR (or payroll admins for payroll items) can dismiss a signal. Acknowledge it, or resolve it once handled." : "Only HR can re-open this signal.");
      if (row.version !== input.version) throw new ConflictException({ message: "This signal changed since you opened it. Reload to see the latest.", code: "VERSION_CONFLICT", current: row.version });
      const problem = checkTransition(verb, row.status, input.note);
      if (problem) throw new BadRequestException(problem);
      const to = TRANSITIONS[verb].to;
      const note = input.note?.trim() || null;
      const closing = to === "RESOLVED" || to === "DISMISSED";
      const updated = (await client.query(
        `UPDATE risk_signals SET status=$3, status_note=$4, status_by=$5, status_at=now(), status_fingerprint=$6, version=version+1, updated_at=now()
          WHERE organization_id=$1 AND id=$2 RETURNING version`,
        [org, id, to, note, identity.userId, closing ? row.fingerprint : null])).rows[0];
      await client.query(`INSERT INTO risk_signal_events(organization_id,signal_id,actor_user_id,action,from_status,to_status,note) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [org, id, identity.userId, verb === "reopen" ? "REOPENED" : to, row.status, to, note]);
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,'risk_signal',$4,$5,$6)`,
        [org, identity.userId, `RISK_SIGNAL_${verb.toUpperCase()}`, id, JSON.stringify({ status: row.status, version: row.version }),
          JSON.stringify({ status: to, note, detector: row.detector, subject: row.subject_key, fingerprint: row.fingerprint })]);
      return { id, status: to, version: updated.version, statusNote: note };
    });
  }

  scan(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      await this.viewer(client, identity);
      const started = Date.now();
      const summary = await runScan(client, identity.organizationId, identity.userId);
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'RISK_SCAN_RUN','organization',$1,$3)`,
        [identity.organizationId, identity.userId, JSON.stringify({ ...summary, newUrgent: summary.newUrgent.length })]);
      const { newUrgent, ...rest } = summary;
      return { ...rest, newUrgent: newUrgent.length, ms: Date.now() - started };
    });
  }

  // ----------------------------------------------------------------------------------------------------- settings

  getSettings(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const viewer = await this.viewer(client, identity);
      if (!viewer.isHr && !viewer.isPayroll) throw new ForbiddenException("Risk settings are available to HR and payroll admins.");
      const { settings, version } = await loadSettings(client, identity.organizationId);
      const minimumWages = await ensureMinimumWages(client, identity.organizationId);
      const current = (await client.query(`SELECT version FROM risk_settings WHERE organization_id=$1`, [identity.organizationId])).rows[0];
      return {
        thresholds: settings, defaults: DEFAULT_SETTINGS, version: current?.version ?? version, minimumWages, categories: MIN_WAGE_CATEGORIES,
        detectors: DETECTORS.map(({ key, area, label, description }) => ({ key, area, label, description, enabled: !settings.disabled.includes(key) })),
        canEdit: viewer.isHr,
        minimumWageWarning: "Minimum wages here are EXAMPLE values seeded for demonstration — they are not current law. Replace them with the notification that applies to each state, zone and skill category before relying on the check.",
      };
    });
  }

  updateSettings(identity: AuthIdentity, input: UpdateRiskSettingsDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const viewer = await this.viewer(client, identity);
      if (!viewer.isHr) throw new ForbiddenException("Only HR can change risk settings.");
      let thresholds, wages;
      try {
        thresholds = input.thresholds === undefined ? undefined : validateSettings(input.thresholds, true);
        wages = input.minimumWages === undefined ? undefined : validateMinimumWages(input.minimumWages);
      } catch (error) {
        if (error instanceof SettingsError) throw new BadRequestException(error.message);
        throw error;
      }
      if (thresholds?.disabled.some((key) => !DETECTOR_MAP.has(key))) throw new BadRequestException("disabled lists an unknown detector.");
      await client.query(`INSERT INTO risk_settings(organization_id) VALUES($1) ON CONFLICT DO NOTHING`, [org]);
      const current = (await client.query(`SELECT thresholds, version FROM risk_settings WHERE organization_id=$1 FOR UPDATE`, [org])).rows[0];
      if (current.version !== input.version && !(input.version === 0 && current.version === 1))
        throw new ConflictException({ message: "Settings were changed by someone else. Reload and try again.", code: "VERSION_CONFLICT", current: current.version });
      const beforeWages = await ensureMinimumWages(client, org);
      if (thresholds) await client.query(`UPDATE risk_settings SET thresholds=$2 || jsonb_build_object('minimumWagesSeeded', true) WHERE organization_id=$1`, [org, JSON.stringify(thresholds)]);
      if (wages) {
        await client.query(`DELETE FROM risk_minimum_wages WHERE organization_id=$1`, [org]);
        for (const row of wages)
          await client.query(`INSERT INTO risk_minimum_wages(organization_id,state_code,category,monthly_amount,effective_from,is_example,note,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [org, row.stateCode, row.category, row.monthlyAmount, row.effectiveFrom, row.isExample, row.note, identity.userId]);
        await client.query(`UPDATE risk_settings SET thresholds = thresholds || '{"minimumWagesSeeded":true}' WHERE organization_id=$1`, [org]);
      }
      const saved = (await client.query(`UPDATE risk_settings SET version=version+1, updated_by=$2, updated_at=now() WHERE organization_id=$1 RETURNING version`, [org, identity.userId])).rows[0];
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,'RISK_SETTINGS_UPDATED','organization',$1,$3,$4)`,
        [org, identity.userId, JSON.stringify({ thresholds: current.thresholds, minimumWages: wages ? beforeWages : undefined }), JSON.stringify({ thresholds, minimumWages: wages })]);
      return { version: saved.version, saved: true };
    });
  }

  // ----------------------------------------------------------------------------------------------------- compliance

  markObligation(identity: AuthIdentity, key: string, input: ComplianceMarkDto) {
    if (!OBLIGATION_KEY.test(key)) throw new BadRequestException("Unknown obligation.");
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const viewer = await this.viewer(client, identity);
      if (!viewer.isHr && !viewer.isPayroll) throw new ForbiddenException("Only HR and payroll admins can mark filings.");
      const before = (await client.query(`SELECT * FROM risk_compliance_marks WHERE organization_id=$1 AND obligation_key=$2 FOR UPDATE`, [org, key])).rows[0] || null;
      if (input.filed) {
        await client.query(
          `INSERT INTO risk_compliance_marks(organization_id,obligation_key,status,reference,note,marked_by) VALUES($1,$2,'FILED',$3,$4,$5)
           ON CONFLICT (organization_id,obligation_key) DO UPDATE SET reference=$3, note=$4, marked_by=$5, marked_at=now()`,
          [org, key, input.reference?.trim() || null, input.note?.trim() || null, identity.userId]);
        // Close the matching calendar signal now rather than waiting for the next scan.
        const signal = (await client.query(
          `UPDATE risk_signals SET status='RESOLVED', status_note=$3, status_by=$4, status_at=now(), status_fingerprint=NULL, cleared_at=now(), version=version+1, updated_at=now()
            WHERE organization_id=$1 AND detector='compliance.calendar' AND subject_key=$2 AND status IN ('OPEN','ACKNOWLEDGED') RETURNING id`,
          [org, key, `Marked as filed${input.reference ? ` (ref. ${input.reference.trim()})` : ""}.`, identity.userId])).rows[0];
        if (signal) await client.query(`INSERT INTO risk_signal_events(organization_id,signal_id,actor_user_id,action,to_status,note) VALUES($1,$2,$3,'RESOLVED','RESOLVED',$4)`,
          [org, signal.id, identity.userId, "Marked as filed from the compliance calendar."]);
      } else {
        await client.query(`DELETE FROM risk_compliance_marks WHERE organization_id=$1 AND obligation_key=$2`, [org, key]);
      }
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,'organization',$1,$4,$5)`,
        [org, identity.userId, input.filed ? "COMPLIANCE_MARKED_FILED" : "COMPLIANCE_UNMARKED", JSON.stringify(before), JSON.stringify({ key, filed: input.filed, reference: input.reference || null, note: input.note || null })]);
      return { key, filed: input.filed };
    });
  }
}


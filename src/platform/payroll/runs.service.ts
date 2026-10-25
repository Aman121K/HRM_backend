import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { INPUT_CODES, type CreateRunDto, type HoldDto, type RunInputDto, type RunTransitionDto } from "./payroll.dto";
import {
  PAYROLL_ROLES, audit, bankFileBlock, bankFileError, decryptProfileField, loadAcceptedDeclarations, loadSettings, monthLabel, notify, num, requireAdmin, requireReviewer, type Settings,
} from "./payroll.shared";
import { presentProfile } from "./payroll.service";
import { DISCLAIMER, addMonths, rulesetFor, esiContributionPeriod, lopDaysInPeriod, parsePeriod, resolveState, type LeaveSpan } from "./statutory";
import { calculateLine, type RunInput } from "./engine";
import { plainField, toCsv } from "./csv";
import { loadOpeningYtd, openingNet } from "../imports/ytd.shared"; // switch-over import

type RunRow = Record<string, any>;
const EDITABLE = ["DRAFT", "CALCULATED"];
const PAID = ["PUBLISHED", "LOCKED"];
export const RUN_STEPS = ["DRAFT", "CALCULATED", "SUBMITTED", "APPROVED", "PUBLISHED", "LOCKED"];

const RUN_SELECT = `
  SELECT r.*, to_char(r.pay_date,'YYYY-MM-DD') AS pay_date_text,
         cb.full_name AS created_by_name, kb.full_name AS calculated_by_name, sb.full_name AS submitted_by_name,
         ab.full_name AS approved_by_name, pb.full_name AS published_by_name, lb.full_name AS locked_by_name, xb.full_name AS cancelled_by_name
    FROM payroll_runs r
    LEFT JOIN employees cb ON cb.id=r.created_by AND cb.organization_id=r.organization_id
    LEFT JOIN employees kb ON kb.id=r.calculated_by AND kb.organization_id=r.organization_id
    LEFT JOIN employees sb ON sb.id=r.submitted_by AND sb.organization_id=r.organization_id
    LEFT JOIN employees ab ON ab.id=r.approved_by AND ab.organization_id=r.organization_id
    LEFT JOIN employees pb ON pb.id=r.published_by AND pb.organization_id=r.organization_id
    LEFT JOIN employees lb ON lb.id=r.locked_by AND lb.organization_id=r.organization_id
    LEFT JOIN employees xb ON xb.id=r.cancelled_by AND xb.organization_id=r.organization_id`;

@Injectable()
export class RunsService {
  constructor(private readonly database: DatabaseService) {}

  list(identity: AuthIdentity) {
    requireReviewer(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const rows = (await client.query(`${RUN_SELECT} WHERE r.organization_id=$1 ORDER BY r.period DESC, r.created_at DESC LIMIT 60`, [identity.organizationId])).rows;
      const live = new Set(rows.filter((row) => row.status !== "CANCELLED").map((row) => row.period));
      const current = new Date().toISOString().slice(0, 7);
      const suggestions = [addMonths(current, -1), current, addMonths(current, 1)].filter((period) => !live.has(period));
      return { items: rows.map((row) => this.present(identity, row)), suggestions, disclaimer: DISCLAIMER };
    });
  }

  create(identity: AuthIdentity, input: CreateRunDto) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const settings = await loadSettings(client, identity.organizationId);
      const later = (await client.query(`SELECT period FROM payroll_runs WHERE organization_id=$1 AND status IN ('PUBLISHED','LOCKED') AND period > $2 ORDER BY period DESC LIMIT 1`,
        [identity.organizationId, input.period])).rows[0];
      if (later) throw new ConflictException(`${monthLabel(later.period)} is already published — runs must be processed in month order (use arrears for corrections).`);
      const p = parsePeriod(input.period);
      let row;
      try {
        row = (await client.query(
          `INSERT INTO payroll_runs(organization_id,period,pay_date,include_expenses,notes,created_by,ruleset_version)
           VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [identity.organizationId, input.period, input.payDate || p.lastDay, input.includeExpenses ?? settings.includeExpenses, input.notes?.trim() || null, identity.employeeId, rulesetFor(input.period).version])).rows[0];
      } catch (error: any) {
        if (error?.code === "23505") throw new ConflictException(`A payroll run for ${monthLabel(input.period)} already exists. Cancel it first to start over.`);
        throw error;
      }
      await audit(client, identity, "PAYROLL_RUN_CREATED", "payroll_run", row.id, null, { period: input.period });
      return this.present(identity, await this.load(client, identity, row.id));
    });
  }

  get(identity: AuthIdentity, id: string) {
    requireReviewer(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const run = await this.load(client, identity, id);
      const lines = (await client.query(
        `SELECT l.id, l.employee_id, l.status, l.held, l.hold_reason, l.days_in_month, l.payable_days::float, l.lop_days::float,
                l.gross::float, l.reimbursements::float, l.deductions::float, l.net::float, l.employer_cost::float, l.tds::float, l.pf_employee::float,
                l.esi_employee::float, l.pt::float, l.flags, l.previous_net::float, l.variance_pct::float, l.published_at, l.released_at,
                e.employee_number, e.full_name, e.department, e.designation, e.location,
                l.breakdown->'statutory'->'pt'->>'state' AS pt_state
           FROM payroll_run_lines l JOIN employees e ON e.id=l.employee_id AND e.organization_id=l.organization_id
          WHERE l.organization_id=$1 AND l.run_id=$2 ORDER BY e.employee_number`, [identity.organizationId, id])).rows;
      const inputs = (await client.query(
        `SELECT i.id, i.employee_id, i.kind, i.code, i.label, i.amount::float, i.days::float, i.taxable, i.source, i.source_ref, i.note, i.created_at,
                e.full_name AS employee_name, e.employee_number, c.full_name AS created_by_name
           FROM payroll_inputs i JOIN employees e ON e.id=i.employee_id AND e.organization_id=i.organization_id
           LEFT JOIN employees c ON c.id=i.created_by AND c.organization_id=i.organization_id
          WHERE i.organization_id=$1 AND i.run_id=$2 AND i.voided_at IS NULL ORDER BY e.employee_number, i.created_at`, [identity.organizationId, id])).rows;
      const history = (await client.query(
        `SELECT a.id, a.action, a.after_data, a.created_at, e.full_name AS actor_name
           FROM audit_log a LEFT JOIN employees e ON e.organization_id=a.organization_id AND e.user_id=a.actor_user_id
          WHERE a.organization_id=$1 AND a.entity_type='payroll_run' AND a.entity_id=$2 ORDER BY a.created_at DESC, a.id DESC LIMIT 100`, [identity.organizationId, id])).rows;
      return {
        ...this.present(identity, run),
        lines: lines.map((line) => ({
          id: line.id, employeeId: line.employee_id, number: line.employee_number, name: line.full_name, department: line.department,
          designation: line.designation, location: line.location, state: line.pt_state, status: line.status, held: line.held, holdReason: line.hold_reason,
          daysInMonth: line.days_in_month, payableDays: line.payable_days, lopDays: line.lop_days, gross: line.gross, reimbursements: line.reimbursements,
          deductions: line.deductions, net: line.net, employerCost: line.employer_cost, tds: line.tds, pf: line.pf_employee, esi: line.esi_employee, pt: line.pt,
          flags: line.flags, previousNet: line.previous_net, variancePct: line.variance_pct, publishedAt: line.published_at, releasedAt: line.released_at,
        })),
        inputs: inputs.map((input) => ({
          id: input.id, employeeId: input.employee_id, employeeName: input.employee_name, employeeNumber: input.employee_number, kind: input.kind, code: input.code,
          label: input.label, amount: input.amount, days: input.days, taxable: input.taxable, source: input.source, sourceRef: input.source_ref, note: input.note,
          createdBy: input.created_by_name, createdAt: input.created_at,
        })),
        history: history.map((item) => ({ id: item.id, action: item.action, data: item.after_data, at: item.created_at, actor: item.actor_name })),
        inputCodes: INPUT_CODES,
      };
    });
  }

  line(identity: AuthIdentity, runId: string, employeeId: string) {
    requireReviewer(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const run = await this.load(client, identity, runId);
      const line = (await client.query(
        `SELECT l.*, e.employee_number, e.full_name FROM payroll_run_lines l JOIN employees e ON e.id=l.employee_id AND e.organization_id=l.organization_id
          WHERE l.organization_id=$1 AND l.run_id=$2 AND l.employee_id=$3`, [identity.organizationId, runId, employeeId])).rows[0];
      if (!line) throw new NotFoundException("This employee is not part of the run.");
      const inputs = (await client.query(
        `SELECT id, kind, code, label, amount::float, days::float, taxable, source, note FROM payroll_inputs
          WHERE organization_id=$1 AND run_id=$2 AND employee_id=$3 AND voided_at IS NULL ORDER BY created_at`, [identity.organizationId, runId, employeeId])).rows;
      return {
        runId, period: run.period, runStatus: run.status, employeeId, number: line.employee_number, name: line.full_name, status: line.status,
        held: line.held, holdReason: line.hold_reason, flags: line.flags, breakdown: line.breakdown, inputs, publishedAt: line.published_at,
        previousNet: line.previous_net === null ? null : num(line.previous_net), variancePct: line.variance_pct === null ? null : num(line.variance_pct),
      };
    });
  }

  // ------------------------------------------------------------ calculation

  calculate(identity: AuthIdentity, id: string, version: number) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const run = await this.load(client, identity, id, true);
      this.checkVersion(run, version);
      if (!EDITABLE.includes(run.status)) throw new ConflictException(`A ${run.status.toLowerCase()} run cannot be recalculated. Send it back first.`);
      const settings = await loadSettings(client, identity.organizationId);
      const summary = await this.computeRun(client, identity, run, settings);
      await client.query(
        `UPDATE payroll_runs SET status='CALCULATED', needs_recalc=false, totals=$3, ruleset_version=$4, settings_snapshot=$5,
                calculated_at=now(), calculated_by=$6, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, id, JSON.stringify(summary.totals), rulesetFor(run.period).version, JSON.stringify(settings), identity.employeeId]);
      await audit(client, identity, run.status === "DRAFT" ? "PAYROLL_RUN_CALCULATED" : "PAYROLL_RUN_RECALCULATED", "payroll_run", id,
        { status: run.status }, { status: "CALCULATED", employees: summary.totals.headcount, net: summary.totals.net, expensesAdded: summary.expensesAdded });
      return this.present(identity, await this.load(client, identity, id));
    });
  }

  private async computeRun(client: PoolClient, identity: AuthIdentity, run: RunRow, settings: Settings) {
    const org = identity.organizationId;
    const p = parsePeriod(run.period);
    const expensesAdded = run.include_expenses ? await this.syncExpenses(client, identity, run, p.lastDay) : 0;

    // Owners who have never had a salary structure (e.g. a group owner added to a brand to administer it) are not on
    // this brand's payroll, so they are left out instead of showing up as a "missing structure" error every month.
    const employees = (await client.query(
      `SELECT e.id, e.employee_number, e.full_name, e.department, e.designation, e.location, to_char(e.joining_date,'YYYY-MM-DD') AS joining_date
         FROM employees e WHERE e.organization_id=$1 AND e.status='ACTIVE' AND e.joining_date <= $2
          AND NOT (EXISTS (SELECT 1 FROM organization_memberships m WHERE m.organization_id=e.organization_id AND m.user_id=e.user_id AND m.role='OWNER')
                   AND NOT EXISTS (SELECT 1 FROM salary_structures s WHERE s.organization_id=e.organization_id AND s.employee_id=e.id))
        ORDER BY e.employee_number`, [org, p.lastDay])).rows;
    const ids = employees.map((row) => row.id);
    const byEmployee = <T>(rows: T[], key: (row: T) => string) => { const map = new Map<string, T[]>(); for (const row of rows) { const k = key(row); map.set(k, [...(map.get(k) || []), row]); } return map; };

    const structures = new Map((await client.query(
      `SELECT DISTINCT ON (employee_id) id, employee_id, components, fixed_monthly_gross::float, is_metro, annual_ctc::float, to_char(effective_from,'YYYY-MM-DD') AS effective_from
         FROM salary_structures WHERE organization_id=$1 AND employee_id = ANY($2) AND effective_from <= $3 ORDER BY employee_id, effective_from DESC`, [org, ids, p.lastDay])).rows.map((row) => [row.employee_id, row]));
    const profiles = new Map((await client.query(`SELECT * FROM payroll_profiles WHERE organization_id=$1 AND employee_id = ANY($2)`, [org, ids])).rows.map((row) => [row.employee_id, presentProfile(row)]));
    // Accepted v2 tax declarations for this FY override the profile's declarations (regime + amounts); otherwise the profile is used.
    const accepted = await loadAcceptedDeclarations(client, org, ids, p.fyLabel);
    // Rules are versioned by date: the run uses the rule set in force for its own period, not today's.
    const ruleset = rulesetFor(run.period);
    const leaves = byEmployee((await client.query(
      `SELECT lr.id, lr.employee_id, to_char(lr.start_date,'YYYY-MM-DD') AS start_date, to_char(lr.end_date,'YYYY-MM-DD') AS end_date, lr.days::float, lt.name AS type_name
         FROM leave_requests lr JOIN leave_types lt ON lt.id=lr.leave_type_id AND lt.organization_id=lr.organization_id
        WHERE lr.organization_id=$1 AND lr.status='APPROVED' AND lr.employee_id = ANY($2) AND lr.start_date <= $4 AND lr.end_date >= $3
          AND (lt.code ILIKE '%LOP%' OR lt.name ILIKE '%unpaid%' OR lt.name ILIKE '%loss of pay%' OR lt.code ILIKE '%UNPAID%')`, [org, ids, p.firstDay, p.lastDay])).rows, (row) => row.employee_id);
    const inputs = byEmployee((await client.query(
      `SELECT id, employee_id, kind, code, label, amount::float, days::float, taxable, esi_wage, source FROM payroll_inputs
        WHERE organization_id=$1 AND run_id=$2 AND voided_at IS NULL ORDER BY created_at`, [org, run.id])).rows, (row) => row.employee_id);
    const ytd = new Map((await client.query(
      `SELECT l.employee_id, sum(l.taxable_income)::float AS taxable, sum(l.tds)::float AS tds, sum(l.pf_employee)::float AS pf, sum(l.pt)::float AS pt,
              sum(l.gross)::float AS gross, sum(l.net)::float AS net, count(*)::int AS months
         FROM payroll_run_lines l JOIN payroll_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
        WHERE l.organization_id=$1 AND r.status IN ('PUBLISHED','LOCKED') AND r.period >= $2 AND r.period < $3 AND l.status='INCLUDED'
          AND (NOT l.held OR l.released_at IS NOT NULL) GROUP BY l.employee_id`, [org, p.fyFirstPeriod, run.period])).rows.map((row) => [row.employee_id, row]));
    // switch-over import: add the previous payroll system's year-to-date (months up to its last paid month) to the TDS projection.
    for (const [employeeId, o] of await loadOpeningYtd(client, org, ids, p.fyLabel, run.period)) {
      const prior = ytd.get(employeeId) || { taxable: 0, tds: 0, pf: 0, pt: 0, gross: 0, net: 0, months: 0 };
      ytd.set(employeeId, { ...prior, taxable: prior.taxable + o.taxable, tds: prior.tds + o.tds, pf: prior.pf + o.pfEmployee + o.vpf, pt: prior.pt + o.pt,
        gross: prior.gross + o.gross, net: prior.net + openingNet(o), months: prior.months + o.months });
    }
    const esiPeriod = esiContributionPeriod(run.period);
    const esiEarlier = new Set((await client.query(
      `SELECT DISTINCT l.employee_id FROM payroll_run_lines l JOIN payroll_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
        WHERE l.organization_id=$1 AND r.status IN ('PUBLISHED','LOCKED') AND r.period >= $2 AND r.period < $3 AND l.status='INCLUDED'
          AND (l.breakdown->'statutory'->'esi'->>'covered')::boolean`, [org, esiPeriod.from, run.period])).rows.map((row) => row.employee_id));
    const previousPeriod = addMonths(run.period, -1);
    const previous = new Map((await client.query(
      `SELECT l.employee_id, l.net::float AS net FROM payroll_run_lines l JOIN payroll_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
        WHERE l.organization_id=$1 AND r.status IN ('PUBLISHED','LOCKED') AND r.period=$2 AND l.status='INCLUDED'
       UNION ALL
       SELECT p.employee_id, p.net::float FROM payslips p WHERE p.organization_id=$1 AND p.period=$2 AND p.status='PUBLISHED' AND p.payroll_run_id IS NULL`,
      [org, previousPeriod])).rows.map((row) => [row.employee_id, row.net]));
    const existing = new Map((await client.query(`SELECT employee_id, held, hold_reason, held_by FROM payroll_run_lines WHERE organization_id=$1 AND run_id=$2`, [org, run.id])).rows.map((row) => [row.employee_id, row]));

    for (const employee of employees) {
      const structure = structures.get(employee.id);
      const baseProfile = profiles.get(employee.id) || presentProfile(null);
      const statFlags = baseProfile.statutoryFlags;
      const declaration = accepted.get(employee.id);
      const profile = declaration
        ? { ...baseProfile, taxRegime: declaration.regime, declarations: { ...baseProfile.declarations, ...declaration.declarations } }
        : baseProfile;
      const state = resolveState(profile.stateCode, employee.location, settings.defaultState);
      const employeeLeaves = leaves.get(employee.id) || [];
      const leaveLopDays = lopDaysInPeriod(run.period, employeeLeaves.map((row): LeaveSpan => ({ startDate: row.start_date, endDate: row.end_date, days: row.days })));
      const employeeInputs: RunInput[] = (inputs.get(employee.id) || []).map((row) => ({ id: row.id, kind: row.kind, code: row.code, label: row.label, amount: row.amount, days: row.days, taxable: row.taxable, esiWage: row.esi_wage, source: row.source }));
      const prior = ytd.get(employee.id);
      const prevNet = previous.get(employee.id);
      const result = calculateLine({
        period: run.period, employee: { joiningDate: employee.joining_date, location: employee.location },
        structure: structure ? { components: structure.components, fixedMonthlyGross: structure.fixed_monthly_gross, isMetro: structure.is_metro } : null,
        profile: { regime: profile.taxRegime, pfApplicable: profile.pfApplicable, ptCategory: profile.ptCategory, state: state.state, stateSource: state.source,
          declarations: profile.declarations, hasPan: Boolean(profile.pan), hasBank: Boolean(profile.bankAccount && profile.ifsc),
          hasUan: Boolean(profile.uan), hasEsiNumber: Boolean(profile.esiNumber),
          epsEligible: statFlags.epsEligible, disabled: statFlags.disabled, vpfRate: statFlags.vpfRate, internationalWorker: statFlags.internationalWorker,
          ageCategory: profile.declarations.ageCategory || statFlags.ageCategory },
        settings: { pfWageMode: settings.pfWageMode, labourCodeWages: settings.labourCodeWages, lwfEnabled: settings.lwfEnabled, minimumWageMonthly: settings.minimumWageMonthly },
        leaveLopDays, inputs: employeeInputs,
        ytd: { taxable: prior?.taxable || 0, tds: prior?.tds || 0, pf: prior?.pf || 0, pt: prior?.pt || 0, gross: prior?.gross || 0, net: prior?.net || 0, months: prior?.months || 0 },
        esiCoveredEarlierInPeriod: esiEarlier.has(employee.id), previous: prevNet !== undefined ? { net: prevNet, period: monthLabel(previousPeriod) } : null,
      });
      const kept = existing.get(employee.id);
      const held = Boolean(kept?.held);
      const flags = held ? [...result.flags, { code: "HELD", tone: "warning", message: `On hold${kept?.hold_reason ? `: ${kept.hold_reason}` : ""} — excluded from bank file and publishing.` }] : result.flags;
      const breakdown = {
        employee: {
          number: employee.employee_number, name: employee.full_name, department: employee.department, designation: employee.designation, location: employee.location,
          joiningDate: employee.joining_date, pan: profile.pan, uan: profile.uan, esiNumber: profile.esiNumber, // already masked
          bank: profile.bankAccount ? `${profile.bankName || "Bank"} · ${profile.bankAccount}` : null, state: state.state, stateSource: state.source, regime: profile.taxRegime,
        },
        period: run.period, fiscalYear: p.fyLabel, rulesetVersion: ruleset.version,
        taxDeclaration: declaration
          ? { source: "TAX_DECLARATION", id: declaration.id, regime: declaration.regime, acceptedShare: declaration.factor, reviewedAt: declaration.reviewedAt }
          : { source: "PAYROLL_PROFILE" },
        structure: structure ? { id: structure.id, effectiveFrom: structure.effective_from, annualCtc: structure.annual_ctc, fixedMonthlyGross: structure.fixed_monthly_gross } : null,
        lopLeaves: employeeLeaves.map((row) => ({ id: row.id, type: row.type_name, startDate: row.start_date, endDate: row.end_date, days: row.days })),
        ...result,
      };
      const t = result.included ? result.totals : null;
      const s = result.included ? result.statutory : null;
      await client.query(
        `INSERT INTO payroll_run_lines(organization_id,run_id,employee_id,structure_id,status,held,hold_reason,held_by,days_in_month,payable_days,lop_days,
            gross,reimbursements,deductions,net,employer_cost,taxable_income,tds,pf_employee,esi_employee,pt,breakdown,flags,previous_net,variance_pct)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
         ON CONFLICT(run_id,employee_id) DO UPDATE SET structure_id=$4,status=$5,days_in_month=$9,payable_days=$10,lop_days=$11,gross=$12,reimbursements=$13,
            deductions=$14,net=$15,employer_cost=$16,taxable_income=$17,tds=$18,pf_employee=$19,esi_employee=$20,pt=$21,breakdown=$22,flags=$23,previous_net=$24,
            variance_pct=$25,updated_at=now()`,
        [org, run.id, employee.id, structure?.id || null, result.included ? "INCLUDED" : "EXCLUDED", held, kept?.hold_reason || null, kept?.held_by || null,
          result.days.daysInMonth, result.days.payableDays, result.days.lopDays, t?.gross || 0, t?.reimbursements || 0, t?.deductions || 0, t?.net || 0,
          // pf_employee = employee PF + VPF: it feeds year-to-date PF (80C / TDS projection) and the PF register column.
          t?.employerCost || 0, t?.taxable || 0, s?.tds.amount || 0, (s?.pf.employee || 0) + (s?.pf.vpf || 0), s?.esi.employee || 0, s?.pt.amount || 0,
          JSON.stringify(breakdown), JSON.stringify(flags), prevNet ?? null, result.included ? result.variancePct : null]);
    }
    await client.query(`DELETE FROM payroll_run_lines WHERE organization_id=$1 AND run_id=$2 AND NOT (employee_id = ANY($3))`, [org, run.id, ids]);
    return { totals: await this.totals(client, identity, run.id), expensesAdded };
  }

  /** Pull APPROVED (awaiting payment) expense claims into the run as non-taxable reimbursements. */
  private async syncExpenses(client: PoolClient, identity: AuthIdentity, run: RunRow, lastDay: string) {
    const org = identity.organizationId;
    // Claims that stopped being payable (paid outside payroll, rejected, withdrawn) drop out of an unapproved run.
    await client.query(
      `UPDATE payroll_inputs i SET voided_at=now(), note=coalesce(i.note,'')||' [claim no longer approved]'
         FROM hr_cases c WHERE i.organization_id=$1 AND i.run_id=$2 AND i.source='EXPENSE_CLAIM' AND i.voided_at IS NULL
          AND c.organization_id=i.organization_id AND c.id=i.source_ref AND c.status<>'APPROVED'`, [org, run.id]);
    const added = await client.query(
      `INSERT INTO payroll_inputs(organization_id,run_id,employee_id,kind,code,label,amount,taxable,esi_wage,source,source_ref,note,created_by)
       SELECT $1, $2, c.requester_id, 'REIMBURSEMENT', 'REIMBURSEMENT', left('Expense ' || c.case_number || ' — ' || c.title, 120), c.amount, false, false,
              'EXPENSE_CLAIM', c.id, c.category, $4
         FROM hr_cases c
        WHERE c.organization_id=$1 AND c.module='expenses' AND c.status='APPROVED' AND c.amount > 0 AND coalesce(c.start_date, c.created_at::date) <= $3
          AND NOT EXISTS (SELECT 1 FROM payroll_inputs i WHERE i.organization_id=$1 AND i.source='EXPENSE_CLAIM' AND i.source_ref=c.id
                            AND (i.voided_at IS NULL OR i.run_id=$2))
       RETURNING id`, [org, run.id, lastDay, identity.employeeId]);
    return added.rowCount || 0;
  }

  private async totals(client: PoolClient, identity: AuthIdentity, runId: string) {
    const row = (await client.query(
      `SELECT count(*)::int AS headcount,
              count(*) FILTER (WHERE status='INCLUDED' AND NOT held)::int AS payable,
              count(*) FILTER (WHERE held)::int AS held,
              count(*) FILTER (WHERE status='EXCLUDED')::int AS excluded,
              coalesce(sum(gross) FILTER (WHERE status='INCLUDED' AND NOT held),0)::float AS gross,
              coalesce(sum(reimbursements) FILTER (WHERE status='INCLUDED' AND NOT held),0)::float AS reimbursements,
              coalesce(sum(deductions) FILTER (WHERE status='INCLUDED' AND NOT held),0)::float AS deductions,
              coalesce(sum(net) FILTER (WHERE status='INCLUDED' AND NOT held),0)::float AS net,
              coalesce(sum(employer_cost) FILTER (WHERE status='INCLUDED' AND NOT held),0)::float AS employer_cost,
              coalesce(sum(tds) FILTER (WHERE status='INCLUDED' AND NOT held),0)::float AS tds,
              coalesce(sum(pf_employee) FILTER (WHERE status='INCLUDED' AND NOT held),0)::float AS pf_employee,
              coalesce(sum(esi_employee) FILTER (WHERE status='INCLUDED' AND NOT held),0)::float AS esi_employee,
              coalesce(sum(pt) FILTER (WHERE status='INCLUDED' AND NOT held),0)::float AS pt,
              coalesce(sum((breakdown->'statutory'->'pf'->>'employerTotal')::numeric) FILTER (WHERE status='INCLUDED' AND NOT held),0)::float AS pf_employer,
              coalesce(sum((breakdown->'statutory'->'esi'->>'employer')::numeric) FILTER (WHERE status='INCLUDED' AND NOT held),0)::float AS esi_employer,
              coalesce(sum(lop_days),0)::float AS lop_days,
              count(*) FILTER (WHERE flags @> '[{"code":"NEGATIVE_NET"}]' AND NOT held)::int AS blocking,
              count(*) FILTER (WHERE jsonb_array_length(flags) > 0)::int AS flagged
         FROM payroll_run_lines WHERE organization_id=$1 AND run_id=$2`, [identity.organizationId, runId])).rows[0];
    const flagCounts = Object.fromEntries((await client.query(
      `SELECT f->>'code' AS code, count(*)::int AS count FROM payroll_run_lines l, jsonb_array_elements(l.flags) f
        WHERE l.organization_id=$1 AND l.run_id=$2 GROUP BY 1`, [identity.organizationId, runId])).rows.map((item) => [item.code, item.count]));
    return {
      headcount: row.headcount, payable: row.payable, held: row.held, excluded: row.excluded, gross: row.gross, reimbursements: row.reimbursements,
      deductions: row.deductions, net: row.net, employerCost: row.employer_cost, tds: row.tds, pfEmployee: row.pf_employee, pfEmployer: row.pf_employer,
      esiEmployee: row.esi_employee, esiEmployer: row.esi_employer, pt: row.pt, lopDays: row.lop_days, blocking: row.blocking, flagged: row.flagged, flags: flagCounts,
    };
  }

  // ------------------------------------------------------------ inputs & holds

  addInput(identity: AuthIdentity, runId: string, input: RunInputDto) {
    requireAdmin(identity);
    const def = INPUT_CODES[input.code];
    if (def.kind === "LOP" ? !input.days : !input.amount) throw new BadRequestException(def.kind === "LOP" ? "Enter the number of LOP days." : "Enter an amount.");
    return this.database.tenantTransaction(identity, async (client) => {
      const run = await this.load(client, identity, runId, true);
      if (!EDITABLE.includes(run.status)) throw new ConflictException("Inputs can only change while the run is in draft or calculated.");
      const employee = (await client.query(`SELECT id, full_name FROM employees WHERE organization_id=$1 AND id=$2 AND status='ACTIVE'`, [identity.organizationId, input.employeeId])).rows[0];
      if (!employee) throw new NotFoundException("Active employee not found.");
      const row = (await client.query(
        `INSERT INTO payroll_inputs(organization_id,run_id,employee_id,kind,code,label,amount,days,taxable,esi_wage,note,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [identity.organizationId, runId, input.employeeId, def.kind, input.code, input.label?.trim() || def.label, def.kind === "LOP" ? 0 : input.amount,
          def.kind === "LOP" ? input.days : null, def.kind === "EARNING" ? input.taxable ?? def.taxable : def.taxable, def.esiWage, input.note?.trim() || null, identity.employeeId])).rows[0];
      await this.touch(client, identity, run);
      await audit(client, identity, "PAYROLL_INPUT_ADDED", "payroll_run", runId, null, { inputId: row.id, employee: employee.full_name, code: input.code, amount: input.amount, days: input.days });
      return { id: row.id, needsRecalc: true };
    });
  }

  removeInput(identity: AuthIdentity, runId: string, inputId: string) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const run = await this.load(client, identity, runId, true);
      if (!EDITABLE.includes(run.status)) throw new ConflictException("Inputs can only change while the run is in draft or calculated.");
      const row = (await client.query(
        `UPDATE payroll_inputs SET voided_at=now() WHERE organization_id=$1 AND run_id=$2 AND id=$3 AND voided_at IS NULL RETURNING code, label, amount::float, days::float, source`,
        [identity.organizationId, runId, inputId])).rows[0];
      if (!row) throw new NotFoundException("Input not found.");
      await this.touch(client, identity, run);
      await audit(client, identity, "PAYROLL_INPUT_REMOVED", "payroll_run", runId, row, { inputId });
      return { removed: true, needsRecalc: true };
    });
  }

  hold(identity: AuthIdentity, runId: string, employeeId: string, input: HoldDto) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const run = await this.load(client, identity, runId, true);
      const line = (await client.query(`SELECT * FROM payroll_run_lines WHERE organization_id=$1 AND run_id=$2 AND employee_id=$3 FOR UPDATE`, [identity.organizationId, runId, employeeId])).rows[0];
      if (!line) throw new NotFoundException("This employee is not part of the run.");
      if (line.status !== "INCLUDED") throw new BadRequestException("Only calculated employees can be held.");
      if (input.hold === line.held) return { held: line.held };
      if (input.hold && !input.reason?.trim()) throw new BadRequestException("Give a reason for holding this salary.");
      if (input.hold && !EDITABLE.includes(run.status)) throw new ConflictException("Salaries can only be put on hold before the run is submitted.");
      const releaseAfterPublish = !input.hold && run.status === "PUBLISHED";
      if (!input.hold && !EDITABLE.includes(run.status) && !releaseAfterPublish)
        throw new ConflictException(run.status === "LOCKED" ? "The run is locked — held salaries can no longer be released through it." : "Release held salaries while the run is editable or after it is published.");
      const flags = (line.flags as any[]).filter((flag) => flag.code !== "HELD");
      if (input.hold) flags.push({ code: "HELD", tone: "warning", message: `On hold: ${input.reason!.trim()} — excluded from bank file and publishing.` });
      await client.query(
        `UPDATE payroll_run_lines SET held=$4, hold_reason=$5, held_by=$6, flags=$7, released_at=$8, updated_at=now() WHERE organization_id=$1 AND run_id=$2 AND employee_id=$3`,
        [identity.organizationId, runId, employeeId, input.hold, input.hold ? input.reason!.trim() : null, input.hold ? identity.employeeId : null, JSON.stringify(flags), releaseAfterPublish ? new Date() : null]);
      if (releaseAfterPublish) await this.publishLine(client, identity, run, employeeId);
      const totals = await this.totals(client, identity, runId);
      await client.query(`UPDATE payroll_runs SET totals=$3, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`, [identity.organizationId, runId, JSON.stringify(totals)]);
      await audit(client, identity, input.hold ? "PAYROLL_LINE_HELD" : releaseAfterPublish ? "PAYROLL_LINE_RELEASED" : "PAYROLL_LINE_UNHELD", "payroll_run", runId,
        { employeeId, held: line.held }, { employeeId, held: input.hold, reason: input.reason || null });
      return { held: input.hold, released: releaseAfterPublish };
    });
  }

  // ------------------------------------------------------------ state machine

  transition(identity: AuthIdentity, id: string, input: RunTransitionDto) {
    if (input.action === "approve" || input.action === "reject") requireReviewer(identity); else requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const run = await this.load(client, identity, id, true);
      this.checkVersion(run, input.version);
      const org = identity.organizationId;
      const note = input.note?.trim() || null;
      const label = monthLabel(run.period);
      const from = run.status as string;
      const allowed: Record<string, string[]> = {
        submit: ["CALCULATED"], approve: ["SUBMITTED"], reject: ["SUBMITTED", "APPROVED"], reopen: ["SUBMITTED", "APPROVED"],
        publish: ["APPROVED"], lock: ["PUBLISHED"], cancel: ["DRAFT", "CALCULATED", "SUBMITTED", "APPROVED"],
      };
      if (!allowed[input.action].includes(from)) throw new ConflictException(`Cannot ${input.action} a run that is ${from.toLowerCase()}.`);
      let to = from;
      const set: string[] = [];
      const values: unknown[] = [org, id];
      const me = () => { if (!values.includes(identity.employeeId)) values.push(identity.employeeId); return `$${values.indexOf(identity.employeeId) + 1}`; };
      switch (input.action) {
        case "submit": {
          if (run.needs_recalc) throw new ConflictException("Salary data or inputs changed after the last calculation — recalculate before submitting.");
          const totals = await this.totals(client, identity, id);
          if (totals.blocking) throw new ConflictException(`${totals.blocking} employee(s) have a negative net pay. Hold them or fix their inputs before submitting.`);
          if (!totals.payable) throw new ConflictException("There is nobody to pay in this run.");
          to = "SUBMITTED"; set.push("submitted_at=now()", `submitted_by=${me()}`, "approved_at=NULL", "approved_by=NULL");
          const approvers = (await client.query(
            `SELECT DISTINCT e.id FROM organization_memberships m JOIN employees e ON e.organization_id=m.organization_id AND e.user_id=m.user_id
              WHERE m.organization_id=$1 AND m.status='ACTIVE' AND m.role = ANY($2) AND e.id<>$3`, [org, PAYROLL_ROLES, identity.employeeId])).rows;
          for (const approver of approvers)
            await notify(client, org, approver.id, "PAYROLL_APPROVAL_REQUESTED", "payroll_run", id,
              { message: `${label} payroll (${totals.payable} employees, net ₹${Math.round(totals.net).toLocaleString("en-IN")}) is waiting for your approval.`, period: run.period, link: `/payroll/admin/${id}` });
          break;
        }
        case "approve":
          if (!run.submitted_by) throw new ConflictException("This run has no recorded submitter — send it back and submit it again.");
          if (run.submitted_by === identity.employeeId || run.calculated_by === identity.employeeId)
            throw new ForbiddenException("Maker-checker: the person who prepared (calculated or submitted) this run cannot approve it. Ask another payroll or HR admin.");
          to = "APPROVED"; set.push("approved_at=now()", `approved_by=${me()}`);
          if (run.submitted_by) await notify(client, org, run.submitted_by, "PAYROLL_RUN_APPROVED", "payroll_run", id, { message: `${label} payroll was approved and is ready to publish.`, link: `/payroll/admin/${id}` });
          break;
        case "reject":
        case "reopen":
          if (input.action === "reject" && !note) throw new BadRequestException("Explain what needs to change before sending the run back.");
          if (input.action === "reject" && run.submitted_by === identity.employeeId) throw new ForbiddenException("You submitted this run — use “Withdraw” instead of sending it back.");
          to = "CALCULATED"; set.push("submitted_at=NULL", "submitted_by=NULL", "approved_at=NULL", "approved_by=NULL");
          if (run.submitted_by && run.submitted_by !== identity.employeeId)
            await notify(client, org, run.submitted_by, "PAYROLL_RUN_RETURNED", "payroll_run", id, { message: `${label} payroll was sent back${note ? `: ${note}` : "."}`, link: `/payroll/admin/${id}` });
          break;
        case "publish": {
          to = "PUBLISHED"; set.push("published_at=now()", `published_by=${me()}`);
          const lines = (await client.query(`SELECT employee_id FROM payroll_run_lines WHERE organization_id=$1 AND run_id=$2 AND status='INCLUDED' AND NOT held`, [org, id])).rows;
          for (const line of lines) await this.publishLine(client, identity, run, line.employee_id);
          break;
        }
        case "lock":
          to = "LOCKED"; set.push("locked_at=now()", `locked_by=${me()}`);
          break;
        case "cancel":
          if (!note) throw new BadRequestException("Give a reason for cancelling the run.");
          to = "CANCELLED"; const noteParam = `$${values.push(note)}`; set.push("cancelled_at=now()", `cancelled_by=${me()}`, `cancel_reason=${noteParam}`);
          await client.query(`UPDATE payroll_inputs SET voided_at=now() WHERE organization_id=$1 AND run_id=$2 AND voided_at IS NULL`, [org, id]);
          break;
      }
      await client.query(
        `UPDATE payroll_runs SET status='${to}', ${set.length ? `${set.join(", ")}, ` : ""}version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`,
        values);
      if (input.action === "publish") {
        const totals = await this.totals(client, identity, id);
        await client.query(`UPDATE payroll_runs SET totals=$3 WHERE organization_id=$1 AND id=$2`, [org, id, JSON.stringify(totals)]);
      }
      await audit(client, identity, `PAYROLL_RUN_${input.action.toUpperCase()}`, "payroll_run", id, { status: from }, { status: to, note });
      return this.present(identity, await this.load(client, identity, id));
    });
  }

  /** Writes the employee's payslip (PUBLISHED, with the full breakdown) and notifies them. */
  private async publishLine(client: PoolClient, identity: AuthIdentity, run: RunRow, employeeId: string) {
    const org = identity.organizationId;
    const line = (await client.query(`SELECT * FROM payroll_run_lines WHERE organization_id=$1 AND run_id=$2 AND employee_id=$3`, [org, run.id, employeeId])).rows[0];
    const gross = num(line.gross) + num(line.reimbursements);
    const payslip = (await client.query(
      `INSERT INTO payslips(organization_id,employee_id,period,gross,deductions,net,status,published_at,storage_reference,breakdown,payroll_run_id)
       VALUES($1,$2,$3,$4,$5,$6,'PUBLISHED',now(),$7,$8,$9)
       ON CONFLICT(organization_id,employee_id,period) DO UPDATE SET gross=$4,deductions=$5,net=$6,status='PUBLISHED',published_at=now(),storage_reference=$7,breakdown=$8,payroll_run_id=$9
       RETURNING id`,
      [org, employeeId, run.period, gross, num(line.deductions), num(line.net), `payroll-run:${run.id}`, JSON.stringify(line.breakdown), run.id])).rows[0];
    await client.query(`UPDATE payroll_run_lines SET payslip_id=$4, published_at=now() WHERE organization_id=$1 AND run_id=$2 AND employee_id=$3`, [org, run.id, employeeId, payslip.id]);
    await notify(client, org, employeeId, "PAYSLIP_PUBLISHED", "payslip", payslip.id, {
      message: `Your payslip for ${monthLabel(run.period)} is ready — net pay ₹${Math.round(num(line.net)).toLocaleString("en-IN")}.`,
      period: run.period, net: num(line.net), link: `/payroll/payslips/${run.period}`,
    });
  }

  // ------------------------------------------------------------ exports

  async exportFile(identity: AuthIdentity, id: string, kind: string) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const run = await this.load(client, identity, id);
      if (run.status === "DRAFT" || run.status === "CANCELLED") throw new ConflictException("Calculate the run before exporting.");
      if (kind === "bank") {
        const blocked = bankFileError(identity, run as any);
        if (blocked) throw blocked;
      }
      const settings = (run.settings_snapshot as Settings) || (await loadSettings(client, identity.organizationId));
      const lines = (await client.query(
        `SELECT l.*, e.employee_number, e.full_name, e.department, e.location, pp.ifsc, pp.bank_name, pp.bank_account_enc, pp.uan_enc, pp.esi_number_enc
           FROM payroll_run_lines l JOIN employees e ON e.id=l.employee_id AND e.organization_id=l.organization_id
           LEFT JOIN payroll_profiles pp ON pp.organization_id=l.organization_id AND pp.employee_id=l.employee_id
          WHERE l.organization_id=$1 AND l.run_id=$2 ORDER BY e.employee_number`, [identity.organizationId, id])).rows;
      const paid = lines.filter((line) => line.status === "INCLUDED" && (!line.held || line.released_at));
      const tag = run.period.replace("-", "");
      const narration = `SALARY ${monthLabel(run.period).toUpperCase()}`;
      const s = (line: any) => line.breakdown?.statutory || {};
      // Decrypts one identifier of the line's payroll profile (ciphertext is bound to this brand + employee).
      const pii = (line: any, field: "bankAccount" | "uan" | "esiNumber") => decryptProfileField(line, field);
      const file = this.buildExport(kind, run, lines, paid, settings, tag, narration, s, pii);
      const body = file.type === "text/csv" ? `\ufeff${file.body}` : file.body;
      const sha256 = createHash("sha256").update(body, "utf8").digest("hex");
      await audit(client, identity, "PAYROLL_EXPORTED", "payroll_run", id, null, {
        kind, file: file.name, sha256, rows: file.rows, total: file.total, runStatus: run.status, period: run.period,
      });
      return { ...file, body, sha256 };
    });
  }

  private buildExport(kind: string, run: RunRow, lines: any[], paid: any[], settings: Settings, tag: string, narration: string,
                      s: (line: any) => any, pii: (line: any, field: "bankAccount" | "uan" | "esiNumber") => string | null) {
      switch (kind) {
        case "bank": {
          const rows: unknown[][] = [["Sr No", "Employee ID", "Beneficiary name", "Bank", "Account number", "IFSC", "Amount", "Payment date", "Narration", "Debit account"]];
          let n = 0, total = 0;
          for (const line of paid) {
            if (!line.bank_account_enc || !line.ifsc || num(line.net) <= 0) continue;
            const account = pii(line, "bankAccount");
            if (!account) continue;
            total += num(line.net);
            rows.push([++n, line.employee_number, line.full_name, line.bank_name || "", account, line.ifsc, num(line.net), run.pay_date_text, narration, settings.debitAccount || ""]);
          }
          // Control trailer: the bank portal / treasury reconciles count and amount before releasing the batch.
          total = Math.round(total * 100) / 100;
          rows.push([], ["CONTROL TOTAL", `${n} payments`, "", "", "", "", total, run.pay_date_text, `RUN ${run.id}`, settings.debitAccount || ""]);
          return { body: toCsv(rows), name: `bank-transfer-${tag}.csv`, type: "text/csv", rows: n, total };
        }
        case "pf-ecr": {
          // EPFO ECR 2.0 text layout: #~# separated, one member per line.
          const members = paid.filter((line) => s(line).pf?.applicable && num(s(line).pf?.employee) > 0);
          const body = members.map((line) => {
            const pf = s(line).pf;
            const ncp = Math.round(num(line.days_in_month) - num(line.payable_days));
            return [pii(line, "uan") || "UAN-MISSING", plainField(String(line.full_name).toUpperCase()), Math.round(num(line.gross)), pf.pfWage, pf.epsWage, pf.edliWage ?? pf.epsWage, num(pf.employee) + num(pf.vpf), pf.employerEps, pf.employerEpf, ncp, 0].join("#~#");
          }).join("\r\n");
          return { body: body ? `${body}\r\n` : "", name: `pf-ecr-${tag}.txt`, type: "text/plain", rows: members.length, total: members.reduce((t, line) => t + num(s(line).pf.employee) + num(s(line).pf.vpf), 0) };
        }
        case "esi": {
          const rows: unknown[][] = [["IP number", "IP name", "Days paid", "Total monthly wages", "Employee contribution", "Employer contribution", "Reason code", "Last working day"]];
          let wages = 0, employee = 0, employer = 0;
          for (const line of paid) {
            const esi = s(line).esi;
            if (!esi?.covered) continue;
            wages += num(esi.wages); employee += num(esi.employee); employer += num(esi.employer);
            rows.push([pii(line, "esiNumber") || "", line.full_name, num(line.payable_days), num(esi.wages), num(esi.employee), num(esi.employer), num(line.payable_days) === 0 ? 1 : 0, ""]);
          }
          const count = rows.length - 1;
          rows.push([], ["TOTAL", `${count} employees`, "", wages, employee, employer, "", ""]);
          return { body: toCsv(rows), name: `esi-contribution-${tag}.csv`, type: "text/csv", rows: count, total: employee + employer };
        }
        case "pt": {
          const rows: unknown[][] = [["State", "Employee ID", "Name", "Gross salary", "Professional tax"]];
          const byState = new Map<string, { name: string; employees: number; gross: number; pt: number }>();
          for (const line of paid) {
            const pt = s(line).pt || {};
            rows.push([pt.stateName || pt.state || "", line.employee_number, line.full_name, num(line.gross), num(line.pt)]);
            const agg = byState.get(pt.state) || { name: pt.stateName || pt.state, employees: 0, gross: 0, pt: 0 };
            agg.employees += 1; agg.gross += num(line.gross); agg.pt += num(line.pt);
            byState.set(pt.state, agg);
          }
          rows.push([], ["Summary by state", "Employees", "", "Gross salary", "Professional tax"]);
          for (const agg of byState.values()) rows.push([agg.name, agg.employees, "", agg.gross, agg.pt]);
          return { body: toCsv(rows), name: `professional-tax-${tag}.csv`, type: "text/csv", rows: paid.length, total: paid.reduce((t, line) => t + num(line.pt), 0) };
        }
        case "register": {
          const rows: unknown[][] = [["Employee ID", "Name", "Department", "Location", "PT state", "Status", "Days in month", "LOP days", "Payable days",
            "Basic", "HRA", "Conveyance", "Other allowance", "Special allowance", "One-time earnings", "Gross earnings", "Reimbursements",
            "PF (employee)", "ESI (employee)", "Professional tax", "TDS", "Other deductions", "Total deductions", "Net pay",
            "Employer EPF", "Employer EPS", "EDLI + admin", "Employer ESI", "Employer cost", "Previous net", "Variance %", "Flags"]];
          for (const line of lines) {
            const b = line.breakdown || {};
            const earn = (code: string) => (b.earnings || []).find((item: any) => item.code === code)?.amount || 0;
            const st = b.statutory || {};
            const statutoryDeductions = num(line.pf_employee) + num(line.esi_employee) + num(line.pt) + num(line.tds);
            rows.push([line.employee_number, line.full_name, line.department, line.location, st.pt?.stateName || "", line.status === "EXCLUDED" ? "Excluded" : line.held ? (line.released_at ? "Released" : "Held") : "Included",
              num(line.days_in_month), num(line.lop_days), num(line.payable_days), earn("BASIC"), earn("HRA"), earn("CONVEYANCE"), earn("OTHER_ALLOWANCE"), earn("SPECIAL"),
              (b.oneTime || []).reduce((t: number, item: any) => t + num(item.amount), 0), num(line.gross), num(line.reimbursements),
              num(line.pf_employee), num(line.esi_employee), num(line.pt), num(line.tds), num(line.deductions) - statutoryDeductions, num(line.deductions), num(line.net),
              num(st.pf?.employerEpf), num(st.pf?.employerEps), num(st.pf?.edli) + num(st.pf?.admin), num(st.esi?.employer), num(line.employer_cost),
              line.previous_net === null ? "" : num(line.previous_net), line.variance_pct === null ? "" : num(line.variance_pct),
              (line.flags as any[]).map((flag) => flag.code).join(" ")]);
          }
          return { body: toCsv(rows), name: `payroll-register-${tag}.csv`, type: "text/csv", rows: lines.length, total: paid.reduce((t, line) => t + num(line.net), 0) };
        }
        default:
          throw new NotFoundException("Unknown export.");
      }
  }


  // ------------------------------------------------------------ helpers

  private async load(client: PoolClient, identity: AuthIdentity, id: string, forUpdate = false) {
    if (forUpdate) await client.query(`SELECT id FROM payroll_runs WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [identity.organizationId, id]);
    const row = (await client.query(`${RUN_SELECT} WHERE r.organization_id=$1 AND r.id=$2`, [identity.organizationId, id])).rows[0];
    if (!row) throw new NotFoundException("Payroll run not found.");
    return row;
  }

  private checkVersion(run: RunRow, version: number) {
    if (run.version !== version) throw new ConflictException("This run changed since you loaded it. Reload to see the latest numbers.");
  }

  /** Inputs changed: a calculated run needs recalculation; bump the version so stale screens reload. */
  private touch(client: PoolClient, identity: AuthIdentity, run: RunRow) {
    return client.query(`UPDATE payroll_runs SET needs_recalc = (status='CALCULATED'), version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`, [identity.organizationId, run.id]);
  }

  private present(identity: AuthIdentity, row: RunRow) {
    const status = row.status as string;
    const mine = row.submitted_by === identity.employeeId;
    const prepared = mine || row.calculated_by === identity.employeeId;
    const actions: { action: string; label: string; intent: "primary" | "neutral" | "danger"; noteRequired?: boolean; disabledReason?: string }[] = [];
    if (EDITABLE.includes(status)) actions.push({ action: "calculate", label: status === "DRAFT" ? "Calculate payroll" : "Recalculate", intent: status === "DRAFT" || row.needs_recalc ? "primary" : "neutral" });
    if (status === "CALCULATED") actions.push({ action: "submit", label: "Submit for approval", intent: "primary", disabledReason: row.needs_recalc ? "Recalculate first — inputs changed." : row.totals?.blocking ? "Resolve negative net pay first." : undefined });
    if (status === "SUBMITTED") {
      actions.push({ action: "approve", label: "Approve", intent: "primary", disabledReason: prepared ? "You prepared this run — another admin must approve (maker-checker)." : undefined });
      if (!mine) actions.push({ action: "reject", label: "Send back", intent: "neutral", noteRequired: true });
      else actions.push({ action: "reopen", label: "Withdraw", intent: "neutral" });
    }
    if (status === "APPROVED") { actions.push({ action: "publish", label: "Publish payslips", intent: "primary" }); actions.push({ action: "reopen", label: "Reopen", intent: "neutral" }); }
    if (status === "PUBLISHED") actions.push({ action: "lock", label: "Lock period", intent: "neutral" });
    if (["DRAFT", "CALCULATED", "SUBMITTED", "APPROVED"].includes(status)) actions.push({ action: "cancel", label: "Cancel run", intent: "danger", noteRequired: true });
    return {
      id: row.id, period: row.period, label: monthLabel(row.period), status, payDate: row.pay_date_text, includeExpenses: row.include_expenses,
      needsRecalc: row.needs_recalc, notes: row.notes, totals: row.totals || {}, rulesetVersion: row.ruleset_version, version: row.version,
      createdAt: row.created_at, updatedAt: row.updated_at,
      people: {
        createdBy: row.created_by_name, calculatedBy: row.calculated_by_name, calculatedAt: row.calculated_at, submittedBy: row.submitted_by_name, submittedById: row.submitted_by,
        submittedAt: row.submitted_at, approvedBy: row.approved_by_name, approvedAt: row.approved_at, publishedBy: row.published_by_name, publishedAt: row.published_at,
        lockedBy: row.locked_by_name, lockedAt: row.locked_at, cancelledBy: row.cancelled_by_name, cancelledAt: row.cancelled_at, cancelReason: row.cancel_reason,
      },
      editable: EDITABLE.includes(status), steps: RUN_STEPS, actions,
      bankFile: (() => { const blocked = bankFileBlock(identity, row as any); return { allowed: !blocked, reason: blocked?.reason || null }; })(),
    };
  }
}

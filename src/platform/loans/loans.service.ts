import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { audit, isPayrollAdmin, monthLabel, notify, num, requireAdmin } from "../payroll/payroll.shared";
import { todayIst } from "../payroll/rules/types";
import type { CancelLoanDto, DecideLoanDto, DisburseLoanDto, ForecloseDto, LoanListQuery, RequestLoanDto, SkipInstallmentDto } from "./loans.dto";
import { POLICY, PURPOSES, addMonths, perquisiteFlag, schedule, validateRequest } from "./loan-rules";

const LOAN_COLUMNS = `l.id, l.loan_number, l.employee_id, e.full_name AS employee_name, e.employee_number, e.department, l.kind, l.purpose, l.reason,
  l.principal::float, l.tenure_months, l.emi::float, l.first_period, l.status, l.requested_by, rq.full_name AS requested_by_name,
  l.decided_by, d.full_name AS decided_by_name, l.decided_at, l.decision_note, to_char(l.disbursed_on,'YYYY-MM-DD') AS disbursed_on, l.disbursement_ref,
  l.closed_at, l.closure_note, l.version, l.created_at,
  coalesce((SELECT sum(i.amount) FROM employee_loan_installments i WHERE i.loan_id=l.id AND i.status IN ('DEDUCTED','PREPAID')),0)::float AS recovered`;
const LOAN_FROM = `employee_loans l JOIN employees e ON e.id=l.employee_id AND e.organization_id=l.organization_id
  JOIN employees rq ON rq.id=l.requested_by AND rq.organization_id=l.organization_id
  LEFT JOIN employees d ON d.id=l.decided_by AND d.organization_id=l.organization_id`;

const nextPeriod = () => addMonths(todayIst().slice(0, 7), 1);

@Injectable()
export class LoansService {
  constructor(private readonly database: DatabaseService) {}

  context(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const gross = await this.monthlyGross(client, identity.organizationId, identity.employeeId);
      return {
        viewer: { employeeId: identity.employeeId, isAdmin: isPayrollAdmin(identity) },
        purposes: PURPOSES, policy: POLICY, monthlyGross: gross, defaultFirstPeriod: nextPeriod(),
        outstanding: await this.outstanding(client, identity.organizationId, identity.employeeId),
        limits: gross === null ? null : { ADVANCE: Math.floor(gross * POLICY.ADVANCE.maxGrossMultiple), LOAN: Math.floor(gross * POLICY.LOAN.maxGrossMultiple) },
      };
    });
  }

  list(identity: AuthIdentity, query: LoanListQuery) {
    const scope = query.scope || "mine";
    if (scope === "all") requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const values: unknown[] = [identity.organizationId];
      const where = ["l.organization_id=$1"];
      if (scope === "mine") { values.push(identity.employeeId); where.push(`l.employee_id=$${values.length}`); }
      if (query.status) { values.push(query.status); where.push(`l.status=$${values.length}`); }
      const rows = (await client.query(`SELECT ${LOAN_COLUMNS} FROM ${LOAN_FROM} WHERE ${where.join(" AND ")} ORDER BY l.created_at DESC LIMIT 500`, values)).rows;
      const summary = scope === "all" ? (await client.query(
        `SELECT count(*) FILTER (WHERE status='REQUESTED')::int AS pending, count(*) FILTER (WHERE status='APPROVED')::int AS to_disburse,
                count(*) FILTER (WHERE status='ACTIVE')::int AS active,
                coalesce(sum(principal) FILTER (WHERE status='ACTIVE'),0)::float AS active_principal,
                coalesce((SELECT sum(i.amount) FROM employee_loan_installments i JOIN employee_loans x ON x.id=i.loan_id
                           WHERE i.organization_id=$1 AND x.status='ACTIVE' AND i.status='DUE'),0)::float AS outstanding,
                coalesce((SELECT sum(i.amount) FROM employee_loan_installments i JOIN employee_loans x ON x.id=i.loan_id
                           WHERE i.organization_id=$1 AND x.status='ACTIVE' AND i.status='DUE' AND i.period=$2),0)::float AS due_next
           FROM employee_loans WHERE organization_id=$1`, [identity.organizationId, nextPeriod()])).rows[0] : null;
      return { items: rows.map((row) => this.present(row)), summary };
    });
  }

  get(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = await this.load(client, identity, id);
      const installments = (await client.query(
        `SELECT i.id, i.seq, i.period, i.amount::float, i.status, i.note, i.run_id, r.status AS run_status
           FROM employee_loan_installments i LEFT JOIN payroll_runs r ON r.id=i.run_id AND r.organization_id=i.organization_id
          WHERE i.organization_id=$1 AND i.loan_id=$2 ORDER BY i.seq`, [identity.organizationId, id])).rows;
      const history = isPayrollAdmin(identity) ? (await client.query(
        `SELECT a.action, a.after_data, a.created_at, u.full_name AS actor FROM audit_log a LEFT JOIN users u ON u.id=a.actor_user_id
          WHERE a.organization_id=$1 AND a.entity_type='employee_loan' AND a.entity_id=$2 ORDER BY a.created_at`, [identity.organizationId, id])).rows : [];
      const preview = row.status === "REQUESTED" ? schedule(num(row.principal), row.tenure_months, row.first_period).rows : [];
      return { ...this.present(row), installments: installments.length ? installments : preview.map((p) => ({ ...p, status: "PLANNED" })), history };
    });
  }

  request(identity: AuthIdentity, input: RequestLoanDto) {
    const forOther = input.employeeId && input.employeeId !== identity.employeeId;
    if (forOther) requireAdmin(identity);
    const employeeId = input.employeeId || identity.employeeId;
    const firstPeriod = input.firstPeriod || nextPeriod();
    if (firstPeriod < todayIst().slice(0, 7)) throw new BadRequestException("Recovery can't start in a past month.");
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const employee = (await client.query(`SELECT id, full_name, manager_id FROM employees WHERE organization_id=$1 AND id=$2 AND status='ACTIVE'`, [org, employeeId])).rows[0];
      if (!employee) throw new NotFoundException("Employee not found.");
      const open = (await client.query(`SELECT count(*)::int AS n FROM employee_loans WHERE organization_id=$1 AND employee_id=$2 AND kind=$3 AND status IN ('REQUESTED','APPROVED')`,
        [org, employeeId, input.kind])).rows[0].n;
      if (open) throw new ConflictException(`There is already a ${input.kind === "ADVANCE" ? "salary advance" : "loan"} request awaiting a decision.`);
      const gross = await this.monthlyGross(client, org, employeeId);
      const outstanding = await this.outstanding(client, org, employeeId);
      const check = validateRequest(input.kind, input.principal, input.tenureMonths, gross, outstanding);
      if (check.errors.length && !forOther) throw new BadRequestException(check.errors.join(" "));
      const plan = schedule(input.principal, input.tenureMonths, firstPeriod);
      const prefix = input.kind === "ADVANCE" ? "ADV" : "LN";
      const seq = (await client.query(
        `SELECT coalesce(max(substring(loan_number from '[0-9]+$')::int),0)+1 AS n FROM employee_loans WHERE organization_id=$1 AND kind=$2`, [org, input.kind])).rows[0].n;
      const row = (await client.query(
        `INSERT INTO employee_loans(organization_id,loan_number,employee_id,kind,purpose,reason,principal,tenure_months,emi,first_period,requested_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [org, `${prefix}-${String(seq).padStart(4, "0")}`, employeeId, input.kind, input.purpose, input.reason.trim(), input.principal, input.tenureMonths, plan.emi, firstPeriod, identity.employeeId])).rows[0];
      await audit(client, identity, "LOAN_REQUESTED", "employee_loan", row.id, null,
        { kind: input.kind, principal: input.principal, tenureMonths: input.tenureMonths, emi: plan.emi, firstPeriod, onBehalf: forOther || undefined, overrides: forOther ? check.errors : undefined });
      // HR/payroll admins decide; the request also shows in their loans queue.
      const approvers = (await client.query(
        `SELECT DISTINCT e.id FROM organization_memberships m JOIN employees e ON e.user_id=m.user_id AND e.organization_id=m.organization_id
          WHERE m.organization_id=$1 AND m.status='ACTIVE' AND m.role IN ('PAYROLL_ADMIN','HR_ADMIN','OWNER') AND e.id<>$2 AND e.status='ACTIVE' LIMIT 20`, [org, employeeId])).rows;
      for (const approver of approvers)
        await notify(client, org, approver.id, "LOAN_REQUESTED", "employee_loan", row.id, { employee: employee.full_name, kind: input.kind, principal: input.principal, link: "/loans" });
      return { ...(await this.getIn(client, identity, row.id)), warnings: [...check.warnings, ...(forOther ? check.errors : [])] };
    });
  }

  decide(identity: AuthIdentity, id: string, input: DecideLoanDto) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const loan = await this.load(client, identity, id, true);
      this.checkVersion(loan, input.version);
      if (loan.status !== "REQUESTED") throw new ConflictException("Only pending requests can be approved or rejected.");
      if (loan.employee_id === identity.employeeId || loan.requested_by === identity.employeeId)
        throw new ForbiddenException("Another administrator must decide on a loan you raised or that is for you.");
      if (input.decision === "reject" && !input.note?.trim()) throw new BadRequestException("Add a note explaining the rejection.");
      const tenure = input.tenureMonths || loan.tenure_months;
      const firstPeriod = input.firstPeriod || loan.first_period;
      const plan = schedule(num(loan.principal), tenure, firstPeriod);
      await client.query(
        `UPDATE employee_loans SET status=$3, decided_by=$4, decided_at=now(), decision_note=$5, tenure_months=$6, first_period=$7, emi=$8, version=version+1, updated_at=now()
          WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, id, input.decision === "approve" ? "APPROVED" : "REJECTED", identity.employeeId, input.note?.trim() || null, tenure, firstPeriod, plan.emi]);
      await audit(client, identity, input.decision === "approve" ? "LOAN_APPROVED" : "LOAN_REJECTED", "employee_loan", id,
        { status: loan.status, tenureMonths: loan.tenure_months, firstPeriod: loan.first_period }, { tenureMonths: tenure, firstPeriod, emi: plan.emi, note: input.note || null });
      await notify(client, identity.organizationId, loan.employee_id, input.decision === "approve" ? "LOAN_APPROVED" : "LOAN_REJECTED", "employee_loan", id,
        { number: loan.loan_number, principal: num(loan.principal), emi: plan.emi, firstPeriod, link: "/loans" });
      return this.getIn(client, identity, id);
    });
  }

  /** Records the payout and creates the EMI schedule; the first DUE month is picked up by that month's payroll run. */
  disburse(identity: AuthIdentity, id: string, input: DisburseLoanDto) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const loan = await this.load(client, identity, id, true);
      this.checkVersion(loan, input.version);
      if (loan.status !== "APPROVED") throw new ConflictException("Only approved loans can be disbursed.");
      if (input.disbursedOn > todayIst()) throw new BadRequestException("The disbursement date can't be in the future.");
      const locked = (await client.query(`SELECT max(period) AS period FROM payroll_runs WHERE organization_id=$1 AND status IN ('SUBMITTED','APPROVED','PUBLISHED','LOCKED')`, [org])).rows[0]?.period;
      let firstPeriod = loan.first_period as string;
      if (locked && firstPeriod <= locked) firstPeriod = addMonths(locked, 1);
      const plan = schedule(num(loan.principal), loan.tenure_months, firstPeriod);
      for (const row of plan.rows)
        await client.query(`INSERT INTO employee_loan_installments(organization_id,loan_id,employee_id,seq,period,amount) VALUES($1,$2,$3,$4,$5,$6)`,
          [org, id, loan.employee_id, row.seq, row.period, row.amount]);
      await client.query(
        `UPDATE employee_loans SET status='ACTIVE', disbursed_on=$3, disbursement_ref=$4, disbursed_by=$5, first_period=$6, emi=$7, version=version+1, updated_at=now()
          WHERE organization_id=$1 AND id=$2`, [org, id, input.disbursedOn, input.reference.trim(), identity.employeeId, firstPeriod, plan.emi]);
      await this.markRunsStale(client, org, firstPeriod);
      await audit(client, identity, "LOAN_DISBURSED", "employee_loan", id, { status: "APPROVED" },
        { status: "ACTIVE", disbursedOn: input.disbursedOn, reference: input.reference.trim(), firstPeriod, installments: plan.rows.length });
      await notify(client, org, loan.employee_id, "LOAN_DISBURSED", "employee_loan", id,
        { number: loan.loan_number, principal: num(loan.principal), emi: plan.emi, firstPeriod, link: "/loans" });
      return this.getIn(client, identity, id);
    });
  }

  /** Skips one month's recovery (e.g. hardship or a low-pay month) and adds an installment at the end. */
  skip(identity: AuthIdentity, id: string, input: SkipInstallmentDto) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const loan = await this.load(client, identity, id, true);
      this.checkVersion(loan, input.version);
      if (loan.status !== "ACTIVE") throw new ConflictException("Only active loans have installments to skip.");
      const row = (await client.query(`SELECT * FROM employee_loan_installments WHERE organization_id=$1 AND loan_id=$2 AND period=$3 AND status='DUE' FOR UPDATE`, [org, id, input.period])).rows[0];
      if (!row) throw new NotFoundException(`No installment is due in ${monthLabel(input.period)}.`);
      await this.assertPeriodOpen(client, org, input.period);
      const last = (await client.query(`SELECT max(seq) AS seq, max(period) AS period FROM employee_loan_installments WHERE organization_id=$1 AND loan_id=$2`, [org, id])).rows[0];
      await client.query(`UPDATE employee_loan_installments SET status='SKIPPED', note=$3, updated_at=now() WHERE organization_id=$1 AND id=$2`, [org, row.id, input.note.trim()]);
      await this.voidInputs(client, org, [row.id], "installment skipped");
      await client.query(`INSERT INTO employee_loan_installments(organization_id,loan_id,employee_id,seq,period,amount,note) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [org, id, loan.employee_id, last.seq + 1, addMonths(last.period, 1), row.amount, `Moved from ${monthLabel(input.period)}`]);
      await client.query(`UPDATE employee_loans SET version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`, [org, id]);
      await this.markRunsStale(client, org, input.period);
      await audit(client, identity, "LOAN_INSTALLMENT_SKIPPED", "employee_loan", id, null, { period: input.period, amount: num(row.amount), note: input.note.trim() });
      await notify(client, org, loan.employee_id, "LOAN_INSTALLMENT_SKIPPED", "employee_loan", id, { number: loan.loan_number, period: input.period, link: "/loans" });
      return this.getIn(client, identity, id);
    });
  }

  /** The employee repaid the balance outside payroll: remaining installments are marked PREPAID and the loan closes. */
  foreclose(identity: AuthIdentity, id: string, input: ForecloseDto) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const loan = await this.load(client, identity, id, true);
      this.checkVersion(loan, input.version);
      if (loan.status !== "ACTIVE") throw new ConflictException("Only active loans can be foreclosed.");
      const due = (await client.query(`SELECT id, period, amount::float FROM employee_loan_installments WHERE organization_id=$1 AND loan_id=$2 AND status='DUE' FOR UPDATE`, [org, id])).rows;
      const inFlight = (await client.query(
        `SELECT r.period FROM payroll_inputs p JOIN payroll_runs r ON r.id=p.run_id AND r.organization_id=p.organization_id
          WHERE p.organization_id=$1 AND p.source='LOAN' AND p.source_ref = ANY($2) AND p.voided_at IS NULL AND r.status IN ('SUBMITTED','APPROVED') LIMIT 1`,
        [org, due.map((row) => row.id)])).rows[0];
      if (inFlight) throw new ConflictException(`The ${monthLabel(inFlight.period)} payroll run already includes this EMI and is awaiting approval — send it back first.`);
      const balance = due.reduce((t, row) => t + row.amount, 0);
      await client.query(`UPDATE employee_loan_installments SET status='PREPAID', note=$3, updated_at=now() WHERE organization_id=$1 AND loan_id=$2 AND status='DUE'`,
        [org, id, `Foreclosed · ${input.reference.trim()}`]);
      await this.voidInputs(client, org, due.map((row) => row.id), "loan foreclosed");
      await client.query(`UPDATE employee_loans SET status='CLOSED', closed_at=now(), closure_note=$3, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [org, id, `Foreclosed · ${input.reference.trim()}${input.note?.trim() ? ` · ${input.note.trim()}` : ""}`]);
      if (due.length) await this.markRunsStale(client, org, due[0].period);
      await audit(client, identity, "LOAN_FORECLOSED", "employee_loan", id, { status: "ACTIVE" }, { status: "CLOSED", balance, reference: input.reference.trim() });
      await notify(client, org, loan.employee_id, "LOAN_CLOSED", "employee_loan", id, { number: loan.loan_number, link: "/loans" });
      return this.getIn(client, identity, id);
    });
  }

  /** The requester withdraws a pending request, or an admin cancels an approved-but-not-disbursed one. */
  cancel(identity: AuthIdentity, id: string, input: CancelLoanDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const loan = await this.load(client, identity, id, true);
      this.checkVersion(loan, input.version);
      const own = loan.employee_id === identity.employeeId || loan.requested_by === identity.employeeId;
      if (!(loan.status === "REQUESTED" && own) && !(["REQUESTED", "APPROVED"].includes(loan.status) && isPayrollAdmin(identity)))
        throw new ConflictException("This loan can no longer be cancelled.");
      await client.query(`UPDATE employee_loans SET status='CANCELLED', version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id]);
      await audit(client, identity, "LOAN_CANCELLED", "employee_loan", id, { status: loan.status }, { status: "CANCELLED" });
      return this.getIn(client, identity, id);
    });
  }

  // ---------------------------------------------------------------- payroll hooks (called from RunsService)

  /** Pull DUE installments for the run's period into it as LOAN_EMI deductions; drop inputs whose installment is no longer due. */
  static async syncIntoRun(client: PoolClient, organizationId: string, runId: string, period: string, actorEmployeeId: string) {
    await client.query(
      `UPDATE payroll_inputs p SET voided_at=now(), note=coalesce(p.note,'')||' [installment no longer due]'
         FROM employee_loan_installments i WHERE p.organization_id=$1 AND p.run_id=$2 AND p.source='LOAN' AND p.voided_at IS NULL
          AND i.organization_id=p.organization_id AND i.id=p.source_ref AND i.status<>'DUE'`, [organizationId, runId]);
    const added = await client.query(
      `INSERT INTO payroll_inputs(organization_id,run_id,employee_id,kind,code,label,amount,taxable,esi_wage,source,source_ref,note,created_by)
       SELECT $1, $2, i.employee_id, 'DEDUCTION', 'LOAN_EMI', left((CASE WHEN l.kind='ADVANCE' THEN 'Salary advance ' ELSE 'Loan EMI ' END) || l.loan_number || ' (' || i.seq || '/' || l.tenure_months || ')', 120),
              i.amount, false, false, 'LOAN', i.id, l.purpose, $4
         FROM employee_loan_installments i JOIN employee_loans l ON l.id=i.loan_id AND l.organization_id=i.organization_id
        WHERE i.organization_id=$1 AND i.period=$3 AND i.status='DUE' AND l.status='ACTIVE' AND i.amount > 0
          AND NOT EXISTS (SELECT 1 FROM payroll_inputs p WHERE p.organization_id=$1 AND p.source='LOAN' AND p.source_ref=i.id AND p.voided_at IS NULL)
       RETURNING id`, [organizationId, runId, period, actorEmployeeId]);
    return added.rowCount || 0;
  }

  /** On publish: installments recovered from paid lines become DEDUCTED; held/excluded lines keep them DUE for the next run. */
  static async markRecovered(client: PoolClient, organizationId: string, runId: string) {
    const recovered = (await client.query(
      `UPDATE employee_loan_installments i SET status='DEDUCTED', run_id=$2, updated_at=now()
         FROM payroll_inputs p JOIN payroll_run_lines rl ON rl.organization_id=p.organization_id AND rl.run_id=p.run_id AND rl.employee_id=p.employee_id
        WHERE p.organization_id=$1 AND p.run_id=$2 AND p.source='LOAN' AND p.voided_at IS NULL AND i.organization_id=p.organization_id AND i.id=p.source_ref
          AND i.status='DUE' AND rl.status='INCLUDED' AND NOT rl.held
       RETURNING i.loan_id`, [organizationId, runId])).rows;
    // Unrecovered installments (held/excluded salary) roll to the end of the schedule so nothing is silently lost.
    const missed = (await client.query(
      `SELECT i.id, i.loan_id, i.employee_id, i.amount FROM employee_loan_installments i JOIN payroll_inputs p ON p.organization_id=i.organization_id AND p.source='LOAN' AND p.source_ref=i.id AND p.voided_at IS NULL
        WHERE i.organization_id=$1 AND p.run_id=$2 AND i.status='DUE'`, [organizationId, runId])).rows;
    for (const row of missed) {
      const last = (await client.query(`SELECT max(seq) AS seq, max(period) AS period FROM employee_loan_installments WHERE organization_id=$1 AND loan_id=$2`, [organizationId, row.loan_id])).rows[0];
      await client.query(`UPDATE employee_loan_installments SET status='SKIPPED', note='Salary held or excluded — moved to the end', updated_at=now() WHERE organization_id=$1 AND id=$2`, [organizationId, row.id]);
      await client.query(`INSERT INTO employee_loan_installments(organization_id,loan_id,employee_id,seq,period,amount,note) VALUES($1,$2,$3,$4,$5,$6,'Carried forward')`,
        [organizationId, row.loan_id, row.employee_id, last.seq + 1, addMonths(last.period, 1), row.amount]);
    }
    const loans = [...new Set(recovered.map((row) => row.loan_id))];
    if (loans.length) await client.query(
      `UPDATE employee_loans l SET status='CLOSED', closed_at=now(), closure_note='Fully recovered through payroll', version=version+1, updated_at=now()
        WHERE l.organization_id=$1 AND l.id = ANY($2) AND l.status='ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM employee_loan_installments i WHERE i.loan_id=l.id AND i.status='DUE')`, [organizationId, loans]);
    return recovered.length;
  }

  // ---------------------------------------------------------------- helpers

  private async getIn(client: PoolClient, identity: AuthIdentity, id: string) {
    const row = await this.load(client, identity, id);
    const installments = (await client.query(
      `SELECT id, seq, period, amount::float, status, note, run_id FROM employee_loan_installments WHERE organization_id=$1 AND loan_id=$2 ORDER BY seq`, [identity.organizationId, id])).rows;
    return { ...this.present(row), installments };
  }

  private async load(client: PoolClient, identity: AuthIdentity, id: string, forUpdate = false) {
    if (forUpdate) await client.query(`SELECT 1 FROM employee_loans WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [identity.organizationId, id]);
    const row = (await client.query(`SELECT ${LOAN_COLUMNS} FROM ${LOAN_FROM} WHERE l.organization_id=$1 AND l.id=$2`, [identity.organizationId, id])).rows[0];
    if (!row || (!isPayrollAdmin(identity) && row.employee_id !== identity.employeeId && row.requested_by !== identity.employeeId)) throw new NotFoundException("Loan not found.");
    return row;
  }

  private present(row: any) {
    const principal = num(row.principal), recovered = num(row.recovered);
    return {
      id: row.id, number: row.loan_number, kind: row.kind, purpose: row.purpose, reason: row.reason, status: row.status,
      employee: { id: row.employee_id, name: row.employee_name, number: row.employee_number, department: row.department },
      principal, tenureMonths: row.tenure_months, emi: num(row.emi), firstPeriod: row.first_period,
      recovered, outstanding: ["ACTIVE"].includes(row.status) ? Math.max(0, Math.round((principal - recovered) * 100) / 100) : 0,
      requestedBy: row.requested_by_name, decidedBy: row.decided_by_name, decidedAt: row.decided_at, decisionNote: row.decision_note,
      disbursedOn: row.disbursed_on, disbursementRef: row.disbursement_ref, closedAt: row.closed_at, closureNote: row.closure_note,
      createdAt: row.created_at, version: row.version,
      perquisite: row.status === "ACTIVE" || row.status === "APPROVED" ? perquisiteFlag(row.purpose, principal) : null,
    };
  }

  private checkVersion(row: { version: number }, version: number) {
    if (row.version !== version) throw new ConflictException("This loan changed since you opened it. Reload and try again.");
  }

  private async monthlyGross(client: PoolClient, organizationId: string, employeeId: string): Promise<number | null> {
    const row = (await client.query(
      `SELECT fixed_monthly_gross::float AS gross FROM salary_structures WHERE organization_id=$1 AND employee_id=$2 AND effective_from <= current_date ORDER BY effective_from DESC LIMIT 1`,
      [organizationId, employeeId])).rows[0];
    return row ? row.gross : null;
  }

  private async outstanding(client: PoolClient, organizationId: string, employeeId: string) {
    return (await client.query(
      `SELECT coalesce(sum(i.amount),0)::float AS n FROM employee_loan_installments i JOIN employee_loans l ON l.id=i.loan_id
        WHERE i.organization_id=$1 AND i.employee_id=$2 AND i.status='DUE' AND l.status='ACTIVE'`, [organizationId, employeeId])).rows[0].n as number;
  }

  private async assertPeriodOpen(client: PoolClient, organizationId: string, period: string) {
    const run = (await client.query(`SELECT status FROM payroll_runs WHERE organization_id=$1 AND period=$2 AND status IN ('SUBMITTED','APPROVED','PUBLISHED','LOCKED') LIMIT 1`,
      [organizationId, period])).rows[0];
    if (run) throw new ConflictException(`The ${monthLabel(period)} payroll run is ${run.status.toLowerCase()} — send it back before changing its loan recoveries.`);
  }

  private async voidInputs(client: PoolClient, organizationId: string, installmentIds: string[], why: string) {
    if (!installmentIds.length) return;
    await client.query(`UPDATE payroll_inputs SET voided_at=now(), note=coalesce(note,'')||$3 WHERE organization_id=$1 AND source='LOAN' AND source_ref = ANY($2) AND voided_at IS NULL`,
      [organizationId, installmentIds, ` [${why}]`]);
  }

  private async markRunsStale(client: PoolClient, organizationId: string, fromPeriod: string) {
    await client.query(`UPDATE payroll_runs SET needs_recalc=true, updated_at=now() WHERE organization_id=$1 AND status='CALCULATED' AND period >= $2`, [organizationId, fromPeriod]);
  }
}

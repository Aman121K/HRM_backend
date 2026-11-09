import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { emailButton, escapeHtml } from "../jobs/email-layout";
import { JobsService } from "../jobs/jobs.service";
import type { CreateLeaveDto, LeaveDecisionDto } from "./leave.dto";

@Injectable()
export class LeaveService {
  constructor(private readonly database: DatabaseService, private readonly jobs: JobsService) {}

  listTypes(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => ({
      // Who this person's leave is routed to (their reporting manager), shown on the apply form.
      approver: (await client.query(
        `SELECT m.id, m.full_name AS name, m.designation FROM employees e JOIN employees m ON m.id=e.manager_id AND m.organization_id=e.organization_id
          WHERE e.organization_id=$1 AND e.id=$2`, [identity.organizationId, identity.employeeId])).rows[0] || null,
      items: (await client.query(
      `SELECT t.id,t.code,t.name,t.annual_quota,t.requires_document_after_days,
              -- switch-over import: imported opening balance (leave_balance_ledger, migration 034) − leave approved after its as-of date; null when none.
              (o.days + coalesce((SELECT sum(a.days) FROM leave_balance_ledger a WHERE a.organization_id=t.organization_id AND a.employee_id=$2 AND a.leave_type_id=t.id AND a.entry_type='ADJUSTMENT'),0)
                 - coalesce((SELECT sum(r.days) FROM leave_requests r WHERE r.organization_id=t.organization_id AND r.employee_id=$2 AND r.leave_type_id=t.id AND r.status='APPROVED' AND r.start_date > o.as_of),0))::float AS balance,
              o.days::float AS opening_balance, to_char(o.as_of,'YYYY-MM-DD') AS balance_as_of
         FROM leave_types t
         LEFT JOIN leave_balance_ledger o ON o.organization_id=t.organization_id AND o.employee_id=$2 AND o.leave_type_id=t.id AND o.entry_type='OPENING'
        WHERE t.organization_id=$1 AND t.active=true ORDER BY t.name`, [identity.organizationId, identity.employeeId])).rows }));
  }

  listMine(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => ({ items: (await client.query(
      `SELECT l.*,to_char(l.start_date,'YYYY-MM-DD') start_date,to_char(l.end_date,'YYYY-MM-DD') end_date,t.name leave_type FROM leave_requests l
         JOIN leave_types t ON t.id=l.leave_type_id AND t.organization_id=l.organization_id
        WHERE l.organization_id=$1 AND l.employee_id=$2 ORDER BY l.submitted_at DESC LIMIT 100`,
      [identity.organizationId, identity.employeeId])).rows }));
  }

  async create(identity: AuthIdentity, input: CreateLeaveDto) {
    if (input.endDate < input.startDate) throw new BadRequestException("End date must be on or after start date.");
    const row = await this.database.tenantTransaction(identity, async (client) => {
      const employee = (await client.query(
        `SELECT manager_id,full_name FROM employees WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
        [identity.organizationId, identity.employeeId])).rows[0];
      if (!employee?.manager_id) throw new ConflictException("A reporting manager must be assigned before leave can be submitted.");
      const leaveType = (await client.query(
        `SELECT id,name FROM leave_types WHERE organization_id=$1 AND id=$2 AND active=true`,
        [identity.organizationId, input.leaveTypeId])).rows[0];
      if (!leaveType) throw new BadRequestException("The selected leave type is not available for this organization.");
      const span = Math.round((Date.parse(input.endDate) - Date.parse(input.startDate)) / 86_400_000) + 1;
      if (input.days > span) throw new BadRequestException(`${input.days} day(s) don't fit between ${input.startDate} and ${input.endDate}.`);
      // Balance check: imported opening balance (switch-over) when there is one, otherwise the annual quota for the year.
      // Pending requests count as already used, so two requests can't both spend the same days. Loss of pay is never capped.
      const available = (await client.query(
        `SELECT t.code, t.name,
                CASE WHEN o.id IS NOT NULL THEN
                  o.days + coalesce((SELECT sum(a.days) FROM leave_balance_ledger a WHERE a.organization_id=t.organization_id AND a.employee_id=$2 AND a.leave_type_id=t.id AND a.entry_type='ADJUSTMENT'),0)
                    - coalesce((SELECT sum(r.days) FROM leave_requests r WHERE r.organization_id=t.organization_id AND r.employee_id=$2 AND r.leave_type_id=t.id AND r.status IN ('APPROVED','PENDING') AND r.start_date > o.as_of),0)
                ELSE t.annual_quota
                    - coalesce((SELECT sum(r.days) FROM leave_requests r WHERE r.organization_id=t.organization_id AND r.employee_id=$2 AND r.leave_type_id=t.id AND r.status IN ('APPROVED','PENDING')
                                  AND date_trunc('year', r.start_date) = date_trunc('year', $4::date)),0)
                END::float AS available
           FROM leave_types t
           LEFT JOIN leave_balance_ledger o ON o.organization_id=t.organization_id AND o.employee_id=$2 AND o.leave_type_id=t.id AND o.entry_type='OPENING'
          WHERE t.organization_id=$1 AND t.id=$3`, [identity.organizationId, identity.employeeId, input.leaveTypeId, input.startDate])).rows[0];
      const unpaid = /LOP|UNPAID/i.test(available.code) || /loss of pay|unpaid/i.test(available.name);
      if (!unpaid && available.available !== null && input.days > available.available)
        throw new BadRequestException(`Only ${Math.max(0, available.available)} day(s) of ${leaveType.name} left (pending requests included). Apply for fewer days or use Loss of Pay.`);
      const overlap = await client.query(
        `SELECT 1 FROM leave_requests WHERE organization_id=$1 AND employee_id=$2
          AND status IN ('PENDING','APPROVED') AND daterange(start_date,end_date,'[]') && daterange($3::date,$4::date,'[]')`,
        [identity.organizationId, identity.employeeId, input.startDate, input.endDate]);
      if (overlap.rowCount) throw new ConflictException("This leave overlaps an existing request.");
      const created = (await client.query(
        `INSERT INTO leave_requests(organization_id,employee_id,approver_id,leave_type_id,start_date,end_date,days,reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [identity.organizationId, identity.employeeId, employee.manager_id, input.leaveTypeId, input.startDate, input.endDate, input.days, input.reason])).rows[0];
      const manager = (await client.query(`SELECT work_email FROM employees WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, employee.manager_id])).rows[0];
      await client.query(
        `INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload)
         VALUES($1,$2,'LEAVE_SUBMITTED','leave',$3,$4)`,
        [identity.organizationId, employee.manager_id, created.id, JSON.stringify({ ...created, employeeName: employee.full_name, leaveType: leaveType.name })]);
      await client.query(`INSERT INTO email_outbox(organization_id,recipient,subject,html) VALUES($1,$2,$3,$4)`,
        [identity.organizationId, manager.work_email, "New leave request",
          `<p>${escapeHtml(employee.full_name)} submitted ${escapeHtml(input.days)} day(s) of ${escapeHtml(leaveType.name)} (${escapeHtml(input.startDate)} – ${escapeHtml(input.endDate)}).</p>` +
          (input.reason ? `<p>Reason: ${escapeHtml(String(input.reason).slice(0, 500))}</p>` : "") + emailButton("Review request", "/approvals")]);
      await client.query(
        `INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data)
         VALUES($1,$2,'LEAVE_SUBMITTED','leave',$3,$4)`,
        [identity.organizationId, identity.userId, created.id, JSON.stringify(created)]);
      return created;
    });
    await this.jobs.enqueue("outbox.dispatch", { organizationId: identity.organizationId, entityType: "leave", entityId: row.id });
    return row;
  }

  async withdraw(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const result = await client.query(
        `UPDATE leave_requests SET status='WITHDRAWN',updated_at=now(),version=version+1
          WHERE organization_id=$1 AND id=$2 AND employee_id=$3 AND status='PENDING' RETURNING *`,
        [identity.organizationId, id, identity.employeeId]);
      if (!result.rowCount) throw new ConflictException("Only your pending leave request can be withdrawn.");
      const row = result.rows[0];
      await client.query(`INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload)
        VALUES($1,$2,'LEAVE_WITHDRAWN','leave',$3,$4)`, [identity.organizationId, row.approver_id, row.id, JSON.stringify(row)]);
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data)
        VALUES($1,$2,'LEAVE_WITHDRAWN','leave',$3,$4)`, [identity.organizationId, identity.userId, row.id, JSON.stringify(row)]);
      return row;
    });
  }

  /** HR admins and owners see and can decide every pending leave in the brand (e.g. when a manager is away), never their own. */
  private isHr(identity: AuthIdentity) { return identity.roles.some((role) => role === "HR_ADMIN" || role === "OWNER"); }

  approvalQueue(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => ({ items: (await client.query(
      `SELECT l.id,'LEAVE' type,l.status,l.submitted_at,e.full_name employee,t.name title,
              concat(l.days,' day(s) · ',to_char(l.start_date,'YYYY-MM-DD'),' to ',to_char(l.end_date,'YYYY-MM-DD'),' · ',l.reason) detail
         FROM leave_requests l JOIN employees e ON e.id=l.employee_id AND e.organization_id=l.organization_id
         JOIN leave_types t ON t.id=l.leave_type_id AND t.organization_id=l.organization_id
        WHERE l.organization_id=$1 AND l.status='PENDING'
          AND (l.approver_id=$2 OR ($3 AND l.employee_id IS DISTINCT FROM $2)) ORDER BY l.submitted_at`,
      [identity.organizationId, identity.employeeId, this.isHr(identity)])).rows }));
  }

  async decide(identity: AuthIdentity, id: string, input: LeaveDecisionDto) {
    if (input.decision === "REJECTED" && !input.note?.trim()) throw new BadRequestException("A decision note is required when rejecting leave.");
    const row = await this.database.tenantTransaction(identity, async (client) => {
      const result = await client.query(
        `UPDATE leave_requests SET status=$1,decision_note=$2,decided_at=now(),updated_at=now(),version=version+1
          WHERE organization_id=$3 AND id=$4 AND status='PENDING'
            AND (approver_id=$5 OR ($6 AND employee_id IS DISTINCT FROM $5)) RETURNING *`,
        [input.decision, input.note?.trim() || null, identity.organizationId, id, identity.employeeId, this.isHr(identity)]);
      if (!result.rowCount) throw new NotFoundException("Pending approval was not found or was already decided.");
      const decided = result.rows[0];
      const employee = (await client.query(`SELECT work_email,full_name FROM employees WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, decided.employee_id])).rows[0];
      await client.query(`INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload)
        VALUES($1,$2,$3,'leave',$4,$5)`, [identity.organizationId, decided.employee_id, `LEAVE_${input.decision}`, decided.id, JSON.stringify(decided)]);
      await client.query(`INSERT INTO email_outbox(organization_id,recipient,subject,html) VALUES($1,$2,$3,$4)`,
        [identity.organizationId, employee.work_email, `Leave ${input.decision.toLowerCase()}`, `<p>Your leave request was ${input.decision.toLowerCase()}.</p>`]);
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data)
        VALUES($1,$2,$3,'leave',$4,$5)`, [identity.organizationId, identity.userId, input.decision, decided.id, JSON.stringify(decided)]);
      return decided;
    });
    await this.jobs.enqueue("outbox.dispatch", { organizationId: identity.organizationId, entityType: "leave", entityId: row.id });
    return row;
  }

  /**
   * One leave request in full: who applied, who it was routed to, the decision, the balance it draws on and an audited
   * timeline. Visible to the employee, the assigned approver, and HR / owners of the brand.
   */
  async detail(identity: AuthIdentity, id: string) {
    const row = await this.database.tenantTransaction(identity, async (client) => (await client.query(
      `SELECT l.id, l.status, l.days::float AS days, l.reason, l.decision_note AS "decisionNote",
              to_char(l.start_date,'YYYY-MM-DD') AS "startDate", to_char(l.end_date,'YYYY-MM-DD') AS "endDate",
              l.submitted_at AS "submittedAt", l.decided_at AS "decidedAt", l.employee_id AS "employeeId", l.approver_id AS "approverId",
              t.id AS "leaveTypeId", t.code AS "leaveTypeCode", t.name AS "leaveType",
              e.full_name AS "employeeName", e.employee_number AS "employeeNumber", e.department, e.designation,
              a.full_name AS "approverName", a.employee_number AS "approverNumber"
         FROM leave_requests l
         JOIN leave_types t ON t.id=l.leave_type_id AND t.organization_id=l.organization_id
         JOIN employees e ON e.id=l.employee_id AND e.organization_id=l.organization_id
         LEFT JOIN employees a ON a.id=l.approver_id AND a.organization_id=l.organization_id
        WHERE l.organization_id=$1 AND l.id=$2`, [identity.organizationId, id])).rows[0]);
    if (!row || !(row.employeeId === identity.employeeId || row.approverId === identity.employeeId || this.isHr(identity)))
      throw new NotFoundException("Leave request not found.");
    const balance = (await this.listTypesFor(identity, row.employeeId)).find((t: { id: string }) => t.id === row.leaveTypeId) || null;
    const timeline = (await this.database.systemQuery(
      `SELECT a.action, a.created_at AS at, coalesce(e.full_name, u.full_name, u.email) AS actor, a.after_data->>'decision_note' AS note
         FROM audit_log a LEFT JOIN users u ON u.id=a.actor_user_id
         LEFT JOIN employees e ON e.user_id=a.actor_user_id AND e.organization_id=a.organization_id
        WHERE a.organization_id=$1 AND a.entity_type='leave' AND a.entity_id=$2 ORDER BY a.created_at, a.id`, [identity.organizationId, id])).rows;
    const { employeeId: _e, approverId: _a, ...leave } = row;
    return { ...leave, balance, timeline };
  }

  /** HR / owner register: every leave request in the brand (filterable) plus each active employee's paid-leave balances. */
  async register(identity: AuthIdentity, filters: { status?: string; month?: string; employeeId?: string }) {
    const status = filters.status && ["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"].includes(filters.status) ? filters.status : null;
    const month = /^\d{4}-\d{2}$/.test(filters.month || "") ? `${filters.month}-01` : null;
    const employee = /^[0-9a-f-]{36}$/i.test(filters.employeeId || "") ? filters.employeeId! : null;
    return this.database.tenantTransaction(identity, async (client) => {
      const requests = (await client.query(
        `SELECT l.id, l.status, l.days::float AS days, l.reason, l.decision_note AS "decisionNote",
                to_char(l.start_date,'YYYY-MM-DD') AS "startDate", to_char(l.end_date,'YYYY-MM-DD') AS "endDate",
                l.submitted_at AS "submittedAt", l.decided_at AS "decidedAt", t.code AS "leaveTypeCode", t.name AS "leaveType",
                e.id AS "employeeId", e.full_name AS "employeeName", e.employee_number AS "employeeNumber", e.department,
                a.full_name AS "approverName"
           FROM leave_requests l
           JOIN leave_types t ON t.id=l.leave_type_id AND t.organization_id=l.organization_id
           JOIN employees e ON e.id=l.employee_id AND e.organization_id=l.organization_id
           LEFT JOIN employees a ON a.id=l.approver_id AND a.organization_id=l.organization_id
          WHERE l.organization_id=$1 AND ($2::text IS NULL OR l.status=$2)
            AND ($3::date IS NULL OR daterange(l.start_date,l.end_date,'[]') && daterange($3::date,($3::date + interval '1 month')::date,'[)'))
            AND ($4::uuid IS NULL OR l.employee_id=$4)
          ORDER BY l.submitted_at DESC LIMIT 500`, [identity.organizationId, status, month, employee])).rows;
      const balances = (await client.query(
        `SELECT e.id AS "employeeId", e.full_name AS "employeeName", e.employee_number AS "employeeNumber", e.department, m.full_name AS "managerName",
                t.code, (o.days + coalesce((SELECT sum(x.days) FROM leave_balance_ledger x WHERE x.organization_id=t.organization_id AND x.employee_id=e.id AND x.leave_type_id=t.id AND x.entry_type='ADJUSTMENT'),0)
                   - coalesce((SELECT sum(r.days) FROM leave_requests r WHERE r.organization_id=t.organization_id AND r.employee_id=e.id AND r.leave_type_id=t.id AND r.status='APPROVED' AND r.start_date > o.as_of),0))::float AS balance,
                coalesce((SELECT sum(r.days) FROM leave_requests r WHERE r.organization_id=t.organization_id AND r.employee_id=e.id AND r.leave_type_id=t.id AND r.status='PENDING'),0)::float AS pending
           FROM employees e
           LEFT JOIN employees m ON m.id=e.manager_id AND m.organization_id=e.organization_id
           JOIN leave_types t ON t.organization_id=e.organization_id AND t.code IN ('CL','SL','EL')
           LEFT JOIN leave_balance_ledger o ON o.organization_id=t.organization_id AND o.employee_id=e.id AND o.leave_type_id=t.id AND o.entry_type='OPENING'
          WHERE e.organization_id=$1 AND e.status='ACTIVE' ORDER BY e.employee_number, t.code`, [identity.organizationId])).rows;
      const people = new Map<string, Record<string, unknown>>();
      for (const b of balances) {
        const p = people.get(b.employeeId) || { employeeId: b.employeeId, employeeName: b.employeeName, employeeNumber: b.employeeNumber, department: b.department, managerName: b.managerName, balances: {} };
        (p.balances as Record<string, unknown>)[b.code] = { balance: b.balance, pending: b.pending };
        people.set(b.employeeId, p);
      }
      const summary = { total: requests.length, pending: 0, approved: 0, rejected: 0, withdrawn: 0, approvedDays: 0 };
      for (const r of requests) { const k = r.status.toLowerCase() as "pending"; summary[k] = (summary[k] || 0) + 1; if (r.status === "APPROVED") summary.approvedDays += r.days; }
      return { requests, employees: [...people.values()], summary };
    });
  }

  /** listTypes for any employee of the brand (detail view for HR / approver). */
  private async listTypesFor(identity: AuthIdentity, employeeId: string) {
    return (await this.listTypes({ ...identity, employeeId } as AuthIdentity)).items;
  }
}

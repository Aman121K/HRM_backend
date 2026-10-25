import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { JobsService } from "../jobs/jobs.service";
import { FilesService } from "../files/files.service";
import { OrganizationsService } from "../organizations/organizations.service";
import { CASE_MODULES, caseModuleEnabled } from "../organizations/module.guard";
import { caseModuleMap, caseModules, type CaseActor, type CaseColumn, type CaseModule, type FieldDef } from "./case-modules";
import type { CaseCommentDto, CaseTransitionDto, CreateCaseDto, ListCasesQuery } from "./cases.dto";

type CaseRow = Record<string, any>;
const HR_ROLES = ["HR_ADMIN", "OWNER"];
const MANAGER_ROUTED = caseModules.filter((module) => module.routing === "manager").map((module) => module.key);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const columnSql: Record<CaseColumn, string> = {
  title: "title", category: "category", priority: "priority", amount: "amount",
  startDate: "start_date", endDate: "end_date", subjectEmployeeId: "subject_employee_id",
};

const SELECT_CASE = `
  SELECT c.*, to_char(c.start_date,'YYYY-MM-DD') AS start_date, to_char(c.end_date,'YYYY-MM-DD') AS end_date,
         r.full_name AS requester_name, r.employee_number AS requester_number, r.department AS requester_department,
         r.designation AS requester_designation, r.manager_id AS requester_manager_id,
         s.full_name AS subject_name, s.designation AS subject_designation,
         a.full_name AS approver_name, g.full_name AS assignee_name
    FROM hr_cases c
    JOIN employees r ON r.id=c.requester_id AND r.organization_id=c.organization_id
    LEFT JOIN employees s ON s.id=c.subject_employee_id AND s.organization_id=c.organization_id
    LEFT JOIN employees a ON a.id=c.approver_id AND a.organization_id=c.organization_id
    LEFT JOIN employees g ON g.id=c.assignee_id AND g.organization_id=c.organization_id`;

@Injectable()
export class CasesService implements OnModuleInit {
  constructor(private readonly database: DatabaseService, private readonly jobs: JobsService, private readonly files: FilesService,
    private readonly orgs: OrganizationsService) {}

  onModuleInit() {
    // Anyone who can see a case can read its attachments; people working on an open case can add them.
    this.files.registerPolicy("hr_case", async (identity, id, client) => {
      const row = await this.load(client, identity, id).catch(() => null);
      if (!row) return null;
      const participant = [row.requester_id, row.approver_id, row.assignee_id].includes(identity.employeeId) || this.isHr(identity);
      return participant && !row.closed_at ? "write" : "read";
    });
  }

  definitions(identity: AuthIdentity) {
    return { items: caseModules, viewer: { employeeId: identity.employeeId, roles: identity.roles, isHr: this.isHr(identity) } };
  }

  async list(identity: AuthIdentity, query: ListCasesQuery) {
    const scope = query.scope || "mine";
    const module = query.module ? this.module(query.module) : undefined;
    if (module) await this.assertModuleEnabled(identity, module.key);
    const enabled = await this.enabledModules(identity);
    if (scope === "all" && !this.isHr(identity) && module?.visibility !== "public")
      throw new ForbiddenException("Only HR can view every request in this module.");
    return this.database.tenantTransaction(identity, async (client) => {
      const values: unknown[] = [identity.organizationId];
      const param = (value: unknown) => { values.push(value); return `$${values.length}`; };
      const where = ["c.organization_id=$1"];
      if (module) where.push(`c.module=${param(module.key)}`);
      else where.push(`c.module = ANY(${param(enabled)})`);
      if (scope === "mine") { const me = param(identity.employeeId); where.push(`(c.requester_id=${me} OR c.subject_employee_id=${me})`); }
      // Managers see their reports' requests only in modules they approve; HR-routed cases (helpdesk, letters) stay private.
      if (scope === "team") { const me = param(identity.employeeId); where.push(`(c.approver_id=${me} OR c.assignee_id=${me} OR (r.manager_id=${me} AND c.module = ANY(${param(MANAGER_ROUTED)})))`); }
      if (scope === "all" && module?.visibility === "public" && !this.isHr(identity))
        where.push(`(c.status = ANY(${param(module.publicStatuses || [])}) OR c.requester_id=${param(identity.employeeId)})`);
      const whereParams = values.length;
      const filterWhere = [...where];
      if (query.status) filterWhere.push(`c.status=${param(query.status)}`);
      if (query.search?.trim()) {
        const term = param(query.search.trim());
        filterWhere.push(`(c.title ILIKE '%'||${term}||'%' OR c.case_number ILIKE '%'||${term}||'%' OR r.full_name ILIKE '%'||${term}||'%')`);
      }
      const limit = Math.min(query.limit || 100, 200);
      const rows = (await client.query(`${SELECT_CASE} WHERE ${filterWhere.join(" AND ")} ORDER BY c.created_at DESC, c.id DESC LIMIT ${limit}`, values)).rows;
      const counts = (await client.query(
        `SELECT c.status, count(*)::int AS count, coalesce(sum(c.amount),0)::float AS amount FROM hr_cases c
           JOIN employees r ON r.id=c.requester_id AND r.organization_id=c.organization_id
          WHERE ${where.join(" AND ")} GROUP BY c.status`, values.slice(0, whereParams))).rows;
      if (module?.visibility === "public" && !this.isHr(identity)) for (const row of counts) row.amount = 0;
      return { items: rows.map((row) => this.present(identity, row)), counts, scope };
    });
  }

  /** Everything waiting on the current user across all case modules. */
  async inbox(identity: AuthIdentity) {
    const enabled = await this.enabledModules(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const rows = (await client.query(
        `${SELECT_CASE} WHERE c.organization_id=$1 AND c.closed_at IS NULL AND c.module = ANY($4)
            AND ($3 OR c.approver_id=$2 OR c.assignee_id=$2 OR c.requester_id=$2)
          ORDER BY c.due_at NULLS LAST, c.created_at LIMIT 500`,
        [identity.organizationId, identity.employeeId, this.isHr(identity), enabled])).rows;
      const items = rows.map((row) => this.present(identity, row)).filter((item) => item.actions.some((action) => !action.optional));
      const byModule: Record<string, number> = {};
      for (const item of items) byModule[item.module] = (byModule[item.module] || 0) + 1;
      return { items, byModule, total: items.length };
    });
  }

  async summary(identity: AuthIdentity) {
    const enabled = await this.enabledModules(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const mine = (await client.query(
        `SELECT module, count(*) FILTER (WHERE closed_at IS NULL)::int AS open, count(*)::int AS total
           FROM hr_cases WHERE organization_id=$1 AND requester_id=$2 AND module = ANY($3) GROUP BY module`,
        [identity.organizationId, identity.employeeId, enabled])).rows;
      const recognition = enabled.includes("recognition") ? (await client.query(
        `${SELECT_CASE} WHERE c.organization_id=$1 AND c.module='recognition' AND c.status='PUBLISHED' ORDER BY c.created_at DESC LIMIT 6`,
        [identity.organizationId])).rows.map((row) => this.present(identity, row)) : [];
      const openings = enabled.includes("requisitions") ? (await client.query(
        `${SELECT_CASE} WHERE c.organization_id=$1 AND c.module='requisitions' AND c.status='OPEN' ORDER BY c.created_at DESC LIMIT 5`,
        [identity.organizationId])).rows.map((row) => this.present(identity, row)) : [];
      return { mine, recognition, openings };
    });
  }

  get(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = await this.load(client, identity, id);
      const events = (await client.query(
        `SELECT ev.id, ev.kind, ev.action, ev.from_status AS "fromStatus", ev.to_status AS "toStatus", ev.note, ev.data,
                ev.created_at AS "createdAt", e.full_name AS "actorName", e.designation AS "actorDesignation"
           FROM hr_case_events ev JOIN employees e ON e.id=ev.actor_id AND e.organization_id=ev.organization_id
          WHERE ev.organization_id=$1 AND ev.case_id=$2 ORDER BY ev.id`, [identity.organizationId, id])).rows;
      const attachments = await this.files.count(client, identity, "hr_case", id);
      return { ...this.present(identity, row), events, attachments };
    });
  }

  async create(identity: AuthIdentity, input: CreateCaseDto) {
    const module = this.module(input.module);
    await this.assertModuleEnabled(identity, module.key);
    if (module.createRoles && !module.createRoles.some((role) => identity.roles.includes(role)))
      throw new ForbiddenException(`Your role cannot create a ${module.singular}.`);
    const created = await this.database.tenantTransaction(identity, async (client) => {
      const me = (await client.query(`SELECT id, full_name, manager_id, work_email FROM employees WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, identity.employeeId])).rows[0];
      if (!me) throw new NotFoundException("Your employee profile was not found.");
      const { columns, details } = await this.parseValues(client, identity, module.fields, input.values, true);
      if (columns.subjectEmployeeId === identity.employeeId)
        throw new BadRequestException(module.key === "recognition" ? "Recognise a colleague rather than yourself." : "Choose a colleague other than yourself.");
      if (columns.startDate && columns.endDate && String(columns.endDate) < String(columns.startDate))
        throw new BadRequestException("The end date must be on or after the start date.");
      if (module.singleOpen) {
        const open = await client.query(`SELECT case_number FROM hr_cases WHERE organization_id=$1 AND module=$2 AND requester_id=$3 AND closed_at IS NULL LIMIT 1`,
          [identity.organizationId, module.key, identity.employeeId]);
        if (open.rowCount) throw new ConflictException(`You already have an open ${module.singular} (${open.rows[0].case_number}).`);
      }
      const limit = module.limits && columns.category ? module.limits[String(columns.category)] : undefined;
      if (limit !== undefined && Number(columns.amount) > limit) details.policyFlag = `Exceeds the ₹${limit.toLocaleString("en-IN")} ${columns.category} limit`;
      const approverId = module.routing === "manager" ? me.manager_id || null : null;
      const priority = String(columns.priority || "MEDIUM");
      const dueAt = module.slaHours ? new Date(Date.now() + module.slaHours[priority as keyof typeof module.slaHours] * 3_600_000) : null;
      const sequence = (await client.query(
        `INSERT INTO hr_case_counters(organization_id,module,next_value) VALUES($1,$2,2)
         ON CONFLICT (organization_id,module) DO UPDATE SET next_value=hr_case_counters.next_value+1 RETURNING next_value-1 AS n`,
        [identity.organizationId, module.key])).rows[0].n;
      const caseNumber = `${module.prefix}-${String(sequence).padStart(4, "0")}`;
      const row = (await client.query(
        `INSERT INTO hr_cases(organization_id,module,case_number,title,category,requester_id,subject_employee_id,approver_id,status,priority,amount,start_date,end_date,due_at,details,closed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [identity.organizationId, module.key, caseNumber, columns.title, columns.category ?? null, identity.employeeId, columns.subjectEmployeeId ?? null,
          approverId, module.initial, priority, columns.amount ?? null, columns.startDate ?? null, columns.endDate ?? null, dueAt,
          JSON.stringify(details), this.status(module, module.initial).terminal ? new Date() : null])).rows[0];
      await client.query(`INSERT INTO hr_case_events(organization_id,case_id,actor_id,kind,to_status,data) VALUES($1,$2,$3,'CREATED',$4,$5)`,
        [identity.organizationId, row.id, identity.employeeId, module.initial, JSON.stringify({ values: input.values })]);
      const notify = approverId || (columns.subjectEmployeeId as string | undefined);
      if (notify) await this.notify(client, identity, notify, `${module.key.toUpperCase()}_CREATED`, row.id, {
        module: module.key, caseNumber, title: columns.title, by: me.full_name,
        message: module.key === "recognition" ? `${me.full_name} recognised you` : `${me.full_name} submitted a ${module.singular}`,
      });
      if (approverId) {
        const approver = (await client.query(`SELECT work_email FROM employees WHERE organization_id=$1 AND id=$2`, [identity.organizationId, approverId])).rows[0];
        if (approver) await client.query(`INSERT INTO email_outbox(organization_id,recipient,subject,html) VALUES($1,$2,$3,$4)`,
          [identity.organizationId, approver.work_email, `${caseNumber}: new ${module.singular} to review`, `<p>${escapeHtml(me.full_name)} submitted “${escapeHtml(String(columns.title))}”.</p>`]);
      }
      await this.audit(client, identity, `${module.key.toUpperCase()}_CREATED`, row.id, { caseNumber, values: input.values });
      return this.present(identity, await this.load(client, identity, row.id));
    });
    await this.jobs.enqueue("outbox.dispatch", { organizationId: identity.organizationId, entityType: "hr_case", entityId: created.id });
    return created;
  }

  transition(identity: AuthIdentity, id: string, input: CaseTransitionDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = await this.load(client, identity, id, true);
      const module = this.module(row.module);
      if (row.version !== input.version) throw new ConflictException("This request changed since you opened it. Refresh and try again.");
      const transition = module.transitions.find((candidate) => candidate.action === input.action);
      if (!transition || !transition.from.includes(row.status))
        throw new ConflictException(`“${input.action}” is not available while the ${module.singular} is ${this.status(module, row.status).label.toLowerCase()}.`);
      const actors = this.actors(identity, row);
      if (!transition.by.some((actor) => actors.has(actor))) throw new ForbiddenException("You are not allowed to take this action.");
      const note = input.note?.trim() || null;
      if (transition.noteRequired && !note) throw new BadRequestException("Please add a note explaining this action.");
      const { columns, details } = await this.parseValues(client, identity, transition.fields || [], input.values || {}, true);
      const sets = ["status=$3", "version=version+1", "updated_at=now()", "details=details || $4::jsonb"];
      const values: unknown[] = [identity.organizationId, id, transition.to, JSON.stringify(details)];
      for (const [column, value] of Object.entries(columns)) { values.push(value); sets.push(`${columnSql[column as CaseColumn]}=$${values.length}`); }
      if (transition.assignSelf) { values.push(identity.employeeId); sets.push(`assignee_id=$${values.length}`); }
      sets.push(this.status(module, transition.to).terminal ? "closed_at=now()" : "closed_at=NULL");
      await client.query(`UPDATE hr_cases SET ${sets.join(",")} WHERE organization_id=$1 AND id=$2`, values);
      await client.query(`INSERT INTO hr_case_events(organization_id,case_id,actor_id,kind,action,from_status,to_status,note,data) VALUES($1,$2,$3,'TRANSITION',$4,$5,$6,$7,$8)`,
        [identity.organizationId, id, identity.employeeId, transition.action, row.status, transition.to, note, JSON.stringify(input.values || {})]);
      const recipients = new Set([row.requester_id, row.approver_id, row.assignee_id].filter((value) => value && value !== identity.employeeId));
      for (const recipient of recipients) await this.notify(client, identity, recipient, `${module.key.toUpperCase()}_${transition.to}`, id, {
        module: module.key, caseNumber: row.case_number, title: row.title, message: `${row.case_number} · ${this.status(module, transition.to).label}`,
      });
      await this.audit(client, identity, `${module.key.toUpperCase()}_${transition.action.toUpperCase()}`, id, { from: row.status, to: transition.to, note, values: input.values });
      return this.present(identity, await this.load(client, identity, id));
    });
  }

  comment(identity: AuthIdentity, id: string, input: CaseCommentDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = await this.load(client, identity, id);
      const event = (await client.query(
        `INSERT INTO hr_case_events(organization_id,case_id,actor_id,kind,note) VALUES($1,$2,$3,'COMMENT',$4) RETURNING id, created_at AS "createdAt"`,
        [identity.organizationId, id, identity.employeeId, input.note.trim()])).rows[0];
      const recipients = new Set([row.requester_id, row.approver_id, row.assignee_id, row.subject_employee_id].filter((value) => value && value !== identity.employeeId));
      for (const recipient of recipients) await this.notify(client, identity, recipient, "CASE_COMMENT", id, {
        module: row.module, caseNumber: row.case_number, title: row.title, message: `New comment on ${row.case_number}`,
      });
      return event;
    });
  }

  // ---- helpers ---------------------------------------------------------------------------------

  /** Case-engine module keys usable by the identity's organization (its enabled organization modules). */
  private async enabledModules(identity: AuthIdentity): Promise<string[]> {
    const state = await this.orgs.moduleState(identity.organizationId);
    return caseModules.map((module) => module.key).filter((key) => caseModuleEnabled(key, state.modules));
  }

  private async assertModuleEnabled(identity: AuthIdentity, caseModule: string) {
    const state = await this.orgs.moduleState(identity.organizationId);
    if (!caseModuleEnabled(caseModule, state.modules))
      throw new ForbiddenException({ message: `The ${CASE_MODULES[caseModule]} module isn't enabled for this organization.`, code: "MODULE_DISABLED" });
  }

  private isHr(identity: AuthIdentity) { return identity.roles.some((role) => HR_ROLES.includes(role)); }

  private module(key: string): CaseModule {
    const module = caseModuleMap.get(key);
    if (!module) throw new NotFoundException("Unknown module.");
    return module;
  }

  private status(module: CaseModule, key: string) {
    return module.statuses.find((status) => status.key === key) || { key, label: key, tone: "neutral" as const, terminal: false };
  }

  /** Which workflow roles the viewer holds on this case. Requesters never approve or settle their own case. */
  private actors(identity: AuthIdentity, row: CaseRow) {
    const actors = new Set<CaseActor>();
    const own = row.requester_id === identity.employeeId;
    if (own) actors.add("requester");
    if (!own && (row.approver_id === identity.employeeId || this.isHr(identity))) actors.add("approver");
    if (row.assignee_id === identity.employeeId) actors.add("assignee");
    if (!own && this.isHr(identity)) actors.add("hr");
    return actors;
  }

  private canView(identity: AuthIdentity, row: CaseRow) {
    const module = this.module(row.module);
    const me = identity.employeeId;
    if (this.isHr(identity)) return true;
    if ([row.requester_id, row.subject_employee_id, row.approver_id, row.assignee_id].includes(me)) return true;
    if (module.routing === "manager" && row.requester_manager_id === me) return true;
    return module.visibility === "public" && (module.publicStatuses || []).includes(row.status);
  }

  private async load(client: PoolClient, identity: AuthIdentity, id: string, lock = false) {
    if (!UUID.test(id)) throw new NotFoundException("Request not found.");
    const result = await client.query(`${SELECT_CASE} WHERE c.organization_id=$1 AND c.id=$2${lock ? " FOR UPDATE OF c" : ""}`, [identity.organizationId, id]);
    const row = result.rows[0];
    if (!row || !this.canView(identity, row)) throw new NotFoundException("Request not found.");
    // Routes addressed by id carry no module in the query/body, so ModuleGuard can't see it: enforce the case's own module.
    await this.assertModuleEnabled(identity, row.module);
    return row;
  }

  private present(identity: AuthIdentity, row: CaseRow) {
    const module = this.module(row.module);
    const actors = this.actors(identity, row);
    const actions = module.transitions
      .filter((transition) => transition.from.includes(row.status) && transition.by.some((actor) => actors.has(actor)))
      .map(({ action, label, noteRequired, fields, intent, optional }) => ({ action, label, noteRequired: !!noteRequired, fields: fields || [], intent: intent || "neutral", optional: !!optional }));
    const status = this.status(module, row.status);
    // Budgets on public job postings are visible only to HR and the hiring manager who raised them.
    const hideAmount = module.visibility === "public" && module.key === "requisitions" && !this.isHr(identity) && row.requester_id !== identity.employeeId;
    return {
      id: row.id, module: row.module, caseNumber: row.case_number, title: row.title, category: row.category,
      status: row.status, statusLabel: status.label, tone: status.tone, terminal: !!status.terminal,
      priority: row.priority, amount: row.amount === null || hideAmount ? null : Number(row.amount), currency: row.currency,
      startDate: row.start_date, endDate: row.end_date, dueAt: row.due_at, details: row.details || {}, version: row.version,
      createdAt: row.created_at, updatedAt: row.updated_at, closedAt: row.closed_at,
      // The SLA clock stops once a case reaches a successful or terminal status (e.g. helpdesk "Resolved").
      overdue: !!row.due_at && !row.closed_at && status.tone !== "success" && new Date(row.due_at).getTime() < Date.now(),
      slaStopped: !!status.terminal || status.tone === "success",
      requester: { id: row.requester_id, name: row.requester_name, number: row.requester_number, department: row.requester_department, designation: row.requester_designation },
      subject: row.subject_employee_id ? { id: row.subject_employee_id, name: row.subject_name, designation: row.subject_designation } : null,
      approver: row.approver_id ? { id: row.approver_id, name: row.approver_name } : null,
      assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name } : null,
      relation: row.requester_id === identity.employeeId ? "mine" : row.subject_employee_id === identity.employeeId ? "about-me" : "other",
      actions,
    };
  }

  private async parseValues(client: PoolClient, identity: AuthIdentity, fields: FieldDef[], raw: Record<string, unknown>, enforceRequired: boolean) {
    const columns: Partial<Record<CaseColumn, unknown>> = {};
    const details: Record<string, unknown> = {};
    const errors: string[] = [];
    const known = new Set(fields.map((field) => field.key));
    for (const key of Object.keys(raw || {})) if (!known.has(key)) errors.push(`Unknown field “${key}”.`);
    for (const field of fields) {
      const input = raw?.[field.key];
      const blank = input === undefined || input === null || (typeof input === "string" && input.trim() === "");
      if (blank) { if (field.required && enforceRequired) errors.push(`${field.label} is required.`); continue; }
      let value: unknown;
      switch (field.type) {
        case "text": case "textarea": case "email": {
          const text = String(input).trim();
          const max = field.max || (field.type === "textarea" ? 4000 : 200);
          if (text.length > max) errors.push(`${field.label} must be ${max} characters or fewer.`);
          if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) errors.push(`${field.label} must be a valid email address.`);
          if (field.column === "title" && text.length < 3) errors.push(`${field.label} must be at least 3 characters.`);
          value = text; break;
        }
        case "number": case "money": {
          const number = Number(input);
          const max = field.max ?? 1_000_000_000;
          if (!Number.isFinite(number) || number < 0 || number > max) errors.push(`${field.label} must be a number between 0 and ${max.toLocaleString("en-IN")}.`);
          if (field.type === "money" && number === 0 && field.required) errors.push(`${field.label} must be more than zero.`);
          value = field.type === "money" ? Math.round(number * 100) / 100 : number; break;
        }
        case "date": {
          const text = String(input);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) errors.push(`${field.label} must be a valid date.`);
          value = text; break;
        }
        case "time": {
          const text = String(input);
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) errors.push(`${field.label} must be a valid time (HH:MM).`);
          value = text; break;
        }
        case "select": {
          if (!field.options?.includes(String(input))) errors.push(`${field.label} has an unsupported value.`);
          value = String(input); break;
        }
        case "employee": {
          const text = String(input);
          const exists = UUID.test(text) && (await client.query(`SELECT 1 FROM employees WHERE organization_id=$1 AND id=$2 AND status='ACTIVE'`, [identity.organizationId, text])).rowCount;
          if (!exists) errors.push(`${field.label} must be an active colleague.`);
          value = text; break;
        }
      }
      if (field.column) columns[field.column] = value; else details[field.key] = value;
    }
    if (errors.length) throw new BadRequestException(errors);
    return { columns, details };
  }

  private notify(client: PoolClient, identity: AuthIdentity, employeeId: string, eventType: string, caseId: string, payload: Record<string, unknown>) {
    return client.query(`INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload) VALUES($1,$2,$3,'hr_case',$4,$5)`,
      [identity.organizationId, employeeId, eventType, caseId, JSON.stringify(payload)]);
  }

  private audit(client: PoolClient, identity: AuthIdentity, action: string, caseId: string, data: unknown) {
    return client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,$3,'hr_case',$4,$5)`,
      [identity.organizationId, identity.userId, action, caseId, JSON.stringify(data)]);
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

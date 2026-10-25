import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { FilesService } from "../files/files.service";
import { JobsService } from "../jobs/jobs.service";
import { escapeHtml, headerSafe } from "../jobs/email-layout";
import { decryptField, mask, sealField } from "../security/field-crypto";
import { DEFAULT_TASKS, DEFAULT_TEMPLATE_DESCRIPTION, DEFAULT_TEMPLATE_NAME } from "./onboarding-defaults";
import type {
  AddTaskDto, CreateJoinerDto, JoinerTransitionDto, ListJoinersQuery, ListMyTasksQuery, ReviewDocumentDto, SaveSettingsDto, SaveTemplateDto,
  TaskActionDto, UpcomingQuery, UpdateJoinerDto, UpdateTaskDto,
} from "./onboarding.dto";

type Row = Record<string, any>;
type Access = "hr" | "manager" | "self" | "participant";
const HR_ROLES = ["HR_ADMIN", "OWNER"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY = "onboarding_joiner";
const TODAY = "(now() AT TIME ZONE 'Asia/Kolkata')::date";
const OPEN_STATUSES = ["PRE_BOARDING", "READY_TO_JOIN", "JOINED"];
const panContext = (organizationId: string, joinerId: string) => ({ table: "onboarding_joiners", column: "pan", organizationId, rowId: joinerId });
export const PHASE_LABELS: Record<string, string> = { PRE_BOARDING: "Before joining", DAY_ONE: "Day one", FIRST_WEEK: "First week", FIRST_90_DAYS: "First 90 days" };
const STATUS_LABELS: Record<string, { label: string; tone: string }> = {
  PRE_BOARDING: { label: "Pre-boarding", tone: "info" }, READY_TO_JOIN: { label: "Ready to join", tone: "warning" },
  JOINED: { label: "Joined", tone: "success" }, COMPLETED: { label: "Onboarded", tone: "success" }, WITHDRAWN: { label: "Withdrawn", tone: "neutral" },
};
const DOC_LABELS: Record<string, string> = { PAN: "PAN card", AADHAAR: "Aadhaar card", BANK_PROOF: "Bank proof", EDUCATION: "Education certificates", PHOTO: "Photo", OTHER: "Other document" };
const OWNER_LABELS: Record<string, string> = { HR: "HR", IT: "IT", MANAGER: "Manager", BUDDY: "Buddy", JOINER: "Joiner", FINANCE: "Finance" };

const SELECT_JOINER = `
  SELECT j.*, to_char(j.joining_date,'YYYY-MM-DD') AS joining_date, (j.joining_date - ${TODAY})::int AS days_to_join,
         m.full_name AS manager_name, m.designation AS manager_designation, m.employee_number AS manager_number,
         b.full_name AS buddy_name, b.designation AS buddy_designation,
         e.employee_number AS employee_number, e.work_email AS work_email, t.name AS template_name
    FROM onboarding_joiners j
    LEFT JOIN employees m ON m.id=j.manager_id AND m.organization_id=j.organization_id
    LEFT JOIN employees b ON b.id=j.buddy_id AND b.organization_id=j.organization_id
    LEFT JOIN employees e ON e.id=j.employee_id AND e.organization_id=j.organization_id
    LEFT JOIN onboarding_templates t ON t.id=j.template_id AND t.organization_id=j.organization_id`;

const SELECT_TASK = `
  SELECT t.*, to_char(t.due_date,'YYYY-MM-DD') AS due_date, (t.status='PENDING' AND t.due_date < ${TODAY}) AS overdue,
         (t.due_date - ${TODAY})::int AS days_left,
         o.full_name AS owner_name, o.designation AS owner_designation, c.full_name AS completed_by_name
    FROM onboarding_tasks t
    LEFT JOIN employees o ON o.id=t.owner_id AND o.organization_id=t.organization_id
    LEFT JOIN employees c ON c.id=t.completed_by AND c.organization_id=t.organization_id`;

@Injectable()
export class OnboardingService implements OnModuleInit {
  constructor(private readonly database: DatabaseService, private readonly files: FilesService, private readonly jobs: JobsService) {}

  onModuleInit() {
    // HR manage joiner documents; the reporting manager can review them; once converted, the joiner can upload
    // while they still have open document tasks of their own, and read afterwards.
    this.files.registerPolicy(ENTITY, async (identity, id, client) => {
      const row = (await client.query(`SELECT manager_id, employee_id FROM onboarding_joiners WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id])).rows[0];
      if (!row) return null;
      if (this.isHr(identity)) return "write";
      if (row.employee_id && row.employee_id === identity.employeeId) {
        const open = await client.query(
          `SELECT 1 FROM onboarding_tasks WHERE organization_id=$1 AND joiner_id=$2 AND owner_type='JOINER' AND requires_document AND status='PENDING' LIMIT 1`,
          [identity.organizationId, id]);
        return open.rowCount ? "write" : "read";
      }
      if (row.manager_id === identity.employeeId) return "read";
      return null;
    });
  }

  // ---- overview / lists --------------------------------------------------------------------------

  list(identity: AuthIdentity, query: ListJoinersQuery) {
    return this.database.tenantTransaction(identity, async (client) => {
      const values: unknown[] = [identity.organizationId];
      const param = (value: unknown) => { values.push(value); return `$${values.length}`; };
      const where = ["j.organization_id=$1"];
      const isHr = this.isHr(identity);
      if (!isHr || query.scope === "mine") {
        const me = param(identity.employeeId);
        where.push(`(j.manager_id=${me} OR j.buddy_id=${me} OR EXISTS (SELECT 1 FROM onboarding_tasks x WHERE x.organization_id=j.organization_id AND x.joiner_id=j.id AND x.owner_id=${me}))`);
      }
      const base = [...where];
      const baseCount = values.length;
      if (query.status) where.push(`j.status=${param(query.status)}`);
      if (query.department) where.push(`j.department=${param(query.department)}`);
      if (query.search?.trim()) {
        const term = param(query.search.trim());
        where.push(`(j.full_name ILIKE '%'||${term}||'%' OR j.designation ILIKE '%'||${term}||'%' OR j.location ILIKE '%'||${term}||'%' OR m.full_name ILIKE '%'||${term}||'%')`);
      }
      const rows = (await client.query(`${SELECT_JOINER} WHERE ${where.join(" AND ")} ORDER BY j.joining_date, j.full_name, j.id LIMIT 300`, values)).rows;
      const progress = await this.progress(client, identity, rows.map((row) => row.id));
      const counts = (await client.query(
        `SELECT j.status, count(*)::int AS count FROM onboarding_joiners j LEFT JOIN employees m ON m.id=j.manager_id AND m.organization_id=j.organization_id
          WHERE ${base.join(" AND ")} GROUP BY j.status`, values.slice(0, baseCount))).rows;
      const departments = (await client.query(
        `SELECT DISTINCT j.department FROM onboarding_joiners j WHERE ${base.join(" AND ")} ORDER BY 1`, values.slice(0, baseCount))).rows.map((row) => row.department);
      const stats = (await client.query(
        `SELECT count(*) FILTER (WHERE j.status IN ('PRE_BOARDING','READY_TO_JOIN') AND j.joining_date BETWEEN ${TODAY} AND ${TODAY} + 30)::int AS joining_soon,
                count(*) FILTER (WHERE j.status IN ('PRE_BOARDING','READY_TO_JOIN') AND j.joining_date BETWEEN ${TODAY} AND ${TODAY} + 7)::int AS joining_week,
                count(*) FILTER (WHERE j.status IN ('PRE_BOARDING','READY_TO_JOIN','JOINED'))::int AS active,
                count(*) FILTER (WHERE j.status IN ('PRE_BOARDING','READY_TO_JOIN','JOINED') AND j.buddy_id IS NOT NULL)::int AS with_buddy,
                (SELECT count(*) FROM onboarding_tasks x JOIN onboarding_joiners y ON y.id=x.joiner_id AND y.organization_id=x.organization_id
                  WHERE x.organization_id=$1 AND y.status IN ('PRE_BOARDING','READY_TO_JOIN','JOINED') AND x.status='PENDING' AND x.due_date < ${TODAY}
                    AND y.id IN (SELECT j.id FROM onboarding_joiners j WHERE ${base.join(" AND ")}))::int AS overdue_tasks,
                (SELECT count(DISTINCT x.owner_id) FROM onboarding_tasks x JOIN onboarding_joiners y ON y.id=x.joiner_id AND y.organization_id=x.organization_id
                  WHERE x.organization_id=$1 AND y.status IN ('PRE_BOARDING','READY_TO_JOIN','JOINED') AND x.status='PENDING' AND x.due_date < ${TODAY}
                    AND y.id IN (SELECT j.id FROM onboarding_joiners j WHERE ${base.join(" AND ")}))::int AS overdue_owners
           FROM onboarding_joiners j WHERE ${base.join(" AND ")}`, values.slice(0, baseCount))).rows[0];
      const pendingDocs = isHr ? Number((await client.query(
        `SELECT count(*) FROM stored_files f JOIN onboarding_joiners j ON j.id=f.entity_id AND j.organization_id=f.organization_id
          LEFT JOIN onboarding_document_reviews r ON r.file_id=f.id
          WHERE f.organization_id=$1 AND f.entity_type=$2 AND f.deleted_at IS NULL AND r.file_id IS NULL AND j.status <> 'WITHDRAWN'`,
        [identity.organizationId, ENTITY])).rows[0].count) : 0;
      const preboarding = rows.filter((row) => row.status === "PRE_BOARDING" || row.status === "READY_TO_JOIN");
      const preAverage = preboarding.length
        ? Math.round(preboarding.reduce((sum, row) => sum + (progress.get(row.id)?.phases.PRE_BOARDING?.percent ?? 100), 0) / preboarding.length) : null;
      return {
        items: rows.map((row) => this.presentCard(identity, row, progress.get(row.id))),
        counts, departments,
        stats: { ...stats, pendingDocuments: pendingDocs, preboardingAverage: preAverage },
        viewer: this.viewer(identity),
      };
    });
  }

  upcoming(identity: AuthIdentity, query: UpcomingQuery) {
    const days = query.days || 14;
    return this.database.tenantTransaction(identity, async (client) => {
      const values: unknown[] = [identity.organizationId, days];
      let visibility = "";
      if (!this.isHr(identity)) {
        values.push(identity.employeeId);
        visibility = `AND (j.manager_id=$3 OR j.buddy_id=$3 OR EXISTS (SELECT 1 FROM onboarding_tasks x WHERE x.organization_id=j.organization_id AND x.joiner_id=j.id AND x.owner_id=$3))`;
      }
      const rows = (await client.query(
        `${SELECT_JOINER} WHERE j.organization_id=$1 AND j.status IN ('PRE_BOARDING','READY_TO_JOIN')
            AND j.joining_date BETWEEN ${TODAY} AND ${TODAY} + $2::int ${visibility}
          ORDER BY j.joining_date, j.full_name LIMIT 20`, values)).rows;
      const progress = await this.progress(client, identity, rows.map((row) => row.id));
      return { items: rows.map((row) => this.presentCard(identity, row, progress.get(row.id))), days, viewer: this.viewer(identity) };
    });
  }

  hiredCandidates(identity: AuthIdentity) {
    this.requireHr(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const rows = (await client.query(
        `SELECT c.id, c.case_number AS "caseNumber", c.title AS name, c.details, c.updated_at AS "hiredAt"
           FROM hr_cases c
          WHERE c.organization_id=$1 AND c.module='candidates' AND c.status='HIRED'
            AND NOT EXISTS (SELECT 1 FROM onboarding_joiners j WHERE j.organization_id=c.organization_id AND j.candidate_case_id=c.id)
          ORDER BY c.updated_at DESC LIMIT 50`, [identity.organizationId])).rows;
      return {
        items: rows.map((row) => {
          const [designation, location] = String(row.details?.position || "").split(/\s+[—–-]\s+/);
          return { id: row.id, caseNumber: row.caseNumber, name: row.name, email: row.details?.email || "", phone: row.details?.phone || "",
            joiningDate: row.details?.joiningDate || null, position: row.details?.position || "", designation: designation || "", location: location || "", hiredAt: row.hiredAt };
        }),
      };
    });
  }

  // ---- joiner detail -----------------------------------------------------------------------------

  get(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => this.detail(client, identity, await this.load(client, identity, id)));
  }

  welcome(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(`${SELECT_JOINER} WHERE j.organization_id=$1 AND j.employee_id=$2 AND j.status <> 'WITHDRAWN' ORDER BY j.created_at DESC LIMIT 1`,
        [identity.organizationId, identity.employeeId])).rows[0];
      if (!row) return { joiner: null, viewer: this.viewer(identity) };
      const settings = await this.settingsRow(client, identity);
      return { ...(await this.detail(client, identity, row)), welcomeMessage: settings.welcome_message };
    });
  }

  private async detail(client: PoolClient, identity: AuthIdentity, row: Row) {
    const access = await this.access(client, identity, row);
    const tasks = (await client.query(`${SELECT_TASK} WHERE t.organization_id=$1 AND t.joiner_id=$2 ORDER BY t.due_date, t.sort_order, t.created_at`,
      [identity.organizationId, row.id])).rows;
    const progress = (await this.progress(client, identity, [row.id])).get(row.id);
    const documents = access === "participant" ? null : await this.documents(client, identity, row, tasks);
    const activity = access === "hr" || access === "manager" ? (await client.query(
      `SELECT a.id, a.action, a.entity_type AS "entityType", a.after_data AS data, a.created_at AS "createdAt", e.full_name AS "actorName"
         FROM audit_log a LEFT JOIN employees e ON e.user_id=a.actor_user_id AND e.organization_id=a.organization_id
        WHERE a.organization_id=$1 AND ((a.entity_type=$2 AND a.entity_id=$3) OR (a.entity_type='onboarding_task' AND a.entity_id = ANY($4::uuid[])))
        ORDER BY a.created_at DESC, a.id DESC LIMIT 60`,
      [identity.organizationId, ENTITY, row.id, tasks.map((task) => task.id)])).rows : [];
    const fileAccess = access === "participant" ? null : await this.fileAccess(client, identity, row);
    return {
      joiner: this.presentJoiner(identity, row, access, progress),
      tasks: tasks.map((task) => this.presentTask(identity, task, row)),
      phases: Object.keys(PHASE_LABELS).map((key) => ({ key, label: PHASE_LABELS[key], ...(progress?.phases[key] || { total: 0, closed: 0, overdue: 0, percent: 0 }) })),
      documents, activity, access, fileAccess,
      actions: this.joinerActions(identity, row, tasks),
      viewer: this.viewer(identity),
    };
  }

  private async documents(client: PoolClient, identity: AuthIdentity, joiner: Row, tasks: Row[]) {
    const files = (await client.query(
      `SELECT f.id, f.category, f.original_name AS "originalName", f.mime_type AS "mimeType", f.byte_size AS "byteSize", f.created_at AS "createdAt",
              u.full_name AS "uploadedBy", r.status AS "reviewStatus", r.reason AS "reviewReason", r.reviewed_at AS "reviewedAt", v.full_name AS "reviewedBy"
         FROM stored_files f JOIN employees u ON u.id=f.uploaded_by AND u.organization_id=f.organization_id
         LEFT JOIN onboarding_document_reviews r ON r.file_id=f.id AND r.organization_id=f.organization_id
         LEFT JOIN employees v ON v.id=r.reviewed_by AND v.organization_id=f.organization_id
        WHERE f.organization_id=$1 AND f.entity_type=$2 AND f.entity_id=$3 AND f.deleted_at IS NULL ORDER BY f.created_at`,
      [identity.organizationId, ENTITY, joiner.id])).rows;
    const required = new Map<string, Row>();
    for (const task of tasks) if (task.requires_document && task.document_category && task.status !== "SKIPPED") required.set(task.document_category, task);
    const categories = new Set<string>([...required.keys(), ...files.map((file) => file.category).filter((category) => DOC_LABELS[category])]);
    const order = Object.keys(DOC_LABELS);
    const items = [...categories].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((category) => {
      const list = files.filter((file) => file.category === category);
      const status = !list.length ? "MISSING" : list.some((file) => file.reviewStatus === "VERIFIED") ? "VERIFIED"
        : list.some((file) => !file.reviewStatus) ? "PENDING_REVIEW" : "REJECTED";
      const task = required.get(category);
      return { category, label: DOC_LABELS[category], required: !!task, taskId: task?.id || null, dueDate: task ? task.due_date : null, status, files: list };
    });
    const otherFiles = files.filter((file) => !DOC_LABELS[file.category]);
    const requiredItems = items.filter((item) => item.required);
    return {
      items, otherFiles,
      summary: {
        required: requiredItems.length,
        verified: requiredItems.filter((item) => item.status === "VERIFIED").length,
        missing: requiredItems.filter((item) => item.status === "MISSING" || item.status === "REJECTED").length,
        pendingReview: requiredItems.filter((item) => item.status === "PENDING_REVIEW").length,
      },
      canReview: this.isHr(identity) && joiner.status !== "WITHDRAWN",
    };
  }

  private async fileAccess(client: PoolClient, identity: AuthIdentity, joiner: Row) {
    if (this.isHr(identity)) return "write";
    if (joiner.employee_id === identity.employeeId) {
      const open = await client.query(`SELECT 1 FROM onboarding_tasks WHERE organization_id=$1 AND joiner_id=$2 AND owner_type='JOINER' AND requires_document AND status='PENDING' LIMIT 1`,
        [identity.organizationId, joiner.id]);
      return open.rowCount ? "write" : "read";
    }
    return joiner.manager_id === identity.employeeId ? "read" : null;
  }

  // ---- create / update joiners -------------------------------------------------------------------

  async create(identity: AuthIdentity, input: CreateJoinerDto) {
    this.requireHr(identity);
    const created = await this.database.tenantTransaction(identity, async (client) => {
      const errors: string[] = [];
      const fullName = input.fullName.trim();
      const personalEmail = input.personalEmail.trim().toLowerCase();
      if (fullName.length < 2) errors.push("Full name is required.");
      if (input.managerId) await this.requireEmployee(client, identity, input.managerId, "Reporting manager", errors);
      if (input.buddyId) await this.requireEmployee(client, identity, input.buddyId, "Buddy", errors);
      if (input.managerId && input.buddyId && input.managerId === input.buddyId) errors.push("Choose a buddy other than the reporting manager.");
      const window = (await client.query(`SELECT ($1::date >= ${TODAY} - 60) AS not_old, ($1::date <= ${TODAY} + 365) AS not_far`, [input.joiningDate]).catch(() => null))?.rows[0];
      if (!window) errors.push("Joining date must be a valid date.");
      else if (!window.not_old || !window.not_far) errors.push("Joining date must be between 60 days ago and one year from today.");
      if (errors.length) throw new BadRequestException(errors);

      const duplicate = await client.query(`SELECT full_name FROM onboarding_joiners WHERE organization_id=$1 AND lower(personal_email)=$2 AND status = ANY($3) LIMIT 1`,
        [identity.organizationId, personalEmail, OPEN_STATUSES]);
      if (duplicate.rowCount) throw new ConflictException(`${duplicate.rows[0].full_name} is already being onboarded with ${personalEmail}.`);

      let candidateId: string | null = null;
      if (input.candidateId) {
        const candidate = (await client.query(`SELECT id, status, title FROM hr_cases WHERE organization_id=$1 AND id=$2 AND module='candidates' FOR UPDATE`,
          [identity.organizationId, input.candidateId])).rows[0];
        if (!candidate) throw new NotFoundException("Candidate not found.");
        if (candidate.status !== "HIRED") throw new ConflictException(`${candidate.title} is not marked hired yet.`);
        const imported = await client.query(`SELECT id FROM onboarding_joiners WHERE organization_id=$1 AND candidate_case_id=$2`, [identity.organizationId, candidate.id]);
        if (imported.rowCount) throw new ConflictException(`${candidate.title} has already been added to onboarding.`);
        candidateId = candidate.id;
      }

      const template = input.templateId
        ? (await client.query(`SELECT id FROM onboarding_templates WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL`, [identity.organizationId, input.templateId])).rows[0]
        : { id: await this.ensureDefaultTemplate(client, identity) };
      if (!template) throw new BadRequestException("Choose an active checklist template.");

      const joiner = (await client.query(
        `INSERT INTO onboarding_joiners(organization_id,full_name,personal_email,phone,designation,department,location,manager_id,buddy_id,joining_date,employment_type,template_id,candidate_case_id,notes,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [identity.organizationId, fullName, personalEmail, clean(input.phone), input.designation.trim(), input.department.trim(), clean(input.location),
          input.managerId || null, input.buddyId || null, input.joiningDate, input.employmentType || "FULL_TIME", template.id, candidateId, clean(input.notes), identity.employeeId])).rows[0];
      const row = await this.load(client, identity, joiner.id, true);
      const settings = await this.settingsRow(client, identity);
      const templateTasks = (await client.query(`SELECT * FROM onboarding_template_tasks WHERE organization_id=$1 AND template_id=$2 ORDER BY sort_order, id`,
        [identity.organizationId, template.id])).rows;
      for (const task of templateTasks)
        await client.query(
          `INSERT INTO onboarding_tasks(organization_id,joiner_id,template_task_id,phase,title,description,owner_type,owner_id,due_date,requires_document,document_category,completes_on_conversion,sort_order)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::date + $10::int,$11,$12,$13,$14)`,
          [identity.organizationId, row.id, task.id, task.phase, task.title, task.description, task.owner_type, this.resolveOwner(task.owner_type, row, settings),
            row.joining_date, task.due_offset_days, task.requires_document, task.document_category, task.completes_on_conversion, task.sort_order]);
      await this.notifyOwners(client, identity, row, `New joiner: ${row.full_name}`);
      if (row.manager_id && row.manager_id !== identity.employeeId)
        await this.notify(client, identity, row.manager_id, "ONBOARDING_JOINER_ADDED", row.id,
          `${row.full_name} joins your team as ${row.designation} on ${formatDate(row.joining_date)}`);
      if (row.buddy_id)
        await this.notify(client, identity, row.buddy_id, "ONBOARDING_BUDDY_ASSIGNED", row.id, `You are ${row.full_name}'s onboarding buddy — they join on ${formatDate(row.joining_date)}`);
      await this.audit(client, identity, "ONBOARDING_JOINER_CREATED", ENTITY, row.id, null, {
        fullName, designation: row.designation, department: row.department, joiningDate: row.joining_date, candidateId, templateId: template.id, tasks: templateTasks.length,
      });
      return this.detail(client, identity, await this.load(client, identity, row.id));
    });
    await this.jobs.enqueue("notifications.dispatch", { organizationId: identity.organizationId, entityType: ENTITY, entityId: created.joiner.id });
    return created;
  }

  update(identity: AuthIdentity, id: string, input: UpdateJoinerDto) {
    this.requireHr(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const row = await this.load(client, identity, id, true);
      if (row.version !== input.version) throw new ConflictException("This joiner changed since you opened it. Refresh and try again.");
      if (row.status === "WITHDRAWN" || row.status === "COMPLETED") throw new ConflictException("Closed onboarding records can no longer be edited.");
      const joined = row.status === "JOINED";
      const errors: string[] = [];
      const sets: string[] = [];
      const values: unknown[] = [identity.organizationId, id];
      const set = (column: string, value: unknown) => { values.push(value); sets.push(`${column}=$${values.length}`); };
      const before: Row = {}; const after: Row = {};
      const track = (key: string, column: string, value: unknown) => { if (String(row[column] ?? "") !== String(value ?? "")) { before[key] = row[column]; after[key] = value; set(column, value); } };
      const lockedAfterJoin = ["fullName", "personalEmail", "designation", "department", "location", "managerId", "joiningDate", "employmentType"] as const;
      if (joined) for (const key of lockedAfterJoin) if (input[key] !== undefined && String(input[key] ?? "") !== String(row[snake(key)] ?? ""))
        errors.push("After day one, update job details on the employee record instead; only buddy, notes and ID details can change here.");
      if (input.fullName !== undefined) track("fullName", "full_name", input.fullName.trim());
      if (input.personalEmail !== undefined) track("personalEmail", "personal_email", input.personalEmail.trim().toLowerCase());
      if (input.phone !== undefined) track("phone", "phone", clean(input.phone));
      if (input.designation !== undefined) track("designation", "designation", input.designation.trim());
      if (input.department !== undefined) track("department", "department", input.department.trim());
      if (input.location !== undefined) track("location", "location", clean(input.location));
      if (input.employmentType !== undefined) track("employmentType", "employment_type", input.employmentType);
      if (input.notes !== undefined) track("notes", "notes", clean(input.notes));
      const managerId = input.managerId === undefined ? row.manager_id : input.managerId || null;
      const buddyId = input.buddyId === undefined ? row.buddy_id : input.buddyId || null;
      if (input.managerId) await this.requireEmployee(client, identity, input.managerId, "Reporting manager", errors);
      if (input.buddyId) await this.requireEmployee(client, identity, input.buddyId, "Buddy", errors);
      if (managerId && buddyId && managerId === buddyId) errors.push("Choose a buddy other than the reporting manager.");
      if (buddyId && buddyId === row.employee_id) errors.push("The joiner cannot be their own buddy.");
      if (input.managerId !== undefined) track("managerId", "manager_id", managerId);
      if (input.buddyId !== undefined) track("buddyId", "buddy_id", buddyId);
      if (input.panNumber !== undefined) {
        const pan = input.panNumber.trim().toUpperCase();
        if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) errors.push("PAN must look like ABCDE1234F.");
        else {
          // Stored encrypted (bound to this brand + joiner) with a blind index for duplicate checks; never in plaintext.
          const sealed = sealField("pan", pan || null, panContext(identity.organizationId, id));
          if ((row.pan_hash || null) !== sealed.hash) {
            const duplicate = sealed.hash ? await this.panDuplicate(client, identity, sealed.hash, id, row.employee_id) : null;
            if (duplicate) errors.push(`This PAN is already on file for ${duplicate}.`);
            before.panNumber = row.pan_enc ? mask("pan", row.pan_last4) : null; after.panNumber = pan ? mask("pan", sealed.last4) : null;
            set("pan_enc", sealed.enc); set("pan_hash", sealed.hash); set("pan_last4", sealed.last4);
          }
        }
      }
      if (input.aadhaarNumber !== undefined) {
        const digits = input.aadhaarNumber.replace(/\s+/g, "");
        if (digits && !/^[2-9][0-9]{11}$/.test(digits)) errors.push("Aadhaar must be a 12-digit number.");
        // Only the last four digits are retained.
        else if (String(row.aadhaar_last4 || "") !== digits.slice(-4)) { after.aadhaarLast4 = digits ? digits.slice(-4) : null; set("aadhaar_last4", digits ? digits.slice(-4) : null); }
      }
      let shift = 0;
      if (input.joiningDate !== undefined && input.joiningDate !== row.joining_date) {
        const check = (await client.query(`SELECT ($1::date >= ${TODAY} - 60 AND $1::date <= ${TODAY} + 365) AS ok, ($1::date - $2::date)::int AS delta`, [input.joiningDate, row.joining_date]).catch(() => null))?.rows[0];
        if (!check?.ok) errors.push("Joining date must be between 60 days ago and one year from today.");
        else { shift = check.delta; track("joiningDate", "joining_date", input.joiningDate); }
      }
      if (errors.length) throw new BadRequestException([...new Set(errors)]);
      if (!sets.length) return this.detail(client, identity, row);
      await client.query(`UPDATE onboarding_joiners SET ${sets.join(",")}, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`, values);
      if (shift) await client.query(`UPDATE onboarding_tasks SET due_date=due_date + $3::int, version=version+1, updated_at=now() WHERE organization_id=$1 AND joiner_id=$2 AND status='PENDING'`,
        [identity.organizationId, id, shift]);
      const updated = await this.load(client, identity, id, true);
      if (after.managerId !== undefined || after.buddyId !== undefined) {
        const settings = await this.settingsRow(client, identity);
        const pending = (await client.query(`SELECT id, owner_type, owner_id FROM onboarding_tasks WHERE organization_id=$1 AND joiner_id=$2 AND status='PENDING' AND owner_type IN ('MANAGER','BUDDY')`,
          [identity.organizationId, id])).rows;
        const moved = new Map<string, number>();
        for (const task of pending) {
          const owner = this.resolveOwner(task.owner_type, updated, settings);
          if (owner === task.owner_id) continue;
          await client.query(`UPDATE onboarding_tasks SET owner_id=$3, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`, [identity.organizationId, task.id, owner]);
          if (owner) moved.set(owner, (moved.get(owner) || 0) + 1);
        }
        for (const [owner, count] of moved) if (owner !== identity.employeeId)
          await this.notify(client, identity, owner, "ONBOARDING_TASKS_ASSIGNED", id, `${count} onboarding task${count > 1 ? "s" : ""} for ${updated.full_name} moved to you`);
        if (after.buddyId && after.buddyId !== identity.employeeId)
          await this.notify(client, identity, String(after.buddyId), "ONBOARDING_BUDDY_ASSIGNED", id, `You are ${updated.full_name}'s onboarding buddy — they join on ${formatDate(updated.joining_date)}`);
      }
      if (shift && updated.manager_id && updated.manager_id !== identity.employeeId)
        await this.notify(client, identity, updated.manager_id, "ONBOARDING_DATE_CHANGED", id, `${updated.full_name}'s joining date moved to ${formatDate(updated.joining_date)}`);
      await this.audit(client, identity, "ONBOARDING_JOINER_UPDATED", ENTITY, id, before, { ...after, ...(shift ? { tasksShiftedByDays: shift } : {}) });
      return this.detail(client, identity, updated);
    });
  }

  // ---- lifecycle -----------------------------------------------------------------------------------

  async transition(identity: AuthIdentity, id: string, input: JoinerTransitionDto) {
    this.requireHr(identity);
    const result = await this.database.tenantTransaction(identity, async (client) => {
      const row = await this.load(client, identity, id, true);
      // Converting twice (double click, retry after a timeout) returns the employee that already exists.
      if (input.action === "convert" && row.employee_id) return this.detail(client, identity, row);
      if (row.version !== input.version) throw new ConflictException("This joiner changed since you opened it. Refresh and try again.");
      const note = input.note?.trim() || null;
      const tasks = (await client.query(`SELECT id, phase, title, status FROM onboarding_tasks WHERE organization_id=$1 AND joiner_id=$2`, [identity.organizationId, id])).rows;
      switch (input.action) {
        case "ready": {
          this.expect(row, ["PRE_BOARDING"], "marked ready to join");
          const open = tasks.filter((task) => task.phase === "PRE_BOARDING" && task.status === "PENDING");
          if (open.length) throw new ConflictException(`Finish or skip the ${open.length} open before-joining task${open.length > 1 ? "s" : ""} first: ${open.slice(0, 3).map((task) => task.title).join("; ")}${open.length > 3 ? "…" : ""}`);
          await client.query(`UPDATE onboarding_joiners SET status='READY_TO_JOIN', ready_at=now(), version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id]);
          if (row.manager_id && row.manager_id !== identity.employeeId)
            await this.notify(client, identity, row.manager_id, "ONBOARDING_READY", id, `${row.full_name} is ready to join on ${formatDate(row.joining_date)} — paperwork complete`);
          await this.audit(client, identity, "ONBOARDING_READY_TO_JOIN", ENTITY, id, { status: row.status }, { status: "READY_TO_JOIN", note });
          break;
        }
        case "back_to_preboarding": {
          this.expect(row, ["READY_TO_JOIN"], "moved back to pre-boarding");
          await client.query(`UPDATE onboarding_joiners SET status='PRE_BOARDING', ready_at=NULL, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id]);
          await this.audit(client, identity, "ONBOARDING_REOPENED", ENTITY, id, { status: row.status }, { status: "PRE_BOARDING", note });
          break;
        }
        case "convert": {
          this.expect(row, ["READY_TO_JOIN"], "converted to an employee");
          const soon = (await client.query(`SELECT $1::date <= ${TODAY} + 3 AS ok`, [row.joining_date])).rows[0].ok;
          if (!soon) throw new ConflictException(`Conversion opens three days before the joining date (${formatDate(row.joining_date)}).`);
          await this.convert(client, identity, row, input.workEmail);
          break;
        }
        case "complete": {
          this.expect(row, ["JOINED"], "marked onboarded");
          const open = tasks.filter((task) => task.status === "PENDING");
          if (open.length) throw new ConflictException(`${open.length} task${open.length > 1 ? "s are" : " is"} still open. Complete or skip them first.`);
          await this.markCompleted(client, identity, row, note);
          break;
        }
        case "withdraw": {
          this.expect(row, ["PRE_BOARDING", "READY_TO_JOIN"], "withdrawn");
          if (!note) throw new BadRequestException("Add a reason, e.g. offer declined or no-show.");
          await client.query(`UPDATE onboarding_joiners SET status='WITHDRAWN', withdrawn_at=now(), withdrawn_reason=$3, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`,
            [identity.organizationId, id, note]);
          const skipped = await client.query(
            `UPDATE onboarding_tasks SET status='SKIPPED', note='Joiner withdrew: '||$3, completed_by=$4, completed_at=now(), version=version+1, updated_at=now()
              WHERE organization_id=$1 AND joiner_id=$2 AND status='PENDING' RETURNING owner_id`, [identity.organizationId, id, note, identity.employeeId]);
          const notified = new Set<string>([row.manager_id, row.buddy_id, ...skipped.rows.map((task) => task.owner_id)].filter((value) => value && value !== identity.employeeId));
          for (const recipient of notified)
            await this.notify(client, identity, recipient, "ONBOARDING_WITHDRAWN", id, `${row.full_name} will not be joining — their onboarding tasks were closed`);
          await this.audit(client, identity, "ONBOARDING_WITHDRAWN", ENTITY, id, { status: row.status }, { status: "WITHDRAWN", reason: note, tasksClosed: skipped.rowCount });
          break;
        }
      }
      return this.detail(client, identity, await this.load(client, identity, id));
    });
    if (input.action === "convert") await this.jobs.enqueue("outbox.dispatch", { organizationId: identity.organizationId, entityType: ENTITY, entityId: id });
    return result;
  }

  /** Day one: creates the user, membership and employees row, then hands the joiner their own tasks. */
  private async convert(client: PoolClient, identity: AuthIdentity, row: Row, requestedEmail?: string) {
    const settings = await this.settingsRow(client, identity);
    // Serialise employee-number allocation per organization.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('employee_number:' || $1))`, [identity.organizationId]);
    const workEmail = requestedEmail ? requestedEmail.trim().toLowerCase() : await this.suggestEmail(client, identity, row.full_name, settings);
    // Uniqueness rules: employee number and work email are unique per brand (employees, RLS-scoped). Sign-in identities
    // (users) are global, so the email must not already belong to a person anywhere in the group.
    const taken = await client.query(`SELECT employee_number FROM employees WHERE organization_id=$1 AND lower(work_email)=$2`, [identity.organizationId, workEmail]);
    if (taken.rowCount) throw new ConflictException(`${workEmail} already belongs to ${taken.rows[0].employee_number}. Choose another work email.`);
    const existingUser = await this.globalUser(workEmail, identity.organizationId);
    // Re-using a user row would hand the joiner someone else's sign-in: only an orphan identity (no employee record and no
    // membership in any brand, e.g. left behind by an earlier failed conversion) may be adopted.
    if (existingUser && (existingUser.employees > 0 || existingUser.memberships > 0))
      throw new ConflictException(`${workEmail} is already used by another account${existingUser.otherBrand ? " in another brand" : ""}. Choose another work email.`);
    if (row.pan_hash) {
      const duplicate = await this.panDuplicate(client, identity, row.pan_hash, row.id, null);
      if (duplicate) throw new ConflictException(`This joiner's PAN is already on file for ${duplicate}. Resolve the duplicate (re-hire or data-entry error) before converting.`);
    }
    const prefix = settings.employee_number_prefix;
    const next = Number((await client.query(
      `SELECT coalesce(max(substring(employee_number from '^' || $2 || '([0-9]+)$')::int), 0) + 1 AS n FROM employees WHERE organization_id=$1 AND employee_number ~ ('^' || $2 || '[0-9]+$')`,
      [identity.organizationId, prefix])).rows[0].n);
    const employeeNumber = `${prefix}${String(next).padStart(3, "0")}`;
    let userId: string = existingUser?.id;
    if (!userId) {
      try {
        userId = (await client.query(`INSERT INTO users(email, full_name) VALUES($1,$2) RETURNING id`, [workEmail, row.full_name])).rows[0].id;
      } catch (error: any) {
        // Concurrent conversion (any brand) claimed the email between the check and the insert.
        if (error?.code === "23505") throw new ConflictException(`${workEmail} was just taken by another account. Choose another work email.`);
        throw error;
      }
    }
    await client.query(`INSERT INTO organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'EMPLOYEE','ACTIVE') ON CONFLICT (organization_id,user_id) DO NOTHING`,
      [identity.organizationId, userId]);
    const employee = (await client.query(
      `INSERT INTO employees(organization_id,user_id,employee_number,full_name,work_email,manager_id,department,designation,location,joining_date,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE') RETURNING id`,
      [identity.organizationId, userId, employeeNumber, row.full_name, workEmail, row.manager_id, row.department, row.designation, row.location, row.joining_date])).rows[0];
    await client.query(`UPDATE onboarding_joiners SET status='JOINED', employee_id=$3, converted_at=now(), version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`,
      [identity.organizationId, row.id, employee.id]);
    if (row.pan_enc) {
      // Carry the verified PAN into the payroll profile, re-encrypted for its new home (payroll_profiles / this employee).
      const pan = decryptField(row.pan_enc, panContext(identity.organizationId, row.id));
      const sealed = sealField("pan", pan, { table: "payroll_profiles", column: "pan", organizationId: identity.organizationId, rowId: employee.id });
      await client.query(
        `INSERT INTO payroll_profiles(organization_id,employee_id,pan_enc,pan_hash,pan_last4) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(organization_id,employee_id) DO UPDATE SET pan_enc=$3,pan_hash=$4,pan_last4=$5,version=payroll_profiles.version+1,updated_at=now()`,
        [identity.organizationId, employee.id, sealed.enc, sealed.hash, sealed.last4]);
    }
    await client.query(`UPDATE onboarding_tasks SET owner_id=$3, version=version+1, updated_at=now() WHERE organization_id=$1 AND joiner_id=$2 AND owner_type='JOINER' AND status='PENDING'`,
      [identity.organizationId, row.id, employee.id]);
    const auto = await client.query(
      `UPDATE onboarding_tasks SET status='DONE', note='Completed automatically when the employee record was created (' || $3 || ').', completed_by=$4, completed_at=now(), version=version+1, updated_at=now()
        WHERE organization_id=$1 AND joiner_id=$2 AND completes_on_conversion AND status='PENDING' RETURNING id, title`,
      [identity.organizationId, row.id, employeeNumber, identity.employeeId]);
    const firstName = row.full_name.split(" ")[0];
    await this.notify(client, identity, employee.id, "ONBOARDING_WELCOME", row.id, `${settings.welcome_message} — your employee ID is ${employeeNumber}.`, { link: "/welcome" });
    if (row.manager_id && row.manager_id !== identity.employeeId)
      await this.notify(client, identity, row.manager_id, "ONBOARDING_JOINED", row.id, `${row.full_name} (${employeeNumber}) has joined your team today`);
    if (row.buddy_id)
      await this.notify(client, identity, row.buddy_id, "ONBOARDING_JOINED", row.id, `${firstName} joined today — say hello and take them for their welcome coffee`);
    const html = `<p>Hi ${escapeHtml(firstName)},</p><p>${escapeHtml(settings.welcome_message)}</p>
      <p>Your employee ID is <b>${escapeHtml(employeeNumber)}</b> and your work email is <b>${escapeHtml(workEmail)}</b>. Sign in to Northstar and open <b>Welcome</b> to see your first-week plan.</p>`;
    for (const recipient of new Set([row.personal_email, workEmail]))
      await client.query(`INSERT INTO email_outbox(organization_id,recipient,subject,html) VALUES($1,$2,$3,$4)`, [identity.organizationId, recipient, headerSafe(`Welcome to the team, ${firstName}!`), html]);
    await this.audit(client, identity, "ONBOARDING_CONVERTED", ENTITY, row.id, { status: row.status },
      { status: "JOINED", employeeId: employee.id, employeeNumber, workEmail, autoCompleted: auto.rows.map((task) => task.title) });
    await this.audit(client, identity, "EMPLOYEE_CREATED", "employee", employee.id, null,
      { employeeNumber, fullName: row.full_name, source: "onboarding", joinerId: row.id, managerId: row.manager_id, joiningDate: row.joining_date });
  }

  private async markCompleted(client: PoolClient, identity: AuthIdentity, row: Row, note: string | null) {
    await client.query(`UPDATE onboarding_joiners SET status='COMPLETED', completed_at=now(), version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`, [identity.organizationId, row.id]);
    for (const recipient of new Set([row.manager_id, row.employee_id].filter((value) => value && value !== identity.employeeId)))
      await this.notify(client, identity, recipient, "ONBOARDING_COMPLETED", row.id, `${row.full_name}'s onboarding is complete 🎉`);
    await this.audit(client, identity, "ONBOARDING_COMPLETED", ENTITY, row.id, { status: row.status }, { status: "COMPLETED", note });
  }

  // ---- tasks --------------------------------------------------------------------------------------

  myTasks(identity: AuthIdentity, query: ListMyTasksQuery) {
    const state = query.state || "open";
    return this.database.tenantTransaction(identity, async (client) => {
      const hr = this.isHr(identity);
      const rows = (await client.query(
        `${SELECT_TASK.replace("FROM onboarding_tasks t", `, j.full_name AS joiner_name, j.designation AS joiner_designation, j.department AS joiner_department,
                to_char(j.joining_date,'YYYY-MM-DD') AS joiner_joining_date, j.status AS joiner_status, j.employee_id AS joiner_employee_id
           FROM onboarding_tasks t JOIN onboarding_joiners j ON j.id=t.joiner_id AND j.organization_id=t.organization_id`)}
          WHERE t.organization_id=$1 AND j.status <> 'WITHDRAWN'
            AND (t.owner_id=$2 OR ($3 AND t.owner_id IS NULL))
            AND ($4='all' OR ($4='open' AND t.status='PENDING') OR ($4='done' AND t.status <> 'PENDING'))
          ORDER BY (t.status='PENDING') DESC, t.due_date, j.full_name, t.sort_order LIMIT 300`,
        [identity.organizationId, identity.employeeId, hr, state])).rows;
      const counts = (await client.query(
        `SELECT count(*) FILTER (WHERE t.status='PENDING')::int AS open, count(*) FILTER (WHERE t.status='PENDING' AND t.due_date < ${TODAY})::int AS overdue,
                count(*) FILTER (WHERE t.status='PENDING' AND t.due_date BETWEEN ${TODAY} AND ${TODAY} + 7)::int AS this_week,
                count(*) FILTER (WHERE t.status <> 'PENDING' AND t.completed_at > now() - interval '30 days')::int AS done_recently
           FROM onboarding_tasks t JOIN onboarding_joiners j ON j.id=t.joiner_id AND j.organization_id=t.organization_id
          WHERE t.organization_id=$1 AND j.status <> 'WITHDRAWN' AND (t.owner_id=$2 OR ($3 AND t.owner_id IS NULL))`,
        [identity.organizationId, identity.employeeId, hr])).rows[0];
      return {
        items: rows.map((task) => ({
          ...this.presentTask(identity, task, { status: task.joiner_status, employee_id: task.joiner_employee_id }),
          joiner: { id: task.joiner_id, name: task.joiner_name, designation: task.joiner_designation, department: task.joiner_department, joiningDate: task.joiner_joining_date, status: task.joiner_status },
        })),
        counts, state, viewer: this.viewer(identity),
      };
    });
  }

  taskAction(identity: AuthIdentity, id: string, input: TaskActionDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const task = await this.loadTask(client, identity, id, true);
      const joiner = await this.load(client, identity, task.joiner_id, true);
      if (task.version !== input.version) throw new ConflictException("This task changed since you opened it. Refresh and try again.");
      if (joiner.status === "WITHDRAWN" || joiner.status === "COMPLETED") throw new ConflictException("This onboarding is closed.");
      if (!this.canWork(identity, task)) throw new ForbiddenException(task.owner_id ? `Only ${task.owner_name} or HR can update this task.` : "Only HR can update this task until the joiner has an employee login.");
      const note = input.note?.trim() || null;
      if (input.action === "reopen") {
        if (task.status === "PENDING") throw new ConflictException("This task is already open.");
        await client.query(`UPDATE onboarding_tasks SET status='PENDING', completed_by=NULL, completed_at=NULL, note=$3, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`,
          [identity.organizationId, id, note]);
      } else {
        if (task.status !== "PENDING") throw new ConflictException(`This task is already ${task.status === "DONE" ? "done" : "skipped"}.`);
        if (input.action === "skip" && !note) throw new BadRequestException("Add a note explaining why this task is skipped.");
        if (input.action === "complete" && task.requires_document) {
          const usable = await client.query(
            `SELECT 1 FROM stored_files f LEFT JOIN onboarding_document_reviews r ON r.file_id=f.id
              WHERE f.organization_id=$1 AND f.entity_type=$2 AND f.entity_id=$3 AND f.category=$4 AND f.deleted_at IS NULL AND coalesce(r.status,'') <> 'REJECTED' LIMIT 1`,
            [identity.organizationId, ENTITY, joiner.id, task.document_category]);
          if (!usable.rowCount) throw new ConflictException(`Upload the ${DOC_LABELS[task.document_category].toLowerCase()} before completing this task.`);
        }
        await client.query(`UPDATE onboarding_tasks SET status=$3, note=$4, completed_by=$5, completed_at=now(), version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`,
          [identity.organizationId, id, input.action === "complete" ? "DONE" : "SKIPPED", note, identity.employeeId]);
        // Let HR know when a joiner or another owner skips something so nothing silently falls through.
        if (input.action === "skip" && !this.isHr(identity)) {
          const settings = await this.settingsRow(client, identity);
          const hrOwner = settings.hr_owner_id || joiner.created_by;
          if (hrOwner && hrOwner !== identity.employeeId)
            await this.notify(client, identity, hrOwner, "ONBOARDING_TASK_SKIPPED", joiner.id, `“${task.title}” for ${joiner.full_name} was skipped: ${note}`);
        }
      }
      await this.audit(client, identity, `ONBOARDING_TASK_${input.action.toUpperCase()}`, "onboarding_task", id,
        { status: task.status }, { joinerId: joiner.id, title: task.title, status: input.action === "reopen" ? "PENDING" : input.action === "complete" ? "DONE" : "SKIPPED", note });
      await this.maybeComplete(client, identity, joiner.id);
      const updated = await this.loadTask(client, identity, id);
      return { task: this.presentTask(identity, updated, await this.load(client, identity, joiner.id)) };
    });
  }

  updateTask(identity: AuthIdentity, id: string, input: UpdateTaskDto) {
    this.requireHr(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const task = await this.loadTask(client, identity, id, true);
      const joiner = await this.load(client, identity, task.joiner_id, true);
      if (task.version !== input.version) throw new ConflictException("This task changed since you opened it. Refresh and try again.");
      if (joiner.status === "WITHDRAWN" || joiner.status === "COMPLETED") throw new ConflictException("This onboarding is closed.");
      const errors: string[] = [];
      const sets: string[] = []; const values: unknown[] = [identity.organizationId, id];
      const after: Row = {};
      let newOwner: string | null | undefined;
      if (input.ownerId !== undefined) {
        if (input.ownerId) await this.requireEmployee(client, identity, input.ownerId, "Owner", errors);
        newOwner = input.ownerId || this.resolveOwner(task.owner_type, joiner, await this.settingsRow(client, identity));
        if (newOwner !== task.owner_id) { values.push(newOwner); sets.push(`owner_id=$${values.length}`); after.ownerId = newOwner; }
      }
      if (input.dueDate !== undefined && input.dueDate !== task.due_date) {
        const ok = (await client.query(`SELECT $1::date BETWEEN $2::date - 120 AND $2::date + 365 AS ok`, [input.dueDate, joiner.joining_date]).catch(() => null))?.rows[0]?.ok;
        if (!ok) errors.push("Due date must be within 120 days before and a year after the joining date.");
        values.push(input.dueDate); sets.push(`due_date=$${values.length}`); after.dueDate = input.dueDate;
      }
      if (input.title !== undefined && input.title.trim() !== task.title) { values.push(input.title.trim()); sets.push(`title=$${values.length}`); after.title = input.title.trim(); }
      if (errors.length) throw new BadRequestException(errors);
      if (sets.length) {
        await client.query(`UPDATE onboarding_tasks SET ${sets.join(",")}, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`, values);
        if (newOwner && after.ownerId && newOwner !== identity.employeeId)
          await this.notify(client, identity, newOwner, "ONBOARDING_TASK_ASSIGNED", joiner.id, `You own “${task.title}” for ${joiner.full_name}`);
        await this.audit(client, identity, "ONBOARDING_TASK_UPDATED", "onboarding_task", id,
          { ownerId: task.owner_id, dueDate: task.due_date, title: task.title }, { joinerId: joiner.id, ...after });
      }
      return { task: this.presentTask(identity, await this.loadTask(client, identity, id), joiner) };
    });
  }

  addTask(identity: AuthIdentity, joinerId: string, input: AddTaskDto) {
    this.requireHr(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const joiner = await this.load(client, identity, joinerId, true);
      if (joiner.status === "WITHDRAWN" || joiner.status === "COMPLETED") throw new ConflictException("This onboarding is closed.");
      const errors: string[] = [];
      if (input.ownerId) await this.requireEmployee(client, identity, input.ownerId, "Owner", errors);
      const ok = (await client.query(`SELECT $1::date BETWEEN $2::date - 120 AND $2::date + 365 AS ok`, [input.dueDate, joiner.joining_date]).catch(() => null))?.rows[0]?.ok;
      if (!ok) errors.push("Due date must be within 120 days before and a year after the joining date.");
      if (errors.length) throw new BadRequestException(errors);
      const owner = input.ownerId || this.resolveOwner(input.ownerType, joiner, await this.settingsRow(client, identity));
      const order = Number((await client.query(`SELECT coalesce(max(sort_order),0)+10 AS n FROM onboarding_tasks WHERE organization_id=$1 AND joiner_id=$2`, [identity.organizationId, joinerId])).rows[0].n);
      const task = (await client.query(
        `INSERT INTO onboarding_tasks(organization_id,joiner_id,phase,title,description,owner_type,owner_id,due_date,requires_document,document_category,sort_order)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [identity.organizationId, joinerId, input.phase, input.title.trim(), clean(input.description), input.ownerType, owner, input.dueDate,
          !!input.documentCategory, input.documentCategory || null, order])).rows[0];
      // A JOINED record that was fully complete gets a new open task — nothing else to do; COMPLETED is closed above.
      if (owner && owner !== identity.employeeId)
        await this.notify(client, identity, owner, "ONBOARDING_TASK_ASSIGNED", joinerId, `You own “${input.title.trim()}” for ${joiner.full_name}`);
      await this.audit(client, identity, "ONBOARDING_TASK_ADDED", "onboarding_task", task.id, null, { joinerId, title: input.title.trim(), phase: input.phase, ownerType: input.ownerType, dueDate: input.dueDate });
      return { task: this.presentTask(identity, await this.loadTask(client, identity, task.id), joiner) };
    });
  }

  // ---- documents ----------------------------------------------------------------------------------

  reviewDocument(identity: AuthIdentity, fileId: string, input: ReviewDocumentDto) {
    this.requireHr(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const file = (await client.query(`SELECT id, entity_id, category, original_name FROM stored_files WHERE organization_id=$1 AND id=$2 AND entity_type=$3 AND deleted_at IS NULL`,
        [identity.organizationId, fileId, ENTITY])).rows[0];
      if (!file) throw new NotFoundException("Document not found.");
      const joiner = await this.load(client, identity, file.entity_id, true);
      if (joiner.status === "WITHDRAWN") throw new ConflictException("This onboarding is closed.");
      const reason = input.reason?.trim() || null;
      if (input.decision === "REJECTED" && !reason) throw new BadRequestException("Tell the joiner why the document was rejected, e.g. blurred or expired.");
      const previous = (await client.query(`SELECT status FROM onboarding_document_reviews WHERE file_id=$1`, [fileId])).rows[0];
      await client.query(
        `INSERT INTO onboarding_document_reviews(file_id,organization_id,joiner_id,status,reason,reviewed_by) VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (file_id) DO UPDATE SET status=EXCLUDED.status, reason=EXCLUDED.reason, reviewed_by=EXCLUDED.reviewed_by, reviewed_at=now()`,
        [fileId, identity.organizationId, joiner.id, input.decision, reason, identity.employeeId]);
      const label = DOC_LABELS[file.category] || "Document";
      if (input.decision === "VERIFIED") {
        // Verifying closes the matching document task so the joiner and HR do not have to tick it twice.
        await client.query(
          `UPDATE onboarding_tasks SET status='DONE', note=coalesce(note,'Document verified by HR.'), completed_by=$4, completed_at=now(), version=version+1, updated_at=now()
            WHERE organization_id=$1 AND joiner_id=$2 AND requires_document AND document_category=$3 AND status='PENDING'`,
          [identity.organizationId, joiner.id, file.category, identity.employeeId]);
      } else {
        const verified = await client.query(
          `SELECT 1 FROM stored_files f JOIN onboarding_document_reviews r ON r.file_id=f.id AND r.status='VERIFIED'
            WHERE f.organization_id=$1 AND f.entity_type=$2 AND f.entity_id=$3 AND f.category=$4 AND f.deleted_at IS NULL LIMIT 1`,
          [identity.organizationId, ENTITY, joiner.id, file.category]);
        if (!verified.rowCount) {
          const reopened = await client.query(
            `UPDATE onboarding_tasks SET status='PENDING', completed_by=NULL, completed_at=NULL, note=$4, version=version+1, updated_at=now()
              WHERE organization_id=$1 AND joiner_id=$2 AND requires_document AND document_category=$3 AND status='DONE' RETURNING owner_id`,
            [identity.organizationId, joiner.id, file.category, `Document rejected: ${reason}`]);
          if (joiner.status === "READY_TO_JOIN" && reopened.rowCount)
            await client.query(`UPDATE onboarding_joiners SET status='PRE_BOARDING', ready_at=NULL, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`, [identity.organizationId, joiner.id]);
        }
        if (joiner.employee_id) await this.notify(client, identity, joiner.employee_id, "ONBOARDING_DOCUMENT_REJECTED", joiner.id, `Your ${label.toLowerCase()} needs to be re-uploaded: ${reason}`, { link: "/welcome" });
      }
      await this.audit(client, identity, `ONBOARDING_DOCUMENT_${input.decision}`, ENTITY, joiner.id, previous ? { status: previous.status } : null,
        { fileId, category: file.category, name: file.original_name, reason });
      return this.detail(client, identity, await this.load(client, identity, joiner.id));
    });
  }

  // ---- templates ----------------------------------------------------------------------------------

  templates(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      if (this.isHr(identity)) await this.ensureDefaultTemplate(client, identity);
      const rows = (await client.query(
        `SELECT t.id, t.name, t.description, t.is_default AS "isDefault", t.version, t.updated_at AS "updatedAt",
                (SELECT count(*) FROM onboarding_template_tasks x WHERE x.organization_id=t.organization_id AND x.template_id=t.id)::int AS "taskCount",
                (SELECT count(*) FROM onboarding_joiners j WHERE j.organization_id=t.organization_id AND j.template_id=t.id AND j.status IN ('PRE_BOARDING','READY_TO_JOIN','JOINED'))::int AS "activeJoiners"
           FROM onboarding_templates t WHERE t.organization_id=$1 AND t.archived_at IS NULL ORDER BY t.is_default DESC, t.name`, [identity.organizationId])).rows;
      return { items: rows, viewer: this.viewer(identity) };
    });
  }

  template(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => this.loadTemplate(client, identity, id));
  }

  saveTemplate(identity: AuthIdentity, id: string | null, input: SaveTemplateDto) {
    this.requireHr(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const errors: string[] = [];
      if (!input.tasks.length) errors.push("Add at least one task.");
      input.tasks.forEach((task, index) => {
        if (task.requiresDocument && !task.documentCategory) errors.push(`Task ${index + 1}: choose which document is required.`);
        const phaseOk = task.phase === "PRE_BOARDING" ? task.dueOffsetDays <= 0 : task.phase === "DAY_ONE" ? task.dueOffsetDays >= 0 && task.dueOffsetDays <= 1 : task.dueOffsetDays >= 0;
        if (!phaseOk) errors.push(`Task ${index + 1} (“${task.title}”): the due offset does not fit the ${PHASE_LABELS[task.phase].toLowerCase()} phase.`);
      });
      if (errors.length) throw new BadRequestException(errors);
      const name = input.name.trim();
      const clash = await client.query(`SELECT id FROM onboarding_templates WHERE organization_id=$1 AND lower(name)=lower($2) AND ($3::uuid IS NULL OR id <> $3::uuid)`, [identity.organizationId, name, id]);
      if (clash.rowCount) throw new ConflictException(`A template called “${name}” already exists.`);
      let templateId = id;
      let before: Row | null = null;
      if (id) {
        const current = (await client.query(`SELECT * FROM onboarding_templates WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, [identity.organizationId, id])).rows[0];
        if (!current) throw new NotFoundException("Template not found.");
        if (input.version !== current.version) throw new ConflictException("Someone else edited this template. Reload it and try again.");
        before = { name: current.name, tasks: Number((await client.query(`SELECT count(*) FROM onboarding_template_tasks WHERE organization_id=$1 AND template_id=$2`, [identity.organizationId, id])).rows[0].count) };
        if (current.is_default && input.isDefault === false) throw new BadRequestException("Make another template the default instead of unsetting this one.");
        await client.query(`UPDATE onboarding_templates SET name=$3, description=$4, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id, name, clean(input.description)]);
        await client.query(`DELETE FROM onboarding_template_tasks WHERE organization_id=$1 AND template_id=$2`, [identity.organizationId, id]);
      } else {
        const hasAny = (await client.query(`SELECT 1 FROM onboarding_templates WHERE organization_id=$1 AND archived_at IS NULL LIMIT 1`, [identity.organizationId])).rowCount;
        templateId = (await client.query(`INSERT INTO onboarding_templates(organization_id,name,description,is_default,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id`,
          [identity.organizationId, name, clean(input.description), !hasAny, identity.employeeId])).rows[0].id;
      }
      if (input.isDefault) {
        await client.query(`UPDATE onboarding_templates SET is_default=false WHERE organization_id=$1 AND id <> $2 AND is_default`, [identity.organizationId, templateId]);
        await client.query(`UPDATE onboarding_templates SET is_default=true WHERE organization_id=$1 AND id=$2`, [identity.organizationId, templateId]);
      }
      await this.insertTemplateTasks(client, identity, templateId!, input.tasks.map((task) => ({
        phase: task.phase, title: task.title.trim(), description: clean(task.description), ownerType: task.ownerType, dueOffsetDays: task.dueOffsetDays,
        documentCategory: task.requiresDocument ? task.documentCategory : undefined, completesOnConversion: !!task.completesOnConversion,
      })));
      await this.audit(client, identity, id ? "ONBOARDING_TEMPLATE_UPDATED" : "ONBOARDING_TEMPLATE_CREATED", "onboarding_template", templateId!, before, { name, tasks: input.tasks.length, isDefault: !!input.isDefault });
      return this.loadTemplate(client, identity, templateId!);
    });
  }

  archiveTemplate(identity: AuthIdentity, id: string) {
    this.requireHr(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const current = (await client.query(`SELECT * FROM onboarding_templates WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, [identity.organizationId, id])).rows[0];
      if (!current) throw new NotFoundException("Template not found.");
      if (current.is_default) throw new ConflictException("The default template cannot be archived. Make another template the default first.");
      await client.query(`UPDATE onboarding_templates SET archived_at=now(), version=version+1 WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id]);
      await this.audit(client, identity, "ONBOARDING_TEMPLATE_ARCHIVED", "onboarding_template", id, { name: current.name }, { archived: true });
      return { id, archived: true };
    });
  }

  // ---- settings -----------------------------------------------------------------------------------

  settings(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = await this.settingsRow(client, identity);
      const names = (await client.query(`SELECT id, full_name, designation FROM employees WHERE organization_id=$1 AND id = ANY($2::uuid[])`,
        [identity.organizationId, [row.hr_owner_id, row.it_owner_id, row.finance_owner_id].filter(Boolean)])).rows;
      const person = (id: string | null) => { const match = names.find((item) => item.id === id); return match ? { id: match.id, name: match.full_name, designation: match.designation } : null; };
      return {
        hrOwner: person(row.hr_owner_id), itOwner: person(row.it_owner_id), financeOwner: person(row.finance_owner_id),
        employeeNumberPrefix: row.employee_number_prefix, workEmailDomain: row.work_email_domain, welcomeMessage: row.welcome_message,
        version: row.version, saved: row.saved, viewer: this.viewer(identity),
      };
    });
  }

  saveSettings(identity: AuthIdentity, input: SaveSettingsDto) {
    this.requireHr(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const current = await this.settingsRow(client, identity, true);
      if (input.version !== current.version) throw new ConflictException("Settings changed since you opened them. Reload and try again.");
      const errors: string[] = [];
      for (const [key, label] of [["hrOwnerId", "HR owner"], ["itOwnerId", "IT owner"], ["financeOwnerId", "Finance owner"]] as const)
        if (input[key]) await this.requireEmployee(client, identity, input[key]!, label, errors);
      const domain = input.workEmailDomain === undefined ? current.work_email_domain : input.workEmailDomain.trim().toLowerCase() || null;
      if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) errors.push("Work email domain must look like company.com.");
      const welcome = input.welcomeMessage === undefined ? current.welcome_message : input.welcomeMessage.trim();
      if (!welcome) errors.push("Write a welcome message for new joiners.");
      if (errors.length) throw new BadRequestException(errors);
      const pick = (value: string | undefined, fallback: string | null) => value === undefined ? fallback : value || null;
      const next = {
        hr: pick(input.hrOwnerId, current.hr_owner_id), it: pick(input.itOwnerId, current.it_owner_id), finance: pick(input.financeOwnerId, current.finance_owner_id),
        prefix: input.employeeNumberPrefix || current.employee_number_prefix,
      };
      await client.query(
        `INSERT INTO onboarding_settings(organization_id,hr_owner_id,it_owner_id,finance_owner_id,employee_number_prefix,work_email_domain,welcome_message,version)
         VALUES($1,$2,$3,$4,$5,$6,$7,1)
         ON CONFLICT (organization_id) DO UPDATE SET hr_owner_id=EXCLUDED.hr_owner_id, it_owner_id=EXCLUDED.it_owner_id, finance_owner_id=EXCLUDED.finance_owner_id,
           employee_number_prefix=EXCLUDED.employee_number_prefix, work_email_domain=EXCLUDED.work_email_domain, welcome_message=EXCLUDED.welcome_message,
           version=onboarding_settings.version+1, updated_at=now()`,
        [identity.organizationId, next.hr, next.it, next.finance, next.prefix, domain, welcome]);
      // Hand open HR / IT / Finance tasks that still sit with the old default owner to the new one.
      const moves: [string, string | null, string | null][] = [["HR", current.hr_owner_id, next.hr], ["IT", current.it_owner_id, next.it], ["FINANCE", current.finance_owner_id, next.finance]];
      for (const [type, from, to] of moves) if (from !== to && to && from)
        await client.query(
          `UPDATE onboarding_tasks t SET owner_id=$4, version=t.version+1, updated_at=now() FROM onboarding_joiners j
            WHERE t.organization_id=$1 AND j.id=t.joiner_id AND j.organization_id=t.organization_id AND j.status IN ('PRE_BOARDING','READY_TO_JOIN','JOINED')
              AND t.status='PENDING' AND t.owner_type=$2 AND t.owner_id=$3`, [identity.organizationId, type, from, to]);
      await this.audit(client, identity, "ONBOARDING_SETTINGS_UPDATED", "onboarding_settings", identity.organizationId,
        { hrOwnerId: current.hr_owner_id, itOwnerId: current.it_owner_id, financeOwnerId: current.finance_owner_id, prefix: current.employee_number_prefix, domain: current.work_email_domain },
        { hrOwnerId: next.hr, itOwnerId: next.it, financeOwnerId: next.finance, prefix: next.prefix, domain });
      return { saved: true };
    }).then(() => this.settings(identity));
  }

  suggestWorkEmail(identity: AuthIdentity, id: string) {
    this.requireHr(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const row = await this.load(client, identity, id);
      if (row.employee_id) return { workEmail: row.work_email, employeeNumber: row.employee_number };
      const settings = await this.settingsRow(client, identity);
      const prefix = settings.employee_number_prefix;
      const next = Number((await client.query(
        `SELECT coalesce(max(substring(employee_number from '^' || $2 || '([0-9]+)$')::int), 0) + 1 AS n FROM employees WHERE organization_id=$1 AND employee_number ~ ('^' || $2 || '[0-9]+$')`,
        [identity.organizationId, prefix])).rows[0].n);
      return { workEmail: await this.suggestEmail(client, identity, row.full_name, settings), employeeNumber: `${prefix}${String(next).padStart(3, "0")}` };
    });
  }

  // ---- helpers ------------------------------------------------------------------------------------

  private isHr(identity: AuthIdentity) { return identity.roles.some((role) => HR_ROLES.includes(role)); }
  /** HR: decrypt the joiner's PAN for verification. Audited as PII_REVEALED. */
  revealPan(identity: AuthIdentity, id: string, reason?: string) {
    this.requireHr(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const row = await this.load(client, identity, id);
      if (!row.pan_enc) throw new NotFoundException("No PAN is on file for this joiner.");
      const value = decryptField(row.pan_enc, panContext(identity.organizationId, id));
      await this.audit(client, identity, "PII_REVEALED", ENTITY, id, null, { table: "onboarding_joiners", field: "pan", reason: reason?.trim() || null });
      return { field: "pan", value, masked: mask("pan", row.pan_last4) };
    });
  }

  /**
   * users is the global sign-in table (one row per person across brands), so this lookup deliberately runs on the owner
   * pool: a tenant-scoped query would only see employees/memberships of the current brand. Returns counts only.
   */
  private async globalUser(email: string, organizationId: string) {
    const row = (await this.database.systemQuery<{ id: string; employees: number; memberships: number; otherBrand: boolean }>(
      `SELECT u.id, (SELECT count(*)::int FROM employees e WHERE e.user_id=u.id) AS employees,
              (SELECT count(*)::int FROM organization_memberships m WHERE m.user_id=u.id) AS memberships,
              EXISTS(SELECT 1 FROM organization_memberships m WHERE m.user_id=u.id AND m.organization_id<>$2) AS "otherBrand"
         FROM users u WHERE lower(u.email)=lower($1) LIMIT 1`, [email, organizationId])).rows[0];
    return row || null;
  }

  /** Same PAN (blind index) on an active employee's payroll profile or another open joiner in this brand. */
  private async panDuplicate(client: PoolClient, identity: AuthIdentity, hash: string, joinerId: string, ownEmployeeId: string | null) {
    const row = (await client.query(
      `SELECT e.full_name || ' (' || e.employee_number || ')' AS who FROM payroll_profiles p JOIN employees e ON e.id=p.employee_id AND e.organization_id=p.organization_id
        WHERE p.organization_id=$1 AND p.pan_hash=$2 AND e.status='ACTIVE' AND ($4::uuid IS NULL OR p.employee_id<>$4)
       UNION ALL
       SELECT j.full_name || ' (joiner)' FROM onboarding_joiners j WHERE j.organization_id=$1 AND j.pan_hash=$2 AND j.id<>$3 AND j.status = ANY($5)
       LIMIT 1`, [identity.organizationId, hash, joinerId, ownEmployeeId, ["PRE_BOARDING", "READY_TO_JOIN"]])).rows[0];
    return (row?.who as string) || null;
  }

  private requireHr(identity: AuthIdentity) { if (!this.isHr(identity)) throw new ForbiddenException("Only HR can manage onboarding."); }
  private viewer(identity: AuthIdentity) {
    return { employeeId: identity.employeeId, roles: identity.roles, isHr: this.isHr(identity), isManager: identity.roles.includes("MANAGER") };
  }

  private expect(row: Row, from: string[], verb: string) {
    if (!from.includes(row.status)) throw new ConflictException(`${row.full_name} cannot be ${verb} while ${STATUS_LABELS[row.status].label.toLowerCase()}.`);
  }

  private async load(client: PoolClient, identity: AuthIdentity, id: string, lock = false) {
    if (!UUID.test(id)) throw new NotFoundException("Joiner not found.");
    const row = (await client.query(`${SELECT_JOINER} WHERE j.organization_id=$1 AND j.id=$2${lock ? " FOR UPDATE OF j" : ""}`, [identity.organizationId, id])).rows[0];
    if (!row || !(await this.access(client, identity, row))) throw new NotFoundException("Joiner not found.");
    return row;
  }

  private async access(client: PoolClient, identity: AuthIdentity, row: Row): Promise<Access | null> {
    if (this.isHr(identity)) return "hr";
    if (row.manager_id === identity.employeeId) return "manager";
    if (row.employee_id && row.employee_id === identity.employeeId) return "self";
    if (row.buddy_id === identity.employeeId) return "participant";
    const owns = await client.query(`SELECT 1 FROM onboarding_tasks WHERE organization_id=$1 AND joiner_id=$2 AND owner_id=$3 LIMIT 1`, [identity.organizationId, row.id, identity.employeeId]);
    return owns.rowCount ? "participant" : null;
  }

  private async loadTask(client: PoolClient, identity: AuthIdentity, id: string, lock = false) {
    if (!UUID.test(id)) throw new NotFoundException("Task not found.");
    const task = (await client.query(`${SELECT_TASK} WHERE t.organization_id=$1 AND t.id=$2${lock ? " FOR UPDATE OF t" : ""}`, [identity.organizationId, id])).rows[0];
    if (!task) throw new NotFoundException("Task not found.");
    return task;
  }

  private canWork(identity: AuthIdentity, task: Row) { return this.isHr(identity) || (!!task.owner_id && task.owner_id === identity.employeeId); }

  private async maybeComplete(client: PoolClient, identity: AuthIdentity, joinerId: string) {
    const row = (await client.query(`${SELECT_JOINER} WHERE j.organization_id=$1 AND j.id=$2`, [identity.organizationId, joinerId])).rows[0];
    if (row?.status !== "JOINED") return;
    const open = await client.query(`SELECT 1 FROM onboarding_tasks WHERE organization_id=$1 AND joiner_id=$2 AND status='PENDING' LIMIT 1`, [identity.organizationId, joinerId]);
    if (!open.rowCount) await this.markCompleted(client, identity, row, "All onboarding tasks closed.");
  }

  private async requireEmployee(client: PoolClient, identity: AuthIdentity, id: string, label: string, errors: string[]) {
    const ok = UUID.test(id) && (await client.query(`SELECT 1 FROM employees WHERE organization_id=$1 AND id=$2 AND status='ACTIVE'`, [identity.organizationId, id])).rowCount;
    if (!ok) errors.push(`${label} must be an active employee.`);
  }

  private resolveOwner(ownerType: string, joiner: Row, settings: Row): string | null {
    const hr = settings.hr_owner_id || joiner.created_by || null;
    switch (ownerType) {
      case "HR": return hr;
      case "IT": return settings.it_owner_id || hr;
      case "FINANCE": return settings.finance_owner_id || hr;
      case "MANAGER": return joiner.manager_id || hr;
      case "BUDDY": return joiner.buddy_id || joiner.manager_id || hr;
      case "JOINER": return joiner.employee_id || null;
      default: return hr;
    }
  }

  private async notifyOwners(client: PoolClient, identity: AuthIdentity, joiner: Row, prefix: string) {
    const owners = (await client.query(
      `SELECT owner_id, count(*)::int AS count, min(due_date) AS first_due FROM onboarding_tasks
        WHERE organization_id=$1 AND joiner_id=$2 AND status='PENDING' AND owner_id IS NOT NULL GROUP BY owner_id`, [identity.organizationId, joiner.id])).rows;
    for (const owner of owners) if (owner.owner_id !== identity.employeeId)
      await this.notify(client, identity, owner.owner_id, "ONBOARDING_TASKS_ASSIGNED", joiner.id,
        `${prefix} — you have ${owner.count} onboarding task${owner.count > 1 ? "s" : ""} (joins ${formatDate(joiner.joining_date)})`);
  }

  private async progress(client: PoolClient, identity: AuthIdentity, ids: string[]) {
    const map = new Map<string, { total: number; closed: number; overdue: number; percent: number; phases: Record<string, { total: number; closed: number; overdue: number; percent: number }>; nextTask: Row | null }>();
    if (!ids.length) return map;
    const rows = (await client.query(
      `SELECT joiner_id, phase, count(*)::int AS total, count(*) FILTER (WHERE status <> 'PENDING')::int AS closed,
              count(*) FILTER (WHERE status='PENDING' AND due_date < ${TODAY})::int AS overdue
         FROM onboarding_tasks WHERE organization_id=$1 AND joiner_id = ANY($2::uuid[]) GROUP BY joiner_id, phase`, [identity.organizationId, ids])).rows;
    const next = (await client.query(
      `SELECT DISTINCT ON (t.joiner_id) t.joiner_id, t.title, t.owner_type, to_char(t.due_date,'YYYY-MM-DD') AS due_date, o.full_name AS owner_name, (t.due_date < ${TODAY}) AS overdue
         FROM onboarding_tasks t LEFT JOIN employees o ON o.id=t.owner_id AND o.organization_id=t.organization_id
        WHERE t.organization_id=$1 AND t.joiner_id = ANY($2::uuid[]) AND t.status='PENDING' ORDER BY t.joiner_id, t.due_date, t.sort_order`, [identity.organizationId, ids])).rows;
    const pct = (closed: number, total: number) => total ? Math.round((closed / total) * 100) : 0;
    for (const id of ids) map.set(id, { total: 0, closed: 0, overdue: 0, percent: 0, phases: {}, nextTask: null });
    for (const row of rows) {
      const entry = map.get(row.joiner_id)!;
      entry.total += row.total; entry.closed += row.closed; entry.overdue += row.overdue;
      entry.phases[row.phase] = { total: row.total, closed: row.closed, overdue: row.overdue, percent: pct(row.closed, row.total) };
    }
    for (const entry of map.values()) entry.percent = pct(entry.closed, entry.total);
    for (const row of next) map.get(row.joiner_id)!.nextTask = { title: row.title, ownerType: row.owner_type, ownerName: row.owner_name, dueDate: row.due_date, overdue: row.overdue };
    return map;
  }

  private presentCard(identity: AuthIdentity, row: Row, progress?: Row) {
    const status = STATUS_LABELS[row.status];
    return {
      id: row.id, fullName: row.full_name, designation: row.designation, department: row.department, location: row.location,
      joiningDate: row.joining_date, daysToJoin: row.days_to_join, employmentType: row.employment_type,
      status: row.status, statusLabel: status.label, tone: status.tone, version: row.version,
      manager: row.manager_id ? { id: row.manager_id, name: row.manager_name, designation: row.manager_designation } : null,
      buddy: row.buddy_id ? { id: row.buddy_id, name: row.buddy_name, designation: row.buddy_designation } : null,
      employee: row.employee_id ? { id: row.employee_id, number: row.employee_number } : null,
      fromCandidate: !!row.candidate_case_id,
      progress: progress ? { total: progress.total, closed: progress.closed, overdue: progress.overdue, percent: progress.percent, phases: progress.phases } : null,
      nextTask: progress?.nextTask || null,
      relation: this.isHr(identity) ? "hr" : row.manager_id === identity.employeeId ? "manager" : row.buddy_id === identity.employeeId ? "buddy" : "owner",
    };
  }

  private presentJoiner(identity: AuthIdentity, row: Row, access: Access | null, progress?: Row) {
    const personal = access === "hr" || access === "manager" || access === "self";
    return {
      ...this.presentCard(identity, row, progress),
      personalEmail: personal ? row.personal_email : null, phone: personal ? row.phone : null,
      notes: access === "hr" ? row.notes : null,
      // Full PAN is never returned here; HR uses POST /joiners/:id/reveal (audited). panNumber stays for API compatibility.
      panNumber: null, panOnFile: !!row.pan_enc,
      panMasked: row.pan_enc && personal ? mask("pan", row.pan_last4) : null,
      aadhaarMasked: row.aadhaar_last4 && personal ? `XXXX XXXX ${row.aadhaar_last4}` : null,
      workEmail: row.work_email || null, templateName: row.template_name, templateId: row.template_id,
      candidateId: access === "hr" ? row.candidate_case_id : null,
      withdrawnReason: row.withdrawn_reason, createdAt: row.created_at, readyAt: row.ready_at, convertedAt: row.converted_at, completedAt: row.completed_at, withdrawnAt: row.withdrawn_at,
    };
  }

  private presentTask(identity: AuthIdentity, task: Row, joiner: Row) {
    const open = joiner.status !== "WITHDRAWN" && joiner.status !== "COMPLETED";
    const mine = !!task.owner_id && task.owner_id === identity.employeeId;
    const can = open && (this.isHr(identity) || mine);
    return {
      id: task.id, joinerId: task.joiner_id, phase: task.phase, phaseLabel: PHASE_LABELS[task.phase], title: task.title, description: task.description,
      ownerType: task.owner_type, ownerTypeLabel: OWNER_LABELS[task.owner_type],
      owner: task.owner_id ? { id: task.owner_id, name: task.owner_name, designation: task.owner_designation } : null,
      dueDate: task.due_date, daysLeft: task.days_left, overdue: !!task.overdue, status: task.status,
      requiresDocument: task.requires_document, documentCategory: task.document_category, documentLabel: task.document_category ? DOC_LABELS[task.document_category] : null,
      completesOnConversion: task.completes_on_conversion,
      note: task.note, completedAt: task.completed_at, completedBy: task.completed_by_name || null, version: task.version,
      mine, canAct: can, canEdit: open && this.isHr(identity),
    };
  }

  private joinerActions(identity: AuthIdentity, row: Row, tasks: Row[]) {
    if (!this.isHr(identity)) return [];
    const openPre = tasks.filter((task) => task.phase === "PRE_BOARDING" && task.status === "PENDING").length;
    const open = tasks.filter((task) => task.status === "PENDING").length;
    const actions: { action: string; label: string; intent: string; blockedReason?: string; noteRequired?: boolean }[] = [];
    if (row.status === "PRE_BOARDING")
      actions.push({ action: "ready", label: "Mark ready to join", intent: "primary", blockedReason: openPre ? `${openPre} before-joining task${openPre > 1 ? "s" : ""} still open` : undefined });
    if (row.status === "READY_TO_JOIN") {
      actions.push({ action: "convert", label: "Convert to employee", intent: "primary", blockedReason: row.days_to_join > 3 ? `Opens 3 days before joining (${formatDate(row.joining_date)})` : undefined });
      actions.push({ action: "back_to_preboarding", label: "Back to pre-boarding", intent: "neutral" });
    }
    if (row.status === "JOINED")
      actions.push({ action: "complete", label: "Mark onboarded", intent: "primary", blockedReason: open ? `${open} task${open > 1 ? "s" : ""} still open` : undefined });
    if (row.status === "PRE_BOARDING" || row.status === "READY_TO_JOIN")
      actions.push({ action: "withdraw", label: "Withdraw (offer declined)", intent: "danger", noteRequired: true });
    return actions;
  }

  private async settingsRow(client: PoolClient, identity: AuthIdentity, lock = false) {
    const row = (await client.query(`SELECT * FROM onboarding_settings WHERE organization_id=$1${lock ? " FOR UPDATE" : ""}`, [identity.organizationId])).rows[0];
    if (row) return { ...row, saved: true };
    // Sensible defaults until HR saves settings: the prefix and domain most employees already use.
    const guess = (await client.query(
      `SELECT (SELECT substring(employee_number from '^([A-Z]+)[0-9]+$') AS p FROM employees WHERE organization_id=$1 AND employee_number ~ '^[A-Z]+[0-9]+$'
                GROUP BY 1 ORDER BY count(*) DESC LIMIT 1) AS prefix,
              (SELECT split_part(lower(work_email),'@',2) FROM employees WHERE organization_id=$1 GROUP BY 1 ORDER BY count(*) DESC LIMIT 1) AS domain`,
      [identity.organizationId])).rows[0];
    return {
      organization_id: identity.organizationId, hr_owner_id: null, it_owner_id: null, finance_owner_id: null,
      employee_number_prefix: guess?.prefix || "EMP", work_email_domain: guess?.domain || null,
      welcome_message: "Welcome aboard! We are so glad you are here.", version: 0, saved: false,
    };
  }

  private async suggestEmail(client: PoolClient, identity: AuthIdentity, fullName: string, settings: Row) {
    const domain = settings.work_email_domain || "example.com";
    const parts = fullName.normalize("NFKD").replace(/[^\p{L}\s.-]/gu, "").toLowerCase().split(/\s+/).filter(Boolean);
    const base = (parts.length > 1 ? `${parts[0]}.${parts[parts.length - 1]}` : parts[0] || "joiner").replace(/[^a-z.-]/g, "") || "joiner";
    for (let n = 0; n < 50; n += 1) {
      const candidate = `${base}${n ? n + 1 : ""}@${domain}`;
      const used = await client.query(`SELECT 1 FROM employees WHERE organization_id=$1 AND lower(work_email)=$2 LIMIT 1`, [identity.organizationId, candidate]);
      if (!used.rowCount && !(await this.globalUser(candidate, identity.organizationId))) return candidate;
    }
    throw new ConflictException("Could not generate a free work email. Enter one manually.");
  }

  private async ensureDefaultTemplate(client: PoolClient, identity: AuthIdentity) {
    const existing = (await client.query(`SELECT id FROM onboarding_templates WHERE organization_id=$1 AND archived_at IS NULL ORDER BY is_default DESC, created_at LIMIT 1`, [identity.organizationId])).rows[0];
    if (existing) return existing.id as string;
    const template = (await client.query(
      `INSERT INTO onboarding_templates(organization_id,name,description,is_default,created_by) VALUES($1,$2,$3,true,$4)
       ON CONFLICT (organization_id,name) DO UPDATE SET archived_at=NULL, is_default=true RETURNING id`,
      [identity.organizationId, DEFAULT_TEMPLATE_NAME, DEFAULT_TEMPLATE_DESCRIPTION, identity.employeeId])).rows[0];
    const count = Number((await client.query(`SELECT count(*) FROM onboarding_template_tasks WHERE organization_id=$1 AND template_id=$2`, [identity.organizationId, template.id])).rows[0].count);
    if (!count) await this.insertTemplateTasks(client, identity, template.id, DEFAULT_TASKS);
    await this.audit(client, identity, "ONBOARDING_TEMPLATE_CREATED", "onboarding_template", template.id, null, { name: DEFAULT_TEMPLATE_NAME, tasks: DEFAULT_TASKS.length, source: "built-in" });
    return template.id as string;
  }

  private async insertTemplateTasks(client: PoolClient, identity: AuthIdentity, templateId: string,
    tasks: { phase: string; title: string; description?: string | null; ownerType: string; dueOffsetDays: number; documentCategory?: string; completesOnConversion?: boolean }[]) {
    let order = 0;
    for (const task of tasks) {
      order += 10;
      await client.query(
        `INSERT INTO onboarding_template_tasks(organization_id,template_id,phase,title,description,owner_type,due_offset_days,requires_document,document_category,completes_on_conversion,sort_order)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [identity.organizationId, templateId, task.phase, task.title, task.description || null, task.ownerType, task.dueOffsetDays,
          !!task.documentCategory, task.documentCategory || null, !!task.completesOnConversion, order]);
    }
  }

  private async loadTemplate(client: PoolClient, identity: AuthIdentity, id: string) {
    if (!UUID.test(id)) throw new NotFoundException("Template not found.");
    const template = (await client.query(
      `SELECT id, name, description, is_default AS "isDefault", version, updated_at AS "updatedAt" FROM onboarding_templates WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL`,
      [identity.organizationId, id])).rows[0];
    if (!template) throw new NotFoundException("Template not found.");
    const tasks = (await client.query(
      `SELECT id, phase, title, description, owner_type AS "ownerType", due_offset_days AS "dueOffsetDays", requires_document AS "requiresDocument",
              document_category AS "documentCategory", completes_on_conversion AS "completesOnConversion", sort_order AS "sortOrder"
         FROM onboarding_template_tasks WHERE organization_id=$1 AND template_id=$2 ORDER BY sort_order, id`, [identity.organizationId, id])).rows;
    return { ...template, tasks, viewer: this.viewer(identity) };
  }

  private notify(client: PoolClient, identity: AuthIdentity, employeeId: string, eventType: string, joinerId: string, message: string, extra: Row = {}) {
    return client.query(`INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload) VALUES($1,$2,$3,$4,$5,$6)`,
      [identity.organizationId, employeeId, eventType, ENTITY, joinerId, JSON.stringify({ message, module: "onboarding", link: `/onboarding/${joinerId}`, ...extra })]);
  }

  private audit(client: PoolClient, identity: AuthIdentity, action: string, entityType: string, entityId: string, before: unknown, after: unknown) {
    return client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [identity.organizationId, identity.userId, action, entityType, entityId, before === null ? null : JSON.stringify(before), JSON.stringify(after)]);
  }
}

function clean(value?: string | null) { const text = value?.trim(); return text ? text : null; }
function snake(key: string) { return ({ fullName: "full_name", personalEmail: "personal_email", managerId: "manager_id", joiningDate: "joining_date", employmentType: "employment_type" } as Record<string, string>)[key] || key; }
function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(new Date(`${value}T00:00:00+05:30`));
}

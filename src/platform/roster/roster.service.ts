import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import type { AssignmentInput, CopyWeekDto, SaveAssignmentsDto, SettingsDto, TemplateDto, UpdateTemplateDto, WeekQuery, WeekScopeDto } from "./roster.dto";
import {
  addDays, dayLabel, evaluatePerson, hours, matchCategory, mondayOf, overnight, paidMinutes, sameEntry, todayLocal, validDate, weekDates,
  type Entry, type RuleSettings, type Template, type Warning,
} from "./roster-rules";

const HR_ROLES = ["HR_ADMIN", "OWNER"];
const DEFAULT_TEMPLATES = [
  { code: "OPEN", name: "Opening", start: "07:00", end: "15:00", breakMinutes: 30, color: "#c9822b", min: 1, sort: 1 },
  { code: "MID", name: "Mid", start: "11:00", end: "19:00", breakMinutes: 30, color: "#0f8177", min: 1, sort: 2 },
  { code: "CLOSE", name: "Closing", start: "15:00", end: "23:00", breakMinutes: 30, color: "#5a4a93", min: 1, sort: 3 },
  { code: "GEN", name: "General", start: "09:30", end: "18:30", breakMinutes: 60, color: "#3a6ea5", min: 0, sort: 4 },
];

type Person = { id: string; name: string; number: string; designation: string | null; department: string | null; location: string | null; managerId: string | null };
type Settings = RuleSettings & { version: number };
type SnapshotEntry = Entry & { code?: string; name?: string; startTime?: string; endTime?: string; breakMinutes?: number; color?: string; hours?: number };
type Leave = { employeeId: string; start: string; end: string; status: string; type: string; code: string };

@Injectable()
export class RosterService {
  constructor(private readonly database: DatabaseService) {}

  // ---- read models ---------------------------------------------------------------------------

  context(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      await this.ensureDefaults(client, identity);
      const reports = (await client.query(`SELECT count(*)::int AS n FROM employees WHERE organization_id=$1 AND manager_id=$2 AND status='ACTIVE'`,
        [identity.organizationId, identity.employeeId])).rows[0].n as number;
      const facets = (await client.query(
        `SELECT array_remove(array_agg(DISTINCT department ORDER BY department),NULL) AS departments,
                array_remove(array_agg(DISTINCT location ORDER BY location),NULL) AS locations
           FROM employees WHERE organization_id=$1 AND status='ACTIVE'`, [identity.organizationId])).rows[0];
      const isHr = this.isHr(identity);
      const today = todayLocal();
      return {
        viewer: { employeeId: identity.employeeId, roles: identity.roles, isHr, reportCount: reports, canPlan: isHr || reports > 0 },
        templates: await this.templates(client, identity), settings: await this.settings(client, identity),
        departments: isHr ? facets.departments : [], locations: isHr ? facets.locations : [],
        today, currentWeekStart: mondayOf(today),
      };
    });
  }

  week(identity: AuthIdentity, query: WeekQuery) {
    const start = this.weekStart(query.start);
    const scope = query.scope || (this.isHr(identity) ? "all" : "team");
    if (scope === "all" && !this.isHr(identity)) throw new ForbiddenException("Only HR can plan rosters outside their own team.");
    return this.database.tenantTransaction(identity, async (client) => {
      await this.ensureDefaults(client, identity);
      const values: unknown[] = [identity.organizationId];
      const param = (value: unknown) => { values.push(value); return `$${values.length}`; };
      const where = ["e.organization_id=$1", "e.status='ACTIVE'"];
      if (scope === "team") where.push(`e.manager_id=${param(identity.employeeId)}`);
      if (query.department) where.push(`e.department=${param(query.department)}`);
      if (query.location) where.push(`e.location=${param(query.location)}`);
      if (query.search?.trim()) { const term = param(query.search.trim()); where.push(`(e.full_name ILIKE '%'||${term}||'%' OR e.employee_number ILIKE '%'||${term}||'%')`); }
      const people = (await client.query(
        `SELECT e.id, e.full_name AS name, e.employee_number AS number, e.designation, e.department, e.location, e.manager_id AS "managerId"
           FROM employees e WHERE ${where.join(" AND ")} ORDER BY e.department NULLS LAST, e.full_name, e.id LIMIT 300`, values)).rows as Person[];
      if (scope === "team" && !people.length && !this.isHr(identity)) {
        const reports = await client.query(`SELECT 1 FROM employees WHERE organization_id=$1 AND manager_id=$2 AND status='ACTIVE' LIMIT 1`, [identity.organizationId, identity.employeeId]);
        if (!reports.rowCount) throw new ForbiddenException("You have no direct reports to plan a roster for.");
      }
      return this.buildWeek(client, identity, start, people, scope);
    });
  }

  /** The signed-in employee's published roster for two weeks (drafts are never shown to employees). */
  mine(identity: AuthIdentity, startInput?: string) {
    const start = this.weekStart(startInput);
    return this.database.tenantTransaction(identity, async (client) => {
      await this.ensureDefaults(client, identity);
      const today = todayLocal();
      const weeks = [];
      for (const weekStart of [start, addDays(start, 7)]) weeks.push(await this.personalWeek(client, identity, identity.employeeId, weekStart, today));
      const me = (await client.query(`SELECT full_name AS name, designation, location FROM employees WHERE organization_id=$1 AND id=$2`, [identity.organizationId, identity.employeeId])).rows[0];
      return { employee: me || null, today, weeks, settings: await this.settings(client, identity) };
    });
  }

  /** Dashboard widget: today's published shift, plus the next upcoming one. */
  today(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const today = todayLocal();
      const thisWeek = await this.personalWeek(client, identity, identity.employeeId, mondayOf(today), today);
      const nextWeek = await this.personalWeek(client, identity, identity.employeeId, addDays(mondayOf(today), 7), today);
      const day = thisWeek.days.find((item) => item.date === today)!;
      const status = day.leave?.status === "APPROVED" ? "LEAVE" : day.entry ? day.entry.kind : thisWeek.published ? "UNPLANNED" : "UNPUBLISHED";
      const upcoming = [...thisWeek.days, ...nextWeek.days].find((item) => item.date > today && item.entry?.kind === "SHIFT" && item.leave?.status !== "APPROVED");
      return {
        date: today, status, shift: day.entry?.kind === "SHIFT" ? day.entry : null, leave: day.leave, weekHours: thisWeek.hours,
        next: upcoming ? { date: upcoming.date, ...upcoming.entry } : null, link: "/roster",
      };
    });
  }

  // ---- planning --------------------------------------------------------------------------------

  saveAssignments(identity: AuthIdentity, input: SaveAssignmentsDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const keys = new Set<string>();
      for (const item of input.items) {
        if (!validDate(item.date)) throw new BadRequestException(`${item.date} is not a valid date.`);
        const key = `${item.employeeId}:${item.date}`;
        if (keys.has(key)) throw new BadRequestException("Each person and day can only appear once per save.");
        keys.add(key);
        if (item.kind === "SHIFT" && !item.templateId) throw new BadRequestException("Choose a shift template for a shift.");
      }
      const people = await this.manageable(client, identity, input.items.map((item) => item.employeeId));
      const result = await this.apply(client, identity, input.items, people, input.source || "MANUAL", null, !!input.skipConflicts);
      return result;
    });
  }

  copyPreviousWeek(identity: AuthIdentity, input: CopyWeekDto) {
    const start = this.weekStart(input.start, true);
    return this.database.tenantTransaction(identity, async (client) => {
      const people = await this.manageable(client, identity, input.employeeIds);
      const from = addDays(start, -7);
      const source = (await client.query(
        `SELECT a.employee_id, to_char(a.work_date,'YYYY-MM-DD') AS date, a.kind, a.template_id, a.location, a.note, t.is_active
           FROM roster_assignments a LEFT JOIN roster_shift_templates t ON t.id=a.template_id AND t.organization_id=a.organization_id
          WHERE a.organization_id=$1 AND a.employee_id = ANY($2) AND a.work_date BETWEEN $3 AND $4`,
        [identity.organizationId, [...people.keys()], from, addDays(from, 6)])).rows;
      if (!source.length) throw new BadRequestException("The previous week has nothing planned for these people.");
      const existing = await this.entries(client, identity, [...people.keys()], start, addDays(start, 6));
      const items: AssignmentInput[] = [];
      let kept = 0, inactive = 0;
      for (const row of source) {
        if (row.kind === "SHIFT" && !row.is_active) { inactive += 1; continue; }
        const date = addDays(row.date, 7);
        if (!input.overwrite && existing.get(row.employee_id)?.has(date)) { kept += 1; continue; }
        items.push({ employeeId: row.employee_id, date, kind: row.kind, templateId: row.template_id || undefined, location: row.location || "", note: row.note || "" });
      }
      const result = items.length ? await this.apply(client, identity, items, people, "COPY", null, true) : { saved: 0, cleared: 0, unchanged: 0, skipped: [] };
      return { ...result, kept, inactive };
    });
  }

  clearWeek(identity: AuthIdentity, input: WeekScopeDto) {
    const start = this.weekStart(input.start, true);
    return this.database.tenantTransaction(identity, async (client) => {
      const people = await this.manageable(client, identity, input.employeeIds);
      const removed = (await client.query(
        `DELETE FROM roster_assignments WHERE organization_id=$1 AND employee_id = ANY($2) AND work_date BETWEEN $3 AND $4
         RETURNING id, employee_id, to_char(work_date,'YYYY-MM-DD') AS date, kind, template_id`,
        [identity.organizationId, [...people.keys()], start, addDays(start, 6)])).rows;
      const byPerson = new Map<string, unknown[]>();
      for (const row of removed) byPerson.set(row.employee_id, [...(byPerson.get(row.employee_id) || []), row]);
      for (const [employeeId, rows] of byPerson)
        await this.audit(client, identity, "ROSTER_WEEK_CLEARED", "roster_week", employeeId, { weekStart: start, assignments: rows }, null);
      return { cleared: removed.length };
    });
  }

  publish(identity: AuthIdentity, input: WeekScopeDto) {
    const start = this.weekStart(input.start, true);
    return this.database.tenantTransaction(identity, async (client) => {
      const people = await this.manageable(client, identity, input.employeeIds);
      const ids = [...people.keys()];
      const templates = new Map((await this.templates(client, identity)).map((template) => [template.id, template]));
      const live = await this.entries(client, identity, ids, start, addDays(start, 6));
      const publications = await this.publications(client, identity, ids, start);
      const actor = (await client.query(`SELECT full_name FROM employees WHERE organization_id=$1 AND id=$2`, [identity.organizationId, identity.employeeId])).rows[0]?.full_name || "Your manager";
      let published = 0, updated = 0, unchanged = 0, empty = 0;
      for (const id of ids) {
        const current = live.get(id) || new Map<string, Entry>();
        const previous = publications.get(id);
        if (!previous && !current.size) { empty += 1; continue; }
        const changed = this.diff(start, current, previous?.snapshot);
        if (previous && !changed.length) { unchanged += 1; continue; }
        const snapshot = weekDates(start).filter((date) => current.has(date)).map((date) => this.snapshotEntry(current.get(date)!, templates));
        const row = (await client.query(
          `INSERT INTO roster_publications(organization_id,employee_id,week_start,snapshot,published_by)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT (organization_id,employee_id,week_start) DO UPDATE SET snapshot=EXCLUDED.snapshot, published_by=EXCLUDED.published_by,
             published_at=now(), revision=roster_publications.revision+1
           RETURNING id, revision`,
          [identity.organizationId, id, start, JSON.stringify(snapshot), identity.employeeId])).rows[0];
        const paid = snapshot.reduce((sum, entry) => sum + (entry.hours || 0), 0);
        const shifts = snapshot.filter((entry) => entry.kind === "SHIFT");
        const range = `${dayLabel(start)} – ${dayLabel(addDays(start, 6))}`;
        const message = previous
          ? `${actor} updated your roster for ${range}: ${changed.map((date) => `${dayLabel(date)} → ${this.describe(current.get(date), templates)}`).slice(0, 3).join("; ")}${changed.length > 3 ? ` and ${changed.length - 3} more` : ""}.`
          : `Your roster for ${range} is published: ${shifts.length} shift${shifts.length === 1 ? "" : "s"} · ${Math.round(paid * 10) / 10} h.`;
        await client.query(
          `INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload) VALUES($1,$2,$3,'roster_publication',$4,$5)`,
          [identity.organizationId, id, previous ? "ROSTER_UPDATED" : "ROSTER_PUBLISHED", row.id,
            JSON.stringify({ message, weekStart: start, revision: row.revision, changedDates: previous ? changed : undefined, link: "/roster", by: actor })]);
        await this.audit(client, identity, previous ? "ROSTER_REPUBLISHED" : "ROSTER_PUBLISHED", "roster_publication", row.id,
          { weekStart: start, employeeId: id, revision: row.revision, snapshot }, previous ? { snapshot: previous.snapshot, revision: previous.revision } : null);
        if (previous) updated += 1; else published += 1;
      }
      return { published, updated, unchanged, empty, notified: published + updated };
    });
  }

  /** Applies an approved shift-change request (and the swap with a colleague, if any) to the roster. */
  applyShiftRequest(identity: AuthIdentity, caseId: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const request = (await client.query(
        `SELECT id, case_number, category, requester_id, subject_employee_id, status,
                to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(coalesce(end_date,start_date),'YYYY-MM-DD') AS end_date
           FROM hr_cases WHERE organization_id=$1 AND id=$2 AND module='shifts' FOR UPDATE`, [identity.organizationId, caseId])).rows[0];
      if (!request) throw new NotFoundException("Shift request not found.");
      if (request.status !== "APPROVED") throw new ConflictException(`${request.case_number} is not approved, so it cannot be applied.`);
      if (!request.start_date) throw new BadRequestException(`${request.case_number} has no dates.`);
      const dates: string[] = [];
      for (let date = request.start_date; date <= request.end_date; date = addDays(date, 1)) dates.push(date);
      if (dates.length > 31) throw new BadRequestException("Shift requests longer than 31 days must be planned manually.");
      const templates = await this.templates(client, identity);
      const target = matchCategory(request.category, templates);
      if (!target) throw new BadRequestException(`No active shift template matches “${request.category}”. Add one in Shift templates first.`);
      const involved = [request.requester_id, request.subject_employee_id].filter(Boolean) as string[];
      const people = await this.manageable(client, identity, involved);
      const current = await this.entries(client, identity, involved, dates[0], dates[dates.length - 1]);
      const items: AssignmentInput[] = [];
      const swaps: AssignmentInput[] = [];
      for (const date of dates) {
        const before = current.get(request.requester_id)?.get(date);
        items.push({ employeeId: request.requester_id, date, kind: target.kind, templateId: target.templateId || undefined });
        // A swap hands the requester's original plan for that day to the colleague.
        if (request.subject_employee_id && before && !(before.kind === target.kind && before.templateId === target.templateId))
          swaps.push({ employeeId: request.subject_employee_id, date, kind: before.kind, templateId: before.templateId || undefined, location: before.location || "" });
      }
      const result = await this.apply(client, identity, [...items, ...swaps], people, "SHIFT_REQUEST", request.id, true);
      await this.audit(client, identity, "ROSTER_SHIFT_REQUEST_APPLIED", "hr_case", request.id, { caseNumber: request.case_number, target, dates, swapped: swaps.length }, null);
      return { ...result, caseNumber: request.case_number, target: target.label, swapped: swaps.length };
    });
  }

  // ---- templates & settings (HR) -----------------------------------------------------------------

  listTemplates(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      await this.ensureDefaults(client, identity);
      return { items: await this.templates(client, identity), settings: await this.settings(client, identity) };
    });
  }

  createTemplate(identity: AuthIdentity, input: TemplateDto) {
    this.requireHr(identity);
    this.checkTemplate(input);
    return this.database.tenantTransaction(identity, async (client) => {
      const sort = (await client.query(`SELECT coalesce(max(sort_order),0)+1 AS n FROM roster_shift_templates WHERE organization_id=$1`, [identity.organizationId])).rows[0].n;
      const row = (await client.query(
        `INSERT INTO roster_shift_templates(organization_id,code,name,start_time,end_time,break_minutes,color,min_headcount,is_active,sort_order)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (organization_id,code) DO NOTHING RETURNING id`,
        [identity.organizationId, input.code, input.name.trim(), input.startTime, input.endTime, input.breakMinutes, input.color.toLowerCase(), input.minHeadcount, input.active ?? true, sort])).rows[0];
      if (!row) throw new ConflictException(`A shift template with code ${input.code} already exists.`);
      await this.audit(client, identity, "ROSTER_TEMPLATE_CREATED", "roster_shift_template", row.id, input, null);
      return (await this.templates(client, identity)).find((template) => template.id === row.id);
    });
  }

  updateTemplate(identity: AuthIdentity, id: string, input: UpdateTemplateDto) {
    this.requireHr(identity);
    this.checkTemplate(input);
    return this.database.tenantTransaction(identity, async (client) => {
      const before = (await client.query(`SELECT * FROM roster_shift_templates WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [identity.organizationId, id])).rows[0];
      if (!before) throw new NotFoundException("Shift template not found.");
      if (before.version !== input.version) throw new ConflictException("This template changed since you opened it. Refresh and try again.");
      const clash = await client.query(`SELECT 1 FROM roster_shift_templates WHERE organization_id=$1 AND code=$2 AND id<>$3`, [identity.organizationId, input.code, id]);
      if (clash.rowCount) throw new ConflictException(`A shift template with code ${input.code} already exists.`);
      await client.query(
        `UPDATE roster_shift_templates SET code=$3,name=$4,start_time=$5,end_time=$6,break_minutes=$7,color=$8,min_headcount=$9,is_active=$10,version=version+1,updated_at=now()
          WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, id, input.code, input.name.trim(), input.startTime, input.endTime, input.breakMinutes, input.color.toLowerCase(), input.minHeadcount, input.active ?? true]);
      const { version: _version, ...after } = input;
      await this.audit(client, identity, "ROSTER_TEMPLATE_UPDATED", "roster_shift_template", id, after, before);
      return (await this.templates(client, identity)).find((template) => template.id === id);
    });
  }

  updateSettings(identity: AuthIdentity, input: SettingsDto) {
    this.requireHr(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      await this.ensureDefaults(client, identity);
      const before = (await client.query(`SELECT * FROM roster_settings WHERE organization_id=$1 FOR UPDATE`, [identity.organizationId])).rows[0];
      if (before.version !== input.version) throw new ConflictException("Roster rules changed since you opened them. Refresh and try again.");
      await client.query(`UPDATE roster_settings SET min_rest_hours=$2,max_weekly_hours=$3,max_consecutive_days=$4,version=version+1,updated_at=now() WHERE organization_id=$1`,
        [identity.organizationId, input.minRestHours, input.maxWeeklyHours, input.maxConsecutiveDays]);
      await this.audit(client, identity, "ROSTER_SETTINGS_UPDATED", "roster_settings", identity.organizationId, input, before);
      return this.settings(client, identity);
    });
  }

  // ---- internals ------------------------------------------------------------------------------

  private async buildWeek(client: PoolClient, identity: AuthIdentity, start: string, people: Person[], scope: string) {
    const ids = people.map((person) => person.id);
    const days = weekDates(start);
    const end = days[6];
    const today = todayLocal();
    const allTemplates = await this.templates(client, identity);
    const templates = new Map(allTemplates.map((template) => [template.id, template]));
    const settings = await this.settings(client, identity);
    const entries = await this.entries(client, identity, ids, addDays(start, -6), end, true);
    const leaves = await this.leaves(client, identity, ids, addDays(start, -6), end);
    const publications = await this.publications(client, identity, ids, start);
    const requests = await this.shiftRequests(client, identity, ids, start, end, allTemplates);

    const coverage = days.map((date) => ({ date, counts: new Map<string, number>(), working: 0, off: 0, leave: 0 }));
    const rows = people.map((person) => {
      const mine = entries.get(person.id) || new Map<string, Entry & { version?: number; source?: string; caseId?: string | null }>();
      const approvedLeave = new Set<string>();
      const leaveByDate = new Map<string, Leave>();
      for (const leave of leaves.filter((item) => item.employeeId === person.id))
        for (let date = leave.start; date <= leave.end; date = addDays(date, 1)) {
          if (leave.status === "APPROVED") approvedLeave.add(date);
          if (!leaveByDate.has(date) || leave.status === "APPROVED") leaveByDate.set(date, leave);
        }
      const evaluation = evaluatePerson(days, mine, approvedLeave, templates, settings);
      const publication = publications.get(person.id);
      const liveWeek = new Map(days.filter((date) => mine.has(date)).map((date) => [date, mine.get(date)!]));
      const changed = new Set(publication ? this.diff(start, liveWeek, publication.snapshot) : []);
      const cells = days.map((date, index) => {
        const entry = mine.get(date) as (Entry & { id?: string; version?: number; source?: string; caseId?: string | null }) | undefined;
        const leave = leaveByDate.get(date);
        if (entry?.kind === "SHIFT" && entry.templateId && !approvedLeave.has(date)) {
          coverage[index].counts.set(entry.templateId, (coverage[index].counts.get(entry.templateId) || 0) + 1);
          coverage[index].working += 1;
        } else if (approvedLeave.has(date)) coverage[index].leave += 1;
        else if (entry?.kind === "WEEKLY_OFF") coverage[index].off += 1;
        const request = requests.find((item) => date >= item.startDate && date <= item.endDate && (item.requester.id === person.id || item.subject?.id === person.id));
        return {
          date,
          assignment: entry ? { id: entry.id, kind: entry.kind, templateId: entry.templateId, location: entry.location, note: entry.note, version: entry.version, source: entry.source, caseId: entry.caseId } : null,
          leave: leave ? { type: leave.type, code: leave.code, status: leave.status } : null,
          warnings: evaluation.cellWarnings.get(date) || [],
          changed: changed.has(date),
          request: request ? { id: request.id, caseNumber: request.caseNumber, label: request.target?.label || request.category, applied: request.applied, role: request.requester.id === person.id ? "requester" : "swap" } : null,
        };
      });
      const state = !publication ? (liveWeek.size ? "DRAFT" : "EMPTY") : changed.size ? "CHANGED" : "PUBLISHED";
      return {
        employee: { id: person.id, name: person.name, number: person.number, designation: person.designation, department: person.department, location: person.location },
        cells, hours: hours(evaluation.paidMinutes), shifts: evaluation.shifts, offs: evaluation.offs,
        warnings: evaluation.rowWarnings,
        warningCount: evaluation.rowWarnings.length + cells.reduce((sum, cell) => sum + cell.warnings.length, 0),
        publication: { state, publishedAt: publication?.publishedAt || null, revision: publication?.revision || 0, changes: changed.size },
      };
    });

    const coverageRows = coverage.map((day) => {
      const slots = allTemplates.filter((template) => template.active || day.counts.has(template.id)).map((template) => {
        const count = day.counts.get(template.id) || 0;
        return { templateId: template.id, code: template.code, name: template.name, color: template.color, count, min: template.minHeadcount, short: Math.max(0, template.minHeadcount - count) };
      }).filter((slot) => slot.min > 0 || slot.count > 0);
      return { date: day.date, working: day.working, off: day.off, leave: day.leave, slots, gaps: slots.reduce((sum, slot) => sum + slot.short, 0) };
    });

    const states = rows.map((row) => row.publication.state).filter((state) => state !== "EMPTY");
    const publicationState = !states.length ? "EMPTY" : states.every((state) => state === "PUBLISHED") ? "PUBLISHED"
      : states.every((state) => state === "DRAFT") ? "DRAFT" : "CHANGED";
    const lastPublishedAt = rows.map((row) => row.publication.publishedAt).filter(Boolean).sort().pop() || null;
    const pending = rows.reduce((sum, row) => sum + (row.publication.state === "DRAFT" ? row.cells.filter((cell) => cell.assignment).length : row.publication.changes), 0);
    return {
      weekStart: start, weekEnd: end, previousWeek: addDays(start, -7), nextWeek: addDays(start, 7), today, scope,
      days: days.map((date) => ({ date, isToday: date === today, isPast: date < today })),
      settings, templates: allTemplates,
      people: rows,
      coverage: coverageRows,
      publication: {
        state: publicationState, lastPublishedAt, pendingChanges: pending,
        draftPeople: rows.filter((row) => row.publication.state === "DRAFT").length,
        changedPeople: rows.filter((row) => row.publication.state === "CHANGED").length,
        publishedPeople: rows.filter((row) => row.publication.state === "PUBLISHED").length,
      },
      requests,
      summary: {
        hours: Math.round(rows.reduce((sum, row) => sum + row.hours, 0) * 10) / 10,
        shifts: rows.reduce((sum, row) => sum + row.shifts, 0),
        warnings: rows.reduce((sum, row) => sum + row.warningCount, 0),
        gaps: coverageRows.reduce((sum, day) => sum + day.gaps, 0),
        unplanned: rows.reduce((sum, row) => sum + row.cells.filter((cell) => !cell.assignment && cell.leave?.status !== "APPROVED").length, 0),
        onLeave: rows.reduce((sum, row) => sum + row.cells.filter((cell) => cell.leave?.status === "APPROVED").length, 0),
        pendingRequests: requests.filter((request) => !request.applied && request.target).length,
      },
    };
  }

  private async personalWeek(client: PoolClient, identity: AuthIdentity, employeeId: string, start: string, today: string) {
    const publication = (await this.publications(client, identity, [employeeId], start)).get(employeeId);
    const leaves = await this.leaves(client, identity, [employeeId], start, addDays(start, 6));
    const snapshot = new Map((publication?.snapshot || []).map((entry) => [entry.date, entry]));
    const days = weekDates(start).map((date) => {
      const leave = leaves.find((item) => date >= item.start && date <= item.end && item.status === "APPROVED")
        || leaves.find((item) => date >= item.start && date <= item.end);
      return { date, isToday: date === today, entry: snapshot.get(date) || null, leave: leave ? { type: leave.type, code: leave.code, status: leave.status } : null };
    });
    const worked = days.filter((day) => day.entry?.kind === "SHIFT" && day.leave?.status !== "APPROVED");
    return {
      weekStart: start, weekEnd: addDays(start, 6), published: !!publication, publishedAt: publication?.publishedAt || null, revision: publication?.revision || 0,
      days, shifts: worked.length, hours: Math.round(worked.reduce((sum, day) => sum + (day.entry?.hours || 0), 0) * 100) / 100,
    };
  }

  /** Upserts/clears cells after authorization; enforces leave blocks and optimistic versions. */
  private async apply(client: PoolClient, identity: AuthIdentity, items: AssignmentInput[], people: Map<string, Person>, source: string, caseId: string | null, skipConflicts: boolean) {
    const templates = new Map((await this.templates(client, identity)).map((template) => [template.id, template]));
    const dates = items.map((item) => item.date).sort();
    const leaves = (await this.leaves(client, identity, [...people.keys()], dates[0], dates[dates.length - 1])).filter((leave) => leave.status === "APPROVED");
    let saved = 0, cleared = 0, unchanged = 0;
    const skipped: { employeeId: string; date: string; reason: string }[] = [];
    for (const item of items) {
      const person = people.get(item.employeeId)!;
      if (item.kind === "SHIFT") {
        const template = templates.get(item.templateId!);
        if (!template) throw new BadRequestException("That shift template does not exist.");
        if (!template.active) throw new BadRequestException(`${template.name} is inactive — reactivate it in Shift templates to plan it.`);
      }
      const leave = leaves.find((row) => row.employeeId === item.employeeId && item.date >= row.start && item.date <= row.end);
      if (leave && item.kind !== "CLEAR") {
        const reason = `${person.name} is on approved ${leave.type} on ${dayLabel(item.date)}.`;
        if (skipConflicts) { skipped.push({ employeeId: item.employeeId, date: item.date, reason }); continue; }
        throw new BadRequestException(reason);
      }
      const existing = (await client.query(
        `SELECT id, kind, template_id AS "templateId", location, note, version, source, source_case_id FROM roster_assignments
          WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3 FOR UPDATE`, [identity.organizationId, item.employeeId, item.date])).rows[0];
      if (item.version !== undefined && (existing?.version || 0) !== item.version)
        throw new ConflictException(`${person.name}'s ${dayLabel(item.date)} was changed by someone else. Refresh to see the latest roster.`);
      if (item.kind === "CLEAR") {
        if (!existing) { unchanged += 1; continue; }
        await client.query(`DELETE FROM roster_assignments WHERE organization_id=$1 AND id=$2`, [identity.organizationId, existing.id]);
        await this.audit(client, identity, "ROSTER_ASSIGNMENT_CLEARED", "roster_assignment", existing.id, null, { employeeId: item.employeeId, date: item.date, ...existing });
        cleared += 1; continue;
      }
      const next = {
        kind: item.kind, templateId: item.kind === "SHIFT" ? item.templateId! : null,
        location: item.location === undefined ? existing?.location ?? null : item.location.trim() || null,
        note: item.note === undefined ? existing?.note ?? null : item.note.trim() || null,
      };
      if (existing && sameEntry(existing, next) && (existing.source_case_id || null) === caseId) { unchanged += 1; continue; }
      const row = (await client.query(
        `INSERT INTO roster_assignments(organization_id,employee_id,work_date,kind,template_id,location,note,source,source_case_id,created_by,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
         ON CONFLICT (organization_id,employee_id,work_date) DO UPDATE SET kind=EXCLUDED.kind, template_id=EXCLUDED.template_id, location=EXCLUDED.location,
           note=EXCLUDED.note, source=EXCLUDED.source, source_case_id=EXCLUDED.source_case_id, updated_by=EXCLUDED.updated_by,
           version=roster_assignments.version+1, updated_at=now()
         RETURNING id, version`,
        [identity.organizationId, item.employeeId, item.date, next.kind, next.templateId, next.location, next.note, source, caseId, identity.employeeId])).rows[0];
      await this.audit(client, identity, existing ? "ROSTER_ASSIGNMENT_UPDATED" : "ROSTER_ASSIGNMENT_CREATED", "roster_assignment", row.id,
        { employeeId: item.employeeId, date: item.date, ...next, source, caseId }, existing || null);
      saved += 1;
    }
    return { saved, cleared, unchanged, skipped };
  }

  /** People the viewer may plan for: HR → any active employee; everyone else → active direct reports only. */
  private async manageable(client: PoolClient, identity: AuthIdentity, employeeIds: string[]) {
    const unique = [...new Set(employeeIds)];
    const rows = (await client.query(
      `SELECT id, full_name AS name, employee_number AS number, designation, department, location, manager_id AS "managerId"
         FROM employees WHERE organization_id=$1 AND id = ANY($2) AND status='ACTIVE'`, [identity.organizationId, unique])).rows as Person[];
    if (rows.length !== unique.length) throw new NotFoundException("One or more people were not found or are no longer active.");
    if (!this.isHr(identity)) {
      const outside = rows.filter((row) => row.managerId !== identity.employeeId);
      if (outside.length) throw new ForbiddenException(`You can only plan rosters for your direct reports (${outside.map((row) => row.name).join(", ")} is not).`);
    }
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async entries(client: PoolClient, identity: AuthIdentity, ids: string[], from: string, to: string, withMeta = false) {
    const rows = (await client.query(
      `SELECT id, employee_id, to_char(work_date,'YYYY-MM-DD') AS date, kind, template_id AS "templateId", location, note, version, source, source_case_id AS "caseId"
         FROM roster_assignments WHERE organization_id=$1 AND employee_id = ANY($2) AND work_date BETWEEN $3 AND $4`,
      [identity.organizationId, ids, from, to])).rows;
    const map = new Map<string, Map<string, Entry & { id?: string; version?: number; source?: string; caseId?: string | null }>>();
    for (const row of rows) {
      if (!map.has(row.employee_id)) map.set(row.employee_id, new Map());
      const entry: Entry & { id?: string; version?: number; source?: string; caseId?: string | null } = { date: row.date, kind: row.kind, templateId: row.templateId, location: row.location, note: row.note };
      if (withMeta) Object.assign(entry, { id: row.id, version: row.version, source: row.source, caseId: row.caseId });
      map.get(row.employee_id)!.set(row.date, entry);
    }
    return map;
  }

  private async leaves(client: PoolClient, identity: AuthIdentity, ids: string[], from: string, to: string): Promise<Leave[]> {
    return (await client.query(
      `SELECT l.employee_id AS "employeeId", to_char(l.start_date,'YYYY-MM-DD') AS start, to_char(l.end_date,'YYYY-MM-DD') AS "end", l.status,
              coalesce(t.name,'Leave') AS type, coalesce(t.code,'LV') AS code
         FROM leave_requests l LEFT JOIN leave_types t ON t.id=l.leave_type_id AND t.organization_id=l.organization_id
        WHERE l.organization_id=$1 AND l.employee_id = ANY($2) AND l.status IN ('APPROVED','PENDING') AND l.start_date <= $4 AND l.end_date >= $3`,
      [identity.organizationId, ids, from, to])).rows;
  }

  private async publications(client: PoolClient, identity: AuthIdentity, ids: string[], start: string) {
    const rows = (await client.query(
      `SELECT id, employee_id, snapshot, published_at AS "publishedAt", revision FROM roster_publications
        WHERE organization_id=$1 AND employee_id = ANY($2) AND week_start=$3`, [identity.organizationId, ids, start])).rows;
    return new Map(rows.map((row) => [row.employee_id as string, row as { id: string; snapshot: SnapshotEntry[]; publishedAt: string; revision: number }]));
  }

  private async shiftRequests(client: PoolClient, identity: AuthIdentity, ids: string[], start: string, end: string, templates: Template[]) {
    const rows = (await client.query(
      `SELECT c.id, c.case_number, c.title, c.category, to_char(c.start_date,'YYYY-MM-DD') AS start_date,
              to_char(coalesce(c.end_date,c.start_date),'YYYY-MM-DD') AS end_date, c.closed_at,
              r.id AS requester_id, r.full_name AS requester_name, s.id AS subject_id, s.full_name AS subject_name,
              (SELECT count(*)::int FROM roster_assignments a WHERE a.organization_id=c.organization_id AND a.source_case_id=c.id AND a.employee_id=c.requester_id) AS applied_days,
              (SELECT count(DISTINCT d)::int FROM generate_series(c.start_date, coalesce(c.end_date,c.start_date), interval '1 day') d
                 WHERE NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.organization_id=c.organization_id AND l.employee_id=c.requester_id
                                      AND l.status='APPROVED' AND d::date BETWEEN l.start_date AND l.end_date)) AS eligible_days
         FROM hr_cases c
         JOIN employees r ON r.id=c.requester_id AND r.organization_id=c.organization_id
         LEFT JOIN employees s ON s.id=c.subject_employee_id AND s.organization_id=c.organization_id
        WHERE c.organization_id=$1 AND c.module='shifts' AND c.status='APPROVED' AND c.start_date IS NOT NULL
          AND c.start_date <= $4 AND coalesce(c.end_date,c.start_date) >= $3
          AND (c.requester_id = ANY($2) OR c.subject_employee_id = ANY($2))
        ORDER BY c.start_date, c.case_number`, [identity.organizationId, ids, start, end])).rows;
    return rows.map((row) => ({
      id: row.id as string, caseNumber: row.case_number as string, title: row.title as string, category: row.category as string | null,
      startDate: row.start_date as string, endDate: row.end_date as string, approvedAt: row.closed_at,
      requester: { id: row.requester_id as string, name: row.requester_name as string },
      subject: row.subject_id ? { id: row.subject_id as string, name: row.subject_name as string } : null,
      target: matchCategory(row.category, templates),
      appliedDays: row.applied_days as number, eligibleDays: row.eligible_days as number,
      applied: row.applied_days > 0 && row.applied_days >= row.eligible_days,
    }));
  }

  private async templates(client: PoolClient, identity: AuthIdentity): Promise<Template[]> {
    return (await client.query(
      `SELECT id, code, name, to_char(start_time,'HH24:MI') AS "startTime", to_char(end_time,'HH24:MI') AS "endTime", break_minutes AS "breakMinutes",
              color, min_headcount AS "minHeadcount", is_active AS active, sort_order AS "sortOrder", version
         FROM roster_shift_templates WHERE organization_id=$1 ORDER BY is_active DESC, sort_order, start_time, code`, [identity.organizationId])).rows
      .map((row) => ({ ...row, paidHours: hours(paidMinutes(row)), overnight: overnight(row) }));
  }

  private async settings(client: PoolClient, identity: AuthIdentity): Promise<Settings> {
    const row = (await client.query(`SELECT min_rest_hours, max_weekly_hours, max_consecutive_days, version FROM roster_settings WHERE organization_id=$1`, [identity.organizationId])).rows[0];
    return row ? { minRestHours: Number(row.min_rest_hours), maxWeeklyHours: Number(row.max_weekly_hours), maxConsecutiveDays: row.max_consecutive_days, version: row.version }
      : { minRestHours: 11, maxWeeklyHours: 48, maxConsecutiveDays: 6, version: 0 };
  }

  /** First use per organization: default café shifts and rule settings. */
  private async ensureDefaults(client: PoolClient, identity: AuthIdentity) {
    await client.query(`INSERT INTO roster_settings(organization_id) VALUES($1) ON CONFLICT DO NOTHING`, [identity.organizationId]);
    const any = await client.query(`SELECT 1 FROM roster_shift_templates WHERE organization_id=$1 LIMIT 1`, [identity.organizationId]);
    if (any.rowCount) return;
    for (const template of DEFAULT_TEMPLATES)
      await client.query(
        `INSERT INTO roster_shift_templates(organization_id,code,name,start_time,end_time,break_minutes,color,min_headcount,sort_order)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [identity.organizationId, template.code, template.name, template.start, template.end, template.breakMinutes, template.color, template.min, template.sort]);
  }

  private diff(start: string, live: Map<string, Entry>, snapshot: SnapshotEntry[] | undefined) {
    const published = new Map((snapshot || []).map((entry) => [entry.date, entry]));
    return weekDates(start).filter((date) => !sameEntry(live.get(date), published.get(date)));
  }

  private snapshotEntry(entry: Entry, templates: Map<string, Template>): SnapshotEntry {
    const template = entry.templateId ? templates.get(entry.templateId) : undefined;
    const base: SnapshotEntry = { date: entry.date, kind: entry.kind, templateId: entry.templateId, location: entry.location, note: entry.note };
    if (!template) return base;
    return { ...base, code: template.code, name: template.name, startTime: template.startTime, endTime: template.endTime, breakMinutes: template.breakMinutes, color: template.color, hours: hours(paidMinutes(template)) };
  }

  private describe(entry: Entry | undefined, templates: Map<string, Template>) {
    if (!entry) return "not scheduled";
    if (entry.kind === "WEEKLY_OFF") return "weekly off";
    const template = templates.get(entry.templateId!);
    return template ? `${template.name} ${template.startTime}–${template.endTime}` : "shift";
  }

  private weekStart(value: string | undefined, strict = false) {
    const date = value || todayLocal();
    if (!validDate(date)) throw new BadRequestException("Choose a valid week start date.");
    const monday = mondayOf(date);
    if (strict && monday !== date) throw new BadRequestException("Weeks start on Monday — pass the Monday date.");
    return monday;
  }

  private checkTemplate(input: TemplateDto) {
    if (input.startTime === input.endTime) throw new BadRequestException("A shift must end at a different time than it starts.");
    const [sh, sm] = input.startTime.split(":").map(Number), [eh, em] = input.endTime.split(":").map(Number);
    const gross = ((eh * 60 + em) - (sh * 60 + sm) + 1440) % 1440;
    if (input.breakMinutes >= gross) throw new BadRequestException("The unpaid break must be shorter than the shift.");
    if (gross > 16 * 60) throw new BadRequestException("Shifts longer than 16 hours are not allowed.");
  }

  private isHr(identity: AuthIdentity) { return identity.roles.some((role) => HR_ROLES.includes(role)); }
  private requireHr(identity: AuthIdentity) { if (!this.isHr(identity)) throw new ForbiddenException("Only HR can manage shift templates and roster rules."); }

  private audit(client: PoolClient, identity: AuthIdentity, action: string, entityType: string, entityId: string, after: unknown, before: unknown) {
    return client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [identity.organizationId, identity.userId, action, entityType, entityId, before === null || before === undefined ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after)]);
  }
}

export type { Warning };

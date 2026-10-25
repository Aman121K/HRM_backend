import { caseModuleMap, caseModules } from "../../cases/case-modules";
import { emailButton, emailList, escapeHtml } from "../email-layout";
import { ESCALATE_PRIORITIES, approverPendingStatuses, dedupeKey, slaActiveStatuses, slaState } from "../scheduling";
import type { Counters, TenantJobContext } from "../tenant-runner";
import { firstName, formatDateTime, formatDay, hrAdmins, plural, uniquePeople, type Person } from "./shared";

/**
 * Helpdesk SLA watch (every 15 min): assignee (or HR when unassigned) hears once when a ticket is within 2 h of its
 * due time and once when it breaches; breached HIGH/URGENT tickets are escalated to all HR admins exactly once.
 * Keys include due_at, so if a ticket's due time moves (priority change) the new deadline is watched afresh.
 */
export async function helpdeskSlaWatch(ctx: TenantJobContext): Promise<Counters> {
  const org = ctx.organization.id;
  let dueSoon = 0, breached = 0, escalated = 0;
  const hr = await hrAdmins(ctx);
  for (const module of caseModules.filter((item) => item.slaHours)) {
    const statuses = slaActiveStatuses(module);
    const rows = (await ctx.client.query(
      `SELECT c.id, c.case_number, c.title, c.priority, c.due_at, c.status,
              a.id AS assignee_id, a.full_name AS assignee_name, a.work_email AS assignee_email, r.full_name AS requester_name
         FROM hr_cases c
         JOIN employees r ON r.id=c.requester_id AND r.organization_id=c.organization_id
         LEFT JOIN employees a ON a.id=c.assignee_id AND a.organization_id=c.organization_id AND a.status='ACTIVE'
        WHERE c.organization_id=$1 AND c.module=$2 AND c.status = ANY($3) AND c.due_at IS NOT NULL AND c.due_at <= now() + interval '2 hours'
        ORDER BY c.due_at LIMIT 500`, [org, module.key, statuses])).rows;
    for (const row of rows) {
      const state = slaState(row.due_at, ctx.now);
      if (state === "OK") continue;
      const due = new Date(row.due_at).toISOString();
      const assignee: Person | null = row.assignee_id ? { id: row.assignee_id, full_name: row.assignee_name, work_email: row.assignee_email } : null;
      const recipients = assignee ? [assignee] : hr;
      const when = formatDateTime(row.due_at, ctx.organization.timezone);
      const href = `/${module.key}?case=${row.id}`;
      for (const person of recipients) {
        const kind = state === "DUE_SOON" ? "due_soon" : "breached";
        if (!(await ctx.claim(dedupeKey("helpdesk.sla", kind, row.id, due, person.id), { recipient: person.id, entityId: row.id }))) continue;
        const message = state === "DUE_SOON"
          ? `${row.case_number} “${row.title}” is due ${when} — under 2 hours left on the SLA`
          : `${row.case_number} “${row.title}” breached its SLA (was due ${when})`;
        await ctx.notify(person.id, state === "DUE_SOON" ? "CASE_SLA_DUE_SOON" : "CASE_SLA_BREACHED", "hr_case", row.id,
          { message, caseNumber: row.case_number, module: module.key, dueAt: row.due_at, priority: row.priority, href });
        await ctx.email(person.work_email, state === "DUE_SOON" ? `SLA due soon: ${row.case_number}` : `SLA breached: ${row.case_number}`,
          `<p>Hi ${escapeHtml(firstName(person.full_name))},</p><p>${escapeHtml(message)}.</p>` +
          `<p style="color:#6b716c">Raised by ${escapeHtml(row.requester_name)} · Priority ${escapeHtml(row.priority)} · ${assignee ? "Assigned to you" : "Unassigned — any HR agent can pick it up"}</p>` +
          emailButton("Open ticket", href));
        if (state === "DUE_SOON") dueSoon += 1; else breached += 1;
      }
      if (state === "BREACHED" && ESCALATE_PRIORITIES.includes(row.priority) && (await ctx.claim(dedupeKey("helpdesk.sla", "escalated", row.id), { entityId: row.id }))) {
        const message = `Escalation: ${row.priority} ticket ${row.case_number} “${row.title}” breached its SLA${assignee ? ` (assigned to ${assignee.full_name})` : " and is unassigned"}`;
        for (const person of uniquePeople(hr)) {
          await ctx.notify(person.id, "CASE_SLA_ESCALATED", "hr_case", row.id, { message, caseNumber: row.case_number, module: module.key, priority: row.priority, href });
          await ctx.email(person.work_email, `Escalated: ${row.case_number} breached SLA`,
            `<p>${escapeHtml(message)}.</p><p>It was due ${escapeHtml(when)}. Please reassign or follow up.</p>${emailButton("Review ticket", href)}`);
        }
        await ctx.audit("CASE_SLA_ESCALATED", "hr_case", row.id, { caseNumber: row.case_number, priority: row.priority, dueAt: row.due_at, notified: hr.length });
        escalated += 1;
      }
    }
  }
  return { dueSoon, breached, escalated };
}

/**
 * Daily approvals digest (09:30 IST): every approver with case or leave approvals waiting more than 24 h gets one
 * in-app notification and one email per day (ledger key per approver + local date).
 */
export async function approvalsDigest(ctx: TenantJobContext): Promise<Counters> {
  const org = ctx.organization.id;
  const pending = approverPendingStatuses(caseModules);
  const pairs = Object.entries(pending).flatMap(([module, statuses]) => statuses.map((status) => `${module}:${status}`));
  const cases = (await ctx.client.query(
    `SELECT c.approver_id, c.id, c.case_number, c.title, c.module, c.amount, c.updated_at, r.full_name AS requester
       FROM hr_cases c JOIN employees r ON r.id=c.requester_id AND r.organization_id=c.organization_id
      WHERE c.organization_id=$1 AND c.approver_id IS NOT NULL AND (c.module || ':' || c.status) = ANY($2)
        AND c.updated_at < now() - interval '24 hours'
      ORDER BY c.updated_at`, [org, pairs])).rows;
  const leaves = (await ctx.client.query(
    `SELECT l.approver_id, l.id, l.start_date::text AS start_date, l.end_date::text AS end_date, l.days, l.submitted_at, t.name AS leave_type, e.full_name AS requester
       FROM leave_requests l JOIN employees e ON e.id=l.employee_id AND e.organization_id=l.organization_id
       JOIN leave_types t ON t.id=l.leave_type_id AND t.organization_id=l.organization_id
      WHERE l.organization_id=$1 AND l.status='PENDING' AND l.submitted_at < now() - interval '24 hours'
      ORDER BY l.submitted_at`, [org])).rows;
  const byApprover = new Map<string, { cases: typeof cases; leaves: typeof leaves }>();
  for (const row of cases) (byApprover.get(row.approver_id) || byApprover.set(row.approver_id, { cases: [], leaves: [] }).get(row.approver_id)!).cases.push(row);
  for (const row of leaves) (byApprover.get(row.approver_id) || byApprover.set(row.approver_id, { cases: [], leaves: [] }).get(row.approver_id)!).leaves.push(row);
  if (!byApprover.size) return { approvers: 0, items: 0 };
  const approvers = (await ctx.client.query(
    `SELECT id, full_name, work_email FROM employees WHERE organization_id=$1 AND id = ANY($2) AND status='ACTIVE'`, [org, [...byApprover.keys()]])).rows as Person[];
  let sent = 0, items = 0;
  for (const approver of approvers) {
    const work = byApprover.get(approver.id)!;
    const total = work.cases.length + work.leaves.length;
    if (!(await ctx.claim(dedupeKey("approvals.digest", approver.id, ctx.clock.date), { recipient: approver.id }))) continue;
    const message = `${plural(total, "approval")} waiting on you for more than a day`;
    await ctx.notify(approver.id, "APPROVALS_DIGEST", "employee", approver.id,
      { message, href: "/approvals", cases: work.cases.length, leaves: work.leaves.length, date: ctx.clock.date });
    const list = [
      ...work.leaves.map((row) => ({ title: `${row.requester} · ${row.leave_type}`, meta: `${formatDay(row.start_date)}${row.end_date !== row.start_date ? ` – ${formatDay(row.end_date)}` : ""} · ${Number(row.days)} day(s) · waiting since ${formatDay(row.submitted_at)}` })),
      ...work.cases.map((row) => ({ title: `${row.case_number} · ${row.title}`, meta: `${caseModuleMap.get(row.module)?.label || row.module} · ${row.requester}${row.amount !== null ? ` · ₹${Number(row.amount).toLocaleString("en-IN")}` : ""} · waiting since ${formatDay(row.updated_at)}` })),
    ].slice(0, 25);
    await ctx.email(approver.work_email, `${plural(total, "approval")} waiting for you`,
      `<p>Good morning ${escapeHtml(firstName(approver.full_name))},</p><p>These requests have been waiting on your decision for more than 24 hours:</p>${emailList(list)}` +
      (total > list.length ? `<p style="color:#6b716c">…and ${total - list.length} more.</p>` : "") + emailButton("Review approvals", "/approvals"));
    sent += 1; items += total;
  }
  return { approvers: sent, items };
}

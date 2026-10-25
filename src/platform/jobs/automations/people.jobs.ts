import { emailButton, emailList, escapeHtml } from "../email-layout";
import { addDays, anniversaryYears, daysBetween, dedupeKey, nextWeekStart, overdueStage, withinSendWindow } from "../scheduling";
import type { Counters, TenantJobContext } from "../tenant-runner";
import { firstName, formatDay, ordinal, plural, type Person } from "./shared";

/** Mirrors the engagement module's per-person reminder cooldown (engagement.service.ts REMINDER_COOLDOWN_HOURS). */
export const SURVEY_REMINDER_COOLDOWN_HOURS = 20;
/** Mirrors the LMS module's reminder throttle (lms.service.ts reminders(): reminded_at older than 20 h). */
export const LMS_REMINDER_COOLDOWN_HOURS = 20;

const outsideWindow = (ctx: TenantJobContext) => !ctx.manual && !withinSendWindow(ctx.clock);

/**
 * Surveys (hourly): closes LIVE surveys/polls past their close time (same rule as the engagement module's lazy
 * sweep, but without waiting for someone to open the page) and, once per survey close date, reminds
 * non-respondents when it closes within 48 h. Honours the 20 h per-person cooldown; only counts are audited and
 * reminders carry no response data, so anonymous surveys stay anonymous.
 */
export async function surveysAutomation(ctx: TenantJobContext): Promise<Counters> {
  const org = ctx.organization.id;
  const closed = (await ctx.client.query(
    `UPDATE surveys SET status='CLOSED', closed_at=closes_at, version=version+1, updated_at=now()
      WHERE organization_id=$1 AND status='LIVE' AND closes_at IS NOT NULL AND closes_at <= now()
      RETURNING id, title, kind, owner_id`, [org])).rows;
  for (const row of closed) {
    await ctx.audit(row.kind === "POLL" ? "POLL_CLOSED" : "SURVEY_CLOSED", "survey", row.id, { status: "CLOSED", automated: true }, { status: "LIVE" });
    if (await ctx.claim(dedupeKey("surveys.closed", row.id), { recipient: row.owner_id, entityId: row.id }))
      await ctx.notify(row.owner_id, "SURVEY_CLOSED", "survey", row.id,
        { title: row.title, href: `/surveys/${row.id}`, message: `“${row.title}” closed on schedule — results are ready` });
  }
  if (outsideWindow(ctx)) return { closed: closed.length, surveysReminded: 0, reminded: 0, skippedRecent: 0 };

  const closing = (await ctx.client.query(
    `SELECT id, title, anonymous, closes_at FROM surveys
      WHERE organization_id=$1 AND kind='SURVEY' AND status='LIVE' AND closes_at > now() AND closes_at <= now() + interval '48 hours'
        AND (opens_at IS NULL OR opens_at <= now())`, [org])).rows;
  let surveys = 0, reminded = 0, skipped = 0;
  for (const survey of closing) {
    if (!(await ctx.claim(dedupeKey("surveys.closing_soon", survey.id, new Date(survey.closes_at).toISOString()), { entityId: survey.id }))) continue;
    const pending = (await ctx.client.query(
      `SELECT i.employee_id, (i.last_reminded_at IS NOT NULL AND i.last_reminded_at > now() - make_interval(hours => $3)) AS recent
         FROM survey_invitations i JOIN employees e ON e.id=i.employee_id AND e.organization_id=i.organization_id AND e.status='ACTIVE'
        WHERE i.organization_id=$1 AND i.survey_id=$2 AND i.responded_on IS NULL FOR UPDATE OF i`,
      [org, survey.id, SURVEY_REMINDER_COOLDOWN_HOURS])).rows;
    const due = pending.filter((row) => !row.recent).map((row) => row.employee_id as string);
    if (due.length) {
      await ctx.client.query(`UPDATE survey_invitations SET reminder_count=reminder_count+1, last_reminded_at=now()
        WHERE organization_id=$1 AND survey_id=$2 AND employee_id = ANY($3)`, [org, survey.id, due]);
      const message = `Reminder: “${survey.title}” closes ${formatDay(survey.closes_at)} — it only takes a few minutes${survey.anonymous ? " (anonymous)" : ""}`;
      await ctx.client.query(
        `INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload) SELECT $1,unnest($2::uuid[]),'SURVEY_REMINDER','survey',$3,$4`,
        [org, due, survey.id, JSON.stringify({ title: survey.title, href: `/surveys/${survey.id}`, closesAt: survey.closes_at, message, automated: true })]);
    }
    await ctx.audit("SURVEY_REMINDERS_SENT", "survey", survey.id, { reminded: due.length, pending: pending.length, automated: true });
    surveys += 1; reminded += due.length; skipped += pending.length - due.length;
  }
  return { closed: closed.length, surveysReminded: surveys, reminded, skippedRecent: skipped };
}

/**
 * LMS (hourly, working hours): one "due in ≤3 days" reminder per enrolment and due date, then overdue reminders on
 * day 1, 3, 7 and weekly. Respects the LMS 20 h throttle shared with the manual "Send reminders" button.
 */
export async function lmsDueReminders(ctx: TenantJobContext): Promise<Counters> {
  if (outsideWindow(ctx)) return { skipped: true, reason: "outside working hours" };
  const org = ctx.organization.id;
  const today = ctx.clock.date;
  const rows = (await ctx.client.query(
    `SELECT e.id, e.employee_id, e.due_date::text AS due_date, c.id AS course_id, c.title,
            (e.reminded_at IS NOT NULL AND e.reminded_at > now() - make_interval(hours => $3)) AS recent
       FROM lms_enrollments e
       JOIN lms_courses c ON c.id=e.course_id AND c.organization_id=e.organization_id AND c.status='PUBLISHED'
       JOIN employees m ON m.id=e.employee_id AND m.organization_id=e.organization_id AND m.status='ACTIVE'
      WHERE e.organization_id=$1 AND e.status<>'COMPLETED' AND e.due_date IS NOT NULL AND e.due_date <= $2::date + 3
      FOR UPDATE OF e`, [org, today, LMS_REMINDER_COOLDOWN_HOURS])).rows;
  let dueSoon = 0, overdue = 0, throttled = 0;
  for (const row of rows) {
    const late = daysBetween(row.due_date, today);
    const stage = late >= 1 ? overdueStage(late) : "soon";
    if (!stage) continue;
    if (row.recent) { throttled += 1; continue; }
    const key = late >= 1 ? dedupeKey("lms.overdue", row.id, row.due_date, stage) : dedupeKey("lms.due_soon", row.id, row.due_date);
    if (!(await ctx.claim(key, { recipient: row.employee_id, entityId: row.id }))) continue;
    const message = late >= 1
      ? `“${row.title}” is overdue (was due ${formatDay(row.due_date)})`
      : late === 0 ? `“${row.title}” is due today` : `“${row.title}” is due ${formatDay(row.due_date)} — ${plural(-late, "day")} left`;
    await ctx.notify(row.employee_id, late >= 1 ? "LMS_OVERDUE" : "LMS_DUE_SOON", "lms_enrollment", row.id,
      { courseId: row.course_id, courseTitle: row.title, dueDate: row.due_date, href: `/learning/course/${row.course_id}`, message });
    await ctx.client.query(`UPDATE lms_enrollments SET reminded_at=now() WHERE organization_id=$1 AND id=$2`, [org, row.id]);
    if (late >= 1) overdue += 1; else dueSoon += 1;
  }
  return { dueSoon, overdue, throttled };
}

/**
 * Onboarding (hourly, working hours): overdue checklist tasks nudge their owner (day 1, 3, 7, weekly; one digest per
 * owner per run), and the day before a joiner starts their manager, buddy and IT owner get a heads-up.
 */
export async function onboardingReminders(ctx: TenantJobContext): Promise<Counters> {
  if (outsideWindow(ctx)) return { skipped: true, reason: "outside working hours" };
  const org = ctx.organization.id;
  const today = ctx.clock.date;
  const tasks = (await ctx.client.query(
    `SELECT t.id, t.title, t.due_date::text AS due_date, j.id AS joiner_id, j.full_name AS joiner_name,
            o.id AS owner_id, o.full_name AS owner_name, o.work_email AS owner_email
       FROM onboarding_tasks t
       JOIN onboarding_joiners j ON j.id=t.joiner_id AND j.organization_id=t.organization_id AND j.status NOT IN ('WITHDRAWN','COMPLETED')
       LEFT JOIN onboarding_settings s ON s.organization_id=t.organization_id
       JOIN employees o ON o.organization_id=t.organization_id AND o.status='ACTIVE'
        AND o.id = coalesce(t.owner_id, CASE WHEN t.owner_type='JOINER' THEN j.employee_id END, CASE WHEN t.owner_type='IT' THEN s.it_owner_id WHEN t.owner_type='FINANCE' THEN s.finance_owner_id END, s.hr_owner_id)
      WHERE t.organization_id=$1 AND t.status='PENDING' AND t.due_date < $2::date
      ORDER BY o.id, t.due_date`, [org, today])).rows;
  const byOwner = new Map<string, { owner: Person; items: typeof tasks }>();
  for (const task of tasks) {
    const stage = overdueStage(daysBetween(task.due_date, today));
    if (!stage || !(await ctx.claim(dedupeKey("onboarding.task_overdue", task.id, stage), { recipient: task.owner_id, entityId: task.id }))) continue;
    const entry = byOwner.get(task.owner_id) || { owner: { id: task.owner_id, full_name: task.owner_name, work_email: task.owner_email }, items: [] as typeof tasks };
    entry.items.push(task);
    byOwner.set(task.owner_id, entry);
  }
  for (const { owner, items } of byOwner.values()) {
    const joiners = [...new Set(items.map((item) => item.joiner_name))];
    const message = `${plural(items.length, "onboarding task")} overdue for ${joiners.slice(0, 2).join(", ")}${joiners.length > 2 ? ` +${joiners.length - 2}` : ""}`;
    await ctx.notify(owner.id, "ONBOARDING_TASKS_OVERDUE", "onboarding_joiner", items[0].joiner_id,
      { message, module: "onboarding", link: `/onboarding/${items[0].joiner_id}`, href: `/onboarding/${items[0].joiner_id}`, tasks: items.length });
    await ctx.email(owner.work_email, `${plural(items.length, "onboarding task")} overdue`,
      `<p>Hi ${escapeHtml(firstName(owner.full_name))},</p><p>These onboarding tasks are past their due date:</p>` +
      emailList(items.slice(0, 20).map((item) => ({ title: item.title, meta: `${item.joiner_name} · due ${formatDay(item.due_date)}` }))) +
      emailButton("Open onboarding", items.length === 1 || joiners.length === 1 ? `/onboarding/${items[0].joiner_id}` : "/onboarding"));
  }

  const tomorrow = addDays(today, 1);
  const joiners = (await ctx.client.query(
    `SELECT j.id, j.full_name, j.designation, j.department, j.location, j.joining_date::text AS joining_date,
            j.manager_id, j.buddy_id, s.it_owner_id
       FROM onboarding_joiners j LEFT JOIN onboarding_settings s ON s.organization_id=j.organization_id
      WHERE j.organization_id=$1 AND j.joining_date=$2::date AND j.status IN ('PRE_BOARDING','READY_TO_JOIN')`, [org, tomorrow])).rows;
  let headsUps = 0;
  for (const joiner of joiners) {
    const roles = new Map<string, string>();
    if (joiner.it_owner_id) roles.set(joiner.it_owner_id, "IT");
    if (joiner.buddy_id) roles.set(joiner.buddy_id, "buddy");
    if (joiner.manager_id) roles.set(joiner.manager_id, "manager");
    if (!roles.size) continue;
    const people = (await ctx.client.query(`SELECT id, full_name, work_email FROM employees WHERE organization_id=$1 AND id = ANY($2) AND status='ACTIVE'`,
      [org, [...roles.keys()]])).rows as Person[];
    for (const person of people) {
      if (!(await ctx.claim(dedupeKey("onboarding.joining_tomorrow", joiner.id, joiner.joining_date, person.id), { recipient: person.id, entityId: joiner.id }))) continue;
      const role = roles.get(person.id)!;
      const ask = role === "IT" ? "Please have their laptop, accounts and access ready." : role === "buddy" ? "Say hello and plan their first coffee!" : "Block time to welcome them on day one.";
      const message = `${joiner.full_name} joins tomorrow as ${joiner.designation}${joiner.location ? ` in ${joiner.location}` : ""}. ${ask}`;
      await ctx.notify(person.id, "ONBOARDING_JOINING_TOMORROW", "onboarding_joiner", joiner.id,
        { message, module: "onboarding", link: `/onboarding/${joiner.id}`, href: `/onboarding/${joiner.id}`, role });
      await ctx.email(person.work_email, `${joiner.full_name} joins tomorrow`,
        `<p>Hi ${escapeHtml(firstName(person.full_name))},</p><p><b>${escapeHtml(joiner.full_name)}</b> starts tomorrow (${escapeHtml(formatDay(joiner.joining_date))}) as ${escapeHtml(joiner.designation)}, ${escapeHtml(joiner.department)}${joiner.location ? ` · ${escapeHtml(joiner.location)}` : ""}.</p>` +
        `<p>You're their ${escapeHtml(role === "IT" ? "IT contact" : role)}. ${escapeHtml(ask)}</p>${emailButton("View onboarding plan", `/onboarding/${joiner.id}`)}`);
      headsUps += 1;
    }
  }
  return { overdueTasks: [...byOwner.values()].reduce((sum, entry) => sum + entry.items.length, 0), owners: byOwner.size, joiningTomorrow: joiners.length, headsUps };
}

/**
 * Roster (Fridays 11:00): managers whose shift-based team has people without a published roster for next week get
 * one reminder per week. Teams that never use the roster (no assignments in the last 4 weeks) are left alone.
 */
export async function rosterPublishReminder(ctx: TenantJobContext): Promise<Counters> {
  const org = ctx.organization.id;
  const week = nextWeekStart(ctx.clock.date);
  const managers = (await ctx.client.query(
    `SELECT m.id, m.full_name, m.work_email, count(r.id)::int AS team, (count(r.id) FILTER (WHERE p.id IS NULL))::int AS unpublished
       FROM employees m
       JOIN employees r ON r.manager_id=m.id AND r.organization_id=m.organization_id AND r.status='ACTIVE'
       LEFT JOIN roster_publications p ON p.organization_id=r.organization_id AND p.employee_id=r.id AND p.week_start=$2::date
      WHERE m.organization_id=$1 AND m.status='ACTIVE'
        AND EXISTS (SELECT 1 FROM roster_assignments a JOIN employees x ON x.id=a.employee_id AND x.organization_id=a.organization_id
                     WHERE a.organization_id=$1 AND x.manager_id=m.id AND a.work_date >= $2::date - 28)
      GROUP BY m.id HAVING count(r.id) FILTER (WHERE p.id IS NULL) > 0`, [org, week])).rows;
  let reminded = 0;
  for (const manager of managers) {
    if (!(await ctx.claim(dedupeKey("roster.unpublished", manager.id, week), { recipient: manager.id }))) continue;
    const message = `Next week's roster (from ${formatDay(week)}) isn't published for ${manager.unpublished} of ${plural(manager.team, "person", "people")} in your team`;
    await ctx.notify(manager.id, "ROSTER_PUBLISH_REMINDER", "employee", manager.id, { message, href: "/roster", weekStart: week, unpublished: manager.unpublished });
    await ctx.email(manager.work_email, `Publish next week's roster`,
      `<p>Hi ${escapeHtml(firstName(manager.full_name))},</p><p>${escapeHtml(message)}. Your team sees shifts only after you publish, so they can plan their week.</p>${emailButton("Open roster planner", "/roster")}`);
    reminded += 1;
  }
  return { weekStart: week, managers: reminded };
}

/**
 * Work anniversaries (daily 09:00): a celebratory in-app note to the employee and a heads-up to their manager, once
 * per employee per year. Set JOBS_ANNIVERSARY_ANNOUNCE=true to also tell the rest of the team.
 * (Birthdays are not supported: the HRIS does not store dates of birth.)
 */
export async function workAnniversaries(ctx: TenantJobContext): Promise<Counters> {
  const org = ctx.organization.id;
  const today = ctx.clock.date;
  const [, month, day] = today.split("-").map(Number);
  const candidates = (await ctx.client.query(
    `SELECT id, full_name, manager_id, joining_date::text AS joining_date FROM employees
      WHERE organization_id=$1 AND status='ACTIVE' AND joining_date < $2::date AND extract(month FROM joining_date)=$3
        AND (extract(day FROM joining_date)=$4 OR ($3=2 AND $4=28 AND extract(day FROM joining_date)=29))`, [org, today, month, day])).rows;
  const announce = process.env.JOBS_ANNIVERSARY_ANNOUNCE === "true";
  let celebrated = 0, notified = 0;
  for (const person of candidates) {
    const years = anniversaryYears(person.joining_date, today);
    if (!years || !(await ctx.claim(dedupeKey("people.anniversary", person.id, today.slice(0, 4)), { recipient: person.id, entityId: person.id }))) continue;
    const span = plural(years, "year");
    await ctx.notify(person.id, "WORK_ANNIVERSARY", "employee", person.id,
      { message: `Happy ${ordinal(years)} work anniversary, ${firstName(person.full_name)}! Thank you for ${span} with ${ctx.organization.name}.`, years, href: "/recognition", celebrate: true });
    notified += 1;
    const audience: string[] = [];
    if (person.manager_id) audience.push(person.manager_id);
    if (announce && person.manager_id)
      audience.push(...(await ctx.client.query(`SELECT id FROM employees WHERE organization_id=$1 AND manager_id=$2 AND status='ACTIVE' AND id<>$3`,
        [org, person.manager_id, person.id])).rows.map((row) => row.id as string));
    for (const recipient of new Set(audience)) {
      await ctx.notify(recipient, "WORK_ANNIVERSARY_TEAM", "employee", person.id,
        { message: `${person.full_name} completes ${span} at ${ctx.organization.name} today — send a thank-you!`, years, href: "/recognition", celebrate: true });
      notified += 1;
    }
    celebrated += 1;
  }
  return { celebrated, notified };
}

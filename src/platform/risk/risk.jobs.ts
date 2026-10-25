import { Injectable, type OnModuleInit } from "@nestjs/common";
import { JobRegistry } from "../jobs/job-registry";
import { emailButton, escapeHtml } from "../jobs/email-layout";
import { dedupeKey } from "../jobs/scheduling";
import { TenantJobRunner, type Counters, type TenantJobContext } from "../jobs/tenant-runner";
import { COMPLIANCE_DISCLAIMER, complianceCalendar, type CalendarItem } from "./compliance";
import { loadSettings, runScan } from "./risk.engine";
import { loadCompliance, loadOrg } from "./risk.loaders";
import { addDays, dayLabel, plural } from "./risk.types";

type Recipient = { id: string; full_name: string; work_email: string | null; role: string };

/** Active HR admins, owners and payroll admins who have an employee record (so they get in-app notifications). */
async function riskRecipients(ctx: TenantJobContext, roles: string[]): Promise<Recipient[]> {
  return (await ctx.client.query(
    `SELECT DISTINCT ON (e.id) e.id, e.full_name, e.work_email, m.role
       FROM organization_memberships m
       JOIN employees e ON e.organization_id=m.organization_id AND e.user_id=m.user_id AND e.status='ACTIVE'
      WHERE m.organization_id=$1 AND m.status='ACTIVE' AND m.role = ANY($2) ORDER BY e.id`, [ctx.organization.id, roles])).rows as Recipient[];
}

/** Hourly: run every detector and tell HR (and payroll for payroll items) about new high/critical signals once each. */
export async function riskScanJob(ctx: TenantJobContext): Promise<Counters> {
  const summary = await runScan(ctx.client, ctx.organization.id, ctx.identity.userId, ctx.now);
  let notified = 0;
  if (summary.newUrgent.length) {
    const signals = (await ctx.client.query(`SELECT id, title, severity, audiences FROM risk_signals WHERE organization_id=$1 AND id = ANY($2)`, [ctx.organization.id, summary.newUrgent])).rows;
    const people = await riskRecipients(ctx, ["HR_ADMIN", "OWNER", "PAYROLL_ADMIN"]);
    for (const signal of signals) for (const person of people) {
      if (person.role === "PAYROLL_ADMIN" && !signal.audiences.includes("PAYROLL")) continue;
      if (!(await ctx.claim(dedupeKey("risk.signal", signal.id, person.id), { recipient: person.id, entityId: signal.id }))) continue;
      await ctx.notify(person.id, "RISK_SIGNAL_RAISED", "risk_signal", signal.id,
        { message: `${signal.severity === "critical" ? "Critical" : "High"} risk: ${signal.title}`, href: `/risk?signal=${signal.id}`, severity: signal.severity });
      notified += 1;
    }
  }
  const { newUrgent, errors, ...counts } = summary;
  return { ...counts, newUrgent: newUrgent.length, notified, areaErrors: errors.length };
}

/** Daily: remind HR/payroll admins 5 and 1 days before each statutory due date (and the day after it is missed). */
export async function complianceReminderJob(ctx: TenantJobContext): Promise<Counters> {
  const org = await loadOrg(ctx.client, ctx.organization.id, ctx.now);
  const { settings } = await loadSettings(ctx.client, org.id);
  const { facts, states } = await loadCompliance(ctx.client, org);
  const days = settings.compliance.reminderDays;
  const calendar = complianceCalendar(addDays(org.today, -2), addDays(org.today, Math.max(...days, 1) + 1), states, facts, org.today);
  const due = calendar.items.filter((item) => item.status !== "FILED" && item.status !== "NOT_APPLICABLE" && (days.includes(item.daysLeft) || item.daysLeft === -1));
  if (!due.length) return { reminders: 0, obligations: 0 };
  const people = await riskRecipients(ctx, ["HR_ADMIN", "OWNER", "PAYROLL_ADMIN"]);
  let sent = 0;
  for (const item of due) for (const person of people) {
    if (!(await ctx.claim(dedupeKey("risk.compliance_reminder", item.key, String(item.daysLeft), person.id), { recipient: person.id }))) continue;
    const message = reminderText(item);
    await ctx.notify(person.id, "COMPLIANCE_DUE", "organization", org.id, { message, href: "/risk?tab=compliance", obligation: item.key, dueDate: item.dueDate });
    await ctx.email(person.work_email, item.daysLeft < 0 ? `Missed: ${item.label}` : `Due ${item.daysLeft === 1 ? "tomorrow" : `in ${item.daysLeft} days`}: ${item.label}`,
      `<p>Hi ${escapeHtml(person.full_name.split(" ")[0])},</p><p>${escapeHtml(message)}.</p><p>${escapeHtml(item.detail)}</p>` +
      `<p style="color:#6b716c;font-size:12px">${escapeHtml(COMPLIANCE_DISCLAIMER)}</p>${emailButton("Open compliance calendar", "/risk?tab=compliance")}`);
    sent += 1;
  }
  return { reminders: sent, obligations: due.length };
}

const reminderText = (item: CalendarItem) =>
  item.daysLeft < 0 ? `${item.label} was due ${dayLabel(item.dueDate)} and isn't marked as filed`
    : `${item.label} is due ${dayLabel(item.dueDate)} (${item.daysLeft === 1 ? "tomorrow" : `in ${plural(item.daysLeft, "day")}`})`;

@Injectable()
export class RiskJobs implements OnModuleInit {
  constructor(private readonly registry: JobRegistry, private readonly runner: TenantJobRunner) {}
  onModuleInit() {
    this.registry.register("risk.scan", (payload) => this.runner.forEachTenant("risk.scan", payload, riskScanJob), {
      every: 60 * 60_000, tenantScoped: true, timeoutMs: 10 * 60_000,
      description: "Runs the Risk & Compliance detectors (statutory calendar, attendance integrity, labour limits, payroll, expenses, people, service) and upserts signals by fingerprint; notifies HR of new high/critical signals once.",
    });
    this.registry.register("risk.compliance_reminders", (payload) => this.runner.forEachTenant("risk.compliance_reminders", payload, complianceReminderJob), {
      cron: "15 9 * * *", tz: "Asia/Kolkata", tenantScoped: true, timeoutMs: 5 * 60_000,
      description: "Reminds HR and payroll admins 5 and 1 days before PF, ESI, TDS, PT, 24Q and Form 16 due dates (and the day after a missed one).",
    });
  }
}

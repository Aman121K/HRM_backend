import { Injectable, type OnModuleInit } from "@nestjs/common";
import { JobRegistry } from "./job-registry";
import { OutboxDispatcher } from "./outbox.dispatcher";
import { DEFAULT_TIMEZONE } from "./scheduling";
import { TenantJobRunner, type Counters, type TenantJobContext } from "./tenant-runner";
import { approvalsDigest, helpdeskSlaWatch } from "./automations/cases.jobs";
import { expireNotifications, purgeDeletedFiles } from "./automations/housekeeping.jobs";
import { lmsDueReminders, onboardingReminders, rosterPublishReminder, surveysAutomation, workAnniversaries } from "./automations/people.jobs";

type Automation = { name: string; description: string; every?: number; cron?: string; run: (ctx: TenantJobContext) => Promise<Counters> };

const MIN = 60_000;
/** Platform automations. Every one is tenant-scoped, idempotent (job_dispatch_log) and safe to "Run now". */
export const AUTOMATIONS: Automation[] = [
  { name: "helpdesk.sla_watch", every: 15 * MIN, run: helpdeskSlaWatch,
    description: "Warns assignees 2 h before a ticket's SLA is due and when it breaches; escalates breached HIGH/URGENT tickets to HR admins once." },
  { name: "approvals.daily_digest", cron: "30 9 * * *", run: approvalsDigest,
    description: "Morning email + in-app digest to each approver with case and leave approvals waiting more than 24 h." },
  { name: "surveys.automation", every: 60 * MIN, run: surveysAutomation,
    description: "Closes surveys past their close date; reminds non-respondents once when a survey closes within 2 days (20 h per-person cooldown)." },
  { name: "lms.due_reminders", every: 60 * MIN, run: lmsDueReminders,
    description: "Reminds learners 3 days before a course is due, then on day 1, 3, 7 and weekly when overdue (working hours only)." },
  { name: "onboarding.reminders", every: 60 * MIN, run: onboardingReminders,
    description: "Nudges owners of overdue onboarding tasks and gives manager, buddy and IT a heads-up the day before a joiner starts." },
  { name: "roster.publish_reminder", cron: "0 11 * * 5", run: rosterPublishReminder,
    description: "Friday reminder to managers whose team roster for next week is not published yet." },
  { name: "people.work_anniversaries", cron: "0 9 * * *", run: workAnniversaries,
    description: "Celebrates work anniversaries (from joining date) with an in-app note to the employee and their manager." },
  { name: "housekeeping.purge_deleted_files", cron: "15 3 * * *", run: purgeDeletedFiles,
    description: "Permanently removes attachments deleted more than FILE_RETENTION_DAYS (default 30) ago — bytes, then rows." },
  { name: "housekeeping.expire_notifications", cron: "30 3 * * *", run: expireNotifications,
    description: "Deletes in-app notifications older than 180 days and old job history." },
];

@Injectable()
export class JobsAutomations implements OnModuleInit {
  constructor(private readonly registry: JobRegistry, private readonly runner: TenantJobRunner, private readonly outbox: OutboxDispatcher) {}

  onModuleInit() {
    this.registry.register("outbox.dispatch", (payload) => this.outbox.dispatch(payload), undefined,
      { description: "Sends due email_outbox rows now (optionally for one organization). Enqueue after writing urgent mail." });
    this.registry.register("outbox.sweep", (payload) => this.outbox.dispatch(payload),
      { every: 30_000, tenantScoped: true, timeoutMs: 5 * MIN,
        description: `Delivers pending and retryable emails every 30 s (${process.env.SMTP_HOST ? "SMTP" : "development mailbox in .data/mail"}).` });
    for (const automation of AUTOMATIONS)
      this.registry.register(automation.name, (payload) => this.runner.forEachTenant(automation.name, payload, automation.run), {
        every: automation.every, cron: automation.cron, tz: automation.cron ? DEFAULT_TIMEZONE : undefined,
        description: automation.description, tenantScoped: true, timeoutMs: 10 * MIN,
      });
  }
}

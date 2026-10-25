import { Module } from "@nestjs/common";
import { JobsAutomations } from "./jobs.automations";
import { JobsConsoleService } from "./jobs.console.service";
import { JobsController, PlatformJobsController } from "./jobs.controller";
import { OutboxDispatcher } from "./outbox.dispatcher";
import { TenantJobRunner } from "./tenant-runner";

/**
 * Jobs console API (/api/v2/jobs) + platform automations (email delivery, reminders, housekeeping).
 * JobRegistry/JobsService themselves live in CoreModule (global). The worker imports this module explicitly, so
 * automations run even before the API registers it in FEATURE_MODULES.
 */
@Module({
  controllers: [JobsController, PlatformJobsController],
  providers: [TenantJobRunner, OutboxDispatcher, JobsAutomations, JobsConsoleService],
  exports: [TenantJobRunner, OutboxDispatcher],
})
export class JobsModule {}

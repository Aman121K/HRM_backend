import { Global, Injectable, Module, type OnModuleInit } from "@nestjs/common";
import { JobRegistry } from "../jobs/job-registry";
import { NotificationsService } from "./notifications.service";
import { PushProviders } from "./push-providers";
import { PushService } from "./push.service";

export const PUSH_FANOUT_JOB = "notifications.push_fanout";

@Injectable()
class PushJobs implements OnModuleInit {
  constructor(private readonly registry: JobRegistry, private readonly push: PushService) {}
  onModuleInit() {
    // Recurring sweep; modules that want an instant push can also jobs.enqueue(PUSH_FANOUT_JOB, { organizationId }).
    this.registry.register(PUSH_FANOUT_JOB, (payload) => this.push.run(payload), {
      every: 15_000, tenantScoped: true, timeoutMs: 2 * 60_000,
      description: "Turns new in-app notifications into mobile pushes (APNs/FCM) honouring preferences, quiet hours and burst collapsing; retries transient failures and deactivates dead tokens.",
    });
  }
}

/**
 * Push notifications + in-app read state. Global because NotificationsController is registered in AppModule
 * (outside this folder); this module is pulled into the app through ReceiptsModule's imports.
 */
@Global()
@Module({
  providers: [NotificationsService, PushService, PushProviders, PushJobs],
  exports: [NotificationsService, PushService, PushProviders],
})
export class NotificationsModule {}

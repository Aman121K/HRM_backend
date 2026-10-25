import { Module, OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { FastifyInstance } from "fastify";
import { JobRegistry } from "../jobs/job-registry";
import { AccountingService } from "./accounting.service";
import { assertIntegrationSecrets } from "./crypto";
import { AdmsController, DeviceIngestController, DevicesController } from "./devices.controller";
import { DevicesService } from "./devices.service";
import { AccountingController, IntegrationsController, PayoutsController, WebhooksController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";
import { PayoutsService, SYNC_JOB } from "./payouts.service";
import { installIntegrationBodyHooks } from "./raw-body";
import { DELIVER_JOB, SCAN_JOB, WebhooksService } from "./webhooks.service";

/**
 * Integrations: biometric devices (signed JSON API + ZKTeco/eSSL ADMS push), Tally/ERP accounting exports,
 * bank payouts (H2H files + RazorpayX-style API with sandbox) and signed outgoing webhooks.
 * Background work runs in the jobs worker through the handlers registered below.
 */
@Module({
  controllers: [IntegrationsController, DevicesController, DeviceIngestController, AdmsController, AccountingController, PayoutsController, WebhooksController],
  providers: [IntegrationsService, DevicesService, AccountingService, PayoutsService, WebhooksService],
  exports: [WebhooksService],
})
export class IntegrationsModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry, private readonly adapterHost: HttpAdapterHost,
    private readonly webhooks: WebhooksService, private readonly payouts: PayoutsService,
  ) {}

  onModuleInit() {
    assertIntegrationSecrets(); // production: refuse to boot (API and worker) without strong integration secrets
    installIntegrationBodyHooks(this.adapterHost?.httpAdapter?.getInstance?.() as FastifyInstance | undefined);
    this.registry.register(DELIVER_JOB, (payload) => this.webhooks.deliver(payload), undefined,
      { description: "Delivers one signed outgoing webhook (retried with exponential backoff; FAILED after 5 attempts).", timeoutMs: 20_000 });
    this.registry.register(SCAN_JOB, (payload) => this.webhooks.scan(payload.organizationId as string | undefined), {
      every: 60_000, tenantScoped: true, timeoutMs: 120_000,
      description: "Turns new audit-log rows (employees, leave, payroll, attendance, cases) into webhook events, tracking a cursor per organization.",
    });
    this.registry.register(SYNC_JOB, (payload) => this.payouts.syncAll(payload.organizationId as string | undefined), {
      every: 5 * 60_000, tenantScoped: true, timeoutMs: 240_000,
      description: "Submits released API payouts and polls their status (sandbox or live), updating UTRs and batch status.",
    });
  }
}

import { Module } from "@nestjs/common";
import { JobsModule } from "../jobs/jobs.module";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";

/** SaaS billing: plans, usage metering, GST invoices, payments, reminders (platform scope + brand-owner view). */
@Module({ imports: [JobsModule], controllers: [BillingController], providers: [BillingService] })
export class BillingModule {}

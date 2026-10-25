import { Module } from "@nestjs/common";
import { JobsModule } from "../jobs/jobs.module";
import { RiskController } from "./risk.controller";
import { RiskJobs } from "./risk.jobs";
import { RiskService } from "./risk.service";

/**
 * Risk & Compliance Center (/api/v2/risk): statutory calendar, attendance integrity, labour limits, payroll anomalies,
 * expense fraud, people and service risk. Jobs: risk.scan (hourly) and risk.compliance_reminders (daily 09:15 IST).
 * JobsModule is imported for TenantJobRunner (it is also registered on its own; Nest shares the instance).
 */
@Module({
  imports: [JobsModule],
  controllers: [RiskController],
  providers: [RiskService, RiskJobs],
})
export class RiskModule {}

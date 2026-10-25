import { Module } from "@nestjs/common";
import { JobsModule } from "../jobs/jobs.module";
import { BreachService } from "./breach.service";
import { BrandExitService } from "./brand-exit.service";
import { ErasureService } from "./erasure.service";
import { PlatformPrivacyController, PrivacyController } from "./privacy.controller";
import { PrivacyService } from "./privacy.service";

/** DPDP Act 2023: data-principal rights, retention & erasure, breach register, customer exit. */
@Module({
  imports: [JobsModule],
  controllers: [PrivacyController, PlatformPrivacyController],
  providers: [PrivacyService, ErasureService, BreachService, BrandExitService],
})
export class PrivacyModule {}

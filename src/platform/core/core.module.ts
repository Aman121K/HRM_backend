import { Global, Module } from "@nestjs/common";
import { AuthService } from "../auth/auth.service";
import { RuntimeConfig } from "../config/runtime-config";
import { DatabaseService } from "../database/database.service";
import { JobsService } from "../jobs/jobs.service";
import { JobRegistry } from "../jobs/job-registry";

/** Shared infrastructure available to every feature module without re-importing. */
@Global()
@Module({
  providers: [RuntimeConfig, DatabaseService, AuthService, JobsService, JobRegistry],
  exports: [RuntimeConfig, DatabaseService, AuthService, JobsService, JobRegistry],
})
export class CoreModule {}

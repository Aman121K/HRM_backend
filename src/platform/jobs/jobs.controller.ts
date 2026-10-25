import { Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { Roles } from "../auth/roles.decorator";
import { FailedJobsQuery, JobRunsQuery, OutboxQuery } from "./jobs.dto";
import { JobsConsoleService } from "./jobs.console.service";

@ApiTags("jobs") @ApiBearerAuth() @Controller("api/v2/jobs") @Roles("HR_ADMIN", "OWNER")
export class JobsController {
  constructor(private readonly console: JobsConsoleService) {}

  @Get("overview") @ApiOperation({ summary: "Queue health, live workers, schedules with next run and this organization's last run" })
  overview(@Req() request: FastifyRequest) { return this.console.overview(request.identity!); }

  @Get("failed") @ApiOperation({ summary: "Failed jobs (dead letters) visible to this organization" })
  failed(@Req() request: FastifyRequest, @Query() query: FailedJobsQuery) { return this.console.failed(request.identity!, query.limit); }

  @Post("failed/:id/retry") @HttpCode(200) @ApiOperation({ summary: "Retry a failed job" })
  retry(@Req() request: FastifyRequest, @Param("id") id: string) { return this.console.retry(request.identity!, id); }

  @Post("run/:name") @HttpCode(202) @ApiOperation({ summary: "Run a recurring job now for the caller's organization only" })
  run(@Req() request: FastifyRequest, @Param("name") name: string) { return this.console.runNow(request.identity!, name); }

  @Get("runs") @ApiOperation({ summary: "This organization's recent job runs" })
  runs(@Req() request: FastifyRequest, @Query() query: JobRunsQuery) { return this.console.runs(request.identity!, query); }

  @Get("outbox") @ApiOperation({ summary: "Recent emails for this organization with delivery status" })
  outbox(@Req() request: FastifyRequest, @Query() query: OutboxQuery) { return this.console.outboxList(request.identity!, query); }

  @Post("outbox/:id/requeue") @HttpCode(200) @ApiOperation({ summary: "Re-send a failed email" })
  requeue(@Req() request: FastifyRequest, @Param("id") id: string) { return this.console.requeueEmail(request.identity!, id); }
}

/** Platform (super admin) console: the whole shared queue, across organizations. */
@ApiTags("jobs") @ApiBearerAuth() @Controller("api/v2/platform/jobs") @Roles("PLATFORM_ADMIN")
export class PlatformJobsController {
  constructor(private readonly console: JobsConsoleService) {}

  @Get("failed") @ApiOperation({ summary: "Every failed job in the shared queue (platform administrators)" })
  failed(@Query() query: FailedJobsQuery) { return this.console.platformFailed(query.limit); }

  @Post("failed/:id/retry") @HttpCode(200) @ApiOperation({ summary: "Retry any failed job (platform administrators)" })
  retry(@Req() request: FastifyRequest, @Param("id") id: string) { return this.console.platformRetry(request.identity!, id); }
}

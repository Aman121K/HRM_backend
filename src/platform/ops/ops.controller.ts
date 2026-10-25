import { Controller, Get, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { Roles } from "../auth/roles.decorator";
import { OpsService } from "./ops.service";

@ApiTags("ops") @ApiBearerAuth() @Controller("api/v2/platform/ops") @Roles("PLATFORM_ADMIN")
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Get("status")
  @ApiOperation({ summary: "Read-only operational status: versions, uptime, queue depth, failed jobs, DB size, migrations, last backup marker" })
  status(@Req() request: FastifyRequest) { return this.ops.status(request.identity!); }
}

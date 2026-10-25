import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { Roles } from "../auth/roles.decorator";
import { ComplianceMarkDto, SignalActionDto, SignalsQuery, UpdateRiskSettingsDto } from "./risk.dto";
import { RiskService } from "./risk.service";

const VIEWERS = ["HR_ADMIN", "OWNER", "PAYROLL_ADMIN", "MANAGER"];

/** Risk & Compliance Center. Row-level visibility (payroll items, managers → direct reports) is enforced in RiskService. */
@ApiTags("risk") @ApiBearerAuth() @Controller("api/v2/risk")
export class RiskController {
  constructor(private readonly risk: RiskService) {}

  @Get("overview") @Roles(...VIEWERS) @ApiOperation({ summary: "Counts by area/severity, top signals and the statutory calendar (HR/payroll)" })
  overview(@Req() request: FastifyRequest) { return this.risk.overview(request.identity!); }

  @Get("signals") @Roles(...VIEWERS) @ApiOperation({ summary: "Signals visible to the caller, filtered by area, severity, status" })
  list(@Req() request: FastifyRequest, @Query() query: SignalsQuery) { return this.risk.list(request.identity!, query); }

  @Get("signals/:id") @Roles(...VIEWERS)
  get(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.risk.get(request.identity!, id); }

  @Post("signals/:id/:action") @HttpCode(200) @Roles(...VIEWERS) @ApiOperation({ summary: "acknowledge | resolve | dismiss (reason required) | reopen, with optimistic version" })
  act(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Param("action") action: string, @Body() input: SignalActionDto) {
    return this.risk.act(request.identity!, id, action, input);
  }

  @Post("scan") @HttpCode(200) @Roles("HR_ADMIN", "OWNER") @ApiOperation({ summary: "Run every detector for the caller's organization now" })
  scan(@Req() request: FastifyRequest) { return this.risk.scan(request.identity!); }

  @Get("settings") @Roles("HR_ADMIN", "OWNER", "PAYROLL_ADMIN")
  settings(@Req() request: FastifyRequest) { return this.risk.getSettings(request.identity!); }

  @Put("settings") @Roles("HR_ADMIN", "OWNER") @ApiOperation({ summary: "Thresholds per detector and the minimum-wage table (optimistic version)" })
  updateSettings(@Req() request: FastifyRequest, @Body() input: UpdateRiskSettingsDto) { return this.risk.updateSettings(request.identity!, input); }

  @Post("compliance/:key/mark") @HttpCode(200) @Roles("HR_ADMIN", "OWNER", "PAYROLL_ADMIN") @ApiOperation({ summary: "Mark (or unmark) a statutory obligation as filed" })
  mark(@Req() request: FastifyRequest, @Param("key") key: string, @Body() input: ComplianceMarkDto) { return this.risk.markObligation(request.identity!, key, input); }
}

import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { Roles } from "../auth/roles.decorator";
import { DeviceDecisionDto, DeviceQuery, HistoryQuery, NetworksDto, PolicyDto, PrecheckDto, PunchDto, ReviewDecisionDto, ReviewQuery, SiteDto } from "./attendance.dto";
import { AttendanceService } from "./attendance.service";

@ApiTags("attendance") @ApiBearerAuth() @Controller("api/v2/attendance")
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}
  @Get("today") today(@Req() request: FastifyRequest) { return this.attendance.today(request.identity!); }
  @Post("punch") punch(@Req() request: FastifyRequest, @Body() input: PunchDto) { return this.attendance.punch(request.identity!, input, request.ip); }
  @Post("precheck") precheck(@Req() request: FastifyRequest, @Body() input: PrecheckDto) { return this.attendance.precheck(request.identity!, input, request.ip); }
  /** Mobile: a fresh random device secret to keep in the Keychain/Keystore (phones have no secure RNG in JS). Nothing is stored until first punch. */
  @Post("device-token") deviceToken() { return { token: randomBytes(32).toString("base64url") }; }
  /** HR: every registered/pending punch device; others: their own. */
  @Get("devices") devices(@Req() request: FastifyRequest, @Query() query: DeviceQuery) { return this.attendance.devices(request.identity!, query.status); }
  @Post("devices/:id/decision") @Roles("HR_ADMIN", "OWNER")
  decideDevice(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: DeviceDecisionDto) { return this.attendance.decideDevice(request.identity!, id, input); }
  @Get("networks") @Roles("HR_ADMIN", "OWNER") networks(@Req() request: FastifyRequest) { return this.attendance.networks(request.identity!, request.ip); }
  @Put("networks") @Roles("HR_ADMIN", "OWNER")
  saveNetworks(@Req() request: FastifyRequest, @Body() input: NetworksDto) { return this.attendance.saveNetworks(request.identity!, input.items, request.ip); }
  @Get("policy") policy(@Req() request: FastifyRequest) { return this.attendance.policy(request.identity!); }
  @Put("policy") @Roles("HR_ADMIN", "OWNER")
  savePolicy(@Req() request: FastifyRequest, @Body() input: PolicyDto) { return this.attendance.savePolicy(request.identity!, input); }
  @Get("review") @Roles("MANAGER", "HR_ADMIN", "OWNER")
  reviewQueue(@Req() request: FastifyRequest, @Query() query: ReviewQuery) { return this.attendance.reviewQueue(request.identity!, query); }
  @Post("events/:id/review") @Roles("MANAGER", "HR_ADMIN", "OWNER")
  decide(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: ReviewDecisionDto) { return this.attendance.decide(request.identity!, id, input); }
  @Get("history") history(@Req() request: FastifyRequest, @Query() query: HistoryQuery) { return this.attendance.history(request.identity!, query); }
  @Get("sites") sites(@Req() request: FastifyRequest) { return this.attendance.sites(request.identity!); }
  @Post("sites") @Roles("HR_ADMIN", "OWNER")
  createSite(@Req() request: FastifyRequest, @Body() input: SiteDto) { return this.attendance.saveSite(request.identity!, input); }
  @Patch("sites/:id") @Roles("HR_ADMIN", "OWNER")
  updateSite(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: SiteDto) { return this.attendance.saveSite(request.identity!, input, id); }
}

import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { Roles } from "../auth/roles.decorator";
import { CreateLeaveDto, LeaveDecisionDto } from "./leave.dto";
import { LeaveService } from "./leave.service";

@ApiTags("leave") @ApiBearerAuth() @Controller("api/v2")
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}
  @Get("leave-types") types(@Req() request: FastifyRequest) { return this.leave.listTypes(request.identity!); }
  @Get("leaves") mine(@Req() request: FastifyRequest) { return this.leave.listMine(request.identity!); }
  @Post("leaves") @Roles("EMPLOYEE", "MANAGER", "HR_ADMIN")
  create(@Req() request: FastifyRequest, @Body() input: CreateLeaveDto) { return this.leave.create(request.identity!, input); }
  @Post("leaves/:id/withdraw")
  withdraw(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.leave.withdraw(request.identity!, id); }
  @Get("approvals/leaves") @Roles("MANAGER", "HR_ADMIN", "OWNER")
  approvals(@Req() request: FastifyRequest) { return this.leave.approvalQueue(request.identity!); }
  @Post("approvals/leaves/:id/decision") @Roles("MANAGER", "HR_ADMIN", "OWNER")
  decide(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: LeaveDecisionDto) {
    return this.leave.decide(request.identity!, id, input);
  }
}

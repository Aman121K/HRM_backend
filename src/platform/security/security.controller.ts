import { Controller, ForbiddenException, Get, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { SecurityService } from "./security.service";

@ApiTags("security") @ApiBearerAuth() @Controller("api/v2")
export class SecurityController {
  constructor(private readonly security: SecurityService) {}
  @Get("platform/security/posture") posture(@Req() request: FastifyRequest) { return this.security.posture(request.identity!); }
  @Get("platform/security/events") platformEvents(@Req() request: FastifyRequest, @Query("hours") hours = "24") { return this.security.events(request.identity!, Number(hours)); }
  /** Brand owners/HR see denied traffic attributed to their own brand. */
  @Get("security/events") brandEvents(@Req() request: FastifyRequest, @Query("hours") hours = "24") {
    const identity = request.identity!;
    if (!identity.roles.some((role) => ["OWNER", "HR_ADMIN"].includes(role))) throw new ForbiddenException("Only owners and HR admins can view security activity.");
    return this.security.events(identity, Number(hours), identity.organizationId);
  }
}

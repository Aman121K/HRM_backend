import { Controller, Get, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { PeopleService } from "./people.service";

@ApiTags("people")
@ApiBearerAuth()
@ApiHeader({ name: "x-tenant-id", required: false, description: "Local development only" })
@ApiHeader({ name: "x-employee-id", required: false, description: "Local development only" })
@Controller("api/v2")
export class PeopleController {
  constructor(private readonly people: PeopleService) {}
  @Get("me")
  @ApiOperation({ summary: "Current organization employee profile" })
  me(@Req() request: FastifyRequest) {
    return this.people.me(request.identity!);
  }
  @Get("employees")
  @ApiOperation({ summary: "Tenant employee directory" })
  list(@Req() request: FastifyRequest, @Query("search") search = "", @Query("limit") limit = "50", @Query("offset") offset = "0") {
    return this.people.list(request.identity!, search, Number(limit), Number(offset));
  }
}

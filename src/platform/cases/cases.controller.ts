import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { CaseCommentDto, CaseTransitionDto, CreateCaseDto, ListCasesQuery } from "./cases.dto";
import { CasesService } from "./cases.service";

@ApiTags("cases") @ApiBearerAuth() @Controller("api/v2/cases")
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Get("modules") @ApiOperation({ summary: "Module definitions, state machines and form fields" })
  modules(@Req() request: FastifyRequest) { return this.cases.definitions(request.identity!); }

  @Get("inbox") @ApiOperation({ summary: "Requests awaiting the current user's action across modules" })
  inbox(@Req() request: FastifyRequest) { return this.cases.inbox(request.identity!); }

  @Get("summary") @ApiOperation({ summary: "Home dashboard counts, recognition wall and job openings" })
  summary(@Req() request: FastifyRequest) { return this.cases.summary(request.identity!); }

  @Get() list(@Req() request: FastifyRequest, @Query() query: ListCasesQuery) { return this.cases.list(request.identity!, query); }

  @Post() create(@Req() request: FastifyRequest, @Body() input: CreateCaseDto) { return this.cases.create(request.identity!, input); }

  @Get(":id") get(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.cases.get(request.identity!, id); }

  @Post(":id/transitions")
  transition(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: CaseTransitionDto) {
    return this.cases.transition(request.identity!, id, input);
  }

  @Post(":id/comments")
  comment(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: CaseCommentDto) {
    return this.cases.comment(request.identity!, id, input);
  }
}

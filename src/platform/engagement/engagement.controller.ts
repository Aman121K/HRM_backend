import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, StreamableFile } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { CreatePollDto, ListSurveysQuery, ResultsQuery, SubmitResponseDto, SurveyInputDto, UpdateSurveyDto, VersionDto, VoteDto } from "./engagement.dto";
import { EngagementService } from "./engagement.service";

@ApiTags("engagement") @ApiBearerAuth() @Controller("api/v2/engagement")
export class EngagementController {
  constructor(private readonly engagement: EngagementService) {}

  @Get("home") @ApiOperation({ summary: "Surveys waiting for, answered by and missed by the current employee" })
  home(@Req() request: FastifyRequest) { return this.engagement.home(request.identity!); }

  @Get("options") @ApiOperation({ summary: "Audience picker data (departments, locations, team size) for survey builders" })
  options(@Req() request: FastifyRequest) { return this.engagement.options(request.identity!); }

  // ---- polls
  @Get("polls") @ApiOperation({ summary: "Active and recently closed quick polls for the current employee" })
  polls(@Req() request: FastifyRequest) { return this.engagement.polls(request.identity!); }

  @Post("polls") @ApiOperation({ summary: "Create a quick poll (goes live immediately)" })
  createPoll(@Req() request: FastifyRequest, @Body() input: CreatePollDto) { return this.engagement.createPoll(request.identity!, input); }

  @Post("polls/:id/vote")
  vote(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: VoteDto) { return this.engagement.vote(request.identity!, id, input); }

  @Post("polls/:id/close")
  closePoll(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: VersionDto) { return this.engagement.close(request.identity!, id, input.version); }

  // ---- surveys
  @Get("surveys") @ApiOperation({ summary: "Surveys the viewer manages (HR: all; managers: their own)" })
  list(@Req() request: FastifyRequest, @Query() query: ListSurveysQuery) { return this.engagement.list(request.identity!, query); }

  @Post("surveys") @ApiOperation({ summary: "Create a draft survey" })
  create(@Req() request: FastifyRequest, @Body() input: SurveyInputDto) { return this.engagement.create(request.identity!, input); }

  @Get("surveys/:id")
  get(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.engagement.get(request.identity!, id); }

  @Patch("surveys/:id") @ApiOperation({ summary: "Edit a draft (anything) or a live survey (description, close date, result sharing)" })
  update(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: UpdateSurveyDto) { return this.engagement.update(request.identity!, id, input); }

  @Delete("surveys/:id")
  remove(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Query() input: VersionDto) { return this.engagement.remove(request.identity!, id, input.version); }

  @Post("surveys/:id/launch")
  launch(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: VersionDto) { return this.engagement.launch(request.identity!, id, input.version); }

  @Post("surveys/:id/close")
  close(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: VersionDto) { return this.engagement.close(request.identity!, id, input.version); }

  @Post("surveys/:id/duplicate")
  duplicate(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.engagement.duplicate(request.identity!, id); }

  @Post("surveys/:id/reminders") @ApiOperation({ summary: "Notify invitees who have not responded (counts only, 20 h cooldown per person)" })
  remind(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.engagement.remind(request.identity!, id); }

  @Post("surveys/:id/responses") @ApiOperation({ summary: "Submit (or, when allowed, edit) the viewer's response" })
  respond(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: SubmitResponseDto) { return this.engagement.respond(request.identity!, id, input); }

  @Get("surveys/:id/results")
  results(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Query() query: ResultsQuery) { return this.engagement.results(request.identity!, id, query); }

  @Get("surveys/:id/export.csv")
  async exportCsv(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) {
    const file = await this.engagement.csv(request.identity!, id);
    return new StreamableFile(file.body, { type: "text/csv; charset=utf-8", disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, length: file.body.length });
  }
}

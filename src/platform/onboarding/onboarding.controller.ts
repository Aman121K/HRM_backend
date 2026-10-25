import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import {
  AddTaskDto, CreateJoinerDto, RevealJoinerDto, JoinerTransitionDto, ListJoinersQuery, ListMyTasksQuery, ReviewDocumentDto, SaveSettingsDto, SaveTemplateDto,
  TaskActionDto, UpcomingQuery, UpdateJoinerDto, UpdateTaskDto,
} from "./onboarding.dto";
import { OnboardingService } from "./onboarding.service";

@ApiTags("onboarding") @ApiBearerAuth() @Controller("api/v2/onboarding")
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get("joiners") @ApiOperation({ summary: "Pipeline of joiners visible to the viewer, with progress and KPIs" })
  list(@Req() request: FastifyRequest, @Query() query: ListJoinersQuery) { return this.onboarding.list(request.identity!, query); }

  @Post("joiners") @ApiOperation({ summary: "HR: add a joiner (optionally from a hired candidate) and instantiate the checklist" })
  create(@Req() request: FastifyRequest, @Body() input: CreateJoinerDto) { return this.onboarding.create(request.identity!, input); }

  @Get("upcoming") @ApiOperation({ summary: "Joiners starting in the next N days (dashboard widget)" })
  upcoming(@Req() request: FastifyRequest, @Query() query: UpcomingQuery) { return this.onboarding.upcoming(request.identity!, query); }

  @Get("candidates") @ApiOperation({ summary: "HR: hired candidates not yet added to onboarding" })
  candidates(@Req() request: FastifyRequest) { return this.onboarding.hiredCandidates(request.identity!); }

  @Get("welcome") @ApiOperation({ summary: "The signed-in employee's own onboarding plan" })
  welcome(@Req() request: FastifyRequest) { return this.onboarding.welcome(request.identity!); }

  @Get("my-tasks") @ApiOperation({ summary: "Onboarding tasks owned by the viewer across joiners" })
  myTasks(@Req() request: FastifyRequest, @Query() query: ListMyTasksQuery) { return this.onboarding.myTasks(request.identity!, query); }

  @Get("joiners/:id") get(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.onboarding.get(request.identity!, id); }

  @Patch("joiners/:id")
  update(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: UpdateJoinerDto) { return this.onboarding.update(request.identity!, id, input); }

  @Post("joiners/:id/reveal") @Header("cache-control", "private, no-store")
  @ApiOperation({ summary: "HR: decrypt the joiner's PAN for verification (audited as PII_REVEALED)" })
  reveal(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: RevealJoinerDto) { return this.onboarding.revealPan(request.identity!, id, input.reason); }

  @Post("joiners/:id/transitions") @ApiOperation({ summary: "ready | back_to_preboarding | convert | complete | withdraw" })
  transition(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: JoinerTransitionDto) { return this.onboarding.transition(request.identity!, id, input); }

  @Get("joiners/:id/conversion-preview") @ApiOperation({ summary: "HR: the work email and employee number conversion would use" })
  preview(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.onboarding.suggestWorkEmail(request.identity!, id); }

  @Post("joiners/:id/tasks")
  addTask(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: AddTaskDto) { return this.onboarding.addTask(request.identity!, id, input); }

  @Post("tasks/:id/actions") @ApiOperation({ summary: "complete | skip | reopen a task" })
  taskAction(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: TaskActionDto) { return this.onboarding.taskAction(request.identity!, id, input); }

  @Patch("tasks/:id") @ApiOperation({ summary: "HR: reassign owner, move due date or rename a task" })
  updateTask(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: UpdateTaskDto) { return this.onboarding.updateTask(request.identity!, id, input); }

  @Post("documents/:fileId/review") @ApiOperation({ summary: "HR: verify or reject an uploaded joiner document" })
  review(@Req() request: FastifyRequest, @Param("fileId", ParseUUIDPipe) fileId: string, @Body() input: ReviewDocumentDto) { return this.onboarding.reviewDocument(request.identity!, fileId, input); }

  @Get("templates") templates(@Req() request: FastifyRequest) { return this.onboarding.templates(request.identity!); }
  @Post("templates") createTemplate(@Req() request: FastifyRequest, @Body() input: SaveTemplateDto) { return this.onboarding.saveTemplate(request.identity!, null, input); }
  @Get("templates/:id") template(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.onboarding.template(request.identity!, id); }
  @Put("templates/:id")
  saveTemplate(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: SaveTemplateDto) { return this.onboarding.saveTemplate(request.identity!, id, input); }
  @Post("templates/:id/archive")
  archive(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.onboarding.archiveTemplate(request.identity!, id); }

  @Get("settings") settings(@Req() request: FastifyRequest) { return this.onboarding.settings(request.identity!); }
  @Put("settings") saveSettings(@Req() request: FastifyRequest, @Body() input: SaveSettingsDto) { return this.onboarding.saveSettings(request.identity!, input); }
}

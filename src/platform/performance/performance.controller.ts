import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { Roles } from "../auth/roles.decorator";
import {
  AdvanceCycleDto, CalibrateDto, CycleDto, GoalDecisionDto, NominateDto, ProgressDto, ReviewDto, RevisionDecisionDto, SaveGoalsDto,
} from "./performance.dto";
import { PerformanceService } from "./performance.service";

const HR = ["HR_ADMIN", "OWNER"];

/** Appraisal cycles: goals/OKRs → self, manager and 360 reviews → calibration → published ratings → salary revisions. */
@ApiTags("performance") @ApiBearerAuth() @Controller("api/v2/performance")
export class PerformanceController {
  constructor(private readonly performance: PerformanceService) {}

  @Get("context") @ApiOperation({ summary: "Cycles visible to the viewer, their role and pending feedback count" })
  context(@Req() request: FastifyRequest) { return this.performance.context(request.identity!); }

  @Post("cycles") @Roles(...HR) createCycle(@Req() request: FastifyRequest, @Body() input: CycleDto) { return this.performance.createCycle(request.identity!, input); }

  @Patch("cycles/:id") @Roles(...HR) @ApiOperation({ summary: "Edit a draft cycle (after launch, only due dates)" })
  updateCycle(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: CycleDto) { return this.performance.updateCycle(request.identity!, id, input); }

  @Post("cycles/:id/advance") @Roles(...HR) @ApiOperation({ summary: "Draft → goal setting → reviews → calibration → published → closed" })
  advance(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: AdvanceCycleDto) { return this.performance.advance(request.identity!, id, input); }

  @Get("cycles/:id/me") mine(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.performance.mine(request.identity!, id); }

  @Put("cycles/:id/me/goals") @ApiOperation({ summary: "Save (or submit) my goals and key results" })
  myGoals(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: SaveGoalsDto) { return this.performance.saveGoals(request.identity!, id, input); }

  @Put("cycles/:id/me/review") @ApiOperation({ summary: "Save or submit my self review" })
  myReview(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: ReviewDto) {
    return this.performance.saveReview(request.identity!, id, request.identity!.employeeId, input);
  }

  @Post("cycles/:id/nominations") @ApiOperation({ summary: "Ask colleagues for 360 feedback" })
  nominate(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: NominateDto) { return this.performance.nominate(request.identity!, id, input); }

  @Get("cycles/:id/team") @ApiOperation({ summary: "Direct reports (or everyone for HR) with progress, ratings and the rating distribution" })
  team(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.performance.team(request.identity!, id); }

  @Get("cycles/:id/people/:employeeId") @ApiOperation({ summary: "A report's full sheet (manager) or anyone's (HR)" })
  person(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Param("employeeId", ParseUUIDPipe) employeeId: string) {
    return this.performance.person(request.identity!, id, employeeId);
  }

  @Put("cycles/:id/people/:employeeId/goals") @ApiOperation({ summary: "Manager/HR set goals for a report (submit = approve)" })
  setGoals(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Param("employeeId", ParseUUIDPipe) employeeId: string, @Body() input: SaveGoalsDto) {
    return this.performance.saveGoals(request.identity!, id, input, employeeId);
  }

  @Post("cycles/:id/people/:employeeId/goals/decision") @ApiOperation({ summary: "approve | return submitted goals" })
  decideGoals(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Param("employeeId", ParseUUIDPipe) employeeId: string, @Body() input: GoalDecisionDto) {
    return this.performance.decideGoals(request.identity!, id, employeeId, input);
  }

  @Put("cycles/:id/people/:employeeId/review") @ApiOperation({ summary: "Save or submit the manager review (with increment / promotion recommendation)" })
  managerReview(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Param("employeeId", ParseUUIDPipe) employeeId: string, @Body() input: ReviewDto) {
    return this.performance.saveReview(request.identity!, id, employeeId, input);
  }

  @Put("cycles/:id/people/:employeeId/calibration") @Roles(...HR) @ApiOperation({ summary: "Final rating, increment and promotion (proposes a salary revision)" })
  calibrate(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Param("employeeId", ParseUUIDPipe) employeeId: string, @Body() input: CalibrateDto) {
    return this.performance.calibrate(request.identity!, id, employeeId, input);
  }

  @Post("cycles/:id/revisions") @Roles(...HR) @ApiOperation({ summary: "approve (maker-checker) or apply revisions as new salary structures" })
  revisions(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: RevisionDecisionDto) { return this.performance.revisions(request.identity!, id, input); }

  @Patch("goals/:goalId/progress") @ApiOperation({ summary: "Check-in: update key result values" })
  progress(@Req() request: FastifyRequest, @Param("goalId", ParseUUIDPipe) goalId: string, @Body() input: ProgressDto) { return this.performance.updateProgress(request.identity!, goalId, input); }

  @Get("feedback") @ApiOperation({ summary: "360 feedback I've been asked to give" })
  feedback(@Req() request: FastifyRequest) { return this.performance.feedbackRequests(request.identity!); }

  @Put("feedback/:reviewId") submitFeedback(@Req() request: FastifyRequest, @Param("reviewId", ParseUUIDPipe) reviewId: string, @Body() input: ReviewDto) {
    return this.performance.submitFeedback(request.identity!, reviewId, input);
  }

  @Post("feedback/:reviewId/decline") decline(@Req() request: FastifyRequest, @Param("reviewId", ParseUUIDPipe) reviewId: string) {
    return this.performance.declineFeedback(request.identity!, reviewId);
  }
}

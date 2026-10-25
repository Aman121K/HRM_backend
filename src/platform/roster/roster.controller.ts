import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { Roles } from "../auth/roles.decorator";
import { CopyWeekDto, MyRosterQuery, SaveAssignmentsDto, SettingsDto, TemplateDto, UpdateTemplateDto, WeekQuery, WeekScopeDto } from "./roster.dto";
import { RosterService } from "./roster.service";

const PLANNERS = ["MANAGER", "HR_ADMIN", "OWNER"];
const HR = ["HR_ADMIN", "OWNER"];

@ApiTags("roster") @ApiBearerAuth() @Controller("api/v2/roster")
export class RosterController {
  constructor(private readonly roster: RosterService) {}

  @Get("context") @ApiOperation({ summary: "Viewer capabilities, shift templates, rules and filter facets" })
  context(@Req() request: FastifyRequest) { return this.roster.context(request.identity!); }

  @Get("week") @ApiOperation({ summary: "Planning grid for a Monday-start week with rule warnings, coverage and publish state" })
  week(@Req() request: FastifyRequest, @Query() query: WeekQuery) { return this.roster.week(request.identity!, query); }

  @Get("me") @ApiOperation({ summary: "The signed-in employee's published roster for this week and next" })
  mine(@Req() request: FastifyRequest, @Query() query: MyRosterQuery) { return this.roster.mine(request.identity!, query.start); }

  @Get("me/today") @ApiOperation({ summary: "Today's published shift and the next upcoming shift (dashboard)" })
  today(@Req() request: FastifyRequest) { return this.roster.today(request.identity!); }

  @Put("assignments") @Roles(...PLANNERS) @ApiOperation({ summary: "Assign, change or clear roster cells in bulk" })
  save(@Req() request: FastifyRequest, @Body() input: SaveAssignmentsDto) { return this.roster.saveAssignments(request.identity!, input); }

  @Post("weeks/copy-previous") @Roles(...PLANNERS) @ApiOperation({ summary: "Copy the previous week's plan into this week" })
  copy(@Req() request: FastifyRequest, @Body() input: CopyWeekDto) { return this.roster.copyPreviousWeek(request.identity!, input); }

  @Post("weeks/clear") @Roles(...PLANNERS) @ApiOperation({ summary: "Clear the week for the given people" })
  clear(@Req() request: FastifyRequest, @Body() input: WeekScopeDto) { return this.roster.clearWeek(request.identity!, input); }

  @Post("weeks/publish") @Roles(...PLANNERS) @ApiOperation({ summary: "Publish (or re-publish changes) and notify affected employees" })
  publish(@Req() request: FastifyRequest, @Body() input: WeekScopeDto) { return this.roster.publish(request.identity!, input); }

  @Post("shift-requests/:id/apply") @Roles(...PLANNERS) @ApiOperation({ summary: "Apply an approved shift-change request to the roster" })
  applyRequest(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.roster.applyShiftRequest(request.identity!, id); }

  @Get("templates") templates(@Req() request: FastifyRequest) { return this.roster.listTemplates(request.identity!); }

  @Post("templates") @Roles(...HR)
  createTemplate(@Req() request: FastifyRequest, @Body() input: TemplateDto) { return this.roster.createTemplate(request.identity!, input); }

  @Patch("templates/:id") @Roles(...HR)
  updateTemplate(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: UpdateTemplateDto) {
    return this.roster.updateTemplate(request.identity!, id, input);
  }

  @Put("settings") @Roles(...HR)
  settings(@Req() request: FastifyRequest, @Body() input: SettingsDto) { return this.roster.updateSettings(request.identity!, input); }
}

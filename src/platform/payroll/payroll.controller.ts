import { Body, Controller, Delete, Get, Header, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, StreamableFile } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Roles } from "../auth/roles.decorator";
import {
  CreateRunDto, CreateStructureDto, EmployeeQuery, HoldDto, PreviewStructureDto, RevealDto, RunInputDto, RunTransitionDto, RunVersionDto, SearchQuery,
  UpdateProfileDto, UpdateSettingsDto,
} from "./payroll.dto";
import { PAYROLL_ROLES } from "./payroll.shared";
import { PayrollService } from "./payroll.service";
import { RunsService } from "./runs.service";

const EXPORTS = ["bank", "pf-ecr", "esi", "pt", "register"];

@ApiTags("payroll") @ApiBearerAuth() @Controller("api/v2/payroll")
export class PayrollController {
  constructor(private readonly payroll: PayrollService, private readonly runs: RunsService) {}

  @Get("meta") @ApiOperation({ summary: "Statutory rule set (versioned, with sources and disclaimer), org settings and viewer permissions" })
  meta(@Req() request: FastifyRequest) { return this.payroll.meta(request.identity!); }

  @Put("settings") @Roles(...PAYROLL_ROLES)
  settings(@Req() request: FastifyRequest, @Body() input: UpdateSettingsDto) { return this.payroll.updateSettings(request.identity!, input); }

  // Employee self-service
  @Get("me") @ApiOperation({ summary: "My salary structure, published payslips, YTD totals and tax projection" })
  me(@Req() request: FastifyRequest) { return this.payroll.me(request.identity!); }

  @Get("payslips/:period")
  payslip(@Req() request: FastifyRequest, @Param("period") period: string, @Query() query: EmployeeQuery) {
    return this.payroll.payslip(request.identity!, period, query.employeeId);
  }

  @Get("payslips/:period/document") @Header("cache-control", "private, no-store") @Header("x-content-type-options", "nosniff")
  @ApiOperation({ summary: "Printable payslip (HTML with print stylesheet — use the browser's Save as PDF)" })
  async payslipDocument(@Req() request: FastifyRequest, @Param("period") period: string, @Query() query: EmployeeQuery) {
    const document = await this.payroll.payslipDocument(request.identity!, period, query.employeeId);
    const bytes = Buffer.from(document.html, "utf8");
    return new StreamableFile(bytes, { type: "text/html; charset=utf-8", disposition: `attachment; filename*=UTF-8''${encodeURIComponent(document.fileName)}`, length: bytes.length });
  }

  // Salary structures & payroll profiles
  @Get("structures") @Roles(...PAYROLL_ROLES)
  structures(@Req() request: FastifyRequest, @Query() query: SearchQuery) { return this.payroll.listStructures(request.identity!, query.search); }

  @Post("structures/preview") @Roles(...PAYROLL_ROLES) @ApiOperation({ summary: "Live CTC breakdown + indicative take-home for a draft structure" })
  preview(@Req() request: FastifyRequest, @Body() input: PreviewStructureDto) { return this.payroll.preview(request.identity!, input); }

  @Post("structures") @Roles(...PAYROLL_ROLES)
  createStructure(@Req() request: FastifyRequest, @Body() input: CreateStructureDto) { return this.payroll.createStructure(request.identity!, input); }

  @Delete("structures/:id") @Roles(...PAYROLL_ROLES)
  deleteStructure(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.payroll.deleteStructure(request.identity!, id); }

  @Get("employees/:employeeId") @ApiOperation({ summary: "Structure history and payroll profile (admins, or the employee themself — masked)" })
  employee(@Req() request: FastifyRequest, @Param("employeeId", ParseUUIDPipe) employeeId: string) { return this.payroll.employeeStructures(request.identity!, employeeId); }

  @Put("employees/:employeeId/profile") @Roles(...PAYROLL_ROLES)
  profile(@Req() request: FastifyRequest, @Param("employeeId", ParseUUIDPipe) employeeId: string, @Body() input: UpdateProfileDto) {
    return this.payroll.updateProfile(request.identity!, employeeId, input);
  }

  @Post("employees/:employeeId/reveal") @Header("cache-control", "private, no-store")
  @ApiOperation({ summary: "Decrypt one identifier (pan | uan | esiNumber | bankAccount) — payroll/HR admins or the employee themself; audited as PII_REVEALED" })
  reveal(@Req() request: FastifyRequest, @Param("employeeId", ParseUUIDPipe) employeeId: string, @Body() input: RevealDto) {
    return this.payroll.reveal(request.identity!, employeeId, input.field, input.reason);
  }

  // Payroll runs
  @Get("runs") @Roles(...PAYROLL_ROLES)
  listRuns(@Req() request: FastifyRequest) { return this.runs.list(request.identity!); }

  @Post("runs") @Roles(...PAYROLL_ROLES)
  createRun(@Req() request: FastifyRequest, @Body() input: CreateRunDto) { return this.runs.create(request.identity!, input); }

  @Get("runs/:id") @Roles(...PAYROLL_ROLES)
  getRun(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.runs.get(request.identity!, id); }

  @Post("runs/:id/calculate") @Roles(...PAYROLL_ROLES) @ApiOperation({ summary: "Calculate (or recalculate) every employee line" })
  calculate(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: RunVersionDto) { return this.runs.calculate(request.identity!, id, input.version); }

  @Post("runs/:id/transitions") @Roles(...PAYROLL_ROLES) @ApiOperation({ summary: "submit | approve | reject | reopen | publish | lock | cancel (maker-checker on approve)" })
  transition(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: RunTransitionDto) { return this.runs.transition(request.identity!, id, input); }

  @Get("runs/:id/lines/:employeeId") @Roles(...PAYROLL_ROLES)
  line(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Param("employeeId", ParseUUIDPipe) employeeId: string) {
    return this.runs.line(request.identity!, id, employeeId);
  }

  @Post("runs/:id/lines/:employeeId/hold") @Roles(...PAYROLL_ROLES)
  hold(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Param("employeeId", ParseUUIDPipe) employeeId: string, @Body() input: HoldDto) {
    return this.runs.hold(request.identity!, id, employeeId, input);
  }

  @Post("runs/:id/inputs") @Roles(...PAYROLL_ROLES)
  addInput(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: RunInputDto) { return this.runs.addInput(request.identity!, id, input); }

  @Delete("runs/:id/inputs/:inputId") @Roles(...PAYROLL_ROLES)
  removeInput(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Param("inputId", ParseUUIDPipe) inputId: string) {
    return this.runs.removeInput(request.identity!, id, inputId);
  }

  @Get("runs/:id/exports/:kind") @Roles(...PAYROLL_ROLES) @Header("cache-control", "private, no-store") @Header("x-content-type-options", "nosniff")
  @ApiOperation({ summary: "bank | pf-ecr | esi | pt | register" })
  async export(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Param("id", ParseUUIDPipe) id: string, @Param("kind") kind: string) {
    if (!EXPORTS.includes(kind)) throw new NotFoundException("Unknown export.");
    const file = await this.runs.exportFile(request.identity!, id, kind);
    const bytes = Buffer.from(file.body, "utf8");
    // Integrity/control values (also recorded in the PAYROLL_EXPORTED audit row).
    reply.header("x-file-sha256", file.sha256).header("x-row-count", String(file.rows)).header("x-control-total", String(file.total));
    return new StreamableFile(bytes, { type: `${file.type}; charset=utf-8`, disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, length: bytes.length });
  }
}

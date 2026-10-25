import { Body, Controller, Delete, Get, Header, NotFoundException, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query, Req, Res, StreamableFile } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyReply, FastifyRequest } from "fastify";
import { IsInt } from "class-validator";
import { Roles } from "../auth/roles.decorator";
import { PAYROLL_ROLES } from "../payroll/payroll.shared";
import { ChallanDto, DeductorDto, FyQuery, GenerateDto, PartAUploadDto, QuarterFilingDto, UpdateChallanDto } from "./returns.dto";
import { ReturnsService } from "./returns.service";
import type { Quarter } from "./tds-math";

class VersionDto { @IsInt() version!: number; }
const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];
const quarterParam = (value: string) => { const q = String(value).toUpperCase(); if (!QUARTERS.includes(q)) throw new NotFoundException("Unknown quarter."); return q as Quarter; };
const fyParam = (value: number) => { if (value < 2020 || value > 2100) throw new NotFoundException("Unknown year."); return value; };
const attachment = (bytes: Buffer, type: string, name: string) =>
  new StreamableFile(bytes, { type, disposition: `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, length: bytes.length });

/** Statutory returns: TDS challans, quarterly Form 138 / 24Q, annual Form 130 / 16 + perquisites, employee tax documents. */
@ApiTags("payroll-returns") @ApiBearerAuth() @Controller("api/v2/payroll/returns")
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  // Employee self-service (published documents only)
  @Get("mine") @ApiOperation({ summary: "My published tax documents (Form 130/16, perquisites, quarterly TDS summary) per year" })
  mine(@Req() request: FastifyRequest) { return this.returns.mine(request.identity!); }

  @Get("documents/:fy/:employeeId/:kind") @Header("cache-control", "private, no-store") @Header("x-content-type-options", "nosniff")
  @ApiOperation({ summary: "certificate | perquisites | tds-summary | part-a PDF — payroll admins, or the employee themself once published" })
  async document(@Req() request: FastifyRequest, @Param("fy", ParseIntPipe) fy: number, @Param("employeeId", ParseUUIDPipe) employeeId: string, @Param("kind") kind: string) {
    const file = await this.returns.document(request.identity!, fyParam(fy), employeeId, kind);
    return attachment(file.bytes, file.type, file.name);
  }

  // Payroll admin workspace
  @Get("overview") @Roles(...PAYROLL_ROLES) @ApiOperation({ summary: "Quarter workspace: months, challans, deposits vs deductions, validation, statement status" })
  overview(@Req() request: FastifyRequest, @Query() query: FyQuery) { return this.returns.overview(request.identity!, query.fy, query.quarter || "Q1"); }

  @Get("deductor") @Roles(...PAYROLL_ROLES)
  deductor(@Req() request: FastifyRequest) { return this.returns.getDeductor(request.identity!); }

  @Put("deductor") @Roles(...PAYROLL_ROLES)
  updateDeductor(@Req() request: FastifyRequest, @Body() input: DeductorDto) { return this.returns.updateDeductor(request.identity!, input); }

  @Post("challans") @Roles(...PAYROLL_ROLES)
  createChallan(@Req() request: FastifyRequest, @Body() input: ChallanDto) { return this.returns.createChallan(request.identity!, input); }

  @Put("challans/:id") @Roles(...PAYROLL_ROLES)
  updateChallan(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: UpdateChallanDto) { return this.returns.updateChallan(request.identity!, id, input); }

  @Delete("challans/:id") @Roles(...PAYROLL_ROLES)
  deleteChallan(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.returns.deleteChallan(request.identity!, id); }

  @Post("quarters/:fy/:quarter/allocate") @Roles(...PAYROLL_ROLES) @ApiOperation({ summary: "Map the quarter's deducted TDS (published/locked runs) onto its challans" })
  allocate(@Req() request: FastifyRequest, @Param("fy", ParseIntPipe) fy: number, @Param("quarter") quarter: string) {
    return this.returns.allocateQuarter(request.identity!, fyParam(fy), quarterParam(quarter));
  }

  @Put("quarters/:fy/:quarter/filing") @Roles(...PAYROLL_ROLES) @ApiOperation({ summary: "Record the filed statement's token number (or reopen as draft)" })
  filing(@Req() request: FastifyRequest, @Param("fy", ParseIntPipe) fy: number, @Param("quarter") quarter: string, @Body() input: QuarterFilingDto) {
    return this.returns.recordFiling(request.identity!, fyParam(fy), quarterParam(quarter), input);
  }

  @Get("quarters/:fy/:quarter/files/:kind") @Roles(...PAYROLL_ROLES) @Header("cache-control", "private, no-store") @Header("x-content-type-options", "nosniff")
  @ApiOperation({ summary: "form138 (RPU/FVU text) | annexure1 | annexure2 (Q4) | challans (CSV) | review (PDF)" })
  async file(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Param("fy", ParseIntPipe) fy: number, @Param("quarter") quarter: string, @Param("kind") kind: string) {
    const file = await this.returns.statementFile(request.identity!, fyParam(fy), quarterParam(quarter), kind);
    const bytes = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body, "utf8");
    reply.header("x-file-sha256", file.sha256).header("x-row-count", String(file.rows));
    return attachment(bytes, file.type === "application/pdf" ? file.type : `${file.type}; charset=utf-8`, file.name);
  }

  @Get("certificates/:fy") @Roles(...PAYROLL_ROLES)
  certificates(@Req() request: FastifyRequest, @Param("fy", ParseIntPipe) fy: number) { return this.returns.listDocuments(request.identity!, fyParam(fy)); }

  @Post("certificates/:fy/generate") @Roles(...PAYROLL_ROLES) @ApiOperation({ summary: "Generate the next batch of annual certificates; repeat until status is GENERATED" })
  generate(@Req() request: FastifyRequest, @Param("fy", ParseIntPipe) fy: number, @Body() input: GenerateDto) { return this.returns.generate(request.identity!, fyParam(fy), Boolean(input.restart)); }

  @Post("certificates/:fy/publish") @Roles(...PAYROLL_ROLES) @ApiOperation({ summary: "Publish to employees (maker-checker: not the person who generated them)" })
  publish(@Req() request: FastifyRequest, @Param("fy", ParseIntPipe) fy: number, @Body() input: VersionDto) { return this.returns.publish(request.identity!, fyParam(fy), input.version); }

  @Post("certificates/:fy/:employeeId/part-a") @Roles(...PAYROLL_ROLES) @ApiOperation({ summary: "Attach the TRACES-issued Part A PDF (base64)" })
  partA(@Req() request: FastifyRequest, @Param("fy", ParseIntPipe) fy: number, @Param("employeeId", ParseUUIDPipe) employeeId: string, @Body() input: PartAUploadDto) {
    return this.returns.uploadPartA(request.identity!, fyParam(fy), employeeId, input);
  }
}

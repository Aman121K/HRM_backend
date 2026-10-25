import { Body, Controller, ForbiddenException, Get, Header, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req, StreamableFile } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { Roles } from "../auth/roles.decorator";
import { CommitDto, PayslipImportDto, SettingsDto, UndoDto } from "./imports.dto";
import { IMPORT_ROLES, ImportsService, canRun, kindFromSlug } from "./imports.service";
import { COLUMNS, KIND_LABELS, PAYSLIP_HELP, helpCsv, templateCsv, type ImportKind } from "./templates";

const csvFile = (text: string, name: string) => {
  const bytes = Buffer.from(`﻿${text}`, "utf8");
  return new StreamableFile(bytes, { type: "text/csv; charset=utf-8", disposition: `attachment; filename="${name}"`, length: bytes.length });
};

/** Switch-over import (opening data from PeopleStrong / Excel / another HRMS). HR: people + leave; payroll: salary, YTD, payslips. */
@ApiTags("imports") @ApiBearerAuth() @Controller("api/v2/imports")
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get("overview") @Roles(...IMPORT_ROLES) @ApiOperation({ summary: "Cut-over checklist: steps, counts, last batch per step" })
  overview(@Req() request: FastifyRequest) { return this.imports.overview(request.identity!); }

  @Get("settings") @Roles(...IMPORT_ROLES) settings(@Req() request: FastifyRequest) { return this.imports.getSettings(request.identity!); }
  @Put("settings") @Roles(...IMPORT_ROLES) @ApiOperation({ summary: "Cut-over date, last month paid by the old system, control totals" })
  updateSettings(@Req() request: FastifyRequest, @Body() input: SettingsDto) { return this.imports.updateSettings(request.identity!, input); }

  @Get("batches") @Roles(...IMPORT_ROLES)
  batches(@Req() request: FastifyRequest, @Query("kind") kind?: string) { return this.imports.listBatches(request.identity!, kind ? kindFromSlug(kind) : undefined); }
  @Get("batches/:id") @Roles(...IMPORT_ROLES)
  batch(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.imports.batch(request.identity!, id); }
  @Post("batches/:id/undo") @Roles(...IMPORT_ROLES) @ApiOperation({ summary: "Revert every record a batch wrote (only while nothing depends on it)" })
  undo(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: UndoDto) { return this.imports.undo(request.identity!, id, input); }

  @Get("reconciliation") @Roles(...IMPORT_ROLES) @ApiOperation({ summary: "Imported totals vs the old system's control totals" })
  reconciliation(@Req() request: FastifyRequest) { return this.imports.reconciliation(request.identity!); }
  @Get("leave-balances") @Roles("HR_ADMIN", "OWNER")
  leaveBalances(@Req() request: FastifyRequest, @Query("employeeNumber") employeeNumber?: string) { return this.imports.leaveBalances(request.identity!, employeeNumber); }

  // Payslip PDFs (before the generic :kind routes).
  @Post("payslips/dry-run") @Roles("PAYROLL_ADMIN", "OWNER")
  payslipDryRun(@Req() request: FastifyRequest, @Body() input: PayslipImportDto) { return this.imports.payslipDryRun(request.identity!, input); }
  @Post("payslips/commit") @Roles("PAYROLL_ADMIN", "OWNER")
  payslipCommit(@Req() request: FastifyRequest, @Body() input: PayslipImportDto) { return this.imports.payslipCommit(request.identity!, input); }
  /** Employee self-service: "Previous payslips (imported)". */
  @Get("payslips/mine") mine(@Req() request: FastifyRequest) { return this.imports.importedPayslips(request.identity!, request.identity!.employeeId); }
  @Get("payslips/employee/:employeeId") @Roles("PAYROLL_ADMIN", "OWNER")
  employeePayslips(@Req() request: FastifyRequest, @Param("employeeId", ParseUUIDPipe) employeeId: string) { return this.imports.importedPayslips(request.identity!, employeeId); }

  @Get(":kind/template") @Roles(...IMPORT_ROLES) @Header("cache-control", "no-store")
  template(@Req() request: FastifyRequest, @Param("kind") slug: string, @Query("help") help?: string) {
    const kind = this.csvKind(request, slug);
    return help ? csvFile(helpCsv(kind), `${slug}-column-help.csv`) : csvFile(templateCsv(kind), `${slug}-template.csv`);
  }
  @Get(":kind/help") @Roles(...IMPORT_ROLES)
  help(@Req() request: FastifyRequest, @Param("kind") slug: string) {
    const kind = kindFromSlug(slug);
    if (!canRun(request.identity!, kind)) throw new ForbiddenException("Your role cannot run this import.");
    return kind === "PAYSLIPS" ? { kind, ...KIND_LABELS[kind], columns: [], notes: PAYSLIP_HELP } : { kind, ...KIND_LABELS[kind], columns: COLUMNS[kind], notes: [] };
  }
  @Post(":kind/dry-run") @Roles(...IMPORT_ROLES) @ApiOperation({ summary: "Validate a CSV; nothing is stored" })
  dryRun(@Req() request: FastifyRequest, @Param("kind") slug: string, @Body() input: CommitDto) { return this.imports.dryRun(request.identity!, this.csvKind(request, slug), input); }
  @Post(":kind/commit") @Roles(...IMPORT_ROLES) @ApiOperation({ summary: "Re-validate and commit in one locked transaction (idempotent by batch key)" })
  commit(@Req() request: FastifyRequest, @Param("kind") slug: string, @Body() input: CommitDto) { return this.imports.commit(request.identity!, this.csvKind(request, slug), input); }

  private csvKind(request: FastifyRequest, slug: string) {
    const kind = kindFromSlug(slug);
    if (kind === "PAYSLIPS") throw new NotFoundException("Payslips are imported through /imports/payslips/dry-run and /commit.");
    if (!canRun(request.identity!, kind)) throw new ForbiddenException("Your role cannot run this import.");
    return kind as Exclude<ImportKind, "PAYSLIPS">;
  }
}

import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Req, StreamableFile } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { Roles } from "../auth/roles.decorator";
import { ImportCsvDto, UpdateEmployeeDto } from "./people-admin.dto";
import { PEOPLE_ADMIN_ROLES, PeopleAdminService, templateCsv } from "./people-admin.service";

/** HR administration of the employee register (replaces legacy /api/v1/employees PATCH + CSV import). */
@ApiTags("people") @ApiBearerAuth() @Controller("api/v2/employees")
export class PeopleAdminController {
  constructor(private readonly admin: PeopleAdminService) {}

  @Get("import/template") @Roles(...PEOPLE_ADMIN_ROLES) @Header("cache-control", "no-store")
  @ApiOperation({ summary: "CSV template for the guided employee import" })
  template() {
    const bytes = Buffer.from(templateCsv(), "utf8");
    return new StreamableFile(bytes, { type: "text/csv; charset=utf-8", disposition: `attachment; filename="employee-import-template.csv"`, length: bytes.length });
  }

  @Post("import/dry-run") @Roles(...PEOPLE_ADMIN_ROLES) @ApiOperation({ summary: "Validate a CSV; nothing is stored" })
  dryRun(@Req() request: FastifyRequest, @Body() input: ImportCsvDto) { return this.admin.dryRun(request.identity!, input); }

  @Post("import/commit") @Roles(...PEOPLE_ADMIN_ROLES) @ApiOperation({ summary: "Re-validate and commit the same CSV in one transaction" })
  commit(@Req() request: FastifyRequest, @Body() input: ImportCsvDto) { return this.admin.commit(request.identity!, input); }

  @Patch(":id") @Roles(...PEOPLE_ADMIN_ROLES) @ApiOperation({ summary: "Update one employee record (requires the current version)" })
  update(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: UpdateEmployeeDto) {
    return this.admin.update(request.identity!, id, input);
  }
}

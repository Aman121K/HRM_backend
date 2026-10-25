import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { RequirePermissions } from "../auth/roles.decorator";
import { AssignRoleDto, AuditQuery, BaseRoleDto, CreateRoleDto, ExportQuery, PeopleQuery, RevokeAssignmentDto, RoleStatusDto, UpdateRoleDto } from "./access.dto";
import { AccessService } from "./access.service";

const MANAGE = "settings.access";
const AUDIT = "audit.view";

@ApiTags("access") @ApiBearerAuth() @Controller("api/v2/access")
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get("me") @ApiOperation({ summary: "The caller's effective permissions, scopes and custom roles" })
  me(@Req() request: FastifyRequest) { return this.access.me(request.identity!); }

  @Get("organization") @ApiOperation({ summary: "Read-only organization profile for the settings hub" })
  organization(@Req() request: FastifyRequest) { return this.access.organization(request.identity!); }

  @Get("catalogue") @RequirePermissions(MANAGE, AUDIT) @ApiOperation({ summary: "Permission catalogue, scopes and separation-of-duties rules" })
  catalogue() { return this.access.catalogue(); }

  // Roles
  @Get("roles") @RequirePermissions(MANAGE, AUDIT)
  roles(@Req() request: FastifyRequest) { return this.access.listRoles(request.identity!); }

  @Post("roles") @RequirePermissions(MANAGE)
  createRole(@Req() request: FastifyRequest, @Body() input: CreateRoleDto) { return this.access.createRole(request.identity!, input); }

  @Get("roles/:id") @RequirePermissions(MANAGE, AUDIT)
  role(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.access.getRole(request.identity!, id); }

  @Patch("roles/:id") @RequirePermissions(MANAGE) @ApiOperation({ summary: "Edit a custom role (optimistic concurrency on version)" })
  updateRole(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: UpdateRoleDto) { return this.access.updateRole(request.identity!, id, input); }

  @Post("roles/:id/status") @RequirePermissions(MANAGE) @ApiOperation({ summary: "Archive or restore a custom role" })
  roleStatus(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: RoleStatusDto) { return this.access.setRoleStatus(request.identity!, id, input); }

  // People & assignments
  @Get("people") @RequirePermissions(MANAGE, AUDIT)
  people(@Req() request: FastifyRequest, @Query() query: PeopleQuery) { return this.access.people(request.identity!, query); }

  @Get("people/:employeeId") @RequirePermissions(MANAGE, AUDIT) @ApiOperation({ summary: "What can this person do — effective permissions with their source role" })
  person(@Req() request: FastifyRequest, @Param("employeeId", ParseUUIDPipe) employeeId: string) { return this.access.person(request.identity!, employeeId); }

  @Patch("people/:employeeId/base-role") @RequirePermissions(MANAGE)
  baseRole(@Req() request: FastifyRequest, @Param("employeeId", ParseUUIDPipe) employeeId: string, @Body() input: BaseRoleDto) { return this.access.changeBaseRole(request.identity!, employeeId, input); }

  @Post("assignments") @RequirePermissions(MANAGE) @ApiOperation({ summary: "Assign a custom role (optionally temporary / restricted); dryRun previews the impact" })
  assign(@Req() request: FastifyRequest, @Body() input: AssignRoleDto) { return this.access.assign(request.identity!, input); }

  @Post("assignments/:id/revoke") @RequirePermissions(MANAGE)
  revoke(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: RevokeAssignmentDto) { return this.access.revoke(request.identity!, id, input.reason); }

  // Access review
  @Get("review/permissions/:key") @RequirePermissions(MANAGE, AUDIT) @ApiOperation({ summary: "Who can do X — everyone holding a permission, with scope and source" })
  whoCan(@Req() request: FastifyRequest, @Param("key") key: string) { return this.access.whoCan(request.identity!, key); }

  @Get("review/export.csv") @RequirePermissions(MANAGE, AUDIT)
  @Header("content-type", "text/csv; charset=utf-8") @Header("content-disposition", 'attachment; filename="access-review.csv"') @Header("cache-control", "private, no-store")
  exportReview(@Req() request: FastifyRequest, @Query() query: ExportQuery) { return this.access.exportCsv(request.identity!, query.permission); }

  // Audit log
  @Get("audit") @RequirePermissions(AUDIT) @ApiOperation({ summary: "Audit log, filtered and paginated" })
  audit(@Req() request: FastifyRequest, @Query() query: AuditQuery) { return this.access.auditLog(request.identity!, query); }

  @Get("audit/facets") @RequirePermissions(AUDIT)
  auditFacets(@Req() request: FastifyRequest) { return this.access.auditFacets(request.identity!); }

  @Get("audit/export.csv") @RequirePermissions(AUDIT)
  @Header("content-type", "text/csv; charset=utf-8") @Header("content-disposition", 'attachment; filename="audit-log.csv"') @Header("cache-control", "private, no-store")
  auditCsv(@Req() request: FastifyRequest, @Query() query: AuditQuery) { return this.access.auditCsv(request.identity!, query); }

  @Get("audit/:id") @RequirePermissions(AUDIT)
  auditEntry(@Req() request: FastifyRequest, @Param("id") id: string) { return this.access.auditEntry(request.identity!, id); }
}

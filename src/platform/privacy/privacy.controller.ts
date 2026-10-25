import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, StreamableFile } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { BreachService } from "./breach.service";
import { BrandExitService } from "./brand-exit.service";
import { ErasureService } from "./erasure.service";
import { BrandExportDto, ConfirmClosureDto, CreateBreachDto, ExecuteRetentionDto, LegalHoldDto, RequestClosureDto, RequestErasureDto, UpdateBreachDto, UpdatePrivacySettingsDto } from "./privacy.dto";
import { PrivacyService } from "./privacy.service";

/** Brand scope: employees (my data), HR/owner (settings, retention, erasure), owner (breach register). */
@ApiTags("privacy") @ApiBearerAuth() @Controller("api/v2/privacy")
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService, private readonly erasure: ErasureService, private readonly breaches: BreachService) {}

  @Get("me") @ApiOperation({ summary: "My data & privacy: grievance officer, notice, exports, requests, retention schedule" })
  me(@Req() request: FastifyRequest) { return this.privacy.overview(request.identity!); }
  @Post("me/exports") @ApiOperation({ summary: "Request a “Download my data” export (async; notified when ready)" })
  requestExport(@Req() request: FastifyRequest) { return this.privacy.requestExport(request.identity!); }
  @Get("me/exports/:id") exportStatus(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.privacy.exportStatus(request.identity!, id); }

  @Get("settings") settings(@Req() request: FastifyRequest) { return this.privacy.settings(request.identity!); }
  @Put("settings") updateSettings(@Req() request: FastifyRequest, @Body() body: UpdatePrivacySettingsDto) { return this.privacy.updateSettings(request.identity!, body); }

  @Get("retention/runs") runs(@Req() request: FastifyRequest) { return this.erasure.runs(request.identity!); }
  @Get("retention/runs/:id") run(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.erasure.run(request.identity!, id); }
  @Post("retention/dry-run") @ApiOperation({ summary: "Preview what retention would erase now (changes nothing)" })
  dryRun(@Req() request: FastifyRequest) { return this.erasure.dryRun(request.identity!); }
  @Post("retention/execute") @ApiOperation({ summary: "Erase what a reviewed dry-run listed" })
  execute(@Req() request: FastifyRequest, @Body() body: ExecuteRetentionDto) { return this.erasure.executeDryRun(request.identity!, body.dryRunId); }
  @Put("subjects/:employeeId/legal-hold") hold(@Req() request: FastifyRequest, @Param("employeeId", ParseUUIDPipe) employeeId: string, @Body() body: LegalHoldDto) {
    return this.erasure.setLegalHold(request.identity!, employeeId, body.hold, body.reason);
  }
  @Get("requests/erasure") erasureRequests(@Req() request: FastifyRequest) { return this.erasure.erasureRequests(request.identity!); }
  @Post("requests/:caseId/erase") erase(@Req() request: FastifyRequest, @Param("caseId", ParseUUIDPipe) caseId: string, @Body() body: RequestErasureDto) {
    return this.erasure.eraseForRequest(request.identity!, caseId, body.mode);
  }

  @Get("breaches") breachList(@Req() request: FastifyRequest) { return this.breaches.list(request.identity!, false); }
  @Post("breaches") breachCreate(@Req() request: FastifyRequest, @Body() body: CreateBreachDto) { return this.breaches.create(request.identity!, false, body); }
  @Get("breaches/:id") breachGet(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.breaches.get(request.identity!, false, id); }
  @Patch("breaches/:id") breachUpdate(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() body: UpdateBreachDto) {
    return this.breaches.update(request.identity!, false, id, body);
  }
  @Get("breaches/:id/notice") breachNotice(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.breaches.notice(request.identity!, false, id); }
}

/** Platform scope (super admins): breach register across brands, brand export, brand closure. */
@ApiTags("privacy") @ApiBearerAuth() @Controller("api/v2/platform/privacy")
export class PlatformPrivacyController {
  constructor(private readonly breaches: BreachService, private readonly exit: BrandExitService) {}

  @Get("breaches") list(@Req() request: FastifyRequest) { return this.breaches.list(request.identity!, true); }
  @Post("breaches") create(@Req() request: FastifyRequest, @Body() body: CreateBreachDto) { return this.breaches.create(request.identity!, true, body); }
  @Get("breaches/:id") get(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.breaches.get(request.identity!, true, id); }
  @Patch("breaches/:id") update(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() body: UpdateBreachDto) {
    return this.breaches.update(request.identity!, true, id, body);
  }
  @Get("breaches/:id/notice") notice(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.breaches.notice(request.identity!, true, id); }

  @Get("brands") brands(@Req() request: FastifyRequest) { return this.exit.brands(request.identity!); }
  @Post("exports") startExport(@Req() request: FastifyRequest, @Body() body: BrandExportDto) { return this.exit.startExport(request.identity!, body); }
  @Get("exports/:id") exportFiles(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.exit.exportFiles(request.identity!, id); }
  @Get("exports/:id/file") @Header("x-content-type-options", "nosniff") @Header("cache-control", "private, no-store")
  async file(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Query("name") name: string) {
    const file = await this.exit.download(request.identity!, id, String(name || ""));
    return new StreamableFile(file.bytes, { type: file.mimeType, disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, length: file.bytes.length });
  }
  @Post("closures") requestClosure(@Req() request: FastifyRequest, @Body() body: RequestClosureDto) { return this.exit.requestClosure(request.identity!, body); }
  @Post("closures/:id/confirm") confirm(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() body: ConfirmClosureDto) {
    return this.exit.confirmClosure(request.identity!, id, body.confirmSlug);
  }
  @Post("closures/:id/cancel") cancel(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.exit.cancelClosure(request.identity!, id); }
}

import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query, Req, StreamableFile } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { AddEvidenceDto, DecideItemDto, PublishPolicyDto, StartReviewDto, UpdateControlDto } from "./compliance.dto";
import { ComplianceService } from "./compliance.service";

/** ISO 27001 / SOC 2 Compliance Center (platform admins) and policy acceptance (everyone). */
@ApiTags("compliance") @ApiBearerAuth() @Controller("api/v2")
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get("platform/compliance/overview") overview(@Req() request: FastifyRequest, @Query("framework") framework = "iso27001") { return this.compliance.overview(request.identity!, framework); }
  @Post("platform/compliance/collect") collect(@Req() request: FastifyRequest) { return this.compliance.collectNow(request.identity!); }
  @Get("platform/compliance/audit-chain") chain(@Req() request: FastifyRequest) { return this.compliance.auditChain(request.identity!); }
  @Get("platform/compliance/controls/:framework/:id") control(@Req() request: FastifyRequest, @Param("framework") framework: string, @Param("id") id: string) {
    return this.compliance.controlDetail(request.identity!, framework, id);
  }
  @Patch("platform/compliance/controls/:framework/:id") updateControl(@Req() request: FastifyRequest, @Param("framework") framework: string, @Param("id") id: string, @Body() body: UpdateControlDto) {
    return this.compliance.updateControl(request.identity!, framework, id, body);
  }
  @Post("platform/compliance/controls/:framework/:id/evidence") addEvidence(@Req() request: FastifyRequest, @Param("framework") framework: string, @Param("id") id: string, @Body() body: AddEvidenceDto) {
    return this.compliance.addEvidence(request.identity!, framework, id, body);
  }

  @Get("platform/compliance/access-reviews") reviews(@Req() request: FastifyRequest) { return this.compliance.reviews(request.identity!); }
  @Post("platform/compliance/access-reviews") startReview(@Req() request: FastifyRequest, @Body() body: StartReviewDto) { return this.compliance.startReview(request.identity!, body); }
  @Get("platform/compliance/access-reviews/:id") review(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.compliance.review(request.identity!, id); }
  @Post("platform/compliance/access-reviews/:id/close") close(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.compliance.closeReview(request.identity!, id); }
  @Post("platform/compliance/access-review-items/:id/decision") decide(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() body: DecideItemDto) {
    return this.compliance.decide(request.identity!, id, body.decision, body.note);
  }

  @Get("platform/compliance/policies") policies(@Req() request: FastifyRequest) { return this.compliance.policies(request.identity!); }
  @Post("platform/compliance/policies") publish(@Req() request: FastifyRequest, @Body() body: PublishPolicyDto) { return this.compliance.publishPolicy(request.identity!, body); }
  @Get("compliance/policies/pending") pending(@Req() request: FastifyRequest) { return this.compliance.pending(request.identity!); }
  @Post("compliance/policies/:id/acknowledge") acknowledge(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.compliance.acknowledge(request.identity!, id, request.ip);
  }

  @Get("platform/compliance/export") @Header("cache-control", "private, no-store") @Header("x-content-type-options", "nosniff")
  async export(@Req() request: FastifyRequest, @Query("framework") framework = "iso27001") {
    const file = await this.compliance.exportPack(request.identity!, framework);
    const bytes = Buffer.from(file.body, "utf8");
    return new StreamableFile(bytes, { type: "application/json; charset=utf-8", disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, length: bytes.length });
  }
}

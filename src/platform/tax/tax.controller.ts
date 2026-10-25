import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Patch, Post, Req, StreamableFile } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { Roles } from "../auth/roles.decorator";
import { CalculateTaxDto, ReviewDeclarationDto, SaveDeclarationDto, SubmitDeclarationDto, UpdateDeclarationDto, UploadProofDto, WithdrawDeclarationDto } from "./tax.dto";
import { TAX_REVIEW_ROLES, TaxService } from "./tax.service";

/**
 * Employee income-tax declarations (FY regime choice, investments, proofs) and the payroll reviewer flow.
 * Lives under /api/v2/payroll so the organization's payroll module switch gates it.
 */
@ApiTags("tax") @ApiBearerAuth() @Controller("api/v2/payroll/tax")
export class TaxController {
  constructor(private readonly tax: TaxService) {}

  @Get("rules") @ApiOperation({ summary: "Versioned tax rule set used for estimates" })
  rules() { return this.tax.ruleSet(); }

  @Post("calculate") @ApiOperation({ summary: "Stateless tax estimate for one regime (nothing is stored)" })
  calculate(@Body() input: CalculateTaxDto) { return this.tax.calculate(input); }

  @Get("declarations") @ApiOperation({ summary: "My declarations, newest first" })
  mine(@Req() request: FastifyRequest) { return this.tax.listMine(request.identity!); }

  @Get("declarations/review-queue") @Roles(...TAX_REVIEW_ROLES) @ApiOperation({ summary: "Submitted declarations awaiting a payroll decision (excludes the reviewer's own)" })
  queue(@Req() request: FastifyRequest) { return this.tax.reviewQueue(request.identity!); }

  @Post("declarations") create(@Req() request: FastifyRequest, @Body() input: SaveDeclarationDto) { return this.tax.create(request.identity!, input); }

  @Get("declarations/:id") get(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.tax.get(request.identity!, id); }

  @Patch("declarations/:id") update(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: UpdateDeclarationDto) {
    return this.tax.update(request.identity!, id, input);
  }

  @Post("declarations/:id/submit") submit(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: SubmitDeclarationDto) {
    return this.tax.submit(request.identity!, id, input);
  }

  @Post("declarations/:id/withdraw") withdraw(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: WithdrawDeclarationDto) {
    return this.tax.withdraw(request.identity!, id, input);
  }

  @Get("declarations/:id/history") history(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.tax.history(request.identity!, id); }

  @Post("declarations/:id/review") @Roles(...TAX_REVIEW_ROLES) @ApiOperation({ summary: "ACCEPT | REJECT | REQUEST_CLARIFICATION (never your own declaration)" })
  review(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: ReviewDeclarationDto) {
    return this.tax.review(request.identity!, id, input);
  }

  @Get("declarations/:id/proofs") proofs(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.tax.listProofs(request.identity!, id); }

  @Post("declarations/:id/proofs") upload(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: UploadProofDto) {
    return this.tax.uploadProof(request.identity!, id, input);
  }

  @Get("declarations/:id/proofs/:fileId/content") @Header("x-content-type-options", "nosniff") @Header("cache-control", "private, no-store")
  async content(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Param("fileId", ParseUUIDPipe) fileId: string) {
    const file = await this.tax.downloadProof(request.identity!, id, fileId);
    return new StreamableFile(file.bytes, { type: file.mimeType, disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, length: file.bytes.length });
  }

  @Delete("declarations/:id/proofs/:fileId") remove(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Param("fileId", ParseUUIDPipe) fileId: string) {
    return this.tax.removeProof(request.identity!, id, fileId);
  }
}

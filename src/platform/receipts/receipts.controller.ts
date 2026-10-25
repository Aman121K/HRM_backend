import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { AttachReceiptDto, ScanReceiptDto } from "./receipts.dto";
import { ReceiptsService } from "./receipts.service";

@ApiTags("receipts") @ApiBearerAuth() @Controller("api/v2/receipts")
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Post("scan") @HttpCode(200) @ApiOperation({ summary: "Store a receipt photo/PDF and extract merchant, date, total, GST and category" })
  scan(@Req() request: FastifyRequest, @Body() input: ScanReceiptDto) { return this.receipts.scan(request.identity!, input); }

  @Get(":scanId") get(@Req() request: FastifyRequest, @Param("scanId", ParseUUIDPipe) scanId: string) { return this.receipts.get(request.identity!, scanId); }

  @Post(":scanId/attach") @HttpCode(200) @ApiOperation({ summary: "Move the scanned file onto the caller's open expense claim and record OCR values/flags" })
  attach(@Req() request: FastifyRequest, @Param("scanId", ParseUUIDPipe) scanId: string, @Body() input: AttachReceiptDto) {
    return this.receipts.attach(request.identity!, scanId, input);
  }
}

import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, StreamableFile } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { Public } from "../auth/public.decorator";
import { Roles } from "../auth/roles.decorator";
import { AccountingService } from "./accounting.service";
import {
  AccountingPreviewQuery, BankResponseDto, CreateBatchDto, CreateExportDto, CreateSubscriptionDto, DeliveriesQuery, LedgerSettingsDto, UpdateSubscriptionDto, VersionDto,
} from "./integrations.dto";
import { IntegrationsService } from "./integrations.service";
import { PayoutsService } from "./payouts.service";
import { ALL_INTEGRATION_ROLES, FINANCE_ROLES, INTEGRATION_ADMIN_ROLES } from "./shared";
import { WebhooksService } from "./webhooks.service";

const download = (file: { name: string; type: string; content: string; checksum: string }) => {
  const bytes = Buffer.from(file.content, "utf8");
  return new StreamableFile(bytes, { type: `${file.type}; charset=utf-8`, disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, length: bytes.length });
};

@ApiTags("integrations") @ApiBearerAuth() @Controller("api/v2/integrations")
export class IntegrationsController {
  constructor(private readonly overview: IntegrationsService) {}

  @Get("overview") @Roles(...ALL_INTEGRATION_ROLES) @ApiOperation({ summary: "Status cards for every integration the viewer may manage" })
  get(@Req() request: FastifyRequest) { return this.overview.overview(request.identity!); }
}

@ApiTags("integrations") @ApiBearerAuth() @Controller("api/v2/integrations/accounting") @Roles(...FINANCE_ROLES)
export class AccountingController {
  constructor(private readonly accounting: AccountingService) {}

  @Get("settings") settings(@Req() request: FastifyRequest) { return this.accounting.settings(request.identity!); }
  @Put("settings") save(@Req() request: FastifyRequest, @Body() input: LedgerSettingsDto) { return this.accounting.saveSettings(request.identity!, input); }
  @Get("runs") runs(@Req() request: FastifyRequest) { return this.accounting.runs(request.identity!); }
  @Get("preview") @ApiOperation({ summary: "Voucher lines, totals and reconciliation checks for a run (payroll journal) or month (paid expenses)" })
  preview(@Req() request: FastifyRequest, @Query() query: AccountingPreviewQuery) { return this.accounting.preview(request.identity!, query); }
  @Post("exports") @ApiOperation({ summary: "Create a Tally XML or CSV export (refused unless balanced and reconciled)" })
  create(@Req() request: FastifyRequest, @Body() input: CreateExportDto) { return this.accounting.createExport(request.identity!, input); }
  @Get("exports") exports(@Req() request: FastifyRequest) { return this.accounting.exports(request.identity!); }
  @Get("exports/:id/download") @Header("cache-control", "private, no-store") @Header("x-content-type-options", "nosniff")
  async download(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return download(await this.accounting.download(request.identity!, id)); }
}

@ApiTags("integrations") @ApiBearerAuth() @Controller("api/v2/integrations/payouts")
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get("config") @Roles(...FINANCE_ROLES) config() { return this.payouts.config_(); }
  @Get("runs") @Roles(...FINANCE_ROLES) runs(@Req() request: FastifyRequest) { return this.payouts.runs(request.identity!); }
  @Get("batches") @Roles(...FINANCE_ROLES) list(@Req() request: FastifyRequest) { return this.payouts.list(request.identity!); }
  @Post("batches") @Roles(...FINANCE_ROLES) @ApiOperation({ summary: "Create a draft payout batch from an approved payroll run" })
  create(@Req() request: FastifyRequest, @Body() input: CreateBatchDto) { return this.payouts.createBatch(request.identity!, input); }
  @Get("batches/:id") @Roles(...FINANCE_ROLES) get(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.payouts.get(request.identity!, id); }
  @Post("batches/:id/release") @Roles(...FINANCE_ROLES) @HttpCode(200) @ApiOperation({ summary: "Maker-checker release (must be a different administrator than the creator)" })
  release(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: VersionDto) { return this.payouts.release(request.identity!, id, input.version); }
  @Post("batches/:id/cancel") @Roles(...FINANCE_ROLES) @HttpCode(200)
  cancel(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: VersionDto) { return this.payouts.cancel(request.identity!, id, input.version); }
  @Post("batches/:id/sync") @Roles(...FINANCE_ROLES) @HttpCode(200)
  sync(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.payouts.syncNow(request.identity!, id); }
  @Post("batches/:id/bank-response") @Roles(...FINANCE_ROLES) @HttpCode(200)
  bankResponse(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: BankResponseDto) { return this.payouts.bankResponse(request.identity!, id, input); }
  @Get("batches/:id/file") @Roles(...FINANCE_ROLES) @Header("cache-control", "private, no-store") @Header("x-content-type-options", "nosniff")
  async file(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return download(await this.payouts.file(request.identity!, id)); }

  @Public() @Post("webhook") @HttpCode(200) @ApiOperation({ summary: "Inbound payout status webhook (X-Razorpay-Signature HMAC over a signed timestamp; replays are ignored)" })
  webhook(@Req() request: FastifyRequest, @Headers("x-razorpay-signature") signature: string, @Headers("x-payout-timestamp") timestamp: string, @Headers("x-razorpay-event-id") eventId: string) {
    return this.payouts.inboundWebhook({ signature: signature || "", timestamp: timestamp || undefined, eventId: eventId || undefined }, request.integrationRawBody, request.body);
  }
}

@ApiTags("integrations") @ApiBearerAuth() @Controller("api/v2/integrations/webhooks") @Roles(...INTEGRATION_ADMIN_ROLES)
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get("event-types") eventTypes() { return this.webhooks.eventTypes(); }
  @Get("subscriptions") list(@Req() request: FastifyRequest) { return this.webhooks.list(request.identity!); }
  @Post("subscriptions") @ApiOperation({ summary: "Create a subscription; returns its signing secret once" })
  create(@Req() request: FastifyRequest, @Body() input: CreateSubscriptionDto) { return this.webhooks.create(request.identity!, input); }
  @Patch("subscriptions/:id") update(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: UpdateSubscriptionDto) { return this.webhooks.update(request.identity!, id, input); }
  @Post("subscriptions/:id/rotate") @HttpCode(200)
  rotate(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: VersionDto) { return this.webhooks.rotate(request.identity!, id, input.version); }
  @Post("subscriptions/:id/test") @HttpCode(200) @ApiOperation({ summary: "Send a signed test event now" })
  test(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.webhooks.test(request.identity!, id); }
  @Get("subscriptions/:id/deliveries")
  deliveries(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Query() query: DeliveriesQuery) { return this.webhooks.deliveries(request.identity!, id, query); }
  @Post("deliveries/:id/redeliver") @HttpCode(200)
  redeliver(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.webhooks.redeliver(request.identity!, id); }
}

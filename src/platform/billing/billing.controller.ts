import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, StreamableFile } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import {
  AccountDto, AdjustmentDto, AssignPlanDto, CreditNoteDto, GenerateDto, InvoiceQuery, IssueDto, PaymentDto, PlanDto, ReceivablesRunDto, ReverseDto, SnapshotDto,
  UpdateSettingsDto, UsageQuery,
} from "./billing.dto";
import { BillingService } from "./billing.service";

const pdf = (file: { name: string; body: Buffer }) =>
  new StreamableFile(file.body, { type: "application/pdf", disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, length: file.body.length });

/**
 * SaaS billing. /api/v2/platform/billing/* is super-admin only (checked in the service against platform_admins).
 * /api/v2/orgs/billing/* is the brand OWNER's read-only view; it lives under /orgs so a brand suspended for non-payment
 * can still see and pay its invoices (ModuleGuard lets /api/v2/orgs through for suspended brands).
 */
@ApiTags("billing") @ApiBearerAuth() @Controller("api/v2")
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get("platform/billing/settings") settings(@Req() r: FastifyRequest) { return this.billing.getSettings(r.identity!); }
  @Put("platform/billing/settings") saveSettings(@Req() r: FastifyRequest, @Body() body: UpdateSettingsDto) { return this.billing.updateSettings(r.identity!, body); }

  @Get("platform/billing/plans") plans(@Req() r: FastifyRequest) { return this.billing.plans(r.identity!); }
  @Post("platform/billing/plans") createPlan(@Req() r: FastifyRequest, @Body() body: PlanDto) { return this.billing.createPlan(r.identity!, body); }
  @Patch("platform/billing/plans/:id") updatePlan(@Req() r: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() body: PlanDto) { return this.billing.updatePlan(r.identity!, id, body); }

  @Get("platform/billing/accounts") accounts(@Req() r: FastifyRequest) { return this.billing.accounts(r.identity!); }
  @Post("platform/billing/accounts") createAccount(@Req() r: FastifyRequest, @Body() body: AccountDto) { return this.billing.saveAccount(r.identity!, null, body); }
  @Patch("platform/billing/accounts/:id") updateAccount(@Req() r: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() body: AccountDto) {
    return this.billing.saveAccount(r.identity!, id, body);
  }
  @Post("platform/billing/accounts/:id/subscriptions") assign(@Req() r: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() body: AssignPlanDto) {
    return this.billing.assignPlan(r.identity!, id, body);
  }
  @Get("platform/billing/accounts/:id/adjustments") adjustments(@Req() r: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.billing.adjustments(r.identity!, id); }
  @Post("platform/billing/accounts/:id/adjustments") addAdjustment(@Req() r: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() body: AdjustmentDto) {
    return this.billing.addAdjustment(r.identity!, id, body);
  }
  @Post("platform/billing/accounts/:id/reactivate") reactivate(@Req() r: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.billing.reactivate(r.identity!, id); }

  @Get("platform/billing/usage") usage(@Req() r: FastifyRequest, @Query() query: UsageQuery) { return this.billing.usage(r.identity!, query.month); }
  @Post("platform/billing/usage/snapshot") snapshot(@Req() r: FastifyRequest, @Body() body: SnapshotDto) { return this.billing.snapshotUsage(r.identity!, body); }

  @Get("platform/billing/invoices") invoices(@Req() r: FastifyRequest, @Query() query: InvoiceQuery) { return this.billing.invoices(r.identity!, query); }
  @Post("platform/billing/invoices/generate") generate(@Req() r: FastifyRequest, @Body() body: GenerateDto) { return this.billing.generateInvoices(r.identity!, body); }
  @Get("platform/billing/invoices/:id") invoice(@Req() r: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.billing.invoice(r.identity!, id); }
  @Delete("platform/billing/invoices/:id") deleteDraft(@Req() r: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.billing.deleteDraft(r.identity!, id); }
  @Post("platform/billing/invoices/:id/issue") issue(@Req() r: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() body: IssueDto) {
    return this.billing.issue(r.identity!, id, body?.issueDate);
  }
  @Post("platform/billing/invoices/:id/credit-notes") creditNote(@Req() r: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() body: CreditNoteDto) {
    return this.billing.creditNote(r.identity!, id, body);
  }
  @Post("platform/billing/invoices/:id/payments") payment(@Req() r: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() body: PaymentDto) {
    return this.billing.recordPayment(r.identity!, id, body);
  }
  @Post("platform/billing/payments/:id/reverse") reverse(@Req() r: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() body: ReverseDto) {
    return this.billing.reversePayment(r.identity!, id, body.reason);
  }
  @Get("platform/billing/invoices/:id/pdf") @Header("cache-control", "private, no-store") @Header("x-content-type-options", "nosniff")
  async invoicePdf(@Req() r: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return pdf(await this.billing.invoicePdf(r.identity!, id)); }
  @Get("platform/billing/credit-notes/:id/pdf") @Header("cache-control", "private, no-store") @Header("x-content-type-options", "nosniff")
  async creditPdf(@Req() r: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return pdf(await this.billing.creditNotePdf(r.identity!, id)); }

  @Get("platform/billing/aging") aging(@Req() r: FastifyRequest) { return this.billing.aging(r.identity!); }
  @Post("platform/billing/receivables/run") receivables(@Req() r: FastifyRequest, @Body() body: ReceivablesRunDto) { return this.billing.runReceivables(r.identity!, body); }

  // ---- brand owner (read-only) ----
  @Get("orgs/billing/summary") @Header("cache-control", "private, no-store") ownerSummary(@Req() r: FastifyRequest) { return this.billing.ownerSummary(r.identity!); }
  @Get("orgs/billing/invoices/:id/pdf") @Header("cache-control", "private, no-store") @Header("x-content-type-options", "nosniff")
  async ownerInvoicePdf(@Req() r: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return pdf(await this.billing.ownerInvoicePdf(r.identity!, id)); }
  @Get("orgs/billing/credit-notes/:id/pdf") @Header("cache-control", "private, no-store") @Header("x-content-type-options", "nosniff")
  async ownerCreditPdf(@Req() r: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return pdf(await this.billing.ownerCreditNotePdf(r.identity!, id)); }
}

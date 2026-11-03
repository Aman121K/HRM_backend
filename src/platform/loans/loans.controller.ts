import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { Roles } from "../auth/roles.decorator";
import { PAYROLL_ROLES } from "../payroll/payroll.shared";
import { CancelLoanDto, DecideLoanDto, DisburseLoanDto, ForecloseDto, LoanListQuery, RequestLoanDto, SkipInstallmentDto } from "./loans.dto";
import { LoansService } from "./loans.service";

/** Employee loans and salary advances, recovered as EMIs through payroll. */
@ApiTags("loans") @ApiBearerAuth() @Controller("api/v2/loans")
export class LoansController {
  constructor(private readonly loans: LoansService) {}

  @Get("context") @ApiOperation({ summary: "Policy, the viewer's limits and outstanding balance" })
  context(@Req() request: FastifyRequest) { return this.loans.context(request.identity!); }

  @Get() @ApiOperation({ summary: "My loans (scope=mine) or every loan with a queue summary (scope=all, payroll admins)" })
  list(@Req() request: FastifyRequest, @Query() query: LoanListQuery) { return this.loans.list(request.identity!, query); }

  @Get(":id") @ApiOperation({ summary: "Loan with its EMI schedule (and audit history for admins)" })
  get(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.loans.get(request.identity!, id); }

  @Post() @ApiOperation({ summary: "Request a loan or salary advance (admins may raise one for an employee)" })
  request(@Req() request: FastifyRequest, @Body() input: RequestLoanDto) { return this.loans.request(request.identity!, input); }

  @Post(":id/decision") @Roles(...PAYROLL_ROLES) @ApiOperation({ summary: "approve | reject (maker-checker: never your own)" })
  decide(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: DecideLoanDto) { return this.loans.decide(request.identity!, id, input); }

  @Post(":id/disburse") @Roles(...PAYROLL_ROLES) @ApiOperation({ summary: "Record the payout and create the EMI schedule" })
  disburse(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: DisburseLoanDto) { return this.loans.disburse(request.identity!, id, input); }

  @Post(":id/skip") @Roles(...PAYROLL_ROLES) @ApiOperation({ summary: "Skip one month's EMI and extend the schedule" })
  skip(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: SkipInstallmentDto) { return this.loans.skip(request.identity!, id, input); }

  @Post(":id/foreclose") @Roles(...PAYROLL_ROLES) @ApiOperation({ summary: "Close the loan after the balance is repaid outside payroll" })
  foreclose(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: ForecloseDto) { return this.loans.foreclose(request.identity!, id, input); }

  @Post(":id/cancel") @ApiOperation({ summary: "Withdraw a pending request (or, for admins, cancel before disbursement)" })
  cancel(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: CancelLoanDto) { return this.loans.cancel(request.identity!, id, input); }
}

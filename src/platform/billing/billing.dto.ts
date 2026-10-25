import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from "class-validator";
import { MODULE_KEYS } from "../organizations/organizations.dto";
import { GST_STATES } from "./billing.engine";

const STATE_KEYS = Object.keys(GST_STATES);
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Rupee amounts arrive as numbers with at most 2 decimals and are converted to paise in the service. */
const Rupees = () => IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false });

export class UpdateSettingsDto {
  @IsOptional() @IsString() @MaxLength(160) legalName?: string;
  @IsOptional() @IsString() @MaxLength(120) tradeName?: string;
  @IsOptional() @Matches(/^[0-9]{2}[A-Z0-9]{13}$/) gstin?: string;
  @IsOptional() @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/) pan?: string;
  @IsOptional() @IsString() @MaxLength(400) address?: string;
  @IsOptional() @IsIn(STATE_KEYS) stateCode?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @Matches(/^99\d{4}$/) sacCode?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(28) gstRate?: number;
  @IsOptional() @Matches(/^[A-Za-z0-9]{1,4}$/) invoicePrefix?: string;
  @IsOptional() @Matches(/^[A-Za-z0-9]{1,4}$/) creditNotePrefix?: string;
  @IsOptional() @IsInt() @Min(0) @Max(120) paymentTermsDays?: number;
  @IsOptional() @IsString() @MaxLength(400) bankDetails?: string;
  @IsOptional() @IsIn(["ACTIVE_WITH_LOGIN", "ALL_ACTIVE_EMPLOYEES"]) headcountRule?: string;
  @IsOptional() @IsBoolean() autoSuspendEnabled?: boolean;
  @IsOptional() @IsInt() @Min(7) @Max(365) autoSuspendAfterDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(60) suspendWarningDays?: number;
}

export class PlanDto {
  @IsOptional() @Matches(/^[a-z0-9-]{2,30}$/) code?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @Rupees() @Min(0) @Max(100000) pepm?: number;
  @IsOptional() @Rupees() @Min(0) @Max(10000000) minimumMonthly?: number;
  @IsOptional() @Rupees() @Min(0) @Max(10000000) setupFee?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsIn(MODULE_KEYS as unknown as string[], { each: true }) includedModules?: string[];
  @IsOptional() @IsIn(["MONTHLY", "ANNUAL"]) billingCycle?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(50) annualDiscountPct?: number;
  @IsOptional() @IsInt() @Min(0) @Max(90) trialDays?: number;
  @IsOptional() @IsIn(["PEAK", "AVERAGE"]) usageBasis?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() version?: number;
}

export class AccountDto {
  @IsOptional() @IsIn(["BRAND", "GROUP"]) kind?: string;
  @IsOptional() @IsUUID() organizationId?: string;
  @IsOptional() @IsUUID() groupId?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(160) legalName?: string;
  /** Empty string clears the GSTIN (unregistered recipient). */
  @IsOptional() @Matches(/^([0-9]{2}[A-Z0-9]{13})?$/) gstin?: string;
  @IsOptional() @IsString() @MinLength(5) @MaxLength(400) billingAddress?: string;
  @IsOptional() @IsIn(STATE_KEYS) stateCode?: string;
  @IsOptional() @IsString() @MaxLength(120) contactName?: string;
  @IsOptional() @IsEmail() contactEmail?: string;
  @IsOptional() @IsString() @MaxLength(30) contactPhone?: string;
  @IsOptional() @IsInt() @Min(0) @Max(120) paymentTermsDays?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsInt() version?: number;
}

export class AssignPlanDto {
  @IsUUID() planId!: string;
  @Matches(ISO_DATE) contractStart!: string;
  @IsOptional() @Matches(ISO_DATE) contractEnd?: string;
  @IsOptional() @Rupees() @Min(0) @Max(100000) pepmOverride?: number;
  @IsOptional() @Rupees() @Min(0) @Max(10000000) minimumOverride?: number;
  @IsOptional() @Rupees() @Min(0) @Max(10000000) setupFeeOverride?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) discountPct?: number;
  @IsOptional() @IsIn(["MONTHLY", "ANNUAL"]) billingCycle?: string;
  @IsOptional() @IsIn(["PEAK", "AVERAGE"]) usageBasis?: string;
  @IsOptional() @IsInt() @Min(0) @Max(90) trialDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000000) committedSeats?: number;
  /** Also switch the brand(s) to exactly the plan's modules. */
  @IsOptional() @IsBoolean() applyModules?: boolean;
}

export class AdjustmentDto {
  @IsIn(["CREDIT", "CHARGE"]) kind!: string;
  @IsString() @MinLength(3) @MaxLength(200) description!: string;
  @Rupees() @Min(0.01) @Max(10000000) amount!: number;
}

export class SnapshotDto {
  @IsOptional() @Matches(ISO_DATE) date?: string;
  @IsOptional() @Matches(ISO_DATE) from?: string;
  @IsOptional() @Matches(ISO_DATE) to?: string;
}

export class GenerateDto {
  @Matches(PERIOD) period!: string;
  @IsOptional() @IsUUID() accountId?: string;
  /** Demo invoices are numbered in a separate DM/ series, watermarked and excluded from reminders and suspension. */
  @IsOptional() @IsBoolean() demo?: boolean;
}

export class IssueDto {
  @IsOptional() @Matches(ISO_DATE) issueDate?: string;
}

export class CreditNoteDto {
  /** Taxable value to credit, in rupees (GST is added in the same split as the invoice). */
  @Rupees() @Min(0.01) @Max(100000000) amount!: number;
  @IsString() @MinLength(5) @MaxLength(300) reason!: string;
}

export class PaymentDto {
  @Rupees() @Min(0.01) @Max(100000000) amount!: number;
  @Matches(ISO_DATE) paidOn!: string;
  @IsIn(["NEFT", "RTGS", "IMPS", "UPI", "CHEQUE", "CARD", "CASH", "OTHER"]) mode!: string;
  @IsOptional() @IsString() @MaxLength(60) @Matches(/^[A-Za-z0-9 /_.-]*$/) reference?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class ReverseDto {
  @IsString() @MinLength(5) @MaxLength(300) reason!: string;
}

export class ReceivablesRunDto {
  @IsOptional() @Matches(ISO_DATE) today?: string;
  @IsOptional() @IsBoolean() includeDemo?: boolean;
  /** Limit the run to one billing account (required together with includeDemo, so a test can never touch other brands). */
  @IsOptional() @IsUUID() accountId?: string;
}

export class InvoiceQuery {
  @IsOptional() @IsIn(["DRAFT", "ISSUED"]) status?: string;
  @IsOptional() @Matches(PERIOD) period?: string;
  @IsOptional() @IsUUID() accountId?: string;
}

export class UsageQuery {
  @IsOptional() @Matches(PERIOD) month?: string;
}

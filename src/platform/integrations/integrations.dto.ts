import { Type } from "class-transformer";
import {
  ArrayMaxSize, ArrayMinSize, ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString, IsUUID,
  Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from "class-validator";

export const VENDORS = ["ZKTECO", "ESSL", "MANTRA", "GENERIC"] as const;
export const PAYOUT_ADAPTERS = ["H2H_GENERIC", "H2H_BANK_CSV", "API_RAZORPAYX"] as const;
export const EXPORT_KINDS = ["PAYROLL_JOURNAL", "EXPENSE_PAYMENTS"] as const;
export const EXPORT_FORMATS = ["TALLY_XML", "CSV"] as const;
export const WEBHOOK_EVENT_TYPES = [
  "employee.created", "employee.updated", "leave.requested", "leave.approved", "payroll.approved", "payroll.published",
  "attendance.punch", "case.created", "case.status_changed", "payout.batch_released", "payout.processed", "payout.failed",
] as const;
export const LEDGER_KEYS = [
  "salaryExpense", "employerContributionExpense", "reimbursementExpense", "pfPayable", "esiPayable", "ptPayable", "tdsPayable",
  "otherDeductions", "gratuityProvision", "salaryPayable", "bank",
] as const;

const SERIAL = /^[A-Za-z0-9._-]{4,40}$/;
const PIN = /^[A-Za-z0-9_-]{1,24}$/;
const PERIOD = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export class VersionDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}

// ------------------------------------------------------------------ devices
export class CreateDeviceDto {
  @IsString() @Matches(SERIAL, { message: "Serial number: 4–40 letters, digits, dot, dash or underscore." }) serialNumber!: string;
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsIn(VENDORS) vendor!: (typeof VENDORS)[number];
  @IsOptional() @IsUUID() siteId?: string;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
}

export class UpdateDeviceDto extends VersionDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsIn(VENDORS) vendor?: (typeof VENDORS)[number];
  @IsOptional() @IsString() @MaxLength(40) siteId?: string; // uuid, or "" to clear
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
  @IsOptional() @IsIn(["ACTIVE", "DISABLED"]) status?: "ACTIVE" | "DISABLED";
}

export class DevicePunchesQuery {
  @IsOptional() @IsIn(["RECORDED", "UNMATCHED", "IGNORED", "REJECTED"]) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

export class CreateMappingDto {
  @IsUUID() employeeId!: string;
  @IsString() @Matches(PIN, { message: "Device user ID: 1–24 letters, digits, dash or underscore." }) deviceUserId!: string;
  @IsOptional() @IsUUID() deviceId?: string;
}

export class ImportMappingsDto {
  @IsString() @MinLength(3) @MaxLength(500_000) csv!: string;
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

export class ResolveUnmatchedDto {
  @IsString() @Matches(PIN) deviceUserId!: string;
  @IsUUID() employeeId!: string;
  @IsOptional() @IsUUID() deviceId?: string;
}

export class IgnorePunchesDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(500) @IsUUID("all", { each: true }) punchIds!: string[];
}

/** One punch in the signed JSON ingestion API (validated after the signature is verified). */
export class DevicePunchItem {
  @IsString() @MinLength(1) @MaxLength(80) externalId!: string;
  @IsString() @Matches(PIN) deviceUserId!: string;
  @IsString() @MaxLength(40) occurredAt!: string;
  @IsOptional() @IsIn(["IN", "OUT"]) type?: "IN" | "OUT";
  @IsOptional() @IsString() @MaxLength(20) verifyMode?: string;
}
export class DevicePunchBatch {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => DevicePunchItem) punches!: DevicePunchItem[];
}
export class DeviceHeartbeat {
  @IsOptional() @IsString() @MaxLength(60) firmware?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) users?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) pendingPunches?: number;
}

// ------------------------------------------------------------------ accounting
export class LedgerSettingsDto {
  @IsString() @MinLength(2) @MaxLength(120) companyName!: string;
  @IsObject() ledgers!: Record<string, string>;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60) journalVoucherType?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60) paymentVoucherType?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) version?: number;
}

export class AccountingPreviewQuery {
  @IsIn(EXPORT_KINDS) kind!: (typeof EXPORT_KINDS)[number];
  @IsOptional() @IsUUID() runId?: string;
  @IsOptional() @Matches(PERIOD) month?: string;
}

export class CreateExportDto extends AccountingPreviewQuery {
  @IsIn(EXPORT_FORMATS) format!: (typeof EXPORT_FORMATS)[number];
}

// ------------------------------------------------------------------ payouts
export class CreateBatchDto {
  @IsUUID() runId!: string;
  @IsIn(PAYOUT_ADAPTERS) adapter!: (typeof PAYOUT_ADAPTERS)[number];
  @IsOptional() @IsIn(["NEFT", "IMPS", "RTGS"]) mode?: "NEFT" | "IMPS" | "RTGS";
}

export class BankResponseDto {
  @IsString() @MinLength(10) @MaxLength(500_000) csv!: string;
}

// ------------------------------------------------------------------ webhooks
export class CreateSubscriptionDto {
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsString() @MinLength(10) @MaxLength(500) url!: string;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(WEBHOOK_EVENT_TYPES.length) @IsIn(WEBHOOK_EVENT_TYPES, { each: true }) eventTypes!: string[];
}

export class UpdateSubscriptionDto extends VersionDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MinLength(10) @MaxLength(500) url?: string;
  @IsOptional() @IsArray() @ArrayNotEmpty() @IsIn(WEBHOOK_EVENT_TYPES, { each: true }) eventTypes?: string[];
  @IsOptional() @IsIn(["ACTIVE", "DISABLED"]) status?: "ACTIVE" | "DISABLED";
}

export class DeliveriesQuery {
  @IsOptional() @IsIn(["PENDING", "RETRYING", "SUCCEEDED", "FAILED", "SKIPPED"]) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class SinceQuery {
  @IsOptional() @IsISO8601() since?: string;
}

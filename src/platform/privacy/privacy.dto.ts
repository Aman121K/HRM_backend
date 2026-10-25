import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from "class-validator";

const PHONE = /^[0-9+()\-\s]{6,20}$/;

export class UpdatePrivacySettingsDto {
  /** 0 when the brand has never saved privacy settings. */
  @IsInt() @Min(0) version!: number;
  @IsOptional() @IsString() @MaxLength(120) grievanceName?: string;
  @IsOptional() @ValidateIf((_, value) => value !== "") @IsEmail() @MaxLength(160) grievanceEmail?: string;
  @IsOptional() @ValidateIf((_, value) => value !== "") @Matches(PHONE, { message: "grievancePhone must be a phone number" }) grievancePhone?: string;
  @IsOptional() @IsString() @MaxLength(400) grievanceAddress?: string;
  @IsOptional() @IsBoolean() significantFiduciary?: boolean;
  @IsOptional() @IsString() @MaxLength(120) dpoName?: string;
  @IsOptional() @ValidateIf((_, value) => value !== "") @IsEmail() @MaxLength(160) dpoEmail?: string;
  @IsOptional() @ValidateIf((_, value) => value !== "") @Matches(PHONE, { message: "dpoPhone must be a phone number" }) dpoPhone?: string;
  @IsOptional() @IsObject() retention?: Record<string, number>;
  @IsOptional() @IsBoolean() autoErase?: boolean;
}

export class LegalHoldDto {
  @IsBoolean() hold!: boolean;
  @ValidateIf((dto) => dto.hold) @IsString() @MinLength(5) @MaxLength(500) reason?: string;
}

export class ExecuteRetentionDto {
  /** The dry-run the HR person reviewed; execution only erases what that report listed. */
  @IsUUID() dryRunId!: string;
  @Matches(/^ERASE$/, { message: "Type ERASE to confirm." }) confirm!: string;
}

export class RequestErasureDto {
  @IsIn(["DRY_RUN", "EXECUTE"]) mode!: "DRY_RUN" | "EXECUTE";
  @ValidateIf((dto) => dto.mode === "EXECUTE") @Matches(/^ERASE$/, { message: "Type ERASE to confirm." }) confirm?: string;
}

export const BREACH_CATEGORIES = ["Identity & contact", "PAN / Aadhaar / government IDs", "Bank account", "Salary & payslips", "Tax declarations",
  "Attendance & location", "Punch selfies / photos", "Health / leave reasons", "Sign-in credentials", "Documents", "Other"] as const;

export class CreateBreachDto {
  @IsOptional() @IsUUID() organizationId?: string;
  @IsString() @MinLength(5) @MaxLength(160) title!: string;
  @IsString() @MinLength(10) @MaxLength(4000) nature!: string;
  @IsIn(["LOW", "MEDIUM", "HIGH", "CRITICAL"]) severity!: string;
  @IsISO8601() detectedAt!: string;
  @IsOptional() @IsISO8601() occurredAt?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsIn(BREACH_CATEGORIES as unknown as string[], { each: true }) dataCategories?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000_000) affectedCount?: number;
  @IsOptional() @IsString() @MaxLength(2000) affectedDescription?: string;
  @IsOptional() @IsBoolean() certInReportable?: boolean;
}

export class UpdateBreachDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsString() @MinLength(5) @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MinLength(10) @MaxLength(4000) nature?: string;
  @IsOptional() @IsIn(["LOW", "MEDIUM", "HIGH", "CRITICAL"]) severity?: string;
  @IsOptional() @IsIn(["OPEN", "CONTAINED", "CLOSED"]) status?: string;
  @IsOptional() @IsISO8601() occurredAt?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsIn(BREACH_CATEGORIES as unknown as string[], { each: true }) dataCategories?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000_000) affectedCount?: number;
  @IsOptional() @IsString() @MaxLength(2000) affectedDescription?: string;
  @IsOptional() @IsString() @MaxLength(4000) likelyConsequences?: string;
  @IsOptional() @IsString() @MaxLength(4000) containment?: string;
  @IsOptional() @IsString() @MaxLength(4000) mitigation?: string;
  @IsOptional() @IsBoolean() certInReportable?: boolean;
  /** Clock key → mark done now (true) or clear (false). */
  @IsOptional() @IsObject() notified?: Record<string, boolean>;
}

export class BrandExportDto {
  @IsUUID() organizationId!: string;
  @IsOptional() @IsString() @MaxLength(400) reason?: string;
}

export class RequestClosureDto {
  @IsUUID() organizationId!: string;
  @IsString() @MinLength(10) @MaxLength(1000) reason!: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(180) graceDays!: number;
  /** The brand's slug, typed by the admin as confirmation. */
  @IsString() @MaxLength(80) confirmSlug!: string;
}

export class ConfirmClosureDto {
  @IsString() @MaxLength(80) confirmSlug!: string;
}

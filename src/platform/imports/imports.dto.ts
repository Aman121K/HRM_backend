import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsInt, IsObject, IsOptional, IsString, Matches, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from "class-validator";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const FY = /^\d{4}-\d{2}$/;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export class ImportOptionsDto {
  @IsOptional() @Matches(DATE, { message: "cutoverDate must be YYYY-MM-DD" }) cutoverDate?: string;
  @IsOptional() @Matches(FY, { message: "fiscalYear must look like 2026-27" }) fiscalYear?: string;
  @IsOptional() @Matches(PERIOD, { message: "lastPaidPeriod must be YYYY-MM" }) lastPaidPeriod?: string;
}

export class CommitDto {
  /** Raw CSV text (≤ 4 MB). Commit re-validates the same file server-side; reviewed rows from the browser are never trusted. */
  @IsString() @MinLength(1) @MaxLength(4_000_000) csv!: string;
  @IsOptional() @IsString() @MaxLength(200) fileName?: string;
  /** Idempotency key: re-sending a committed key is a no-op. Default: hash of kind + options + file contents. */
  @IsOptional() @Matches(KEY, { message: "batchKey must be 8–128 letters, digits, . _ : -" }) batchKey?: string;
  @IsOptional() @ValidateNested() @Type(() => ImportOptionsDto) options?: ImportOptionsDto;
}

export class PayslipFileDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsString() @MaxLength(11_300_000) base64!: string;
}

export class PayslipImportDto {
  /** A .zip of PDFs named <employee number>_<YYYY-MM>.pdf (base64). */
  @IsOptional() @IsString() @MaxLength(11_300_000) zipBase64?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(600) @ValidateNested({ each: true }) @Type(() => PayslipFileDto) files?: PayslipFileDto[];
  @IsOptional() @IsString() @MaxLength(200) fileName?: string;
  @IsOptional() @Matches(KEY, { message: "batchKey must be 8–128 letters, digits, . _ : -" }) batchKey?: string;
}

export class UndoDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class SettingsDto {
  @Type(() => Number) @IsInt() @Min(0) version!: number;
  @IsOptional() @ValidateIf((_, value) => value !== null) @Matches(DATE, { message: "cutoverDate must be YYYY-MM-DD" }) cutoverDate?: string | null;
  @IsOptional() @ValidateIf((_, value) => value !== null) @Matches(FY, { message: "fiscalYear must look like 2026-27" }) fiscalYear?: string | null;
  @IsOptional() @ValidateIf((_, value) => value !== null) @Matches(PERIOD, { message: "lastPaidPeriod must be YYYY-MM" }) lastPaidPeriod?: string | null;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsString() @MaxLength(80) sourceSystem?: string | null;
  /** Previous system's control totals: { headcount, leave: {EL: 120}, ytd: {gross, tds, pf_employee …}, salary: {structures, annualCtc} }. */
  @IsOptional() @IsObject() controlTotals?: Record<string, unknown>;
}

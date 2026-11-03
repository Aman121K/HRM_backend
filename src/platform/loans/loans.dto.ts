import { Type } from "class-transformer";
import { IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from "class-validator";
import { PURPOSES } from "./loan-rules";

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class RequestLoanDto {
  @IsIn(["LOAN", "ADVANCE"]) kind!: "LOAN" | "ADVANCE";
  @IsIn(PURPOSES as unknown as string[]) purpose!: string;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
  @Type(() => Number) @IsNumber() @Min(500) @Max(10_000_000) principal!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(60) tenureMonths!: number;
  /** First month of recovery (YYYY-MM); defaults to next month. */
  @IsOptional() @Matches(PERIOD, { message: "firstPeriod must be YYYY-MM" }) firstPeriod?: string;
  /** HR raising a loan on someone's behalf. */
  @IsOptional() @IsUUID() employeeId?: string;
}

export class LoanListQuery {
  @IsOptional() @IsIn(["mine", "all"]) scope?: "mine" | "all";
  @IsOptional() @IsIn(["REQUESTED", "APPROVED", "ACTIVE", "CLOSED", "REJECTED", "CANCELLED"]) status?: string;
}

export class DecideLoanDto {
  @IsIn(["approve", "reject"]) decision!: "approve" | "reject";
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  /** Approver may shorten/extend tenure or move the first recovery month. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60) tenureMonths?: number;
  @IsOptional() @Matches(PERIOD, { message: "firstPeriod must be YYYY-MM" }) firstPeriod?: string;
  @Type(() => Number) @IsInt() version!: number;
}

export class DisburseLoanDto {
  @Matches(DATE, { message: "disbursedOn must be a YYYY-MM-DD date" }) disbursedOn!: string;
  @IsString() @MinLength(2) @MaxLength(80) reference!: string;
  @Type(() => Number) @IsInt() version!: number;
}

export class SkipInstallmentDto {
  @Matches(PERIOD, { message: "period must be YYYY-MM" }) period!: string;
  @IsString() @MinLength(3) @MaxLength(300) note!: string;
  @Type(() => Number) @IsInt() version!: number;
}

export class ForecloseDto {
  @IsString() @MinLength(2) @MaxLength(80) reference!: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @Type(() => Number) @IsInt() version!: number;
}

export class CancelLoanDto {
  @Type(() => Number) @IsInt() version!: number;
}

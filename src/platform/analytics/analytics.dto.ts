import { IsIn, IsOptional, IsString, Matches, MaxLength } from "class-validator";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export class AnalyticsQuery {
  @IsOptional() @Matches(MONTH, { message: "from must be a month in YYYY-MM format" }) from?: string;
  @IsOptional() @Matches(MONTH, { message: "to must be a month in YYYY-MM format" }) to?: string;
  @IsOptional() @IsString() @MaxLength(120) department?: string;
  @IsOptional() @IsString() @MaxLength(120) location?: string;
  /** Bypass the 5-minute result cache. */
  @IsOptional() @IsIn(["1", "true"]) refresh?: string;
}

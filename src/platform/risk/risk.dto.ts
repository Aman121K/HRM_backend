import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import { AREAS, SEVERITIES } from "./risk.types";

export class SignalsQuery {
  @IsOptional() @IsIn([...AREAS]) area?: string;
  @IsOptional() @IsIn([...SEVERITIES]) severity?: string;
  /** active = OPEN + ACKNOWLEDGED (default), closed = RESOLVED + DISMISSED. */
  @IsOptional() @IsIn(["active", "closed", "all", "OPEN", "ACKNOWLEDGED", "RESOLVED", "DISMISSED"]) status?: string;
  @IsOptional() @IsString() @MaxLength(80) detector?: string;
  @IsOptional() @IsString() @MaxLength(80) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100000) offset?: number;
}

export class SignalActionDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}

export class UpdateRiskSettingsDto {
  @IsOptional() @IsObject() thresholds?: Record<string, unknown>;
  @IsOptional() @IsArray() minimumWages?: Record<string, unknown>[];
  @Type(() => Number) @IsInt() @Min(0) version!: number;
}

export class ComplianceMarkDto {
  @IsBoolean() filed!: boolean;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export const OBLIGATION_KEY = /^(PF|ESI|TDS):\d{4}-\d{2}$|^(PT|LWF):[A-Z]{2}:\d{4}-\d{2}$|^24Q:\d{4}-\d{2}:Q[1-4]$|^FORM16:\d{4}-\d{2}$/;
export class CalendarQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
}

import { Type } from "class-transformer";
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from "class-validator";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export class WeekQuery {
  @IsOptional() @Matches(DATE, { message: "start must be a YYYY-MM-DD date" }) start?: string;
  @IsOptional() @IsIn(["team", "all"]) scope?: "team" | "all";
  @IsOptional() @IsString() @MaxLength(80) department?: string;
  @IsOptional() @IsString() @MaxLength(120) location?: string;
  @IsOptional() @IsString() @MaxLength(80) search?: string;
}

export class MyRosterQuery {
  @IsOptional() @Matches(DATE, { message: "start must be a YYYY-MM-DD date" }) start?: string;
}

export class AssignmentInput {
  @IsUUID() employeeId!: string;
  @Matches(DATE, { message: "date must be a YYYY-MM-DD date" }) date!: string;
  /** SHIFT needs templateId; WEEKLY_OFF marks a rest day; CLEAR removes whatever is planned. */
  @IsIn(["SHIFT", "WEEKLY_OFF", "CLEAR"]) kind!: "SHIFT" | "WEEKLY_OFF" | "CLEAR";
  @IsOptional() @IsUUID() templateId?: string;
  @IsOptional() @IsString() @MaxLength(120) location?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  /** Version the planner last saw (0 = empty cell). Omit to overwrite without a check. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) version?: number;
}

export class SaveAssignmentsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(400) @ValidateNested({ each: true }) @Type(() => AssignmentInput) items!: AssignmentInput[];
  /** Skip days blocked by approved leave instead of rejecting the whole batch (patterns, bulk fills). */
  @IsOptional() @IsBoolean() skipConflicts?: boolean;
  @IsOptional() @IsIn(["MANUAL", "PATTERN"]) source?: "MANUAL" | "PATTERN";
}

export class WeekScopeDto {
  @Matches(DATE, { message: "start must be a YYYY-MM-DD date" }) start!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID("all", { each: true }) employeeIds!: string[];
}

export class CopyWeekDto extends WeekScopeDto {
  /** Replace cells that are already planned in the target week (default: only fill empty cells). */
  @IsOptional() @IsBoolean() overwrite?: boolean;
}

export class TemplateDto {
  @Matches(/^[A-Z0-9]{1,6}$/, { message: "code must be 1–6 capital letters or digits" }) code!: string;
  @IsString() @MinLength(2) @MaxLength(60) name!: string;
  @Matches(TIME, { message: "startTime must be HH:MM" }) startTime!: string;
  @Matches(TIME, { message: "endTime must be HH:MM" }) endTime!: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(240) breakMinutes!: number;
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: "color must be a #RRGGBB hex colour" }) color!: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(500) minHeadcount!: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateTemplateDto extends TemplateDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}

export class SettingsDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(24) minRestHours!: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 1 }) @Min(1) @Max(120) maxWeeklyHours!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(13) maxConsecutiveDays!: number;
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}

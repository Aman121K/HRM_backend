import { Type } from "class-transformer";
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested,
} from "class-validator";

export const QUESTION_TYPES = ["RATING", "ENPS", "SINGLE_CHOICE", "MULTI_CHOICE", "SHORT_TEXT", "LONG_TEXT"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const AUDIENCE_TYPES = ["ALL", "DEPARTMENTS", "LOCATIONS", "TEAM"] as const;
export type AudienceType = (typeof AUDIENCE_TYPES)[number];

export class QuestionDto {
  @IsIn(QUESTION_TYPES) type!: QuestionType;
  @IsString() @MinLength(3) @MaxLength(500) prompt!: string;
  @IsOptional() @IsString() @MaxLength(500) helpText?: string;
  @IsBoolean() required!: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) @MaxLength(120, { each: true }) options?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) @MaxLength(40, { each: true }) scaleLabels?: string[];
}

export class SurveyInputDto {
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsBoolean() anonymous!: boolean;
  @IsBoolean() allowEdit!: boolean;
  @IsBoolean() shareResults!: boolean;
  @IsIn(AUDIENCE_TYPES) audienceType!: AudienceType;
  @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(120, { each: true }) audienceValues!: string[];
  @IsOptional() @IsISO8601() opensAt?: string | null;
  @IsOptional() @IsISO8601() closesAt?: string | null;
  @IsArray() @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => QuestionDto) questions!: QuestionDto[];
}

export class UpdateSurveyDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsBoolean() anonymous?: boolean;
  @IsOptional() @IsBoolean() allowEdit?: boolean;
  @IsOptional() @IsBoolean() shareResults?: boolean;
  @IsOptional() @IsIn(AUDIENCE_TYPES) audienceType?: AudienceType;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(120, { each: true }) audienceValues?: string[];
  @IsOptional() @IsISO8601() opensAt?: string | null;
  @IsOptional() @IsISO8601() closesAt?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => QuestionDto) questions?: QuestionDto[];
}

export class VersionDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}

export class AnswerDto {
  @IsUUID() questionId!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10) value?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) @MaxLength(120, { each: true }) choices?: string[];
  @IsOptional() @IsString() @MaxLength(4000) text?: string;
}

export class SubmitResponseDto {
  @IsArray() @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => AnswerDto) answers!: AnswerDto[];
}

export class CreatePollDto {
  @IsString() @MinLength(3) @MaxLength(300) question!: string;
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(6) @IsString({ each: true }) @MinLength(1, { each: true }) @MaxLength(120, { each: true }) options!: string[];
  @IsBoolean() multiple!: boolean;
  @IsBoolean() anonymous!: boolean;
  @IsOptional() @IsISO8601() closesAt?: string | null;
  @IsIn(AUDIENCE_TYPES) audienceType!: AudienceType;
  @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(120, { each: true }) audienceValues!: string[];
}

export class VoteDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6) @IsString({ each: true }) @MaxLength(120, { each: true }) choices!: string[];
}

export class ListSurveysQuery {
  @IsOptional() @IsIn(["manage"]) scope?: "manage";
  @IsOptional() @IsIn(["SURVEY", "POLL"]) kind?: "SURVEY" | "POLL";
}

export class ResultsQuery {
  @IsOptional() @IsIn(["department", "location"]) breakdown?: "department" | "location";
}

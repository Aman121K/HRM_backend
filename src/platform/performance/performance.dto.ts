import { Type } from "class-transformer";
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from "class-validator";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CompetencyDto {
  @Matches(/^[a-z][a-z0-9_]{1,30}$/) key!: string;
  @IsString() @MinLength(2) @MaxLength(60) label!: string;
  @IsString() @MaxLength(300) description!: string;
}

export class CycleDto {
  @IsString() @MinLength(3) @MaxLength(80) name!: string;
  @Matches(DATE) periodStart!: string;
  @Matches(DATE) periodEnd!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100) goalWeight?: number;
  @IsOptional() @IsBoolean() selfReview?: boolean;
  @IsOptional() @IsBoolean() peerReview?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(8) maxPeers?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => CompetencyDto) competencies?: CompetencyDto[];
  @IsOptional() @IsString() @MaxLength(80) department?: string;
  @IsOptional() @Matches(DATE) goalsDue?: string;
  @IsOptional() @Matches(DATE) reviewsDue?: string;
}

export class AdvanceCycleDto {
  @Type(() => Number) @IsInt() version!: number;
}

export class KeyResultDto {
  @IsString() @MinLength(2) @MaxLength(160) title!: string;
  @Type(() => Number) @IsNumber() @Min(0) @Max(1e12) target!: number;
  @Type(() => Number) @IsNumber() @Min(0) @Max(1e12) current!: number;
  @IsString() @MaxLength(20) unit!: string;
}

export class GoalDto {
  @IsOptional() @IsUUID() id?: string;
  @IsString() @MinLength(3) @MaxLength(160) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @Type(() => Number) @IsInt() @Min(5) @Max(100) weight!: number;
  @IsArray() @ArrayMaxSize(6) @ValidateNested({ each: true }) @Type(() => KeyResultDto) keyResults!: KeyResultDto[];
}

export class SaveGoalsDto {
  @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => GoalDto) goals!: GoalDto[];
  /** true = submit to the manager for approval. */
  @IsOptional() @IsBoolean() submit?: boolean;
}

export class GoalDecisionDto {
  @IsIn(["approve", "return"]) decision!: "approve" | "return";
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class ProgressDto {
  @IsArray() @ArrayMaxSize(6) @ValidateNested({ each: true }) @Type(() => KeyResultDto) keyResults!: KeyResultDto[];
}

export class GoalRatingDto {
  @IsUUID() goalId!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(5) rating!: number;
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
}

export class ReviewDto {
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => GoalRatingDto) goals?: GoalRatingDto[];
  @IsOptional() @IsObject() competencyRatings?: Record<string, number>;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) overallRating?: number;
  @IsOptional() @IsString() @MaxLength(3000) strengths?: string;
  @IsOptional() @IsString() @MaxLength(3000) improvements?: string;
  @IsOptional() @IsString() @MaxLength(3000) comments?: string;
  /** Manager only: recommendation that seeds calibration. */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) incrementPct?: number;
  @IsOptional() @IsBoolean() promote?: boolean;
  @IsOptional() @IsString() @MaxLength(80) newDesignation?: string;
  /** false = save as draft. */
  @IsOptional() @IsBoolean() submit?: boolean;
}

export class NominateDto {
  @IsArray() @ArrayMaxSize(8) @IsUUID("all", { each: true }) reviewerIds!: string[];
  @IsOptional() @IsIn(["PEER", "REPORT"]) relation?: "PEER" | "REPORT";
  /** Managers/HR nominating for someone else. */
  @IsOptional() @IsUUID() subjectId?: string;
}

export class CalibrateDto {
  @Type(() => Number) @IsNumber() @Min(1) @Max(5) finalRating!: number;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) incrementPct?: number;
  @IsOptional() @IsBoolean() promote?: boolean;
  @IsOptional() @IsString() @MaxLength(80) newDesignation?: string;
  @Type(() => Number) @IsInt() version!: number;
}

export class RevisionDecisionDto {
  @IsArray() @ArrayMaxSize(1000) @IsUUID("all", { each: true }) participantIds!: string[];
  @IsIn(["approve", "apply"]) action!: "approve" | "apply";
  @IsOptional() @Matches(DATE) effectiveFrom?: string;
}

export class CycleQuery {
  @IsOptional() @IsUUID() cycleId?: string;
}

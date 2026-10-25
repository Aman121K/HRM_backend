import { Type } from "class-transformer";
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength,
  Min, MinLength, ValidateNested,
} from "class-validator";

export const LMS_CATEGORIES = ["Coffee craft", "Customer service", "Leadership", "Food safety", "Compliance", "Technology", "Operations", "Wellbeing"];
export const LMS_LEVELS = ["BEGINNER", "INTERMEDIATE", "ADVANCED"];
export const LESSON_TYPES = ["TEXT", "VIDEO", "PDF", "QUIZ"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CatalogQuery {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(LMS_CATEGORIES) category?: string;
}

export class CourseInputDto {
  @IsString() @MinLength(3) @MaxLength(140) title!: string;
  @IsOptional() @IsString() @MaxLength(600) summary?: string;
  @IsOptional() @IsString() @MaxLength(8000) description?: string;
  @IsIn(LMS_CATEGORIES) category!: string;
  @IsOptional() @IsIn(LMS_LEVELS) level?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(6000) durationMinutes?: number;
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/) coverColor?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(8) coverEmoji?: string;
  @IsOptional() @IsBoolean() mandatory?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) mandatoryDueDays?: number;
}

export class UpdateCourseDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(140) title?: string;
  @IsOptional() @IsString() @MaxLength(600) summary?: string;
  @IsOptional() @IsString() @MaxLength(8000) description?: string;
  @IsOptional() @IsIn(LMS_CATEGORIES) category?: string;
  @IsOptional() @IsIn(LMS_LEVELS) level?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(6000) durationMinutes?: number;
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/) coverColor?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(8) coverEmoji?: string;
  @IsOptional() @IsBoolean() mandatory?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) mandatoryDueDays?: number;
}

export class CourseStatusDto {
  @IsIn(["DRAFT", "PUBLISHED", "ARCHIVED"]) status!: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}

export class QuestionOptionDto {
  @Matches(/^[a-z0-9]{1,8}$/) id!: string;
  @IsString() @MinLength(1) @MaxLength(300) text!: string;
}

export class QuestionDto {
  @IsString() @MinLength(3) @MaxLength(1000) prompt!: string;
  @IsIn(["SINGLE", "MULTI"]) kind!: "SINGLE" | "MULTI";
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(8) @ValidateNested({ each: true }) @Type(() => QuestionOptionDto) options!: QuestionOptionDto[];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(8) @Matches(/^[a-z0-9]{1,8}$/, { each: true }) correct!: string[];
  @IsOptional() @IsString() @MaxLength(1000) explanation?: string;
}

export class LessonInputDto {
  @Type(() => Number) @IsInt() @Min(1) courseVersion!: number;
  @IsString() @MinLength(2) @MaxLength(140) title!: string;
  @IsIn(LESSON_TYPES) type!: "TEXT" | "VIDEO" | "PDF" | "QUIZ";
  @IsOptional() @IsString() @MaxLength(20000) body?: string;
  @IsOptional() @IsString() @MaxLength(500) videoUrl?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(600) durationMinutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) passMark?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(20) maxAttempts?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => QuestionDto) questions?: QuestionDto[];
}

export class UpdateLessonDto {
  @Type(() => Number) @IsInt() @Min(1) courseVersion!: number;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(140) title?: string;
  @IsOptional() @IsString() @MaxLength(20000) body?: string;
  @IsOptional() @IsString() @MaxLength(500) videoUrl?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(600) durationMinutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) passMark?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(20) maxAttempts?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => QuestionDto) questions?: QuestionDto[];
}

export class CourseVersionDto {
  @Type(() => Number) @IsInt() @Min(1) courseVersion!: number;
}

export class ReorderLessonsDto {
  @Type(() => Number) @IsInt() @Min(1) courseVersion!: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID("all", { each: true }) lessonIds!: string[];
}

export class AttemptDto {
  /** questionId → selected option ids */
  @IsObject() answers!: Record<string, string[]>;
}

export class AssignDto {
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID("all", { each: true }) employeeIds?: string[];
  @IsOptional() @IsString() @MaxLength(80) department?: string;
  @IsOptional() @IsString() @MaxLength(120) location?: string;
  @IsOptional() @Matches(DATE) dueDate?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class RemindersDto {
  @IsOptional() @IsUUID() courseId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30) withinDays?: number;
}

export class ResetAttemptsDto {
  @IsUUID() lessonId!: string;
}

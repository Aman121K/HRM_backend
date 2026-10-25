import { Type } from "class-transformer";
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from "class-validator";

export const PHASES = ["PRE_BOARDING", "DAY_ONE", "FIRST_WEEK", "FIRST_90_DAYS"] as const;
export const OWNER_TYPES = ["HR", "IT", "MANAGER", "BUDDY", "JOINER", "FINANCE"] as const;
export const DOCUMENT_CATEGORIES = ["PAN", "AADHAAR", "BANK_PROOF", "EDUCATION", "PHOTO", "OTHER"] as const;
export const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"] as const;
export const JOINER_STATUSES = ["PRE_BOARDING", "READY_TO_JOIN", "JOINED", "COMPLETED", "WITHDRAWN"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateJoinerDto {
  @IsString() @MinLength(2) @MaxLength(160) fullName!: string;
  @IsEmail() @MaxLength(200) personalEmail!: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsString() @MinLength(2) @MaxLength(120) designation!: string;
  @IsString() @MinLength(2) @MaxLength(120) department!: string;
  @IsOptional() @IsString() @MaxLength(120) location?: string;
  @IsOptional() @IsUUID() managerId?: string;
  @IsOptional() @IsUUID() buddyId?: string;
  @Matches(DATE, { message: "joiningDate must be a YYYY-MM-DD date" }) joiningDate!: string;
  @IsOptional() @IsIn(EMPLOYMENT_TYPES) employmentType?: string;
  @IsOptional() @IsUUID() templateId?: string;
  @IsOptional() @IsUUID() candidateId?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateJoinerDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(160) fullName?: string;
  @IsOptional() @IsEmail() @MaxLength(200) personalEmail?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) designation?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) department?: string;
  @IsOptional() @IsString() @MaxLength(120) location?: string;
  /** Empty string clears the value. */
  @IsOptional() @IsString() @MaxLength(36) managerId?: string;
  @IsOptional() @IsString() @MaxLength(36) buddyId?: string;
  @IsOptional() @Matches(DATE, { message: "joiningDate must be a YYYY-MM-DD date" }) joiningDate?: string;
  @IsOptional() @IsIn(EMPLOYMENT_TYPES) employmentType?: string;
  @IsOptional() @IsString() @MaxLength(10) panNumber?: string;
  @IsOptional() @IsString() @MaxLength(14) aadhaarNumber?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class JoinerTransitionDto {
  @IsIn(["ready", "back_to_preboarding", "convert", "complete", "withdraw"]) action!: string;
  @Type(() => Number) @IsInt() @Min(1) version!: number;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsEmail() @MaxLength(200) workEmail?: string;
}

export class ListJoinersQuery {
  @IsOptional() @IsIn(JOINER_STATUSES) status?: string;
  @IsOptional() @IsString() @MaxLength(120) department?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(["all", "mine"]) scope?: string;
}

export class UpcomingQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) days?: number;
}

export class TaskActionDto {
  @IsIn(["complete", "skip", "reopen"]) action!: string;
  @Type(() => Number) @IsInt() @Min(1) version!: number;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class UpdateTaskDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
  @IsOptional() @IsString() @MaxLength(36) ownerId?: string;
  @IsOptional() @Matches(DATE, { message: "dueDate must be a YYYY-MM-DD date" }) dueDate?: string;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(160) title?: string;
}

export class AddTaskDto {
  @IsIn(PHASES) phase!: string;
  @IsString() @MinLength(3) @MaxLength(160) title!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsIn(OWNER_TYPES) ownerType!: string;
  @IsOptional() @IsUUID() ownerId?: string;
  @Matches(DATE, { message: "dueDate must be a YYYY-MM-DD date" }) dueDate!: string;
  @IsOptional() @IsIn(DOCUMENT_CATEGORIES) documentCategory?: string;
}

export class ListMyTasksQuery {
  @IsOptional() @IsIn(["open", "done", "all"]) state?: string;
}

export class ReviewDocumentDto {
  @IsIn(["VERIFIED", "REJECTED"]) decision!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class TemplateTaskDto {
  @IsIn(PHASES) phase!: string;
  @IsString() @MinLength(3) @MaxLength(160) title!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsIn(OWNER_TYPES) ownerType!: string;
  @Type(() => Number) @IsInt() @Min(-90) @Max(180) dueOffsetDays!: number;
  @IsOptional() @IsBoolean() requiresDocument?: boolean;
  @IsOptional() @IsIn(DOCUMENT_CATEGORIES) documentCategory?: string;
  @IsOptional() @IsBoolean() completesOnConversion?: boolean;
}

export class SaveTemplateDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) version?: number;
  @IsString() @MinLength(3) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsArray() @ArrayMaxSize(80) @ValidateNested({ each: true }) @Type(() => TemplateTaskDto) tasks!: TemplateTaskDto[];
}

export class SaveSettingsDto {
  @Type(() => Number) @IsInt() @Min(0) version!: number;
  @IsOptional() @IsString() @MaxLength(36) hrOwnerId?: string;
  @IsOptional() @IsString() @MaxLength(36) itOwnerId?: string;
  @IsOptional() @IsString() @MaxLength(36) financeOwnerId?: string;
  @IsOptional() @Matches(/^[A-Z]{1,6}$/, { message: "employeeNumberPrefix must be 1–6 capital letters" }) employeeNumberPrefix?: string;
  @IsOptional() @IsString() @MaxLength(120) workEmailDomain?: string;
  @IsOptional() @IsString() @MaxLength(2000) welcomeMessage?: string;
}

export class RevealJoinerDto {
  @IsIn(["pan"]) field!: "pan";
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

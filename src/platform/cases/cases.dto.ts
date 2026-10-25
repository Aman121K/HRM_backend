import { Type } from "class-transformer";
import { IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";
import { caseModules } from "./case-modules";

const moduleKeys = caseModules.map((module) => module.key);

export class CreateCaseDto {
  @IsIn(moduleKeys) module!: string;
  @IsObject() values!: Record<string, unknown>;
}

export class CaseTransitionDto {
  @IsString() @MaxLength(60) action!: string;
  @Type(() => Number) @IsInt() @Min(1) version!: number;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsObject() values?: Record<string, unknown>;
}

export class CaseCommentDto {
  @IsString() @MinLength(1) @MaxLength(2000) note!: string;
}

export class ListCasesQuery {
  @IsOptional() @IsIn(moduleKeys) module?: string;
  @IsOptional() @IsIn(["mine", "team", "all"]) scope?: "mine" | "team" | "all";
  @IsOptional() @IsString() @MaxLength(40) status?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

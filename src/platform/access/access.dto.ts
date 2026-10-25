import { Type } from "class-transformer";
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from "class-validator";
import { BASE_ROLES, PERMISSION_KEYS, SCOPES, type Scope } from "./permissions";

export class PermissionGrantDto {
  @IsIn(PERMISSION_KEYS) key!: string;
  @IsIn(SCOPES as unknown as string[]) scope!: Scope;
}

/** High-risk (CRITICAL) grants must be confirmed explicitly with a written reason. */
class ConfirmableDto {
  @IsOptional() @IsBoolean() confirm?: boolean;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class CreateRoleDto extends ConfirmableDto {
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => PermissionGrantDto) permissions!: PermissionGrantDto[];
  /** 'system:MANAGER' or a custom role id this one was cloned from. */
  @IsOptional() @IsString() @MaxLength(60) basedOn?: string;
}

export class UpdateRoleDto extends ConfirmableDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => PermissionGrantDto) permissions?: PermissionGrantDto[];
}

export class RoleStatusDto extends ConfirmableDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
  @IsIn(["ACTIVE", "ARCHIVED"]) status!: "ACTIVE" | "ARCHIVED";
}

export class AssignRoleDto extends ConfirmableDto {
  @IsUUID() employeeId!: string;
  @IsUUID() roleId!: string;
  @IsOptional() @IsDateString() expiresAt?: string;
  @IsOptional() @IsString() @MaxLength(120) department?: string;
  @IsOptional() @IsString() @MaxLength(120) location?: string;
  /** Validate and return the impact (new permissions, SoD warnings, confirmation needed) without saving. */
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

export class RevokeAssignmentDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class BaseRoleDto extends ConfirmableDto {
  @IsIn(BASE_ROLES as unknown as string[]) role!: string;
  /** The role the admin saw — protects against two admins changing the same person at once. */
  @IsIn(BASE_ROLES as unknown as string[]) expectedRole!: string;
}

export class PeopleQuery {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsUUID() roleId?: string;
  @IsOptional() @IsIn(BASE_ROLES as unknown as string[]) baseRole?: string;
  @IsOptional() @IsIn(["elevated", "temporary", "custom"]) filter?: "elevated" | "temporary" | "custom";
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

export class ExportQuery {
  @IsOptional() @IsIn(PERMISSION_KEYS) permission?: string;
}

export class AuditQuery {
  @IsOptional() @IsUUID() actor?: string;
  @IsOptional() @IsString() @MaxLength(80) action?: string;
  @IsOptional() @IsString() @MaxLength(80) entityType?: string;
  @IsOptional() @IsUUID() entityId?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(100) pageSize?: number;
}

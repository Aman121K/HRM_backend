import { Transform, Type } from "class-transformer";
import { IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateIf } from "class-validator";

const blankToNull = ({ value }: { value: unknown }) => (typeof value === "string" && value.trim() === "" ? null : typeof value === "string" ? value.trim() : value);

export class UpdateEmployeeDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
  @IsOptional() @Transform(({ value }) => (typeof value === "string" ? value.trim() : value)) @IsString() @MinLength(2) @MaxLength(120) fullName?: string;
  @IsOptional() @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value)) @IsEmail() @MaxLength(200) workEmail?: string;
  @IsOptional() @Transform(blankToNull) @ValidateIf((_, value) => value !== null) @IsString() @MaxLength(120) department?: string | null;
  @IsOptional() @Transform(blankToNull) @ValidateIf((_, value) => value !== null) @IsString() @MaxLength(120) designation?: string | null;
  @IsOptional() @Transform(blankToNull) @ValidateIf((_, value) => value !== null) @IsString() @MaxLength(120) location?: string | null;
  @IsOptional() @IsIn(["ACTIVE", "INACTIVE"]) status?: "ACTIVE" | "INACTIVE";
  /** null clears the reporting manager. */
  @IsOptional() @Transform(blankToNull) @ValidateIf((_, value) => value !== null) @IsUUID() managerId?: string | null;
}

export class ImportCsvDto {
  /** Raw CSV text (≤ 2 MB). Commit re-validates the same file server-side; reviewed rows from the browser are never trusted. */
  @IsString() @MinLength(1) @MaxLength(2_000_000) csv!: string;
  @IsOptional() @IsString() @MaxLength(200) fileName?: string;
}

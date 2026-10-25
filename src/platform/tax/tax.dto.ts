import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from "class-validator";

export const REGIMES = ["NEW", "OLD"] as const;
export const REVIEW_ACTIONS = ["ACCEPT", "REJECT", "REQUEST_CLARIFICATION"] as const;

export class CalculateTaxDto {
  @IsOptional() @IsIn(REGIMES) regime?: "NEW" | "OLD";
  /** Annual amounts keyed by TaxInputs field; unknown keys are ignored by normalize(). */
  @IsOptional() @IsObject() inputs?: Record<string, unknown>;
}

export class SaveDeclarationDto {
  @IsIn(REGIMES) regime!: "NEW" | "OLD";
  @IsObject() inputs!: Record<string, unknown>;
  /** Line items (investment, rent, insurance…); sanitised field-by-field in the service. */
  @IsOptional() @IsArray() @ArrayMaxSize(60) @IsObject({ each: true }) items?: Record<string, unknown>[];
  @IsOptional() @IsBoolean() consent?: boolean;
}

export class UpdateDeclarationDto extends SaveDeclarationDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}

export class SubmitDeclarationDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
  @IsBoolean() consent!: boolean;
}

export class WithdrawDeclarationDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}

export class ReviewAmountsDto {
  @Type(() => Number) @IsNumber() @Min(0) @Max(1_000_000_000) declared!: number;
  @Type(() => Number) @IsNumber() @Min(0) @Max(1_000_000_000) accepted!: number;
  @Type(() => Number) @IsNumber() @Min(0) @Max(1_000_000_000) rejected!: number;
}

export class ReviewDeclarationDto {
  @IsIn(REVIEW_ACTIONS) action!: (typeof REVIEW_ACTIONS)[number];
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
  @IsOptional() @ValidateNested() @Type(() => ReviewAmountsDto) amounts?: ReviewAmountsDto;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) version?: number;
}

export class UploadProofDto {
  @IsString() @MaxLength(60) category!: string;
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9-]{1,64}$/) itemId?: string;
  @IsString() @MaxLength(180) originalName!: string;
  @IsString() @MaxLength(60) mimeType!: string;
  @IsString() @MaxLength(12_000_000) base64!: string;
}

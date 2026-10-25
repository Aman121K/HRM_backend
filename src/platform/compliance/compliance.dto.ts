import { IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from "class-validator";

export class UpdateControlDto {
  @IsIn(["not_started", "in_progress", "implemented", "not_applicable"]) status!: string;
  @IsOptional() @IsString() @MaxLength(120) owner?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
  @IsInt() @Min(0) version!: number;
}

export class AddEvidenceDto {
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(4000) detail?: string;
  /** Link to the document in your drive / ticketing system (https only). */
  @IsOptional() @IsString() @MaxLength(1000) link?: string;
}

export class StartReviewDto {
  @IsOptional() @IsString() @MaxLength(160) title?: string;
  @IsOptional() @IsDateString() dueAt?: string;
}

export class DecideItemDto {
  @IsIn(["KEEP", "REVOKE"]) decision!: "KEEP" | "REVOKE";
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class PublishPolicyDto {
  @IsOptional() @Matches(/^[a-z0-9-]{2,60}$/) key?: string;
  @IsString() @MinLength(3) @MaxLength(160) title!: string;
  @IsString() @MinLength(3) @MaxLength(400) summary!: string;
  @IsString() @MinLength(20) @MaxLength(40000) body!: string;
}

import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from "class-validator";

export const OUTBOX_STATUSES = ["PENDING", "PROCESSING", "SENT", "FAILED"] as const;

export class FailedJobsQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class OutboxQuery {
  @IsOptional() @IsIn(OUTBOX_STATUSES) status?: (typeof OUTBOX_STATUSES)[number];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class JobRunsQuery {
  @IsOptional() @Matches(/^[a-z][a-z0-9_.-]{1,79}$/) name?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

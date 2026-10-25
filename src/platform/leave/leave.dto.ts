import { IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from "class-validator";
import { Type } from "class-transformer";

export class CreateLeaveDto {
  @IsUUID() leaveTypeId!: string;
  @IsDateString() startDate!: string;
  @IsDateString() endDate!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.5) days!: number;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}

export class LeaveDecisionDto {
  @IsIn(["APPROVED", "REJECTED"]) decision!: "APPROVED" | "REJECTED";
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

import { Type } from "class-transformer";
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested,
} from "class-validator";

export class RegisterDeviceDto {
  @IsIn(["ios", "android"]) platform: "ios" | "android";
  @IsIn(["apns", "fcm"]) provider: "apns" | "fcm";
  @IsString() @IsNotEmpty() @MaxLength(4096) @Matches(/^[\x21-\x7e]{8,}$/, { message: "token must be at least 8 printable characters without spaces" }) token: string;
  /** APNs environment. "simulator" = local development device served by the dev provider (and simctl). */
  @IsOptional() @IsIn(["sandbox", "production", "simulator"]) environment?: "sandbox" | "production" | "simulator";
  @IsOptional() @IsString() @MaxLength(40) appVersion?: string;
  @IsOptional() @IsString() @MaxLength(120) deviceName?: string;
  @IsOptional() @IsString() @MaxLength(200) @Matches(/^[A-Za-z0-9.\-_]+$/) bundleId?: string;
}

export class UnregisterDeviceDto {
  @IsString() @IsNotEmpty() @MaxLength(4096) token: string;
}

export class MarkReadDto {
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsInt({ each: true }) @Min(1, { each: true }) ids?: number[];
  @IsOptional() @IsBoolean() all?: boolean;
}

export class CategoryPreferencesDto {
  @IsBoolean() approvals: boolean;
  @IsBoolean() payroll: boolean;
  @IsBoolean() time: boolean;
  @IsBoolean() requests: boolean;
  @IsBoolean() learning: boolean;
  @IsBoolean() engagement: boolean;
  @IsBoolean() announcements: boolean;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export class QuietHoursDto {
  @IsBoolean() enabled: boolean;
  @Matches(HHMM, { message: "start must be HH:MM" }) start: string;
  @Matches(HHMM, { message: "end must be HH:MM" }) end: string;
  @IsString() @MaxLength(64) timezone: string;
}

export class ChannelsDto {
  @IsBoolean() push: boolean;
  @IsBoolean() email: boolean;
}

export class PreferencesDto {
  @ValidateNested() @Type(() => CategoryPreferencesDto) categories: CategoryPreferencesDto;
  @ValidateNested() @Type(() => QuietHoursDto) quietHours: QuietHoursDto;
  @ValidateNested() @Type(() => ChannelsDto) channels: ChannelsDto;
  /** Version from GET (0 when never saved). Optional; when sent, a stale value returns 409. */
  @IsOptional() @IsInt() @Min(0) version?: number;
}

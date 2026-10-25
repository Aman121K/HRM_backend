import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from "class-validator";

const SLUG = /^(platform|[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)$/;

export class LoginDto {
  @IsString() @MaxLength(254) email!: string;
  @IsString() @MaxLength(256) password!: string;
  @IsOptional() @IsString() @Matches(SLUG) brand?: string;
  @IsOptional() @IsString() @MaxLength(80) deviceName?: string;
}
export class ChallengeDto { @IsString() @MinLength(20) @MaxLength(200) challenge!: string; }
export class MfaVerifyDto {
  @IsString() @MinLength(20) @MaxLength(200) challenge!: string;
  @IsIn(["totp", "recovery", "email"]) method!: "totp" | "recovery" | "email";
  @IsString() @MaxLength(40) code!: string;
}
export class EnrollConfirmDto {
  @IsString() @MinLength(20) @MaxLength(200) challenge!: string;
  @IsString() @MaxLength(12) code!: string;
}
export class RefreshDto { @IsOptional() @IsString() @MaxLength(200) refreshToken?: string; }
export class ForgotDto {
  @IsString() @MaxLength(254) email!: string;
  @IsOptional() @IsString() @Matches(SLUG) brand?: string;
}
export class TokenDto { @IsString() @MinLength(20) @MaxLength(200) token!: string; }
export class ResetDto {
  @IsString() @MinLength(20) @MaxLength(200) token!: string;
  @IsString() @MaxLength(256) password!: string;
}
export class ActivateDto {
  @IsString() @MinLength(20) @MaxLength(200) token!: string;
  @IsString() @MaxLength(256) password!: string;
  @IsOptional() @IsString() @MaxLength(80) deviceName?: string;
}
export class ChangePasswordDto {
  @IsString() @MaxLength(256) currentPassword!: string;
  @IsString() @MaxLength(256) newPassword!: string;
  @IsOptional() @IsString() @MaxLength(12) code?: string;
}
export class TotpStartDto {
  @IsOptional() @IsString() @MaxLength(256) currentPassword?: string;
  @IsOptional() @IsString() @MaxLength(60) name?: string;
}
export class TotpConfirmDto {
  @IsUUID() deviceId!: string;
  @IsString() @MaxLength(12) code!: string;
}
export class TotpRemoveDto {
  @IsOptional() @IsString() @MaxLength(256) currentPassword?: string;
  @IsOptional() @IsString() @MaxLength(12) code?: string;
}
export class CodeDto { @IsString() @MaxLength(12) code!: string; }
export class PolicyDto {
  @IsOptional() @IsIn(["PASSWORD", "SSO", "BOTH"]) signInMethods?: "PASSWORD" | "SSO" | "BOTH";
  @IsOptional() @IsBoolean() mfaRequiredAll?: boolean;
  @IsOptional() @IsBoolean() emailOtpFallback?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(720) sessionMaxHours?: number;
  @IsOptional() @IsInt() @Min(5) @Max(720) sessionIdleMinutes?: number;
}
export class PlatformInviteDto {
  @IsString() @MaxLength(254) @Matches(/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/) email!: string;
  @IsString() @MinLength(2) @MaxLength(120) fullName!: string;
}

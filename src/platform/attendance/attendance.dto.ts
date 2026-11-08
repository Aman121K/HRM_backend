import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsDefined, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from "class-validator";

export class PunchLocationDto {
  @Type(() => Number) @IsNumber() @Min(-90) @Max(90) latitude!: number;
  @Type(() => Number) @IsNumber() @Min(-180) @Max(180) longitude!: number;
  @Type(() => Number) @IsNumber() @Min(0.1) @Max(100000) accuracyMetres!: number;
  @IsDateString() capturedAt!: string;
  @IsIn(["granted"]) permission!: "granted";
}

export class LivenessDto {
  @IsBoolean() passed!: boolean;
  @IsIn(["blink", "head_turn", "none"]) method!: "blink" | "head_turn" | "none";
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(1) score?: number;
}

/** Result of on-device face detection. Advisory: failures route the punch to review rather than rejecting it. */
export class FaceCheckDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(20) faces!: number;
  @ValidateNested() @Type(() => LivenessDto) liveness!: LivenessDto;
  @IsIn(["mediapipe", "mlkit", "vision", "none"]) detector!: string;
}

export class SelfieDto {
  /** ≤ ~2 MB image; capture must be a live front-camera photo taken moments before the punch. */
  @IsString() @MaxLength(2_900_000) base64!: string;
  @IsIn(["image/jpeg", "image/webp", "image/png"]) mimeType!: string;
  @IsDateString() capturedAt!: string;
}

/** Proof that the punch comes from a registered device (see punch-guard.ts). */
export class DeviceProofDto {
  @IsIn(["webcrypto", "token"]) kind!: "webcrypto" | "token";
  /** web: SPKI public key (base64) of a non-extractable ECDSA P-256 key held by the browser. */
  @IsOptional() @IsString() @MaxLength(400) @Matches(/^[A-Za-z0-9+/=]+$/) publicKey?: string;
  /** web: P-256 signature (base64, raw r||s) over punchMessage(type, idempotencyKey, location.capturedAt). */
  @IsOptional() @IsString() @MaxLength(200) @Matches(/^[A-Za-z0-9+/=]+$/) signature?: string;
  /** mobile: random secret kept in the Keychain / Android Keystore. */
  @IsOptional() @IsString() @MaxLength(200) @Matches(/^[A-Za-z0-9_-]+$/) token?: string;
  @IsIn(["WEB", "ANDROID", "IOS"]) platform!: "WEB" | "ANDROID" | "IOS";
  @IsOptional() @IsString() @MaxLength(80) label?: string;
}

const BSSID = /^[0-9A-Fa-f]{2}([:-]?[0-9A-Fa-f]{2}){5}$/;

export class PrecheckDto extends PunchLocationDto {
  @IsOptional() @Matches(/^[0-9a-f]{64}$/) deviceKeyHash?: string;
  @IsOptional() @Matches(BSSID) wifiBssid?: string;
}

export class PunchDto {
  @IsIn(["IN", "OUT"]) type!: "IN" | "OUT";
  @IsDefined({ message: "location is required to punch" }) @ValidateNested() @Type(() => PunchLocationDto) location!: PunchLocationDto;
  @IsOptional() @IsIn(["WEB", "MOBILE"]) source?: "WEB" | "MOBILE";
  @IsOptional() @IsString() @MaxLength(120) deviceId?: string;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  /** Client-generated key so a retried request (flaky mobile network) never records two punches. */
  @IsOptional() @Matches(/^[A-Za-z0-9_-]{8,80}$/) idempotencyKey?: string;
  @IsOptional() @ValidateNested() @Type(() => SelfieDto) selfie?: SelfieDto;
  @IsOptional() @ValidateNested() @Type(() => FaceCheckDto) faceCheck?: FaceCheckDto;
  @IsOptional() @ValidateNested() @Type(() => DeviceProofDto) device?: DeviceProofDto;
  /** MAC (BSSID) of the Wi-Fi access point the phone is connected to; mobile app only. */
  @IsOptional() @Matches(BSSID) wifiBssid?: string;
}

export class PolicyDto {
  @IsIn(["OFF", "OUTSIDE_GEOFENCE", "ALWAYS"]) selfieMode!: "OFF" | "OUTSIDE_GEOFENCE" | "ALWAYS";
  @IsBoolean() livenessRequired!: boolean;
  @Type(() => Number) @IsInt() @Min(7) @Max(730) selfieRetentionDays!: number;
  @IsArray() @ArrayMaxSize(5) @IsIn(["EMPLOYEE", "MANAGER", "HR_ADMIN", "OWNER", "PAYROLL_ADMIN"], { each: true }) exemptRoles!: string[];
  @IsOptional() @IsIn(["OFF", "FLAG", "BLOCK"]) deviceBinding?: "OFF" | "FLAG" | "BLOCK";
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3) maxDevices?: number;
  @IsOptional() @IsIn(["FIRST_AUTO", "ALWAYS_HR"]) deviceApproval?: "FIRST_AUTO" | "ALWAYS_HR";
  @IsOptional() @IsIn(["OFF", "FLAG", "BLOCK"]) officeNetwork?: "OFF" | "FLAG" | "BLOCK";
  @IsOptional() @IsIn(["OFF", "FLAG", "BLOCK"]) routerMac?: "OFF" | "FLAG" | "BLOCK";
  @Type(() => Number) @IsInt() @Min(0) version!: number;
}

export class DeviceQuery {
  @IsOptional() @IsIn(["ACTIVE", "PENDING", "REVOKED"]) status?: string;
}

export class DeviceDecisionDto {
  @IsIn(["APPROVE", "REJECT", "REVOKE"]) decision!: "APPROVE" | "REJECT" | "REVOKE";
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class NetworkEntryDto {
  @IsIn(["IP_RANGE", "WIFI_BSSID"]) kind!: "IP_RANGE" | "WIFI_BSSID";
  @IsString() @MaxLength(64) value!: string;
  @IsOptional() @IsString() @MaxLength(80) label?: string;
  @IsOptional() @IsUUID() siteId?: string;
}

export class NetworksDto {
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => NetworkEntryDto) items!: NetworkEntryDto[];
}

export class ReviewQuery {
  @IsOptional() @IsIn(["PENDING", "APPROVED", "REJECTED"]) status?: "PENDING" | "APPROVED" | "REJECTED";
}

export class ReviewDecisionDto {
  @IsIn(["APPROVED", "REJECTED"]) decision!: "APPROVED" | "REJECTED";
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class HistoryQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
}

export class SiteDto {
  @IsString() @MaxLength(120) name!: string;
  @Type(() => Number) @IsNumber() @Min(-90) @Max(90) latitude!: number;
  @Type(() => Number) @IsNumber() @Min(-180) @Max(180) longitude!: number;
  @Type(() => Number) @IsInt() @Min(25) @Max(5000) radiusMetres!: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) version?: number;
}

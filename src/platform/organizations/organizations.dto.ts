import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateBy, ValidateNested } from "class-validator";

export const MODULE_KEYS = ["core", "attendance", "leave", "roster", "payroll", "expenses", "travel", "helpdesk", "letters", "assets", "exit",
  "learning", "performance", "recruitment", "onboarding", "engagement", "recognition", "reports", "integrations"] as const;
export const INDIAN_STATES = ["KA", "MH", "TN", "TS", "AP", "WB", "GJ", "DL", "HR", "KL", "UP", "RJ", "PB", "GA", "OTHER"] as const;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Raster logo data URL only (no SVG: it can carry script). */
export const LOGO_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const LOGO_MAGIC: Record<string, (bytes: Buffer) => boolean> = {
  png: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};
/** The declared image type must match the file's signature, so an SVG/HTML payload can't be smuggled under image/png. */
export const isRasterLogo = (value: unknown) => {
  if (typeof value !== "string") return false;
  const match = LOGO_DATA_URL.exec(value);
  if (!match) return false;
  return LOGO_MAGIC[match[1]](Buffer.from(value.slice(value.indexOf(",") + 1, value.indexOf(",") + 1 + 64), "base64"));
};
const IsRasterLogo = () => ValidateBy({ name: "isRasterLogo", validator: { validate: isRasterLogo, defaultMessage: () => "logoDataUrl must be a PNG, JPEG or WebP image (SVG is not allowed)." } });

/** Branding fields shared by create and update (display name and prefix differ in optionality). */
class BrandingFieldsDto {
  @IsOptional() @IsString() @MaxLength(160) legalName?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(24) shortName?: string;
  @IsOptional() @Matches(HEX) brandColor?: string;
  @IsOptional() @Matches(HEX) accentColor?: string;
  /** Small logo as a data URL (PNG/JPEG/WebP only, < ~150 KB). null removes it. */
  @IsOptional() @IsString() @MaxLength(200000) @IsRasterLogo() logoDataUrl?: string | null;
  @IsOptional() @IsString() @MaxLength(60) industry?: string;
  @IsOptional() @IsIn(INDIAN_STATES) defaultState?: string;
  @IsOptional() @IsString() @MaxLength(40) timezone?: string;
}
export class BrandingDto extends BrandingFieldsDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) displayName?: string;
  @IsOptional() @Matches(/^[A-Z]{2,6}$/) employeePrefix?: string;
}
export class UpdateBrandingDto extends BrandingDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}

export class FirstAdminDto {
  @IsString() @MinLength(2) @MaxLength(120) fullName!: string;
  @IsEmail() @MaxLength(200) workEmail!: string;
  @IsOptional() @IsString() @MaxLength(80) designation?: string;
}

export class CreateOrganizationDto extends BrandingFieldsDto {
  @IsString() @MinLength(2) @MaxLength(80) displayName!: string;
  @Matches(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/) slug!: string;
  @Matches(/^[A-Z]{2,6}$/) employeePrefix!: string;
  @IsOptional() @IsUUID() groupId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(MODULE_KEYS.length) @IsIn(MODULE_KEYS, { each: true }) enabledModules?: string[];
  @ValidateNested() @Type(() => FirstAdminDto) admin!: FirstAdminDto;
  /** Also make the platform admin creating the brand an OWNER of it (so it appears in their brand switcher). */
  @IsOptional() @IsBoolean() addMeAsOwner?: boolean;
}

export class PlatformUpdateOrganizationDto extends BrandingDto {
  @IsOptional() @IsIn(["ACTIVE", "SUSPENDED"]) status?: "ACTIVE" | "SUSPENDED";
  @IsOptional() @IsArray() @ArrayMaxSize(MODULE_KEYS.length) @IsIn(MODULE_KEYS, { each: true }) enabledModules?: string[];
  @IsOptional() @IsUUID() groupId?: string;
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}

export class AddAdminDto {
  @IsString() @MinLength(2) @MaxLength(120) fullName!: string;
  @IsEmail() @MaxLength(200) workEmail!: string;
  @IsOptional() @IsString() @MaxLength(80) designation?: string;
  @IsIn(["HR_ADMIN", "OWNER", "PAYROLL_ADMIN"]) role!: "HR_ADMIN" | "OWNER" | "PAYROLL_ADMIN";
}

export class DemoIdentitiesQuery {
  @IsOptional() @Matches(/^[a-z0-9-]{2,40}$/) slug?: string;
}

export class CreateGroupDto {
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @Matches(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/) slug!: string;
}

export class GroupQuery {
  @IsOptional() @IsUUID() groupId?: string;
}

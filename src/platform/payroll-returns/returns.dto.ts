import { Type } from "class-transformer";
import { IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from "class-validator";

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

export class FyQuery {
  @Type(() => Number) @IsInt() @Min(2020) @Max(2100) fy!: number;
  @IsOptional() @IsIn(QUARTERS) quarter?: "Q1" | "Q2" | "Q3" | "Q4";
}

export class AddressDto {
  @IsOptional() @IsString() @MaxLength(25) line1?: string;
  @IsOptional() @IsString() @MaxLength(25) line2?: string;
  @IsOptional() @IsString() @MaxLength(25) line3?: string;
  @IsOptional() @IsString() @MaxLength(25) line4?: string;
  @IsOptional() @IsString() @MaxLength(25) line5?: string;
  @IsOptional() @Matches(/^[0-9]{2}$/, { message: "State code is the 2-digit Protean code (e.g. 15 Karnataka)." }) stateCode?: string;
  @IsOptional() @Matches(/^[1-9][0-9]{5}$/, { message: "PIN code must be 6 digits." }) pincode?: string;
}

export class ResponsibleDto {
  @IsOptional() @IsString() @MaxLength(75) name?: string;
  @IsOptional() @IsString() @MaxLength(20) designation?: string;
  @IsOptional() @IsEmail() @MaxLength(75) email?: string;
  @IsOptional() @Matches(/^[0-9]{6,10}$/) phone?: string;
  @IsOptional() @ValidateNested() @Type(() => AddressDto) address?: AddressDto;
  /** Full PAN of the person responsible (stored encrypted). Omit to keep the stored one. */
  @IsOptional() @Matches(/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/, { message: "PAN must look like ABCDE1234F." }) pan?: string;
}

export class DeductorDto {
  @IsOptional() @Matches(/^[A-Za-z]{4}[0-9]{5}[A-Za-z]$/, { message: "TAN must look like ABCD12345E." }) tan?: string;
  @IsOptional() @Matches(/^([A-Za-z]{5}[0-9]{4}[A-Za-z]|PANNOTREQD)$/, { message: "Deductor PAN must look like ABCDE1234F." }) pan?: string;
  @IsOptional() @IsString() @MaxLength(75) name?: string;
  @IsOptional() @Matches(/^[ASDEGHLNKMPTJBQF]$/) category?: string;
  @IsOptional() @Matches(/^[0-9]{2}[A-Za-z0-9]{13}$/) gstin?: string;
  @IsOptional() @IsEmail() @MaxLength(75) email?: string;
  @IsOptional() @Matches(/^[0-9]{6,10}$/) phone?: string;
  @IsOptional() @ValidateNested() @Type(() => AddressDto) address?: AddressDto;
  @IsOptional() @ValidateNested() @Type(() => ResponsibleDto) responsible?: ResponsibleDto;
  @IsInt() version!: number;
}

export class ChallanDto {
  @Matches(/^[0-9]{4}-(0[1-9]|1[0-2])$/, { message: "Month of deduction is YYYY-MM." }) period!: string;
  @Matches(/^[0-9]{7}$/, { message: "BSR code is 7 digits." }) bsrCode!: string;
  @Matches(/^[0-9]{1,5}$/, { message: "Challan serial number is up to 5 digits." }) challanSerial!: string;
  @IsDateString() depositDate!: string;
  @IsOptional() @IsIn(["C", "B"]) mode?: "C" | "B";
  @IsOptional() @IsIn(["200", "400"]) minorHead?: "200" | "400";
  @IsNumber() @Min(0) @Max(1e11) tax!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1e11) surcharge?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1e11) cess?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1e11) interest?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1e11) fee?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1e11) penalty?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class UpdateChallanDto extends ChallanDto { @IsInt() version!: number; }

export class QuarterFilingDto {
  @IsIn(["DRAFT", "FILED"]) status!: "DRAFT" | "FILED";
  @IsOptional() @Matches(/^[0-9]{15}$/, { message: "Token / receipt number is 15 digits." }) tokenNumber?: string;
  @IsOptional() @IsDateString() filedOn?: string;
  @IsOptional() @IsBoolean() filedExternally?: boolean;
}

export class GenerateDto { @IsOptional() @IsBoolean() restart?: boolean; }

export class PartAUploadDto {
  @IsString() @MaxLength(180) originalName!: string;
  @IsIn(["application/pdf"]) mimeType!: string;
  @IsString() @MaxLength(12_000_000) base64!: string;
}

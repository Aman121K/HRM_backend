import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { PT_STATES } from "./statutory";

const STATE_CODES = Object.keys(PT_STATES);
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export class TemplateDto {
  @IsOptional() @IsNumber() @Min(0.3) @Max(0.8) basicPct?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(0.5) hraPct?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100000) conveyance?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(500000) otherAllowance?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(0.4) variablePct?: number;
  @IsOptional() @IsBoolean() includeGratuity?: boolean;
}

export class PreviewStructureDto {
  @IsOptional() @IsUUID() employeeId?: string;
  /** Date whose statutory rules apply (the structure's effective-from); defaults to today. */
  @IsOptional() @Matches(DATE, { message: "effectiveFrom must be a YYYY-MM-DD date" }) effectiveFrom?: string;
  @Type(() => Number) @IsNumber() @Min(10000) @Max(1_000_000_000) annualCtc!: number;
  @IsOptional() @IsBoolean() isMetro?: boolean;
  @IsOptional() @IsBoolean() pfApplicable?: boolean;
  @IsOptional() @IsIn(["NEW", "OLD"]) taxRegime?: "NEW" | "OLD";
  @IsOptional() @IsIn(STATE_CODES) stateCode?: string;
  @IsOptional() @ValidateNested() @Type(() => TemplateDto) template?: TemplateDto;
}

export class CreateStructureDto {
  @IsUUID() employeeId!: string;
  @Type(() => Number) @IsNumber() @Min(10000) @Max(1_000_000_000) annualCtc!: number;
  @IsOptional() @IsBoolean() isMetro?: boolean;
  @IsOptional() @ValidateNested() @Type(() => TemplateDto) template?: TemplateDto;
  @Matches(DATE, { message: "effectiveFrom must be a YYYY-MM-DD date" }) effectiveFrom!: string;
  @IsOptional() @IsIn(["JOINING", "REVISION", "PROMOTION", "CORRECTION"]) reason?: "JOINING" | "REVISION" | "PROMOTION" | "CORRECTION";
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class DeclarationsDto {
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) section80C?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) section80D?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100_000_000) rentPaidAnnual?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) homeLoanInterest?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) otherIncome?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) previousEmployerSalary?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) previousEmployerTds?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) previousEmployerPf?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100_000) previousEmployerPt?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) section80DParents?: number;
  @IsOptional() @IsBoolean() parentsSenior?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) nps80CCD1B?: number;
  /** Rented accommodation in Delhi/Mumbai/Kolkata/Chennai (50% HRA exemption limit) — defaults to the work location. */
  @IsOptional() @IsBoolean() rentedInMetro?: boolean;
  @IsOptional() @IsIn(["BELOW_60", "SENIOR", "SUPER_SENIOR"]) ageCategory?: "BELOW_60" | "SENIOR" | "SUPER_SENIOR";
}

/** payroll_profiles.statutory_flags — every field optional; omitted fields keep their stored value. */
export class StatutoryFlagsDto {
  /** false = not an EPS member (joined above the wage ceiling after 1 Sep 2014, or past 58): full 12% employer share to EPF. */
  @IsOptional() @IsBoolean() epsEligible?: boolean;
  /** Person with disability: ESI coverage threshold ₹25,000 instead of ₹21,000. */
  @IsOptional() @IsBoolean() disabled?: boolean;
  /** Voluntary PF as a fraction of PF wages (0.05 = 5%), up to 0.88. */
  @IsOptional() @IsNumber() @Min(0) @Max(0.88) vpfRate?: number;
  /** International worker: PF on full wages (no ceiling). */
  @IsOptional() @IsBoolean() internationalWorker?: boolean;
  @IsOptional() @IsIn(["BELOW_60", "SENIOR", "SUPER_SENIOR"]) ageCategory?: "BELOW_60" | "SENIOR" | "SUPER_SENIOR";
}

export class UpdateProfileDto {
  @IsOptional() @IsIn(STATE_CODES) stateCode?: string | null;
  @IsOptional() @IsIn(["NEW", "OLD"]) taxRegime?: "NEW" | "OLD";
  @IsOptional() @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/, { message: "PAN must look like ABCDE1234F" }) pan?: string | null;
  @IsOptional() @Matches(/^[0-9]{12}$/, { message: "UAN must be 12 digits" }) uan?: string | null;
  @IsOptional() @Matches(/^[0-9]{10,17}$/, { message: "ESI IP number must be 10–17 digits" }) esiNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(80) bankName?: string | null;
  @IsOptional() @Matches(/^[0-9]{6,20}$/, { message: "Bank account must be 6–20 digits" }) bankAccount?: string | null;
  @IsOptional() @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, { message: "IFSC must look like HDFC0001234" }) ifsc?: string | null;
  @IsOptional() @IsBoolean() pfApplicable?: boolean;
  @IsOptional() @IsIn(["STANDARD", "WOMAN", "EXEMPT"]) ptCategory?: "STANDARD" | "WOMAN" | "EXEMPT";
  @IsOptional() @ValidateNested() @Type(() => DeclarationsDto) declarations?: DeclarationsDto;
  @IsOptional() @ValidateNested() @Type(() => StatutoryFlagsDto) statutoryFlags?: StatutoryFlagsDto;
  @Type(() => Number) @IsInt() @Min(0) version!: number;
}

export class RevealDto {
  @IsIn(["pan", "uan", "esiNumber", "bankAccount"]) field!: "pan" | "uan" | "esiNumber" | "bankAccount";
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

export class UpdateSettingsDto {
  @IsIn(["CEILING", "ACTUAL"]) pfWageMode!: "CEILING" | "ACTUAL";
  @IsIn(STATE_CODES) defaultState!: string;
  @IsBoolean() includeExpenses!: boolean;
  @IsOptional() @IsString() @MaxLength(30) pfEstablishmentCode?: string | null;
  @IsOptional() @IsString() @MaxLength(30) esiEmployerCode?: string | null;
  @IsOptional() @Matches(/^[0-9]{6,20}$/) debitAccount?: string | null;
  /** Labour Code 50% wage rule for PF wages: AUTO (from the Codes' commencement), ON, OFF. */
  @IsOptional() @IsIn(["AUTO", "ON", "OFF"]) labourCodeWages?: "AUTO" | "ON" | "OFF";
  /** Deduct Labour Welfare Fund (enable once LWF registration / rates are confirmed). */
  @IsOptional() @IsBoolean() lwfEnabled?: boolean;
  /** Monthly minimum wage floor (Basic + DA) for the establishment's State / skill; null = not configured. */
  @IsOptional() @IsNumber() @Min(1000) @Max(1_000_000) minimumWageMonthly?: number | null;
  @Type(() => Number) @IsInt() @Min(0) version!: number;
}

export class CreateRunDto {
  @Matches(PERIOD, { message: "period must be YYYY-MM" }) period!: string;
  @IsOptional() @Matches(DATE) payDate?: string;
  @IsOptional() @IsBoolean() includeExpenses?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class RunVersionDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}

export const RUN_ACTIONS = ["submit", "approve", "reject", "reopen", "publish", "lock", "cancel"] as const;
export class RunTransitionDto {
  @IsIn(RUN_ACTIONS as unknown as string[]) action!: (typeof RUN_ACTIONS)[number];
  @Type(() => Number) @IsInt() @Min(1) version!: number;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export const INPUT_CODES: Record<string, { kind: "EARNING" | "DEDUCTION" | "REIMBURSEMENT" | "LOP"; label: string; taxable: boolean; esiWage: boolean }> = {
  BONUS: { kind: "EARNING", label: "Bonus", taxable: true, esiWage: false },
  VARIABLE_PAY: { kind: "EARNING", label: "Variable pay", taxable: true, esiWage: false },
  INCENTIVE: { kind: "EARNING", label: "Incentive", taxable: true, esiWage: true },
  ARREARS: { kind: "EARNING", label: "Salary arrears", taxable: true, esiWage: true },
  OVERTIME: { kind: "EARNING", label: "Overtime", taxable: true, esiWage: true },
  OTHER_EARNING: { kind: "EARNING", label: "Other earning", taxable: true, esiWage: true },
  REIMBURSEMENT: { kind: "REIMBURSEMENT", label: "Reimbursement", taxable: false, esiWage: false },
  RECOVERY: { kind: "DEDUCTION", label: "Recovery", taxable: false, esiWage: false },
  LOAN_EMI: { kind: "DEDUCTION", label: "Loan / advance EMI", taxable: false, esiWage: false },
  OTHER_DEDUCTION: { kind: "DEDUCTION", label: "Other deduction", taxable: false, esiWage: false },
  LOP_DAYS: { kind: "LOP", label: "Loss of pay (manual)", taxable: false, esiWage: false },
};

export class RunInputDto {
  @IsUUID() employeeId!: string;
  @IsIn(Object.keys(INPUT_CODES)) code!: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) label?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(100_000_000) amount?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.5) @Max(31) days?: number;
  @IsOptional() @IsBoolean() taxable?: boolean;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class HoldDto {
  @IsBoolean() hold!: boolean;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class SearchQuery {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
}

export class EmployeeQuery {
  @IsOptional() @IsUUID() employeeId?: string;
}

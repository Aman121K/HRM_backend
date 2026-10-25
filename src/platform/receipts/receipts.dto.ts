import { IsIn, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

export const RECEIPT_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;

export class ScanReceiptDto {
  @IsString() @MinLength(1) @MaxLength(180) originalName!: string;
  @IsIn(RECEIPT_MIME_TYPES as unknown as string[]) mimeType!: (typeof RECEIPT_MIME_TYPES)[number];
  /** Raw base64 or a data: URL; 8 MB decoded maximum (enforced by FilesService). */
  @IsString() @MinLength(8) @MaxLength(12_000_000) base64!: string;
}

export class AttachReceiptDto {
  @IsUUID() caseId!: string;
}

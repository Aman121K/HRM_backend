import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { FilesService } from "../files/files.service";
import { OcrProviders, type OcrResult } from "./ocr-providers";
import type { AttachReceiptDto, ScanReceiptDto } from "./receipts.dto";

const HR_ROLES = ["HR_ADMIN", "OWNER"];
const AMOUNT_TOLERANCE = 0.02;
const MAX_RECEIPT_AGE_DAYS = 60;

type DuplicateOf = { caseId: string; caseNumber: string; reason: string };
export type OcrFlag = { code: "AMOUNT_MISMATCH" | "DATE_MISMATCH" | "STALE_RECEIPT" | "DUPLICATE"; message: string };

/** Lower-case alphanumeric word tokens used to compare merchant names. */
function tokens(value: unknown) {
  return new Set(String(value || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((token) => token.length > 1 && !["pvt", "ltd", "the", "and", "private", "limited"].includes(token)));
}
/** Merchants are "similar" when one name contains the other or they share at least half their words. */
export function similarMerchant(a: unknown, b: unknown) {
  const left = String(a || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const right = String(b || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (left.length < 3 || right.length < 3) return false;
  if (left.includes(right) || right.includes(left)) return true;
  const x = tokens(a); const y = tokens(b);
  const shared = [...x].filter((token) => y.has(token)).length;
  return shared > 0 && shared / Math.min(x.size, y.size) >= 0.5;
}

/** Flags stored as details.ocrFlag when the scanned receipt disagrees with the claim (pure; unit-tested). */
export function compareWithClaim(ocr: { total?: number; date?: string }, claim: { amount: number | null; expenseDate: string | null }, today = new Date(), duplicate?: DuplicateOf | null): OcrFlag[] {
  const flags: OcrFlag[] = [];
  if (ocr.total !== undefined && ocr.total > 0 && claim.amount !== null && Math.abs(claim.amount - ocr.total) / ocr.total > AMOUNT_TOLERANCE)
    flags.push({ code: "AMOUNT_MISMATCH", message: `Claimed ₹${claim.amount.toFixed(2)} but the receipt total is ₹${ocr.total.toFixed(2)}.` });
  if (ocr.date && claim.expenseDate && ocr.date !== claim.expenseDate)
    flags.push({ code: "DATE_MISMATCH", message: `Expense date ${claim.expenseDate} differs from the receipt date ${ocr.date}.` });
  if (ocr.date && (Date.parse(today.toISOString().slice(0, 10)) - Date.parse(ocr.date)) / 86_400_000 > MAX_RECEIPT_AGE_DAYS)
    flags.push({ code: "STALE_RECEIPT", message: `The receipt is more than ${MAX_RECEIPT_AGE_DAYS} days old (${ocr.date}).` });
  if (duplicate) flags.push({ code: "DUPLICATE", message: duplicate.reason });
  return flags;
}

@Injectable()
export class ReceiptsService implements OnModuleInit {
  private readonly logger = new Logger("Receipts");
  /** Scan ids being created right now → uploader, so the file policy lets the upload through before the row exists. */
  private readonly pending = new Map<string, string>();

  constructor(private readonly database: DatabaseService, private readonly files: FilesService, private readonly ocr: OcrProviders) {}

  private isHr(identity: AuthIdentity) { return identity.roles.some((role) => HR_ROLES.includes(role)); }

  onModuleInit() {
    // Receipt images: the uploader may read (and, until attached, change) them; HR may read them.
    this.files.registerPolicy("receipt_scan", async (identity, entityId, client) => {
      const row = (await client.query(`SELECT employee_id, status FROM receipt_scans WHERE organization_id=$1 AND id=$2`, [identity.organizationId, entityId])).rows[0];
      if (!row) return this.pending.get(entityId) === identity.employeeId ? "write" : null;
      if (row.employee_id === identity.employeeId) return row.status === "SCANNED" ? "write" : "read";
      return this.isHr(identity) ? "read" : null;
    });
  }

  async scan(identity: AuthIdentity, input: ScanReceiptDto) {
    if (!identity.employeeId) throw new ForbiddenException("Receipt scanning is available to employees only.");
    const bytes = Buffer.from(String(input.base64 || "").replace(/^data:[^;]+;base64,/, ""), "base64");
    const mimeType = input.mimeType.toLowerCase();
    const scanId = randomUUID();
    this.pending.set(scanId, identity.employeeId);
    try {
      return await this.scanAs(identity, input, scanId, bytes, mimeType);
    } finally {
      this.pending.delete(scanId);
    }
  }

  private async scanAs(identity: AuthIdentity, input: ScanReceiptDto, scanId: string, bytes: Buffer, mimeType: string) {
    // FilesService validates type, magic bytes and size, stores the bytes and audits FILE_UPLOADED.
    const file = await this.files.upload(identity, { entityType: "receipt_scan", entityId: scanId, category: "RECEIPT", originalName: input.originalName, mimeType, base64: input.base64 });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let result: OcrResult;
    const started = Date.now();
    try {
      result = await this.ocr.scan(bytes, mimeType);
    } catch (error) {
      // Keep the upload usable: the employee can still attach it and type the values in.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(JSON.stringify({ event: "ocr_failed", scanId, reason: reason.slice(0, 300) }));
      result = { provider: mimeType === "application/pdf" ? "pdf-text" : "tesseract", confidence: 0, fields: {}, lines: [], rawText: null,
        warnings: [`The receipt couldn't be read automatically: ${reason}`] };
    }
    return this.database.tenantTransaction(identity, async (client) => {
      const duplicateOf = await this.findDuplicate(client, identity, scanId, sha256, result);
      const warnings = [...result.warnings];
      if (duplicateOf) warnings.unshift(duplicateOf.reason);
      else if (await this.scannedBefore(client, identity, scanId, sha256)) warnings.unshift("You scanned this same receipt before.");
      await client.query(
        `INSERT INTO receipt_scans(id,organization_id,employee_id,file_id,sha256,mime_type,provider,confidence,fields,lines,warnings,duplicate_of,raw_text)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [scanId, identity.organizationId, identity.employeeId, file.id, sha256, mimeType, result.provider, result.confidence,
          JSON.stringify(result.fields), JSON.stringify(result.lines), JSON.stringify(warnings), duplicateOf ? JSON.stringify(duplicateOf) : null, result.rawText?.slice(0, 20_000) ?? null]);
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'RECEIPT_SCANNED','receipt_scan',$3,$4)`,
        [identity.organizationId, identity.userId, scanId, JSON.stringify({ fileId: file.id, provider: result.provider, confidence: result.confidence, fields: result.fields, duplicateOf, ms: Date.now() - started })]);
      return this.present({ id: scanId, file_id: file.id, provider: result.provider, confidence: result.confidence, fields: result.fields, lines: result.lines, warnings, duplicate_of: duplicateOf });
    });
  }

  get(identity: AuthIdentity, scanId: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = await this.load(client, identity, scanId);
      return { ...this.present(row), status: row.status, attachedCaseId: row.attached_case_id, createdAt: row.created_at };
    });
  }

  attach(identity: AuthIdentity, scanId: string, input: AttachReceiptDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const scan = await this.load(client, identity, scanId, true);
      if (scan.employee_id !== identity.employeeId) throw new ForbiddenException("Only the person who scanned this receipt can attach it.");
      if (scan.status === "ATTACHED") throw new ConflictException("This receipt is already attached to a claim.");
      const claim = (await client.query(
        `SELECT id, case_number, module, requester_id, amount, to_char(start_date,'YYYY-MM-DD') AS expense_date, closed_at, details
           FROM hr_cases WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [org, input.caseId])).rows[0];
      if (!claim || (claim.requester_id !== identity.employeeId && !this.isHr(identity))) throw new NotFoundException("Expense claim not found.");
      if (claim.module !== "expenses") throw new BadRequestException("Receipts can only be attached to expense claims.");
      if (claim.requester_id !== identity.employeeId) throw new ForbiddenException("Only the person who raised the claim can attach receipts.");
      if (claim.closed_at) throw new ConflictException(`${claim.case_number} is closed; receipts can no longer be attached.`);
      const moved = await client.query(
        `UPDATE stored_files SET entity_type='hr_case', entity_id=$3, category='RECEIPT' WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id`,
        [org, scan.file_id, claim.id]);
      if (!moved.rowCount) throw new ConflictException("The scanned file was removed; please scan the receipt again.");
      const fields = scan.fields as { merchant?: string; date?: string; total?: number };
      const flags = compareWithClaim(fields, { amount: claim.amount === null ? null : Number(claim.amount), expenseDate: claim.expense_date }, new Date(), scan.duplicate_of);
      const ocr = { merchant: fields.merchant ?? null, date: fields.date ?? null, total: fields.total ?? null, confidence: Number(scan.confidence), provider: scan.provider, scanId };
      const ocrFlag = flags.length ? { reasons: flags, flaggedAt: new Date().toISOString() } : null;
      // The case engine owns hr_cases; we only merge our keys into details (no version bump: nothing the user edited changed).
      await client.query(
        `UPDATE hr_cases SET details = (details - 'ocrFlag') || jsonb_build_object('ocr', $3::jsonb) || CASE WHEN $4::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('ocrFlag', $4::jsonb) END,
                updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [org, claim.id, JSON.stringify(ocr), ocrFlag ? JSON.stringify(ocrFlag) : null]);
      await client.query(`UPDATE receipt_scans SET status='ATTACHED', attached_case_id=$3, attached_at=now() WHERE organization_id=$1 AND id=$2`, [org, scanId, claim.id]);
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,'RECEIPT_ATTACHED','hr_case',$3,$4,$5)`,
        [org, identity.userId, claim.id, JSON.stringify({ fileEntity: { type: "receipt_scan", id: scanId }, ocr: claim.details?.ocr ?? null, ocrFlag: claim.details?.ocrFlag ?? null }),
          JSON.stringify({ fileId: scan.file_id, scanId, ocr, ocrFlag })]);
      return { attached: true, caseId: claim.id, caseNumber: claim.case_number, fileId: scan.file_id, flags };
    });
  }

  private async load(client: PoolClient, identity: AuthIdentity, scanId: string, lock = false) {
    const row = (await client.query(`SELECT * FROM receipt_scans WHERE organization_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`, [identity.organizationId, scanId])).rows[0];
    if (!row || (row.employee_id !== identity.employeeId && !this.isHr(identity))) throw new NotFoundException("Receipt scan not found.");
    return row;
  }

  /**
   * duplicateOf: (1) the same bytes already attached to / uploaded on an expense claim by anyone in the organization;
   * (2) the same requester already claimed the same total on the same date at a similar merchant.
   */
  private async findDuplicate(client: PoolClient, identity: AuthIdentity, scanId: string, sha256: string, result: OcrResult): Promise<DuplicateOf | null> {
    const org = identity.organizationId;
    const sameFile = (await client.query(
      `SELECT c.id, c.case_number, c.requester_id FROM stored_files f JOIN hr_cases c ON c.organization_id=f.organization_id AND c.id=f.entity_id
        WHERE f.organization_id=$1 AND f.sha256=$2 AND f.entity_type='hr_case' AND f.deleted_at IS NULL AND c.module='expenses'
          AND c.status NOT IN ('WITHDRAWN','REJECTED') ORDER BY f.created_at LIMIT 1`, [org, sha256])).rows[0];
    if (sameFile)
      return { caseId: sameFile.id, caseNumber: sameFile.case_number,
        reason: sameFile.requester_id === identity.employeeId ? `This exact receipt is already attached to your claim ${sameFile.case_number}.` : `This exact receipt was already submitted on claim ${sameFile.case_number} by a colleague.` };
    const { total, date, merchant } = result.fields;
    if (total === undefined || !date || !merchant) return null;
    const candidates = (await client.query(
      `SELECT id, case_number, title, details FROM hr_cases WHERE organization_id=$1 AND module='expenses' AND requester_id=$2 AND amount=$3 AND start_date=$4
          AND status NOT IN ('WITHDRAWN','REJECTED') ORDER BY created_at DESC LIMIT 20`, [org, identity.employeeId, total, date])).rows;
    const match = candidates.find((row) => [row.details?.merchant, row.details?.ocr?.merchant, row.title].some((name) => similarMerchant(name, merchant)));
    return match ? { caseId: match.id, caseNumber: match.case_number, reason: `You already claimed ₹${total} at ${merchant} on ${date} (${match.case_number}).` } : null;
  }

  private async scannedBefore(client: PoolClient, identity: AuthIdentity, scanId: string, sha256: string) {
    return !!(await client.query(`SELECT 1 FROM receipt_scans WHERE organization_id=$1 AND sha256=$2 AND id<>$3 AND employee_id=$4 LIMIT 1`,
      [identity.organizationId, sha256, scanId, identity.employeeId])).rowCount;
  }

  private present(row: { id: string; file_id: string; provider: string; confidence: number | string; fields: unknown; lines: unknown; warnings: unknown; duplicate_of: DuplicateOf | null }) {
    const lines = row.lines as unknown[];
    return {
      scanId: row.id, fileId: row.file_id, provider: row.provider, confidence: Number(row.confidence), fields: row.fields,
      ...(lines?.length ? { lines } : {}), warnings: row.warnings as string[], ...(row.duplicate_of ? { duplicateOf: row.duplicate_of } : {}),
    };
  }
}

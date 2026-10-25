import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { FilesService } from "../files/files.service";
// Read-only use of the payroll tax engine (owned by payroll/); this module never changes it.
import { calculateTax, normalize, TAX_RULES, type Regime } from "../payroll/tax-engine";
import type { CalculateTaxDto, ReviewDeclarationDto, SaveDeclarationDto, SubmitDeclarationDto, UpdateDeclarationDto, UploadProofDto, WithdrawDeclarationDto } from "./tax.dto";

export const TAX_ENTITY = "tax_declaration";
/** Who may review declarations and read proofs. They can never decide their own declaration. */
export const TAX_REVIEW_ROLES = ["PAYROLL_ADMIN", "HR_ADMIN", "OWNER"];
const MUTABLE = ["DRAFT", "CLARIFICATION"];
const PROOF_STATUSES = ["MISSING", "UPLOADED", "VERIFIED", "REJECTED"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES = [
  "https://www.incometax.gov.in/iec/foportal/help/all-topics/e-filing-services/file-itr-2-online",
  "https://www.incometax.gov.in/iec/foportal/help/individual/return-applicable-1",
  "https://www.incometax.gov.in/iec/foportal/help/all-topics/e-filing-services/objective-and-scope-new-act",
];

const SELECT = `SELECT d.*, e.full_name AS employee_name, e.employee_number, r.full_name AS reviewer_name
  FROM tax_declarations d JOIN employees e ON e.id=d.employee_id AND e.organization_id=d.organization_id
  LEFT JOIN employees r ON r.id=d.reviewed_by AND r.organization_id=d.organization_id`;

/** Months left in the Indian financial year (April–March), including the current month. */
export function monthsLeftInFy(today = new Date()) {
  const month = today.getMonth();
  return month >= 3 ? 15 - month : 3 - month;
}

const text = (value: unknown, max: number) => String(value ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

/** Whitelist each line item field; the browser decides nothing about the stored shape. */
export function sanitizeItems(raw: Record<string, unknown>[] = []) {
  return raw.map((item) => {
    const amount = Number(item.amount);
    const details: Record<string, string | boolean> = {};
    if (item.details && typeof item.details === "object" && !Array.isArray(item.details))
      for (const [key, value] of Object.entries(item.details as Record<string, unknown>).slice(0, 20))
        if (/^[A-Za-z0-9_]{1,40}$/.test(key)) details[key] = typeof value === "boolean" ? value : text(value, 200);
    return {
      id: /^[A-Za-z0-9-]{1,64}$/.test(String(item.id)) ? String(item.id) : randomUUID(),
      category: text(item.category, 60) || "Other",
      instrument: text(item.instrument, 120), provider: text(item.provider, 120), reference: text(item.reference, 120),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || "")) ? String(item.date) : "",
      amount: Number.isFinite(amount) ? Math.min(Math.max(0, Math.round(amount)), 1_000_000_000) : 0,
      proofStatus: PROOF_STATUSES.includes(String(item.proofStatus)) ? String(item.proofStatus) : "MISSING",
      remarks: text(item.remarks, 500), details,
    };
  });
}

/** Same scoring as the original workspace: base 35, up to 48 for items, 17 for consent. */
export const completenessOf = (items: unknown[], consent: boolean) => Math.min(100, 35 + Math.min(items.length * 12, 48) + (consent ? 17 : 0));

@Injectable()
export class TaxService implements OnModuleInit {
  constructor(private readonly database: DatabaseService, private readonly files: FilesService) {}

  onModuleInit() {
    // Proofs: the declaring employee (write while the declaration is editable), payroll admins and HR (read only).
    this.files.registerPolicy(TAX_ENTITY, async (identity, id, client) => {
      const row = (await client.query(`SELECT employee_id, status FROM tax_declarations WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id])).rows[0];
      if (!row) return null;
      if (row.employee_id === identity.employeeId) return MUTABLE.includes(row.status) ? "write" : "read";
      return this.isReviewer(identity) && row.status !== "DRAFT" ? "read" : null;
    });
  }

  isReviewer(identity: AuthIdentity) { return identity.roles.some((role) => TAX_REVIEW_ROLES.includes(role)); }

  ruleSet() {
    return { ...TAX_RULES, sources: SOURCES, disclaimer: "Payroll-planning estimate only; not tax filing or tax advice." };
  }

  calculate(input: CalculateTaxDto) {
    const inputs = normalize((input.inputs || {}) as never);
    const regime: Regime = input.regime === "OLD" ? "OLD" : "NEW";
    return { inputs, result: this.result(inputs, regime), ruleSet: this.ruleSet() };
  }

  private result(inputs: ReturnType<typeof normalize>, regime: Regime) {
    const result = calculateTax(inputs, regime);
    return { ...result, monthsRemaining: monthsLeftInFy(), projectedMonthlyTds: Math.ceil(result.remainingTax / monthsLeftInFy()) };
  }

  listMine(identity: AuthIdentity) {
    this.requireEmployee(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const rows = (await client.query(`${SELECT} WHERE d.organization_id=$1 AND d.employee_id=$2 ORDER BY d.updated_at DESC, d.id`, [identity.organizationId, identity.employeeId])).rows;
      return { items: rows.map((row) => this.present(row)) };
    });
  }

  reviewQueue(identity: AuthIdentity) {
    if (!this.isReviewer(identity)) throw new ForbiddenException("Only payroll or HR can review tax declarations.");
    return this.database.tenantTransaction(identity, async (client) => {
      // Reviewers never see their own declaration in the queue (maker-checker).
      const rows = (await client.query(`${SELECT} WHERE d.organization_id=$1 AND d.status='SUBMITTED' AND d.employee_id<>$2 ORDER BY d.submitted_at, d.id`,
        [identity.organizationId, identity.employeeId || "00000000-0000-0000-0000-000000000000"])).rows;
      return { items: rows.map((row) => this.present(row)) };
    });
  }

  get(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => this.present(await this.readable(client, identity, id)));
  }

  create(identity: AuthIdentity, input: SaveDeclarationDto) {
    this.requireEmployee(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const open = (await client.query(`SELECT id, status FROM tax_declarations WHERE organization_id=$1 AND employee_id=$2 AND tax_year=$3 AND status = ANY($4)`,
        [identity.organizationId, identity.employeeId, TAX_RULES.taxYear, [...MUTABLE, "SUBMITTED"]])).rows[0];
      if (open) throw new ConflictException(`You already have a ${open.status.toLowerCase()} declaration for FY ${TAX_RULES.taxYear}. Open it instead of starting another.`);
      const items = sanitizeItems(input.items);
      const inputs = normalize(input.inputs as never);
      const consent = !!input.consent;
      const row = (await client.query(
        `INSERT INTO tax_declarations(organization_id,employee_id,tax_year,regime,status,items,inputs,calculation,rules_version,completeness,consent)
         VALUES($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$10) RETURNING id`,
        [identity.organizationId, identity.employeeId, TAX_RULES.taxYear, input.regime, JSON.stringify(items), JSON.stringify(inputs),
          JSON.stringify(this.result(inputs, input.regime)), TAX_RULES.version, completenessOf(items, consent), consent])).rows[0];
      await this.audit(client, identity, "TAX_DECLARATION_DRAFT_CREATED", row.id, null, { regime: input.regime, items: items.length });
      return this.present(await this.readable(client, identity, row.id));
    });
  }

  update(identity: AuthIdentity, id: string, input: UpdateDeclarationDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const before = await this.ownForUpdate(client, identity, id, input.version);
      if (!MUTABLE.includes(before.status)) throw new ConflictException("Submitted declarations are immutable. Ask Payroll for a clarification to change them.");
      const items = sanitizeItems(input.items);
      const inputs = normalize(input.inputs as never);
      const consent = !!input.consent;
      await client.query(
        `UPDATE tax_declarations SET regime=$3,items=$4,inputs=$5,calculation=$6,rules_version=$7,completeness=$8,consent=$9,version=version+1,updated_at=now()
          WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, id, input.regime, JSON.stringify(items), JSON.stringify(inputs), JSON.stringify(this.result(inputs, input.regime)),
          TAX_RULES.version, completenessOf(items, consent), consent]);
      await this.audit(client, identity, "TAX_DECLARATION_DRAFT_UPDATED", id, { regime: before.regime, items: before.items.length, version: before.version },
        { regime: input.regime, items: items.length, version: before.version + 1 });
      return this.present(await this.readable(client, identity, id));
    });
  }

  submit(identity: AuthIdentity, id: string, input: SubmitDeclarationDto) {
    if (!input.consent) throw new BadRequestException("Employee declaration and consent are required.");
    return this.database.tenantTransaction(identity, async (client) => {
      const before = await this.ownForUpdate(client, identity, id, input.version);
      if (!MUTABLE.includes(before.status)) throw new ConflictException("Only draft or clarification declarations can be submitted.");
      if (before.completeness < 60) throw new BadRequestException("Complete the required declaration details before submission.");
      const calculation = this.result(normalize(before.inputs), before.regime);
      await client.query(
        `UPDATE tax_declarations SET status='SUBMITTED',consent=true,calculation=$3,rules_version=$4,submitted_at=now(),version=version+1,updated_at=now()
          WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, id, JSON.stringify(calculation), TAX_RULES.version]);
      await this.audit(client, identity, "TAX_DECLARATION_SUBMITTED", id, { status: before.status }, { status: "SUBMITTED", rulesVersion: TAX_RULES.version });
      return this.present(await this.readable(client, identity, id));
    });
  }

  withdraw(identity: AuthIdentity, id: string, input: WithdrawDeclarationDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const before = await this.ownForUpdate(client, identity, id, input.version);
      if (before.status !== "SUBMITTED") throw new ConflictException("Only submitted declarations can be withdrawn.");
      await client.query(`UPDATE tax_declarations SET status='WITHDRAWN',version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id]);
      await this.audit(client, identity, "TAX_DECLARATION_WITHDRAWN", id, { status: before.status }, { status: "WITHDRAWN" });
      return this.present(await this.readable(client, identity, id));
    });
  }

  review(identity: AuthIdentity, id: string, input: ReviewDeclarationDto) {
    if (!this.isReviewer(identity)) throw new ForbiddenException("Only payroll or HR can review tax declarations.");
    const reason = (input.reason || "").trim();
    if (input.action !== "ACCEPT" && reason.length < 3) throw new BadRequestException("Add a reviewer reason before requesting clarification or rejecting a declaration.");
    return this.database.tenantTransaction(identity, async (client) => {
      const before = (await client.query(`SELECT * FROM tax_declarations WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [identity.organizationId, id])).rows[0];
      if (!before) throw new NotFoundException("Tax declaration not found.");
      if (before.employee_id === identity.employeeId) throw new ForbiddenException("You cannot review your own tax declaration.");
      if (input.version !== undefined && input.version !== before.version) throw new ConflictException("This declaration changed since you opened it. Refresh and try again.");
      if (before.status !== "SUBMITTED") throw new ConflictException("Only submitted declarations can be reviewed.");
      const status = input.action === "ACCEPT" ? "ACCEPTED" : input.action === "REJECT" ? "REJECTED" : "CLARIFICATION";
      await client.query(
        `UPDATE tax_declarations SET status=$3,reviewed_by=$4,reviewed_at=now(),review_action=$5,review_reason=$6,review_amounts=$7,version=version+1,updated_at=now()
          WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, id, status, identity.employeeId, input.action, reason || null, input.amounts ? JSON.stringify(input.amounts) : null]);
      await this.audit(client, identity, "TAX_DECLARATION_REVIEWED", id, { status: before.status, version: before.version },
        { status, action: input.action, reason: reason || null, amounts: input.amounts || null });
      const message = status === "ACCEPTED" ? "Payroll accepted your tax declaration"
        : status === "REJECTED" ? "Payroll rejected your tax declaration" : "Payroll needs clarification on your tax declaration";
      await client.query(`INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload) VALUES($1,$2,$3,$4,$5,$6)`,
        [identity.organizationId, before.employee_id, `TAX_DECLARATION_${status}`, TAX_ENTITY, id, JSON.stringify({ message, reason: reason || null, href: "/payroll/tax" })]);
      return this.present(await this.readable(client, identity, id));
    });
  }

  history(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      await this.readable(client, identity, id);
      const rows = (await client.query(
        `SELECT a.action, a.created_at AS "at", a.before_data AS "before", a.after_data AS "after", u.full_name AS "actor"
           FROM audit_log a LEFT JOIN users u ON u.id=a.actor_user_id
          WHERE a.organization_id=$1 AND a.entity_type=$2 AND a.entity_id=$3 ORDER BY a.id`,
        [identity.organizationId, TAX_ENTITY, id])).rows;
      return { items: rows };
    });
  }

  // ------------------------------------------------------------------ proofs (bytes via FilesService)

  async listProofs(identity: AuthIdentity, id: string) {
    const { status } = await this.get(identity, id);
    const files = (await this.files.list(identity, TAX_ENTITY, id)).items as { id: string; category: string; originalName: string; mimeType: string; byteSize: number; createdAt: string }[];
    const meta = await this.database.tenantTransaction(identity, async (client) => (await client.query(
      `SELECT file_id, item_id, category FROM tax_declaration_proofs WHERE organization_id=$1 AND declaration_id=$2`, [identity.organizationId, id])).rows);
    const byFile = new Map(meta.map((row) => [row.file_id, row]));
    const proofStatus = status === "ACCEPTED" ? "VERIFIED" : status === "REJECTED" ? "REJECTED" : status === "SUBMITTED" ? "UNDER_REVIEW" : "UPLOADED";
    return {
      items: files.slice().reverse().map((file) => ({
        id: file.id, category: byFile.get(file.id)?.category || file.category, itemId: byFile.get(file.id)?.item_id || null,
        originalName: file.originalName, mimeType: file.mimeType, byteSize: file.byteSize, status: proofStatus, createdAt: file.createdAt,
      })),
    };
  }

  async uploadProof(identity: AuthIdentity, id: string, input: UploadProofDto) {
    // FilesService checks type, magic bytes, size and the policy above (owner + editable declaration only).
    const file = await this.files.upload(identity, { entityType: TAX_ENTITY, entityId: id, category: "TAX_PROOF", originalName: input.originalName, mimeType: input.mimeType, base64: input.base64 });
    await this.database.tenantTransaction(identity, (client) => client.query(
      `INSERT INTO tax_declaration_proofs(file_id,organization_id,declaration_id,item_id,category) VALUES($1,$2,$3,$4,$5)`,
      [file.id, identity.organizationId, id, input.itemId || null, text(input.category, 60) || "Other"]));
    return this.listProofs(identity, id);
  }

  async removeProof(identity: AuthIdentity, id: string, fileId: string) {
    await this.assertProofOf(identity, id, fileId);
    return this.files.remove(identity, fileId);
  }

  async downloadProof(identity: AuthIdentity, id: string, fileId: string) {
    await this.assertProofOf(identity, id, fileId);
    return this.files.download(identity, fileId);
  }

  private assertProofOf(identity: AuthIdentity, id: string, fileId: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const linked = await client.query(`SELECT 1 FROM stored_files WHERE organization_id=$1 AND id=$2 AND entity_type=$3 AND entity_id=$4 AND deleted_at IS NULL`,
        [identity.organizationId, fileId, TAX_ENTITY, id]);
      if (!linked.rowCount) throw new NotFoundException("Proof not found.");
    });
  }

  // ------------------------------------------------------------------ helpers

  private requireEmployee(identity: AuthIdentity) {
    if (!identity.employeeId) throw new ForbiddenException("Tax declarations are available to employees only.");
  }

  /** The declaration if the viewer is its employee or a reviewer (non-draft); otherwise 404 (no existence leak). */
  private async readable(client: PoolClient, identity: AuthIdentity, id: string) {
    if (!UUID.test(id)) throw new NotFoundException("Tax declaration not found.");
    const row = (await client.query(`${SELECT} WHERE d.organization_id=$1 AND d.id=$2`, [identity.organizationId, id])).rows[0];
    // Reviewers see a declaration once it has been submitted at least once; drafts stay private to the employee.
    if (!row || (row.employee_id !== identity.employeeId && !(this.isReviewer(identity) && row.status !== "DRAFT"))) throw new NotFoundException("Tax declaration not found.");
    return row;
  }

  private async ownForUpdate(client: PoolClient, identity: AuthIdentity, id: string, version: number) {
    const row = (await client.query(`SELECT * FROM tax_declarations WHERE organization_id=$1 AND id=$2 AND employee_id=$3 FOR UPDATE`,
      [identity.organizationId, id, identity.employeeId])).rows[0];
    if (!row) throw new NotFoundException("Tax declaration not found.");
    if (row.version !== version) throw new ConflictException("This declaration changed in another session. Refresh and try again.");
    return row;
  }

  private present(row: Record<string, any>) {
    return {
      id: row.id, status: row.status, version: row.version, regime: row.regime, taxYear: row.tax_year, completeness: row.completeness,
      consent: row.consent, items: row.items || [], inputs: row.inputs || {}, calculation: row.calculation || {}, rulesVersion: row.rules_version,
      employeeId: row.employee_id, employeeNumber: row.employee_number, employeeName: row.employee_name,
      reviewAction: row.review_action, reviewReason: row.review_reason, reviewedAt: row.reviewed_at, reviewerName: row.reviewer_name || null,
      reviewAmounts: row.review_amounts || null,
      submitted_at: row.submitted_at, updated_at: row.updated_at, created_at: row.created_at,
    };
  }

  private audit(client: PoolClient, identity: AuthIdentity, action: string, id: string, before: unknown, after: unknown) {
    return client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [identity.organizationId, identity.userId, action, TAX_ENTITY, id, before === null ? null : JSON.stringify(before), JSON.stringify(after)]);
  }
}

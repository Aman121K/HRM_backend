import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { RuntimeConfig } from "../config/runtime-config";
import { DatabaseService } from "../database/database.service";
import { hmacHex, maskAccount, safeEqual, sha256 } from "./crypto";
import { BankResponseDto, CreateBatchDto } from "./integrations.dto";
import { ADAPTERS, payoutWebhookSecret, razorpayX, type ApiAdapter, type FileAdapter, type PayoutStatus } from "./payout-adapters";
import { BANK_FILE_ROLES, bankFileError as bankFileBlock, decryptProfileField } from "../payroll/payroll.shared";
import { audit, istDate, lastDayOfPeriod, paise, requireFinance, systemIdentity } from "./shared";
import { WebhooksService } from "./webhooks.service";

export const SYNC_JOB = "integrations.payouts.sync";
/** Inbound payout webhooks must carry a signed timestamp within this many seconds of now. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const PAYABLE_RUN_STATUSES = ["APPROVED", "PUBLISHED", "LOCKED"];
const RANK: Record<string, number> = { SKIPPED: -1, PENDING: 0, QUEUED: 1, PROCESSING: 2, PROCESSED: 3, FAILED: 3, REVERSED: 4 };
const TERMINAL = ["PROCESSED", "FAILED", "REVERSED", "SKIPPED"];
/**
 * Snapshot of a beneficiary's bank details at batch creation, compared again at release/file/submit time. Built from the
 * per-brand blind index (payroll_profiles.bank_account_hash), so the plaintext account number is never needed for it.
 */
const fingerprint = (org: string, accountHash: string, ifsc: string) => sha256(`${org}:${accountHash}:${ifsc}`);

// Segregation of duties (only PAYROLL_ADMIN/OWNER, approved run with an approver, never the run's preparer) is the shared
// payroll rule — payroll/payroll.shared.ts bankFileBlock — so the payroll bank file and payouts cannot drift apart.

type Source = "USER" | "SYNC" | "WEBHOOK" | "BANK_FILE" | "SYSTEM";

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);
  constructor(private readonly database: DatabaseService, private readonly webhooks: WebhooksService, private readonly config: RuntimeConfig) {}

  config_() {
    const secret = payoutWebhookSecret();
    return {
      adapters: Object.values(ADAPTERS).map((adapter) => ({ key: adapter.key, kind: adapter.kind, label: adapter.label, description: adapter.description, ...adapter.configured() })),
      statusWebhook: { path: "/api/v2/integrations/payouts/webhook", signatureHeader: "x-razorpay-signature",
        configured: secret.source === "env", detail: secret.source === "env" ? "PAYOUTS_WEBHOOK_SECRET configured" : secret.source === "dev-install" ? "Development: per-install secret in .data/secrets/payouts-webhook.key" : "PAYOUTS_WEBHOOK_SECRET not configured — the webhook is refused" },
      replayProtection: { timestampHeader: "x-payout-timestamp", toleranceSeconds: WEBHOOK_TOLERANCE_SECONDS,
        detail: "Signed timestamp (header, or the payload's created_at) must be within ±5 minutes; each event id / signature is processed once." },
      syncJob: { name: SYNC_JOB, every: "5 minutes" },
    };
  }

  runs(identity: AuthIdentity) {
    requireFinance(identity);
    return this.database.tenantTransaction(identity, async (client) => ({ items: (await client.query(
      `SELECT r.id, r.period, r.status, r.pay_date AS "payDate", r.totals, (r.status = ANY($2)) AS payable,
              b.id AS "batchId", b.status AS "batchStatus"
         FROM payroll_runs r LEFT JOIN payout_batches b ON b.run_id=r.id AND b.status <> 'CANCELLED'
        WHERE r.organization_id=$1 AND r.status <> 'CANCELLED' ORDER BY r.period DESC LIMIT 24`, [identity.organizationId, PAYABLE_RUN_STATUSES])).rows }));
  }

  list(identity: AuthIdentity) {
    requireFinance(identity);
    return this.database.tenantTransaction(identity, async (client) => ({ items: (await client.query(
      `SELECT b.id, b.period, b.adapter, b.mode, b.status, b.run_id AS "runId", b.run_net::float AS "runNet", b.total_amount::float AS "totalAmount",
              b.skipped_amount::float AS "skippedAmount", b.payout_count AS "payoutCount", b.skipped_count AS "skippedCount", b.reference,
              b.created_at AS "createdAt", b.released_at AS "releasedAt", c.full_name AS "createdBy", r.full_name AS "releasedBy", b.version,
              b.created_by AS "createdById",
              (SELECT count(*)::int FROM payout_items i WHERE i.batch_id=b.id AND i.status='PROCESSED') AS processed,
              (SELECT count(*)::int FROM payout_items i WHERE i.batch_id=b.id AND i.status IN ('FAILED','REVERSED')) AS failed
         FROM payout_batches b JOIN employees c ON c.id=b.created_by LEFT JOIN employees r ON r.id=b.released_by
        WHERE b.organization_id=$1 ORDER BY b.created_at DESC LIMIT 50`, [identity.organizationId])).rows }));
  }

  get(identity: AuthIdentity, id: string) {
    requireFinance(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const batch = (await client.query(
        `SELECT b.id, b.period, b.adapter, b.mode, b.status, b.run_id AS "runId", b.run_net::float AS "runNet", b.total_amount::float AS "totalAmount",
                b.skipped_amount::float AS "skippedAmount", b.payout_count AS "payoutCount", b.skipped_count AS "skippedCount", b.reference, b.file_checksum AS "fileChecksum",
                b.created_at AS "createdAt", b.released_at AS "releasedAt", c.full_name AS "createdBy", r.full_name AS "releasedBy", b.created_by AS "createdById", b.version,
                pr.status AS "runStatus", pr.totals->>'net' AS "currentRunNet", pr.approved_by AS "runApprovedBy", pr.submitted_by AS "runSubmittedBy", pr.calculated_by AS "runCalculatedBy"
           FROM payout_batches b JOIN employees c ON c.id=b.created_by LEFT JOIN employees r ON r.id=b.released_by JOIN payroll_runs pr ON pr.id=b.run_id
          WHERE b.organization_id=$1 AND b.id=$2`, [identity.organizationId, id])).rows[0];
      if (!batch) throw new NotFoundException("Payout batch not found.");
      const items = (await client.query(
        `SELECT i.id, i.status, i.amount::float, i.skip_reason AS "skipReason", i.bank_name AS "bankName", i.ifsc, i.account_last4 AS "accountLast4",
                i.reference, i.provider_payout_id AS "providerPayoutId", i.utr, i.failure_reason AS "failureReason", i.updated_at AS "updatedAt",
                e.employee_number AS "employeeNumber", e.full_name AS "employeeName", e.department
           FROM payout_items i JOIN employees e ON e.id=i.employee_id WHERE i.organization_id=$1 AND i.batch_id=$2 ORDER BY (i.status='SKIPPED'), e.full_name`,
        [identity.organizationId, id])).rows.map((item) => ({ ...item, account: maskAccount(item.accountLast4) }));
      const events = (await client.query(
        `SELECT ev.id, ev.status, ev.note, ev.source, ev.created_at AS "createdAt", e.full_name AS actor, emp.full_name AS "employeeName", i.reference
           FROM payout_events ev LEFT JOIN employees e ON e.id=ev.actor_id LEFT JOIN payout_items i ON i.id=ev.item_id LEFT JOIN employees emp ON emp.id=i.employee_id
          WHERE ev.organization_id=$1 AND ev.batch_id=$2 ORDER BY ev.id DESC LIMIT 300`, [identity.organizationId, id])).rows;
      const counts = items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.status]: (acc[item.status] || 0) + 1 }), {});
      const adapter = ADAPTERS[batch.adapter];
      const { runApprovedBy, runSubmittedBy, runCalculatedBy, ...rest } = batch;
      const duty = bankFileBlock(identity, { status: batch.runStatus, approved_by: runApprovedBy, submitted_by: runSubmittedBy, calculated_by: runCalculatedBy });
      const releaseBlockedReason = batch.status !== "DRAFT" ? null
        : batch.createdById === identity.employeeId ? "Maker-checker: another payroll administrator or the owner must release a batch you created."
        : duty ? duty.message : null;
      return {
        ...rest, items, events, counts, adapterLabel: adapter.label, adapterKind: adapter.kind,
        reconciled: Math.round((batch.totalAmount + batch.skippedAmount) * 100) === Math.round(batch.runNet * 100),
        canRelease: batch.status === "DRAFT" && !releaseBlockedReason,
        releaseBlockedReason,
        canDownloadFile: adapter.kind === "FILE" && !["DRAFT", "CANCELLED"].includes(batch.status) && !duty,
      };
    });
  }

  createBatch(identity: AuthIdentity, input: CreateBatchDto) {
    if (!identity.roles.some((role) => BANK_FILE_ROLES.includes(role))) throw new ForbiddenException("Only a payroll administrator or the owner can prepare salary payouts.");
    const mode = input.mode || "NEFT";
    return this.database.tenantTransaction(identity, async (client) => {
      const run = (await client.query(`SELECT id, period, status, totals, approved_by FROM payroll_runs WHERE organization_id=$1 AND id=$2 FOR SHARE`, [identity.organizationId, input.runId])).rows[0];
      if (!run) throw new NotFoundException("Payroll run not found.");
      if (!PAYABLE_RUN_STATUSES.includes(run.status)) throw new ConflictException(`Only approved payroll runs can be paid (this run is ${run.status.toLowerCase()}).`);
      if (!run.approved_by) throw new ConflictException("This run has no recorded approver — reopen, submit and approve it again.");
      if ((await client.query(`SELECT 1 FROM payout_batches WHERE organization_id=$1 AND run_id=$2 AND status <> 'CANCELLED'`, [identity.organizationId, run.id])).rowCount)
        throw new ConflictException("This run already has a payout batch. Cancel it first to create a new one.");
      const lines = (await client.query(
        `SELECT l.id, l.employee_id, l.status, l.held, l.hold_reason, l.net, p.bank_name, p.bank_account_hash, p.bank_account_last4, p.ifsc, e.full_name
           FROM payroll_run_lines l JOIN employees e ON e.id=l.employee_id
           LEFT JOIN payroll_profiles p ON p.organization_id=l.organization_id AND p.employee_id=l.employee_id
          WHERE l.organization_id=$1 AND l.run_id=$2 ORDER BY e.full_name`, [identity.organizationId, run.id])).rows;
      const runNet = paise(run.totals?.net);
      const payableNet = lines.filter((line) => line.status === "INCLUDED" && !line.held).reduce((sum, line) => sum + paise(line.net), 0);
      if (payableNet !== runNet) throw new ConflictException(`Run totals are out of date (lines ₹${payableNet / 100} vs run ₹${runNet / 100}). Ask payroll to recalculate.`);
      const reference = `NSP${run.period.replace("-", "")}${randomBytes(3).toString("hex").toUpperCase()}`;
      const items: { line: typeof lines[number]; amount: number; status: "PENDING" | "SKIPPED"; reason?: string; inRunNet: boolean }[] = [];
      for (const line of lines) {
        const amount = paise(line.net);
        const inRunNet = line.status === "INCLUDED" && !line.held;
        if (line.status !== "INCLUDED") items.push({ line, amount, status: "SKIPPED", reason: "Excluded from this payroll run", inRunNet });
        else if (line.held) items.push({ line, amount, status: "SKIPPED", reason: `Salary on hold${line.hold_reason ? ` — ${line.hold_reason}` : ""}`, inRunNet });
        else if (amount <= 0) items.push({ line, amount, status: "SKIPPED", reason: "Zero net pay", inRunNet });
        else if (!line.bank_account_hash || !line.ifsc) items.push({ line, amount, status: "SKIPPED", reason: "Missing bank account or IFSC in payroll profile", inRunNet });
        else if (mode === "RTGS" && amount < 20_000_000) items.push({ line, amount, status: "SKIPPED", reason: "Below the ₹2,00,000 RTGS minimum — pay by NEFT", inRunNet });
        else if (mode === "IMPS" && amount > 50_000_000) items.push({ line, amount, status: "SKIPPED", reason: "Above the ₹5,00,000 IMPS limit — pay by NEFT/RTGS", inRunNet });
        else items.push({ line, amount, status: "PENDING", inRunNet });
      }
      const paid = items.filter((item) => item.status === "PENDING");
      if (!paid.length) throw new ConflictException("Nobody in this run can be paid (check holds and bank details).");
      const total = paid.reduce((sum, item) => sum + item.amount, 0);
      const skippedOwed = items.filter((item) => item.status === "SKIPPED" && item.inRunNet).reduce((sum, item) => sum + item.amount, 0);
      if (total + skippedOwed !== runNet) throw new ConflictException("Batch does not reconcile with the run net pay.");
      const batch = (await client.query(
        `INSERT INTO payout_batches(organization_id,run_id,period,adapter,mode,run_net,total_amount,skipped_amount,payout_count,skipped_count,reference,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [identity.organizationId, run.id, run.period, input.adapter, mode, (runNet / 100).toFixed(2), (total / 100).toFixed(2), (skippedOwed / 100).toFixed(2),
          paid.length, items.length - paid.length, reference, identity.employeeId])).rows[0];
      let seq = 0;
      for (const item of items) {
        seq += 1;
        await client.query(
          `INSERT INTO payout_items(organization_id,batch_id,employee_id,run_line_id,amount,status,skip_reason,bank_name,ifsc,account_last4,account_fingerprint,reference)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [identity.organizationId, batch.id, item.line.employee_id, item.line.id, (item.amount / 100).toFixed(2), item.status, item.reason ?? null,
            item.line.bank_name, item.line.ifsc, item.line.bank_account_last4 ?? null,
            item.line.bank_account_hash && item.line.ifsc ? fingerprint(identity.organizationId, item.line.bank_account_hash, item.line.ifsc) : null, `${reference}-${String(seq).padStart(4, "0")}`]);
      }
      await this.event(client, identity.organizationId, batch.id, null, "DRAFT", `Batch created from ${run.period} payroll: ${paid.length} payouts, ${items.length - paid.length} skipped.`, "USER", identity.employeeId);
      await audit(client, identity, "PAYOUT_BATCH_CREATED", "payout_batch", batch.id, { runId: run.id, adapter: input.adapter, mode, total: total / 100, payouts: paid.length, skipped: items.length - paid.length });
      const checkers = (await client.query(
        `SELECT DISTINCT e.id FROM organization_memberships m JOIN employees e ON e.user_id=m.user_id AND e.organization_id=m.organization_id
          WHERE m.organization_id=$1 AND m.status='ACTIVE' AND m.role IN ('PAYROLL_ADMIN','HR_ADMIN','OWNER') AND e.id <> $2`, [identity.organizationId, identity.employeeId])).rows;
      for (const checker of checkers)
        await client.query(`INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload) VALUES($1,$2,'PAYOUT_RELEASE_REQUESTED','payout_batch',$3,$4)`,
          [identity.organizationId, checker.id, batch.id, JSON.stringify({ message: `A ${run.period} salary payout batch (₹${(total / 100).toLocaleString("en-IN")}, ${paid.length} employees) is waiting for your release.`, link: "/settings/integrations?tab=payouts" })]);
      return { id: batch.id, reference, totalAmount: total / 100, skippedAmount: skippedOwed / 100, runNet: runNet / 100, payoutCount: paid.length, skippedCount: items.length - paid.length };
    });
  }

  async release(identity: AuthIdentity, id: string, version: number) {
    requireFinance(identity);
    const result = await this.database.tenantTransaction(identity, async (client) => {
      const batch = (await client.query(`SELECT * FROM payout_batches WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [identity.organizationId, id])).rows[0];
      if (!batch) throw new NotFoundException("Payout batch not found.");
      if (batch.version !== version) throw new ConflictException("This batch changed since you opened it. Refresh and try again.");
      if (batch.status !== "DRAFT") throw new ConflictException(`Only draft batches can be released (this one is ${batch.status.toLowerCase()}).`);
      if (batch.created_by === identity.employeeId) throw new ForbiddenException("Maker-checker: a different payroll administrator or the owner must release a batch you created.");
      const run = (await client.query(`SELECT status, totals, approved_by, submitted_by, calculated_by FROM payroll_runs WHERE organization_id=$1 AND id=$2`, [identity.organizationId, batch.run_id])).rows[0];
      if (!PAYABLE_RUN_STATUSES.includes(run.status)) throw new ConflictException("The payroll run is no longer approved. Cancel this batch.");
      const blocked = bankFileBlock(identity, run);
      if (blocked) throw blocked;
      if (paise(run.totals?.net) !== paise(batch.run_net)) throw new ConflictException("The payroll run changed after this batch was created. Cancel and recreate the batch.");
      const changed = await this.changedAccounts(client, identity.organizationId, id);
      if (changed.length) throw new ConflictException(`Bank details changed since the batch was created for: ${changed.join(", ")}. Cancel and recreate the batch.`);
      const adapter = ADAPTERS[batch.adapter];
      let checksum: string | null = null;
      if (adapter.kind === "FILE") checksum = sha256((await this.buildFile(client, identity.organizationId, batch, adapter)).content);
      await client.query(`UPDATE payout_items SET status='QUEUED', updated_at=now() WHERE organization_id=$1 AND batch_id=$2 AND status='PENDING'`, [identity.organizationId, id]);
      await client.query(
        `UPDATE payout_batches SET status=$3, released_by=$4, released_at=now(), file_checksum=$5, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, id, adapter.kind === "API" ? "PROCESSING" : "RELEASED", identity.employeeId, checksum]);
      await this.event(client, identity.organizationId, id, null, adapter.kind === "API" ? "PROCESSING" : "RELEASED",
        adapter.kind === "API" ? "Released — submitting payouts to the payouts API." : "Released — the bank file is ready to download and upload.", "USER", identity.employeeId);
      await audit(client, identity, "PAYOUT_BATCH_RELEASED", "payout_batch", id, { adapter: batch.adapter, total: Number(batch.total_amount), checksum });
      if (checksum) await audit(client, identity, "PAYOUT_FILE_RELEASED", "payout_batch", id, { adapter: batch.adapter, sha256: checksum, period: batch.period, rows: batch.payout_count, total: Number(batch.total_amount) });
      await client.query(`INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload) VALUES($1,$2,'PAYOUT_RELEASED','payout_batch',$3,$4)`,
        [identity.organizationId, batch.created_by, id, JSON.stringify({ message: `The ${batch.period} salary payout batch you prepared was released.`, link: "/settings/integrations?tab=payouts" })]);
      const deliveryIds = await this.webhooks.emit(client, identity.organizationId, { type: "payout.batch_released", entityType: "payout_batch", entityId: id, payload: {
        batchId: id, reference: batch.reference, period: batch.period, adapter: batch.adapter, payouts: batch.payout_count, totalAmount: Number(batch.total_amount), releasedAt: new Date().toISOString(),
      } });
      return { kind: adapter.kind, deliveryIds, organizationId: identity.organizationId };
    });
    await this.webhooks.dispatch(result.deliveryIds);
    if (result.kind === "API") await this.syncBatch(result.organizationId, id).catch((error) => this.logger.warn(`Initial payout submission for ${id} failed: ${error.message}`));
    return this.get(identity, id);
  }

  cancel(identity: AuthIdentity, id: string, version: number) {
    requireFinance(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(
        `UPDATE payout_batches SET status='CANCELLED', cancelled_by=$3, cancelled_at=now(), version=version+1, updated_at=now()
          WHERE organization_id=$1 AND id=$2 AND version=$4 AND status='DRAFT' RETURNING id`, [identity.organizationId, id, identity.employeeId, version])).rows[0];
      if (!row) throw new ConflictException("Only an unchanged draft batch can be cancelled. Refresh and try again.");
      await this.event(client, identity.organizationId, id, null, "CANCELLED", "Batch cancelled before release.", "USER", identity.employeeId);
      await audit(client, identity, "PAYOUT_BATCH_CANCELLED", "payout_batch", id);
      return { id, status: "CANCELLED" };
    });
  }

  /** The bank file with full account numbers — the only place they appear. Released FILE batches only. */
  file(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const batch = (await client.query(`SELECT * FROM payout_batches WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id])).rows[0];
      if (!batch) throw new NotFoundException("Payout batch not found.");
      const adapter = ADAPTERS[batch.adapter];
      if (adapter.kind !== "FILE") throw new BadRequestException("API batches have no bank file — payouts are sent through the API.");
      if (batch.status === "DRAFT" || batch.status === "CANCELLED") throw new ConflictException("The bank file is available only after a second administrator releases the batch.");
      const run = (await client.query(`SELECT status, approved_by, submitted_by, calculated_by FROM payroll_runs WHERE organization_id=$1 AND id=$2`, [identity.organizationId, batch.run_id])).rows[0];
      const blocked = bankFileBlock(identity, run);
      if (blocked) throw blocked;
      const changed = await this.changedAccounts(client, identity.organizationId, id);
      if (changed.length) throw new ConflictException(`Bank details changed after release for: ${changed.join(", ")}. The file cannot be regenerated safely.`);
      const file = await this.buildFile(client, identity.organizationId, batch, adapter);
      if (sha256(file.content) !== batch.file_checksum) throw new ConflictException("The regenerated file does not match the released checksum.");
      await audit(client, identity, "PAYOUT_FILE_DOWNLOADED", "payout_batch", id, { checksum: batch.file_checksum, sha256: batch.file_checksum, file: file.name });
      return { ...file, checksum: batch.file_checksum as string };
    });
  }

  private async buildFile(client: PoolClient, org: string, batch: Record<string, any>, adapter: FileAdapter) {
    const rows = (await client.query(
      `SELECT i.reference, i.amount, e.full_name, e.work_email, p.organization_id, p.employee_id, p.bank_account_enc, p.ifsc
         FROM payout_items i JOIN employees e ON e.id=i.employee_id JOIN payroll_profiles p ON p.organization_id=i.organization_id AND p.employee_id=i.employee_id
        WHERE i.organization_id=$1 AND i.batch_id=$2 AND i.status <> 'SKIPPED' ORDER BY i.reference`, [org, batch.id])).rows;
    const settings = (await client.query(`SELECT debit_account FROM payroll_settings WHERE organization_id=$1`, [org])).rows[0];
    const debitAccount = settings?.debit_account || process.env.PAYOUTS_DEBIT_ACCOUNT || "";
    if (!debitAccount && this.config.nodeEnv === "production") throw new ConflictException("Set the salary debit account in payroll settings first.");
    const run = (await client.query(`SELECT pay_date::text FROM payroll_runs WHERE id=$1`, [batch.run_id])).rows[0];
    const [y, m] = String(batch.period).split("-");
    const month = new Date(Date.UTC(+y, +m - 1, 1)).toLocaleString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
    return adapter.build({
      reference: batch.reference, debitAccount: debitAccount || "000000000000", mode: batch.mode,
      valueDate: run?.pay_date && run.pay_date >= istDate(batch.released_at || new Date()) ? run.pay_date : istDate(batch.released_at || new Date()) || lastDayOfPeriod(batch.period),
      // The only place a full account number exists: decrypted for the bank file (role-checked, audited), never returned by the API otherwise.
      rows: rows.map((row, index) => ({ seq: index + 1, reference: row.reference, name: row.full_name, account: decryptProfileField(row, "bankAccount") || "", ifsc: row.ifsc, amountPaise: paise(row.amount),
        mode: batch.mode, narration: `Salary ${month}`, email: row.work_email })),
    });
  }

  private async changedAccounts(client: PoolClient, org: string, batchId: string) {
    const rows = (await client.query(
      `SELECT e.full_name, i.account_fingerprint, p.bank_account_hash, p.ifsc FROM payout_items i JOIN employees e ON e.id=i.employee_id
         LEFT JOIN payroll_profiles p ON p.organization_id=i.organization_id AND p.employee_id=i.employee_id
        WHERE i.organization_id=$1 AND i.batch_id=$2 AND i.status <> 'SKIPPED'`, [org, batchId])).rows;
    return rows.filter((row) => !row.bank_account_hash || !row.ifsc || fingerprint(org, row.bank_account_hash, row.ifsc) !== row.account_fingerprint).map((row) => row.full_name as string);
  }

  // ------------------------------------------------------------------ status updates

  private async event(client: PoolClient, org: string, batchId: string, itemId: string | null, status: string, note: string, source: Source, actorId?: string | null) {
    await client.query(`INSERT INTO payout_events(organization_id,batch_id,item_id,status,note,source,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [org, batchId, itemId, status, note.slice(0, 500), source, actorId || null]);
  }

  /** Applies a provider/bank status to one payout if it moves it forward. Returns webhook delivery ids to dispatch. */
  private async applyStatus(client: PoolClient, org: string, item: { id: string; batch_id: string; status: string; employee_id: string; reference: string; amount: string | number },
    status: PayoutStatus, source: Source, utr?: string | null, reason?: string | null, actorId?: string | null) {
    if (status === item.status || TERMINAL.includes(item.status) && !(item.status === "PROCESSED" && status === "REVERSED")) return [];
    if (RANK[status] < RANK[item.status]) return [];
    await client.query(`UPDATE payout_items SET status=$2, utr=coalesce($3,utr), failure_reason=$4, updated_at=now() WHERE id=$1`, [item.id, status, utr ?? null, reason ?? null]);
    const note = status === "PROCESSED" ? `Credited${utr ? ` · UTR ${utr}` : ""}` : status === "FAILED" ? `Failed: ${reason || "rejected by bank"}` : status === "REVERSED" ? `Reversed: ${reason || "returned by beneficiary bank"}` : `Now ${status.toLowerCase()}`;
    await this.event(client, org, item.batch_id, item.id, status, note, source, actorId);
    if (!["PROCESSED", "FAILED", "REVERSED"].includes(status)) return [];
    const employee = (await client.query(`SELECT employee_number FROM employees WHERE id=$1`, [item.employee_id])).rows[0];
    return this.webhooks.emit(client, org, { type: status === "PROCESSED" ? "payout.processed" : "payout.failed", entityType: "payout_item", entityId: item.id, payload: {
      payoutId: item.id, batchId: item.batch_id, reference: item.reference, employeeNumber: employee?.employee_number, amount: Number(item.amount), status, utr: utr ?? null, failureReason: reason ?? null,
    } });
  }

  private async refreshBatch(client: PoolClient, org: string, batchId: string, source: Source) {
    const batch = (await client.query(`SELECT status FROM payout_batches WHERE id=$1 FOR UPDATE`, [batchId])).rows[0];
    const counts = (await client.query(
      `SELECT count(*) FILTER (WHERE status NOT IN ('SKIPPED'))::int AS total, count(*) FILTER (WHERE status='PROCESSED')::int AS processed,
              count(*) FILTER (WHERE status IN ('FAILED','REVERSED'))::int AS failed, count(*) FILTER (WHERE status IN ('PROCESSING'))::int AS processing
         FROM payout_items WHERE batch_id=$1`, [batchId])).rows[0];
    const done = counts.processed + counts.failed === counts.total;
    const next = done ? (counts.failed === 0 ? "COMPLETED" : counts.processed === 0 ? "FAILED" : "PARTIAL") : counts.processing || counts.processed || counts.failed ? "PROCESSING" : batch.status;
    if (next !== batch.status) {
      await client.query(`UPDATE payout_batches SET status=$2, version=version+1, updated_at=now() WHERE id=$1`, [batchId, next]);
      await this.event(client, org, batchId, null, next, done ? `Batch finished: ${counts.processed} processed, ${counts.failed} failed.` : "Payouts are being processed.", source);
    }
  }

  /** Polls the API adapter for one batch: submits payouts not yet sent, then fetches statuses of in-flight ones. */
  async syncBatch(organizationId: string, batchId: string) {
    const identity = systemIdentity(organizationId);
    const adapter = razorpayX as ApiAdapter;
    const pending = await this.database.tenantTransaction(identity, async (client) => (await client.query(
      `SELECT i.id, i.batch_id, i.status, i.employee_id, i.reference, i.amount, i.provider_payout_id, b.mode, e.full_name, e.employee_number,
              p.organization_id AS profile_org, p.employee_id AS profile_employee, p.bank_account_enc, p.bank_account_hash, p.ifsc, b.period
         FROM payout_items i JOIN payout_batches b ON b.id=i.batch_id JOIN employees e ON e.id=i.employee_id
         LEFT JOIN payroll_profiles p ON p.organization_id=i.organization_id AND p.employee_id=i.employee_id
        WHERE i.organization_id=$1 AND i.batch_id=$2 AND b.adapter='API_RAZORPAYX' AND b.status IN ('RELEASED','PROCESSING') AND i.status IN ('QUEUED','PROCESSING')
        ORDER BY i.reference`, [organizationId, batchId])).rows);
    let submitted = 0;
    let updated = 0;
    const deliveryIds: string[] = [];
    for (const item of pending) {
      try {
        await this.database.tenantTransaction(identity, async (client) => {
          const locked = (await client.query(`SELECT status, provider_payout_id FROM payout_items WHERE id=$1 FOR UPDATE SKIP LOCKED`, [item.id])).rows[0];
          if (!locked || !["QUEUED", "PROCESSING"].includes(locked.status)) return;
          let state;
          if (!locked.provider_payout_id) {
            if (!item.bank_account_hash || !item.ifsc || fingerprint(organizationId, item.bank_account_hash, item.ifsc) !== (await client.query(`SELECT account_fingerprint FROM payout_items WHERE id=$1`, [item.id])).rows[0].account_fingerprint) {
              deliveryIds.push(...await this.applyStatus(client, organizationId, { ...item, status: locked.status }, "FAILED", "SYSTEM", null, "Bank details changed after release — not sent"));
              return;
            }
            const [y, m] = String(item.period).split("-");
            const account = decryptProfileField({ organization_id: item.profile_org, employee_id: item.profile_employee, bank_account_enc: item.bank_account_enc }, "bankAccount");
            if (!account) throw new Error("Bank account could not be decrypted");
            state = await adapter.submit(client, organizationId, { reference: item.reference, amountPaise: paise(item.amount), mode: item.mode, name: item.full_name,
              account, ifsc: item.ifsc, narration: `Salary ${m}/${y}`, employeeNumber: item.employee_number });
            await client.query(`UPDATE payout_items SET provider_payout_id=$2, updated_at=now() WHERE id=$1`, [item.id, state.id]);
            await this.event(client, organizationId, item.batch_id, item.id, "QUEUED", `Submitted to payouts API as ${state.id}`, "SYNC");
            submitted += 1;
          } else state = await adapter.fetch(client, organizationId, locked.provider_payout_id);
          const ids = await this.applyStatus(client, organizationId, { ...item, status: locked.status }, state.status, "SYNC", state.utr, state.failureReason);
          if (state.status !== locked.status) updated += 1;
          deliveryIds.push(...ids);
        });
      } catch (error) {
        this.logger.warn(`Payout ${item.reference} sync failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    await this.database.tenantTransaction(identity, (client) => this.refreshBatch(client, organizationId, batchId, "SYNC"));
    await this.webhooks.dispatch(deliveryIds);
    return { batchId, checked: pending.length, submitted, updated };
  }

  /** Job handler `integrations.payouts.sync`: every in-flight API batch across organizations. */
  async syncAll(organizationId?: string) {
    const batches = (await this.database.systemQuery(
      `SELECT organization_id, id FROM payout_batches WHERE adapter='API_RAZORPAYX' AND status IN ('RELEASED','PROCESSING') AND ($1::uuid IS NULL OR organization_id=$1)
        ORDER BY released_at LIMIT 200`, [organizationId && /^[0-9a-f-]{36}$/i.test(organizationId) ? organizationId : null])).rows;
    const results = [];
    for (const batch of batches) results.push(await this.syncBatch(batch.organization_id, batch.id));
    return { batches: batches.length, results };
  }

  async syncNow(identity: AuthIdentity, id: string) {
    requireFinance(identity);
    const batch = (await this.database.tenantTransaction(identity, async (client) =>
      (await client.query(`SELECT adapter, status FROM payout_batches WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id])).rows[0]));
    if (!batch) throw new NotFoundException("Payout batch not found.");
    if (batch.adapter !== "API_RAZORPAYX") throw new BadRequestException("File batches are updated from the bank's response file.");
    await this.syncBatch(identity.organizationId, id);
    return this.get(identity, id);
  }

  /** H2H bank response CSV: reference,status,utr,reason (status PROCESSED|SUCCESS|PAID / FAILED|REJECTED|RETURNED / REVERSED). */
  async bankResponse(identity: AuthIdentity, id: string, input: BankResponseDto) {
    requireFinance(identity);
    const result = await this.database.tenantTransaction(identity, async (client) => {
      const batch = (await client.query(`SELECT adapter, status FROM payout_batches WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [identity.organizationId, id])).rows[0];
      if (!batch) throw new NotFoundException("Payout batch not found.");
      if (ADAPTERS[batch.adapter].kind !== "FILE") throw new BadRequestException("API batches are updated by the payouts API.");
      if (!["RELEASED", "PROCESSING", "PARTIAL"].includes(batch.status)) throw new ConflictException("Import a bank response only for released batches.");
      const lines = input.csv.replace(/^﻿/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const header = lines.shift()!.toLowerCase().split(",").map((cell) => cell.trim());
      const at = (name: string) => header.indexOf(name);
      if (at("reference") < 0 || at("status") < 0) throw new BadRequestException("The response file needs reference and status columns (utr and reason are optional).");
      const map: Record<string, PayoutStatus> = { PROCESSED: "PROCESSED", SUCCESS: "PROCESSED", PAID: "PROCESSED", CREDITED: "PROCESSED", FAILED: "FAILED", REJECTED: "FAILED", RETURNED: "REVERSED", REVERSED: "REVERSED", PROCESSING: "PROCESSING" };
      const errors: string[] = [];
      const deliveryIds: string[] = [];
      let applied = 0;
      for (const [index, line] of lines.entries()) {
        const cells = line.split(",").map((cell) => cell.replace(/^"|"$/g, "").trim());
        const status = map[(cells[at("status")] || "").toUpperCase()];
        const item = (await client.query(`SELECT id, batch_id, status, employee_id, reference, amount FROM payout_items WHERE organization_id=$1 AND batch_id=$2 AND reference=$3`,
          [identity.organizationId, id, cells[at("reference")]])).rows[0];
        if (!item) { errors.push(`Line ${index + 2}: unknown reference ${cells[at("reference")]}`); continue; }
        if (!status) { errors.push(`Line ${index + 2}: unknown status ${cells[at("status")]}`); continue; }
        const ids = await this.applyStatus(client, identity.organizationId, item, status, "BANK_FILE", at("utr") >= 0 ? cells[at("utr")] || null : null, at("reason") >= 0 ? cells[at("reason")] || null : null, identity.employeeId);
        deliveryIds.push(...ids);
        applied += 1;
      }
      await this.refreshBatch(client, identity.organizationId, id, "BANK_FILE");
      await audit(client, identity, "PAYOUT_BANK_RESPONSE_IMPORTED", "payout_batch", id, { applied, errors: errors.length });
      return { applied, errors, deliveryIds };
    });
    await this.webhooks.dispatch(result.deliveryIds);
    return { applied: result.applied, errors: result.errors };
  }

  /**
   * Inbound provider webhook (RazorpayX-style). Authenticity + freshness + once-only:
   *  - Preferred: header x-payout-timestamp (unix seconds) and X-Razorpay-Signature = hex HMAC-SHA256(secret, `${timestamp}.${raw body}`).
   *  - Provider-native (RazorpayX signs the raw body only): X-Razorpay-Signature = hex HMAC-SHA256(secret, raw body) and the
   *    signed payload's `created_at` (unix seconds) is the timestamp.
   *  Either way the timestamp must be within ±5 minutes, and the event (x-razorpay-event-id, else the signature) is recorded
   *  in payout_webhook_receipts with unique constraints, so a replayed request is acknowledged (200) without effect.
   */
  async inboundWebhook(headers: { signature: string; timestamp?: string; eventId?: string }, raw: Buffer | undefined, body: unknown) {
    const { secret } = payoutWebhookSecret();
    if (!secret) throw new ServiceUnavailableException("Payout webhook secret is not configured.");
    const signature = (headers.signature || "").trim().toLowerCase().replace(/^sha256=/, "");
    if (!raw || !/^[0-9a-f]{64}$/.test(signature)) throw new UnauthorizedException("Invalid webhook signature.");
    const event = body as { event?: string; created_at?: number | string; payload?: { payout?: { entity?: { id?: string; status?: string; utr?: string; failure_reason?: string; status_details?: { description?: string } } } } };
    let timestamp: number;
    if (headers.timestamp) {
      if (!/^\d{9,11}$/.test(headers.timestamp.trim())) throw new UnauthorizedException("Invalid webhook timestamp.");
      if (!safeEqual(hmacHex(secret, Buffer.concat([Buffer.from(`${headers.timestamp.trim()}.`), raw])), signature)) throw new UnauthorizedException("Invalid webhook signature.");
      timestamp = Number(headers.timestamp.trim());
    } else {
      if (!safeEqual(hmacHex(secret, raw), signature)) throw new UnauthorizedException("Invalid webhook signature.");
      timestamp = Number(event?.created_at);
      if (!Number.isInteger(timestamp)) throw new UnauthorizedException("Send x-payout-timestamp (signed) or a signed created_at in the payload.");
    }
    if (Math.abs(Date.now() / 1000 - timestamp) > WEBHOOK_TOLERANCE_SECONDS)
      throw new UnauthorizedException(`Webhook timestamp is outside the ±${WEBHOOK_TOLERANCE_SECONDS / 60}-minute window.`);
    const eventId = (headers.eventId || "").trim().slice(0, 120) || null;
    // Once-only: unique on signature hash and on provider event id. ON CONFLICT DO NOTHING covers both constraints.
    await this.database.systemQuery(`DELETE FROM payout_webhook_receipts WHERE received_at < now() - interval '7 days'`).catch(() => undefined);
    const fresh = await this.database.systemQuery(
      `INSERT INTO payout_webhook_receipts(signature_hash, event_id, event_type, signed_at) VALUES($1,$2,$3,to_timestamp($4)) ON CONFLICT DO NOTHING RETURNING id`,
      [sha256(signature), eventId, String(event?.event || "").slice(0, 60) || null, timestamp]);
    if (!fresh.rowCount) return { ok: true, duplicate: true };
    try {
      const entity = event?.payload?.payout?.entity;
      const statusMap: Record<string, PayoutStatus> = { "payout.queued": "QUEUED", "payout.pending": "QUEUED", "payout.initiated": "PROCESSING", "payout.processing": "PROCESSING",
        "payout.processed": "PROCESSED", "payout.failed": "FAILED", "payout.rejected": "FAILED", "payout.reversed": "REVERSED" };
      const status = statusMap[event?.event || ""];
      if (!entity?.id || !status) return { ok: true, ignored: "unsupported event" };
      const found = (await this.database.systemQuery(`SELECT organization_id FROM payout_items WHERE provider_payout_id=$1`, [entity.id])).rows[0];
      if (!found) return { ok: true, ignored: "unknown payout" };
      const deliveryIds = await this.database.tenantTransaction(systemIdentity(found.organization_id), async (client) => {
        const item = (await client.query(`SELECT id, batch_id, status, employee_id, reference, amount FROM payout_items WHERE organization_id=$1 AND provider_payout_id=$2 FOR UPDATE`,
          [found.organization_id, entity.id])).rows[0];
        const ids = await this.applyStatus(client, found.organization_id, item, status, "WEBHOOK", entity.utr ?? null, entity.failure_reason || entity.status_details?.description || null);
        await this.refreshBatch(client, found.organization_id, item.batch_id, "WEBHOOK");
        return ids;
      });
      await this.webhooks.dispatch(deliveryIds);
      return { ok: true };
    } catch (error) {
      // Not applied: forget the receipt so the provider's own retry is processed.
      await this.database.systemQuery(`DELETE FROM payout_webhook_receipts WHERE id=$1`, [fresh.rows[0].id]).catch(() => undefined);
      throw error;
    }
  }
}

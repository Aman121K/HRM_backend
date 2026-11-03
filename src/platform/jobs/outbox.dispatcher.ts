import { Injectable, Logger } from "@nestjs/common";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { DatabaseService } from "../database/database.service";
import { throwIfAborted } from "./job-context";
import { headerSafe, htmlToText, renderEmail } from "./email-layout";
import { mailRetryDelayMs } from "./scheduling";
import { TenantJobRunner } from "./tenant-runner";

type OutboxRow = { id: string; organization_id: string; recipient: string; subject: string; html: string; attempts: number };

export const MAIL_MAX_ATTEMPTS = () => Math.max(1, Number(process.env.MAIL_MAX_ATTEMPTS || 6));
/** How long a claimed (PROCESSING) row is leased to one worker before another may pick it up again. */
const LEASE_MINUTES = 10;

/**
 * Sends email_outbox rows. Claiming uses FOR UPDATE SKIP LOCKED plus a lease (status PROCESSING, available_at in the
 * future), committed before any network I/O, so parallel workers never double-send and a crashed worker's rows are
 * retried after the lease expires. SMTP when SMTP_HOST is set; otherwise a development mailbox of JSON files.
 */
@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger("Outbox");
  private transport?: Transporter;
  readonly mailDir = resolve(process.env.MAIL_DIR || join(process.cwd(), ".data", "mail"));

  constructor(private readonly database: DatabaseService, private readonly runner: TenantJobRunner) {}

  get mode() { return process.env.SMTP_HOST ? "smtp" : "mailbox"; }

  private smtp() {
    if (!this.transport)
      this.transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === "true" || Number(process.env.SMTP_PORT) === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
        pool: true, maxConnections: 3,
      });
    return this.transport;
  }

  /** Sends due messages for one tenant (payload.organizationId) or all tenants. */
  async dispatch(payload: Record<string, unknown>) {
    const limit = Math.min(Math.max(Number(payload.limit) || 50, 1), 500);
    const organizations = await this.runner.organizations(typeof payload.organizationId === "string" ? payload.organizationId : undefined);
    let sent = 0, failed = 0, gaveUp = 0;
    for (const organization of organizations) {
      throwIfAborted();
      const rows = await this.claim(organization.id, limit);
      for (const row of rows) {
        const result = await this.deliver(row, organization.name);
        if (result === "SENT") sent += 1; else if (result === "GAVE_UP") gaveUp += 1; else failed += 1;
      }
    }
    return { organizations: organizations.length, sent, failed, gaveUp, mode: this.mode };
  }

  private async claim(organizationId: string, limit: number) {
    const identity = await this.runner.systemIdentity(organizationId);
    return this.database.tenantTransaction(identity, async (client) => {
      // A worker died mid-send on its last allowed attempt: close the row out instead of leaving it PROCESSING forever.
      await client.query(`UPDATE email_outbox SET status='FAILED', last_error=coalesce(last_error,'Delivery lease expired') || ' (gave up)'
        WHERE organization_id=$1 AND status='PROCESSING' AND available_at<=now() AND attempts>=$2`, [organizationId, MAIL_MAX_ATTEMPTS()]);
      return (await client.query(
      `UPDATE email_outbox SET status='PROCESSING', attempts=attempts+1, available_at=now()+make_interval(mins => $3)
        WHERE id IN (SELECT id FROM email_outbox
                      WHERE organization_id=$1 AND available_at<=now() AND attempts<$4
                        AND status IN ('PENDING','FAILED','PROCESSING')
                      ORDER BY available_at, id FOR UPDATE SKIP LOCKED LIMIT $2)
        RETURNING id, organization_id, recipient, subject, html, attempts`,
      [organizationId, limit, LEASE_MINUTES, MAIL_MAX_ATTEMPTS()])).rows as OutboxRow[];
    });
  }

  private async deliver(row: OutboxRow, organizationName: string): Promise<"SENT" | "FAILED" | "GAVE_UP"> {
    const identity = await this.runner.systemIdentity(row.organization_id);
    const from = process.env.MAIL_FROM || "ClanChief <no-reply@northstar.local>";
    // Every producer should already pass a clean subject; this is the last line of defence against header injection.
    const subject = headerSafe(row.subject) || "Notification";
    const html = renderEmail({ subject, html: row.html, organizationName });
    const text = `${subject}\n\n${htmlToText(row.html)}`;
    try {
      if (!row.recipient || !/^[^\s@<>,;"]+@[^\s@<>,;"]+$/.test(row.recipient)) throw new Error("Invalid recipient address.");
      let messageId: string;
      if (this.mode === "smtp") {
        const info = await this.smtp().sendMail({ from, to: row.recipient, subject, html, text, headers: { "X-Northstar-Outbox-Id": String(row.id) } });
        messageId = info.messageId;
      } else {
        messageId = await this.writeMailbox(row, from, html, text);
      }
      await this.database.tenantTransaction(identity, (client) => client.query(
        `UPDATE email_outbox SET status='SENT', sent_at=now(), last_error=NULL WHERE organization_id=$1 AND id=$2`, [row.organization_id, row.id]));
      this.logger.log(JSON.stringify({ event: "mail_sent", id: row.id, org: row.organization_id, mode: this.mode, messageId }));
      return "SENT";
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      const final = row.attempts >= MAIL_MAX_ATTEMPTS();
      await this.database.tenantTransaction(identity, (client) => client.query(
        `UPDATE email_outbox SET status='FAILED', last_error=$3, available_at=now()+make_interval(secs => $4) WHERE organization_id=$1 AND id=$2`,
        [row.organization_id, row.id, final ? `Gave up after ${row.attempts} attempts: ${message}` : message, mailRetryDelayMs(row.attempts) / 1000]));
      this.logger.warn(JSON.stringify({ event: final ? "mail_gave_up" : "mail_failed", id: row.id, org: row.organization_id, attempts: row.attempts, error: message }));
      return final ? "GAVE_UP" : "FAILED";
    }
  }

  /** Development mailbox: one JSON file per message, written atomically (tmp + rename). */
  private async writeMailbox(row: OutboxRow, from: string, html: string, text: string) {
    await mkdir(this.mailDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
    const name = `${stamp}-${row.id}.json`;
    const body = JSON.stringify({ id: String(row.id), organizationId: row.organization_id, from, to: row.recipient, subject: headerSafe(row.subject) || "Notification", text, html, sentAt: new Date().toISOString() }, null, 2);
    const target = join(this.mailDir, name);
    await writeFile(`${target}.tmp`, body, { mode: 0o600 });
    await rename(`${target}.tmp`, target);
    return `mailbox:${name}`;
  }

  async close() { this.transport?.close(); }
}

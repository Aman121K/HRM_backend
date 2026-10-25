import { Injectable, Logger } from "@nestjs/common";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { DatabaseService } from "../../database/database.service";
import { JobsService } from "../../jobs/jobs.service";
import { appBaseUrl, emailButton, escapeHtml, headerSafe, htmlToText, renderEmail } from "../../jobs/email-layout";

/**
 * Account emails (invites, password reset, unlock, sign-in codes).
 * - Inside a brand: written to that brand's email_outbox (same delivery, retries and audit as every other message) and
 *   the outbox dispatcher is nudged so the link arrives within seconds.
 * - Platform accounts (super admins have no brand): sent directly — SMTP when SMTP_HOST is set, otherwise the same
 *   development mailbox (.data/mail/*.json) the outbox uses.
 * Every interpolated value is escaped; subjects go through headerSafe.
 */
@Injectable()
export class AuthMailer {
  private readonly logger = new Logger("AuthMailer");
  constructor(private readonly database: DatabaseService, private readonly jobs: JobsService) {}

  async send(organizationId: string | null, recipient: string, subject: string, html: string) {
    const safeSubject = headerSafe(subject);
    if (organizationId) {
      await this.database.systemQuery(`INSERT INTO email_outbox(organization_id,recipient,subject,html) VALUES($1,$2,$3,$4)`,
        [organizationId, recipient, safeSubject, html]);
      await this.jobs.enqueue("outbox.dispatch", { organizationId }, { removeOnComplete: true }).catch((error) =>
        this.logger.warn(`Outbox nudge failed (the periodic sweep will send it): ${(error as Error).message}`));
      return;
    }
    const from = process.env.MAIL_FROM || "Northstar People <no-reply@northstar.local>";
    const body = renderEmail({ subject: safeSubject, html, organizationName: "Northstar Platform" });
    const text = `${safeSubject}\n\n${htmlToText(html)}`;
    if (process.env.SMTP_HOST) {
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === "true" || Number(process.env.SMTP_PORT) === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      });
      try { await transport.sendMail({ from, to: recipient, subject: safeSubject, html: body, text }); } finally { transport.close(); }
      return;
    }
    const dir = resolve(process.env.MAIL_DIR || join(process.cwd(), ".data", "mail"));
    await mkdir(dir, { recursive: true });
    const id = `platform-${randomUUID()}`;
    const name = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}-${id}.json`;
    await writeFile(join(dir, `${name}.tmp`), JSON.stringify({ id, organizationId: null, from, to: recipient, subject: safeSubject, text, html: body, sentAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    await rename(join(dir, `${name}.tmp`), join(dir, name));
  }
}

/** Absolute web address on a brand's own subdomain (got-tea.localhost:3000/activate), or on the main domain. */
export function brandWebUrl(slug: string | null, path: string) {
  const base = new URL(appBaseUrl());
  const domain = (process.env.APP_DOMAIN || "localhost").toLowerCase();
  if (slug && (base.hostname === domain || base.hostname.endsWith(`.${domain}`)))
    return `${base.protocol}//${slug}.${domain}${base.port ? `:${base.port}` : ""}${path}`;
  return `${base.origin}${path}`;
}

export const paragraphs = (...lines: string[]) => lines.map((line) => `<p style="margin:0 0 12px">${escapeHtml(line)}</p>`).join("");
export { emailButton, escapeHtml };

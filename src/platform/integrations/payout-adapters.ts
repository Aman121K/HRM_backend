import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { devInstallSecret, MIN_WEBHOOK_SECRET, sha256 } from "./crypto";
import { csvSafe } from "./shared";

/**
 * Bank payout adapters. Two families share one interface:
 *  - FILE (host-to-host): we build a bulk payment file that treasury uploads to the bank (or an SFTP job pushes);
 *    statuses come back through a bank response file.
 *  - API: payouts are created one by one against a payouts API (modelled on RazorpayX) and their status is polled
 *    by the `integrations.payouts.sync` job or pushed to our signed inbound webhook.
 * Credentials are read from the environment only; the database never holds bank secrets.
 */
export type PayoutStatus = "PENDING" | "QUEUED" | "PROCESSING" | "PROCESSED" | "FAILED" | "REVERSED";
export type FileRow = { seq: number; reference: string; name: string; account: string; ifsc: string; amountPaise: number; mode: string; narration: string; email?: string | null };
export type FileBatch = { reference: string; debitAccount: string; valueDate: string; mode: string; rows: FileRow[] };
export type ApiPayout = { reference: string; amountPaise: number; mode: string; name: string; account: string; ifsc: string; narration: string; employeeNumber: string };
export type ProviderState = { id: string; status: PayoutStatus; utr?: string | null; failureReason?: string | null };

export interface FileAdapter {
  kind: "FILE"; key: string; label: string; description: string;
  configured(): { configured: boolean; detail: string };
  build(batch: FileBatch): { name: string; type: string; content: string };
}
export interface ApiAdapter {
  kind: "API"; key: string; label: string; description: string;
  configured(): { configured: boolean; detail: string; mode: "LIVE" | "SANDBOX" };
  submit(client: PoolClient, organizationId: string, payout: ApiPayout): Promise<ProviderState>;
  fetch(client: PoolClient, organizationId: string, providerId: string): Promise<ProviderState>;
}
export type PayoutAdapter = FileAdapter | ApiAdapter;

const rupees = (paise: number) => (paise / 100).toFixed(2);
const clean = (value: string, max: number) => value.replace(/[|,"\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * ClanChief generic H2H format v1 (pipe-delimited, UTF-8, CRLF):
 *   H|NSH2H1|<batch ref>|<debit account>|<value date YYYYMMDD>|<mode>|<record count>|<total amount 0.00>
 *   D|<seq>|<payment ref>|<beneficiary name ≤40>|<account no>|<IFSC>|<amount 0.00>|<mode>|<narration ≤30>
 *   T|<record count>|<total amount 0.00>|<SHA-256 hex of all D lines joined by CRLF>
 * The trailer hash lets the bank (or our own re-check) detect tampering between release and upload.
 */
export const genericH2H: FileAdapter = {
  kind: "FILE", key: "H2H_GENERIC", label: "Host-to-host file (ClanChief generic v1)",
  description: "Pipe-delimited bulk payment file with header, detail and hash-sealed trailer records.",
  configured: () => ({ configured: true, detail: "No credentials needed — files are downloaded after release." }),
  build(batch) {
    const total = batch.rows.reduce((sum, row) => sum + row.amountPaise, 0);
    const details = batch.rows.map((row) => ["D", row.seq, row.reference, clean(row.name, 40), row.account, row.ifsc, rupees(row.amountPaise), row.mode, clean(row.narration, 30)].join("|"));
    const lines = [
      ["H", "NSH2H1", batch.reference, batch.debitAccount, batch.valueDate.replace(/-/g, ""), batch.mode, batch.rows.length, rupees(total)].join("|"),
      ...details,
      ["T", batch.rows.length, rupees(total), sha256(details.join("\r\n"))].join("|"),
    ];
    return { name: `${batch.reference}-h2h.txt`, type: "text/plain", content: `${lines.join("\r\n")}\r\n` };
  },
};

/** Bank-style bulk upload CSV, modelled on common Indian corporate net-banking templates (N=NEFT, R=RTGS, I=IMPS). */
export const bankCsv: FileAdapter = {
  kind: "FILE", key: "H2H_BANK_CSV", label: "Bank bulk-upload CSV",
  description: "Net-banking bulk transfer template: one row per beneficiary, value date DD/MM/YYYY.",
  configured: () => ({ configured: true, detail: "No credentials needed — upload the CSV in your bank's corporate portal." }),
  build(batch) {
    const code = { NEFT: "N", RTGS: "R", IMPS: "I" }[batch.mode] || "N";
    const [y, m, d] = batch.valueDate.split("-");
    const header = ["Transaction Type", "Beneficiary Code", "Beneficiary Account Number", "Instrument Amount", "Beneficiary Name", "IFSC Code",
      "Value Date", "Customer Reference Number", "Debit Account Number", "Payment Details", "Beneficiary Email"];
    const rows = batch.rows.map((row) => [code, `EMP${String(row.seq).padStart(4, "0")}`, row.account, rupees(row.amountPaise), clean(row.name, 35), row.ifsc,
      `${d}/${m}/${y}`, row.reference, batch.debitAccount, clean(row.narration, 30), row.email || ""].map(csvSafe).join(","));
    return { name: `${batch.reference}-bank.csv`, type: "text/csv", content: `${[header.map(csvSafe).join(","), ...rows].join("\r\n")}\r\n` };
  },
};

const sandboxStep = () => Math.max(1, Number(process.env.PAYOUT_SANDBOX_STEP_SECONDS || 15));
const liveCredentials = () => ({
  keyId: process.env.RAZORPAYX_KEY_ID || "", keySecret: process.env.RAZORPAYX_KEY_SECRET || "", account: process.env.RAZORPAYX_ACCOUNT_NUMBER || "",
});
const statusFrom = (value: string): PayoutStatus =>
  ({ queued: "QUEUED", pending: "QUEUED", scheduled: "QUEUED", processing: "PROCESSING", processed: "PROCESSED", failed: "FAILED", rejected: "FAILED", cancelled: "FAILED", reversed: "REVERSED" } as Record<string, PayoutStatus>)[value] || "QUEUED";

/**
 * RazorpayX-style payouts API. With RAZORPAYX_KEY_ID/SECRET/ACCOUNT_NUMBER set it calls the live API; otherwise it uses
 * the built-in SANDBOX, which persists payouts in payout_sandbox_payouts and advances them asynchronously:
 * queued → processing after PAYOUT_SANDBOX_STEP_SECONDS (default 15 s) → processed (with a UTR) after twice that.
 * Sandbox rule for demos: an account number ending in 0000 fails with "Invalid beneficiary account".
 */
export const razorpayX: ApiAdapter = {
  kind: "API", key: "API_RAZORPAYX", label: "Payouts API (RazorpayX-style)",
  description: "Creates one payout per employee through the API and tracks queued → processing → processed with UTRs.",
  configured() {
    const creds = liveCredentials();
    const live = !!(creds.keyId && creds.keySecret && creds.account);
    return live ? { configured: true, mode: "LIVE", detail: "Live API credentials configured (RAZORPAYX_KEY_ID)." }
      : { configured: true, mode: "SANDBOX", detail: `Built-in sandbox — payouts settle in about ${sandboxStep() * 2} s. Set RAZORPAYX_KEY_ID, RAZORPAYX_KEY_SECRET and RAZORPAYX_ACCOUNT_NUMBER for live payouts.` };
  },
  async submit(client, organizationId, payout) {
    const creds = liveCredentials();
    if (creds.keyId && creds.keySecret && creds.account) {
      const response = await fetch("https://api.razorpay.com/v1/payouts", {
        method: "POST", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64")}`, "X-Payout-Idempotency": payout.reference },
        body: JSON.stringify({
          account_number: creds.account, amount: payout.amountPaise, currency: "INR", mode: payout.mode, purpose: "salary", queue_if_low_balance: true,
          reference_id: payout.reference, narration: payout.narration.slice(0, 30),
          fund_account: { account_type: "bank_account", bank_account: { name: payout.name, ifsc: payout.ifsc, account_number: payout.account },
            contact: { name: payout.name, type: "employee", reference_id: payout.employeeNumber } },
        }),
      });
      const data = await response.json().catch(() => ({})) as { id?: string; status?: string; utr?: string; error?: { description?: string } };
      if (!response.ok || !data.id) throw new Error(data.error?.description || `Payouts API answered HTTP ${response.status}`);
      return { id: data.id, status: statusFrom(data.status || "queued"), utr: data.utr ?? null };
    }
    const id = `pout_sbx${randomBytes(6).toString("hex")}`;
    const row = (await client.query(
      `INSERT INTO payout_sandbox_payouts(id,organization_id,reference_id,amount_paise,mode,account_last4,ifsc) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (organization_id, reference_id) DO UPDATE SET updated_at=payout_sandbox_payouts.updated_at RETURNING id, status, utr, failure_reason`,
      [id, organizationId, payout.reference, payout.amountPaise, payout.mode, payout.account.slice(-4), payout.ifsc])).rows[0];
    return { id: row.id, status: statusFrom(row.status), utr: row.utr, failureReason: row.failure_reason };
  },
  async fetch(client, organizationId, providerId) {
    const creds = liveCredentials();
    if (creds.keyId && creds.keySecret && creds.account && !providerId.startsWith("pout_sbx")) {
      const response = await fetch(`https://api.razorpay.com/v1/payouts/${encodeURIComponent(providerId)}`, {
        signal: AbortSignal.timeout(15_000), headers: { authorization: `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64")}` },
      });
      const data = await response.json().catch(() => ({})) as { id?: string; status?: string; utr?: string; status_details?: { description?: string }; failure_reason?: string };
      if (!response.ok) throw new Error(`Payouts API answered HTTP ${response.status}`);
      return { id: providerId, status: statusFrom(data.status || "queued"), utr: data.utr ?? null, failureReason: data.status_details?.description || data.failure_reason || null };
    }
    const row = (await client.query(`SELECT id, status, utr, failure_reason, account_last4, extract(epoch from now() - created_at)::float AS age FROM payout_sandbox_payouts WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [organizationId, providerId])).rows[0];
    if (!row) throw new Error(`Sandbox payout ${providerId} not found`);
    let next = row.status as string;
    if (next === "queued" && row.age >= sandboxStep()) next = "processing";
    if (next === "processing" && row.age >= sandboxStep() * 2) next = row.account_last4 === "0000" ? "failed" : "processed";
    if (next !== row.status) {
      const utr = next === "processed" ? `SBXN${new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10).replace(/-/g, "")}${randomBytes(4).toString("hex").toUpperCase()}` : null;
      await client.query(`UPDATE payout_sandbox_payouts SET status=$3, utr=coalesce($4,utr), failure_reason=$5, updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [organizationId, providerId, next, utr, next === "failed" ? "Invalid beneficiary account (sandbox rule: account ends in 0000)" : null]);
      return { id: providerId, status: statusFrom(next), utr, failureReason: next === "failed" ? "Invalid beneficiary account (sandbox rule: account ends in 0000)" : null };
    }
    return { id: providerId, status: statusFrom(row.status), utr: row.utr, failureReason: row.failure_reason };
  },
};

export const ADAPTERS: Record<string, PayoutAdapter> = { H2H_GENERIC: genericH2H, H2H_BANK_CSV: bankCsv, API_RAZORPAYX: razorpayX };

/**
 * Secret used to verify the payout provider's status webhooks (X-Razorpay-Signature). Production: PAYOUTS_WEBHOOK_SECRET
 * only (missing → the webhook refuses to operate). Development: the env value, else a per-install random secret in
 * .data/secrets/payouts-webhook.key (the simulator reads the same file).
 */
export function payoutWebhookSecret() {
  const value = process.env.PAYOUTS_WEBHOOK_SECRET || "";
  const production = (process.env.NODE_ENV || "development") === "production";
  if (value && (!production || value.length >= MIN_WEBHOOK_SECRET)) return { secret: value, source: "env" as const };
  if (production) return { secret: "", source: "missing" as const };
  return { secret: devInstallSecret("payouts-webhook"), source: "dev-install" as const };
}

import './lib/dev-only.mjs'; // refuses to run in production — see the file
// Payout provider webhook simulator (RazorpayX-style) for POST /api/v2/integrations/payouts/webhook.
// Signs the way the API expects: x-payout-timestamp = unix seconds, X-Razorpay-Signature = hex HMAC-SHA256(secret, `${ts}.${raw body}`).
// The secret is PAYOUTS_WEBHOOK_SECRET, else (development) the per-install secret in .data/secrets/payouts-webhook.key.
//
// Usage:
//   node scripts/simulate-payout-webhook.mjs --payout pout_sbx… [--event payout.processed] [--utr UTR123]
//   Extra flags: --replay (send the same signed request twice), --stale (timestamp 10 minutes old),
//                --native (provider-native: sign the raw body only, freshness from the payload's created_at),
//                --bad-signature, --api http://localhost:4100
import "dotenv/config";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
const flag = (name) => process.argv.includes(`--${name}`);

export function payoutSecret() {
  if (process.env.PAYOUTS_WEBHOOK_SECRET) return process.env.PAYOUTS_WEBHOOK_SECRET;
  const file = join(resolve(process.env.DATA_DIR || join(process.cwd(), ".data")), "secrets", "payouts-webhook.key");
  if (!existsSync(file)) throw new Error(`No PAYOUTS_WEBHOOK_SECRET and ${file} does not exist yet (the API creates it on the first webhook or config request).`);
  return readFileSync(file, "utf8").trim();
}

export async function sendPayoutWebhook({ api, payoutId, event = "payout.processed", utr = null, replay = false, stale = false, native = false, badSignature = false }) {
  const secret = badSignature ? "not-the-secret" : payoutSecret();
  const ts = Math.floor(Date.now() / 1000) - (stale ? 600 : 0);
  const body = JSON.stringify({ entity: "event", event, created_at: ts,
    payload: { payout: { entity: { id: payoutId, status: event.replace("payout.", ""), utr, failure_reason: event === "payout.failed" ? "Simulated failure" : null } } } });
  const signature = createHmac("sha256", secret).update(native ? body : `${ts}.${body}`).digest("hex");
  const headers = { "content-type": "application/json", "x-razorpay-signature": signature, "x-razorpay-event-id": `evt_sim${randomBytes(6).toString("hex")}` };
  if (!native) headers["x-payout-timestamp"] = String(ts);
  const send = async () => {
    const response = await fetch(`${api}/api/v2/integrations/payouts/webhook`, { method: "POST", headers, body });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const first = await send();
  return replay ? { first, second: await send() } : first;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const api = arg("api", `http://localhost:${process.env.BACKEND_V2_PORT || 4100}`);
  const payoutId = arg("payout", "");
  if (!payoutId) { console.error("Pass --payout <provider payout id> (see payout_items.provider_payout_id)."); process.exit(1); }
  const result = await sendPayoutWebhook({ api, payoutId, event: arg("event", "payout.processed"), utr: arg("utr", null),
    replay: flag("replay"), stale: flag("stale"), native: flag("native"), badSignature: flag("bad-signature") });
  console.log(JSON.stringify(result, null, 2));
}

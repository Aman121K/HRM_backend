// Tiny local receiver for Northstar outgoing webhooks — shows how a subscriber verifies our signature.
//   node scripts/webhook-receiver.mjs --secret whsec_… [--port 4298] [--fail]
// Point a subscription at http://localhost:4298/hooks (plain http is accepted for localhost in development).
// Verification: signature = hex HMAC-SHA256(secret, `${x-northstar-timestamp}.${raw body}`), sent as "v1=<hex>";
// reject timestamps older than 5 minutes. --fail answers 500 to exercise retries and auto-disable.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
const secret = arg("secret", process.env.WEBHOOK_SECRET || "");
const port = Number(arg("port", "4298"));
const fail = process.argv.includes("--fail");
if (!secret) { console.error("Pass --secret whsec_… (shown once when you create or rotate the subscription)."); process.exit(1); }

export function verify(rawBody, timestamp, signatureHeader, key, toleranceSeconds = 300) {
  if (!timestamp || !signatureHeader) return { ok: false, reason: "missing headers" };
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return { ok: false, reason: "timestamp outside tolerance" };
  const expected = createHmac("sha256", key).update(`${timestamp}.${rawBody}`).digest("hex");
  const given = String(signatureHeader).replace(/^v1=/, "");
  const ok = given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  return ok ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") return response.end("ok");
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const result = verify(raw, request.headers["x-northstar-timestamp"], request.headers["x-northstar-signature"], secret);
    let event = {};
    try { event = JSON.parse(raw); } catch { /* not JSON */ }
    console.log(JSON.stringify({ at: new Date().toISOString(), delivery: request.headers["x-northstar-delivery"], event: request.headers["x-northstar-event"], verified: result.ok, reason: result.reason, id: event.id, data: event.data }));
    if (!result.ok) { response.statusCode = 401; return response.end(JSON.stringify({ error: result.reason })); }
    response.statusCode = fail ? 500 : 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(fail ? { error: "simulated failure" } : { received: true }));
  });
}).listen(port, () => console.log(`Webhook receiver listening on http://localhost:${port}/hooks${fail ? " (answering 500)" : ""}`));

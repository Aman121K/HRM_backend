import './lib/dev-only.mjs'; // refuses to run in production — see the file
// Seeds the Integrations demo through the platform API (so validation, audit and maker-checker all apply):
//  - Tally ledger mapping; a Tally XML export of the latest published payroll run
//  - two biometric devices (ZKTeco via ADMS push, eSSL via the signed JSON API), PIN mappings, today's punches,
//    and a couple of unmapped PINs left in the unmatched queue for HR to resolve
//  - payout batches: an H2H bank-CSV batch for an older locked run (released by a second admin, bank response
//    imported) and a DRAFT API batch for the published run, waiting for a checker to release it
//  - a webhook subscription pointing at the local receiver (scripts/webhook-receiver.mjs)
// Re-runnable: existing records are reused. Demo device/webhook secrets are written to
// scripts/.integrations-demo.local.json (development only) so the simulator can use them.
// Usage: npm run db:seed:integrations        (requires the platform API on BACKEND_V2_PORT)
import "dotenv/config";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { DEMO_FILE, sendAdms, sendHeartbeat, sendJson } from "./simulate-biometric.mjs";

if (process.env.NODE_ENV === "production") throw new Error("Demo seed is for development only.");
const root = `http://localhost:${process.env.BACKEND_V2_PORT || 4100}`;
const api = `${root}/api/v2/integrations`;
const actors = { hr: "BT000", finance: "BT009" };

async function call(actor, path, body, method) {
  const response = await fetch(`${api}${path}`, {
    method: method || (body ? "POST" : "GET"),
    headers: { "content-type": "application/json", "x-tenant-id": "tenant-demo-001", "x-employee-id": actors[actor] },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${actor} ${method || (body ? "POST" : "GET")} ${path}: ${JSON.stringify(data.message)}`);
  return data;
}
const step = (message) => console.log(`• ${message}`);
const demo = existsSync(DEMO_FILE) ? JSON.parse(readFileSync(DEMO_FILE, "utf8")) : {};

// ------------------------------------------------------------------ accounting ledgers
const settings = await call("finance", "/accounting/settings");
if (!settings.configured) {
  await call("finance", "/accounting/settings", { companyName: "Blue Tokai Coffee Roasters Pvt Ltd", ledgers: settings.ledgers, journalVoucherType: "Journal", paymentVoucherType: "Payment", version: settings.version }, "PUT");
  step("Saved Tally ledger mapping");
} else step("Ledger mapping already configured");

// ------------------------------------------------------------------ devices
const deviceSpecs = [
  { key: "admsDevice", serialNumber: "BTK-ZK-IND01", name: "Indiranagar café — entrance", vendor: "ZKTECO", site: "Indiranagar café" },
  { key: "jsonDevice", serialNumber: "BTK-ES-RST01", name: "Roastery — shop floor", vendor: "ESSL", site: "Bengaluru roastery" },
];
const registry = await call("hr", "/devices");
for (const spec of deviceSpecs) {
  const siteId = registry.sites.find((site) => site.name === spec.site)?.id;
  const existing = registry.items.find((item) => item.serialNumber === spec.serialNumber);
  let creds;
  if (!existing) {
    creds = await call("hr", "/devices", { serialNumber: spec.serialNumber, name: spec.name, vendor: spec.vendor, siteId, timezone: "Asia/Kolkata" });
    step(`Registered ${spec.name} (${spec.serialNumber})`);
  } else if (demo[spec.key]?.secret && demo[spec.key]?.serialNumber === spec.serialNumber && existing.status === "ACTIVE"
      // Secrets derive from the install's master key (.data/secrets or INTEGRATIONS_MASTER_KEY): reuse only if still valid.
      && (await sendHeartbeat({ api: root, serial: spec.serialNumber, secret: demo[spec.key].secret })).status === 200) {
    creds = demo[spec.key];
    step(`${spec.name} already registered`);
  } else {
    creds = { ...(await call("hr", `/devices/${existing.id}/rotate`, { version: existing.version })), serialNumber: spec.serialNumber };
    step(`Rotated demo credentials for ${spec.name}`);
  }
  demo[spec.key] = { serialNumber: spec.serialNumber, secret: creds.secret, commKey: creds.commKey };
}

// ------------------------------------------------------------------ PIN mappings (bulk CSV)
const mapped = [["BT001", "1001"], ["BT002", "1002"], ["BT003", "1003"], ["BT004", "1004"], ["BT005", "1005"], ["BT006", "1006"], ["BT007", "1007"], ["BT008", "1008"], ["BT010", "1010"]];
const imported = await call("hr", "/devices/mappings/import", { csv: ["employee_number,device_user_id", ...mapped.map((row) => row.join(","))].join("\n") });
step(`Mappings: ${imported.summary.new} new, ${imported.summary.unchanged} unchanged, ${imported.summary.errors} errors`);
demo.pins = ["1002", "1003", "1004", "1010", "1901"];

// ------------------------------------------------------------------ punches (deterministic per day → re-runs are idempotent)
const IST = 330 * 60_000;
const nowIst = new Date(Date.now() + IST);
const day = new Date(Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate() - (nowIst.getUTCHours() < 10 ? 1 : 0)));
const at = (hour, minute) => day.getTime() + (hour * 60 + minute) * 60_000 - IST;
const shift = (pins, startMinute) => pins.flatMap((pin, index) => [
  { pin, at: at(8, startMinute + ((index * 7) % 19)), type: "IN" },
  { pin, at: at(17, 30 + ((index * 11) % 25)), type: "OUT" },
]).filter((punch) => punch.at < Date.now() - 60_000).sort((a, b) => a.at - b.at);
const adms = await sendAdms({ api: root, serial: demo.admsDevice.serialNumber, commKey: demo.admsDevice.commKey, punches: shift(["1002", "1003", "1004", "1010", "1901"], 40) });
step(`ADMS push from ${demo.admsDevice.serialNumber}: handshake ${adms.handshake.status}, upload ${adms.upload.status} ${adms.upload.body}`);
const json = await sendJson({ api: root, serial: demo.jsonDevice.serialNumber, secret: demo.jsonDevice.secret, punches: shift(["1005", "1006", "1007", "1008", "2044"], 25) });
step(`Signed JSON batch from ${demo.jsonDevice.serialNumber}: HTTP ${json.status}, recorded ${json.body.recorded}, unmatched ${json.body.unmatched}, duplicates ${json.body.duplicates}`);
await sendHeartbeat({ api: root, serial: demo.jsonDevice.serialNumber, secret: demo.jsonDevice.secret });

// ------------------------------------------------------------------ webhooks
const subs = await call("hr", "/webhooks/subscriptions");
let sub = subs.items.find((item) => item.name === "Local demo receiver");
if (!sub) {
  const created = await call("hr", "/webhooks/subscriptions", { name: "Local demo receiver", url: "http://localhost:4298/hooks",
    eventTypes: ["employee.created", "leave.approved", "payroll.published", "attendance.punch", "case.status_changed", "payout.processed", "payout.failed"] });
  demo.webhook = { id: created.id, secret: created.secret, url: "http://localhost:4298/hooks" };
  sub = (await call("hr", "/webhooks/subscriptions")).items.find((item) => item.id === created.id);
  step("Created webhook subscription “Local demo receiver”");
}
const receiverUp = await fetch("http://localhost:4298/health").then((response) => response.ok).catch(() => false);
if (!receiverUp && sub.status === "ACTIVE") {
  await call("hr", `/webhooks/subscriptions/${sub.id}`, { status: "DISABLED", version: sub.version }, "PATCH");
  step("Receiver not running — subscription left disabled (start scripts/webhook-receiver.mjs, then enable it)");
}

// ------------------------------------------------------------------ accounting export
const runs = (await call("finance", "/accounting/runs")).items;
const published = runs.find((run) => run.status === "PUBLISHED") || runs.find((run) => run.exportable);
if (published && !published.lastExportedAt) {
  const file = await call("finance", "/accounting/exports", { kind: "PAYROLL_JOURNAL", format: "TALLY_XML", runId: published.id });
  step(`Exported ${file.fileName} (debit = credit = ₹${file.totals.debit.toLocaleString("en-IN")})`);
} else if (published) step(`${published.period} journal already exported`);

// ------------------------------------------------------------------ payouts
const payoutRuns = (await call("finance", "/payouts/runs")).items;
const locked = payoutRuns.find((run) => run.status === "LOCKED" && run.payable);
if (locked && !locked.batchId) {
  const batch = await call("finance", "/payouts/batches", { runId: locked.id, adapter: "H2H_BANK_CSV", mode: "NEFT" });
  const released = await call("hr", `/payouts/batches/${batch.id}/release`, { version: 1 });
  const payable = released.items.filter((item) => item.status !== "SKIPPED");
  const csv = ["reference,status,utr,reason", ...payable.map((item, index) => `${item.reference},SUCCESS,HDFCN${locked.period.replace("-", "")}${String(index + 1).padStart(6, "0")},`)].join("\n");
  await call("finance", `/payouts/batches/${batch.id}/bank-response`, { csv });
  step(`${locked.period}: bank-CSV batch released by a second admin and settled from the bank response (${payable.length} payouts)`);
} else if (locked) step(`${locked.period} already has a payout batch`);
const approved = payoutRuns.find((run) => run.status === "PUBLISHED" || run.status === "APPROVED");
if (approved && !approved.batchId) {
  const batch = await call("finance", "/payouts/batches", { runId: approved.id, adapter: "API_RAZORPAYX", mode: "NEFT" });
  step(`${approved.period}: draft API batch ₹${batch.totalAmount.toLocaleString("en-IN")} (= run net ₹${batch.runNet.toLocaleString("en-IN")}) waiting for a checker (sign in as HR to release)`);
} else if (approved) step(`${approved.period} already has a payout batch`);

writeFileSync(DEMO_FILE, `${JSON.stringify(demo, null, 2)}\n`, { mode: 0o600 });
step(`Demo credentials written to ${DEMO_FILE} (local development only)`);

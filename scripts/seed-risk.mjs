import './lib/dev-only.mjs'; // refuses to run in production — see the file
// Seeds demo data for the Risk & Compliance Center so every area shows something, then runs a scan per brand.
//   blue-tokai: two people punching from one phone, a split + round-number expense pattern, a claim on a weekly off,
//               a late (recycled) receipt, one bill claimed by two people, a new joiner with declined requests, and
//               April–July statutory filings marked as filed (so only the genuinely open ones remain).
//               The impossible-travel pair, 56 h week, clopen and stuck approvals already exist in earlier seeds.
//   got-tea:    two employees sharing one phone and one bank account (payroll profiles), to prove brand isolation.
// Usage: node scripts/seed-risk.mjs   (needs the platform API with the risk module on BACKEND_V2_PORT; re-runnable)
import "dotenv/config";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Bank account numbers are stored only encrypted (+ blind index + last 4): use the API's own field-crypto build
// (run `npm run build` first) with the keys from .env, exactly like encrypt-sensitive-fields.mjs.
const fieldCrypto = createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), "..", "dist-v2", "platform", "security", "field-crypto.js"));
fieldCrypto.assertFieldCryptoConfigured();
const sealBankAccount = (organizationId, employeeId, account) =>
  fieldCrypto.sealField("bank_account", account, { table: "payroll_profiles", column: "bank_account", organizationId, rowId: employeeId });

const api = `http://localhost:${process.env.BACKEND_V2_PORT || 4100}/api/v2`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const MARK = "Risk demo —";

async function call(slug, employee, path, body, method) {
  const response = await fetch(`${api}${path}`, {
    method: method || (body ? "POST" : "GET"),
    headers: { "content-type": "application/json", "x-tenant-id": slug, "x-employee-id": employee },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${slug}/${employee} ${path}: ${response.status} ${JSON.stringify(data.message)}`);
  return data;
}

/** Runs `work` in a transaction scoped to one brand (RLS is forced on these tables). */
async function tenant(orgId, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [orgId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

const orgs = Object.fromEntries((await pool.query(`SELECT slug, id FROM organizations WHERE slug IN ('blue-tokai','got-tea','suchalis')`)).rows.map((row) => [row.slug, row.id]));
if (!orgs["blue-tokai"] || !orgs["got-tea"]) throw new Error("Run the base and brand seeds first (npm run db:seed, npm run db:seed:brands).");
const ids = async (orgId, numbers) => tenant(orgId, async (client) => Object.fromEntries((await client.query(
  `SELECT employee_number, id FROM employees WHERE organization_id=$1 AND employee_number = ANY($2)`, [orgId, numbers])).rows.map((row) => [row.employee_number, row.id])));

// ---------------------------------------------------------------------------------------------------- punches
async function phonePunch(client, orgId, employeeId, at, lat, lng, key, deviceId, siteId, accuracy = 12) {
  await client.query(
    `INSERT INTO attendance_events(organization_id,employee_id,event_type,occurred_at,latitude,longitude,accuracy_metres,location_captured_at,timezone,device_id,permission,idempotency_key,source,site_id,distance_metres,within_geofence)
     VALUES($1,$2,'IN',$3,$4,$5,$6,$3,'Asia/Kolkata',$7,'granted',$8,'MOBILE',$9,$10,true) ON CONFLICT (organization_id,employee_id,idempotency_key) DO NOTHING`,
    [orgId, employeeId, at, lat, lng, accuracy, deviceId, key, siteId, 18]);
}

const bt = await ids(orgs["blue-tokai"], ["BT000", "BT001", "BT002", "BT003", "BT004", "BT901"]);
const gt = await ids(orgs["got-tea"], ["GT001", "GT003", "GT004", "GT005"]);

await tenant(orgs["blue-tokai"], async (client) => {
  const site = (await client.query(`SELECT id FROM attendance_sites WHERE organization_id=$1 AND name ILIKE 'Indiranagar%'`, [orgs["blue-tokai"]])).rows[0];
  // One Android phone punches Priya in at 07:02 and Arjun at 07:05 (both on the opening shift).
  await phonePunch(client, orgs["blue-tokai"], bt.BT003, "2026-09-28T07:02:00+05:30", 12.97194, 77.64117, "risk-demo-shared-1", "android-5f2c9e81b7a4", site?.id || null);
  await phonePunch(client, orgs["blue-tokai"], bt.BT004, "2026-09-28T07:05:00+05:30", 12.97201, 77.64125, "risk-demo-shared-2", "android-5f2c9e81b7a4", site?.id || null);
});
await tenant(orgs["got-tea"], async (client) => {
  const site = (await client.query(`SELECT id FROM attendance_sites WHERE organization_id=$1 LIMIT 1`, [orgs["got-tea"]])).rows[0];
  await phonePunch(client, orgs["got-tea"], gt.GT003, "2026-09-27T08:58:00+05:30", 19.05962, 72.82951, "risk-demo-shared-1", "ios-a91c77e0d3", site?.id || null);
  await phonePunch(client, orgs["got-tea"], gt.GT004, "2026-09-27T09:01:00+05:30", 19.05958, 72.82947, "risk-demo-shared-2", "ios-a91c77e0d3", site?.id || null);
  await phonePunch(client, orgs["got-tea"], gt.GT005, "2026-09-27T09:03:00+05:30", 19.05965, 72.82955, "risk-demo-shared-3", "ios-a91c77e0d3", site?.id || null);
  // Two payroll profiles pointing at the same account (typed from one cancelled cheque by mistake — or not).
  for (const [employee, name] of [[gt.GT004, "HDFC Bank"], [gt.GT005, "HDFC Bank"]]) {
    const sealed = sealBankAccount(orgs["got-tea"], employee, "50100482211907");
    await client.query(
      `INSERT INTO payroll_profiles(organization_id,employee_id,state_code,bank_name,ifsc,bank_account_enc,bank_account_hash,bank_account_last4)
       VALUES($1,$2,'MH',$3,'HDFC0001234',$4,$5,$6)
       ON CONFLICT (organization_id,employee_id) DO UPDATE SET ifsc=EXCLUDED.ifsc, bank_name=EXCLUDED.bank_name,
         bank_account_enc=EXCLUDED.bank_account_enc, bank_account_hash=EXCLUDED.bank_account_hash, bank_account_last4=EXCLUDED.bank_account_last4`,
      [orgs["got-tea"], employee, name, sealed.enc, sealed.hash, sealed.last4]);
  }
});
console.log("✓ shared-phone punches (blue-tokai, got-tea) and a shared bank account (got-tea)");

// ---------------------------------------------------------------------------------------------------- expenses
const existing = await tenant(orgs["blue-tokai"], async (client) => new Set((await client.query(
  `SELECT title FROM hr_cases WHERE organization_id=$1 AND module='expenses' AND title LIKE $2`, [orgs["blue-tokai"], `${MARK}%`])).rows.map((row) => row.title)));
const claims = [
  ["BT002", { category: "Meals", title: `${MARK} team dinner after stock count (part 1)`, amount: 1400, startDate: "2026-09-27", merchant: "Toit Brewpub" }],
  ["BT002", { category: "Meals", title: `${MARK} team dinner after stock count (part 2)`, amount: 1400, startDate: "2026-09-27", merchant: "Toit Brewpub" }],
  ["BT002", { category: "Local travel", title: `${MARK} cab to roastery`, amount: 1000, startDate: "2026-09-12", merchant: "Ola" }],
  ["BT002", { category: "Local travel", title: `${MARK} cab to supplier`, amount: 1500, startDate: "2026-09-18", merchant: "Ola" }],
  ["BT002", { category: "Local travel", title: `${MARK} cab for weekend event`, amount: 2000, startDate: "2026-09-25", merchant: "Ola" }],
  ["BT002", { category: "Store supplies", title: `${MARK} milk and ice top-up`, amount: 640, startDate: "2026-09-24", merchant: "Chai Point" }],
  ["BT901", { category: "Store supplies", title: `${MARK} milk and ice for the evening rush`, amount: 640, startDate: "2026-09-24", merchant: "Chai Point" }],
  ["BT901", { category: "Store supplies", title: `${MARK} cleaning supplies (old bill)`, amount: 865, startDate: "2026-09-23", merchant: "More Supermarket" }],
];
let created = 0;
for (const [employee, values] of claims) {
  if (existing.has(values.title)) continue;
  await call("blue-tokai", employee, "/cases", { module: "expenses", values });
  created += 1;
}
// The "old bill": the receipt the scanner read is dated 10 July — well over 60 days before the claim.
await tenant(orgs["blue-tokai"], (client) => client.query(
  `UPDATE hr_cases SET details = details || '{"ocr":{"date":"2026-07-10","total":865,"merchant":"MORE SUPERMARKET","provider":"tesseract","confidence":0.91}}'::jsonb
    WHERE organization_id=$1 AND module='expenses' AND title=$2`, [orgs["blue-tokai"], `${MARK} cleaning supplies (old bill)`]));
console.log(`✓ expense claims (${created} created, ${claims.length - created} already present)`);

// ---------------------------------------------------------------------------------------------------- new joiner with declined requests
const types = await call("blue-tokai", "BT901", "/leave-types");
const casual = (types.items || []).find((type) => type.code === "CL");
const mine = await call("blue-tokai", "BT901", "/leaves");
for (const [date, reason] of [["2026-10-12", `${MARK} family function`], ["2026-10-19", `${MARK} college convocation`]]) {
  if ((mine.items || []).some((item) => item.reason === reason)) continue;
  const leave = await call("blue-tokai", "BT901", "/leaves", { leaveTypeId: casual.id, startDate: date, endDate: date, days: 1, reason });
  await call("blue-tokai", "BT001", `/approvals/leaves/${leave.id}/decision`, { decision: "REJECTED", note: "Short-staffed on the weekend roster" });
}
console.log("✓ two declined leave requests for the new joiner (BT901)");

// ---------------------------------------------------------------------------------------------------- filings already done
const hr = await tenant(orgs["blue-tokai"], async (client) => (await client.query(`SELECT user_id FROM employees WHERE organization_id=$1 AND id=$2`, [orgs["blue-tokai"], bt.BT000])).rows[0].user_id);
const filed = ["2026-04", "2026-05", "2026-06", "2026-07"].flatMap((period) => [`PF:${period}`, `ESI:${period}`, `TDS:${period}`, `PT:KA:${period}`, `PT:MH:${period}`]).concat(["24Q:2025-26:Q4", "24Q:2026-27:Q1", "FORM16:2025-26", "TDS:2026-03", "PF:2026-03", "ESI:2026-03", "PT:KA:2026-03"]);
await tenant(orgs["blue-tokai"], async (client) => {
  for (const key of filed)
    await client.query(`INSERT INTO risk_compliance_marks(organization_id,obligation_key,reference,note,marked_by) VALUES($1,$2,$3,'Seeded demo filing',$4) ON CONFLICT DO NOTHING`,
      [orgs["blue-tokai"], key, `DEMO-${key.replace(/[^A-Z0-9]/g, "")}`, hr]);
});
console.log(`✓ ${filed.length} blue-tokai filings marked as filed (April–July)`);

// ---------------------------------------------------------------------------------------------------- scan each brand
for (const [slug, hrNumber] of [["blue-tokai", "BT000"], ["got-tea", "GT001"], ["suchalis", "SA001"]]) {
  if (!orgs[slug]) continue;
  const summary = await call(slug, hrNumber, "/risk/scan", {});
  console.log(`✓ scan ${slug}: ${summary.signals} signals (${summary.created} new, ${summary.reopened} re-opened, ${summary.autoResolved} auto-resolved)${summary.errors?.length ? ` errors: ${summary.errors.join("; ")}` : ""}`);
}
await pool.end();

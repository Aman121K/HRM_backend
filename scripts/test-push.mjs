// End-to-end check of push notifications against the running API (:4100), worker and database.
//   set -a; . ./.env; set +a; node scripts/test-push.mjs
// 1. registers a simulator device for BT002 (dev provider; simctl push when DEV_PUSH_SIMCTL=true in the worker's env),
// 2. category switched off → SUPPRESSED, 3. quiet hours → non-approval dropped + approval deferred,
// 4. 7 events at once → one SUMMARY push (burst collapse), 5. an "invalid-" token → APNs 410 simulated → device deactivated,
// 6. test-push endpoint. Synthetic events (entity_type push_selftest) are deleted afterwards; preferences are restored.
import pg from "pg";
import { Queue } from "bullmq";

const API = process.env.PLATFORM_API_URL || "http://localhost:4100";
const TENANT = "tenant-demo-001";
const EMPLOYEE = "BT002";
const headers = { "x-tenant-id": TENANT, "x-employee-id": EMPLOYEE, "content-type": "application/json" };
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const queue = new Queue("northstar-platform", { connection: { url: process.env.REDIS_URL || "redis://127.0.0.1:6379" } });
let failures = 0;
const check = (label, ok, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); };

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : method === "GET" ? undefined : "{}" });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(json)}`);
  return json;
}

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

const org = (await pool.query(`SELECT o.id FROM organizations o WHERE o.status='ACTIVE' ORDER BY created_at LIMIT 1`)).rows[0].id;
const employeeId = await tenant(org, async (c) => (await c.query(`SELECT id FROM employees WHERE organization_id=$1 AND employee_number=$2`, [org, EMPLOYEE])).rows[0].id);
const created = [];

async function emit(eventType, entityType = "push_selftest", message = `[self-test] ${eventType}`) {
  return tenant(org, async (c) => {
    const id = (await c.query(`INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload) VALUES($1,$2,$3,$4,gen_random_uuid(),$5) RETURNING id`,
      [org, employeeId, eventType, entityType, JSON.stringify({ message, href: "/notifications" })])).rows[0].id;
    created.push(id);
    return Number(id);
  });
}
async function runFanout() {
  await queue.add("notifications.push_fanout", { organizationId: org, trigger: "selftest" }, { removeOnComplete: 50, removeOnFail: 50 });
}
async function waitFor(eventIds, timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const rows = await tenant(org, async (c) => (await c.query(`SELECT event_id, status, reason, collapsed_into, send_after FROM push_notifications WHERE organization_id=$1 AND kind='EVENT' AND event_id=ANY($2::bigint[])`, [org, eventIds])).rows);
    if (rows.length === eventIds.length && rows.every((row) => row.status !== "PENDING" && row.status !== "SENDING" || row.reason === "deferred_quiet_hours")) return rows;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`timed out waiting for events ${eventIds.join(",")} — is the jobs worker running?`);
}

const original = await api("GET", "/api/v2/notifications/preferences");
let deadDevice;
try {
  const device = await api("POST", "/api/v2/notifications/devices", { platform: "ios", provider: "apns", token: "sim-bt002-selftest-000000000000", environment: "simulator", deviceName: "Self-test simulator", bundleId: "com.northstar.people" });
  check("device registered", device.registered === true, device.id);

  // 1. normal event → SENT via dev provider (file + optional simctl)
  let saved = await api("PUT", "/api/v2/notifications/preferences", { ...original, version: original.version });
  const normal = await emit("LEAVE_APPROVED", "leave", "[self-test] Your leave on 2 Oct was approved");
  await runFanout();
  let [row] = await waitFor([normal]);
  check("normal event delivered", row.status === "SENT" || row.status === "PARTIAL", row.status);
  const deliveries = await tenant(org, async (c) => (await c.query(`SELECT d.outcome, d.response FROM push_deliveries d JOIN push_notifications p ON p.id=d.notification_id WHERE p.organization_id=$1 AND p.event_id=$2`, [org, normal])).rows);
  const simctl = deliveries.map((d) => d.response?.simctl).filter(Boolean);
  check("dev provider wrote .data/push file", deliveries.some((d) => String(d.response?.file || "").includes(".data/push")));
  console.log(`      simctl: ${simctl.length ? JSON.stringify(simctl[0]) : "not run (DEV_PUSH_SIMCTL not true in the worker env)"}`);

  // 2. category off → suppressed
  saved = await api("PUT", "/api/v2/notifications/preferences", { ...original, categories: { ...original.categories, time: false }, version: saved.version });
  const muted = await emit("LEAVE_APPROVED", "leave");
  await runFanout();
  [row] = await waitFor([muted]);
  check("category switched off → SUPPRESSED", row.status === "SUPPRESSED" && row.reason === "category_disabled:time", `${row.status} ${row.reason}`);

  // 3. quiet hours covering now (IST): non-approvals dropped, approvals deferred until the window ends
  const nowIst = new Date(Date.now() + 5.5 * 3600_000);
  const hh = (d) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const start = hh(new Date(nowIst.getTime() - 30 * 60_000)); const end = hh(new Date(nowIst.getTime() + 60 * 60_000));
  saved = await api("PUT", "/api/v2/notifications/preferences", { ...original, quietHours: { enabled: true, start, end, timezone: "Asia/Kolkata" }, version: saved.version });
  const quietInfo = await emit("SURVEY_LIVE", "survey");
  const quietApproval = await emit("LEAVE_SUBMITTED", "leave", "[self-test] Priya requested leave");
  await runFanout();
  const quietRows = await waitFor([quietInfo, quietApproval]);
  const info = quietRows.find((r) => Number(r.event_id) === quietInfo); const approval = quietRows.find((r) => Number(r.event_id) === quietApproval);
  check("quiet hours: engagement push dropped", info.status === "SUPPRESSED" && info.reason === "quiet_hours", `${info.status} ${info.reason}`);
  check("quiet hours: approval deferred to window end", approval.status === "PENDING" && approval.reason === "deferred_quiet_hours", `${approval.status} send_after=${new Date(approval.send_after).toISOString()} (window ${start}–${end} IST)`);
  // stale-check with a 409
  const conflict = await fetch(`${API}/api/v2/notifications/preferences`, { method: "PUT", headers, body: JSON.stringify({ ...original, version: 0 }) });
  check("preferences optimistic concurrency → 409 on stale version", conflict.status === 409 || saved.version === 0, String(conflict.status));
  saved = await api("PUT", "/api/v2/notifications/preferences", { ...original, version: saved.version });
  // Release the deferred approval now so it doesn't fire later during the demo.
  await tenant(org, (c) => c.query(`UPDATE push_notifications SET status='SUPPRESSED', reason='selftest_cleanup' WHERE organization_id=$1 AND event_id=$2 AND status='PENDING'`, [org, quietApproval]));

  // 4. burst: 7 events at once → one summary
  const burst = [];
  for (let i = 1; i <= 7; i += 1) burst.push(await emit("LMS_ASSIGNED", "lms_enrollment", `[self-test] Course ${i} assigned`));
  await runFanout();
  const burstRows = await waitFor(burst);
  const collapsedInto = new Set(burstRows.map((r) => r.collapsed_into).filter(Boolean));
  check("burst of 7 → collapsed into one summary push", burstRows.every((r) => r.status === "COLLAPSED") && collapsedInto.size === 1, burstRows.map((r) => r.status).join(","));
  const summary = await tenant(org, async (c) => (await c.query(`SELECT title, body, status FROM push_notifications WHERE id=$1`, [[...collapsedInto][0]])).rows[0]);
  check("summary push sent", summary?.status === "SENT" || summary?.status === "PARTIAL", `${summary?.title} · ${summary?.body?.slice(0, 60)}`);

  // 5. dead token → deactivated
  deadDevice = await api("POST", "/api/v2/notifications/devices", { platform: "ios", provider: "apns", token: "invalid-bt002-dead-token-000000", environment: "sandbox", deviceName: "Dead phone" });
  await new Promise((resolve) => setTimeout(resolve, 61_000 - 0)); // leave the burst window so the next push is not collapsed
  const dead = await emit("PAYSLIP_PUBLISHED", "payslip", "[self-test] Your payslip is ready");
  await runFanout();
  [row] = await waitFor([dead]);
  const deadState = await tenant(org, async (c) => (await c.query(`SELECT active, deactivated_reason FROM push_devices WHERE id=$1`, [deadDevice.id])).rows[0]);
  const deadDelivery = await tenant(org, async (c) => (await c.query(`SELECT outcome, http_status, error FROM push_deliveries WHERE device_id=$1 ORDER BY id DESC LIMIT 1`, [deadDevice.id])).rows[0]);
  check("410 Unregistered → delivery INVALID_TOKEN", deadDelivery?.outcome === "INVALID_TOKEN" && deadDelivery?.http_status === 410, JSON.stringify(deadDelivery));
  check("dead device deactivated", deadState.active === false, deadState.deactivated_reason);
  check("other devices still delivered (PARTIAL)", row.status === "PARTIAL", row.status);

  // 6. test-push endpoint
  const test = await api("POST", "/api/v2/notifications/test-push");
  check("test-push returns per-device results", Array.isArray(test.results) && test.results.length > 0 && test.results.every((r) => !String(r.token).includes("selftest-0000")), `${test.status}: ${test.results.map((r) => `${r.token}=${r.outcome}`).join(", ")}`);

  // read state
  const fresh = await emit("ANNOUNCEMENT_POSTED", "push_selftest", "[self-test] unread check");
  const before = await api("GET", "/api/v2/notifications");
  check("new notification listed as unread", before.items.some((item) => item.id === fresh && item.read === false));
  const read = await api("POST", "/api/v2/notifications/read", { ids: [fresh] });
  check("mark one read lowers unread by 1", read.unread === before.unread - 1, `${before.unread} → ${read.unread}`);
} finally {
  await api("POST", "/api/v2/notifications/devices/unregister", { token: "sim-bt002-selftest-000000000000" }).catch(() => undefined);
  const current = await api("GET", "/api/v2/notifications/preferences").catch(() => null);
  if (current) await api("PUT", "/api/v2/notifications/preferences", { ...original, version: current.version }).catch(() => undefined);
  if (created.length) await tenant(org, async (c) => {
    await c.query(`DELETE FROM notification_reads WHERE organization_id=$1 AND event_id=ANY($2::bigint[])`, [org, created]);
    await c.query(`DELETE FROM workflow_events WHERE organization_id=$1 AND id=ANY($2::bigint[])`, [org, created]);
  });
  await queue.close();
  await pool.end();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll push checks passed");
process.exit(failures ? 1 : 0);

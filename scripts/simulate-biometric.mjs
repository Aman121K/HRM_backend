import './lib/dev-only.mjs'; // refuses to run in production — see the file
// Biometric device simulator for ClanChief integrations.
// Sends realistic punches the way a device (or an eSSL/Mantra middleware bridge) would:
//   json mode — POST /api/v2/integrations/devices/punches, signed with HMAC-SHA256(secret, `${timestamp}.${body}`)
//   adms mode — ZKTeco/eSSL ADMS push: GET /iclock/cdata handshake, then POST table=ATTLOG as tab-separated text
//
// Usage:
//   node scripts/simulate-biometric.mjs                         (uses the demo device written by db:seed:integrations)
//   node scripts/simulate-biometric.mjs --serial SN --secret nsd_… --pins 1001,1002,1010
//   node scripts/simulate-biometric.mjs --mode adms --serial SN --comm-key 123456789012
//   Extra flags: --heartbeat (send a heartbeat only), --bad-signature, --replay (send the same signed request twice),
//                --stale (timestamp 10 minutes old), --count N (punches per PIN, default 2), --api http://localhost:4100
import "dotenv/config";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEMO_FILE = join(dirname(fileURLToPath(import.meta.url)), ".integrations-demo.local.json");

const IST_OFFSET = 330 * 60_000;
/** "YYYY-MM-DD HH:mm:ss" wall-clock in IST (what ADMS devices send). */
const istWall = (ms) => new Date(ms + IST_OFFSET).toISOString().replace("T", " ").slice(0, 19);

/** Realistic shift punches that already happened: IN ~8–9 h ago, OUT a few minutes ago (jittered per person). */
export function shiftPunches(pins, count = 2, now = Date.now()) {
  const punches = [];
  pins.forEach((pin, index) => {
    const jitter = ((index * 7919) % 23) * 60_000;
    const start = now - 8.5 * 3_600_000 - jitter;
    const end = now - 5 * 60_000 - ((index * 31) % 9) * 60_000;
    for (let n = 0; n < count; n += 1) {
      const at = count === 1 ? start : start + ((end - start) * n) / (count - 1);
      const rounded = Math.floor(at / 1000) * 1000;
      punches.push({ pin, at: rounded, type: n % 2 === 0 ? "IN" : "OUT" });
    }
  });
  return punches.sort((a, b) => a.at - b.at);
}

export function sign(secret, timestamp, body) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export async function sendJson({ api, serial, secret, punches, badSignature = false, replay = false, stale = false }) {
  const body = JSON.stringify({ punches: punches.map((punch) => ({
    externalId: `${punch.pin}-${Math.floor(punch.at / 1000)}`, deviceUserId: punch.pin, occurredAt: new Date(punch.at).toISOString(),
    type: punch.type, verifyMode: "FINGER",
  })) });
  const timestamp = Math.floor(Date.now() / 1000) - (stale ? 600 : 0);
  const signature = badSignature ? sign("not-the-secret", timestamp, body) : sign(secret, timestamp, body);
  const send = async () => {
    const response = await fetch(`${api}/api/v2/integrations/devices/punches`, {
      method: "POST", body,
      headers: { "content-type": "application/json", "x-device-serial": serial, "x-timestamp": String(timestamp), "x-signature": `sha256=${signature}` },
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const first = await send();
  return replay ? { first, second: await send() } : first;
}

export async function sendHeartbeat({ api, serial, secret }) {
  const body = JSON.stringify({ firmware: "Ver 6.60 Apr 2026 (sim)", users: 42, pendingPunches: 0 });
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await fetch(`${api}/api/v2/integrations/devices/heartbeat`, {
    method: "POST", body,
    headers: { "content-type": "application/json", "x-device-serial": serial, "x-timestamp": String(timestamp), "x-signature": sign(secret, timestamp, body) },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

export async function sendAdms({ api, serial, commKey, punches }) {
  const qs = (extra) => `SN=${encodeURIComponent(serial)}&key=${encodeURIComponent(commKey)}${extra}`;
  const handshake = await fetch(`${api}/iclock/cdata?${qs("&options=all&pushver=2.4.1&language=69")}`);
  const options = await handshake.text();
  const lines = punches.map((punch) => [punch.pin, istWall(punch.at), punch.type === "OUT" ? "1" : "0", "1", "0", "0", "0"].join("\t")).join("\n");
  const upload = await fetch(`${api}/iclock/cdata?${qs("&table=ATTLOG&Stamp=9999")}`, { method: "POST", headers: { "content-type": "text/plain" }, body: `${lines}\n` });
  const poll = await fetch(`${api}/iclock/getrequest?${qs("")}`);
  return { handshake: { status: handshake.status, body: options }, upload: { status: upload.status, body: await upload.text() }, poll: { status: poll.status, body: await poll.text() } };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
  const flag = (name) => process.argv.includes(`--${name}`);
  const demo = existsSync(DEMO_FILE) ? JSON.parse(readFileSync(DEMO_FILE, "utf8")) : {};
  const mode = arg("mode", "json");
  const device = (mode === "adms" ? demo.admsDevice : demo.jsonDevice) || {};
  const api = arg("api", `http://localhost:${process.env.BACKEND_V2_PORT || 4100}`);
  const serial = arg("serial", process.env.DEVICE_SERIAL || device.serialNumber);
  const secret = arg("secret", process.env.DEVICE_SECRET || device.secret);
  const commKey = arg("comm-key", process.env.DEVICE_COMM_KEY || device.commKey);
  const pins = (arg("pins", "") || (demo.pins || ["1001", "1002", "1003", "1010"]).join(",")).split(",").map((pin) => pin.trim()).filter(Boolean);
  const count = Number(arg("count", "2"));
  if (!serial || (mode === "json" ? !secret : !commKey)) {
    console.error("No device credentials. Run `npm run db:seed:integrations` first, or pass --serial and --secret (json) / --comm-key (adms).");
    process.exit(1);
  }
  const punches = shiftPunches(pins, count);
  let result;
  if (flag("heartbeat")) result = await sendHeartbeat({ api, serial, secret });
  else if (mode === "adms") result = await sendAdms({ api, serial, commKey, punches });
  else result = await sendJson({ api, serial, secret, punches, badSignature: flag("bad-signature"), replay: flag("replay"), stale: flag("stale") });
  console.log(JSON.stringify({ mode, serial, pins, punches: punches.length, result }, null, 2));
}

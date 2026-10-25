import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, createPublicKey, verify } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import type { DeviceProofDto, NetworkEntryDto } from "./attendance.dto";

export type GuardMode = "OFF" | "FLAG" | "BLOCK";
export type PunchSecurityPolicy = { deviceBinding: GuardMode; maxDevices: number; deviceApproval: "FIRST_AUTO" | "ALWAYS_HR"; officeNetwork: GuardMode; routerMac: GuardMode };
export type GuardResult = { deviceRecordId: string | null; reasons: string[]; bssid: string | null; block: { code: string; message: string } | null };
type DeviceRow = { id: string; employee_id: string; status: string };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const normalizeBssid = (value?: string | null) => {
  const hex = (value || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return hex.length === 12 ? hex.match(/.{2}/g)!.join(":") : null;
};
/** The exact bytes a web device signs for a punch; binds the signature to this punch intent. */
export const punchMessage = (type: string, idempotencyKey: string, capturedAt: string) => `northstar-punch|${type}|${idempotencyKey}|${capturedAt}`;

const MESSAGES: Record<string, string> = {
  DEVICE_REQUIRED: "Punch from your registered phone or browser — this request didn't include a device key. Update the app and try again.",
  DEVICE_SIGNATURE_INVALID: "This device couldn't prove its identity. Reload the page (or reopen the app) and try again.",
  DEVICE_OF_ANOTHER_EMPLOYEE: "This device is registered to another employee. Each device can mark attendance for one person only.",
  DEVICE_NOT_REGISTERED: "This isn't your registered device. HR has been asked to approve it — punch from your registered device until then.",
  OFF_OFFICE_NETWORK: "Connect to the office Wi-Fi to punch. Your connection isn't on the office network.",
  WIFI_NOT_REPORTED: "Punch from the mobile app while connected to the office Wi-Fi (the browser can't confirm which Wi-Fi you're on).",
  UNKNOWN_WIFI: "You're connected to a Wi-Fi network that isn't an approved office router. Connect to the office Wi-Fi and try again.",
};
const REASON_FOR: Record<string, string> = {
  DEVICE_REQUIRED: "device_unverified", DEVICE_OF_ANOTHER_EMPLOYEE: "device_of_other_employee", DEVICE_NOT_REGISTERED: "unregistered_device",
  OFF_OFFICE_NETWORK: "off_office_network", WIFI_NOT_REPORTED: "wifi_not_reported", UNKNOWN_WIFI: "unknown_wifi",
};

/**
 * Anti buddy-punching checks the HR head switches on per brand:
 * - device binding: punches only from the employee's registered device, and a device serves exactly one employee;
 * - office network: the request must come from the office's public IP ranges;
 * - router MAC: the mobile app must be connected to an approved office Wi-Fi access point (BSSID).
 * Phones no longer expose their own MAC address (Android 10+/iOS randomize and hide it), so device identity is a
 * hardware-held key instead, and "MAC" means the office router's MAC that the phone is connected to.
 */
@Injectable()
export class PunchGuard {
  /** Device identity: hash of the web public key (signature verified) or of the mobile Keychain secret. */
  private deviceKey(proof: DeviceProofDto | undefined, message: string): { hash: string; publicKey: string | null } | { error: string } | null {
    if (!proof) return null;
    if (proof.kind === "token") return proof.token && proof.token.length >= 32 ? { hash: sha256(`token:${proof.token}`), publicKey: null } : { error: "DEVICE_REQUIRED" };
    if (!proof.publicKey || !proof.signature) return { error: "DEVICE_REQUIRED" };
    try {
      const key = createPublicKey({ key: Buffer.from(proof.publicKey, "base64"), format: "der", type: "spki" });
      if (key.asymmetricKeyType !== "ec") return { error: "DEVICE_SIGNATURE_INVALID" };
      const ok = verify("sha256", Buffer.from(message), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(proof.signature, "base64"));
      return ok ? { hash: sha256(`webkey:${proof.publicKey}`), publicKey: proof.publicKey } : { error: "DEVICE_SIGNATURE_INVALID" };
    } catch { return { error: "DEVICE_SIGNATURE_INVALID" }; }
  }

  async evaluate(client: PoolClient, identity: AuthIdentity, policy: PunchSecurityPolicy,
                 input: { type: string; idempotencyKey: string; capturedAt: string; device?: DeviceProofDto; wifiBssid?: string }, clientIp: string): Promise<GuardResult> {
    const org = identity.organizationId;
    const result: GuardResult = { deviceRecordId: null, reasons: [], bssid: normalizeBssid(input.wifiBssid), block: null };
    const fail = (mode: GuardMode, code: string) => {
      if (code === "DEVICE_SIGNATURE_INVALID") { result.block ||= { code, message: MESSAGES[code] }; return; }
      if (mode === "BLOCK") result.block ||= { code, message: MESSAGES[code] };
      else result.reasons.push(REASON_FOR[code]);
    };

    if (policy.deviceBinding !== "OFF") {
      const key = this.deviceKey(input.device, punchMessage(input.type, input.idempotencyKey, input.capturedAt));
      if (!key) fail(policy.deviceBinding, "DEVICE_REQUIRED");
      else if ("error" in key) fail(policy.deviceBinding, key.error);
      else {
        const rows = (await client.query<DeviceRow>(`SELECT id, employee_id, status FROM attendance_devices WHERE organization_id=$1 AND key_hash=$2 AND status IN ('ACTIVE','PENDING')`, [org, key.hash])).rows;
        const active = rows.find((row) => row.status === "ACTIVE");
        if (active && active.employee_id !== identity.employeeId) fail(policy.deviceBinding, "DEVICE_OF_ANOTHER_EMPLOYEE");
        else if (active) {
          result.deviceRecordId = active.id;
          await client.query(`UPDATE attendance_devices SET last_seen=now() WHERE organization_id=$1 AND id=$2`, [org, active.id]);
        } else {
          const mine = (await client.query(`SELECT count(*)::int AS n FROM attendance_devices WHERE organization_id=$1 AND employee_id=$2 AND status='ACTIVE'`, [org, identity.employeeId])).rows[0].n;
          const platform = input.device!.platform, label = input.device!.label?.slice(0, 80) || null;
          if (policy.deviceApproval === "FIRST_AUTO" && mine < policy.maxDevices) {
            // Trust on first use; the unique index stops two employees binding the same device at the same moment.
            await client.query("SAVEPOINT bind_device");
            try {
              const row = (await client.query(`INSERT INTO attendance_devices(organization_id, employee_id, key_hash, public_key, platform, label, status, decided_at, note)
                  VALUES($1,$2,$3,$4,$5,$6,'ACTIVE',now(),'Registered automatically on first punch') RETURNING id`, [org, identity.employeeId, key.hash, key.publicKey, platform, label])).rows[0];
              await client.query("RELEASE SAVEPOINT bind_device");
              result.deviceRecordId = row.id;
              await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'PUNCH_DEVICE_REGISTERED','attendance_device',$3,$4)`,
                [org, identity.userId, row.id, JSON.stringify({ platform, label, automatic: true })]);
            } catch (error) {
              await client.query("ROLLBACK TO SAVEPOINT bind_device");
              if ((error as { code?: string }).code !== "23505") throw error;
              fail(policy.deviceBinding, "DEVICE_OF_ANOTHER_EMPLOYEE");
            }
          } else {
            const created = (await client.query(`INSERT INTO attendance_devices(organization_id, employee_id, key_hash, public_key, platform, label, status)
                VALUES($1,$2,$3,$4,$5,$6,'PENDING') ON CONFLICT DO NOTHING RETURNING id`, [org, identity.employeeId, key.hash, key.publicKey, platform, label])).rows[0];
            if (created) await this.notifyHr(client, identity, created.id, label || platform);
            fail(policy.deviceBinding, "DEVICE_NOT_REGISTERED");
          }
        }
      }
    }

    if (policy.officeNetwork !== "OFF") {
      const [{ ranges, inside }] = (await client.query(`SELECT count(*)::int AS ranges, coalesce(bool_or($2::inet <<= value::cidr), false) AS inside
          FROM attendance_networks WHERE organization_id=$1 AND kind='IP_RANGE'`, [org, clientIp || "0.0.0.0"])).rows;
      if (ranges > 0 && !inside) fail(policy.officeNetwork, "OFF_OFFICE_NETWORK");
    }

    if (policy.routerMac !== "OFF") {
      const known = (await client.query<{ value: string }>(`SELECT value FROM attendance_networks WHERE organization_id=$1 AND kind='WIFI_BSSID'`, [org])).rows.map((row) => row.value);
      if (known.length) {
        if (!result.bssid) fail(policy.routerMac, "WIFI_NOT_REPORTED");
        else if (!known.includes(result.bssid)) fail(policy.routerMac, "UNKNOWN_WIFI");
      }
    }
    return result;
  }

  /** What the punch screen should tell the person before they punch (advisory, no proof needed). */
  async precheck(client: PoolClient, identity: AuthIdentity, policy: PunchSecurityPolicy, input: { deviceKeyHash?: string; wifiBssid?: string }, clientIp: string) {
    const org = identity.organizationId;
    let device: string = "not_required";
    if (policy.deviceBinding !== "OFF") {
      if (!input.deviceKeyHash) device = "unknown";
      else {
        const rows = (await client.query<DeviceRow>(`SELECT id, employee_id, status FROM attendance_devices WHERE organization_id=$1 AND key_hash=$2 AND status IN ('ACTIVE','PENDING')`, [org, input.deviceKeyHash])).rows;
        const active = rows.find((row) => row.status === "ACTIVE");
        device = active ? (active.employee_id === identity.employeeId ? "registered" : "other_employee")
          : rows.some((row) => row.employee_id === identity.employeeId) ? "pending" : "new";
      }
    }
    const nets = (await client.query(`SELECT kind, value FROM attendance_networks WHERE organization_id=$1`, [org])).rows;
    const ranges = nets.filter((row) => row.kind === "IP_RANGE");
    let network = "not_required";
    if (policy.officeNetwork !== "OFF" && ranges.length)
      network = (await client.query(`SELECT bool_or($1::inet <<= value::cidr) AS inside FROM attendance_networks WHERE organization_id=$2 AND kind='IP_RANGE'`, [clientIp || "0.0.0.0", org])).rows[0].inside ? "office" : "outside";
    const bssids = nets.filter((row) => row.kind === "WIFI_BSSID").map((row) => row.value);
    const bssid = normalizeBssid(input.wifiBssid);
    const wifi = policy.routerMac === "OFF" || !bssids.length ? "not_required" : !bssid ? "not_reported" : bssids.includes(bssid) ? "office" : "unknown";
    return { device, network, wifi, modes: { device: policy.deviceBinding, network: policy.officeNetwork, wifi: policy.routerMac } };
  }

  private async notifyHr(client: PoolClient, identity: AuthIdentity, deviceId: string, label: string) {
    const who = (await client.query(`SELECT full_name FROM employees WHERE organization_id=$1 AND id=$2`, [identity.organizationId, identity.employeeId])).rows[0]?.full_name || "An employee";
    await client.query(`INSERT INTO workflow_events(organization_id, employee_id, event_type, entity_type, entity_id, payload)
        SELECT $1, e.id, 'PUNCH_DEVICE_REQUESTED', 'attendance_device', $2, $3 FROM employees e
          JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.user_id=e.user_id AND m.status='ACTIVE' AND m.role IN ('HR_ADMIN','OWNER')
         WHERE e.organization_id=$1`,
      [identity.organizationId, deviceId, JSON.stringify({ message: `${who} wants to punch from a new device (${label}).`, href: "/attendance#devices" })]);
  }

  // ---------- HR management ----------

  async devices(client: PoolClient, identity: AuthIdentity, isHr: boolean, status?: string) {
    return (await client.query(`SELECT d.id, d.platform, d.label, d.status, d.first_seen AS "firstSeen", d.last_seen AS "lastSeen", d.decided_at AS "decidedAt", d.note, d.version,
        e.id AS "employeeId", e.full_name AS "employeeName", e.employee_number AS "employeeNumber", e.designation, u.full_name AS "decidedBy",
        (SELECT count(*)::int FROM attendance_events a WHERE a.organization_id=d.organization_id AND a.device_record_id=d.id) AS punches
       FROM attendance_devices d JOIN employees e ON e.id=d.employee_id AND e.organization_id=d.organization_id LEFT JOIN users u ON u.id=d.decided_by
      WHERE d.organization_id=$1 AND ($2::boolean OR d.employee_id=$3) AND ($4::text IS NULL OR d.status=$4)
      ORDER BY (d.status='PENDING') DESC, d.last_seen DESC LIMIT 500`, [identity.organizationId, isHr, identity.employeeId, status || null])).rows;
  }

  /** APPROVE (replacing the employee's oldest device when at the limit), REJECT a request, or REVOKE an active device. */
  async decideDevice(client: PoolClient, identity: AuthIdentity, policy: PunchSecurityPolicy, id: string, decision: "APPROVE" | "REJECT" | "REVOKE", note?: string) {
    const org = identity.organizationId;
    const device = (await client.query(`SELECT * FROM attendance_devices WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [org, id])).rows[0];
    if (!device) throw new NotFoundException("Device not found.");
    if (decision === "REVOKE" && device.status !== "ACTIVE") throw new ConflictException("Only active devices can be revoked.");
    if (decision !== "REVOKE" && device.status !== "PENDING") throw new ConflictException("This request was already decided.");
    let replaced: string[] = [];
    if (decision === "APPROVE") {
      const owner = (await client.query(`SELECT employee_id FROM attendance_devices WHERE organization_id=$1 AND key_hash=$2 AND status='ACTIVE'`, [org, device.key_hash])).rows[0];
      if (owner) throw new ConflictException("This device is registered to another employee. Revoke it there first.");
      const active = (await client.query(`SELECT id FROM attendance_devices WHERE organization_id=$1 AND employee_id=$2 AND status='ACTIVE' ORDER BY last_seen`, [org, device.employee_id])).rows;
      replaced = active.slice(0, Math.max(0, active.length - policy.maxDevices + 1)).map((row) => row.id);
      if (replaced.length) await client.query(`UPDATE attendance_devices SET status='REVOKED', decided_by=$3, decided_at=now(), note='Replaced by a newly approved device', version=version+1 WHERE organization_id=$1 AND id = ANY($2)`, [org, replaced, identity.userId]);
    }
    const status = decision === "APPROVE" ? "ACTIVE" : "REVOKED";
    await client.query(`UPDATE attendance_devices SET status=$3, decided_by=$4, decided_at=now(), note=$5, version=version+1 WHERE organization_id=$1 AND id=$2`,
      [org, id, status, identity.userId, note?.trim() || (decision === "REJECT" ? "Request rejected" : decision === "REVOKE" ? "Revoked by HR" : "Approved by HR")]);
    await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,'attendance_device',$4,$5,$6)`,
      [org, identity.userId, `PUNCH_DEVICE_${decision}`, id, JSON.stringify({ status: device.status }), JSON.stringify({ status, replaced, note: note || null })]);
    const text = decision === "APPROVE" ? "Your new device is approved — you can punch from it now." : decision === "REJECT" ? "Your request to punch from a new device was declined. Contact HR." : "A punch device was removed from your account by HR.";
    await client.query(`INSERT INTO workflow_events(organization_id, employee_id, event_type, entity_type, entity_id, payload) VALUES($1,$2,$3,'attendance_device',$4,$5)`,
      [org, device.employee_id, `PUNCH_DEVICE_${decision}`, id, JSON.stringify({ message: text, href: "/attendance" })]);
    return { status, replaced: replaced.length };
  }

  async networks(client: PoolClient, organizationId: string) {
    return (await client.query(`SELECT n.id, n.kind, n.value, n.label, n.site_id AS "siteId", s.name AS "siteName", n.created_at AS "createdAt"
        FROM attendance_networks n LEFT JOIN attendance_sites s ON s.id=n.site_id AND s.organization_id=n.organization_id WHERE n.organization_id=$1 ORDER BY n.kind, n.label NULLS LAST, n.value`, [organizationId])).rows;
  }

  /** Replaces the office network list; IPs are normalized to CIDR networks and BSSIDs to aa:bb:cc:dd:ee:ff. */
  async saveNetworks(client: PoolClient, identity: AuthIdentity, items: NetworkEntryDto[]) {
    const org = identity.organizationId;
    const normalized: { kind: string; value: string; label: string | null; siteId: string | null }[] = [];
    for (const item of items) {
      let value: string | null;
      if (item.kind === "WIFI_BSSID") value = normalizeBssid(item.value);
      else {
        await client.query("SAVEPOINT net");
        try { value = (await client.query(`SELECT network($1::inet)::text AS v`, [item.value.trim()])).rows[0].v; await client.query("RELEASE SAVEPOINT net"); }
        catch { await client.query("ROLLBACK TO SAVEPOINT net"); value = null; }
      }
      if (!value) throw new BadRequestException(`"${item.value}" isn't a valid ${item.kind === "WIFI_BSSID" ? "router MAC address (e.g. a4:2b:b0:3c:11:9f)" : "IP address or range (e.g. 49.36.12.40 or 49.36.12.0/24)"}.`);
      if (value === "0.0.0.0/0" || value === "::/0") throw new BadRequestException("That range would allow every network. Enter your office's public IP.");
      if (!normalized.some((row) => row.kind === item.kind && row.value === value)) normalized.push({ kind: item.kind, value, label: item.label?.trim() || null, siteId: item.siteId || null });
    }
    const before = await this.networks(client, org);
    await client.query(`DELETE FROM attendance_networks WHERE organization_id=$1`, [org]);
    for (const row of normalized)
      await client.query(`INSERT INTO attendance_networks(organization_id, kind, value, label, site_id, created_by) VALUES($1,$2,$3,$4,$5,$6)`, [org, row.kind, row.value, row.label, row.siteId, identity.userId]);
    await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,'ATTENDANCE_NETWORKS_UPDATED','attendance_policy',$1,$3,$4)`,
      [org, identity.userId, JSON.stringify(before.map((row) => ({ kind: row.kind, value: row.value }))), JSON.stringify(normalized)]);
    return this.networks(client, org);
  }
}

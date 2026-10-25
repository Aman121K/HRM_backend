import { ConflictException, ForbiddenException, Injectable, BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import type { MarkReadDto, PreferencesDto, RegisterDeviceDto, UnregisterDeviceDto } from "./notifications.dto";
import { CATEGORIES, maskToken } from "./push-policy";
import { preferencesFromRow, unreadCount } from "./push.service";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

@Injectable()
export class NotificationsService {
  constructor(private readonly database: DatabaseService) {}

  private requireEmployee(identity: AuthIdentity) {
    if (!identity.employeeId) throw new ForbiddenException("Notifications are available to employees only.");
  }

  /** GET /notifications — newest 50 above `after`, each with `read`; `unread` counts everything unread. */
  list(identity: AuthIdentity, after: number) {
    this.requireEmployee(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const cursor = Number((await client.query(`SELECT read_through FROM notification_read_cursors WHERE organization_id=$1 AND employee_id=$2`,
        [identity.organizationId, identity.employeeId])).rows[0]?.read_through || 0);
      const result = await client.query(
        `SELECT w.id,w.event_type AS "eventType",w.entity_type AS "entityType",w.entity_id AS "entityId",w.payload,w.created_at AS "createdAt",
                (w.id <= $4 OR r.event_id IS NOT NULL) AS read
           FROM workflow_events w
           LEFT JOIN notification_reads r ON r.organization_id=w.organization_id AND r.employee_id=w.employee_id AND r.event_id=w.id
          WHERE w.organization_id=$1 AND w.employee_id=$2 AND w.id>$3 ORDER BY w.id DESC LIMIT 50`,
        [identity.organizationId, identity.employeeId, after, cursor]);
      const items = result.rows.map((row) => ({ ...row, id: Number(row.id) }));
      return { items, unread: await unreadCount(client, identity.organizationId, identity.employeeId), readThrough: cursor, nextCursor: items[0]?.id || after };
    });
  }

  /** POST /notifications/read — {ids} marks specific notifications, {all:true} moves the read cursor to the newest. */
  markRead(identity: AuthIdentity, input: MarkReadDto) {
    this.requireEmployee(identity);
    if (!input.all && !input.ids?.length) throw new BadRequestException("Send ids or all:true.");
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      let marked = 0;
      if (input.all) {
        const head = Number((await client.query(`SELECT coalesce(max(id),0) AS head FROM workflow_events WHERE organization_id=$1 AND employee_id=$2`, [org, identity.employeeId])).rows[0].head);
        await client.query(
          `INSERT INTO notification_read_cursors(organization_id,employee_id,read_through) VALUES($1,$2,$3)
           ON CONFLICT (organization_id,employee_id) DO UPDATE SET read_through=greatest(notification_read_cursors.read_through,EXCLUDED.read_through), updated_at=now()`,
          [org, identity.employeeId, head]);
        marked = (await client.query(`DELETE FROM notification_reads WHERE organization_id=$1 AND employee_id=$2 AND event_id <= $3`, [org, identity.employeeId, head])).rowCount || 0;
      } else {
        // Only the caller's own notifications, and only ones above the cursor (the rest are already read).
        marked = (await client.query(
          `INSERT INTO notification_reads(organization_id,employee_id,event_id)
           SELECT w.organization_id, w.employee_id, w.id FROM workflow_events w
            WHERE w.organization_id=$1 AND w.employee_id=$2 AND w.id = ANY($3::bigint[])
              AND w.id > coalesce((SELECT read_through FROM notification_read_cursors c WHERE c.organization_id=$1 AND c.employee_id=$2),0)
           ON CONFLICT DO NOTHING`, [org, identity.employeeId, input.ids])).rowCount || 0;
      }
      return { ok: true, marked, unread: await unreadCount(client, org, identity.employeeId) };
    });
  }

  registerDevice(identity: AuthIdentity, input: RegisterDeviceDto) {
    this.requireEmployee(identity);
    if (input.platform === "ios" && input.provider !== "apns" && input.provider !== "fcm") throw new BadRequestException("Unsupported provider.");
    if (input.platform === "android" && input.provider !== "fcm") throw new BadRequestException("Android devices register with provider fcm.");
    const environment = input.environment || (input.provider === "apns" ? process.env.APNS_ENV === "sandbox" ? "sandbox" : "production" : "production");
    const tokenHash = hashToken(input.token);
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const previous = (await client.query(`SELECT id, employee_id, active FROM push_devices WHERE organization_id=$1 AND provider=$2 AND token_hash=$3`, [org, input.provider, tokenHash])).rows[0];
      const row = (await client.query(
        `INSERT INTO push_devices(organization_id,user_id,employee_id,platform,provider,token,token_hash,environment,app_version,device_name,bundle_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (organization_id,provider,token_hash) DO UPDATE SET user_id=EXCLUDED.user_id, employee_id=EXCLUDED.employee_id, platform=EXCLUDED.platform,
           token=EXCLUDED.token, environment=EXCLUDED.environment, app_version=EXCLUDED.app_version, device_name=EXCLUDED.device_name, bundle_id=EXCLUDED.bundle_id,
           active=true, deactivated_at=NULL, deactivated_reason=NULL, last_seen_at=now(), updated_at=now()
         RETURNING id`,
        [org, identity.userId, identity.employeeId, input.platform, input.provider, input.token, tokenHash, environment,
          input.appVersion?.trim() || null, input.deviceName?.trim() || null, input.bundleId || null])).rows[0];
      // Audit new registrations, re-binding to another person and re-activation — not every app launch.
      if (!previous || previous.employee_id !== identity.employeeId || !previous.active)
        await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,'push_device',$4,$5,$6)`,
          [org, identity.userId, previous ? (previous.employee_id !== identity.employeeId ? "PUSH_DEVICE_REBOUND" : "PUSH_DEVICE_REACTIVATED") : "PUSH_DEVICE_REGISTERED", row.id,
            previous ? JSON.stringify({ employeeId: previous.employee_id, active: previous.active }) : null,
            JSON.stringify({ employeeId: identity.employeeId, platform: input.platform, provider: input.provider, environment, token: maskToken(input.token), deviceName: input.deviceName || null })]);
      return { id: row.id, registered: true };
    });
  }

  unregisterDevice(identity: AuthIdentity, input: UnregisterDeviceDto) {
    this.requireEmployee(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const rows = (await client.query(
        `UPDATE push_devices SET active=false, deactivated_at=now(), deactivated_reason='signed_out', updated_at=now()
          WHERE organization_id=$1 AND token_hash=$2 AND employee_id=$3 AND active RETURNING id`,
        [identity.organizationId, hashToken(input.token), identity.employeeId])).rows;
      for (const row of rows)
        await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'PUSH_DEVICE_UNREGISTERED','push_device',$3,$4)`,
          [identity.organizationId, identity.userId, row.id, JSON.stringify({ token: maskToken(input.token) })]);
      // Idempotent: unknown or already-removed tokens also answer removed:true (sign-out must never fail on this).
      return { removed: true };
    });
  }

  devices(identity: AuthIdentity) {
    this.requireEmployee(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const rows = (await client.query(
        `SELECT d.id, d.platform, d.provider, d.token, d.environment, d.app_version AS "appVersion", d.device_name AS "deviceName", d.bundle_id AS "bundleId",
                d.active, d.deactivated_reason AS "deactivatedReason", d.last_seen_at AS "lastSeenAt", d.created_at AS "createdAt",
                l.outcome AS "lastOutcome", l.created_at AS "lastDeliveryAt"
           FROM push_devices d
           LEFT JOIN LATERAL (SELECT outcome, created_at FROM push_deliveries p WHERE p.organization_id=d.organization_id AND p.device_id=d.id ORDER BY p.created_at DESC LIMIT 1) l ON true
          WHERE d.organization_id=$1 AND d.employee_id=$2 ORDER BY d.active DESC, d.last_seen_at DESC LIMIT 50`,
        [identity.organizationId, identity.employeeId])).rows;
      return {
        items: rows.map(({ token, lastOutcome, lastDeliveryAt, ...row }) => ({
          ...row, token: maskToken(token), lastDelivery: lastOutcome ? { outcome: lastOutcome, at: lastDeliveryAt } : null,
        })),
      };
    });
  }

  preferences(identity: AuthIdentity) {
    this.requireEmployee(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(`SELECT * FROM notification_preferences WHERE organization_id=$1 AND employee_id=$2`, [identity.organizationId, identity.employeeId])).rows[0];
      return preferencesFromRow(row);
    });
  }

  updatePreferences(identity: AuthIdentity, input: PreferencesDto) {
    this.requireEmployee(identity);
    try { new Intl.DateTimeFormat("en-GB", { timeZone: input.quietHours.timezone }); } catch { throw new BadRequestException("quietHours.timezone must be an IANA time zone, e.g. Asia/Kolkata."); }
    const categories = Object.fromEntries(CATEGORIES.map((category) => [category, input.categories[category]]));
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const current = (await client.query(`SELECT * FROM notification_preferences WHERE organization_id=$1 AND employee_id=$2 FOR UPDATE`, [org, identity.employeeId])).rows[0];
      const currentVersion = current ? Number(current.version) : 0;
      if (input.version !== undefined && input.version !== currentVersion)
        throw new ConflictException("Your notification settings changed on another device. Refresh and try again.");
      const values = [org, identity.employeeId, JSON.stringify(categories), input.quietHours.enabled, input.quietHours.start, input.quietHours.end,
        input.quietHours.timezone, input.channels.push, input.channels.email];
      const row = current
        ? (await client.query(
          `UPDATE notification_preferences SET categories=$3, quiet_enabled=$4, quiet_start=$5, quiet_end=$6, timezone=$7, channel_push=$8, channel_email=$9,
                  version=version+1, updated_at=now() WHERE organization_id=$1 AND employee_id=$2 RETURNING *`, values)).rows[0]
        : (await client.query(
          `INSERT INTO notification_preferences(organization_id,employee_id,categories,quiet_enabled,quiet_start,quiet_end,timezone,channel_push,channel_email)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, values)).rows[0];
      const after = preferencesFromRow(row);
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,'NOTIFICATION_PREFERENCES_UPDATED','employee',$3,$4,$5)`,
        [org, identity.userId, identity.employeeId, current ? JSON.stringify(preferencesFromRow(current)) : null, JSON.stringify(after)]);
      return after;
    });
  }
}

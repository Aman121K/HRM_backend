// Push fan-out and delivery. workflow_events → push_notifications (one row per event, with the preference decision)
// → provider sends recorded in push_deliveries. Runs in the jobs worker (notifications.push_fanout, every 15 s) and
// can be triggered immediately with jobs.enqueue("notifications.push_fanout", { organizationId }).
import { Injectable, Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { throwIfAborted } from "../jobs/job-context";
import {
  BURST_WINDOW_MS, CATEGORIES, MAX_ATTEMPTS, STALE_EVENT_MS, contentFor, decide, defaultPreferences, maskToken, retryDelayMs, shouldCollapse,
  summaryContent, type Category, type PushData, type PushMessage, type Preferences,
} from "./push-policy";
import { PushProviders, type PushTarget, type SendResult } from "./push-providers";

/** How long an event id may stay "in flight" (its transaction not yet committed) before the cursor moves past it. */
const LOOKBACK_SECONDS = 120;
const BATCH = 500;
const SEND_BATCH = 200;

type EventRow = { id: string; employee_id: string; event_type: string; entity_type: string; entity_id: string; payload: Record<string, unknown>; created_at: Date };
type QueueRow = { id: string; employee_id: string; kind: string; category: string; title: string; body: string; data: PushData; attempts: number };
type DeviceRow = { id: string; employee_id: string; platform: string; provider: string; token: string; environment: string; bundle_id: string | null };
export type DeviceResult = {
  deviceId: string; platform: string; provider: string; token: string; environment: string;
  via: SendResult["provider"]; outcome: SendResult["outcome"]; httpStatus: number | null; error: string | null;
  response: Record<string, unknown> | null; deactivated: boolean;
};

export function preferencesFromRow(row: Record<string, unknown> | undefined): Preferences {
  const prefs = defaultPreferences();
  if (!row) return prefs;
  const stored = (row.categories || {}) as Record<string, unknown>;
  for (const category of CATEGORIES) if (typeof stored[category] === "boolean") prefs.categories[category] = stored[category] as boolean;
  prefs.quietHours = { enabled: !!row.quiet_enabled, start: String(row.quiet_start).slice(0, 5), end: String(row.quiet_end).slice(0, 5), timezone: String(row.timezone) };
  prefs.channels = { push: !!row.channel_push, email: !!row.channel_email };
  prefs.version = Number(row.version);
  return prefs;
}

@Injectable()
export class PushService {
  private readonly logger = new Logger("Push");
  constructor(private readonly database: DatabaseService, private readonly providers: PushProviders) {}

  private systemIdentity(organizationId: string): AuthIdentity {
    return { organizationId, userId: "", employeeId: "", roles: ["SYSTEM"] };
  }

  /** Job handler: fan out + deliver for one organization (payload.organizationId) or every active organization. */
  async run(payload: Record<string, unknown>) {
    const values: unknown[] = [];
    let where = "status='ACTIVE'";
    if (typeof payload.organizationId === "string") { values.push(payload.organizationId); where += " AND id=$1"; }
    const organizations = (await this.database.query<{ id: string; slug: string }>(`SELECT id, slug FROM organizations WHERE ${where} ORDER BY created_at, id`, values)).rows;
    const totals: Record<string, number> = { organizations: organizations.length, events: 0, queued: 0, suppressed: 0, noDevices: 0, sent: 0, failed: 0, retried: 0, collapsed: 0, deactivated: 0 };
    for (const organization of organizations) {
      throwIfAborted();
      const fan = await this.fanout(organization.id);
      const sent = await this.deliverDue(organization.id);
      for (const [key, value] of Object.entries({ ...fan, ...sent })) totals[key] = (totals[key] || 0) + value;
      if (fan.events || sent.sent || sent.failed)
        this.logger.log(JSON.stringify({ event: "push_fanout", org: organization.slug, ...fan, ...sent }));
    }
    return totals;
  }

  /** Turns new workflow_events into queue rows. Idempotent: the unique (organization_id,event_id) index skips repeats. */
  async fanout(organizationId: string) {
    const counters = { events: 0, queued: 0, suppressed: 0, noDevices: 0 };
    await this.database.tenantTransaction(this.systemIdentity(organizationId), async (client) => {
      // First run for an organization starts at the current head (history is not pushed).
      await client.query(
        `INSERT INTO push_fanout_cursors(organization_id,last_event_id) SELECT $1, coalesce(max(id),0) FROM workflow_events WHERE organization_id=$1
         ON CONFLICT (organization_id) DO NOTHING`, [organizationId]);
      const cursor = (await client.query(`SELECT last_event_id FROM push_fanout_cursors WHERE organization_id=$1 FOR UPDATE SKIP LOCKED`, [organizationId])).rows[0];
      if (!cursor) return; // another worker holds this organization right now
      const events = (await client.query<EventRow>(
        `SELECT w.id, w.employee_id, w.event_type, w.entity_type, w.entity_id, w.payload, w.created_at
           FROM workflow_events w
          WHERE w.organization_id=$1 AND w.id>$2 AND w.employee_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM push_notifications p WHERE p.organization_id=w.organization_id AND p.kind='EVENT' AND p.event_id=w.id)
          ORDER BY w.id LIMIT ${BATCH}`, [organizationId, cursor.last_event_id])).rows;
      // Advance past everything that is old enough that no transaction can still commit a lower id.
      await client.query(
        `UPDATE push_fanout_cursors SET updated_at=now(), last_event_id=greatest(last_event_id, coalesce(
           (SELECT max(id) FROM workflow_events WHERE organization_id=$1 AND id>$2 AND created_at < now() - make_interval(secs => $3)
              AND ($4::bigint IS NULL OR id <= $4)), 0))
         WHERE organization_id=$1`, [organizationId, cursor.last_event_id, LOOKBACK_SECONDS, events.length === BATCH ? events[events.length - 1].id : null]);
      if (!events.length) return;
      counters.events = events.length;
      const employees = [...new Set(events.map((event) => event.employee_id))];
      const prefs = new Map((await client.query(`SELECT * FROM notification_preferences WHERE organization_id=$1 AND employee_id=ANY($2::uuid[])`, [organizationId, employees])).rows
        .map((row) => [row.employee_id as string, preferencesFromRow(row)]));
      const withDevices = new Set((await client.query(`SELECT DISTINCT employee_id FROM push_devices WHERE organization_id=$1 AND active AND employee_id=ANY($2::uuid[])`,
        [organizationId, employees])).rows.map((row) => row.employee_id as string));
      const now = new Date();
      for (const event of events) {
        const content = contentFor({ id: event.id, eventType: event.event_type, entityType: event.entity_type, entityId: event.entity_id, payload: event.payload || {} });
        let status: string; let reason: string | null; let sendAfter = now;
        if (!withDevices.has(event.employee_id)) { status = "NO_DEVICES"; reason = null; counters.noDevices += 1; }
        else if (now.getTime() - new Date(event.created_at).getTime() > STALE_EVENT_MS) { status = "SUPPRESSED"; reason = "stale"; counters.suppressed += 1; }
        else {
          const decision = decide(prefs.get(event.employee_id) || defaultPreferences(), content.category, now);
          status = decision.status; reason = decision.reason; sendAfter = decision.sendAfter;
          if (status === "PENDING") counters.queued += 1; else counters.suppressed += 1;
        }
        await client.query(
          `INSERT INTO push_notifications(organization_id,employee_id,kind,event_id,category,title,body,data,status,reason,send_after)
           VALUES($1,$2,'EVENT',$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (organization_id,event_id) WHERE kind='EVENT' DO NOTHING`,
          [organizationId, event.employee_id, event.id, content.category, content.title, content.body, JSON.stringify(content.data), status, reason, sendAfter]);
      }
    });
    return counters;
  }

  /** Sends due queue rows. Bursts per recipient collapse into one summary push. Network I/O happens outside transactions. */
  async deliverDue(organizationId: string) {
    const counters = { sent: 0, failed: 0, retried: 0, collapsed: 0, deactivated: 0 };
    const identity = this.systemIdentity(organizationId);
    const plan = await this.database.tenantTransaction(identity, async (client) => {
      await client.query(`UPDATE push_notifications SET status='PENDING', updated_at=now() WHERE organization_id=$1 AND status='SENDING' AND updated_at < now() - interval '5 minutes'`, [organizationId]);
      const claimed = (await client.query<QueueRow>(
        `UPDATE push_notifications SET status='SENDING', attempts=attempts+1, updated_at=now()
          WHERE id IN (SELECT id FROM push_notifications WHERE organization_id=$1 AND status='PENDING' AND send_after<=now() ORDER BY id LIMIT ${SEND_BATCH} FOR UPDATE SKIP LOCKED)
          RETURNING id, employee_id, kind, category, title, body, data, attempts`, [organizationId])).rows;
      if (!claimed.length) return [];
      const byEmployee = new Map<string, QueueRow[]>();
      for (const row of claimed.sort((a, b) => Number(a.id) - Number(b.id))) byEmployee.set(row.employee_id, [...(byEmployee.get(row.employee_id) || []), row]);
      const toSend: QueueRow[] = [];
      for (const [employeeId, rows] of byEmployee) {
        const recent = Number((await client.query(
          `SELECT count(*) FROM push_notifications WHERE organization_id=$1 AND employee_id=$2 AND status IN ('SENT','PARTIAL') AND sent_at > now() - make_interval(secs => $3)`,
          [organizationId, employeeId, BURST_WINDOW_MS / 1000])).rows[0].count);
        const events = rows.filter((row) => row.kind === "EVENT");
        if (shouldCollapse(events.length, recent)) {
          const summary = summaryContent(events);
          const inserted = (await client.query<QueueRow>(
            `INSERT INTO push_notifications(organization_id,employee_id,kind,category,title,body,data,status,reason,attempts)
             VALUES($1,$2,'SUMMARY',$3,$4,$5,$6,'SENDING',$7,1) RETURNING id, employee_id, kind, category, title, body, data, attempts`,
            [organizationId, employeeId, summary.category, summary.title, summary.body, JSON.stringify(summary.data), `collapsed ${events.length} (recent ${recent})`])).rows[0];
          await client.query(`UPDATE push_notifications SET status='COLLAPSED', collapsed_into=$3, updated_at=now() WHERE organization_id=$1 AND id=ANY($2::bigint[])`,
            [organizationId, events.map((row) => row.id), inserted.id]);
          counters.collapsed += events.length;
          toSend.push(inserted, ...rows.filter((row) => row.kind !== "EVENT"));
        } else toSend.push(...rows);
      }
      return toSend;
    });
    for (const row of plan) {
      throwIfAborted();
      const outcome = await this.deliver(organizationId, row);
      counters.sent += outcome.status === "SENT" || outcome.status === "PARTIAL" ? 1 : 0;
      counters.failed += outcome.status === "FAILED" ? 1 : 0;
      counters.retried += outcome.status === "PENDING" ? 1 : 0;
      counters.deactivated += outcome.results.filter((item) => item.deactivated).length;
    }
    return counters;
  }

  /** Sends one queue row (already SENDING) to every active device of its recipient and records the outcome. */
  async deliver(organizationId: string, row: QueueRow): Promise<{ status: string; results: DeviceResult[] }> {
    const identity = this.systemIdentity(organizationId);
    const { devices, badge } = await this.database.tenantTransaction(identity, async (client) => ({
      devices: (await client.query<DeviceRow>(`SELECT id, employee_id, platform, provider, token, environment, bundle_id FROM push_devices WHERE organization_id=$1 AND employee_id=$2 AND active ORDER BY created_at`,
        [organizationId, row.employee_id])).rows,
      badge: await unreadCount(client, organizationId, row.employee_id),
    }));
    const message: PushMessage = {
      notificationId: String(row.id), title: row.title, body: row.body, badge, category: row.category,
      data: { ...row.data, notificationId: String(row.id) },
    };
    const sends = await Promise.all(devices.map(async (device) => ({ device, sent: await this.providers.send(toTarget(device), message) })));
    return this.database.tenantTransaction(identity, async (client) => {
      const results: DeviceResult[] = [];
      for (const { device, sent } of sends) {
        await client.query(
          `INSERT INTO push_deliveries(organization_id,notification_id,device_id,provider,outcome,http_status,provider_message_id,response,error,duration_ms)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [organizationId, row.id, device.id, sent.provider, sent.outcome, sent.httpStatus, sent.messageId, sent.response ? JSON.stringify(sent.response) : null, sent.error?.slice(0, 1000) || null, sent.durationMs]);
        let deactivated = false;
        if (sent.outcome === "INVALID_TOKEN") {
          const updated = await client.query(`UPDATE push_devices SET active=false, deactivated_at=now(), deactivated_reason=$3, updated_at=now() WHERE organization_id=$1 AND id=$2 AND active`,
            [organizationId, device.id, `provider: ${sent.error || "invalid token"}`.slice(0, 200)]);
          deactivated = (updated.rowCount || 0) > 0;
          if (deactivated) this.logger.warn(JSON.stringify({ event: "push_device_deactivated", device: device.id, token: maskToken(device.token), reason: sent.error }));
        }
        results.push({ deviceId: device.id, platform: device.platform, provider: device.provider, token: maskToken(device.token), environment: device.environment,
          via: sent.provider, outcome: sent.outcome, httpStatus: sent.httpStatus, error: sent.error, response: sent.response, deactivated });
      }
      const sentCount = results.filter((item) => item.outcome === "SENT").length;
      const retry = results.some((item) => item.outcome === "RETRY");
      let status: string; let reason: string | null = null; let sendAfter: Date | null = null;
      if (!results.length) { status = "NO_DEVICES"; }
      else if (sentCount === results.length) status = "SENT";
      else if (sentCount > 0) { status = "PARTIAL"; reason = results.filter((item) => item.outcome !== "SENT").map((item) => `${item.token}: ${item.error}`).join("; ").slice(0, 500); }
      else if (retry && row.attempts < MAX_ATTEMPTS && row.kind !== "TEST") { status = "PENDING"; sendAfter = new Date(Date.now() + retryDelayMs(row.attempts)); reason = results.map((item) => item.error).join("; ").slice(0, 500); }
      else { status = "FAILED"; reason = results.map((item) => item.error).join("; ").slice(0, 500); }
      await client.query(
        `UPDATE push_notifications SET status=$3, reason=coalesce($4,reason), send_after=coalesce($5,send_after), updated_at=now(),
                sent_at=CASE WHEN $3 IN ('SENT','PARTIAL') THEN now() ELSE sent_at END WHERE organization_id=$1 AND id=$2`,
        [organizationId, row.id, status, reason, sendAfter]);
      return { status, results };
    });
  }

  /** POST /notifications/test-push: bypasses preferences and quiet hours (the user asked for it), sends synchronously. */
  async testPush(identity: AuthIdentity) {
    const row = await this.database.tenantTransaction(identity, async (client) => {
      const count = Number((await client.query(`SELECT count(*) FROM push_devices WHERE organization_id=$1 AND employee_id=$2 AND active`, [identity.organizationId, identity.employeeId])).rows[0].count);
      if (!count) return null;
      const data: Omit<PushData, "notificationId"> = { href: "/notifications", eventType: "TEST_PUSH", entityType: "push_test", entityId: "" };
      return (await client.query<QueueRow>(
        `INSERT INTO push_notifications(organization_id,employee_id,kind,category,title,body,data,status,attempts)
         VALUES($1,$2,'TEST','announcements','Test notification','Push notifications are working on this device.',$3,'SENDING',1)
         RETURNING id, employee_id, kind, category, title, body, data, attempts`, [identity.organizationId, identity.employeeId, JSON.stringify(data)])).rows[0];
    });
    if (!row) return { notificationId: null, status: "NO_DEVICES", results: [], mode: this.providers.mode(), message: "No active devices are registered for your account." };
    const outcome = await this.deliver(identity.organizationId, row);
    return { notificationId: Number(row.id), status: outcome.status, results: outcome.results.map(({ response, ...rest }) => ({ ...rest, response: publicResponse(response) })), mode: this.providers.mode() };
  }
}

function toTarget(device: DeviceRow): PushTarget {
  return { deviceId: device.id, platform: device.platform, provider: device.provider, token: device.token, environment: device.environment, bundleId: device.bundle_id };
}

/** Strips local file paths from dev-provider responses before returning them to API callers. */
function publicResponse(response: Record<string, unknown> | null) {
  if (!response) return null;
  const { file, ...rest } = response as { file?: string };
  return file ? { ...rest, file: String(file).split(/[\\/]/).pop() } : rest;
}

/** Unread in-app notifications for one employee (read cursor + individually read ids). */
export async function unreadCount(client: PoolClient, organizationId: string, employeeId: string) {
  return Number((await client.query(
    `SELECT count(*) FROM workflow_events w
      WHERE w.organization_id=$1 AND w.employee_id=$2
        AND w.id > coalesce((SELECT read_through FROM notification_read_cursors c WHERE c.organization_id=$1 AND c.employee_id=$2),0)
        AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.organization_id=$1 AND r.employee_id=$2 AND r.event_id=w.id)`,
    [organizationId, employeeId])).rows[0].count);
}

export type { Category };

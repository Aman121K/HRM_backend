import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { RuntimeConfig } from "../config/runtime-config";
import { DatabaseService } from "../database/database.service";
import { JobsService } from "../jobs/jobs.service";
import { deriveSecret, hmacHex, newSalt, sha256 } from "./crypto";
import { CreateSubscriptionDto, DeliveriesQuery, UpdateSubscriptionDto, WEBHOOK_EVENT_TYPES } from "./integrations.dto";
import { OutboundUrlError, pinnedPost, vetUrl } from "./outbound";
import { audit, systemIdentity } from "./shared";

export const DELIVER_JOB = "integrations.webhook.deliver";
export const SCAN_JOB = "integrations.events.scan";
/** Matches JobsService's BullMQ options (attempts: 5, exponential backoff from 1 s). */
export const MAX_DELIVERY_ATTEMPTS = 5;
/** A subscription is disabled after this many failed attempts in a row (any success resets the count). */
export const DISABLE_AFTER_FAILURES = 10;
const TIMEOUT_MS = 10_000;
/** Only an excerpt is stored; anything beyond this is discarded without being read. */
const MAX_RESPONSE_BYTES = 64 * 1024;

export const EVENT_CATALOG: Record<string, string> = {
  "employee.created": "A new employee record was created or imported.",
  "employee.updated": "An employee's job details changed.",
  "leave.requested": "An employee applied for leave.",
  "leave.approved": "A leave request was approved.",
  "payroll.approved": "A payroll run was approved.",
  "payroll.published": "Payslips for a payroll run were published.",
  "attendance.punch": "A punch was recorded (web, mobile or biometric device).",
  "case.created": "A request was raised in a case module (expenses, helpdesk, travel…).",
  "case.status_changed": "A request moved to a new status.",
  "payout.batch_released": "A salary payout batch was released to the bank.",
  "payout.processed": "A salary payout was credited (with UTR).",
  "payout.failed": "A salary payout failed or was reversed.",
};

export type EventInput = { type: string; entityType?: string; entityId?: string; payload: Record<string, unknown>; sourceAuditId?: string | number };

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  constructor(private readonly database: DatabaseService, private readonly jobs: JobsService, private readonly config: RuntimeConfig) {}

  eventTypes() {
    return { items: WEBHOOK_EVENT_TYPES.map((type) => ({ type, description: EVENT_CATALOG[type] })) };
  }

  private get policy() { return { production: this.config.nodeEnv === "production" }; }

  /** SSRF guard (see outbound.ts): scheme, credentials and every DNS answer must be public. Re-checked on every delivery. */
  private async validateUrl(value: string) {
    try { return (await vetUrl(value, this.policy)).url.toString(); }
    catch (error) { throw new BadRequestException(error instanceof OutboundUrlError ? error.message : "Enter a valid URL."); }
  }

  // ------------------------------------------------------------------ subscriptions

  list(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const rows = (await client.query(
        `SELECT s.id, s.name, s.url, s.event_types AS "eventTypes", s.status, s.consecutive_failures AS "consecutiveFailures",
                s.disabled_reason AS "disabledReason", s.disabled_at AS "disabledAt", s.last_delivery_at AS "lastDeliveryAt",
                s.last_success_at AS "lastSuccessAt", s.version, s.created_at AS "createdAt", right(s.secret_hash, 6) AS "secretHint",
                e.full_name AS "createdBy",
                (SELECT count(*)::int FROM webhook_deliveries d WHERE d.subscription_id=s.id AND d.created_at > now() - interval '24 hours') AS "deliveries24h",
                (SELECT count(*)::int FROM webhook_deliveries d WHERE d.subscription_id=s.id AND d.status='FAILED' AND d.created_at > now() - interval '24 hours') AS "failed24h",
                (SELECT count(*)::int FROM webhook_deliveries d WHERE d.subscription_id=s.id AND d.status IN ('PENDING','RETRYING')) AS "pending"
           FROM webhook_subscriptions s JOIN employees e ON e.id=s.created_by
          WHERE s.organization_id=$1 ORDER BY s.created_at DESC`, [identity.organizationId])).rows;
      return { items: rows, maxAttempts: MAX_DELIVERY_ATTEMPTS, disableAfter: DISABLE_AFTER_FAILURES };
    });
  }

  async create(identity: AuthIdentity, input: CreateSubscriptionDto) {
    const url = await this.validateUrl(input.url);
    return this.database.tenantTransaction(identity, async (client) => {
      const salt = newSalt();
      const id = (await client.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
      const secret = deriveSecret("webhook", id, salt);
      await client.query(
        `INSERT INTO webhook_subscriptions(id,organization_id,name,url,event_types,secret_salt,secret_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, identity.organizationId, input.name.trim(), url, [...new Set(input.eventTypes)], salt, sha256(secret), identity.employeeId]);
      // Start the audit-log scanner from "now" so a new subscriber does not receive the organization's history.
      await client.query(
        `INSERT INTO webhook_event_cursors(organization_id,last_audit_id)
         VALUES($1,(SELECT coalesce(max(id),0) FROM audit_log WHERE organization_id=$1)) ON CONFLICT (organization_id) DO NOTHING`, [identity.organizationId]);
      await audit(client, identity, "WEBHOOK_SUBSCRIPTION_CREATED", "webhook_subscription", id, { name: input.name, url, eventTypes: input.eventTypes });
      return { id, secret, secretNotice: "Copy this signing secret now — it is shown only once." };
    });
  }

  async update(identity: AuthIdentity, id: string, input: UpdateSubscriptionDto) {
    const url = input.url ? await this.validateUrl(input.url) : undefined;
    return this.database.tenantTransaction(identity, async (client) => {
      const before = (await client.query(`SELECT name,url,event_types,status FROM webhook_subscriptions WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id])).rows[0];
      if (!before) throw new NotFoundException("Subscription not found.");
      const row = (await client.query(
        `UPDATE webhook_subscriptions SET name=coalesce($3,name), url=coalesce($4,url), event_types=coalesce($5,event_types),
                status=coalesce($6,status), consecutive_failures=CASE WHEN $6='ACTIVE' THEN 0 ELSE consecutive_failures END,
                disabled_reason=CASE WHEN $6='ACTIVE' THEN NULL WHEN $6='DISABLED' THEN 'Disabled by an administrator' ELSE disabled_reason END,
                disabled_at=CASE WHEN $6='ACTIVE' THEN NULL WHEN $6='DISABLED' THEN now() ELSE disabled_at END,
                version=version+1, updated_at=now()
          WHERE organization_id=$1 AND id=$2 AND version=$7 RETURNING id, version, status`,
        [identity.organizationId, id, input.name?.trim() ?? null, url ?? null, input.eventTypes ? [...new Set(input.eventTypes)] : null, input.status ?? null, input.version])).rows[0];
      if (!row) throw new ConflictException("This subscription changed since you opened it. Refresh and try again.");
      await audit(client, identity, "WEBHOOK_SUBSCRIPTION_UPDATED", "webhook_subscription", id, { name: input.name, url, eventTypes: input.eventTypes, status: input.status }, before);
      return row;
    });
  }

  rotate(identity: AuthIdentity, id: string, version: number) {
    return this.database.tenantTransaction(identity, async (client) => {
      const salt = newSalt();
      const secret = deriveSecret("webhook", id, salt);
      const row = (await client.query(
        `UPDATE webhook_subscriptions SET secret_salt=$3, secret_hash=$4, version=version+1, updated_at=now()
          WHERE organization_id=$1 AND id=$2 AND version=$5 RETURNING id, version`, [identity.organizationId, id, salt, sha256(secret), version])).rows[0];
      if (!row) throw new ConflictException("This subscription changed or was not found. Refresh and try again.");
      await audit(client, identity, "WEBHOOK_SECRET_ROTATED", "webhook_subscription", id);
      return { ...row, secret, secretNotice: "Copy the new signing secret now — it is shown only once. The old secret stops working immediately." };
    });
  }

  deliveries(identity: AuthIdentity, subscriptionId: string, query: DeliveriesQuery) {
    return this.database.tenantTransaction(identity, async (client) => ({ items: (await client.query(
      `SELECT d.id, d.status, d.attempts, d.is_test AS "isTest", d.response_code AS "responseCode", d.response_ms AS "responseMs",
              d.response_excerpt AS "responseExcerpt", d.error, d.last_attempt_at AS "lastAttemptAt", d.delivered_at AS "deliveredAt",
              d.created_at AS "createdAt", ev.id AS "eventId", ev.event_type AS "eventType", ev.payload
         FROM webhook_deliveries d JOIN webhook_events ev ON ev.id=d.event_id
        WHERE d.organization_id=$1 AND d.subscription_id=$2 AND ($3::text IS NULL OR d.status=$3)
        ORDER BY d.created_at DESC LIMIT $4`, [identity.organizationId, subscriptionId, query.status ?? null, query.limit ?? 50])).rows }));
  }

  /** Sends a webhook.test-style event right away (first attempt inline so the admin sees the response), retrying via the queue. */
  async test(identity: AuthIdentity, subscriptionId: string) {
    const deliveryId = await this.database.tenantTransaction(identity, async (client) => {
      const sub = (await client.query(`SELECT id, status, event_types FROM webhook_subscriptions WHERE organization_id=$1 AND id=$2`, [identity.organizationId, subscriptionId])).rows[0];
      if (!sub) throw new NotFoundException("Subscription not found.");
      if (sub.status !== "ACTIVE") throw new ConflictException("Enable the subscription before sending a test event.");
      const event = (await client.query(
        `INSERT INTO webhook_events(organization_id,event_type,entity_type,entity_id,payload) VALUES($1,$2,'webhook_subscription',$3,$4) RETURNING id`,
        [identity.organizationId, sub.event_types[0], subscriptionId, JSON.stringify({ test: true, message: "Test event from Northstar HRM. Verify the signature, then return any 2xx.", sentBy: identity.employeeId })])).rows[0];
      const delivery = (await client.query(
        `INSERT INTO webhook_deliveries(organization_id,subscription_id,event_id,is_test) VALUES($1,$2,$3,true) RETURNING id`,
        [identity.organizationId, subscriptionId, event.id])).rows[0];
      await audit(client, identity, "WEBHOOK_TEST_SENT", "webhook_subscription", subscriptionId);
      return delivery.id as string;
    });
    try { await this.deliver({ deliveryId }); } catch { await this.jobs.enqueue(DELIVER_JOB, { deliveryId }).catch(() => undefined); }
    return this.database.tenantTransaction(identity, async (client) => (await client.query(
      `SELECT id, status, attempts, response_code AS "responseCode", response_ms AS "responseMs", response_excerpt AS "responseExcerpt", error
         FROM webhook_deliveries WHERE organization_id=$1 AND id=$2`, [identity.organizationId, deliveryId])).rows[0]);
  }

  async redeliver(identity: AuthIdentity, deliveryId: string) {
    await this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(
        `UPDATE webhook_deliveries d SET status='PENDING', attempts=0, error=NULL
          FROM webhook_subscriptions s WHERE d.organization_id=$1 AND d.id=$2 AND s.id=d.subscription_id AND s.status='ACTIVE'
            AND d.status IN ('FAILED','SUCCEEDED','SKIPPED') RETURNING d.id`, [identity.organizationId, deliveryId])).rows[0];
      if (!row) throw new ConflictException("Only finished deliveries of an active subscription can be re-sent.");
      await audit(client, identity, "WEBHOOK_REDELIVERED", "webhook_delivery", deliveryId);
    });
    await this.dispatch([deliveryId]);
    return { id: deliveryId, queued: true };
  }

  // ------------------------------------------------------------------ emitting

  /** Records an event and one delivery per matching active subscription. Call dispatch() with the ids after commit. */
  async emit(client: PoolClient, organizationId: string, event: EventInput): Promise<string[]> {
    const subs = (await client.query(
      `SELECT id FROM webhook_subscriptions WHERE organization_id=$1 AND status='ACTIVE' AND $2 = ANY(event_types)`, [organizationId, event.type])).rows;
    if (!subs.length) return [];
    const inserted = (await client.query(
      `INSERT INTO webhook_events(organization_id,event_type,entity_type,entity_id,payload,source_audit_id) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (organization_id, source_audit_id) WHERE source_audit_id IS NOT NULL DO NOTHING RETURNING id`,
      [organizationId, event.type, event.entityType ?? null, event.entityId ?? null, JSON.stringify(event.payload), event.sourceAuditId ?? null])).rows[0];
    if (!inserted) return [];
    const deliveries = (await client.query(
      `INSERT INTO webhook_deliveries(organization_id,subscription_id,event_id) SELECT $1, unnest($2::uuid[]), $3 RETURNING id`,
      [organizationId, subs.map((sub) => sub.id), inserted.id])).rows;
    return deliveries.map((row) => row.id as string);
  }

  async dispatch(deliveryIds: string[]) {
    for (const deliveryId of deliveryIds)
      await this.jobs.enqueue(DELIVER_JOB, { deliveryId }).catch((error) => this.logger.error(`Could not queue webhook delivery ${deliveryId}: ${error.message}`));
  }

  // ------------------------------------------------------------------ delivery (job handler)

  async deliver(payload: Record<string, unknown>) {
    const deliveryId = String(payload.deliveryId || "");
    if (!/^[0-9a-f-]{36}$/.test(deliveryId)) return { skipped: "invalid deliveryId" };
    const found = (await this.database.systemQuery(`SELECT organization_id FROM webhook_deliveries WHERE id=$1`, [deliveryId])).rows[0];
    if (!found) return { skipped: "not found" };
    const identity = systemIdentity(found.organization_id);

    const attempt = await this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(
        `SELECT d.id, d.status, d.attempts, d.is_test, s.id AS sub_id, s.url, s.status AS sub_status, s.secret_salt,
                ev.id AS event_id, ev.event_type, ev.payload, ev.occurred_at, ev.entity_type, ev.entity_id, o.slug
           FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id
           JOIN webhook_events ev ON ev.id=d.event_id JOIN organizations o ON o.id=d.organization_id
          WHERE d.organization_id=$1 AND d.id=$2 FOR UPDATE OF d SKIP LOCKED`, [identity.organizationId, deliveryId])).rows[0];
      if (!row) return null; // another worker holds it
      if (row.status === "SUCCEEDED" || row.status === "FAILED" || row.status === "SKIPPED") return null;
      if (row.sub_status !== "ACTIVE") {
        await client.query(`UPDATE webhook_deliveries SET status='SKIPPED', error='Subscription is disabled' WHERE id=$1`, [deliveryId]);
        return null;
      }
      await client.query(`UPDATE webhook_deliveries SET attempts=attempts+1, last_attempt_at=now() WHERE id=$1`, [deliveryId]);
      return { ...row, attempts: row.attempts + 1 };
    });
    if (!attempt) return { skipped: "not deliverable" };

    const body = JSON.stringify({
      id: attempt.event_id, type: attempt.is_test ? "webhook.test" : attempt.event_type, createdAt: new Date(attempt.occurred_at).toISOString(),
      organization: attempt.slug, entity: attempt.entity_type ? { type: attempt.entity_type, id: attempt.entity_id } : null, data: attempt.payload,
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const secret = deriveSecret("webhook", attempt.sub_id, attempt.secret_salt);
    const signature = hmacHex(secret, `${timestamp}.${body}`);
    const started = Date.now();
    let code: number | null = null;
    let excerpt = "";
    let error: string | null = null;
    try {
      // Vetted again at send time (the URL may predate this check, and DNS may have changed); the connection is pinned
      // to the vetted address so a rebind between check and connect cannot reach an internal host. Redirects are not followed.
      const target = await vetUrl(attempt.url, this.policy);
      const response = await pinnedPost(target, {
        body, timeoutMs: TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES,
        headers: {
          "content-type": "application/json", "user-agent": "Northstar-Webhooks/1.0",
          "x-northstar-event": attempt.is_test ? "webhook.test" : attempt.event_type, "x-northstar-delivery": deliveryId,
          "x-northstar-timestamp": timestamp, "x-northstar-signature": `v1=${signature}`,
        },
      });
      code = response.status;
      excerpt = response.body.slice(0, 500);
      if (code >= 300 && code < 400) error = `Receiver answered HTTP ${code} (redirects are not followed — use the final URL)`;
      else if (code < 200 || code >= 300) error = `Receiver answered HTTP ${code}`;
    } catch (reason) {
      error = reason instanceof OutboundUrlError ? `Blocked: ${reason.message}`
        : reason instanceof Error ? (reason.name === "TimeoutError" ? `Timed out after ${TIMEOUT_MS / 1000}s` : reason.message) : "Network error";
    }
    const ms = Date.now() - started;
    const ok = !error;
    const final = ok || attempt.attempts >= MAX_DELIVERY_ATTEMPTS;
    await this.database.tenantTransaction(identity, async (client) => {
      await client.query(
        `UPDATE webhook_deliveries SET status=$2, response_code=$3, response_ms=$4, response_excerpt=$5, error=$6, delivered_at=CASE WHEN $7 THEN now() END WHERE id=$1`,
        [deliveryId, ok ? "SUCCEEDED" : final ? "FAILED" : "RETRYING", code, ms, excerpt || null, error, ok]);
      if (ok) {
        await client.query(`UPDATE webhook_subscriptions SET consecutive_failures=0, last_delivery_at=now(), last_success_at=now() WHERE id=$1`, [attempt.sub_id]);
      } else {
        const sub = (await client.query(
          `UPDATE webhook_subscriptions SET consecutive_failures=consecutive_failures+1, last_delivery_at=now() WHERE id=$1 RETURNING consecutive_failures, status, created_by`,
          [attempt.sub_id])).rows[0];
        if (sub.status === "ACTIVE" && sub.consecutive_failures >= DISABLE_AFTER_FAILURES) {
          await client.query(
            `UPDATE webhook_subscriptions SET status='DISABLED', disabled_at=now(), disabled_reason=$2, version=version+1 WHERE id=$1`,
            [attempt.sub_id, `Disabled automatically after ${DISABLE_AFTER_FAILURES} consecutive failed deliveries (last: ${error})`]);
          await client.query(
            `INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload) VALUES($1,$2,'WEBHOOK_DISABLED','webhook_subscription',$3,$4)`,
            [identity.organizationId, sub.created_by, attempt.sub_id, JSON.stringify({ message: `A webhook subscription was disabled after ${DISABLE_AFTER_FAILURES} failed deliveries. Check the endpoint and re-enable it.`, link: "/settings/integrations?tab=webhooks" })]);
        }
      }
    });
    // Throwing makes BullMQ retry with exponential backoff; the final attempt is recorded as FAILED instead.
    if (!ok && !final) throw new Error(`Webhook delivery ${deliveryId} failed (attempt ${attempt.attempts}/${MAX_DELIVERY_ATTEMPTS}): ${error}`);
    return { deliveryId, status: ok ? "SUCCEEDED" : "FAILED", code, ms };
  }

  // ------------------------------------------------------------------ audit-log scanner (job handler)

  async scan(organizationId?: string) {
    const orgs = (await this.database.systemQuery(
      `SELECT DISTINCT organization_id FROM webhook_subscriptions WHERE status='ACTIVE' AND ($1::uuid IS NULL OR organization_id=$1)`,
      [organizationId && /^[0-9a-f-]{36}$/i.test(organizationId) ? organizationId : null])).rows.map((row) => row.organization_id as string);
    let emitted = 0;
    for (const organizationId of orgs) {
      const ids = await this.database.tenantTransaction(systemIdentity(organizationId), async (client) => {
        await client.query(
          `INSERT INTO webhook_event_cursors(organization_id,last_audit_id)
           VALUES($1,(SELECT coalesce(max(id),0) FROM audit_log WHERE organization_id=$1)) ON CONFLICT (organization_id) DO NOTHING`, [organizationId]);
        const cursor = (await client.query(`SELECT last_audit_id FROM webhook_event_cursors WHERE organization_id=$1 FOR UPDATE SKIP LOCKED`, [organizationId])).rows[0];
        if (!cursor) return [];
        const rows = (await client.query(
          `SELECT id, action, entity_type, entity_id, after_data, created_at FROM audit_log WHERE organization_id=$1 AND id > $2 ORDER BY id LIMIT 500`,
          [organizationId, cursor.last_audit_id])).rows;
        const deliveryIds: string[] = [];
        for (const row of rows) {
          const event = await this.mapAudit(client, organizationId, row);
          if (event) deliveryIds.push(...await this.emit(client, organizationId, { ...event, sourceAuditId: row.id }));
        }
        if (rows.length)
          await client.query(`UPDATE webhook_event_cursors SET last_audit_id=$2, updated_at=now() WHERE organization_id=$1`, [organizationId, rows[rows.length - 1].id]);
        return deliveryIds;
      });
      emitted += ids.length;
      await this.dispatch(ids);
    }
    return { organizations: orgs.length, deliveries: emitted };
  }

  /** Turns an audit row into a webhook event with a minimal, whitelisted payload (never raw before/after data). */
  private async mapAudit(client: PoolClient, org: string, row: { id: string; action: string; entity_type: string; entity_id: string; created_at: Date }): Promise<EventInput | null> {
    const at = new Date(row.created_at).toISOString();
    if (row.entity_type === "employee" && ["EMPLOYEE_CREATED", "EMPLOYEE_IMPORTED", "EMPLOYEE_UPDATED"].includes(row.action)) {
      const e = (await client.query(
        `SELECT id, employee_number, full_name, work_email, department, designation, location, joining_date::text, status FROM employees WHERE organization_id=$1 AND id=$2`,
        [org, row.entity_id])).rows[0];
      if (!e) return null;
      return { type: row.action === "EMPLOYEE_UPDATED" ? "employee.updated" : "employee.created", entityType: "employee", entityId: e.id, payload: {
        employeeId: e.id, employeeNumber: e.employee_number, name: e.full_name, workEmail: e.work_email, department: e.department,
        designation: e.designation, location: e.location, joiningDate: e.joining_date, status: e.status, at } };
    }
    if (row.entity_type === "leave" && ["LEAVE_SUBMITTED", "APPROVED"].includes(row.action)) {
      const l = (await client.query(
        `SELECT l.id, l.start_date::text, l.end_date::text, l.days::float, l.status, e.id AS employee_id, e.employee_number, t.code
           FROM leave_requests l JOIN employees e ON e.id=l.employee_id LEFT JOIN leave_types t ON t.id=l.leave_type_id
          WHERE l.organization_id=$1 AND l.id=$2`, [org, row.entity_id])).rows[0];
      if (!l) return null;
      return { type: row.action === "APPROVED" ? "leave.approved" : "leave.requested", entityType: "leave_request", entityId: l.id, payload: {
        leaveRequestId: l.id, employeeId: l.employee_id, employeeNumber: l.employee_number, leaveType: l.code, startDate: l.start_date,
        endDate: l.end_date, days: l.days, status: l.status, at } };
    }
    if (row.entity_type === "payroll_run" && ["PAYROLL_RUN_APPROVE", "PAYROLL_RUN_PUBLISH"].includes(row.action)) {
      const r = (await client.query(`SELECT id, period, status, pay_date::text, totals FROM payroll_runs WHERE organization_id=$1 AND id=$2`, [org, row.entity_id])).rows[0];
      if (!r) return null;
      return { type: row.action === "PAYROLL_RUN_PUBLISH" ? "payroll.published" : "payroll.approved", entityType: "payroll_run", entityId: r.id, payload: {
        runId: r.id, period: r.period, status: r.status, payDate: r.pay_date, employeesPaid: r.totals?.payable ?? null, at } };
    }
    if (row.entity_type === "attendance_event" && /^PUNCH_(IN|OUT)$/.test(row.action)) {
      const a = (await client.query(
        `SELECT a.id, a.event_type, a.occurred_at, a.source, a.within_geofence, e.id AS employee_id, e.employee_number
           FROM attendance_events a JOIN employees e ON e.id=a.employee_id WHERE a.organization_id=$1 AND a.id=$2`, [org, row.entity_id])).rows[0];
      if (!a) return null;
      return { type: "attendance.punch", entityType: "attendance_event", entityId: a.id, payload: {
        attendanceEventId: a.id, employeeId: a.employee_id, employeeNumber: a.employee_number, type: a.event_type,
        occurredAt: new Date(a.occurred_at).toISOString(), source: a.source, withinGeofence: a.within_geofence } };
    }
    if (row.entity_type === "hr_case" && row.action !== "FILE_UPLOADED" && !row.action.startsWith("ROSTER_")) {
      const c = (await client.query(
        `SELECT c.id, c.case_number, c.module, c.status, e.employee_number FROM hr_cases c JOIN employees e ON e.id=c.requester_id
          WHERE c.organization_id=$1 AND c.id=$2`, [org, row.entity_id])).rows[0];
      if (!c) return null;
      // Only the case engine's own transitions (<MODULE>_<ACTION>); SLA escalations, reminders etc. are not status changes.
      if (!row.action.startsWith(`${String(c.module).toUpperCase()}_`)) return null;
      const created = row.action.endsWith("_CREATED");
      return { type: created ? "case.created" : "case.status_changed", entityType: "hr_case", entityId: c.id, payload: {
        caseId: c.id, caseNumber: c.case_number, module: c.module, action: row.action.replace(`${c.module.toUpperCase()}_`, "").toLowerCase(),
        currentStatus: c.status, requesterEmployeeNumber: c.employee_number, at } };
    }
    return null;
  }
}

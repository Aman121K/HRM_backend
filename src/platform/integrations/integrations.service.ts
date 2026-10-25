import { Injectable } from "@nestjs/common";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { masterKeyConfigured } from "./crypto";
import { PayoutsService } from "./payouts.service";
import { isFinance, isIntegrationAdmin } from "./shared";

/** Overview cards for /settings/integrations — only the areas the viewer may manage. */
@Injectable()
export class IntegrationsService {
  constructor(private readonly database: DatabaseService, private readonly payouts: PayoutsService) {}

  overview(identity: AuthIdentity) {
    const admin = isIntegrationAdmin(identity);
    const finance = isFinance(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const devices = admin ? (await client.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status='ACTIVE' AND last_seen_at > now() - interval '10 minutes')::int AS online,
                count(*) FILTER (WHERE status='ACTIVE' AND (last_seen_at IS NULL OR last_seen_at <= now() - interval '10 minutes'))::int AS offline,
                (SELECT count(*)::int FROM integration_device_punches WHERE organization_id=$1 AND status='UNMATCHED') AS unmatched,
                (SELECT count(*)::int FROM integration_device_punches WHERE organization_id=$1 AND status='RECORDED' AND received_at > now() - interval '24 hours') AS recorded24h,
                (SELECT count(*)::int FROM integration_device_users WHERE organization_id=$1) AS mappings
           FROM integration_devices WHERE organization_id=$1`, [org])).rows[0] : null;
      const accounting = finance ? (await client.query(
        `SELECT (SELECT count(*)::int FROM accounting_settings WHERE organization_id=$1) > 0 AS configured,
                (SELECT max(created_at) FROM accounting_exports WHERE organization_id=$1) AS "lastExportAt",
                (SELECT count(*)::int FROM accounting_exports WHERE organization_id=$1) AS exports,
                (SELECT count(*)::int FROM payroll_runs r WHERE r.organization_id=$1 AND r.status IN ('APPROVED','PUBLISHED','LOCKED')
                   AND NOT EXISTS (SELECT 1 FROM accounting_exports x WHERE x.run_id=r.id)) AS "runsNotExported"`, [org])).rows[0] : null;
      const payouts = finance ? {
        ...(await client.query(
          `SELECT count(*) FILTER (WHERE status='DRAFT')::int AS "awaitingRelease", count(*) FILTER (WHERE status IN ('RELEASED','PROCESSING'))::int AS "inFlight",
                  count(*) FILTER (WHERE status IN ('PARTIAL','FAILED'))::int AS "needsAttention", max(released_at) AS "lastReleasedAt"
             FROM payout_batches WHERE organization_id=$1`, [org])).rows[0],
        adapters: this.payouts.config_().adapters.map((adapter) => ({ key: adapter.key, label: adapter.label, configured: adapter.configured, mode: (adapter as { mode?: string }).mode })),
      } : null;
      const webhooks = admin ? (await client.query(
        `SELECT count(*) FILTER (WHERE status='ACTIVE')::int AS active, count(*) FILTER (WHERE status='DISABLED')::int AS disabled,
                (SELECT count(*)::int FROM webhook_deliveries WHERE organization_id=$1 AND status='FAILED' AND created_at > now() - interval '24 hours') AS "failed24h",
                (SELECT count(*)::int FROM webhook_deliveries WHERE organization_id=$1 AND status='SUCCEEDED' AND created_at > now() - interval '24 hours') AS "succeeded24h"
           FROM webhook_subscriptions WHERE organization_id=$1`, [org])).rows[0] : null;
      return {
        viewer: { roles: identity.roles, canManageDevices: admin, canManageWebhooks: admin, canManageFinance: finance },
        security: { masterKeyConfigured: masterKeyConfigured() },
        devices, accounting, payouts, webhooks,
      };
    });
  }
}

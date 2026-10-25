import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { BREACH_CLOCKS, breachClocks, principalNotice } from "./breach-rules";
import type { CreateBreachDto, UpdateBreachDto } from "./privacy.dto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Scope = { platform: true } | { platform: false; organizationId: string };

/**
 * Personal-data breach / cyber-incident register. Platform scope: super admins see and log everything (including
 * platform-wide incidents). Brand scope: the brand owner sees their brand's incidents and platform-wide ones, and logs
 * their own. Stored on a platform table (not readable by the tenant DB role); every path filters explicitly.
 */
@Injectable()
export class BreachService {
  constructor(private readonly database: DatabaseService) {}

  async scope(identity: AuthIdentity, platform: boolean): Promise<Scope> {
    if (platform) {
      const ok = identity.userId && (await this.database.systemQuery(`SELECT 1 FROM platform_admins WHERE user_id=$1`, [identity.userId])).rowCount;
      if (!ok) throw new ForbiddenException("Only platform administrators can use the platform breach register.");
      return { platform: true };
    }
    if (!identity.organizationId || !identity.roles.includes("OWNER")) throw new ForbiddenException("Only the brand owner can use the breach register.");
    return { platform: false, organizationId: identity.organizationId };
  }

  private present(row: Record<string, any>, canEdit: boolean) {
    return {
      id: row.id, reference: row.reference, organizationId: row.organization_id, brand: row.brand || (row.organization_id ? "—" : "All brands (platform)"),
      title: row.title, nature: row.nature, severity: row.severity, status: row.status, detectedAt: row.detected_at, occurredAt: row.occurred_at,
      dataCategories: row.data_categories, affectedCount: row.affected_count, affectedDescription: row.affected_description,
      likelyConsequences: row.likely_consequences, containment: row.containment, mitigation: row.mitigation, certInReportable: row.cert_in_reportable,
      notified: Object.fromEntries(BREACH_CLOCKS.map((clock) => [clock.key, row[clock.field] || null])),
      clocks: breachClocks(row, new Date(row.detected_at)), history: row.history || [], version: row.version,
      createdAt: row.created_at, updatedAt: row.updated_at, createdBy: row.created_by_name, canEdit,
    };
  }

  private select(where: string) {
    return `SELECT b.*, coalesce(o.display_name, o.name) AS brand, u.full_name AS created_by_name FROM privacy_breaches b
              LEFT JOIN organizations o ON o.id=b.organization_id LEFT JOIN users u ON u.id=b.created_by WHERE ${where}`;
  }

  async list(identity: AuthIdentity, platform: boolean) {
    const scope = await this.scope(identity, platform);
    const rows = scope.platform
      ? (await this.database.systemQuery(`${this.select("true")} ORDER BY b.detected_at DESC LIMIT 200`)).rows
      : (await this.database.systemQuery(`${this.select("(b.organization_id=$1 OR b.organization_id IS NULL)")} ORDER BY b.detected_at DESC LIMIT 200`, [scope.organizationId])).rows;
    return { items: rows.map((row) => this.present(row, this.canEdit(scope, row))), clocks: BREACH_CLOCKS.map(({ key, label, hours, basis, internalTarget }) => ({ key, label, hours, basis, internalTarget: !!internalTarget })) };
  }

  private canEdit(scope: Scope, row: Record<string, any>) {
    return scope.platform || (!!row.organization_id && row.organization_id === scope.organizationId);
  }

  private async load(client: PoolClient, scope: Scope, id: string) {
    if (!UUID.test(id)) throw new NotFoundException("Incident not found.");
    const row = (await client.query(`${this.select("b.id=$1")} FOR UPDATE OF b`, [id])).rows[0];
    if (!row || (!scope.platform && row.organization_id !== scope.organizationId && row.organization_id !== null)) throw new NotFoundException("Incident not found.");
    return row;
  }

  async get(identity: AuthIdentity, platform: boolean, id: string) {
    const scope = await this.scope(identity, platform);
    return this.database.platformTransaction(async (client) => { const row = await this.load(client, scope, id); return this.present(row, this.canEdit(scope, row)); });
  }

  async create(identity: AuthIdentity, platform: boolean, input: CreateBreachDto) {
    const scope = await this.scope(identity, platform);
    const organizationId = scope.platform ? input.organizationId || null : scope.organizationId;
    const detectedAt = new Date(input.detectedAt);
    if (detectedAt.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException("Detected at can't be in the future.");
    return this.database.platformTransaction(async (client) => {
      if (organizationId && !(await client.query(`SELECT 1 FROM organizations WHERE id=$1`, [organizationId])).rowCount) throw new NotFoundException("Brand not found.");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('privacy_breach_reference'))`);
      const year = new Date().getFullYear();
      const next = Number((await client.query(`SELECT count(*) FROM privacy_breaches WHERE reference LIKE $1`, [`BR-${year}-%`])).rows[0].count) + 1;
      const reference = `BR-${year}-${String(next).padStart(4, "0")}`;
      const history = [{ at: new Date().toISOString(), by: identity.userId, action: "created" }];
      const row = (await client.query(
        `INSERT INTO privacy_breaches(reference,organization_id,title,nature,severity,detected_at,occurred_at,data_categories,affected_count,affected_description,cert_in_reportable,created_by,updated_by,history)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13) RETURNING id`,
        [reference, organizationId, input.title.trim(), input.nature.trim(), input.severity, detectedAt, input.occurredAt ? new Date(input.occurredAt) : null,
          input.dataCategories || [], input.affectedCount ?? null, input.affectedDescription?.trim() || null, input.certInReportable ?? true, identity.userId, JSON.stringify(history)])).rows[0];
      if (organizationId) await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'PRIVACY_BREACH_LOGGED','privacy_breach',$3,$4)`,
        [organizationId, identity.userId, row.id, JSON.stringify({ reference, title: input.title, severity: input.severity, detectedAt })]);
      const created = await this.load(client, scope, row.id);
      return this.present(created, true);
    });
  }

  async update(identity: AuthIdentity, platform: boolean, id: string, input: UpdateBreachDto) {
    const scope = await this.scope(identity, platform);
    return this.database.platformTransaction(async (client) => {
      const row = await this.load(client, scope, id);
      if (!this.canEdit(scope, row)) throw new ForbiddenException("Platform-wide incidents are managed by the platform team.");
      if (row.version !== input.version) throw new ConflictException("This incident changed since you opened it. Reload and try again.");
      const sets: string[] = [];
      const values: unknown[] = [id];
      const changed: Record<string, unknown> = {};
      const put = (column: string, value: unknown, key: string) => { values.push(value); sets.push(`${column}=$${values.length}`); changed[key] = value; };
      if (input.title !== undefined) put("title", input.title.trim(), "title");
      if (input.nature !== undefined) put("nature", input.nature.trim(), "nature");
      if (input.severity !== undefined) put("severity", input.severity, "severity");
      if (input.status !== undefined) put("status", input.status, "status");
      if (input.occurredAt !== undefined) put("occurred_at", new Date(input.occurredAt), "occurredAt");
      if (input.dataCategories !== undefined) put("data_categories", input.dataCategories, "dataCategories");
      if (input.affectedCount !== undefined) put("affected_count", input.affectedCount, "affectedCount");
      if (input.affectedDescription !== undefined) put("affected_description", input.affectedDescription.trim() || null, "affectedDescription");
      if (input.likelyConsequences !== undefined) put("likely_consequences", input.likelyConsequences.trim() || null, "likelyConsequences");
      if (input.containment !== undefined) put("containment", input.containment.trim() || null, "containment");
      if (input.mitigation !== undefined) put("mitigation", input.mitigation.trim() || null, "mitigation");
      if (input.certInReportable !== undefined) put("cert_in_reportable", input.certInReportable, "certInReportable");
      for (const [key, done] of Object.entries(input.notified || {})) {
        const clock = BREACH_CLOCKS.find((item) => item.key === key);
        if (!clock) throw new BadRequestException(`Unknown notification “${key}”.`);
        put(clock.field, done ? (row[clock.field] || new Date()) : null, `notified.${key}`);
      }
      if (input.status === "CLOSED" && !(input.containment ?? row.containment)) throw new BadRequestException("Record the containment steps before closing the incident.");
      if (!sets.length) return this.present(row, true);
      values.push(JSON.stringify([{ at: new Date().toISOString(), by: identity.userId, action: "updated", changes: Object.keys(changed) }]));
      sets.push(`history = history || $${values.length}::jsonb`);
      values.push(identity.userId);
      sets.push(`updated_by=$${values.length}`, "updated_at=now()", "version=version+1");
      await client.query(`UPDATE privacy_breaches SET ${sets.join(", ")} WHERE id=$1`, values);
      if (row.organization_id) await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'PRIVACY_BREACH_UPDATED','privacy_breach',$3,$4)`,
        [row.organization_id, identity.userId, id, JSON.stringify({ reference: row.reference, changes: Object.keys(changed) })]);
      return this.present(await this.load(client, scope, id), true);
    });
  }

  /** Plain-language notification to affected employees, pre-filled from the incident and the brand's grievance officer. */
  async notice(identity: AuthIdentity, platform: boolean, id: string) {
    const scope = await this.scope(identity, platform);
    return this.database.platformTransaction(async (client) => {
      const row = await this.load(client, scope, id);
      const orgId = row.organization_id || (scope.platform ? null : scope.organizationId);
      let contact: Record<string, string | null> = {};
      let brand = row.brand && row.organization_id ? row.brand : "[Company name]";
      if (orgId) {
        await client.query(`SELECT set_config('app.organization_id',$1,true)`, [orgId]);
        const settings = (await client.query(`SELECT grievance_name, grievance_email, grievance_phone FROM privacy_settings WHERE organization_id=$1`, [orgId])).rows[0];
        const org = (await client.query(`SELECT coalesce(legal_name, display_name, name) AS name FROM organizations WHERE id=$1`, [orgId])).rows[0];
        brand = org?.name || brand;
        contact = { contactName: settings?.grievance_name || null, contactEmail: settings?.grievance_email || null, contactPhone: settings?.grievance_phone || null };
      }
      return principalNotice({ brand, reference: row.reference, nature: row.nature, detectedAt: row.detected_at, categories: row.data_categories || [],
        consequences: row.likely_consequences, mitigation: row.mitigation, containment: row.containment, ...contact });
    });
  }
}

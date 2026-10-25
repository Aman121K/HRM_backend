import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleInit } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { FilesService } from "../files/files.service";
import { JobRegistry } from "../jobs/job-registry";
import type { DeviceDecisionDto, HistoryQuery, NetworkEntryDto, PolicyDto, PrecheckDto, PunchDto, ReviewDecisionDto, ReviewQuery, SiteDto } from "./attendance.dto";
import { PunchGuard, type PunchSecurityPolicy } from "./punch-guard";

const ZONE = "Asia/Kolkata";
const MAX_ACCURACY_METRES = 250;
const MAX_LOCATION_AGE_MS = 5 * 60_000;
const MAX_SELFIE_AGE_MS = 2 * 60_000;
const HR_ROLES = ["HR_ADMIN", "OWNER"];

export type AttendancePolicy = PunchSecurityPolicy & { selfieMode: "OFF" | "OUTSIDE_GEOFENCE" | "ALWAYS"; livenessRequired: boolean; selfieRetentionDays: number; exemptRoles: string[]; version: number };
const DEFAULT_POLICY: AttendancePolicy = { selfieMode: "OFF", livenessRequired: true, selfieRetentionDays: 90, exemptRoles: [], version: 0,
  deviceBinding: "OFF", maxDevices: 1, deviceApproval: "FIRST_AUTO", officeNetwork: "OFF", routerMac: "OFF" };

/** Great-circle distance in metres. */
export function distanceMetres(aLat: number, aLng: number, bLat: number, bLng: number) {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export type DevicePunch = { organizationId: string; employeeId: string; occurredAt: Date; deviceSerial: string; externalId: string; type?: "IN" | "OUT" };

@Injectable()
export class AttendanceService implements OnModuleInit {
  private readonly logger = new Logger(AttendanceService.name);
  constructor(private readonly database: DatabaseService, private readonly files: FilesService, private readonly jobs: JobRegistry, private readonly guard: PunchGuard) {}

  onModuleInit() {
    // Punch selfies: the employee, their manager and HR can view; only the employee may upload, right after punching.
    this.files.registerPolicy("attendance_event", async (identity, id, client) => {
      const row = (await client.query(
        `SELECT a.employee_id, a.selfie_file_id, a.occurred_at, e.manager_id FROM attendance_events a
           JOIN employees e ON e.id=a.employee_id AND e.organization_id=a.organization_id WHERE a.organization_id=$1 AND a.id=$2`,
        [identity.organizationId, id])).rows[0];
      if (!row) return null;
      const self = row.employee_id === identity.employeeId;
      if (self && !row.selfie_file_id && Date.now() - new Date(row.occurred_at).getTime() < 10 * 60_000) return "write";
      return self || row.manager_id === identity.employeeId || identity.roles.some((role) => HR_ROLES.includes(role)) ? "read" : null;
    });
    this.jobs.register("attendance.selfie_retention", (payload) => this.purgeSelfies(payload.organizationId as string | undefined),
      { cron: "45 3 * * *", tenantScoped: true, description: "Removes punch selfies older than the organization's retention period." });
  }

  policy(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, (client) => this.loadPolicy(client, identity.organizationId));
  }

  savePolicy(identity: AuthIdentity, input: PolicyDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const current = await this.loadPolicy(client, identity.organizationId);
      if (current.version !== input.version) throw new ConflictException("The policy changed since you opened it. Refresh and try again.");
      const next = { ...input, deviceBinding: input.deviceBinding ?? current.deviceBinding, maxDevices: input.maxDevices ?? current.maxDevices,
        deviceApproval: input.deviceApproval ?? current.deviceApproval, officeNetwork: input.officeNetwork ?? current.officeNetwork, routerMac: input.routerMac ?? current.routerMac };
      const row = (await client.query(
        `INSERT INTO attendance_policies(organization_id,selfie_mode,liveness_required,selfie_retention_days,exempt_roles,device_binding,max_devices,device_approval,office_network,router_mac,version,updated_by)
         VALUES($1,$2,$3,$4,$5,$7,$8,$9,$10,$11,1,$6)
         ON CONFLICT (organization_id) DO UPDATE SET selfie_mode=$2,liveness_required=$3,selfie_retention_days=$4,exempt_roles=$5,
           device_binding=$7,max_devices=$8,device_approval=$9,office_network=$10,router_mac=$11,
           version=attendance_policies.version+1,updated_by=$6,updated_at=now() RETURNING version`,
        [identity.organizationId, next.selfieMode, next.livenessRequired, next.selfieRetentionDays, next.exemptRoles, identity.userId,
          next.deviceBinding, next.maxDevices, next.deviceApproval, next.officeNetwork, next.routerMac])).rows[0];
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,'ATTENDANCE_POLICY_UPDATED','attendance_policy',$1,$3,$4)`,
        [identity.organizationId, identity.userId, JSON.stringify(current), JSON.stringify(next)]);
      return { ...next, version: row.version };
    });
  }

  /** Tells the client, before it punches, which site applies and whether a selfie will be required. */
  precheck(identity: AuthIdentity, location: PrecheckDto, clientIp = "") {
    return this.database.tenantTransaction(identity, async (client) => {
      const policy = await this.loadPolicy(client, identity.organizationId);
      const site = await this.nearestSite(client, identity.organizationId, location.latitude, location.longitude);
      const within = site ? site.distance <= site.radius : null;
      return {
        site: site ? { id: site.id, name: site.name, distanceMetres: Math.round(site.distance), radiusMetres: site.radius } : null,
        withinGeofence: within, selfieRequired: this.selfieRequired(identity, policy, within), livenessRequired: policy.livenessRequired,
        security: await this.guard.precheck(client, identity, policy, location, clientIp),
      };
    });
  }

  reviewQueue(identity: AuthIdentity, query: ReviewQuery) {
    const isHr = identity.roles.some((role) => HR_ROLES.includes(role));
    return this.database.tenantTransaction(identity, async (client) => {
      const rows = (await client.query(
        `SELECT a.id, a.event_type AS type, a.occurred_at AS "occurredAt", a.source, a.within_geofence AS "withinGeofence",
                a.distance_metres::float AS "distanceMetres", a.accuracy_metres::float AS "accuracyMetres", a.selfie_file_id AS "selfieFileId",
                a.face_check AS "faceCheck", a.review_status AS "reviewStatus", a.review_reasons AS "reviewReasons", a.review_note AS "reviewNote",
                a.reviewed_at AS "reviewedAt", r.full_name AS "reviewedBy", s.name AS "siteName",
                e.id AS "employeeId", e.full_name AS "employeeName", e.designation, e.employee_number AS "employeeNumber"
           FROM attendance_events a
           JOIN employees e ON e.id=a.employee_id AND e.organization_id=a.organization_id
           LEFT JOIN employees r ON r.id=a.reviewed_by AND r.organization_id=a.organization_id
           LEFT JOIN attendance_sites s ON s.id=a.site_id AND s.organization_id=a.organization_id
          WHERE a.organization_id=$1 AND a.review_status=$2 AND ($3 OR e.manager_id=$4)
          ORDER BY a.occurred_at DESC LIMIT 200`,
        [identity.organizationId, query.status || "PENDING", isHr, identity.employeeId])).rows;
      return { items: rows, scope: isHr ? "organization" : "direct_reports" };
    });
  }

  decide(identity: AuthIdentity, id: string, input: ReviewDecisionDto) {
    if (input.decision === "REJECTED" && !input.note?.trim()) throw new BadRequestException("Add a note explaining why this punch is rejected.");
    const isHr = identity.roles.some((role) => HR_ROLES.includes(role));
    return this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(
        `SELECT a.id, a.employee_id, a.review_status, a.event_type, a.occurred_at, e.manager_id FROM attendance_events a
           JOIN employees e ON e.id=a.employee_id AND e.organization_id=a.organization_id
          WHERE a.organization_id=$1 AND a.id=$2 FOR UPDATE OF a`, [identity.organizationId, id])).rows[0];
      if (!row || (!isHr && row.manager_id !== identity.employeeId)) throw new NotFoundException("Punch not found.");
      if (row.employee_id === identity.employeeId) throw new ForbiddenException("You can't review your own punch.");
      if (row.review_status !== "PENDING") throw new ConflictException("This punch has already been reviewed.");
      await client.query(`UPDATE attendance_events SET review_status=$3, reviewed_by=$4, reviewed_at=now(), review_note=$5 WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, id, input.decision, identity.employeeId, input.note?.trim() || null]);
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,$3,'attendance_event',$4,$5)`,
        [identity.organizationId, identity.userId, `PUNCH_${input.decision}`, id, JSON.stringify({ note: input.note })]);
      const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: ZONE }).format(new Date(row.occurred_at));
      await client.query(`INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload) VALUES($1,$2,$3,'attendance_event',$4,$5)`,
        [identity.organizationId, row.employee_id, `PUNCH_${input.decision}`, id, JSON.stringify({
          href: "/attendance", message: input.decision === "APPROVED" ? `Your punch ${row.event_type === "IN" ? "in" : "out"} on ${when} was verified`
            : `Your punch ${row.event_type === "IN" ? "in" : "out"} on ${when} was rejected: ${input.note?.trim()}. Request a correction if this is wrong.` })]);
      return { id, reviewStatus: input.decision };
    });
  }

  today(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => this.dayState(client, identity.organizationId, identity.employeeId));
  }

  async punch(identity: AuthIdentity, input: PunchDto, clientIp = "") {
    const result = await this.recordPunch(identity, input, clientIp);
    if (!input.selfie || result.duplicate || !("event" in result) || !result.event) return result;
    // The selfie is stored after the punch commits so a storage hiccup never loses the attendance record.
    try {
      const file = await this.files.upload(identity, { entityType: "attendance_event", entityId: result.event.id, category: "PUNCH_SELFIE",
        originalName: `punch-${result.event.id}.${input.selfie.mimeType.split("/")[1]}`, mimeType: input.selfie.mimeType, base64: input.selfie.base64 });
      await this.database.tenantTransaction(identity, (client) => client.query(`UPDATE attendance_events SET selfie_file_id=$3 WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, result.event.id, file.id]));
      return { ...result, selfieStored: true };
    } catch (error) {
      this.logger.warn(`Selfie upload failed for punch ${result.event.id}: ${(error as Error).message}`);
      await this.database.tenantTransaction(identity, (client) => client.query(
        `UPDATE attendance_events SET review_status='PENDING', review_reasons=array_append(review_reasons,'selfie_upload_failed') WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, result.event.id]));
      return { ...result, selfieStored: false, warning: "Punch recorded, but the selfie couldn't be saved. Your manager will review this punch." };
    }
  }

  private async recordPunch(identity: AuthIdentity, input: PunchDto, clientIp: string) {
    const captured = new Date(input.location.capturedAt).getTime();
    if (Math.abs(Date.now() - captured) > MAX_LOCATION_AGE_MS) throw new BadRequestException("Your location is out of date. Refresh your location and try again.");
    if (input.location.accuracyMetres > MAX_ACCURACY_METRES)
      throw new BadRequestException(`Location accuracy is ${Math.round(input.location.accuracyMetres)} m. Move near a window or enable precise location (needs ≤ ${MAX_ACCURACY_METRES} m).`);
    const outcome = await this.database.tenantTransaction(identity, async (client) => {
      await client.query(`SELECT 1 FROM employees WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [identity.organizationId, identity.employeeId]);
      const key = input.idempotencyKey || `${input.type}-${input.location.capturedAt}`;
      const existing = (await client.query(`SELECT id FROM attendance_events WHERE organization_id=$1 AND employee_id=$2 AND idempotency_key=$3`,
        [identity.organizationId, identity.employeeId, key])).rows[0];
      if (existing) return { duplicate: true, ...(await this.dayState(client, identity.organizationId, identity.employeeId)) };
      const state = await this.dayState(client, identity.organizationId, identity.employeeId);
      if (state.expectedNext !== input.type)
        throw new ConflictException(input.type === "IN" ? "You are already punched in." : "You haven't punched in yet today.");
      const site = await this.nearestSite(client, identity.organizationId, input.location.latitude, input.location.longitude);
      const within = site ? site.distance <= site.radius : null;
      const policy = await this.loadPolicy(client, identity.organizationId);
      if (this.selfieRequired(identity, policy, within) && !input.selfie)
        throw new BadRequestException({ message: within === false ? "You're outside your site — take a selfie to punch." : "Take a selfie to punch.", code: "SELFIE_REQUIRED" });
      if (input.selfie && Math.abs(Date.now() - new Date(input.selfie.capturedAt).getTime()) > MAX_SELFIE_AGE_MS)
        throw new BadRequestException({ message: "That photo is too old. Take a new selfie.", code: "SELFIE_STALE" });
      // Device / office network / router checks. A blocked punch still commits device requests so HR can approve them.
      const guard = await this.guard.evaluate(client, identity, policy,
        { type: input.type, idempotencyKey: input.idempotencyKey || "", capturedAt: input.location.capturedAt, device: input.device, wifiBssid: input.wifiBssid }, clientIp);
      if (guard.block) return { blocked: guard.block };
      const reasons = [...this.reviewReasons(identity, policy, within, input), ...guard.reasons];
      const event = (await client.query(
        `INSERT INTO attendance_events(organization_id,employee_id,event_type,occurred_at,latitude,longitude,accuracy_metres,location_captured_at,
           timezone,device_id,permission,idempotency_key,source,site_id,distance_metres,within_geofence,note,face_check,review_status,review_reasons,
           device_record_id,client_ip,wifi_bssid)
         VALUES($1,$2,$3,now(),$4,$5,$6,$7,$8,$9,'granted',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id, occurred_at AS "occurredAt"`,
        [identity.organizationId, identity.employeeId, input.type, input.location.latitude, input.location.longitude, input.location.accuracyMetres,
          input.location.capturedAt, input.timezone || ZONE, input.deviceId || null, key, input.source || "WEB",
          site?.id || null, site ? Math.round(site.distance * 10) / 10 : null, within, input.note || null,
          input.faceCheck ? JSON.stringify(input.faceCheck) : null, reasons.length ? "PENDING" : "NONE", reasons,
          guard.deviceRecordId, clientIp || null, guard.bssid])).rows[0];
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,$3,'attendance_event',$4,$5)`,
        [identity.organizationId, identity.userId, `PUNCH_${input.type}`, event.id, JSON.stringify({ source: input.source || "WEB", site: site?.name, withinGeofence: site ? site.distance <= site.radius : null })]);
      return { duplicate: false, event, ...(await this.dayState(client, identity.organizationId, identity.employeeId)) };
    });
    if ("blocked" in outcome && outcome.blocked) throw new ForbiddenException({ message: outcome.blocked.message, code: outcome.blocked.code });
    return outcome as Exclude<typeof outcome, { blocked: unknown }>;
  }

  // ---------- punch devices & office networks (HR) ----------

  private isHr(identity: AuthIdentity) { return identity.roles.some((role) => HR_ROLES.includes(role)); }

  devices(identity: AuthIdentity, status?: string) {
    return this.database.tenantTransaction(identity, async (client) => ({ items: await this.guard.devices(client, identity, this.isHr(identity), status), canManage: this.isHr(identity) }));
  }

  decideDevice(identity: AuthIdentity, id: string, input: DeviceDecisionDto) {
    if (!this.isHr(identity)) throw new ForbiddenException("Only HR can approve or remove punch devices.");
    return this.database.tenantTransaction(identity, async (client) => this.guard.decideDevice(client, identity, await this.loadPolicy(client, identity.organizationId), id, input.decision, input.note));
  }

  networks(identity: AuthIdentity, clientIp: string) {
    if (!this.isHr(identity)) throw new ForbiddenException("Only HR can view office networks.");
    return this.database.tenantTransaction(identity, async (client) => ({ items: await this.guard.networks(client, identity.organizationId), yourIp: clientIp }));
  }

  saveNetworks(identity: AuthIdentity, items: NetworkEntryDto[], clientIp: string) {
    if (!this.isHr(identity)) throw new ForbiddenException("Only HR can change office networks.");
    return this.database.tenantTransaction(identity, async (client) => ({ items: await this.guard.saveNetworks(client, identity, items), yourIp: clientIp }));
  }

  /** For biometric integrations: records a device punch, inferring IN/OUT from the day's sequence when the device doesn't say. */
  async recordDevicePunch(client: PoolClient, punch: DevicePunch) {
    const existing = await client.query(`SELECT id FROM attendance_events WHERE organization_id=$1 AND employee_id=$2 AND idempotency_key=$3`,
      [punch.organizationId, punch.employeeId, `device:${punch.deviceSerial}:${punch.externalId}`]);
    if (existing.rowCount) return { id: existing.rows[0].id as string, duplicate: true };
    const last = (await client.query(
      `SELECT event_type FROM attendance_events WHERE organization_id=$1 AND employee_id=$2
          AND occurred_at >= (($3::timestamptz AT TIME ZONE '${ZONE}')::date::timestamp AT TIME ZONE '${ZONE}') AND occurred_at <= $3
        ORDER BY occurred_at DESC LIMIT 1`, [punch.organizationId, punch.employeeId, punch.occurredAt])).rows[0];
    const type = punch.type || (last?.event_type === "IN" ? "OUT" : "IN");
    const row = (await client.query(
      `INSERT INTO attendance_events(organization_id,employee_id,event_type,occurred_at,device_id,idempotency_key,source)
       VALUES($1,$2,$3,$4,$5,$6,'BIOMETRIC') RETURNING id`,
      [punch.organizationId, punch.employeeId, type, punch.occurredAt, punch.deviceSerial, `device:${punch.deviceSerial}:${punch.externalId}`])).rows[0];
    return { id: row.id as string, duplicate: false, type };
  }

  history(identity: AuthIdentity, query: HistoryQuery) {
    const istDate = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date(at));
    const to = query.to || istDate(Date.now());
    const from = query.from || istDate(Date.now() - 30 * 86_400_000);
    if (from > to || (Date.parse(to) - Date.parse(from)) / 86_400_000 > 92) throw new BadRequestException("Choose a range of up to 92 days.");
    return this.database.tenantTransaction(identity, async (client) => {
      const rows = (await client.query(
        `SELECT (occurred_at AT TIME ZONE '${ZONE}')::date::text AS day, event_type AS type, occurred_at AS "occurredAt", source, within_geofence AS "withinGeofence"
           FROM attendance_events WHERE organization_id=$1 AND employee_id=$2 AND review_status <> 'REJECTED'
            AND occurred_at >= ($3::date::timestamp AT TIME ZONE '${ZONE}') AND occurred_at < (($4::date + 1)::timestamp AT TIME ZONE '${ZONE}')
          ORDER BY occurred_at`, [identity.organizationId, identity.employeeId, from, to])).rows;
      const days = new Map<string, typeof rows>();
      for (const row of rows) days.set(row.day, [...(days.get(row.day) || []), row]);
      const items = [...days.entries()].reverse().map(([day, events]) => ({
        day, firstIn: events.find((event) => event.type === "IN")?.occurredAt || null,
        lastOut: [...events].reverse().find((event) => event.type === "OUT")?.occurredAt || null,
        workedMinutes: workedMinutes(events), punches: events.length, sources: [...new Set(events.map((event) => event.source))],
        outsideGeofence: events.some((event) => event.withinGeofence === false),
      }));
      return { from, to, items, totalMinutes: items.reduce((sum, item) => sum + item.workedMinutes, 0) };
    });
  }

  sites(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => ({ items: (await client.query(
      `SELECT id, name, latitude::float, longitude::float, radius_metres AS "radiusMetres", active, version FROM attendance_sites WHERE organization_id=$1 ORDER BY name`,
      [identity.organizationId])).rows }));
  }

  saveSite(identity: AuthIdentity, input: SiteDto, id?: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const values = [identity.organizationId, input.name.trim(), input.latitude, input.longitude, input.radiusMetres, input.active ?? true];
      const row = id
        ? (await client.query(`UPDATE attendance_sites SET name=$2,latitude=$3,longitude=$4,radius_metres=$5,active=$6,version=version+1
             WHERE organization_id=$1 AND id=$7 AND version=$8 RETURNING id, version`, [...values, id, input.version || 0])).rows[0]
        : (await client.query(`INSERT INTO attendance_sites(organization_id,name,latitude,longitude,radius_metres,active) VALUES($1,$2,$3,$4,$5,$6)
             ON CONFLICT (organization_id,name) DO NOTHING RETURNING id, version`, values)).rows[0];
      if (!row) throw id ? new ConflictException("This site changed or was not found. Refresh and try again.") : new ConflictException("A site with this name already exists.");
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,$3,'attendance_site',$4,$5)`,
        [identity.organizationId, identity.userId, id ? "SITE_UPDATED" : "SITE_CREATED", row.id, JSON.stringify(input)]);
      return row;
    });
  }

  private selfieRequired(identity: AuthIdentity, policy: AttendancePolicy, within: boolean | null) {
    if (policy.selfieMode === "OFF" || identity.roles.some((role) => policy.exemptRoles.includes(role))) return false;
    return policy.selfieMode === "ALWAYS" || within !== true;
  }

  /** Signals that send a punch to manager review. Face checks run on the device, so they flag rather than block. */
  private reviewReasons(identity: AuthIdentity, policy: AttendancePolicy, within: boolean | null, input: PunchDto) {
    const reasons: string[] = [];
    if (within === false) reasons.push("outside_geofence");
    if (input.selfie) {
      if (!input.faceCheck || input.faceCheck.detector === "none") reasons.push("face_check_unavailable");
      else {
        if (input.faceCheck.faces === 0) reasons.push("no_face");
        if (input.faceCheck.faces > 1) reasons.push("multiple_faces");
        if (policy.livenessRequired && !input.faceCheck.liveness.passed) reasons.push("liveness_failed");
      }
    } else if (this.selfieRequired(identity, policy, within)) reasons.push("selfie_missing");
    return reasons;
  }

  private async loadPolicy(client: PoolClient, organizationId: string): Promise<AttendancePolicy> {
    const row = (await client.query(
      `SELECT selfie_mode AS "selfieMode", liveness_required AS "livenessRequired", selfie_retention_days AS "selfieRetentionDays",
              exempt_roles AS "exemptRoles", device_binding AS "deviceBinding", max_devices AS "maxDevices", device_approval AS "deviceApproval",
              office_network AS "officeNetwork", router_mac AS "routerMac", version FROM attendance_policies WHERE organization_id=$1`, [organizationId])).rows[0];
    return row || DEFAULT_POLICY;
  }

  /** Soft-deletes punch selfies past retention; the files housekeeping job removes the bytes later. */
  private async purgeSelfies(organizationId?: string) {
    const orgs = organizationId ? [{ id: organizationId }] : (await this.database.query<{ id: string }>(`SELECT id FROM organizations`)).rows;
    let removed = 0;
    for (const org of orgs) {
      const identity = { organizationId: org.id, userId: "", employeeId: "", roles: [] };
      removed += await this.database.tenantTransaction(identity, async (client) => {
        const policy = await this.loadPolicy(client, org.id);
        const result = await client.query(
          `UPDATE stored_files SET deleted_at=now() WHERE organization_id=$1 AND entity_type='attendance_event' AND deleted_at IS NULL
              AND created_at < now() - make_interval(days => $2)`, [org.id, policy.selfieRetentionDays]);
        return result.rowCount || 0;
      });
    }
    return { removed };
  }

  private async nearestSite(client: PoolClient, organizationId: string, lat: number, lng: number) {
    const sites = (await client.query(`SELECT id, name, latitude::float AS lat, longitude::float AS lng, radius_metres AS radius FROM attendance_sites WHERE organization_id=$1 AND active`, [organizationId])).rows;
    return sites.map((site) => ({ ...site, distance: distanceMetres(lat, lng, site.lat, site.lng) })).sort((a, b) => a.distance - b.distance)[0] || null;
  }

  private async dayState(client: PoolClient, organizationId: string, employeeId: string) {
    const events = (await client.query(
      `SELECT id, event_type AS type, occurred_at AS "occurredAt", source, within_geofence AS "withinGeofence", distance_metres::float AS "distanceMetres",
              review_status AS "reviewStatus", selfie_file_id AS "selfieFileId"
         FROM attendance_events WHERE organization_id=$1 AND employee_id=$2 AND review_status <> 'REJECTED'
          AND occurred_at >= ((now() AT TIME ZONE '${ZONE}')::date::timestamp AT TIME ZONE '${ZONE}')
          AND occurred_at < (((now() AT TIME ZONE '${ZONE}')::date + 1)::timestamp AT TIME ZONE '${ZONE}') ORDER BY occurred_at`,
      [organizationId, employeeId])).rows;
    if (!events) throw new NotFoundException();
    const last = events[events.length - 1];
    return {
      date: new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date()),
      state: last?.type === "IN" ? "PUNCHED_IN" : events.length ? "PUNCHED_OUT" : "NOT_STARTED",
      expectedNext: last?.type === "IN" ? "OUT" : "IN",
      workedMinutes: workedMinutes(events, true), events,
    };
  }
}

/** Sums IN→OUT pairs; an open IN counts until now when `live` is set. */
function workedMinutes(events: { type: string; occurredAt: string | Date }[], live = false) {
  let total = 0, start: number | null = null;
  for (const event of events) {
    const at = new Date(event.occurredAt).getTime();
    if (event.type === "IN") start = at;
    else if (start !== null) { total += at - start; start = null; }
  }
  if (live && start !== null) total += Date.now() - start;
  return Math.round(total / 60_000);
}

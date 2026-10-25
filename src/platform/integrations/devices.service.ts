import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import type { PoolClient } from "pg";
import { AttendanceService } from "../attendance/attendance.service";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { deriveSecret, hmacHex, newSalt, safeEqual, sha256 } from "./crypto";
import {
  CreateDeviceDto, CreateMappingDto, DeviceHeartbeat, DevicePunchBatch, DevicePunchesQuery, ImportMappingsDto, ResolveUnmatchedDto, UpdateDeviceDto,
} from "./integrations.dto";
import { audit, parseDeviceTime, systemIdentity, validTimeZone, zoneHours } from "./shared";
import { WebhooksService } from "./webhooks.service";

export const REPLAY_WINDOW_SECONDS = 300;
const ONLINE_MINUTES = 10;
const MAX_AGE_DAYS = 62;

const SERIAL_TAKEN_HERE = "A device with this serial number is already registered in this organization.";
/** Deliberately does not say which brand holds it. */
const SERIAL_TAKEN_ELSEWHERE = "This serial number is already registered (it may belong to another organization). Check the serial on the device label, or ask the platform administrator to release it.";

type Device = { id: string; organization_id: string; serial_number: string; name: string; timezone: string; status: string; secret_salt: string | null; secret_hash: string | null };
export type IncomingPunch = { externalId: string; deviceUserId: string; occurredAt: string; type?: "IN" | "OUT"; verifyMode?: string; raw: Record<string, unknown> };
type PunchResult = { externalId: string; status: "RECORDED" | "UNMATCHED" | "DUPLICATE" | "REJECTED"; reason?: string; attendanceEventId?: string };

const PIN = /^[A-Za-z0-9_-]{1,24}$/;

@Injectable()
export class DevicesService {
  constructor(private readonly database: DatabaseService, private readonly attendance: AttendanceService, private readonly webhooks: WebhooksService) {}

  // ================================================================== admin: registry

  list(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const items = (await client.query(
        `SELECT d.id, d.serial_number AS "serialNumber", d.name, d.vendor, d.site_id AS "siteId", s.name AS "siteName", d.timezone, d.status,
                d.last_seen_at AS "lastSeenAt", d.last_ip AS "lastIp", d.last_punch_at AS "lastPunchAt", d.firmware, d.protocol,
                d.secret_rotated_at AS "secretRotatedAt", right(d.secret_hash, 6) AS "secretHint", d.version, d.created_at AS "createdAt",
                (SELECT count(*)::int FROM integration_device_punches p WHERE p.device_id=d.id AND p.received_at > now() - interval '24 hours') AS "punches24h",
                (SELECT count(*)::int FROM integration_device_punches p WHERE p.device_id=d.id AND p.status='UNMATCHED') AS "unmatched",
                (SELECT count(*)::int FROM integration_device_punches p WHERE p.device_id=d.id AND p.status='REJECTED' AND p.received_at > now() - interval '24 hours') AS "rejected24h",
                CASE WHEN d.status <> 'ACTIVE' THEN 'INACTIVE' WHEN d.last_seen_at IS NULL THEN 'NEVER_SEEN'
                     WHEN d.last_seen_at > now() - make_interval(mins => $2) THEN 'ONLINE'
                     WHEN d.last_seen_at > now() - interval '24 hours' THEN 'STALE' ELSE 'OFFLINE' END AS health
           FROM integration_devices d LEFT JOIN attendance_sites s ON s.id=d.site_id
          WHERE d.organization_id=$1 ORDER BY d.name`, [identity.organizationId, ONLINE_MINUTES])).rows;
      const sites = (await client.query(`SELECT id, name FROM attendance_sites WHERE organization_id=$1 AND active ORDER BY name`, [identity.organizationId])).rows;
      const hourly = (await client.query(
        `SELECT date_trunc('hour', received_at) AS hour, count(*)::int AS total, count(*) FILTER (WHERE status='UNMATCHED')::int AS unmatched
           FROM integration_device_punches WHERE organization_id=$1 AND received_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`,
        [identity.organizationId])).rows;
      return { items, sites, hourly, onlineMinutes: ONLINE_MINUTES };
    });
  }

  create(identity: AuthIdentity, input: CreateDeviceDto) {
    const timezone = input.timezone?.trim() || "Asia/Kolkata";
    if (!validTimeZone(timezone)) throw new BadRequestException("Choose a valid IANA timezone, e.g. Asia/Kolkata.");
    return this.database.tenantTransaction(identity, async (client) => {
      if (input.siteId) await this.requireSite(client, identity.organizationId, input.siteId);
      // Serials are global (devices call /iclock before any brand is known), so the check must see every brand's
      // devices — under RLS this query would only see our own. The unique index still decides races (caught below).
      const taken = (await this.database.systemQuery(`SELECT organization_id FROM integration_devices WHERE upper(serial_number)=upper($1)`, [input.serialNumber.trim()])).rows[0];
      if (taken) throw new ConflictException(taken.organization_id === identity.organizationId ? SERIAL_TAKEN_HERE : SERIAL_TAKEN_ELSEWHERE);
      const id = (await client.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
      const salt = newSalt();
      const secret = deriveSecret("device", id, salt);
      try {
        await client.query(
          `INSERT INTO integration_devices(id,organization_id,serial_number,name,vendor,site_id,timezone,secret_salt,secret_hash,secret_rotated_at,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10)`,
          [id, identity.organizationId, input.serialNumber.trim(), input.name.trim(), input.vendor, input.siteId || null, timezone, salt, sha256(secret), identity.employeeId]);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new ConflictException(SERIAL_TAKEN_ELSEWHERE);
        throw error;
      }
      await audit(client, identity, "INTEGRATION_DEVICE_CREATED", "integration_device", id, { serialNumber: input.serialNumber, name: input.name, vendor: input.vendor, siteId: input.siteId, timezone });
      return { id, serialNumber: input.serialNumber.trim(), secret, commKey: deriveSecret("comm", id, salt), secretNotice: "Copy the device secret and comm key now — they are shown only once." };
    });
  }

  update(identity: AuthIdentity, id: string, input: UpdateDeviceDto) {
    if (input.timezone !== undefined && !validTimeZone(input.timezone)) throw new BadRequestException("Choose a valid IANA timezone, e.g. Asia/Kolkata.");
    if (input.siteId && !/^[0-9a-f-]{36}$/i.test(input.siteId)) throw new BadRequestException("Choose a valid site.");
    return this.database.tenantTransaction(identity, async (client) => {
      const before = (await client.query(`SELECT name, vendor, site_id, timezone, status FROM integration_devices WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id])).rows[0];
      if (!before) throw new NotFoundException("Device not found.");
      if (before.status === "REVOKED" && input.status) throw new ConflictException("A revoked device cannot be re-enabled. Rotate its secret to bring it back.");
      if (input.siteId) await this.requireSite(client, identity.organizationId, input.siteId);
      const row = (await client.query(
        `UPDATE integration_devices SET name=coalesce($3,name), vendor=coalesce($4,vendor),
                site_id=CASE WHEN $5::text IS NULL THEN site_id WHEN $5='' THEN NULL ELSE $5::uuid END,
                timezone=coalesce($6,timezone), status=coalesce($7,status), version=version+1, updated_at=now()
          WHERE organization_id=$1 AND id=$2 AND version=$8 RETURNING id, version, status`,
        [identity.organizationId, id, input.name?.trim() ?? null, input.vendor ?? null, input.siteId ?? null, input.timezone ?? null, input.status ?? null, input.version])).rows[0];
      if (!row) throw new ConflictException("This device changed since you opened it. Refresh and try again.");
      await audit(client, identity, "INTEGRATION_DEVICE_UPDATED", "integration_device", id, input, before);
      return row;
    });
  }

  rotate(identity: AuthIdentity, id: string, version: number) {
    return this.database.tenantTransaction(identity, async (client) => {
      const salt = newSalt();
      const secret = deriveSecret("device", id, salt);
      const row = (await client.query(
        `UPDATE integration_devices SET secret_salt=$3, secret_hash=$4, secret_rotated_at=now(), status=CASE WHEN status='REVOKED' THEN 'ACTIVE' ELSE status END,
                version=version+1, updated_at=now()
          WHERE organization_id=$1 AND id=$2 AND version=$5 RETURNING id, version, serial_number AS "serialNumber"`,
        [identity.organizationId, id, salt, sha256(secret), version])).rows[0];
      if (!row) throw new ConflictException("This device changed or was not found. Refresh and try again.");
      await audit(client, identity, "INTEGRATION_DEVICE_SECRET_ROTATED", "integration_device", id);
      return { ...row, secret, commKey: deriveSecret("comm", id, salt), secretNotice: "Copy the new secret and comm key now — they are shown only once. The old ones stopped working." };
    });
  }

  revoke(identity: AuthIdentity, id: string, version: number) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(
        `UPDATE integration_devices SET status='REVOKED', secret_salt=NULL, secret_hash=NULL, version=version+1, updated_at=now()
          WHERE organization_id=$1 AND id=$2 AND version=$3 RETURNING id, version, status`, [identity.organizationId, id, version])).rows[0];
      if (!row) throw new ConflictException("This device changed or was not found. Refresh and try again.");
      await audit(client, identity, "INTEGRATION_DEVICE_REVOKED", "integration_device", id);
      return row;
    });
  }

  punches(identity: AuthIdentity, id: string, query: DevicePunchesQuery) {
    return this.database.tenantTransaction(identity, async (client) => ({ items: (await client.query(
      `SELECT p.id, p.external_id AS "externalId", p.device_user_id AS "deviceUserId", p.occurred_at AS "occurredAt", p.punch_type AS "type",
              p.verify_mode AS "verifyMode", p.protocol, p.status, p.reason, p.received_at AS "receivedAt", e.full_name AS "employeeName", e.employee_number AS "employeeNumber"
         FROM integration_device_punches p LEFT JOIN employees e ON e.id=p.employee_id
        WHERE p.organization_id=$1 AND p.device_id=$2 AND ($3::text IS NULL OR p.status=$3) ORDER BY p.received_at DESC, p.occurred_at DESC LIMIT $4`,
      [identity.organizationId, id, query.status ?? null, query.limit ?? 100])).rows }));
  }

  employees(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => ({ items: (await client.query(
      `SELECT id, employee_number AS "number", full_name AS name, department, location FROM employees WHERE organization_id=$1 AND status='ACTIVE' ORDER BY full_name`,
      [identity.organizationId])).rows }));
  }

  private async requireSite(client: PoolClient, org: string, siteId: string) {
    if (!(await client.query(`SELECT 1 FROM attendance_sites WHERE organization_id=$1 AND id=$2`, [org, siteId])).rowCount)
      throw new BadRequestException("Choose one of your attendance sites.");
  }

  // ================================================================== admin: mappings & unmatched queue

  mappings(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => ({ items: (await client.query(
      `SELECT m.id, m.device_user_id AS "deviceUserId", m.device_id AS "deviceId", d.name AS "deviceName", d.serial_number AS "deviceSerial",
              e.id AS "employeeId", e.employee_number AS "employeeNumber", e.full_name AS "employeeName", e.department, m.created_at AS "createdAt"
         FROM integration_device_users m JOIN employees e ON e.id=m.employee_id LEFT JOIN integration_devices d ON d.id=m.device_id
        WHERE m.organization_id=$1 ORDER BY e.full_name, m.device_user_id`, [identity.organizationId])).rows }));
  }

  createMapping(identity: AuthIdentity, input: CreateMappingDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const id = await this.insertMapping(client, identity, input.employeeId, input.deviceUserId, input.deviceId || null);
      const replay = await this.replayUnmatched(client, identity, [input.deviceUserId]);
      return { id, ...replay };
    }).then((result) => this.afterReplay(result));
  }

  deleteMapping(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(`DELETE FROM integration_device_users WHERE organization_id=$1 AND id=$2 RETURNING device_user_id, employee_id, device_id`, [identity.organizationId, id])).rows[0];
      if (!row) throw new NotFoundException("Mapping not found.");
      await audit(client, identity, "INTEGRATION_DEVICE_MAPPING_DELETED", "integration_device_user", id, undefined, row);
      return { id, deleted: true };
    });
  }

  private async insertMapping(client: PoolClient, identity: AuthIdentity, employeeId: string, pin: string, deviceId: string | null) {
    const employee = (await client.query(`SELECT id FROM employees WHERE organization_id=$1 AND id=$2 AND status='ACTIVE'`, [identity.organizationId, employeeId])).rows[0];
    if (!employee) throw new BadRequestException("Choose an active employee.");
    if (deviceId && !(await client.query(`SELECT 1 FROM integration_devices WHERE organization_id=$1 AND id=$2`, [identity.organizationId, deviceId])).rowCount)
      throw new BadRequestException("Choose one of your devices.");
    const existing = (await client.query(
      `SELECT m.id, m.employee_id, e.full_name FROM integration_device_users m JOIN employees e ON e.id=m.employee_id
        WHERE m.organization_id=$1 AND m.device_user_id=$2 AND m.device_id IS NOT DISTINCT FROM $3`, [identity.organizationId, pin, deviceId])).rows[0];
    if (existing) {
      if (existing.employee_id === employeeId) return existing.id as string;
      throw new ConflictException(`Device user ${pin} is already mapped to ${existing.full_name}. Remove that mapping first.`);
    }
    const id = (await client.query(
      `INSERT INTO integration_device_users(organization_id,device_id,device_user_id,employee_id,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [identity.organizationId, deviceId, pin, employeeId, identity.employeeId])).rows[0].id as string;
    await audit(client, identity, "INTEGRATION_DEVICE_MAPPING_CREATED", "integration_device_user", id, { employeeId, deviceUserId: pin, deviceId });
    return id;
  }

  /** CSV: employee_number,device_user_id[,device_serial]. Dry run validates only; otherwise valid rows are applied. */
  importMappings(identity: AuthIdentity, input: ImportMappingsDto) {
    const lines = input.csv.replace(/^﻿/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) throw new BadRequestException("Add a header row and at least one mapping.");
    if (lines.length > 5001) throw new BadRequestException("Import up to 5,000 mappings at a time.");
    const header = lines[0].toLowerCase().split(",").map((cell) => cell.replace(/"/g, "").trim());
    const col = (names: string[]) => header.findIndex((cell) => names.includes(cell));
    const numberCol = col(["employee_number", "employee_code", "employee number", "emp_code"]);
    const pinCol = col(["device_user_id", "device user id", "pin", "enroll_id", "user_id"]);
    const serialCol = col(["device_serial", "serial_number", "device serial"]);
    if (numberCol < 0 || pinCol < 0) throw new BadRequestException("The header must include employee_number and device_user_id (device_serial is optional).");
    return this.database.tenantTransaction(identity, async (client) => {
      const employees = new Map((await client.query(`SELECT employee_number, id, full_name FROM employees WHERE organization_id=$1 AND status='ACTIVE'`, [identity.organizationId])).rows
        .map((row) => [row.employee_number.toUpperCase(), row]));
      const devices = new Map((await client.query(`SELECT upper(serial_number) AS serial, id FROM integration_devices WHERE organization_id=$1`, [identity.organizationId])).rows
        .map((row) => [row.serial, row.id as string]));
      const existing = new Map((await client.query(`SELECT device_user_id, device_id, employee_id FROM integration_device_users WHERE organization_id=$1`, [identity.organizationId])).rows
        .map((row) => [`${row.device_user_id}|${row.device_id || ""}`, row.employee_id as string]));
      const seen = new Set<string>();
      const rows: { line: number; employeeNumber: string; deviceUserId: string; deviceSerial: string; status: "NEW" | "UNCHANGED" | "ERROR"; error?: string; employeeName?: string }[] = [];
      for (let index = 1; index < lines.length; index += 1) {
        const cells = lines[index].split(",").map((cell) => cell.replace(/^"|"$/g, "").trim());
        const employeeNumber = (cells[numberCol] || "").toUpperCase();
        const pin = cells[pinCol] || "";
        const serial = serialCol >= 0 ? (cells[serialCol] || "").toUpperCase() : "";
        const row = { line: index + 1, employeeNumber, deviceUserId: pin, deviceSerial: serial, status: "NEW" as "NEW" | "UNCHANGED" | "ERROR", error: undefined as string | undefined, employeeName: undefined as string | undefined };
        const employee = employees.get(employeeNumber);
        const deviceId = serial ? devices.get(serial) : "";
        const key = `${pin}|${deviceId || ""}`;
        if (!employee) row.error = `No active employee ${employeeNumber || "(blank)"}`;
        else if (!PIN.test(pin)) row.error = "Device user ID must be 1–24 letters, digits, dash or underscore";
        else if (serial && !deviceId) row.error = `Unknown device serial ${serial}`;
        else if (seen.has(key)) row.error = `Device user ${pin} appears twice in this file`;
        else if (existing.has(key) && existing.get(key) !== employee.id) row.error = `Device user ${pin} is already mapped to someone else`;
        else if (existing.get(key) === employee.id) row.status = "UNCHANGED";
        if (row.error) row.status = "ERROR";
        row.employeeName = employee?.full_name;
        seen.add(key);
        rows.push(row);
      }
      const summary = { total: rows.length, new: rows.filter((row) => row.status === "NEW").length, unchanged: rows.filter((row) => row.status === "UNCHANGED").length, errors: rows.filter((row) => row.status === "ERROR").length };
      if (input.dryRun) return { dryRun: true, summary, rows: rows.slice(0, 500), replayed: 0, deliveryIds: [] as string[] };
      const pins: string[] = [];
      for (const row of rows.filter((item) => item.status === "NEW")) {
        const employee = employees.get(row.employeeNumber)!;
        const deviceId = row.deviceSerial ? devices.get(row.deviceSerial)! : null;
        await client.query(`INSERT INTO integration_device_users(organization_id,device_id,device_user_id,employee_id,created_by) VALUES($1,$2,$3,$4,$5)`,
          [identity.organizationId, deviceId, row.deviceUserId, employee.id, identity.employeeId]);
        pins.push(row.deviceUserId);
      }
      if (pins.length)
        await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'INTEGRATION_DEVICE_MAPPINGS_IMPORTED','organization',$1,$3)`,
          [identity.organizationId, identity.userId, JSON.stringify(summary)]);
      const replay = pins.length ? await this.replayUnmatched(client, identity, pins) : { replayed: 0, deliveryIds: [] as string[] };
      return { dryRun: false, summary, rows: rows.filter((row) => row.status === "ERROR").slice(0, 500), ...replay };
    }).then((result) => this.afterReplay(result));
  }

  unmatched(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => ({ items: (await client.query(
      `SELECT p.device_user_id AS "deviceUserId", count(*)::int AS punches, min(p.occurred_at) AS "firstAt", max(p.occurred_at) AS "lastAt",
              array_agg(DISTINCT d.name) AS devices, array_agg(DISTINCT d.id::text) AS "deviceIds",
              (array_agg(p.id ORDER BY p.occurred_at DESC))[1:200] AS "punchIds"
         FROM integration_device_punches p JOIN integration_devices d ON d.id=p.device_id
        WHERE p.organization_id=$1 AND p.status='UNMATCHED' GROUP BY p.device_user_id ORDER BY max(p.occurred_at) DESC LIMIT 200`,
      [identity.organizationId])).rows }));
  }

  resolveUnmatched(identity: AuthIdentity, input: ResolveUnmatchedDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const mappingId = await this.insertMapping(client, identity, input.employeeId, input.deviceUserId, input.deviceId || null);
      const replay = await this.replayUnmatched(client, identity, [input.deviceUserId]);
      await audit(client, identity, "INTEGRATION_UNMATCHED_RESOLVED", "integration_device_user", mappingId, { deviceUserId: input.deviceUserId, employeeId: input.employeeId, replayed: replay.replayed });
      return { mappingId, ...replay };
    }).then((result) => this.afterReplay(result));
  }

  ignorePunches(identity: AuthIdentity, punchIds: string[]) {
    return this.database.tenantTransaction(identity, async (client) => {
      const rows = (await client.query(
        `UPDATE integration_device_punches SET status='IGNORED', reason='Dismissed by HR', resolved_at=now(), resolved_by=$3
          WHERE organization_id=$1 AND id = ANY($2::uuid[]) AND status='UNMATCHED' RETURNING id`, [identity.organizationId, punchIds, identity.employeeId])).rows;
      if (rows.length)
        await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'INTEGRATION_PUNCHES_IGNORED','organization',$1,$3)`,
          [identity.organizationId, identity.userId, JSON.stringify({ count: rows.length })]);
      return { ignored: rows.length };
    });
  }

  /** Re-processes UNMATCHED punches for these PINs now that a mapping exists (oldest first so IN/OUT alternate correctly). */
  private async replayUnmatched(client: PoolClient, identity: AuthIdentity, pins: string[]) {
    const pending = (await client.query(
      `SELECT p.id, p.device_id, p.device_user_id, p.external_id, p.occurred_at, p.punch_type, d.serial_number
         FROM integration_device_punches p JOIN integration_devices d ON d.id=p.device_id
        WHERE p.organization_id=$1 AND p.status='UNMATCHED' AND p.device_user_id = ANY($2) ORDER BY p.occurred_at FOR UPDATE OF p`,
      [identity.organizationId, pins])).rows;
    const deliveryIds: string[] = [];
    let replayed = 0;
    for (const punch of pending) {
      const employeeId = await this.resolveEmployee(client, identity.organizationId, punch.device_id, punch.device_user_id);
      if (!employeeId) continue;
      const recorded = await this.attendance.recordDevicePunch(client, {
        organizationId: identity.organizationId, employeeId, occurredAt: new Date(punch.occurred_at),
        deviceSerial: punch.serial_number, externalId: punch.external_id, type: punch.punch_type || undefined,
      });
      const recordedType = "type" in recorded ? recorded.type : null;
      await client.query(
        `UPDATE integration_device_punches SET status='RECORDED', employee_id=$2, attendance_event_id=$3, reason='Replayed after mapping', resolved_at=now(), resolved_by=$4 WHERE id=$1`,
        [punch.id, employeeId, recorded.id, identity.employeeId || null]);
      if (!recorded.duplicate) deliveryIds.push(...await this.punchEvent(client, identity.organizationId, employeeId, recorded.id, punch.occurred_at, recordedType || punch.punch_type, punch.serial_number));
      replayed += 1;
    }
    return { replayed, deliveryIds };
  }

  private async afterReplay<T extends { deliveryIds: string[] }>(result: T) {
    await this.webhooks.dispatch(result.deliveryIds);
    const { deliveryIds: _ignored, ...rest } = result;
    return rest;
  }

  private async resolveEmployee(client: PoolClient, org: string, deviceId: string, pin: string): Promise<string | null> {
    const row = (await client.query(
      `SELECT m.employee_id FROM integration_device_users m JOIN employees e ON e.id=m.employee_id AND e.status='ACTIVE'
        WHERE m.organization_id=$1 AND m.device_user_id=$2 AND (m.device_id=$3 OR m.device_id IS NULL) ORDER BY m.device_id NULLS LAST LIMIT 1`,
      [org, pin, deviceId])).rows[0];
    return row?.employee_id ?? null;
  }

  private async punchEvent(client: PoolClient, org: string, employeeId: string, attendanceEventId: string, occurredAt: Date | string, type: string | null, serial: string) {
    const employee = (await client.query(`SELECT employee_number FROM employees WHERE id=$1`, [employeeId])).rows[0];
    return this.webhooks.emit(client, org, { type: "attendance.punch", entityType: "attendance_event", entityId: attendanceEventId, payload: {
      attendanceEventId, employeeId, employeeNumber: employee?.employee_number, type, occurredAt: new Date(occurredAt).toISOString(), source: "BIOMETRIC", deviceSerial: serial,
    } });
  }

  // ================================================================== ingestion (device-authenticated)

  private async deviceBySerial(serial: string): Promise<Device | null> {
    if (!serial || !/^[A-Za-z0-9._-]{4,40}$/.test(serial)) return null;
    return (await this.database.systemQuery<Device>(
      `SELECT id, organization_id, serial_number, name, timezone, status, secret_salt, secret_hash FROM integration_devices WHERE upper(serial_number)=upper($1)`, [serial])).rows[0] ?? null;
  }

  /** JSON API auth: x-device-serial, x-timestamp (unix seconds), x-signature = hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`). */
  async authenticateSigned(headers: Record<string, string | string[] | undefined>, raw: Buffer | undefined): Promise<Device> {
    const header = (name: string) => { const value = headers[name]; return Array.isArray(value) ? value[0] : value || ""; };
    const serial = header("x-device-serial");
    const timestamp = header("x-timestamp");
    const signature = header("x-signature").replace(/^sha256=/i, "").toLowerCase();
    if (!serial || !timestamp || !signature) throw new UnauthorizedException("Send x-device-serial, x-timestamp and x-signature headers.");
    if (!raw) throw new BadRequestException("Request body is required.");
    const device = await this.deviceBySerial(serial);
    if (!device || !device.secret_salt || !device.secret_hash) throw new UnauthorizedException("Device authentication failed.");
    const secret = deriveSecret("device", device.id, device.secret_salt);
    if (!safeEqual(sha256(secret), device.secret_hash)) throw new UnauthorizedException("Device authentication failed.");
    if (!safeEqual(hmacHex(secret, Buffer.concat([Buffer.from(`${timestamp}.`), raw])), signature)) throw new UnauthorizedException("Device authentication failed: bad signature.");
    const ts = Number(timestamp);
    if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > REPLAY_WINDOW_SECONDS)
      throw new UnauthorizedException(`Request timestamp is outside the ${REPLAY_WINDOW_SECONDS / 60}-minute window. Check the device clock.`);
    if (device.status !== "ACTIVE") throw new ForbiddenException("This device is disabled.");
    await this.database.systemQuery(`DELETE FROM integration_device_nonces WHERE device_id=$1 AND seen_at < now() - make_interval(secs => $2)`, [device.id, REPLAY_WINDOW_SECONDS * 2]);
    const fresh = await this.database.systemQuery(`INSERT INTO integration_device_nonces(device_id,signature) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING 1`, [device.id, signature]);
    if (!fresh.rowCount) throw new HttpException("Replay detected: this signed request was already received.", 409);
    return device;
  }

  /** ADMS auth: serial number + per-device comm key (query ?key= / ?CommKey= or header x-comm-key). */
  async authenticateAdms(serial: string, key: string): Promise<Device | null> {
    const device = await this.deviceBySerial(serial);
    if (!device || !device.secret_salt || device.status !== "ACTIVE" || !key) return null;
    return safeEqual(deriveSecret("comm", device.id, device.secret_salt), key.trim()) ? device : null;
  }

  async parseSignedBatch(body: unknown) {
    const batch = plainToInstance(DevicePunchBatch, body ?? {});
    const errors = await validate(batch, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length) {
      const messages = errors.flatMap((error) => error.children?.length
        ? error.children.flatMap((child) => child.children?.flatMap((leaf) => Object.values(leaf.constraints || {}).map((m) => `punches[${child.property}]: ${m}`)) || [])
        : Object.values(error.constraints || {}));
      throw new BadRequestException(messages.slice(0, 20));
    }
    return batch;
  }

  async parseHeartbeat(body: unknown) {
    const beat = plainToInstance(DeviceHeartbeat, body ?? {});
    const errors = await validate(beat, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length) throw new BadRequestException(errors.flatMap((error) => Object.values(error.constraints || {})));
    return beat;
  }

  async heartbeat(device: Device, ip: string, protocol: "JSON" | "ADMS", firmware?: string) {
    await this.database.systemQuery(
      `UPDATE integration_devices SET last_seen_at=now(), last_ip=$2, protocol=$3, firmware=coalesce($4,firmware) WHERE id=$1`,
      [device.id, ip.slice(0, 64), protocol, firmware?.slice(0, 60) || null]);
    return { serverTime: new Date().toISOString(), device: device.serial_number, status: device.status };
  }

  async ingest(device: Device, punches: IncomingPunch[], protocol: "JSON" | "ADMS", ip: string) {
    const now = Date.now();
    const prepared = punches.map((punch) => ({ ...punch, at: parseDeviceTime(punch.occurredAt, device.timezone) }))
      .sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
    const result = await this.database.tenantTransaction(systemIdentity(device.organization_id), async (client) => {
      const results: PunchResult[] = [];
      const deliveryIds: string[] = [];
      for (const punch of prepared) {
        let status: PunchResult["status"];
        let reason: string | undefined;
        if (!punch.at) { status = "REJECTED"; reason = "Unreadable timestamp"; }
        else if (punch.at.getTime() > now + REPLAY_WINDOW_SECONDS * 1000) { status = "REJECTED"; reason = "Timestamp is in the future — check the device clock"; }
        else if (punch.at.getTime() < now - MAX_AGE_DAYS * 86_400_000) { status = "REJECTED"; reason = `Older than ${MAX_AGE_DAYS} days`; }
        else status = "UNMATCHED";
        const employeeId = status === "UNMATCHED" ? await this.resolveEmployee(client, device.organization_id, device.id, punch.deviceUserId) : null;
        await client.query("SAVEPOINT punch");
        try {
          const inserted = (await client.query(
            `INSERT INTO integration_device_punches(organization_id,device_id,external_id,device_user_id,occurred_at,punch_type,verify_mode,raw,protocol,status,employee_id,reason)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (device_id, external_id) DO NOTHING RETURNING id`,
            [device.organization_id, device.id, punch.externalId, punch.deviceUserId, punch.at ?? new Date(now), punch.type ?? null, punch.verifyMode ?? null,
             JSON.stringify(punch.raw), protocol, employeeId ? "RECORDED" : status, employeeId, reason ?? (status === "UNMATCHED" && !employeeId ? "No employee mapped to this device user ID" : null)])).rows[0];
          if (!inserted) { await client.query("RELEASE SAVEPOINT punch"); results.push({ externalId: punch.externalId, status: "DUPLICATE" }); continue; }
          if (employeeId && punch.at) {
            const recorded = await this.attendance.recordDevicePunch(client, {
              organizationId: device.organization_id, employeeId, occurredAt: punch.at, deviceSerial: device.serial_number, externalId: punch.externalId, type: punch.type,
            });
            const recordedType = "type" in recorded ? recorded.type : null;
            await client.query(`UPDATE integration_device_punches SET attendance_event_id=$2, punch_type=coalesce(punch_type,$3) WHERE id=$1`, [inserted.id, recorded.id, recordedType]);
            if (!recorded.duplicate) deliveryIds.push(...await this.punchEvent(client, device.organization_id, employeeId, recorded.id, punch.at, recordedType ?? punch.type ?? null, device.serial_number));
            results.push({ externalId: punch.externalId, status: "RECORDED", attendanceEventId: recorded.id });
          } else results.push({ externalId: punch.externalId, status, reason: reason ?? "No employee mapped to this device user ID — queued for HR" });
          await client.query("RELEASE SAVEPOINT punch");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT punch");
          results.push({ externalId: punch.externalId, status: "REJECTED", reason: error instanceof Error ? error.message.slice(0, 200) : "Could not record punch" });
        }
      }
      await client.query(
        `UPDATE integration_devices SET last_seen_at=now(), last_ip=$2, protocol=$3, last_punch_at=CASE WHEN $4 THEN now() ELSE last_punch_at END WHERE id=$1`,
        [device.id, ip.slice(0, 64), protocol, results.some((item) => item.status !== "DUPLICATE")]);
      return { results, deliveryIds };
    });
    await this.webhooks.dispatch(result.deliveryIds);
    const count = (status: string) => result.results.filter((item) => item.status === status).length;
    return { received: punches.length, recorded: count("RECORDED"), unmatched: count("UNMATCHED"), duplicates: count("DUPLICATE"), rejected: count("REJECTED"), results: result.results };
  }

  // ================================================================== ADMS protocol helpers

  admsOptions(device: Device) {
    return [
      `GET OPTION FROM: ${device.serial_number}`, "ATTLOGStamp=None", "OPERLOGStamp=9999", "ATTPHOTOStamp=None", "ErrorDelay=30", "Delay=10",
      "TransTimes=00:00;14:05", "TransInterval=1", "TransFlag=TransData AttLog", `TimeZone=${zoneHours(device.timezone)}`, "Realtime=1", "Encrypt=None", "",
    ].join("\n");
  }

  /** ATTLOG rows: PIN \t YYYY-MM-DD HH:mm:ss \t status \t verify \t workcode \t … */
  parseAttlog(text: string): IncomingPunch[] {
    const verify: Record<string, string> = { "0": "PIN", "1": "FINGER", "2": "CARD", "4": "CARD", "15": "FACE", "25": "PALM" };
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 5000).map((line) => {
      const [pin = "", time = "", state = "", mode = ""] = line.split("\t").map((cell) => cell.trim());
      const type = ["0", "3", "4"].includes(state) ? "IN" as const : ["1", "2", "5"].includes(state) ? "OUT" as const : undefined;
      return { externalId: `${pin}@${time.replace(/\D/g, "")}`.slice(0, 80), deviceUserId: PIN.test(pin) ? pin : pin.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "unknown",
        occurredAt: time, type, verifyMode: verify[mode] ?? (mode || undefined), raw: { line } };
    });
  }
}

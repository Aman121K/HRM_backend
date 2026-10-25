import { ForbiddenException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";

export const INTEGRATION_ADMIN_ROLES = ["HR_ADMIN", "OWNER"];
export const FINANCE_ROLES = ["PAYROLL_ADMIN", "HR_ADMIN", "OWNER"];
export const ALL_INTEGRATION_ROLES = ["HR_ADMIN", "OWNER", "PAYROLL_ADMIN"];

export const isIntegrationAdmin = (identity: AuthIdentity) => identity.roles.some((role) => INTEGRATION_ADMIN_ROLES.includes(role));
export const isFinance = (identity: AuthIdentity) => identity.roles.some((role) => FINANCE_ROLES.includes(role));
export function requireFinance(identity: AuthIdentity) {
  if (!isFinance(identity)) throw new ForbiddenException("Only payroll or HR administrators can do this.");
}

/** Identity used by background jobs and device/bank callbacks, which act for an organization but not as a person. */
export const systemIdentity = (organizationId: string): AuthIdentity => ({ organizationId, userId: "system", employeeId: "", roles: [] });

export async function audit(client: PoolClient, identity: AuthIdentity, action: string, entityType: string, entityId: string, after?: unknown, before?: unknown) {
  await client.query(
    `INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [identity.organizationId, identity.userId, action, entityType, entityId, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after)]);
}

/** UTC offset (ms) of an IANA zone at an instant. */
function zoneOffset(at: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(at / 1000) * 1000;
}

/**
 * Parses a device timestamp. ISO strings with an offset/Z are taken as-is; "YYYY-MM-DD HH:mm:ss" (what ADMS devices
 * send) is local wall-clock time in the device's timezone.
 */
export function parseDeviceTime(value: string, timeZone: string): Date | null {
  const trimmed = value.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  let utc = wall - zoneOffset(wall, timeZone);
  utc = wall - zoneOffset(utc, timeZone);
  const date = new Date(utc);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function validTimeZone(zone: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

/** Offset in hours for ADMS "TimeZone=" option (e.g. 5.5 for Asia/Kolkata). */
export const zoneHours = (timeZone: string) => Math.round(zoneOffset(Date.now(), timeZone) / 900_000) / 4;

/** Whole paise from a rupee amount (numeric strings from pg). */
export const paise = (value: number | string | null | undefined) => Math.round(Number(value || 0) * 100);
export const rupees = (valuePaise: number) => (valuePaise / 100).toFixed(2);

export function istDate(at: Date | string | number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(at));
}

export function lastDayOfPeriod(period: string) {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * CSV cell safe to open in Excel/Sheets/LibreOffice: a cell starting with = + - @ TAB or CR is a formula there
 * (CSV/formula injection), so it is prefixed with a single quote. Plain numbers (e.g. -1250.00) are left alone.
 * Then RFC 4180 quoting when the cell contains a comma, quote or line break.
 */
export function csvSafe(value: string | number | null | undefined) {
  const text = value === null || value === undefined ? "" : String(value);
  const neutral = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(neutral) ? `"${neutral.replace(/"/g, '""')}"` : neutral;
}

// Shared plumbing for people analytics: date ranges, access scope, the scoped population CTE, suppression and caching.
import { BadRequestException } from "@nestjs/common";
import type { PoolClient, QueryResultRow } from "pg";
import type { AuthIdentity } from "../auth/auth.types";

export const ORG_TZ = "Asia/Kolkata";
export const MAX_MONTHS = 24;
/** Groups smaller than this are hidden in sensitive breakdowns (attrition, pay, performance, eNPS). */
export const MIN_GROUP = 3;

export type Format = "number" | "percent" | "money" | "days" | "hours" | "months" | "decimal" | "text";
export type Access = { manager: boolean; finance: boolean };
export type Scope = { kind: "org" | "team"; root: string | null; label: string; roles: string[] };

export type Range = {
  fromMonth: string; toMonth: string; months: string[];
  fromDate: string; toDate: string; // inclusive calendar dates (toDate capped at today)
  fromTs: string; toTs: string; // [fromTs, toTs) instants in the org timezone
  partialLastMonth: boolean;
};
export type Filters = { from?: string; to?: string; department?: string; location?: string };

const HR_ROLES = ["HR_ADMIN", "OWNER"];
export const isHr = (identity: AuthIdentity) => identity.roles.some((role) => HR_ROLES.includes(role));

/** Resolve who may run a report and over which population. `null` means the viewer has no access. */
export function resolveScope(identity: AuthIdentity, access: Access): Scope | null {
  const roles = identity.roles;
  if (isHr(identity)) return { kind: "org", root: null, label: "Whole organisation", roles };
  if (access.finance && roles.includes("PAYROLL_ADMIN")) return { kind: "org", root: null, label: "Whole organisation · finance view", roles };
  if (access.manager && roles.includes("MANAGER")) return { kind: "team", root: identity.employeeId, label: "Your reporting line (direct + indirect)", roles };
  return null;
}

// ---- dates ---------------------------------------------------------------------------------------
export function todayInOrg() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ORG_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
export const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
export const monthFromIndex = (index: number) => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
export const addMonths = (month: string, delta: number) => monthFromIndex(monthIndex(month) + delta);
const lastDay = (month: string) => {
  const [year, mon] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(year, mon, 0)).getUTCDate()).padStart(2, "0")}`;
};
const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export function buildRange(fromMonth: string, toMonth: string): Range {
  const today = todayInOrg();
  const months: string[] = [];
  for (let index = monthIndex(fromMonth); index <= monthIndex(toMonth); index += 1) months.push(monthFromIndex(index));
  const end = lastDay(toMonth) > today ? today : lastDay(toMonth);
  return {
    fromMonth, toMonth, months, fromDate: `${fromMonth}-01`, toDate: end,
    fromTs: `${fromMonth}-01T00:00:00+05:30`, toTs: `${nextDay(end)}T00:00:00+05:30`,
    partialLastMonth: end < lastDay(toMonth),
  };
}

/** Validate the requested window: whole months, not in the future, at most 24 months. Defaults to the last 12 months. */
export function parseRange(filters: Filters): Range {
  const current = todayInOrg().slice(0, 7);
  let to = filters.to || current;
  if (to > current) to = current;
  const from = filters.from || addMonths(to, -11);
  if (from > to) throw new BadRequestException("The start month must be on or before the end month.");
  if (monthIndex(to) - monthIndex(from) + 1 > MAX_MONTHS) throw new BadRequestException(`Choose a range of at most ${MAX_MONTHS} months.`);
  return buildRange(from, to);
}

/** The equally long window immediately before `range`, used for period-over-period deltas. */
export function previousRange(range: Range) {
  const length = range.months.length;
  return buildRange(addMonths(range.fromMonth, -length), addMonths(range.fromMonth, -1));
}

// ---- the scoped population -----------------------------------------------------------------------
/**
 * Every metric starts from `pop`: the employees the viewer may analyse, after department/location filters,
 * with a derived exit date. Parameters: $1 org, $2 from date, $3 to date, $4 department, $5 location,
 * $6 team root (NULL = whole org), $7 from instant, $8 to instant.
 * Indexes: employees_manager_directory (organization_id, manager_id, …) drives each recursion step of `team`;
 * hr_cases_module_board (organization_id, module, status, …) finds completed resignations for `exits`.
 */
export const POP = `
WITH RECURSIVE bounds AS (SELECT $2::date AS d0, $3::date AS d1, $7::timestamptz AS t0, $8::timestamptz AS t1),
team AS (
  SELECT e.id FROM employees e WHERE e.organization_id=$1 AND e.manager_id=$6::uuid
  UNION
  SELECT e.id FROM employees e JOIN team t ON e.manager_id=t.id WHERE e.organization_id=$1
),
exits AS (
  SELECT DISTINCT ON (c.requester_id) c.requester_id AS employee_id,
         coalesce(c.end_date, (c.closed_at AT TIME ZONE '${ORG_TZ}')::date) AS exit_date, c.category AS reason
    FROM hr_cases c WHERE c.organization_id=$1 AND c.module='exit' AND c.status='COMPLETED'
   ORDER BY c.requester_id, c.closed_at DESC NULLS LAST
),
pop AS MATERIALIZED (
  SELECT e.id, e.full_name, e.employee_number, e.manager_id, e.status, e.joining_date,
         coalesce(nullif(e.department,''),'Unassigned') AS department,
         coalesce(nullif(e.location,''),'Unassigned') AS location,
         coalesce(nullif(e.designation,''),'Unassigned') AS designation,
         coalesce(x.exit_date, CASE WHEN e.status<>'ACTIVE' THEN (e.updated_at AT TIME ZONE '${ORG_TZ}')::date END) AS exit_date,
         CASE WHEN x.employee_id IS NOT NULL THEN coalesce(x.reason,'Not recorded')
              WHEN e.status<>'ACTIVE' THEN 'Deactivated without exit case' END AS exit_reason
    FROM employees e LEFT JOIN exits x ON x.employee_id=e.id
   WHERE e.organization_id=$1
     AND ($6::uuid IS NULL OR e.id IN (SELECT id FROM team))
     AND ($4::text IS NULL OR coalesce(nullif(e.department,''),'Unassigned')=$4)
     AND ($5::text IS NULL OR coalesce(nullif(e.location,''),'Unassigned')=$5)
),
months AS (
  SELECT m::date AS month, least((m + interval '1 month' - interval '1 day')::date, $3::date) AS month_end
    FROM generate_series(date_trunc('month',$2::date), date_trunc('month',$3::date), interval '1 month') m
)`;

export class Ctx {
  private tableCache = new Map<string, boolean>();
  private columnCache = new Map<string, boolean>();
  constructor(readonly client: PoolClient, readonly identity: AuthIdentity, readonly scope: Scope, readonly range: Range, readonly filters: Filters) {}
  get org() { return this.identity.organizationId; }
  /** Positional parameters matching POP ($1…$8) for `range`. */
  values(range: Range = this.range): unknown[] {
    return [this.org, range.fromDate, range.toDate, this.filters.department || null, this.filters.location || null, this.scope.root, range.fromTs, range.toTs];
  }
  async rows<T extends QueryResultRow = Record<string, any>>(sql: string, values: unknown[]): Promise<T[]> {
    return (await this.client.query<T>(sql, values)).rows;
  }
  /** Scoped query: POP + extra CTEs/SELECT, with the standard parameters (+ any extras from $9). */
  pop<T extends QueryResultRow = Record<string, any>>(tail: string, range: Range = this.range, extra: unknown[] = []) {
    return this.rows<T>(`${POP}${tail}`, [...this.values(range), ...extra]);
  }
  /** Does a table from a parallel feature exist yet? (to_regclass, cached per request) */
  async hasTable(name: string) {
    if (!this.tableCache.has(name)) {
      const row = (await this.client.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`])).rows[0];
      this.tableCache.set(name, Boolean(row?.ok));
    }
    return this.tableCache.get(name)!;
  }
  async hasTables(...names: string[]) {
    for (const name of names) if (!(await this.hasTable(name))) return false;
    return true;
  }
  async hasColumn(table: string, column: string) {
    const key = `${table}.${column}`;
    if (!this.columnCache.has(key)) {
      const row = (await this.client.query(
        `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2) AS ok`, [table, column])).rows[0];
      this.columnCache.set(key, Boolean(row?.ok));
    }
    return this.columnCache.get(key)!;
  }
}

// ---- helpers -------------------------------------------------------------------------------------
export const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
export const numOrNull = (value: unknown) => (value === null || value === undefined ? null : Number(value));
export const round = (value: number | null, digits = 1) => (value === null || !Number.isFinite(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits);
export const pct = (part: number, whole: number, digits = 1) => (whole > 0 ? round((part / whole) * 100, digits) : null);
export const sum = (values: (number | null | undefined)[]) => values.reduce<number>((total, value) => total + (value || 0), 0);
export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function change(current: number | null, previous: number | null) {
  if (current === null || previous === null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return round(((current - previous) / Math.abs(previous)) * 100, 1);
}
export const monthLabel = (month: string) =>
  new Intl.DateTimeFormat("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));

/**
 * Small-number suppression: groups below MIN_GROUP people have their sensitive values blanked. Suppressed groups are
 * pooled into one "Other groups (combined)" row, which is itself blanked if it is still too small.
 */
export function suppress<T extends Record<string, any>>(rows: T[], sizeKey: keyof T, sensitive: (keyof T)[], labelKey: keyof T, combine?: (rows: T[]) => T) {
  const visible = rows.filter((row) => num(row[sizeKey]) >= MIN_GROUP);
  const hidden = rows.filter((row) => num(row[sizeKey]) < MIN_GROUP && num(row[sizeKey]) > 0);
  const blank = (row: T) => { const copy: Record<string, any> = { ...row, suppressed: true }; for (const key of sensitive) copy[key as string] = null; return copy as T; };
  const out: T[] = visible.map((row) => ({ ...row, suppressed: false }));
  if (hidden.length) {
    if (combine && hidden.length > 1) {
      const pooled = { ...combine(hidden), [labelKey]: `Other groups (${hidden.length} combined)` } as T;
      out.push(num(pooled[sizeKey]) >= MIN_GROUP ? { ...pooled, suppressed: false } : blank(pooled));
    } else out.push(...hidden.map(blank));
  }
  return { rows: out, suppressedGroups: hidden.length };
}

// ---- short-lived result cache ---------------------------------------------------------------------
type Entry = { at: number; value: unknown };
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, Entry>();
export function cacheKey(identity: AuthIdentity, scope: Scope, name: string, filters: Filters) {
  return [identity.organizationId, scope.kind, scope.root || "-", scope.roles.slice().sort().join("+"), name, filters.from, filters.to, filters.department, filters.location].join("|");
}
export async function cached<T>(key: string, refresh: boolean, produce: () => Promise<T>): Promise<{ value: T; generatedAt: string; cached: boolean }> {
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return { value: hit.value as T, generatedAt: new Date(hit.at).toISOString(), cached: true };
  const value = await produce();
  const at = Date.now();
  cache.set(key, { at, value });
  if (cache.size > 500) for (const [k, entry] of cache) if (at - entry.at > CACHE_TTL_MS) cache.delete(k);
  return { value, generatedAt: new Date(at).toISOString(), cached: false };
}

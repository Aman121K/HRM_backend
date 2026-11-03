import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import type { ImportCsvDto, UpdateEmployeeDto } from "./people-admin.dto";

export const PEOPLE_ADMIN_ROLES = ["HR_ADMIN", "OWNER"];
export const IMPORT_COLUMNS = ["employee_number", "full_name", "work_email", "department", "designation", "joining_date", "manager_employee_number", "role", "status", "location"] as const;
/** Only these columns must be present; the rest are optional and default sensibly (see review()). */
const REQUIRED_COLUMNS = ["full_name", "work_email", "joining_date"] as const;
const ROLES = ["OWNER", "HR_ADMIN", "MANAGER", "EMPLOYEE", "PAYROLL_ADMIN"];
/** Friendly role spellings HR teams actually type. */
const ROLE_ALIASES: Record<string, string> = { HR: "HR_ADMIN", "HR ADMIN": "HR_ADMIN", ADMIN: "HR_ADMIN", PAYROLL: "PAYROLL_ADMIN", "PAYROLL ADMIN": "PAYROLL_ADMIN", STAFF: "EMPLOYEE", EMP: "EMPLOYEE" };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** Roles only an OWNER may grant, change or deactivate. */
const PRIVILEGED = ["OWNER", "HR_ADMIN"];
const MAX_ROWS = 2000;

export type ImportRow = { row: number; normalized: Record<(typeof IMPORT_COLUMNS)[number], string>; errors: string[]; warnings: string[]; outcome: "CREATE" | "UPDATE" | "INVALID" };
type Existing = { id: string; user_id: string | null; employee_number: string; work_email: string; manager_id: string | null; role: string | null };

/** RFC-4180-ish CSV parser (quoted values, doubled quotes, CRLF). Blank lines are skipped. */
export function parseCsv(source: string) {
  const rows: string[][] = [];
  let row: string[] = [], value = "", quoted = false;
  const input = source.replace(/^﻿/, "");
  for (let n = 0; n <= input.length; n++) {
    const ch = input[n] ?? "\n";
    if (quoted && ch === '"' && input[n + 1] === '"') { value += '"'; n++; }
    else if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ",") { row.push(value.trim()); value = ""; }
    else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && input[n + 1] === "\n") n++;
      row.push(value.trim()); value = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else value += ch;
  }
  return rows;
}

/** Template with the brand's own ID prefix. The second row shows that the employee number may be left blank. */
export const templateCsv = (prefix = "EMP", managerNumber = `${prefix}001`) =>
  `${IMPORT_COLUMNS.join(",")}\n` +
  `${prefix}101,Asha Verma,asha.verma@yourcompany.com,Operations,Store Manager,2026-08-01,${managerNumber},MANAGER,ACTIVE,Pune\n` +
  `,Rohit Kumar,rohit.kumar@yourcompany.com,Operations,Barista,01/09/2026,asha.verma@yourcompany.com,EMPLOYEE,ACTIVE,Pune\n`;

/** A pg DATE (parsed as local midnight) as YYYY-MM-DD, without the UTC shift toISOString() would add. */
const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Header cell → column name: case, spaces and dashes don't matter ("Full Name" → full_name). */
const columnKey = (cell: string) => cell.trim().toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Dates as Indian spreadsheets write them: 2026-10-05, 05/10/2026, 5-10-2026, 05.10.2026, 5 Oct 2026, 05-Oct-26.
 * Day-first (Indian convention). Returns YYYY-MM-DD or null when the date doesn't exist.
 */
export function normalizeDate(value: string): string | null {
  const v = value.trim();
  let y: number, m: number, d: number;
  let match = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = v.match(/^(\d{1,2})[\s/-]([A-Za-z]{3,9})[\s/-](\d{2}|\d{4})$/))) {
    const month = MONTHS.indexOf(match[2].slice(0, 3).toLowerCase());
    if (month < 0) return null;
    [d, m, y] = [Number(match[1]), month + 1, match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3])];
  } else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d || y < 1950 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

@Injectable()
export class PeopleAdminService {
  constructor(private readonly database: DatabaseService) {}

  private isOwner(identity: AuthIdentity) { return identity.roles.includes("OWNER"); }

  /** CSV template using this brand's employee ID prefix and the downloading admin as the example manager. */
  template(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(
        `SELECT o.employee_prefix AS prefix, e.employee_number AS me FROM organizations o LEFT JOIN employees e ON e.organization_id=o.id AND e.id=$2 WHERE o.id=$1`,
        [identity.organizationId, identity.employeeId || null])).rows[0];
      return templateCsv(row?.prefix || "EMP", row?.me || undefined);
    });
  }

  /** HR edits one employee record (optimistic concurrency, audited, manager-cycle safe). */
  update(identity: AuthIdentity, id: string, input: UpdateEmployeeDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const before = (await client.query(
        `SELECT e.*, m.role AS membership_role FROM employees e
           LEFT JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.user_id=e.user_id
          WHERE e.organization_id=$1 AND e.id=$2 FOR UPDATE OF e`, [identity.organizationId, id])).rows[0];
      if (!before) throw new NotFoundException("Employee not found.");
      if (input.version !== before.version) throw new ConflictException("This employee was updated by someone else. Refresh and try again.");
      if (input.status && input.status !== before.status) {
        if (id === identity.employeeId) throw new ForbiddenException("You cannot change your own employment status.");
        if (PRIVILEGED.includes(before.membership_role) && !this.isOwner(identity)) throw new ForbiddenException("Only an owner can change the status of an owner or HR admin.");
      }
      if (input.workEmail && input.workEmail !== before.work_email) {
        const taken = await client.query(`SELECT employee_number FROM employees WHERE organization_id=$1 AND lower(work_email)=$2 AND id<>$3`, [identity.organizationId, input.workEmail, id]);
        if (taken.rowCount) throw new ConflictException(`${input.workEmail} already belongs to ${taken.rows[0].employee_number}.`);
      }
      if (input.managerId !== undefined && input.managerId !== null) {
        if (input.managerId === id) throw new BadRequestException("An employee cannot report to themselves.");
        const manager = await client.query(`SELECT 1 FROM employees WHERE organization_id=$1 AND id=$2 AND status='ACTIVE'`, [identity.organizationId, input.managerId]);
        if (!manager.rowCount) throw new BadRequestException("The reporting manager must be an active employee of this organization.");
        const cycle = await client.query(
          `WITH RECURSIVE chain(id, manager_id, depth) AS (
             SELECT id, manager_id, 1 FROM employees WHERE organization_id=$1 AND id=$2
             UNION ALL SELECT e.id, e.manager_id, c.depth+1 FROM employees e JOIN chain c ON e.id=c.manager_id WHERE e.organization_id=$1 AND c.depth < 50)
           SELECT 1 FROM chain WHERE id=$3`, [identity.organizationId, input.managerId, id]);
        if (cycle.rowCount) throw new BadRequestException("That manager reports (directly or indirectly) to this employee.");
      }
      if (input.joiningDate) {
        if (normalizeDate(input.joiningDate) !== input.joiningDate) throw new BadRequestException("Joining date is not a real date.");
        const salary = (await client.query(
          `SELECT to_char(min(effective_from),'YYYY-MM-DD') AS first FROM salary_structures WHERE organization_id=$1 AND employee_id=$2`, [identity.organizationId, id])).rows[0]?.first;
        if (salary && input.joiningDate > salary)
          throw new BadRequestException(`This person's salary structure starts on ${salary}. The joining date can't be after that — correct the salary structure first.`);
      }
      const next = {
        joining_date: input.joiningDate ?? before.joining_date,
        full_name: input.fullName ?? before.full_name, work_email: input.workEmail ?? before.work_email,
        department: input.department !== undefined ? input.department : before.department,
        designation: input.designation !== undefined ? input.designation : before.designation,
        location: input.location !== undefined ? input.location : before.location,
        status: input.status ?? before.status, manager_id: input.managerId !== undefined ? input.managerId : before.manager_id,
      };
      await client.query(
        `UPDATE employees SET full_name=$3,work_email=$4,department=$5,designation=$6,location=$7,status=$8,manager_id=$9,joining_date=$10,version=version+1,updated_at=now()
          WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, id, next.full_name, next.work_email, next.department, next.designation, next.location, next.status, next.manager_id, next.joining_date]);
      // An inactive employee loses sign-in to this organization; reactivation restores it.
      if (next.status !== before.status && before.user_id)
        await client.query(`UPDATE organization_memberships SET status=$3 WHERE organization_id=$1 AND user_id=$2`, [identity.organizationId, before.user_id, next.status]);
      const pick = (row: Record<string, unknown>) => ({ fullName: row.full_name, workEmail: row.work_email, department: row.department, designation: row.designation, location: row.location, status: row.status, managerId: row.manager_id, joiningDate: row.joining_date instanceof Date ? localDate(row.joining_date) : row.joining_date, version: row.version });
      await this.audit(client, identity, "EMPLOYEE_UPDATED", "employee", id, pick(before), { ...pick(next), version: before.version + 1 });
      return this.present(client, identity, id);
    });
  }

  async dryRun(identity: AuthIdentity, input: ImportCsvDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const rows = await this.review(client, identity, input.csv);
      return { rows, summary: this.summary(rows) };
    });
  }

  /** Re-validates the uploaded CSV inside the commit transaction; any invalid row aborts the whole import. */
  commit(identity: AuthIdentity, input: ImportCsvDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('employee_import:' || $1))`, [identity.organizationId]);
      const rows = await this.review(client, identity, input.csv);
      if (!rows.length) throw new BadRequestException("The file has no employee rows.");
      if (rows.some((row) => row.errors.length)) throw new BadRequestException({ message: "Only a file with no invalid rows can be committed. Validate it again and fix the highlighted rows.", rows, summary: this.summary(rows) });
      let created = 0, updated = 0;
      const ids = new Map<string, string>();
      for (const { normalized: x, outcome } of rows) {
        const email = x.work_email.toLowerCase();
        if (outcome === "CREATE") {
          const existingUser = (await client.query(`SELECT id FROM users WHERE lower(email)=$1`, [email])).rows[0];
          // Existing sign-in accounts are linked, never renamed or otherwise changed by a tenant import.
          const userId = existingUser?.id || (await client.query(`INSERT INTO users(email, full_name) VALUES($1,$2) RETURNING id`, [email, x.full_name])).rows[0].id;
          await client.query(
            `INSERT INTO organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,$3,$4)
             ON CONFLICT (organization_id,user_id) DO UPDATE SET role=excluded.role, status=excluded.status`,
            [identity.organizationId, userId, x.role, x.status]);
          const row = (await client.query(
            `INSERT INTO employees(organization_id,user_id,employee_number,full_name,work_email,department,designation,joining_date,status,location)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [identity.organizationId, userId, x.employee_number, x.full_name, email, x.department || null, x.designation || null, x.joining_date, x.status, x.location || null])).rows[0];
          ids.set(x.employee_number, row.id); created++;
          await this.audit(client, identity, "EMPLOYEE_IMPORTED", "employee", row.id, null, { ...x, work_email: email, outcome });
        } else {
          const before = (await client.query(`SELECT * FROM employees WHERE organization_id=$1 AND employee_number=$2 FOR UPDATE`, [identity.organizationId, x.employee_number])).rows[0];
          await client.query(
            `UPDATE employees SET full_name=$3,work_email=$4,department=$5,designation=$6,joining_date=$7,status=$8,location=$9,version=version+1,updated_at=now()
              WHERE organization_id=$1 AND id=$2`,
            [identity.organizationId, before.id, x.full_name, email, x.department || null, x.designation || null, x.joining_date, x.status, x.location || null]);
          if (before.user_id) await client.query(`UPDATE organization_memberships SET role=$3, status=$4 WHERE organization_id=$1 AND user_id=$2`, [identity.organizationId, before.user_id, x.role, x.status]);
          ids.set(x.employee_number, before.id); updated++;
          await this.audit(client, identity, "EMPLOYEE_IMPORTED", "employee", before.id,
            { full_name: before.full_name, work_email: before.work_email, department: before.department, designation: before.designation, status: before.status, location: before.location, manager_id: before.manager_id },
            { ...x, work_email: email, outcome });
        }
      }
      // Managers are resolved after every row exists, so a file may list a manager below their reports.
      for (const { normalized: x } of rows) {
        const managerId = x.manager_employee_number
          ? ids.get(x.manager_employee_number) || (await client.query(`SELECT id FROM employees WHERE organization_id=$1 AND employee_number=$2`, [identity.organizationId, x.manager_employee_number])).rows[0]?.id
          : null;
        await client.query(`UPDATE employees SET manager_id=$3 WHERE organization_id=$1 AND id=$2`, [identity.organizationId, ids.get(x.employee_number), managerId || null]);
      }
      const job = (await client.query(
        `INSERT INTO employee_import_jobs(organization_id,created_by,status,file_name,total_rows,valid_rows,invalid_rows,summary,committed_at)
         VALUES($1,$2,'COMMITTED',$3,$4,$4,0,$5,now()) RETURNING id`,
        [identity.organizationId, identity.userId, String(input.fileName || "employees.csv").slice(0, 200), rows.length, JSON.stringify({ created, updated })])).rows[0];
      await this.audit(client, identity, "EMPLOYEE_IMPORT_COMMITTED", "employee_import_job", job.id, null, { fileName: input.fileName || "employees.csv", total: rows.length, created, updated });
      return { jobId: job.id, created, updated, total: rows.length };
    });
  }

  private summary(rows: ImportRow[]) {
    return { total: rows.length, valid: rows.filter((row) => !row.errors.length).length, invalid: rows.filter((row) => row.errors.length).length };
  }

  private async review(client: PoolClient, identity: AuthIdentity, csv: string): Promise<ImportRow[]> {
    const parsed = parseCsv(csv);
    if (!parsed.length) throw new BadRequestException("The CSV file is empty.");
    const header = parsed[0].map(columnKey);
    const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
    if (missing.length) throw new BadRequestException(`Missing columns: ${missing.join(", ")}. Download the template to see the expected headings.`);
    if (parsed.length - 1 > MAX_ROWS) throw new BadRequestException(`Import at most ${MAX_ROWS} employees per file.`);
    const existing = new Map<string, Existing>((await client.query(
      `SELECT e.id, e.user_id, e.employee_number, lower(e.work_email) AS work_email, e.manager_id, m.role
         FROM employees e LEFT JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.user_id=e.user_id
        WHERE e.organization_id=$1`, [identity.organizationId])).rows.map((row: Existing) => [row.employee_number, row]));
    const emailOwner = new Map([...existing.values()].map((row) => [row.work_email, row.employee_number]));
    const rows: ImportRow[] = parsed.slice(1).map((values, index) => {
      const normalized = Object.fromEntries(IMPORT_COLUMNS.map((column) => [column, header.includes(column) ? (values[header.indexOf(column)] || "").trim() : ""])) as ImportRow["normalized"];
      const role = normalized.role.toUpperCase().replace(/_/g, " ").trim();
      normalized.role = ROLE_ALIASES[role] || role.replace(/ /g, "_") || "EMPLOYEE";
      normalized.status = normalized.status.toUpperCase() || "ACTIVE";
      normalized.work_email = normalized.work_email.toLowerCase();
      return { row: index + 2, normalized, errors: [], warnings: [], outcome: "CREATE" as const };
    });
    // Rows without an employee number get the next free number in this brand's series (e.g. GT014, GT015…).
    // Numbers are assigned in file order, so a dry run and the commit that follows it produce the same IDs.
    if (rows.some((row) => !row.normalized.employee_number)) {
      const prefix = (await client.query(`SELECT employee_prefix FROM organizations WHERE id=$1`, [identity.organizationId])).rows[0]?.employee_prefix || "EMP";
      const pattern = new RegExp(`^${prefix}(\\d+)$`);
      const used = [...existing.keys(), ...rows.map((row) => row.normalized.employee_number)].map((number) => Number(number.match(pattern)?.[1] || 0));
      let next = Math.max(0, ...used) + 1;
      for (const row of rows) {
        if (row.normalized.employee_number) continue;
        // Re-imports of a person already on file keep their number (matched by work email).
        const known = [...existing.values()].find((item) => item.work_email === row.normalized.work_email);
        if (known) { row.normalized.employee_number = known.employee_number; continue; }
        row.normalized.employee_number = `${prefix}${String(next++).padStart(3, "0")}`;
        row.warnings.push(`Employee number ${row.normalized.employee_number} assigned automatically`);
      }
    }
    // The manager column takes an employee number or the manager's work email.
    const numberByEmail = new Map<string, string>([...existing.values()].map((row) => [row.work_email, row.employee_number]));
    for (const row of rows) if (row.normalized.work_email) numberByEmail.set(row.normalized.work_email, row.normalized.employee_number);
    for (const row of rows) {
      const manager = row.normalized.manager_employee_number;
      if (manager.includes("@")) row.normalized.manager_employee_number = numberByEmail.get(manager.toLowerCase()) || manager;
    }
    for (const row of rows) {
      if (!row.normalized.joining_date) continue;
      const date = normalizeDate(row.normalized.joining_date);
      if (date) row.normalized.joining_date = date;
    }
    // Sign-in accounts that already exist for CREATE rows (linked, not modified).
    const emails = rows.map((row) => row.normalized.work_email.toLowerCase()).filter(Boolean);
    const accounts = new Map((await client.query(
      `SELECT lower(u.email) AS email, u.id, (SELECT e.employee_number FROM employees e WHERE e.organization_id=$1 AND e.user_id=u.id) AS linked_number,
              (SELECT m.role FROM organization_memberships m WHERE m.organization_id=$1 AND m.user_id=u.id) AS member_role
         FROM users u WHERE lower(u.email) = ANY($2)`, [identity.organizationId, emails])).rows.map((row) => [row.email, row]));
    const seen = new Set<string>(), seenEmail = new Set<string>();
    const fileNumbers = new Set(rows.map((row) => row.normalized.employee_number).filter(Boolean));
    for (const item of rows) {
      const x = item.normalized, errors = item.errors, warnings = item.warnings;
      const email = x.work_email.toLowerCase();
      const current = existing.get(x.employee_number);
      if (!/^[A-Za-z0-9_-]{2,30}$/.test(x.employee_number)) errors.push("Employee number is required (2–30 letters, digits, - or _)");
      if (seen.has(x.employee_number)) errors.push("Duplicate employee number in file");
      seen.add(x.employee_number);
      if (x.full_name.length < 2 || x.full_name.length > 120) errors.push("Full name is required (2–120 characters)");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) errors.push("Valid work email is required");
      else if (seenEmail.has(email)) errors.push("Duplicate work email in file");
      seenEmail.add(email);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(x.joining_date) || Number.isNaN(Date.parse(x.joining_date))) errors.push("Joining date is missing or not a real date (use DD/MM/YYYY or YYYY-MM-DD)");
      if (!ROLES.includes(x.role)) errors.push(`Role must be one of EMPLOYEE, MANAGER, HR_ADMIN, PAYROLL_ADMIN or OWNER`);
      if (!["ACTIVE", "INACTIVE"].includes(x.status)) errors.push("Status must be ACTIVE or INACTIVE");
      for (const column of ["department", "designation", "location"] as const) if (x[column].length > 120) errors.push(`${column} must be 120 characters or fewer`);
      if (x.manager_employee_number && x.manager_employee_number === x.employee_number) errors.push("Employee cannot manage themselves");
      else if (x.manager_employee_number && !existing.has(x.manager_employee_number) && !fileNumbers.has(x.manager_employee_number))
        errors.push(`Manager ${x.manager_employee_number} is not in this company or this file`);
      if (!x.manager_employee_number) warnings.push("No reporting manager assigned");
      const owner = emailOwner.get(email);
      if (owner && owner !== x.employee_number) errors.push(`Work email already belongs to ${owner}`);
      // Privilege rules: only an owner grants or alters owner/HR admin access; nobody edits their own access by import.
      if (PRIVILEGED.includes(x.role) && !this.isOwner(identity)) errors.push(`Only an owner can assign the ${x.role} role`);
      if (current) {
        item.outcome = "UPDATE";
        if (current.id === identity.employeeId && (x.role !== current.role || x.status !== "ACTIVE")) errors.push("You cannot change your own role or status");
        if (current.role && PRIVILEGED.includes(current.role) && !this.isOwner(identity) && (x.role !== current.role || x.status !== "ACTIVE"))
          errors.push(`Only an owner can change a ${current.role} member`);
        if (email && email !== current.work_email) warnings.push("Work email changes; the sign-in account is unchanged");
      } else {
        const account = accounts.get(email);
        if (account?.linked_number) errors.push(`This email already signs in as ${account.linked_number}`);
        else if (account?.member_role && PRIVILEGED.includes(account.member_role) && !this.isOwner(identity)) errors.push(`Only an owner can change a ${account.member_role} member`);
        else if (account) warnings.push("An existing ClanChief account with this email will be linked");
      }
      if (errors.length) item.outcome = "INVALID";
    }
    // Reporting-line cycles across existing records and the file.
    const managerOf = new Map<string, string | null>();
    const numberById = new Map([...existing.values()].map((row) => [row.id, row.employee_number]));
    for (const row of existing.values()) managerOf.set(row.employee_number, row.manager_id ? numberById.get(row.manager_id) || null : null);
    for (const { normalized: x } of rows) managerOf.set(x.employee_number, x.manager_employee_number || null);
    for (const item of rows) {
      if (item.errors.length) continue;
      const visited = new Set<string>([item.normalized.employee_number]);
      let cursor = managerOf.get(item.normalized.employee_number) || null;
      while (cursor) {
        if (visited.has(cursor)) { item.errors.push("Reporting line forms a loop"); item.outcome = "INVALID"; break; }
        visited.add(cursor); cursor = managerOf.get(cursor) || null;
      }
    }
    return rows;
  }

  private async present(client: PoolClient, identity: AuthIdentity, id: string) {
    return (await client.query(
      `SELECT e.id,e.employee_number AS "employeeNumber",e.full_name AS "fullName",e.work_email AS "workEmail",e.department,e.designation,e.location,
              e.manager_id AS "managerId",m.full_name AS manager,to_char(e.joining_date,'YYYY-MM-DD') AS "joiningDate",e.status,e.version,e.updated_at AS "updatedAt"
         FROM employees e LEFT JOIN employees m ON m.id=e.manager_id AND m.organization_id=e.organization_id
        WHERE e.organization_id=$1 AND e.id=$2`, [identity.organizationId, id])).rows[0];
  }

  private audit(client: PoolClient, identity: AuthIdentity, action: string, entityType: string, id: string, before: unknown, after: unknown) {
    return client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [identity.organizationId, identity.userId, action, entityType, id, before === null ? null : JSON.stringify(before), JSON.stringify(after)]);
  }
}

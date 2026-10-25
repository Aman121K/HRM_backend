import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { JobRegistry } from "../jobs/job-registry";
import type { AssignRoleDto, AuditQuery, BaseRoleDto, CreateRoleDto, PeopleQuery, RoleStatusDto, UpdateRoleDto } from "./access.dto";
import { computeEffective, covers, normaliseGrants, type CustomAssignmentRow, type Effective } from "./effective";
import {
  BASE_ROLES, PERMISSION_GROUPS, PERMISSION_INDEX, SCOPE_LABELS, SCOPES, SOD_RULES, SYSTEM_ROLES, needsConfirmation, scopeRank, sodWarnings, systemRole,
  type Grant,
} from "./permissions";
import { ROUTE_PERMISSION_EQUIVALENTS } from "./route-permissions";

const ELEVATED_BASE = ["OWNER", "HR_ADMIN", "PAYROLL_ADMIN"];
const ADMIN_BASE = ["OWNER", "HR_ADMIN"];
/** Any of these makes the /settings hub relevant to a person. */
export const HUB_PERMISSIONS = ["settings.access", "settings.organization", "audit.view", "integrations.manage", "jobs.manage", "attendance.sites.manage", "payroll.settings.edit"];

type Person = {
  id: string; name: string; number: string; email: string | null; designation: string | null; department: string | null; location: string | null;
  managerId: string | null; userId: string | null; baseRole: string | null;
};
type LiveAssignment = CustomAssignmentRow & { employee_id: string; starts_at: string; granted_by_name: string | null; reason: string | null; created_at: string };
type RoleRow = {
  id: string; name: string; description: string; permissions: unknown; based_on: string | null; status: string; version: number;
  created_at: string; updated_at: string; created_by_name?: string | null; updated_by_name?: string | null;
};

type Diff = { added: Grant[]; removed: Grant[]; changed: { key: string; from: string; to: string }[] };
export function diffGrants(before: Grant[], after: Grant[]): Diff {
  const b = new Map(before.map((grant) => [grant.key, grant.scope]));
  const a = new Map(after.map((grant) => [grant.key, grant.scope]));
  return {
    added: after.filter((grant) => !b.has(grant.key)),
    removed: before.filter((grant) => !a.has(grant.key)),
    changed: after.filter((grant) => b.has(grant.key) && b.get(grant.key) !== grant.scope).map((grant) => ({ key: grant.key, from: b.get(grant.key)!, to: grant.scope })),
  };
}

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  // Neutralise spreadsheet formula injection and quote every cell.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};
const csv = (rows: unknown[][]) => rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";

@Injectable()
export class AccessService implements OnModuleInit {
  private readonly logger = new Logger(AccessService.name);
  constructor(private readonly database: DatabaseService, private readonly registry: JobRegistry) {}

  onModuleInit() {
    // Lapsed temporary grants are revoked (and people told) every 15 minutes; enforcement never waits for this —
    // AuthService ignores expired assignments immediately.
    this.registry.register("access.expire-assignments", () => this.sweepExpired(), { every: 15 * 60_000 });
  }

  // ───────────────────────────── viewer / catalogue ─────────────────────────────

  me(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const effective = await this.effectiveFor(client, identity.organizationId, identity.employeeId, identity.roles);
      const held = new Set(effective.permissions);
      return {
        employeeId: identity.employeeId, roles: identity.roles.filter(Boolean),
        permissions: effective.permissions, scopes: effective.scopes,
        customRoles: [...new Map(effective.grants.flatMap((grant) => grant.source.type === "CUSTOM" ? [[grant.source.assignmentId, grant.source] as const] : [])).values()],
        can: {
          manageAccess: held.has("settings.access"), viewAudit: held.has("audit.view"),
          reviewAccess: held.has("settings.access") || held.has("audit.view"),
          settingsHub: HUB_PERMISSIONS.some((key) => held.has(key)),
        },
      };
    });
  }

  catalogue() {
    const enforcedRoutes = Object.entries(ROUTE_PERMISSION_EQUIVALENTS).reduce<Record<string, number>>((acc, [, key]) => ({ ...acc, [key]: (acc[key] || 0) + 1 }), {});
    return {
      groups: PERMISSION_GROUPS.map((group) => ({ ...group, permissions: group.permissions.map((permission) => ({ ...permission, confirm: needsConfirmation(permission.key), routes: enforcedRoutes[permission.key] || 0 })) })),
      scopes: SCOPES.map((key) => ({ key, label: SCOPE_LABELS[key] })),
      baseRoles: BASE_ROLES,
      sodRules: SOD_RULES,
    };
  }

  // ───────────────────────────── roles ─────────────────────────────

  listRoles(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const baseCounts = new Map((await client.query(
        `SELECT role, count(*)::int n FROM organization_memberships WHERE organization_id=$1 AND status='ACTIVE' GROUP BY role`, [org])).rows.map((row) => [row.role, row.n]));
      const roles = (await client.query<RoleRow & { holders: number; temporary: number }>(
        `SELECT r.*, (SELECT count(*)::int FROM access_role_assignments a WHERE a.organization_id=r.organization_id AND a.role_id=r.id AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > now())) holders,
                (SELECT count(*)::int FROM access_role_assignments a WHERE a.organization_id=r.organization_id AND a.role_id=r.id AND a.revoked_at IS NULL AND a.expires_at > now()) temporary,
                u.full_name updated_by_name
           FROM access_roles r LEFT JOIN employees u ON u.organization_id=r.organization_id AND u.user_id=r.updated_by
          WHERE r.organization_id=$1 ORDER BY r.status, lower(r.name)`, [org])).rows;
      return {
        system: SYSTEM_ROLES.map((role) => ({ ...role, type: "SYSTEM", holders: baseCounts.get(role.baseRole) || 0, ...this.riskSummary(role.grants) })),
        custom: roles.map((row) => this.presentRole(row)),
      };
    });
  }

  getRole(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = await this.loadRole(client, identity.organizationId, id);
      const assignments = (await client.query(
        `SELECT a.id, a.expires_at "expiresAt", a.starts_at "startsAt", a.restrict_department department, a.restrict_location location, a.reason, a.created_at "createdAt",
                e.id "employeeId", e.full_name name, e.employee_number number, e.designation, e.department "employeeDepartment", g.full_name "grantedBy"
           FROM access_role_assignments a JOIN employees e ON e.id=a.employee_id AND e.organization_id=a.organization_id
           LEFT JOIN employees g ON g.organization_id=a.organization_id AND g.user_id=a.granted_by
          WHERE a.organization_id=$1 AND a.role_id=$2 AND a.revoked_at IS NULL ORDER BY e.full_name`, [identity.organizationId, id])).rows
        .map((item) => ({ ...item, expired: !!item.expiresAt && new Date(item.expiresAt) <= new Date() }));
      const history = (await client.query(
        `SELECT l.id, l.action, l.before_data, l.after_data, l.created_at, e.full_name actor
           FROM audit_log l LEFT JOIN employees e ON e.organization_id=l.organization_id AND e.user_id=l.actor_user_id
          WHERE l.organization_id=$1 AND l.entity_type='access_role' AND l.entity_id=$2 ORDER BY l.created_at DESC, l.id DESC LIMIT 50`, [identity.organizationId, id])).rows
        .map((entry) => {
          const before = normaliseGrants(entry.before_data?.permissions), after = normaliseGrants(entry.after_data?.permissions);
          return {
            id: String(entry.id), action: entry.action, actor: entry.actor, at: entry.created_at, reason: entry.after_data?.reason || null,
            version: entry.after_data?.version ?? null, diff: diffGrants(before, after),
            renamed: entry.before_data?.name && entry.after_data?.name && entry.before_data.name !== entry.after_data.name ? { from: entry.before_data.name, to: entry.after_data.name } : null,
            descriptionChanged: !!entry.before_data && entry.before_data.description !== entry.after_data?.description,
            status: entry.after_data?.status || null,
          };
        });
      return { ...this.presentRole(row), assignments, history };
    });
  }

  createRole(identity: AuthIdentity, input: CreateRoleDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const actor = await this.actorAccess(client, identity);
      const grants = this.cleanGrants(input.permissions);
      if (!grants.length) throw new BadRequestException("Choose at least one permission for this role.");
      this.assertCanGrant(actor, grants);
      this.assertConfirmed(input, grants.filter((grant) => needsConfirmation(grant.key)));
      const name = input.name.trim();
      const created = (await client.query<RoleRow>(
        `INSERT INTO access_roles(organization_id,name,description,permissions,based_on,created_by,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (organization_id, lower(name)) DO NOTHING RETURNING *`,
        [identity.organizationId, name, (input.description || "").trim(), JSON.stringify(grants), input.basedOn || null, identity.userId])).rows[0];
      if (!created) throw new ConflictException(`A role called “${name}” already exists.`);
      await this.audit(client, identity, "ACCESS_ROLE_CREATED", "access_role", created.id, null, { ...this.snapshot(created), reason: input.reason?.trim() || null });
      await this.bump(client, identity.organizationId);
      return this.presentRole({ ...created, holders: 0, temporary: 0 } as RoleRow);
    });
  }

  updateRole(identity: AuthIdentity, id: string, input: UpdateRoleDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const actor = await this.actorAccess(client, identity);
      const before = await this.loadRole(client, identity.organizationId, id, true);
      if (before.version !== input.version) throw new ConflictException("Someone else changed this role while you were editing. Reload to see their changes.");
      if (before.status !== "ACTIVE") throw new ConflictException("Restore this role before editing it.");
      const beforeGrants = normaliseGrants(before.permissions);
      const grants = input.permissions ? this.cleanGrants(input.permissions) : beforeGrants;
      if (!grants.length) throw new BadRequestException("A role needs at least one permission. Archive it instead.");
      const diff = diffGrants(beforeGrants, grants);
      const widened = [...diff.added, ...diff.changed.filter((change) => scopeRank(change.to as never) > scopeRank(change.from as never)).map((change) => ({ key: change.key, scope: change.to }) as Grant)];
      this.assertCanGrant(actor, widened);
      this.assertConfirmed(input, diff.added.filter((grant) => needsConfirmation(grant.key)));
      if (diff.removed.some((grant) => grant.key === "settings.access")) await this.assertAccessAdminsRemain(client, identity.organizationId, { roleId: id });
      const name = input.name?.trim() || before.name;
      const updated = (await client.query<RoleRow>(
        `UPDATE access_roles SET name=$3, description=$4, permissions=$5, version=version+1, updated_by=$6, updated_at=now()
          WHERE organization_id=$1 AND id=$2 AND version=$7 RETURNING *`,
        [identity.organizationId, id, name, input.description !== undefined ? input.description.trim() : before.description, JSON.stringify(grants), identity.userId, input.version]))
        .rows[0];
      if (!updated) throw new ConflictException("Someone else changed this role while you were editing. Reload to see their changes.");
      await this.audit(client, identity, "ACCESS_ROLE_UPDATED", "access_role", id, this.snapshot(before), { ...this.snapshot(updated), reason: input.reason?.trim() || null });
      if (diff.added.length || diff.removed.length || diff.changed.length) {
        const holders = (await client.query(`SELECT employee_id FROM access_role_assignments WHERE organization_id=$1 AND role_id=$2 AND revoked_at IS NULL`, [identity.organizationId, id])).rows;
        for (const holder of holders)
          await this.notify(client, identity.organizationId, holder.employee_id, "ACCESS_ROLE_CHANGED", "access_role", id, { message: `The “${name}” role you hold was updated: ${this.describeDiff(diff)}.`, link: "/settings/access" });
      }
      await this.bump(client, identity.organizationId);
      return this.presentRole(updated);
    });
  }

  setRoleStatus(identity: AuthIdentity, id: string, input: RoleStatusDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const actor = await this.actorAccess(client, identity);
      const before = await this.loadRole(client, identity.organizationId, id, true);
      if (before.version !== input.version) throw new ConflictException("This role changed since you opened it. Reload and try again.");
      if (before.status === input.status) return this.presentRole(before);
      const grants = normaliseGrants(before.permissions);
      if (input.status === "ARCHIVED") {
        if (!input.reason?.trim() || input.reason.trim().length < 3) throw new BadRequestException("Say why this role is being archived.");
        if (grants.some((grant) => grant.key === "settings.access")) await this.assertAccessAdminsRemain(client, identity.organizationId, { roleId: id });
        this.assertCanGrant(actor, grants, "archive");
      } else {
        this.assertCanGrant(actor, grants);
        this.assertConfirmed(input, grants.filter((grant) => needsConfirmation(grant.key)));
      }
      const updated = (await client.query<RoleRow>(
        `UPDATE access_roles SET status=$3, version=version+1, updated_by=$4, updated_at=now() WHERE organization_id=$1 AND id=$2 AND version=$5 RETURNING *`,
        [identity.organizationId, id, input.status, identity.userId, input.version])).rows[0];
      if (!updated) throw new ConflictException("This role changed since you opened it. Reload and try again.");
      await this.audit(client, identity, input.status === "ARCHIVED" ? "ACCESS_ROLE_ARCHIVED" : "ACCESS_ROLE_RESTORED", "access_role", id, this.snapshot(before), { ...this.snapshot(updated), reason: input.reason?.trim() || null });
      await this.bump(client, identity.organizationId);
      return this.presentRole(updated);
    });
  }

  // ───────────────────────────── people & assignments ─────────────────────────────

  people(identity: AuthIdentity, query: PeopleQuery) {
    return this.database.tenantTransaction(identity, async (client) => {
      const people = await this.loadPeople(client, identity.organizationId, query.search);
      const live = await this.liveAssignments(client, identity.organizationId);
      const byEmployee = this.groupBy(live, (row) => row.employee_id);
      let items = people.map((person) => {
        const assignments = byEmployee.get(person.id) || [];
        return {
          ...person, hasLogin: !!person.userId, isSelf: person.id === identity.employeeId,
          customRoles: assignments.map((row) => ({ assignmentId: row.assignment_id, roleId: row.role_id, name: row.role_name, expiresAt: row.expires_at, department: row.restrict_department, location: row.restrict_location })),
          elevated: ELEVATED_BASE.includes(person.baseRole || "") || assignments.some((row) => normaliseGrants(row.permissions).some((grant) => ["HIGH", "CRITICAL"].includes(PERMISSION_INDEX.get(grant.key)?.risk || ""))),
        };
      });
      if (query.roleId) items = items.filter((item) => item.customRoles.some((role) => role.roleId === query.roleId));
      if (query.baseRole) items = items.filter((item) => item.baseRole === query.baseRole);
      if (query.filter === "elevated") items = items.filter((item) => item.elevated);
      if (query.filter === "temporary") items = items.filter((item) => item.customRoles.some((role) => role.expiresAt));
      if (query.filter === "custom") items = items.filter((item) => item.customRoles.length);
      const facets = (await client.query(
        `SELECT array_remove(array_agg(DISTINCT department),NULL) departments, array_remove(array_agg(DISTINCT location),NULL) locations FROM employees WHERE organization_id=$1 AND status='ACTIVE'`,
        [identity.organizationId])).rows[0];
      return { items: items.slice(0, query.limit || 200), total: items.length, departments: (facets.departments || []).sort(), locations: (facets.locations || []).sort() };
    });
  }

  person(identity: AuthIdentity, employeeId: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const person = (await this.loadPeople(client, identity.organizationId, undefined, employeeId))[0];
      if (!person) throw new NotFoundException("Employee not found.");
      const effective = await this.effectiveFor(client, identity.organizationId, person.id, person.baseRole ? [person.baseRole] : []);
      const history = (await client.query(
        `SELECT a.id, r.name role, a.created_at "createdAt", a.expires_at "expiresAt", a.revoked_at "revokedAt", a.revoke_reason "revokeReason", a.reason,
                g.full_name "grantedBy", v.full_name "revokedBy"
           FROM access_role_assignments a JOIN access_roles r ON r.id=a.role_id AND r.organization_id=a.organization_id
           LEFT JOIN employees g ON g.organization_id=a.organization_id AND g.user_id=a.granted_by
           LEFT JOIN employees v ON v.organization_id=a.organization_id AND v.user_id=a.revoked_by
          WHERE a.organization_id=$1 AND a.employee_id=$2 ORDER BY a.created_at DESC LIMIT 30`, [identity.organizationId, person.id])).rows;
      const assignments = (await this.liveAssignments(client, identity.organizationId, person.id)).map((row) => ({
        assignmentId: row.assignment_id, roleId: row.role_id, name: row.role_name, expiresAt: row.expires_at, startsAt: row.starts_at,
        department: row.restrict_department, location: row.restrict_location, reason: row.reason, grantedBy: row.granted_by_name, createdAt: row.created_at,
        permissions: normaliseGrants(row.permissions),
      }));
      return {
        person: { ...person, hasLogin: !!person.userId, isSelf: person.id === identity.employeeId },
        baseRole: person.baseRole ? systemRole(person.baseRole) || null : null,
        assignments, history,
        effective: this.presentEffective(effective),
        sod: sodWarnings(effective.permissions),
      };
    });
  }

  assign(identity: AuthIdentity, input: AssignRoleDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      if (input.employeeId === identity.employeeId) throw new ForbiddenException("You can't change your own access. Ask another administrator.");
      const actor = await this.actorAccess(client, identity);
      const person = (await this.loadPeople(client, org, undefined, input.employeeId))[0];
      if (!person) throw new NotFoundException("Employee not found or no longer active.");
      const role = await this.loadRole(client, org, input.roleId, true);
      if (role.status !== "ACTIVE") throw new ConflictException("This role is archived. Restore it before assigning it.");
      const grants = normaliseGrants(role.permissions);
      this.assertCanGrant(actor, grants);
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      if (expiresAt && expiresAt.getTime() <= Date.now() + 5 * 60_000) throw new BadRequestException("Temporary access must end in the future.");
      if (expiresAt && expiresAt.getTime() > Date.now() + 2 * 366 * 86_400_000) throw new BadRequestException("Temporary access can last at most two years. Leave the end date empty for ongoing access.");
      const department = input.department?.trim() || null, location = input.location?.trim() || null;
      if (department && !(await client.query(`SELECT 1 FROM employees WHERE organization_id=$1 AND department=$2 LIMIT 1`, [org, department])).rowCount)
        throw new BadRequestException(`No employees are in the “${department}” department.`);
      if (location && !(await client.query(`SELECT 1 FROM employees WHERE organization_id=$1 AND location=$2 LIMIT 1`, [org, location])).rowCount)
        throw new BadRequestException(`No employees are at “${location}”.`);
      const existing = await this.liveAssignments(client, org, person.id);
      if (existing.some((row) => row.role_id === role.id)) throw new ConflictException(`${person.name} already has the “${role.name}” role.`);
      const before = computeEffective(person.baseRole ? [person.baseRole] : [], existing);
      const after = computeEffective(person.baseRole ? [person.baseRole] : [], [...existing, { assignment_id: "new", role_id: role.id, role_name: role.name, permissions: grants, expires_at: expiresAt, restrict_department: department, restrict_location: location }]);
      const gained = grants.filter((grant) => !covers(before, grant));
      const critical = grants.filter((grant) => needsConfirmation(grant.key));
      const newSod = sodWarnings(after.permissions).filter((rule) => !sodWarnings(before.permissions).some((existingRule) => existingRule.id === rule.id));
      const impact = {
        gained, critical, confirmationRequired: critical.length > 0,
        sod: sodWarnings(after.permissions), newSod, hasLogin: !!person.userId,
      };
      if (input.dryRun) return { dryRun: true, ...impact };
      this.assertConfirmed(input, critical);
      // A lapsed grant of the same role would block the unique index; close it first.
      await client.query(`UPDATE access_role_assignments SET revoked_at=now(), revoke_reason='Expired' WHERE organization_id=$1 AND employee_id=$2 AND role_id=$3 AND revoked_at IS NULL AND expires_at <= now()`, [org, person.id, role.id]);
      const created = (await client.query(
        `INSERT INTO access_role_assignments(organization_id,role_id,employee_id,expires_at,restrict_department,restrict_location,reason,granted_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (organization_id, employee_id, role_id) WHERE revoked_at IS NULL DO NOTHING RETURNING *`,
        [org, role.id, person.id, expiresAt, department, location, input.reason?.trim() || null, identity.userId])).rows[0];
      if (!created) throw new ConflictException(`${person.name} already has the “${role.name}” role.`);
      await this.audit(client, identity, "ACCESS_ROLE_ASSIGNED", "access_assignment", created.id, null, {
        roleId: role.id, role: role.name, employeeId: person.id, employee: person.name, expiresAt: expiresAt?.toISOString() || null,
        department, location, reason: input.reason?.trim() || null, permissions: grants, sodWarnings: impact.sod.map((rule) => rule.id),
      });
      const until = expiresAt ? ` until ${expiresAt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}` : "";
      await this.notify(client, org, person.id, "ACCESS_ROLE_ASSIGNED", "access_assignment", created.id, { message: `You were given the “${role.name}” role${until}.`, role: role.name, expiresAt: expiresAt?.toISOString() || null });
      await this.bump(client, org);
      return { id: created.id, ...impact };
    });
  }

  revoke(identity: AuthIdentity, assignmentId: string, reason: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const row = (await client.query(
        `SELECT a.*, r.name role_name, r.permissions, e.full_name employee_name FROM access_role_assignments a
           JOIN access_roles r ON r.id=a.role_id AND r.organization_id=a.organization_id JOIN employees e ON e.id=a.employee_id AND e.organization_id=a.organization_id
          WHERE a.organization_id=$1 AND a.id=$2 FOR UPDATE OF a`, [org, assignmentId])).rows[0];
      if (!row || row.revoked_at) throw new NotFoundException("This assignment was not found or was already removed.");
      if (row.employee_id === identity.employeeId) throw new ForbiddenException("You can't change your own access. Ask another administrator.");
      const actor = await this.actorAccess(client, identity);
      const grants = normaliseGrants(row.permissions);
      this.assertCanGrant(actor, grants, "revoke");
      if (grants.some((grant) => grant.key === "settings.access")) await this.assertAccessAdminsRemain(client, org, { assignmentId });
      await client.query(`UPDATE access_role_assignments SET revoked_at=now(), revoked_by=$3, revoke_reason=$4 WHERE organization_id=$1 AND id=$2`, [org, assignmentId, identity.userId, reason.trim()]);
      await this.audit(client, identity, "ACCESS_ROLE_REVOKED", "access_assignment", assignmentId,
        { roleId: row.role_id, role: row.role_name, employeeId: row.employee_id, employee: row.employee_name, expiresAt: row.expires_at, department: row.restrict_department, location: row.restrict_location },
        { revoked: true, reason: reason.trim() });
      await this.notify(client, org, row.employee_id, "ACCESS_ROLE_REVOKED", "access_assignment", assignmentId, { message: `Your “${row.role_name}” role was removed.`, role: row.role_name });
      await this.bump(client, org);
      return { revoked: true };
    });
  }

  changeBaseRole(identity: AuthIdentity, employeeId: string, input: BaseRoleDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      if (employeeId === identity.employeeId) throw new ForbiddenException("You can't change your own access. Ask another administrator.");
      const actor = await this.actorAccess(client, identity);
      const person = (await this.loadPeople(client, org, undefined, employeeId))[0];
      if (!person) throw new NotFoundException("Employee not found or no longer active.");
      if (!person.userId || !person.baseRole) throw new ConflictException(`${person.name} doesn't have a sign-in account yet, so there is no base role to change. Custom roles can still be assigned.`);
      if (person.baseRole !== input.expectedRole) throw new ConflictException(`${person.name}'s base role was changed to ${person.baseRole} by someone else. Reload and try again.`);
      if (input.role === person.baseRole) return { changed: false, role: person.baseRole };
      if ((input.role === "OWNER" || person.baseRole === "OWNER") && !identity.roles.includes("OWNER"))
        throw new ForbiddenException("Only an owner can make someone an owner or remove an owner.");
      const target = systemRole(input.role)!, current = systemRole(person.baseRole)!;
      this.assertCanGrant(actor, target.grants);
      this.assertCanGrant(actor, current.grants, "revoke");
      this.assertConfirmed(input, target.grants.filter((grant) => needsConfirmation(grant.key) && !current.grants.some((held) => held.key === grant.key)));
      if (!input.reason?.trim() || input.reason.trim().length < 3) throw new BadRequestException("Say why this person's base role is changing.");
      if (ADMIN_BASE.includes(person.baseRole) && !ADMIN_BASE.includes(input.role)) await this.assertAccessAdminsRemain(client, org, { baseUserId: person.userId });
      const updated = await client.query(
        `UPDATE organization_memberships SET role=$4 WHERE organization_id=$1 AND user_id=$2 AND role=$3 AND status='ACTIVE' RETURNING role`,
        [org, person.userId, person.baseRole, input.role]);
      if (!updated.rowCount) throw new ConflictException("This person's base role changed while you were editing. Reload and try again.");
      await this.audit(client, identity, "MEMBERSHIP_ROLE_CHANGED", "employee", person.id, { role: person.baseRole, employee: person.name }, { role: input.role, employee: person.name, reason: input.reason.trim() });
      await this.notify(client, org, person.id, "ACCESS_BASE_ROLE_CHANGED", "employee", person.id, { message: `Your base role changed from ${current.name} to ${target.name}.` });
      await this.bump(client, org);
      return { changed: true, role: input.role };
    });
  }

  // ───────────────────────────── access review ─────────────────────────────

  whoCan(identity: AuthIdentity, key: string) {
    if (!PERMISSION_INDEX.has(key)) throw new NotFoundException("Unknown permission.");
    return this.database.tenantTransaction(identity, async (client) => {
      const rows = await this.everyone(client, identity.organizationId);
      const items = rows.flatMap(({ person, effective }) => {
        const scope = effective.scopes[key];
        if (!scope) return [];
        return [{ person: { id: person.id, name: person.name, number: person.number, designation: person.designation, department: person.department, location: person.location, baseRole: person.baseRole, hasLogin: !!person.userId }, scope, sources: effective.grants.filter((grant) => grant.key === key) }];
      });
      return { permission: { ...PERMISSION_INDEX.get(key)!, group: PERMISSION_GROUPS.find((group) => group.permissions.some((permission) => permission.key === key))?.label }, items };
    });
  }

  exportCsv(identity: AuthIdentity, key?: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const rows = await this.everyone(client, identity.organizationId);
      const header = ["Employee number", "Name", "Department", "Location", "Base role", "Permission", "Permission name", "Risk", "Scope", "Restricted to", "Source", "Expires"];
      const lines: unknown[][] = [header];
      for (const { person, effective } of rows)
        for (const grant of effective.grants) {
          if (key && grant.key !== key) continue;
          const definition = PERMISSION_INDEX.get(grant.key)!;
          const source = grant.source;
          lines.push([
            person.number, person.name, person.department, person.location, person.baseRole || "No login", grant.key, definition.label, definition.risk,
            definition.scopable ? SCOPE_LABELS[grant.scope] : "—",
            source.type === "CUSTOM" ? [source.department, source.location].filter(Boolean).join(" / ") : "",
            source.type === "BASE" ? `Base role: ${source.roleName}` : `Custom role: ${source.roleName}`,
            source.type === "CUSTOM" && source.expiresAt ? source.expiresAt.slice(0, 10) : "",
          ]);
        }
      await this.audit(client, identity, "ACCESS_REVIEW_EXPORTED", "organization", identity.organizationId, null, { permission: key || null, rows: lines.length - 1 });
      return csv(lines);
    });
  }

  // ───────────────────────────── audit log ─────────────────────────────

  auditLog(identity: AuthIdentity, query: AuditQuery) {
    return this.database.tenantTransaction(identity, async (client) => {
      const { where, values } = this.auditWhere(identity, query);
      const pageSize = query.pageSize || 25, page = query.page || 1;
      const total = (await client.query(`SELECT count(*)::int n FROM audit_log a WHERE ${where}`, values)).rows[0].n;
      const items = (await client.query(
        `SELECT a.id::text, a.action, a.entity_type "entityType", a.entity_id "entityId", a.created_at "createdAt", a.actor_user_id "actorUserId",
                e.full_name "actorName", e.employee_number "actorNumber", e.designation "actorDesignation",
                a.before_data IS NOT NULL "hasBefore", a.after_data IS NOT NULL "hasAfter",
                left(coalesce(a.after_data->>'reason', a.after_data->>'note', a.after_data->>'message', a.after_data->>'role', a.after_data->>'name', ''), 160) summary
           FROM audit_log a LEFT JOIN employees e ON e.organization_id=a.organization_id AND e.user_id=a.actor_user_id
          WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, values)).rows;
      return { items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
    });
  }

  auditEntry(identity: AuthIdentity, id: string) {
    if (!/^\d{1,18}$/.test(id)) throw new NotFoundException("Audit entry not found.");
    return this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(
        `SELECT a.id::text, a.action, a.entity_type "entityType", a.entity_id "entityId", a.created_at "createdAt", a.before_data "before", a.after_data "after",
                e.full_name "actorName", e.employee_number "actorNumber", e.designation "actorDesignation"
           FROM audit_log a LEFT JOIN employees e ON e.organization_id=a.organization_id AND e.user_id=a.actor_user_id
          WHERE a.organization_id=$1 AND a.id=$2`, [identity.organizationId, id])).rows[0];
      if (!row) throw new NotFoundException("Audit entry not found.");
      return row;
    });
  }

  auditFacets(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const [actions, entities, actors, recent] = await Promise.all([
        client.query(`SELECT action, count(*)::int n FROM audit_log WHERE organization_id=$1 GROUP BY action ORDER BY action LIMIT 400`, [org]),
        client.query(`SELECT entity_type, count(*)::int n FROM audit_log WHERE organization_id=$1 GROUP BY entity_type ORDER BY entity_type`, [org]),
        client.query(`SELECT a.actor_user_id id, max(e.full_name) name, max(e.employee_number) number, count(*)::int n FROM audit_log a
                        LEFT JOIN employees e ON e.organization_id=a.organization_id AND e.user_id=a.actor_user_id WHERE a.organization_id=$1 GROUP BY a.actor_user_id ORDER BY 2 NULLS LAST`, [org]),
        client.query(`SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int "day", count(*) FILTER (WHERE created_at > now() - interval '7 days')::int week, count(*)::int total FROM audit_log WHERE organization_id=$1`, [org]),
      ]);
      return {
        actions: actions.rows.map((row) => ({ key: row.action, count: row.n })),
        entityTypes: entities.rows.map((row) => ({ key: row.entity_type, count: row.n })),
        actors: actors.rows.map((row) => ({ id: row.id, name: row.name || "System", number: row.number, count: row.n })),
        counts: recent.rows[0],
      };
    });
  }

  auditCsv(identity: AuthIdentity, query: AuditQuery) {
    return this.database.tenantTransaction(identity, async (client) => {
      const { where, values } = this.auditWhere(identity, query);
      const rows = (await client.query(
        `SELECT a.id, a.created_at, a.action, a.entity_type, a.entity_id, e.full_name actor, e.employee_number, a.before_data, a.after_data
           FROM audit_log a LEFT JOIN employees e ON e.organization_id=a.organization_id AND e.user_id=a.actor_user_id
          WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT 5000`, values)).rows;
      await this.audit(client, identity, "AUDIT_LOG_EXPORTED", "organization", identity.organizationId, null, { filters: query, rows: rows.length });
      return csv([["Id", "When (UTC)", "Action", "Entity type", "Entity id", "Actor", "Actor number", "Before", "After"],
        ...rows.map((row) => [row.id, new Date(row.created_at).toISOString(), row.action, row.entity_type, row.entity_id, row.actor || "System", row.employee_number,
          row.before_data ? JSON.stringify(row.before_data) : "", row.after_data ? JSON.stringify(row.after_data) : ""])]);
    });
  }

  // ───────────────────────────── organization profile (settings hub) ─────────────────────────────

  organization(identity: AuthIdentity) {
    const held = new Set(identity.permissions || []);
    if (!HUB_PERMISSIONS.some((key) => held.has(key))) throw new ForbiddenException("Organization settings are available to administrators.");
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const profile = (await client.query(`SELECT id, name, slug, created_at "createdAt" FROM organizations WHERE id=$1`, [org])).rows[0];
      const [people, departments, locations, base, roles, grants, audit, sites] = await Promise.all([
        client.query(`SELECT count(*) FILTER (WHERE status='ACTIVE')::int active, count(*)::int total, count(*) FILTER (WHERE status='ACTIVE' AND user_id IS NOT NULL)::int "withLogin" FROM employees WHERE organization_id=$1`, [org]),
        client.query(`SELECT department name, count(*)::int n FROM employees WHERE organization_id=$1 AND status='ACTIVE' AND department IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1`, [org]),
        client.query(`SELECT location name, count(*)::int n FROM employees WHERE organization_id=$1 AND status='ACTIVE' AND location IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1`, [org]),
        client.query(`SELECT role, count(*)::int n FROM organization_memberships WHERE organization_id=$1 AND status='ACTIVE' GROUP BY role`, [org]),
        client.query(`SELECT count(*) FILTER (WHERE status='ACTIVE')::int active FROM access_roles WHERE organization_id=$1`, [org]),
        client.query(`SELECT count(*)::int live, count(*) FILTER (WHERE expires_at IS NOT NULL)::int temporary, count(*) FILTER (WHERE expires_at < now() + interval '7 days')::int "expiringSoon"
                        FROM access_role_assignments a WHERE a.organization_id=$1 AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > now())
                          AND EXISTS (SELECT 1 FROM access_roles r WHERE r.id=a.role_id AND r.status='ACTIVE')`, [org]),
        client.query(`SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int "day" FROM audit_log WHERE organization_id=$1`, [org]),
        client.query(`SELECT count(*) FILTER (WHERE active)::int active, count(*)::int total FROM attendance_sites WHERE organization_id=$1`, [org]),
      ]);
      return {
        profile, people: people.rows[0], departments: departments.rows, locations: locations.rows,
        baseRoles: Object.fromEntries(base.rows.map((row) => [row.role, row.n])),
        customRoles: roles.rows[0].active, grants: grants.rows[0], auditLast24h: audit.rows[0].day, sites: sites.rows[0],
      };
    });
  }

  // ───────────────────────────── background job ─────────────────────────────

  async sweepExpired() {
    const orgs = (await this.database.systemQuery(
      `SELECT DISTINCT organization_id FROM access_role_assignments WHERE revoked_at IS NULL AND expires_at IS NOT NULL
         AND (expires_at <= now() OR (expires_at < now() + interval '3 days' AND expiry_notified_at IS NULL))`)).rows;
    let expired = 0, warned = 0;
    for (const { organization_id: organizationId } of orgs) {
      await this.database.tenantTransaction({ organizationId, userId: "", employeeId: "", roles: [] }, async (client) => {
        const lapsed = (await client.query(
          `UPDATE access_role_assignments a SET revoked_at=now(), revoke_reason='Expired'
             FROM access_roles r WHERE r.id=a.role_id AND a.organization_id=$1 AND a.revoked_at IS NULL AND a.expires_at <= now()
           RETURNING a.id, a.employee_id, a.granted_by, a.expires_at, r.name role_name, r.id role_id`, [organizationId])).rows;
        for (const row of lapsed) {
          await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,'ACCESS_ROLE_EXPIRED','access_assignment',$3,$4,$5)`,
            [organizationId, row.granted_by, row.id, JSON.stringify({ roleId: row.role_id, role: row.role_name, employeeId: row.employee_id, expiresAt: row.expires_at }), JSON.stringify({ revoked: true, reason: "Temporary access ended", system: true })]);
          await this.notify(client, organizationId, row.employee_id, "ACCESS_ROLE_EXPIRED", "access_assignment", row.id, { message: `Your temporary “${row.role_name}” access has ended.`, role: row.role_name });
        }
        const soon = (await client.query(
          `UPDATE access_role_assignments a SET expiry_notified_at=now() FROM access_roles r
            WHERE r.id=a.role_id AND a.organization_id=$1 AND a.revoked_at IS NULL AND a.expiry_notified_at IS NULL AND a.expires_at > now() AND a.expires_at < now() + interval '3 days'
          RETURNING a.id, a.employee_id, a.expires_at, r.name role_name`, [organizationId])).rows;
        for (const row of soon)
          await this.notify(client, organizationId, row.employee_id, "ACCESS_ROLE_EXPIRING", "access_assignment", row.id, { message: `Your temporary “${row.role_name}” access ends on ${new Date(row.expires_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}.`, role: row.role_name });
        if (lapsed.length) await this.bump(client, organizationId);
        expired += lapsed.length; warned += soon.length;
      });
    }
    if (expired || warned) this.logger.log(`Access sweep: ${expired} expired, ${warned} expiry reminders`);
    return { expired, warned };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async actorAccess(client: PoolClient, identity: AuthIdentity) {
    const effective = await this.effectiveFor(client, identity.organizationId, identity.employeeId, identity.roles);
    if (!effective.permissions.includes("settings.access")) throw new ForbiddenException("Managing roles and access needs the “Manage roles & access” permission.");
    return effective;
  }

  /** No privilege escalation: you can only grant (or take away) what you hold yourself, at the same or a wider scope. */
  private assertCanGrant(actor: Effective, grants: Grant[], verb: "grant" | "revoke" | "archive" = "grant") {
    const missing = grants.filter((grant) => !covers(actor, grant));
    if (missing.length) {
      const names = missing.slice(0, 4).map((grant) => PERMISSION_INDEX.get(grant.key)?.label || grant.key).join(", ");
      throw new ForbiddenException(`You can only ${verb} access you hold yourself at the same scope. Missing: ${names}${missing.length > 4 ? ` and ${missing.length - 4} more` : ""}.`);
    }
  }

  private assertConfirmed(input: { confirm?: boolean; reason?: string }, critical: Grant[]) {
    if (!critical.length) return;
    if (input.confirm !== true || !input.reason?.trim() || input.reason.trim().length < 10)
      throw new BadRequestException({
        statusCode: 400, code: "CONFIRMATION_REQUIRED", permissions: critical.map((grant) => grant.key),
        message: `High-risk access (${critical.map((grant) => PERMISSION_INDEX.get(grant.key)?.label).join(", ")}) needs explicit confirmation and a reason of at least 10 characters.`,
      });
  }

  /** At least one person who can sign in must keep "Manage roles & access" (base OWNER/HR_ADMIN or a custom role). */
  private async assertAccessAdminsRemain(client: PoolClient, organizationId: string, exclude: { roleId?: string; assignmentId?: string; baseUserId?: string }) {
    const base = (await client.query(
      `SELECT count(*)::int n FROM organization_memberships WHERE organization_id=$1 AND status='ACTIVE' AND role = ANY($2) AND ($3::uuid IS NULL OR user_id<>$3)`,
      [organizationId, ADMIN_BASE, exclude.baseUserId || null])).rows[0].n;
    if (base > 0) return;
    const custom = (await client.query(
      `SELECT count(DISTINCT a.employee_id)::int n FROM access_role_assignments a
         JOIN access_roles r ON r.id=a.role_id AND r.organization_id=a.organization_id AND r.status='ACTIVE'
         JOIN employees e ON e.id=a.employee_id AND e.organization_id=a.organization_id AND e.user_id IS NOT NULL AND e.status='ACTIVE'
        WHERE a.organization_id=$1 AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > now())
          AND r.permissions @> '[{"key":"settings.access"}]'::jsonb AND ($2::uuid IS NULL OR r.id<>$2) AND ($3::uuid IS NULL OR a.id<>$3)`,
      [organizationId, exclude.roleId || null, exclude.assignmentId || null])).rows[0].n;
    if (custom < 1) throw new ConflictException("At least one owner or HR administrator must keep “Manage roles & access”. Give it to someone else first.");
  }

  private cleanGrants(input: Grant[]) { return normaliseGrants(input); }

  private riskSummary(grants: Grant[]) {
    const counts = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    for (const grant of grants) counts[PERMISSION_INDEX.get(grant.key)!.risk]++;
    const highest = counts.CRITICAL ? "CRITICAL" : counts.HIGH ? "HIGH" : counts.MEDIUM ? "MEDIUM" : "LOW";
    return { riskCounts: counts, highestRisk: highest, sod: sodWarnings(grants.map((grant) => grant.key)) };
  }

  private presentRole(row: RoleRow & { holders?: number; temporary?: number }) {
    const grants = normaliseGrants(row.permissions);
    return {
      id: row.id, type: "CUSTOM", name: row.name, description: row.description, grants, basedOn: row.based_on, status: row.status, version: row.version,
      createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: row.updated_by_name || null,
      holders: row.holders ?? undefined, temporary: row.temporary ?? undefined, ...this.riskSummary(grants),
    };
  }

  private presentEffective(effective: Effective) {
    return PERMISSION_GROUPS.map((group) => ({
      key: group.key, label: group.label,
      permissions: group.permissions.filter((permission) => effective.scopes[permission.key]).map((permission) => ({
        key: permission.key, label: permission.label, risk: permission.risk, scopable: permission.scopable,
        scope: effective.scopes[permission.key], sources: effective.grants.filter((grant) => grant.key === permission.key).map((grant) => ({ scope: grant.scope, ...grant.source })),
      })),
    })).filter((group) => group.permissions.length);
  }

  private snapshot(row: RoleRow) {
    return { name: row.name, description: row.description, permissions: normaliseGrants(row.permissions), status: row.status, version: row.version };
  }

  private describeDiff(diff: Diff) {
    const label = (key: string) => PERMISSION_INDEX.get(key)?.label || key;
    const parts = [
      diff.added.length ? `added ${diff.added.map((grant) => label(grant.key)).join(", ")}` : "",
      diff.removed.length ? `removed ${diff.removed.map((grant) => label(grant.key)).join(", ")}` : "",
      diff.changed.length ? `changed scope of ${diff.changed.map((change) => label(change.key)).join(", ")}` : "",
    ].filter(Boolean);
    return parts.join("; ") || "details changed";
  }

  private async loadRole(client: PoolClient, organizationId: string, id: string, lock = false) {
    const row = (await client.query<RoleRow>(
      `SELECT r.*, c.full_name created_by_name, u.full_name updated_by_name FROM access_roles r
         LEFT JOIN employees c ON c.organization_id=r.organization_id AND c.user_id=r.created_by
         LEFT JOIN employees u ON u.organization_id=r.organization_id AND u.user_id=r.updated_by
        WHERE r.organization_id=$1 AND r.id=$2 ${lock ? "FOR UPDATE OF r" : ""}`, [organizationId, id])).rows[0];
    if (!row) throw new NotFoundException("Role not found.");
    return row;
  }

  private async loadPeople(client: PoolClient, organizationId: string, search?: string, employeeId?: string): Promise<Person[]> {
    const values: unknown[] = [organizationId];
    const where = ["e.organization_id=$1", "e.status='ACTIVE'"];
    if (employeeId) { values.push(employeeId); where.push(`e.id=$${values.length}`); }
    if (search?.trim()) {
      values.push(`%${search.trim().toLowerCase()}%`);
      where.push(`(lower(e.full_name) LIKE $${values.length} OR lower(e.employee_number) LIKE $${values.length} OR lower(coalesce(e.work_email,'')) LIKE $${values.length} OR lower(coalesce(e.designation,'')) LIKE $${values.length} OR lower(coalesce(e.department,'')) LIKE $${values.length})`);
    }
    return (await client.query<Person>(
      `SELECT e.id, e.full_name name, e.employee_number number, e.work_email email, e.designation, e.department, e.location, e.manager_id "managerId",
              e.user_id "userId", m.role "baseRole"
         FROM employees e LEFT JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.user_id=e.user_id AND m.status='ACTIVE'
        WHERE ${where.join(" AND ")} ORDER BY e.full_name`, values)).rows;
  }

  private async liveAssignments(client: PoolClient, organizationId: string, employeeId?: string): Promise<LiveAssignment[]> {
    return (await client.query<LiveAssignment>(
      `SELECT a.id assignment_id, a.employee_id, r.id role_id, r.name role_name, r.permissions, a.expires_at, a.starts_at, a.restrict_department, a.restrict_location,
              a.reason, a.created_at, g.full_name granted_by_name
         FROM access_role_assignments a JOIN access_roles r ON r.id=a.role_id AND r.organization_id=a.organization_id AND r.status='ACTIVE'
         LEFT JOIN employees g ON g.organization_id=a.organization_id AND g.user_id=a.granted_by
        WHERE a.organization_id=$1 AND a.revoked_at IS NULL AND a.starts_at <= now() AND (a.expires_at IS NULL OR a.expires_at > now())
          AND ($2::uuid IS NULL OR a.employee_id=$2) ORDER BY r.name`, [organizationId, employeeId || null])).rows;
  }

  private async effectiveFor(client: PoolClient, organizationId: string, employeeId: string, baseRoles: string[]) {
    return computeEffective(baseRoles.filter(Boolean), employeeId ? await this.liveAssignments(client, organizationId, employeeId) : []);
  }

  private async everyone(client: PoolClient, organizationId: string) {
    const people = await this.loadPeople(client, organizationId);
    const byEmployee = this.groupBy(await this.liveAssignments(client, organizationId), (row) => row.employee_id);
    return people.map((person) => ({ person, effective: computeEffective(person.baseRole ? [person.baseRole] : [], byEmployee.get(person.id) || []) }));
  }

  private groupBy<T>(rows: T[], key: (row: T) => string) {
    const map = new Map<string, T[]>();
    for (const row of rows) map.set(key(row), [...(map.get(key(row)) || []), row]);
    return map;
  }

  private auditWhere(identity: AuthIdentity, query: AuditQuery) {
    const values: unknown[] = [identity.organizationId];
    const where = ["a.organization_id=$1"];
    const add = (sql: string, value: unknown) => { values.push(value); where.push(sql.replace("?", `$${values.length}`)); };
    if (query.actor) add("a.actor_user_id=?", query.actor);
    if (query.action) add("a.action=?", query.action);
    if (query.entityType) add("a.entity_type=?", query.entityType);
    if (query.entityId) add("a.entity_id=?", query.entityId);
    if (query.from) add("a.created_at >= (?::date AT TIME ZONE 'Asia/Kolkata')", query.from);
    if (query.to) add("a.created_at < ((?::date + 1) AT TIME ZONE 'Asia/Kolkata')", query.to);
    return { where: where.join(" AND "), values };
  }

  private async audit(client: PoolClient, identity: AuthIdentity, action: string, entityType: string, entityId: string, before: unknown, after: unknown) {
    await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [identity.organizationId, identity.userId, action, entityType, entityId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after)]);
  }

  private async notify(client: PoolClient, organizationId: string, employeeId: string, eventType: string, entityType: string, entityId: string, payload: Record<string, unknown>) {
    await client.query(`INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload) VALUES($1,$2,$3,$4,$5,$6)`,
      [organizationId, employeeId, eventType, entityType, entityId, JSON.stringify(payload)]);
  }

  /** Invalidates every process's effective-permission cache for this organization (read by AuthService). */
  private async bump(client: PoolClient, organizationId: string) {
    await client.query(
      `INSERT INTO access_org_state(organization_id,version) VALUES($1,2)
       ON CONFLICT (organization_id) DO UPDATE SET version=access_org_state.version+1, updated_at=now()`, [organizationId]);
  }
}

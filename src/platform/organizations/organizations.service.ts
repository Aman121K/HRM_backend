import { RESERVED_SUBDOMAINS } from "./brand-host";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { MODULE_KEYS, type AddAdminDto, type CreateGroupDto, type CreateOrganizationDto, type PlatformUpdateOrganizationDto, type UpdateBrandingDto } from "./organizations.dto";

/**
 * Logos are served only when they are raster data URLs. SVG (or anything else stored before the DTO was tightened) can
 * carry script if opened directly, so it is withheld everywhere the API returns a logo; the stored row is left as is.
 */
const SAFE_LOGO = (column: string) => `CASE WHEN ${column} ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' THEN ${column} END`;

const ORG_COLUMNS = `o.id, o.slug, coalesce(o.display_name, o.name) AS "displayName", o.legal_name AS "legalName",
  coalesce(o.short_name, o.name) AS "shortName", o.brand_color AS "brandColor", o.accent_color AS "accentColor", ${SAFE_LOGO("o.logo_data_url")} AS "logoDataUrl",
  o.industry, o.default_state AS "defaultState", o.timezone, o.currency, o.employee_prefix AS "employeePrefix", o.enabled_modules AS "enabledModules",
  o.status, o.group_id AS "groupId", o.version, o.created_at AS "createdAt"`;

/** Statutory leave types every new Indian organization starts with (editable later). */
const DEFAULT_LEAVE_TYPES: [string, string, number, number | null][] = [
  ["CL", "Casual Leave", 6, null], ["SL", "Sick Leave", 7, 2], ["EL", "Earned Leave", 18, null], ["LOP", "Loss of Pay", 365, null],
  ["MAT", "Maternity Leave", 182, null], ["PAT", "Paternity Leave", 15, null], ["BEREAVEMENT", "Bereavement Leave", 5, null],
];

@Injectable()
export class OrganizationsService {
  private enabledCache = new Map<string, { modules: string[]; status: string; slug: string; at: number }>();
  constructor(private readonly database: DatabaseService) {}

  // ---- the signed-in person's organizations ---------------------------------------------------

  async mine(identity: AuthIdentity) {
    const orgs = (await this.database.systemQuery(
      `SELECT ${ORG_COLUMNS}, m.role, e.employee_number AS "employeeNumber", e.full_name AS "fullName", e.designation
         FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id
         LEFT JOIN employees e ON e.organization_id=m.organization_id AND e.user_id=m.user_id
        WHERE m.user_id=$1 AND m.status='ACTIVE' AND (o.status='ACTIVE' OR o.id=$2)
        ORDER BY coalesce(o.display_name,o.name)`, [identity.userId, identity.organizationId])).rows;
    const groups = (await this.database.systemQuery(
      `SELECT g.id, g.name, g.slug, a.role FROM group_admins a JOIN organization_groups g ON g.id=a.group_id WHERE a.user_id=$1 ORDER BY g.name`,
      [identity.userId])).rows;
    return { currentOrganizationId: identity.organizationId, organizations: orgs, groups, isPlatformAdmin: await this.isPlatformAdmin(identity) };
  }

  async current(identity: AuthIdentity) {
    const org = (await this.database.systemQuery(`SELECT ${ORG_COLUMNS}, g.name AS "groupName" FROM organizations o LEFT JOIN organization_groups g ON g.id=o.group_id WHERE o.id=$1`,
      [identity.organizationId])).rows[0];
    if (!org) throw new NotFoundException("Organization not found.");
    return org;
  }

  async updateBranding(identity: AuthIdentity, input: UpdateBrandingDto) {
    if (!identity.roles.some((role) => ["OWNER", "HR_ADMIN"].includes(role))) throw new ForbiddenException("Only owners and HR admins can change organization settings.");
    const before = await this.current(identity);
    const sets: string[] = []; const values: unknown[] = [identity.organizationId, input.version];
    const map: Record<string, string> = { displayName: "display_name", legalName: "legal_name", shortName: "short_name", brandColor: "brand_color", accentColor: "accent_color",
      logoDataUrl: "logo_data_url", industry: "industry", defaultState: "default_state", timezone: "timezone", employeePrefix: "employee_prefix" };
    for (const [key, column] of Object.entries(map)) {
      const value = (input as unknown as Record<string, unknown>)[key];
      if (value !== undefined) { values.push(value); sets.push(`${column}=$${values.length}`); }
    }
    if (!sets.length) return before;
    const result = await this.database.systemQuery(`UPDATE organizations SET ${sets.join(",")}, version=version+1 WHERE id=$1 AND version=$2 RETURNING id`, values);
    if (!result.rowCount) throw new ConflictException("Settings changed since you opened them. Refresh and try again.");
    await this.audit(identity, identity.organizationId, "ORGANIZATION_UPDATED", before, input);
    this.enabledCache.delete(identity.organizationId);
    return this.current(identity);
  }

  // ---- module enablement (used by the guard) --------------------------------------------------

  async moduleState(organizationId: string) {
    const cached = this.enabledCache.get(organizationId);
    if (cached && Date.now() - cached.at < 30_000) return cached;
    const row = (await this.database.systemQuery(`SELECT enabled_modules AS modules, status, slug FROM organizations WHERE id=$1`, [organizationId])).rows[0];
    const state = { modules: row?.modules || [], status: row?.status || "SUSPENDED", slug: (row?.slug || "") as string, at: Date.now() };
    this.enabledCache.set(organizationId, state);
    return state;
  }

  // ---- platform administration -----------------------------------------------------------------

  async platformList(identity: AuthIdentity) {
    await this.requirePlatformAdmin(identity);
    const rows = (await this.database.systemQuery(
      `SELECT ${ORG_COLUMNS}, g.name AS "groupName",
              (SELECT count(*)::int FROM employees e WHERE e.organization_id=o.id AND e.status='ACTIVE') AS headcount,
              (SELECT count(*)::int FROM organization_memberships m WHERE m.organization_id=o.id AND m.status='ACTIVE') AS members
         FROM organizations o LEFT JOIN organization_groups g ON g.id=o.group_id ORDER BY coalesce(o.display_name,o.name)`)).rows;
    const groups = (await this.database.systemQuery(`SELECT id, name, slug FROM organization_groups ORDER BY name`)).rows;
    return { items: rows, groups, modules: MODULE_KEYS };
  }

  async createGroup(identity: AuthIdentity, input: CreateGroupDto) {
    await this.requirePlatformAdmin(identity);
    const row = (await this.database.systemQuery(`INSERT INTO organization_groups(name,slug) VALUES($1,$2) ON CONFLICT (slug) DO NOTHING RETURNING id, name, slug`, [input.name, input.slug])).rows[0];
    if (!row) throw new ConflictException("A group with this slug already exists.");
    await this.database.systemQuery(`INSERT INTO group_admins(group_id,user_id,role) VALUES($1,$2,'GROUP_OWNER') ON CONFLICT DO NOTHING`, [row.id, identity.userId]);
    return row;
  }

  /**
   * Provisions a new brand: organization, statutory defaults, the first HR admin (user + membership + employee record) and,
   * optionally, the platform admin as OWNER. Everything happens in one transaction.
   */
  async createOrganization(identity: AuthIdentity, input: CreateOrganizationDto) {
    await this.requirePlatformAdmin(identity);
    if (RESERVED_SUBDOMAINS.has(input.slug)) throw new BadRequestException(`"${input.slug}" is reserved by the platform. Choose another short link.`);
    const modules = input.enabledModules?.length ? [...new Set(["core", ...input.enabledModules])] : null;
    return this.database.platformTransaction(async (client) => {
      const columns = ["slug", "name", "display_name", "legal_name", "short_name", "brand_color", "accent_color", "logo_data_url", "industry", "default_state", "timezone", "employee_prefix", "group_id"];
      const values: unknown[] = [input.slug, input.displayName, input.displayName, input.legalName || null, input.shortName || input.displayName.slice(0, 24),
        input.brandColor || "#0b615c", input.accentColor || "#c78c2b", input.logoDataUrl || null, input.industry || null, input.defaultState || "KA",
        input.timezone || "Asia/Kolkata", input.employeePrefix, input.groupId || null];
      if (modules) { columns.push("enabled_modules"); values.push(modules); }
      const org = (await client.query(
        `INSERT INTO organizations(${columns.join(",")}) VALUES(${columns.map((_, index) => `$${index + 1}`).join(",")}) ON CONFLICT (slug) DO NOTHING RETURNING id`, values)).rows[0];
      if (!org) throw new ConflictException("That short link (slug) is already taken.");
      await client.query("SELECT set_config('app.organization_id',$1,true)", [org.id]);
      for (const [code, name, quota, doc] of DEFAULT_LEAVE_TYPES)
        await client.query(`INSERT INTO leave_types(organization_id,code,name,annual_quota,requires_document_after_days) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [org.id, code, name, quota, doc]);
      await client.query(`INSERT INTO attendance_policies(organization_id,selfie_mode) VALUES($1,'OUTSIDE_GEOFENCE') ON CONFLICT DO NOTHING`, [org.id]);
      const admin = await this.addMember(client, org.id, input.employeePrefix, 1, input.admin.fullName, input.admin.workEmail.toLowerCase(), input.admin.designation || "HR Administrator", "HR_ADMIN");
      if (input.addMeAsOwner !== false) {
        const me = (await client.query(`SELECT u.email, u.full_name FROM users u WHERE u.id=$1`, [identity.userId])).rows[0];
        if (me && me.email.toLowerCase() !== input.admin.workEmail.toLowerCase()) await this.addMember(client, org.id, input.employeePrefix, 0, me.full_name, me.email, "Group Owner", "OWNER", identity.userId);
      }
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'ORGANIZATION_PROVISIONED','organization',$1,$3)`,
        [org.id, identity.userId, JSON.stringify({ ...input, logoDataUrl: input.logoDataUrl ? "(logo)" : null })]);
      return { id: org.id as string, slug: input.slug, admin };
    });
  }

  async platformUpdate(identity: AuthIdentity, id: string, input: PlatformUpdateOrganizationDto) {
    await this.requirePlatformAdmin(identity);
    const sets: string[] = []; const values: unknown[] = [id, input.version];
    const branding: Record<string, string> = { displayName: "display_name", legalName: "legal_name", shortName: "short_name", brandColor: "brand_color", accentColor: "accent_color",
      logoDataUrl: "logo_data_url", industry: "industry", defaultState: "default_state", timezone: "timezone", employeePrefix: "employee_prefix" };
    for (const [key, column] of Object.entries(branding)) {
      const value = (input as unknown as Record<string, unknown>)[key];
      if (value !== undefined) { values.push(value); sets.push(`${column}=$${values.length}`); }
    }
    if (input.status) { values.push(input.status); sets.push(`status=$${values.length}`); }
    if (input.enabledModules) { values.push([...new Set(["core", ...input.enabledModules])]); sets.push(`enabled_modules=$${values.length}`); }
    if (input.groupId) { values.push(input.groupId); sets.push(`group_id=$${values.length}`); }
    if (!sets.length) throw new BadRequestException("Nothing to change.");
    if (input.status === "SUSPENDED" && id === identity.organizationId) throw new BadRequestException("Switch to another organization before suspending this one.");
    const result = await this.database.systemQuery(`UPDATE organizations SET ${sets.join(",")}, version=version+1 WHERE id=$1 AND version=$2 RETURNING id, version`, values);
    if (!result.rowCount) throw new ConflictException("This organization changed since you opened it. Refresh and try again.");
    await this.audit(identity, id, "ORGANIZATION_PLATFORM_UPDATED", null, input);
    this.enabledCache.delete(id);
    return result.rows[0];
  }

  /** People who administer a brand (owners, HR and payroll admins). */
  async brandAdmins(identity: AuthIdentity, organizationId: string) {
    await this.requirePlatformAdmin(identity);
    const rows = (await this.database.systemQuery(
      `SELECT u.id AS "userId", u.email, coalesce(e.full_name, u.full_name) AS "fullName", e.employee_number AS "employeeNumber", e.designation, m.role,
              u.last_sign_in_at AS "lastSignInAt", (u.oidc_subject IS NOT NULL) AS "ssoLinked"
         FROM organization_memberships m JOIN users u ON u.id=m.user_id
         LEFT JOIN employees e ON e.organization_id=m.organization_id AND e.user_id=m.user_id
        WHERE m.organization_id=$1 AND m.status='ACTIVE' AND m.role IN ('OWNER','HR_ADMIN','PAYROLL_ADMIN') ORDER BY m.role, coalesce(e.full_name, u.full_name)`,
      [organizationId])).rows;
    return { items: rows };
  }

  async addBrandAdmin(identity: AuthIdentity, organizationId: string, input: AddAdminDto) {
    await this.requirePlatformAdmin(identity);
    return this.database.platformTransaction(async (client) => {
      const org = (await client.query(`SELECT id, employee_prefix FROM organizations WHERE id=$1`, [organizationId])).rows[0];
      if (!org) throw new NotFoundException("Brand not found.");
      await client.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
      const next = (await client.query(
        `SELECT coalesce(max(substring(employee_number FROM '[0-9]+$')::int), 0) + 1 AS n FROM employees WHERE organization_id=$1 AND employee_number ~ ('^' || $2 || '[0-9]+$')`,
        [organizationId, org.employee_prefix])).rows[0].n;
      const admin = await this.addMember(client, organizationId, org.employee_prefix, next, input.fullName, input.workEmail.toLowerCase(), input.designation || "HR Administrator", input.role);
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'BRAND_ADMIN_ADDED','organization',$1,$3)`,
        [organizationId, identity.userId, JSON.stringify({ email: input.workEmail, role: input.role })]);
      return admin;
    });
  }

  async platformMe(identity: AuthIdentity) {
    await this.requirePlatformAdmin(identity);
    const user = (await this.database.systemQuery(`SELECT id, email, full_name AS "fullName" FROM users WHERE id=$1`, [identity.userId])).rows[0];
    return { ...user, brandless: !identity.organizationId };
  }

  /** Public, unauthenticated branding for a brand's own sign-in page. Unknown or suspended brands look the same (404). */
  async publicBrand(slug: string) {
    const row = (await this.database.systemQuery(
      `SELECT slug, coalesce(display_name,name) AS "displayName", coalesce(short_name,name) AS "shortName", brand_color AS "brandColor",
              accent_color AS "accentColor", ${SAFE_LOGO("logo_data_url")} AS "logoDataUrl", industry FROM organizations WHERE slug=$1 AND status='ACTIVE'`, [slug])).rows[0];
    if (!row) throw new NotFoundException("We couldn't find that workspace.");
    return row;
  }

  // ---- group (multi-brand) dashboard -------------------------------------------------------------

  async groupOverview(identity: AuthIdentity, groupId?: string) {
    const isPlatform = await this.isPlatformAdmin(identity);
    const groups = (await this.database.systemQuery(
      `SELECT g.id, g.name FROM organization_groups g WHERE ($2 OR EXISTS (SELECT 1 FROM group_admins a WHERE a.group_id=g.id AND a.user_id=$1)) ORDER BY g.name`,
      [identity.userId, isPlatform])).rows;
    if (!groups.length) throw new ForbiddenException("You are not an administrator of any brand group.");
    const group = groupId ? groups.find((item) => item.id === groupId) : groups[0];
    if (!group) throw new ForbiddenException("You are not an administrator of this group.");
    const orgs = (await this.database.systemQuery(`SELECT ${ORG_COLUMNS} FROM organizations o WHERE o.group_id=$1 AND o.status='ACTIVE' ORDER BY coalesce(o.display_name,o.name)`, [group.id])).rows;
    const brands: Record<string, unknown>[] = [];
    for (const org of orgs) brands.push({ ...org, metrics: await this.brandMetrics(org.id) });
    const sum = (key: string) => brands.reduce((total, brand) => total + (Number((brand.metrics as Record<string, unknown>)[key]) || 0), 0);
    return {
      group, groups, generatedAt: new Date().toISOString(), brands,
      totals: { headcount: sum("headcount"), joinersThisMonth: sum("joinersThisMonth"), exitsInProgress: sum("exitsInProgress"), presentToday: sum("presentToday"),
        pendingApprovals: sum("pendingApprovals"), openTickets: sum("openTickets"), overdueTickets: sum("overdueTickets"), lastPayrollNet: sum("lastPayrollNet"), pendingClaimsAmount: sum("pendingClaimsAmount") },
    };
  }

  /** Per-brand metrics, each read in its own savepoint so a module without data (or tables) never breaks the dashboard. */
  private brandMetrics(organizationId: string) {
    const identity = { organizationId, userId: "", employeeId: "", roles: [] as string[] };
    return this.database.tenantTransaction(identity, async (client) => {
      const metric = async (sql: string, fallback: unknown = 0) => {
        await client.query("SAVEPOINT metric");
        try { const value = (await client.query(sql, [organizationId])).rows[0]; await client.query("RELEASE SAVEPOINT metric"); return value; }
        catch { await client.query("ROLLBACK TO SAVEPOINT metric"); return fallback; }
      };
      const people = await metric(`SELECT count(*) FILTER (WHERE status='ACTIVE')::int AS headcount,
          count(*) FILTER (WHERE status='ACTIVE' AND joining_date >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata'))::int AS "joinersThisMonth"
        FROM employees WHERE organization_id=$1`, { headcount: 0, joinersThisMonth: 0 });
      const today = await metric(`SELECT count(DISTINCT employee_id)::int AS "presentToday" FROM attendance_events WHERE organization_id=$1 AND event_type='IN'
          AND (occurred_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date`, { presentToday: 0 });
      const cases = await metric(`SELECT count(*) FILTER (WHERE closed_at IS NULL AND module='exit')::int AS "exitsInProgress",
          count(*) FILTER (WHERE closed_at IS NULL AND module='helpdesk')::int AS "openTickets",
          count(*) FILTER (WHERE closed_at IS NULL AND module='helpdesk' AND due_at < now() AND status <> 'RESOLVED')::int AS "overdueTickets",
          count(*) FILTER (WHERE closed_at IS NULL AND status IN ('SUBMITTED','REQUESTED','PENDING_APPROVAL'))::int AS "pendingCases",
          coalesce(sum(amount) FILTER (WHERE module='expenses' AND closed_at IS NULL AND status IN ('SUBMITTED','APPROVED')),0)::float AS "pendingClaimsAmount"
        FROM hr_cases WHERE organization_id=$1`, {});
      const leave = await metric(`SELECT count(*)::int AS "pendingLeave" FROM leave_requests WHERE organization_id=$1 AND status='PENDING'`, { pendingLeave: 0 });
      const payroll = await metric(`SELECT period AS "lastPayrollPeriod", coalesce((totals->>'net')::float, 0) AS "lastPayrollNet" FROM payroll_runs
          WHERE organization_id=$1 AND status IN ('PUBLISHED','LOCKED') ORDER BY period DESC LIMIT 1`, null)
        || await metric(`SELECT period AS "lastPayrollPeriod", sum(net)::float AS "lastPayrollNet" FROM payslips WHERE organization_id=$1 AND status='PUBLISHED'
          GROUP BY period ORDER BY period DESC LIMIT 1`, {});
      const merged = { ...(people as object), ...(today as object), ...(cases as object), ...(leave as object), ...((payroll as object) || {}) } as Record<string, number>;
      return { ...merged, pendingApprovals: (merged.pendingCases || 0) + (merged.pendingLeave || 0) };
    });
  }

  // ---- demo sign-in (local only) ---------------------------------------------------------------

  async demoPlatformAdmins() {
    return { items: (await this.database.systemQuery(`SELECT u.email, u.full_name AS "fullName" FROM platform_admins p JOIN users u ON u.id=p.user_id ORDER BY u.full_name`)).rows };
  }

  async demoIdentities(slug?: string) {
    const rows = (await this.database.systemQuery(
      `SELECT o.slug, coalesce(o.display_name,o.name) AS "displayName", o.brand_color AS "brandColor", ${SAFE_LOGO("o.logo_data_url")} AS "logoDataUrl",
              e.employee_number AS "employeeNumber", e.full_name AS "fullName", e.designation, m.role
         FROM organizations o JOIN organization_memberships m ON m.organization_id=o.id AND m.status='ACTIVE'
         JOIN employees e ON e.organization_id=o.id AND e.user_id=m.user_id
        WHERE o.status='ACTIVE' AND ($1::text IS NULL OR o.slug=$1)
        ORDER BY coalesce(o.display_name,o.name), array_position(ARRAY['EMPLOYEE','MANAGER','HR_ADMIN','PAYROLL_ADMIN','OWNER'], m.role), e.full_name`, [slug || null])).rows;
    const byOrg = new Map<string, { slug: string; displayName: string; brandColor: string; logoDataUrl: string | null; people: Record<string, unknown>[] }>();
    for (const row of rows) {
      const org = byOrg.get(row.slug) || { slug: row.slug, displayName: row.displayName, brandColor: row.brandColor, logoDataUrl: row.logoDataUrl, people: [] as Record<string, unknown>[] };
      org.people.push({ employeeNumber: row.employeeNumber, fullName: row.fullName, designation: row.designation, role: row.role });
      byOrg.set(row.slug, org);
    }
    return { organizations: [...byOrg.values()] };
  }

  // ---- helpers ---------------------------------------------------------------------------------

  async isPlatformAdmin(identity: AuthIdentity) {
    if (!identity.userId) return false;
    return !!(await this.database.systemQuery(`SELECT 1 FROM platform_admins WHERE user_id=$1`, [identity.userId])).rowCount;
  }
  private async requirePlatformAdmin(identity: AuthIdentity) {
    if (!(await this.isPlatformAdmin(identity))) throw new ForbiddenException("Only platform administrators can manage organizations.");
  }

  private async addMember(client: PoolClient, organizationId: string, prefix: string, sequence: number, fullName: string, email: string, designation: string, role: string, userId?: string) {
    const user = userId ? { id: userId } : (await client.query(
      `INSERT INTO users(email,full_name) VALUES($1,$2) ON CONFLICT (email) DO UPDATE SET full_name=users.full_name RETURNING id`, [email, fullName])).rows[0];
    await client.query(`INSERT INTO organization_memberships(organization_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT (organization_id,user_id) DO UPDATE SET role=excluded.role, status='ACTIVE'`,
      [organizationId, user.id, role]);
    const number = `${prefix}${String(sequence).padStart(3, "0")}`;
    const employee = (await client.query(
      `INSERT INTO employees(organization_id,user_id,employee_number,full_name,work_email,department,designation,joining_date)
       VALUES($1,$2,$3,$4,$5,'People',$6,(now() AT TIME ZONE 'Asia/Kolkata')::date)
       ON CONFLICT (organization_id,user_id) DO UPDATE SET designation=employees.designation RETURNING id, employee_number AS "employeeNumber"`,
      [organizationId, user.id, number, fullName, email, designation])).rows[0];
    return { userId: user.id, employeeId: employee.id, employeeNumber: employee.employeeNumber, email, role };
  }

  private audit(identity: AuthIdentity, organizationId: string, action: string, before: unknown, after: unknown) {
    return this.database.systemQuery(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,'organization',$1,$4,$5)`,
      [organizationId, identity.userId, action, before ? JSON.stringify(before) : null, JSON.stringify(after)]);
  }
}

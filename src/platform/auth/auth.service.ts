import { ForbiddenException, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { Pool } from "pg";
import { RuntimeConfig } from "../config/runtime-config";
import { computeEffective, type CustomAssignmentRow, type Effective } from "../access/effective";
import type { AuthIdentity } from "./auth.types";
import { localTokenKeys, type LocalClaims } from "./local/signing-keys";

/** Roles that may only be used from a session that passed MFA. */
export const MFA_ROLES = ["OWNER", "HR_ADMIN", "PAYROLL_ADMIN"];
const SESSION_CACHE_TTL_MS = 15_000;
const INVALID_SESSION = "Your session has expired or the token is invalid. Please sign in again.";

type CachedAccess = { version: string; validUntil: number; custom: CustomAssignmentRow[] };
const ACCESS_CACHE_TTL_MS = 60_000;
const ACCESS_CACHE_MAX = 5_000;
/** Signature algorithms accepted on bearer tokens (OIDC IdPs sign with asymmetric keys). */
export const JWT_ALGORITHMS = ["RS256", "ES256", "PS256"];
export const JWT_CLOCK_TOLERANCE_S = 30;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly pool: Pool;
  /** Custom-role assignments per org+employee, valid while the org's access version is unchanged (see access_org_state). */
  private readonly accessCache = new Map<string, CachedAccess>();
  private accessUnavailableLogged = false;
  private readonly jwks;
  private readonly local = localTokenKeys();
  /** First-party session liveness (revoked / past absolute expiry), cached briefly per process. */
  private readonly sessionCache = new Map<string, { active: boolean; until: number }>();

  constructor(private readonly config: RuntimeConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
    this.jwks = config.oidcJwksUrl
      ? createRemoteJWKSet(new URL(config.oidcJwksUrl))
      : null;
  }

  async authenticate(headers: Record<string, unknown>): Promise<AuthIdentity> {
    const authorization = String(headers.authorization || "");
    if (authorization.startsWith("Bearer ")) {
      const token = authorization.slice(7);
      if (this.local.isLocal(token)) return this.withAccess(await this.fromLocalToken(token, headers));
      return this.withAccess({ ...(await this.fromToken(token, headers)), authMethod: "oidc" });
    }
    if (this.config.nodeEnv !== "production" && this.config.allowDemoIdentity)
      return this.withAccess({ ...(await this.fromDemoHeaders(headers)), authMethod: "demo" });
    throw new UnauthorizedException("A valid bearer token is required.");
  }

  /** Effective permissions + scopes for an identity (base role ∪ live custom-role assignments). */
  async effectiveAccess(identity: Pick<AuthIdentity, "organizationId" | "employeeId" | "roles">): Promise<Effective> {
    return computeEffective(identity.roles.filter(Boolean), await this.customAssignments(identity.organizationId, identity.employeeId));
  }

  private async withAccess(identity: AuthIdentity): Promise<AuthIdentity> {
    const { permissions, scopes } = await this.effectiveAccess(identity);
    return { ...identity, permissions, scopes };
  }

  /**
   * One PK lookup per request (the org's access version); assignments are re-read only when the version changed, the
   * entry is older than a minute, or a temporary grant in it has expired. Any access change bumps the version in the
   * same transaction, so every API/worker process sees it on the next request.
   */
  private async customAssignments(organizationId: string, employeeId: string): Promise<CustomAssignmentRow[]> {
    if (!employeeId) return [];
    try {
      const version = String((await this.pool.query(`SELECT version FROM access_org_state WHERE organization_id=$1`, [organizationId])).rows[0]?.version ?? "0");
      const key = `${organizationId}:${employeeId}`;
      const cached = this.accessCache.get(key);
      if (cached && cached.version === version && cached.validUntil > Date.now()) return cached.custom;
      const custom = (await this.pool.query<CustomAssignmentRow>(
        `SELECT a.id AS assignment_id, r.id AS role_id, r.name AS role_name, r.permissions, a.expires_at, a.restrict_department, a.restrict_location
           FROM access_role_assignments a
           JOIN access_roles r ON r.id=a.role_id AND r.organization_id=a.organization_id AND r.status='ACTIVE'
          WHERE a.organization_id=$1 AND a.employee_id=$2 AND a.revoked_at IS NULL AND a.starts_at <= now()
            AND (a.expires_at IS NULL OR a.expires_at > now())`,
        [organizationId, employeeId])).rows;
      const nextExpiry = Math.min(...custom.map((row) => (row.expires_at ? new Date(row.expires_at).getTime() : Infinity)));
      if (this.accessCache.size >= ACCESS_CACHE_MAX) this.accessCache.clear();
      this.accessCache.set(key, { version, custom, validUntil: Math.min(Date.now() + ACCESS_CACHE_TTL_MS, nextExpiry) });
      return custom;
    } catch (error) {
      // Access tables not migrated yet (or a transient DB error): fall back to base-role permissions only.
      if (!this.accessUnavailableLogged) { this.logger.warn(`Custom roles unavailable, using base roles only: ${(error as Error).message}`); this.accessUnavailableLogged = true; }
      return [];
    }
  }

  private async fromToken(token: string, headers: Record<string, unknown>): Promise<AuthIdentity> {
    // Without a pinned issuer and audience jose would skip those checks, so treat that as "not configured".
    if (!this.jwks || !this.config.oidcIssuer || !this.config.oidcAudience)
      throw new UnauthorizedException("OIDC verification is not configured.");
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.oidcIssuer,
        audience: this.config.oidcAudience,
        // Asymmetric algorithms only: no HS* (a public JWK must never double as an HMAC secret) and never "none".
        algorithms: JWT_ALGORITHMS,
        requiredClaims: ["exp", "iat", "sub", "iss", "aud"],
        clockTolerance: JWT_CLOCK_TOLERANCE_S,
      }));
    } catch {
      throw new UnauthorizedException("Your session has expired or the token is invalid. Please sign in again.");
    }
    // jose does not reject an iat in the future; a token "issued" later than now (beyond clock skew) is forged or from a broken IdP.
    if (typeof payload.iat !== "number" || payload.iat > Math.floor(Date.now() / 1000) + JWT_CLOCK_TOLERANCE_S)
      throw new UnauthorizedException("Your session has expired or the token is invalid. Please sign in again.");
    return this.resolveMembership(payload, headers);
  }

  /** Drops the cached liveness of a first-party session (called right after it is revoked in this process). */
  forgetSession(sessionId: string) { this.sessionCache.delete(sessionId); }

  private async sessionActive(sessionId: string, userId: string) {
    const cached = this.sessionCache.get(sessionId);
    if (cached && cached.until > Date.now()) return cached.active;
    const row = (await this.pool.query(
      `SELECT revoked_at IS NULL AND absolute_expires_at > now() AND user_id=$2 AS active FROM auth_sessions WHERE id=$1`, [sessionId, userId])).rows[0];
    const active = !!row?.active;
    if (this.sessionCache.size >= ACCESS_CACHE_MAX) this.sessionCache.clear();
    this.sessionCache.set(sessionId, { active, until: Date.now() + SESSION_CACHE_TTL_MS });
    return active;
  }

  /**
   * First-party access tokens (issued by NativeAuthService): verified with the API's own key (pinned EdDSA/ES256, typ
   * at+jwt, iss/aud/exp/iat/sid required), then the session must still be live. Brand resolution matches OIDC, except
   * that only brands whose sign-in policy allows passwords are reachable, and privileged roles need an MFA session.
   */
  private async fromLocalToken(token: string, headers: Record<string, unknown>): Promise<AuthIdentity> {
    let claims: LocalClaims;
    try { claims = await this.local.verify(token, JWT_CLOCK_TOLERANCE_S); } catch { throw new UnauthorizedException(INVALID_SESSION); }
    if (typeof claims.iat !== "number" || claims.iat > Math.floor(Date.now() / 1000) + JWT_CLOCK_TOLERANCE_S) throw new UnauthorizedException(INVALID_SESSION);
    const userId = String(claims.sub);
    if (!(await this.sessionActive(claims.sid, userId))) throw new UnauthorizedException(INVALID_SESSION);
    const base = { sessionId: claims.sid, amr: claims.amr, authMethod: "local" as const };
    const requested = String(headers["x-organization-id"] || "");
    if (requested === "platform") return { ...(await this.platformIdentity(userId)), ...base };
    const rows = (await this.pool.query(
      `SELECT m.organization_id, e.id AS employee_id, array_agg(m.role) AS roles, bool_or(coalesce(p.mfa_required_all,false)) AS mfa_all
         FROM organization_memberships m
         JOIN organizations o ON o.id=m.organization_id AND o.status='ACTIVE'
         LEFT JOIN employees e ON e.organization_id=m.organization_id AND e.user_id=m.user_id
         LEFT JOIN organization_auth_policies p ON p.organization_id=m.organization_id
        WHERE m.user_id=$1 AND m.status='ACTIVE' AND coalesce(e.status,'ACTIVE')='ACTIVE' AND coalesce(p.sign_in_methods,'BOTH')<>'SSO'
          AND ($2='' OR m.organization_id::text=$2)
        GROUP BY m.organization_id, e.id, o.display_name, o.name
        ORDER BY coalesce(o.display_name, o.name)`, [userId, requested])).rows;
    if (!rows.length) throw new ForbiddenException("You have no active membership in this organization.");
    const row = rows[0];
    const roles: string[] = row.roles || [];
    if ((row.mfa_all || roles.some((role) => MFA_ROLES.includes(role))) && !claims.amr.includes("mfa"))
      throw new ForbiddenException({ message: "This workspace requires multi-factor authentication. Sign in again to verify.", code: "MFA_REQUIRED" });
    return { organizationId: row.organization_id, userId, employeeId: row.employee_id, roles, ...base };
  }

  /**
   * Maps a verified token to a user: first by the bound (issuer, subject); on first sign-in by a verified email,
   * which is then bound so later email changes at the IdP cannot hijack another account.
   */
  private async resolveMembership(payload: JWTPayload, headers: Record<string, unknown>): Promise<AuthIdentity> {
    const subject = String(payload.sub || "");
    if (!subject) throw new UnauthorizedException("Token is missing a subject.");
    const issuer = this.config.oidcIssuer;
    let user = (await this.pool.query(`SELECT id FROM users WHERE oidc_issuer=$1 AND oidc_subject=$2`, [issuer, subject])).rows[0];
    if (!user) {
      const email = String(payload.email || "").toLowerCase();
      if (!email || payload.email_verified !== true)
        throw new UnauthorizedException("Your account is not linked yet and the identity provider did not supply a verified email.");
      user = (await this.pool.query(
        `UPDATE users SET oidc_issuer=$1, oidc_subject=$2 WHERE lower(email)=$3 AND oidc_subject IS NULL RETURNING id`,
        [issuer, subject, email])).rows[0];
      if (!user) throw new ForbiddenException("No Northstar account exists for this email. Ask HR to invite you.");
    }
    await this.pool.query(`UPDATE users SET last_sign_in_at=now() WHERE id=$1 AND (last_sign_in_at IS NULL OR last_sign_in_at < now() - interval '5 minutes')`, [user.id]);
    const requested = String(payload.organization_id || headers["x-organization-id"] || "");
    if (requested === "platform") return this.platformIdentity(user.id);
    const result = await this.pool.query(
      `SELECT m.organization_id, e.id AS employee_id, array_agg(m.role) AS roles
         FROM organization_memberships m
         JOIN organizations o ON o.id=m.organization_id AND o.status='ACTIVE'
         LEFT JOIN employees e ON e.organization_id=m.organization_id AND e.user_id=m.user_id
         LEFT JOIN organization_auth_policies p ON p.organization_id=m.organization_id
        WHERE m.user_id=$1 AND m.status='ACTIVE' AND coalesce(e.status,'ACTIVE')='ACTIVE' AND coalesce(p.sign_in_methods,'BOTH')<>'PASSWORD'
          AND ($2='' OR m.organization_id::text=$2)
        GROUP BY m.organization_id, e.id, o.display_name, o.name
        ORDER BY coalesce(o.display_name, o.name)`,
      [user.id, requested],
    );
    if (!result.rowCount) throw new ForbiddenException("You have no active membership in this organization.");
    // People in several brands start in the first one alphabetically; the web/mobile brand switcher sends x-organization-id after that.
    const row = result.rows[0];
    return { organizationId: row.organization_id, userId: user.id, employeeId: row.employee_id, roles: row.roles || [] };
  }

  /** Super admins act outside any brand: only platform routes accept this identity (see ModuleGuard). */
  async platformIdentity(userId: string): Promise<AuthIdentity> {
    const admin = await this.pool.query(`SELECT 1 FROM platform_admins WHERE user_id=$1`, [userId]);
    if (!admin.rowCount) throw new ForbiddenException("This account is not a platform administrator.");
    return { organizationId: "", userId, employeeId: "", roles: ["PLATFORM_ADMIN"] };
  }

  private async fromDemoHeaders(headers: Record<string, unknown>): Promise<AuthIdentity> {
    const tenant = String(headers["x-tenant-id"] || "tenant-demo-001");
    const employee = String(headers["x-employee-id"] || "BT002");
    if (tenant === "platform") {
      const user = (await this.pool.query(`SELECT id FROM users WHERE lower(email)=lower($1)`, [employee])).rows[0];
      if (!user) throw new UnauthorizedException("Demo platform administrator was not found.");
      return this.platformIdentity(user.id);
    }
    const result = await this.pool.query(
      `SELECT o.id AS organization_id,e.id AS employee_id,e.user_id,array_agg(m.role) AS roles
         FROM organizations o
         JOIN employees e ON e.organization_id=o.id
         LEFT JOIN organization_memberships m ON m.organization_id=o.id AND m.user_id=e.user_id AND m.status='ACTIVE'
        WHERE o.slug=$1 AND (e.employee_number=$2 OR e.work_email=$2)
        GROUP BY o.id,e.id,e.user_id LIMIT 1`,
      [tenant === "tenant-demo-001" ? "blue-tokai" : tenant, employee],
    );
    if (!result.rowCount) throw new UnauthorizedException("Demo employee was not found.");
    return {
      organizationId: result.rows[0].organization_id,
      userId: result.rows[0].user_id,
      employeeId: result.rows[0].employee_id,
      roles: result.rows[0].roles || ["EMPLOYEE"],
    };
  }
}

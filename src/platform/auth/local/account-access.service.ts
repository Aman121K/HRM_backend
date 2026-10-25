import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../database/database.service";
import type { AuthIdentity } from "../auth.types";
import { AuthMailer, brandWebUrl, emailButton, paragraphs } from "./auth-mailer";
import { auditAccount, newToken, normalizeEmail, recordAuthEvent, tokenHash } from "./native-auth.shared";
import { INVITE_HOURS, NativeAuthService } from "./native-auth.service";

export type AuthPolicy = { signInMethods: "PASSWORD" | "SSO" | "BOTH"; mfaRequiredAll: boolean; emailOtpFallback: boolean; sessionMaxHours: number; sessionIdleMinutes: number };
const DEFAULT_POLICY: AuthPolicy = { signInMethods: "BOTH", mfaRequiredAll: false, emailOtpFallback: true, sessionMaxHours: 720, sessionIdleMinutes: 720 };
const BULK_LIMIT = 500;

/**
 * HR / owner side of first-party accounts: invitations, MFA resets and the brand sign-in policy; plus the platform
 * side (super-admin invites, MFA reset for brand owners). Identity tables are owner-pool only, so every query here
 * filters by the caller's organization explicitly and checks roles before touching anything.
 */
@Injectable()
export class AccountAccessService {
  constructor(private readonly database: DatabaseService, private readonly mailer: AuthMailer, private readonly native: NativeAuthService) {}

  private async isPlatformAdmin(userId: string) {
    return !!userId && !!(await this.database.systemQuery(`SELECT 1 FROM platform_admins WHERE user_id=$1`, [userId])).rowCount;
  }

  // ---- status ----------------------------------------------------------------------------------------------------------

  async employeeAccess(identity: AuthIdentity, employeeId?: string) {
    const rows = (await this.database.systemQuery(
      `SELECT e.id AS "employeeId", e.employee_number AS "employeeNumber", e.full_name AS "fullName", e.work_email AS "workEmail", e.status,
              m.role, m.status AS "membershipStatus", u.id AS "userId",
              (u.password_hash IS NOT NULL) AS "hasPassword", (u.oidc_subject IS NOT NULL) AS "ssoLinked", u.last_sign_in_at AS "lastSignInAt",
              (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
              EXISTS(SELECT 1 FROM auth_totp_devices d WHERE d.user_id=u.id AND d.confirmed_at IS NOT NULL) AS "mfaEnrolled",
              i.created_at AS "invitedAt", i.expires_at AS "inviteExpiresAt", i.accepted_at AS "inviteAcceptedAt"
         FROM employees e
         LEFT JOIN users u ON u.id=e.user_id
         LEFT JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.user_id=e.user_id
         LEFT JOIN LATERAL (SELECT created_at, expires_at, accepted_at FROM auth_invites
                             WHERE organization_id=e.organization_id AND user_id=e.user_id AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1) i ON true
        WHERE e.organization_id=$1 AND ($2::uuid IS NULL OR e.id=$2::uuid)
        ORDER BY e.full_name LIMIT 2000`, [identity.organizationId, employeeId || null])).rows.map((row: any) => ({
      ...row,
      access: row.hasPassword || row.ssoLinked ? "ACTIVE"
        : row.invitedAt && !row.inviteAcceptedAt && new Date(row.inviteExpiresAt) > new Date() ? "INVITED"
          : row.invitedAt && !row.inviteAcceptedAt ? "INVITE_EXPIRED" : "NO_LOGIN",
    }));
    if (employeeId) {
      if (!rows[0]) throw new NotFoundException("Employee not found.");
      return rows[0];
    }
    const summary = rows.reduce<Record<string, number>>((acc, row) => { acc[row.access] = (acc[row.access] || 0) + 1; return acc; }, {});
    return { items: rows, summary, invitable: rows.filter((row) => row.status === "ACTIVE" && (row.access === "NO_LOGIN" || row.access === "INVITE_EXPIRED")).length };
  }

  // ---- invites -----------------------------------------------------------------------------------------------------------

  async invite(identity: AuthIdentity, employeeId: string) {
    const result = await this.database.platformTransaction((client) => this.inviteOne(client, identity, employeeId, true));
    await this.sendInvite(result);
    return { invited: true, email: result.email, expiresAt: result.expiresAt };
  }

  /** Invites every active employee of this brand who has no way to sign in yet (and no live invite). */
  async inviteAll(identity: AuthIdentity) {
    const candidates = (await this.database.systemQuery(
      `SELECT e.id FROM employees e LEFT JOIN users u ON u.id=e.user_id
        WHERE e.organization_id=$1 AND e.status='ACTIVE' AND (u.id IS NULL OR (u.password_hash IS NULL AND u.oidc_subject IS NULL))
          AND NOT EXISTS (SELECT 1 FROM auth_invites i WHERE i.organization_id=e.organization_id AND i.user_id=e.user_id
                            AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now())
        ORDER BY e.full_name LIMIT $2`, [identity.organizationId, BULK_LIMIT])).rows;
    let invited = 0;
    const skipped: { employeeId: string; reason: string }[] = [];
    for (const candidate of candidates) {
      try {
        const result = await this.database.platformTransaction((client) => this.inviteOne(client, identity, candidate.id, false));
        await this.sendInvite(result);
        invited += 1;
      } catch (error) {
        skipped.push({ employeeId: candidate.id, reason: (error as Error).message });
      }
    }
    return { invited, skipped, limit: BULK_LIMIT };
  }

  private async inviteOne(client: PoolClient, identity: AuthIdentity, employeeId: string, replace: boolean) {
    const employee = (await client.query(
      `SELECT e.id, e.user_id, e.full_name, e.work_email, e.status, o.slug, coalesce(o.display_name,o.name) AS brand_name
         FROM employees e JOIN organizations o ON o.id=e.organization_id WHERE e.organization_id=$1 AND e.id=$2 FOR UPDATE OF e`,
      [identity.organizationId, employeeId])).rows[0];
    if (!employee) throw new NotFoundException("Employee not found.");
    if (employee.status !== "ACTIVE") throw new BadRequestException("Only active employees can be invited.");
    const email = normalizeEmail(employee.work_email);
    if (!/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(email)) throw new BadRequestException("This employee has no valid work email.");
    let userId: string = employee.user_id;
    if (!userId) {
      userId = (await client.query(`INSERT INTO users(email, full_name) VALUES($1,$2) ON CONFLICT (email) DO UPDATE SET email=users.email RETURNING id`, [email, employee.full_name])).rows[0].id;
      await client.query(`UPDATE employees SET user_id=$3 WHERE organization_id=$1 AND id=$2`, [identity.organizationId, employee.id, userId]);
    }
    await client.query(
      `INSERT INTO organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'EMPLOYEE','ACTIVE') ON CONFLICT (organization_id,user_id) DO NOTHING`,
      [identity.organizationId, userId]);
    const membership = (await client.query(`SELECT status FROM organization_memberships WHERE organization_id=$1 AND user_id=$2`, [identity.organizationId, userId])).rows[0];
    if (membership.status !== "ACTIVE") throw new BadRequestException("This person's access to the workspace is revoked. Restore it before inviting.");
    const user = (await client.query(`SELECT password_hash IS NOT NULL AS has_password, oidc_subject IS NOT NULL AS sso, full_name FROM users WHERE id=$1`, [userId])).rows[0];
    if (user.has_password) throw new ConflictException("This person already has a Northstar login — they can sign in with their existing password.");
    const live = (await client.query(
      `SELECT id FROM auth_invites WHERE user_id=$1 AND organization_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`, [userId, identity.organizationId])).rows;
    if (live.length && !replace) throw new ConflictException("An invitation is already pending.");
    await client.query(`UPDATE auth_invites SET revoked_at=now() WHERE user_id=$1 AND organization_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL`, [userId, identity.organizationId]);
    const raw = newToken();
    const invite = (await client.query(
      `INSERT INTO auth_invites(kind,organization_id,user_id,employee_id,email,token_hash,invited_by,expires_at)
       VALUES('BRAND',$1,$2,$3,$4,$5,$6,now()+make_interval(hours => $7)) RETURNING id, expires_at`,
      [identity.organizationId, userId, employee.id, email, tokenHash(raw), identity.userId, INVITE_HOURS])).rows[0];
    await auditAccount(client, { subjectUserId: userId, actorUserId: identity.userId, action: live.length ? "AUTH_INVITE_RESENT" : "AUTH_INVITE_SENT",
      organizationIds: [identity.organizationId], after: { inviteId: invite.id, employeeId: employee.id, email, expiresAt: invite.expires_at } });
    return { raw, email, fullName: employee.full_name as string, organizationId: identity.organizationId, slug: employee.slug as string, brandName: employee.brand_name as string, expiresAt: invite.expires_at };
  }

  private async sendInvite(input: { raw: string; email: string; fullName: string; organizationId: string | null; slug: string | null; brandName: string }) {
    const link = brandWebUrl(input.slug, `/activate?token=${encodeURIComponent(input.raw)}`);
    await this.mailer.send(input.organizationId, input.email, `You're invited to ${input.brandName} on Northstar People`,
      paragraphs(`Hi ${input.fullName},`, `${input.brandName} has invited you to Northstar People — where you'll see your attendance, leave, payslips and requests.`,
        "Set your password and secure your account with the button below.")
      + emailButton("Set up my account", link)
      + paragraphs(`This link works once and expires in ${INVITE_HOURS} hours.`, "If you weren't expecting this invitation, you can ignore this email."));
  }

  async revokeInvite(identity: AuthIdentity, employeeId: string) {
    const rows = (await this.database.systemQuery(
      `UPDATE auth_invites i SET revoked_at=now() FROM employees e
        WHERE e.organization_id=$1 AND e.id=$2 AND i.organization_id=e.organization_id AND i.user_id=e.user_id AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        RETURNING i.id, i.user_id`, [identity.organizationId, employeeId])).rows;
    if (!rows.length) throw new NotFoundException("There is no pending invitation for this employee.");
    await auditAccount(this.database, { subjectUserId: rows[0].user_id, actorUserId: identity.userId, action: "AUTH_INVITE_REVOKED", organizationIds: [identity.organizationId], after: { invites: rows.map((row) => row.id) } });
    return { revoked: rows.length };
  }

  // ---- MFA reset ---------------------------------------------------------------------------------------------------------

  /**
   * HR / owner resets a colleague's authenticator: devices and recovery codes are removed and every session revoked, so
   * the next sign-in requires a new enrolment (and their password). Never one's own account; HR admins can't reset an
   * owner; a person who also belongs to other brands needs an admin of every one of them (or a platform admin).
   */
  async resetMfa(identity: AuthIdentity, employeeId: string) {
    if (!identity.roles.includes("OWNER") && !identity.roles.includes("HR_ADMIN")) throw new ForbiddenException("Only owners and HR admins can reset MFA.");
    const target = (await this.database.systemQuery(
      `SELECT e.user_id, m.role FROM employees e JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.user_id=e.user_id
        WHERE e.organization_id=$1 AND e.id=$2`, [identity.organizationId, employeeId])).rows[0];
    if (!target?.user_id) throw new NotFoundException("This employee has no login.");
    if (target.user_id === identity.userId) throw new ForbiddenException("You can't reset MFA on your own account. Ask another admin or use your recovery codes.");
    if (target.role === "OWNER" && !identity.roles.includes("OWNER")) throw new ForbiddenException("Only an owner (or a platform administrator) can reset an owner's MFA.");
    const elsewhere = (await this.database.systemQuery(
      `SELECT count(*)::int AS n FROM organization_memberships t WHERE t.user_id=$1 AND t.status='ACTIVE' AND t.organization_id<>$2
          AND NOT EXISTS (SELECT 1 FROM organization_memberships a WHERE a.user_id=$3 AND a.organization_id=t.organization_id AND a.status='ACTIVE' AND a.role IN ('OWNER','HR_ADMIN'))`,
      [target.user_id, identity.organizationId, identity.userId])).rows[0].n;
    if (elsewhere) throw new ForbiddenException("This person also belongs to another brand. Ask a platform administrator to reset their MFA.");
    if (await this.isPlatformAdmin(target.user_id)) throw new ForbiddenException("Platform administrators' MFA can only be reset by another platform administrator.");
    return this.doReset(target.user_id, identity.userId, [identity.organizationId], { employeeId });
  }

  private async doReset(userId: string, actorUserId: string, organizationIds: string[] | null, detail: Record<string, unknown>) {
    const devices = (await this.database.systemQuery(`DELETE FROM auth_totp_devices WHERE user_id=$1 RETURNING id`, [userId])).rowCount;
    await this.database.systemQuery(`DELETE FROM auth_recovery_codes WHERE user_id=$1`, [userId]);
    const sessions = await this.native.revokeSessions(userId, "mfa_reset");
    await auditAccount(this.database, { subjectUserId: userId, actorUserId, action: "AUTH_MFA_RESET", organizationIds, after: { ...detail, devicesRemoved: devices, sessionsRevoked: sessions } });
    await recordAuthEvent(this.database, { event: "mfa_reset", success: true, userId, detail: { by: actorUserId } });
    const user = (await this.database.systemQuery(`SELECT email, full_name FROM users WHERE id=$1`, [userId])).rows[0];
    const brand = organizationIds?.[0] || null;
    await this.mailer.send(brand, user.email, "Your sign-in verification was reset",
      paragraphs(`Hi ${user.full_name},`, "An administrator reset the authenticator app on your Northstar account and signed you out everywhere.",
        "Next time you sign in you'll be asked to set up an authenticator again. If you didn't ask for this, contact your HR team.")).catch(() => undefined);
    return { reset: true, devicesRemoved: devices, sessionsRevoked: sessions };
  }

  // ---- policy --------------------------------------------------------------------------------------------------------------

  async policy(identity: AuthIdentity): Promise<AuthPolicy & { updatedAt: string | null }> {
    const row = (await this.database.systemQuery(
      `SELECT sign_in_methods AS "signInMethods", mfa_required_all AS "mfaRequiredAll", email_otp_fallback AS "emailOtpFallback",
              session_max_hours AS "sessionMaxHours", session_idle_minutes AS "sessionIdleMinutes", updated_at AS "updatedAt"
         FROM organization_auth_policies WHERE organization_id=$1`, [identity.organizationId])).rows[0];
    return (row as AuthPolicy & { updatedAt: string | null }) || { ...DEFAULT_POLICY, updatedAt: null };
  }

  async updatePolicy(identity: AuthIdentity, input: Partial<AuthPolicy>) {
    const before = await this.policy(identity);
    const next: AuthPolicy = { ...DEFAULT_POLICY, ...before, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) } as AuthPolicy;
    if (next.signInMethods === "SSO") {
      const hasSso = !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID);
      if (!hasSso) throw new BadRequestException("Single sign-on isn't configured for Northstar yet, so password sign-in can't be turned off.");
    }
    if (next.sessionIdleMinutes > next.sessionMaxHours * 60) next.sessionIdleMinutes = next.sessionMaxHours * 60;
    await this.database.systemQuery(
      `INSERT INTO organization_auth_policies(organization_id,sign_in_methods,mfa_required_all,email_otp_fallback,session_max_hours,session_idle_minutes,updated_by,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (organization_id) DO UPDATE SET sign_in_methods=excluded.sign_in_methods, mfa_required_all=excluded.mfa_required_all,
         email_otp_fallback=excluded.email_otp_fallback, session_max_hours=excluded.session_max_hours, session_idle_minutes=excluded.session_idle_minutes,
         updated_by=excluded.updated_by, updated_at=now()`,
      [identity.organizationId, next.signInMethods, next.mfaRequiredAll, next.emailOtpFallback, next.sessionMaxHours, next.sessionIdleMinutes, identity.userId]);
    await this.database.systemQuery(
      `INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,'AUTH_POLICY_UPDATED','organization',$1,$3,$4)`,
      [identity.organizationId, identity.userId, JSON.stringify(before), JSON.stringify(next)]);
    return this.policy(identity);
  }

  // ---- platform ----------------------------------------------------------------------------------------------------------

  async invitePlatformAdmin(identity: AuthIdentity, input: { email: string; fullName: string }) {
    if (!(await this.isPlatformAdmin(identity.userId))) throw new ForbiddenException("Only platform administrators can invite platform administrators.");
    const email = normalizeEmail(input.email);
    const result = await this.database.platformTransaction(async (client) => {
      const user = (await client.query(
        `INSERT INTO users(email, full_name) VALUES($1,$2) ON CONFLICT (email) DO UPDATE SET email=users.email RETURNING id, password_hash IS NOT NULL AS has_password`,
        [email, input.fullName.trim()])).rows[0];
      if (user.has_password) {
        await client.query(`INSERT INTO platform_admins(user_id) VALUES($1) ON CONFLICT DO NOTHING`, [user.id]);
        return { existing: true as const, userId: user.id };
      }
      await client.query(`UPDATE auth_invites SET revoked_at=now() WHERE user_id=$1 AND kind='PLATFORM' AND accepted_at IS NULL AND revoked_at IS NULL`, [user.id]);
      const raw = newToken();
      const invite = (await client.query(
        `INSERT INTO auth_invites(kind,organization_id,user_id,email,token_hash,invited_by,expires_at) VALUES('PLATFORM',NULL,$1,$2,$3,$4,now()+make_interval(hours => $5)) RETURNING id, expires_at`,
        [user.id, email, tokenHash(raw), identity.userId, INVITE_HOURS])).rows[0];
      return { existing: false as const, userId: user.id, raw, inviteId: invite.id, expiresAt: invite.expires_at };
    });
    await recordAuthEvent(this.database, { event: result.existing ? "platform_admin_granted" : "platform_admin_invited", success: true, userId: result.userId, detail: { by: identity.userId } });
    if (!result.existing) await this.sendInvite({ raw: result.raw, email, fullName: input.fullName, organizationId: null, slug: null, brandName: "the Northstar platform team" });
    return result.existing ? { granted: true, email } : { invited: true, email, expiresAt: result.expiresAt };
  }

  /**
   * Platform admin sends the account set-up email to a brand admin — the first HR admin of a new brand can't be
   * invited by anyone inside that brand yet. People who already have a Northstar password just sign in.
   */
  async platformInviteMember(identity: AuthIdentity, organizationId: string, userId: string) {
    if (!(await this.isPlatformAdmin(identity.userId))) throw new ForbiddenException("Only platform administrators can do this.");
    const member = (await this.database.systemQuery(
      `SELECT e.id AS employee_id, (u.password_hash IS NOT NULL OR u.oidc_subject IS NOT NULL) AS can_sign_in, u.email
         FROM organization_memberships m JOIN users u ON u.id=m.user_id
         LEFT JOIN employees e ON e.organization_id=m.organization_id AND e.user_id=m.user_id
        WHERE m.organization_id=$1 AND m.user_id=$2 AND m.status='ACTIVE' AND m.role IN ('OWNER','HR_ADMIN','PAYROLL_ADMIN')`,
      [organizationId, userId])).rows[0];
    if (!member) throw new NotFoundException("That person is not an admin of this brand.");
    if (member.can_sign_in) return { invited: false, alreadyActive: true, email: member.email };
    if (!member.employee_id) throw new BadRequestException("This admin has no employee record in the brand.");
    const actingInBrand: AuthIdentity = { organizationId, userId: identity.userId, employeeId: "", roles: ["PLATFORM_ADMIN"] };
    const result = await this.database.platformTransaction((client) => this.inviteOne(client, actingInBrand, member.employee_id, true));
    await this.sendInvite(result);
    return { invited: true, email: result.email, expiresAt: result.expiresAt };
  }

  /** Platform admin resets a brand owner's (or any member's) MFA. */
  async platformResetMfa(identity: AuthIdentity, organizationId: string, userId: string) {
    if (!(await this.isPlatformAdmin(identity.userId))) throw new ForbiddenException("Only platform administrators can do this.");
    if (userId === identity.userId) throw new ForbiddenException("You can't reset MFA on your own account.");
    const member = (await this.database.systemQuery(`SELECT 1 FROM organization_memberships WHERE organization_id=$1 AND user_id=$2`, [organizationId, userId])).rowCount;
    if (!member) throw new NotFoundException("That person is not a member of this brand.");
    return this.doReset(userId, identity.userId, null, { organizationId, byPlatformAdmin: true });
  }
}

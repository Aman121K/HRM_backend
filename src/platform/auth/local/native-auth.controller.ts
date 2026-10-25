import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { FastifyReply, FastifyRequest } from "fastify";
import { RuntimeConfig } from "../../config/runtime-config";
import { AuthService } from "../auth.service";
import { Public } from "../public.decorator";
import { Roles } from "../roles.decorator";
import { AccountAccessService } from "./account-access.service";
import {
  ActivateDto, ChallengeDto, ChangePasswordDto, CodeDto, EnrollConfirmDto, ForgotDto, LoginDto, MfaVerifyDto, PlatformInviteDto, PolicyDto, RefreshDto,
  ResetDto, TokenDto, TotpConfirmDto, TotpRemoveDto, TotpStartDto,
} from "./native-auth.dto";
import { NativeAuthService, REFRESH_COOKIE, REFRESH_COOKIE_PATH, type AuthResult, type ClientInfo } from "./native-auth.service";

function readCookie(header: string | undefined, name: string) {
  for (const part of String(header || "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return undefined;
}

/** Shared request plumbing for the auth controllers. */
abstract class AuthHttp {
  constructor(protected readonly config: RuntimeConfig) {}

  protected info(request: FastifyRequest): ClientInfo {
    const ua = String(request.headers["user-agent"] || "").slice(0, 512);
    return {
      ip: request.ip, userAgent: ua, origin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
      client: request.headers["x-client"] === "mobile" ? "mobile" : "web",
    };
  }

  /** Refresh cookie: HttpOnly, SameSite=Strict, Secure in production (or AUTH_COOKIE_SECURE=true), scoped to the session path. */
  protected send(reply: FastifyReply, result: AuthResult) {
    const secure = this.config.nodeEnv === "production" || process.env.AUTH_COOKIE_SECURE === "true";
    const attributes = `Path=${REFRESH_COOKIE_PATH}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
    if (result.cookie === "clear") reply.header("set-cookie", `${REFRESH_COOKIE}=; ${attributes}; Max-Age=0`);
    else if (result.cookie) reply.header("set-cookie", `${REFRESH_COOKIE}=${encodeURIComponent(result.cookie.value)}; ${attributes}; Max-Age=${result.cookie.maxAge}`);
    reply.header("cache-control", "no-store");
    return result.body;
  }
}

@ApiTags("auth") @Controller("api/v2/auth")
export class NativeAuthController extends AuthHttp {
  constructor(config: RuntimeConfig, private readonly native: NativeAuthService, private readonly auth: AuthService) { super(config); }

  // ---- public ---------------------------------------------------------------------------------------------------------

  /** Which sign-in methods a brand's page should offer. */
  @Get("policy") @Public()
  policy(@Query("brand") brand = "") { return this.native.publicPolicy(String(brand).toLowerCase().slice(0, 40)); }

  @Get("jwks.json") @Public() @Header("cache-control", "public, max-age=300")
  jwks() { return this.native.keys.jwks(); }

  @Post("login") @Public() @HttpCode(200)
  async login(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() input: LoginDto) {
    return this.send(reply, await this.native.login(input, this.info(request)));
  }

  @Post("login/mfa") @Public() @HttpCode(200)
  async mfa(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() input: MfaVerifyDto) {
    return this.send(reply, await this.native.verifyMfa(input, this.info(request)));
  }

  @Post("login/mfa/email") @Public() @HttpCode(200)
  async email(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() input: ChallengeDto) {
    return this.send(reply, await this.native.sendEmailCode(input.challenge, this.info(request)));
  }

  @Post("login/mfa/enroll/start") @Public() @HttpCode(200)
  async enrollStart(@Res({ passthrough: true }) reply: FastifyReply, @Body() input: ChallengeDto) {
    return this.send(reply, await this.native.startEnrollment(input.challenge));
  }

  @Post("login/mfa/enroll/confirm") @Public() @HttpCode(200)
  async enrollConfirm(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() input: EnrollConfirmDto) {
    return this.send(reply, await this.native.confirmEnrollment(input, this.info(request)));
  }

  @Post("login/mfa/enroll/skip") @Public() @HttpCode(200)
  async enrollSkip(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() input: ChallengeDto) {
    return this.send(reply, await this.native.skipEnrollment(input.challenge, this.info(request)));
  }

  /** Rotates the refresh token (cookie for the web; JSON body when x-client: mobile) and returns a new access token. */
  @Post("session/refresh") @Public() @HttpCode(200)
  async refresh(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() input: RefreshDto) {
    const info = this.info(request);
    this.native.assertOrigin(info.origin);
    const raw = info.client === "mobile" ? input.refreshToken : readCookie(request.headers.cookie, REFRESH_COOKIE);
    try {
      return this.send(reply, await this.native.refresh(raw, info));
    } catch (error) {
      if (info.client === "web" && (error as { getStatus?: () => number }).getStatus?.() === 401 && (error as any).response?.code !== "REFRESH_RACE")
        this.send(reply, { body: {}, cookie: "clear" });
      throw error;
    }
  }

  @Post("session/logout") @Public() @HttpCode(200)
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() input: RefreshDto) {
    const info = this.info(request);
    this.native.assertOrigin(info.origin);
    const raw = info.client === "mobile" ? input.refreshToken : readCookie(request.headers.cookie, REFRESH_COOKIE);
    const identity = await this.auth.authenticate({ authorization: request.headers.authorization || "" }).catch(() => undefined);
    return this.send(reply, await this.native.logout(raw, identity?.authMethod === "local" ? identity : undefined, info));
  }

  @Post("password/forgot") @Public() @HttpCode(202)
  forgot(@Req() request: FastifyRequest, @Body() input: ForgotDto) { return this.native.forgotPassword(input, this.info(request)); }

  @Post("password/reset") @Public() @HttpCode(200)
  reset(@Req() request: FastifyRequest, @Body() input: ResetDto) { return this.native.resetPassword(input, this.info(request)); }

  @Post("unlock") @Public() @HttpCode(200)
  unlock(@Req() request: FastifyRequest, @Body() input: TokenDto) { return this.native.unlock(input, this.info(request)); }

  @Post("invites/inspect") @Public() @HttpCode(200)
  inspect(@Req() request: FastifyRequest, @Body() input: TokenDto) { return this.native.inspectInvite(input.token, this.info(request)); }

  @Post("activate") @Public() @HttpCode(200)
  async activate(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() input: ActivateDto) {
    return this.send(reply, await this.native.activate(input, this.info(request)));
  }

  // ---- signed in: my security --------------------------------------------------------------------------------------

  @Get("security") @Header("cache-control", "no-store")
  overview(@Req() request: FastifyRequest) { return this.native.overview(request.identity!); }

  @Post("password/change") @HttpCode(200)
  change(@Req() request: FastifyRequest, @Body() input: ChangePasswordDto) { return this.native.changePassword(request.identity!, input, this.info(request)); }

  @Post("mfa/totp") @HttpCode(200) @Header("cache-control", "no-store")
  totpStart(@Req() request: FastifyRequest, @Body() input: TotpStartDto) { return this.native.startTotp(request.identity!, input, this.info(request)); }

  @Post("mfa/totp/confirm") @HttpCode(200) @Header("cache-control", "no-store")
  totpConfirm(@Req() request: FastifyRequest, @Body() input: TotpConfirmDto) { return this.native.confirmTotp(request.identity!, input, this.info(request)); }

  @Post("mfa/totp/:id/remove") @HttpCode(200)
  totpRemove(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: TotpRemoveDto) {
    return this.native.removeTotp(request.identity!, id, input, this.info(request));
  }

  @Post("mfa/recovery-codes") @HttpCode(200) @Header("cache-control", "no-store")
  recovery(@Req() request: FastifyRequest, @Body() input: CodeDto) { return this.native.regenerateRecoveryCodes(request.identity!, input, this.info(request)); }

  @Delete("sessions/:id")
  revoke(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.native.revokeSession(request.identity!, id); }

  @Post("sessions/revoke-all") @HttpCode(200)
  async revokeAll(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.send(reply, { body: await this.native.revokeAll(request.identity!, this.info(request)), cookie: "clear" });
  }
}

/** The API's own signing keys at the conventional location (first-party token verification by other services). */
@ApiTags("auth") @Controller(".well-known")
export class JwksController {
  constructor(private readonly native: NativeAuthService) {}
  @Get("jwks.json") @Public() @Header("cache-control", "public, max-age=300")
  jwks() { return this.native.keys.jwks(); }
}

const ACCESS_ADMINS = ["OWNER", "HR_ADMIN"];

/** HR / owner: invitations, MFA resets, brand sign-in policy. Not under /auth, so brand-host checks in ModuleGuard apply. */
@ApiTags("account-access") @Controller("api/v2/account-access")
export class AccountAccessController {
  constructor(private readonly access: AccountAccessService) {}

  @Get("employees") @Roles(...ACCESS_ADMINS) @Header("cache-control", "no-store")
  list(@Req() request: FastifyRequest) { return this.access.employeeAccess(request.identity!); }

  @Get("employees/:id") @Roles(...ACCESS_ADMINS) @Header("cache-control", "no-store")
  one(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.access.employeeAccess(request.identity!, id); }

  @Post("employees/:id/invite") @Roles(...ACCESS_ADMINS) @HttpCode(200)
  invite(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.access.invite(request.identity!, id); }

  @Delete("employees/:id/invite") @Roles(...ACCESS_ADMINS)
  revokeInvite(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.access.revokeInvite(request.identity!, id); }

  @Post("invites/bulk") @Roles(...ACCESS_ADMINS) @HttpCode(200)
  bulk(@Req() request: FastifyRequest) { return this.access.inviteAll(request.identity!); }

  @Post("employees/:id/mfa-reset") @Roles(...ACCESS_ADMINS) @HttpCode(200)
  resetMfa(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.access.resetMfa(request.identity!, id); }

  @Get("policy") @Roles(...ACCESS_ADMINS)
  policy(@Req() request: FastifyRequest) { return this.access.policy(request.identity!); }

  @Patch("policy") @Roles(...ACCESS_ADMINS)
  updatePolicy(@Req() request: FastifyRequest, @Body() input: PolicyDto) { return this.access.updatePolicy(request.identity!, input); }
}

/** Platform administrators (brandless identity; ModuleGuard only lets it reach /api/v2/platform). */
@ApiTags("platform") @Controller("api/v2/platform/auth")
export class PlatformAuthController {
  constructor(private readonly access: AccountAccessService) {}

  @Post("admin-invites") @HttpCode(200)
  invite(@Req() request: FastifyRequest, @Body() input: PlatformInviteDto) { return this.access.invitePlatformAdmin(request.identity!, input); }

  @Post("orgs/:orgId/users/:userId/mfa-reset") @HttpCode(200)
  resetMfa(@Req() request: FastifyRequest, @Param("orgId", ParseUUIDPipe) orgId: string, @Param("userId", ParseUUIDPipe) userId: string) {
    return this.access.platformResetMfa(request.identity!, orgId, userId);
  }
}

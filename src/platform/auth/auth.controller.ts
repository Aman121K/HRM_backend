import { Controller, Get, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { RuntimeConfig } from "../config/runtime-config";
import { DatabaseService } from "../database/database.service";
import { Public } from "./public.decorator";

@ApiTags("auth") @Controller("api/v2/auth")
export class AuthController {
  constructor(private readonly config: RuntimeConfig, private readonly database: DatabaseService) {}

  /** What the sign-in page needs: the OIDC issuer/client for PKCE, and whether local demo identities are allowed. */
  @Get("config") @Public()
  settings() {
    const oidc = this.config.oidcIssuer && this.config.oidcClientId
      ? { issuer: this.config.oidcIssuer, clientId: this.config.oidcClientId, scope: this.config.oidcScope, audience: this.config.oidcAudience }
      : null;
    return { oidc, demoIdentity: this.config.nodeEnv !== "production" && this.config.allowDemoIdentity };
  }

  /** The signed-in session: identity, roles and organization. */
  @Get("session")
  async session(@Req() request: FastifyRequest) {
    const identity = request.identity!;
    if (!identity.organizationId) return { ...identity, organization: null, platform: true };
    const organization = (await this.database.systemQuery(`SELECT name, slug FROM organizations WHERE id=$1`, [identity.organizationId])).rows[0];
    return { ...identity, organization };
  }
}

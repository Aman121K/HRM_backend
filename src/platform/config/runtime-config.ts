import { Injectable } from "@nestjs/common";

const bool = (value: string | undefined, fallback = false) =>
  value === undefined ? fallback : value === "true";

@Injectable()
export class RuntimeConfig {
  readonly nodeEnv = process.env.NODE_ENV || "development";
  readonly port = Number(process.env.BACKEND_V2_PORT || 4100);
  readonly databaseUrl = process.env.DATABASE_URL || "";
  /** Least-privilege role for tenant queries (no table ownership, no BYPASSRLS) so Postgres enforces RLS. */
  readonly runtimeDatabaseUrl = process.env.DATABASE_URL_RUNTIME || "";
  readonly corsOrigins = (process.env.CORS_ORIGIN || "http://localhost:3000")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  /** Base domain for brand subdomains: <brand>.<appDomain>. "localhost" works locally without DNS (got-tea.localhost:3000). */
  readonly appDomain = (process.env.APP_DOMAIN || "localhost").toLowerCase();
  /** Header-based demo sign-in. OFF unless ALLOW_DEMO_IDENTITY=true is set explicitly; production refuses to start with it. */
  readonly allowDemoIdentity = bool(process.env.ALLOW_DEMO_IDENTITY, false);
  /** Interface the API listens on. Loopback by default; containers set BIND_HOST=0.0.0.0 behind their load balancer. */
  readonly bindHost = (process.env.BIND_HOST || "127.0.0.1").trim();
  readonly oidcIssuer = process.env.OIDC_ISSUER || "";
  readonly oidcAudience = process.env.OIDC_AUDIENCE || "";
  readonly oidcJwksUrl = process.env.OIDC_JWKS_URL || "";
  /** Public (PKCE) client used by the web app; published through GET /api/v2/auth/config. */
  readonly oidcClientId = process.env.OIDC_CLIENT_ID || "";
  readonly oidcScope = process.env.OIDC_SCOPE || "openid profile email";
  readonly redisUrl = process.env.REDIS_URL || "";

  validate() {
    const errors: string[] = [];
    if (!this.databaseUrl) errors.push("DATABASE_URL is required");
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535)
      errors.push("BACKEND_V2_PORT must be a valid TCP port");
    if (this.nodeEnv === "production") {
      if (!this.runtimeDatabaseUrl || this.runtimeDatabaseUrl === this.databaseUrl)
        errors.push("DATABASE_URL_RUNTIME must point to a separate least-privilege role in production");
      if (this.allowDemoIdentity)
        errors.push("ALLOW_DEMO_IDENTITY must be false in production");
      // Sign-in: company SSO (OIDC) and/or ClanChief's own password sign-in (native auth). At least one must be fully
      // configured; a partially configured OIDC block is always an error (jose would skip unpinned checks).
      const oidcAny = !!(this.oidcIssuer || this.oidcAudience || this.oidcJwksUrl);
      const oidcAll = !!(this.oidcIssuer && this.oidcAudience && this.oidcJwksUrl);
      const nativeAuth = !!(process.env.AUTH_SIGNING_KEY && process.env.AUTH_ISSUER);
      if (oidcAny && !oidcAll) errors.push("OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URL must all be set when OIDC is used");
      if (!oidcAll && !nativeAuth)
        errors.push("Configure sign-in: AUTH_SIGNING_KEY and AUTH_ISSUER (ClanChief password sign-in) and/or OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URL (company SSO)");
      if (!this.redisUrl) errors.push("REDIS_URL is required in production");
    }
    if (errors.length) throw new Error(`Invalid backend configuration: ${errors.join("; ")}`);
  }
}

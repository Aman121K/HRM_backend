import type { ScopeInfo } from "../access/effective";

export type AuthIdentity = {
  organizationId: string;
  userId: string;
  employeeId: string;
  /** Base membership role(s) — unchanged semantics; @Roles checks these first. */
  roles: string[];
  /**
   * Effective permission keys (base role + live custom-role assignments), computed by AuthService on every
   * authenticated request. Optional so synthetic identities (jobs, scripts) keep compiling; absent = base roles only.
   */
  permissions?: string[];
  /** Data scope per effective permission (widest grant wins), e.g. { "leave.approve": { scope: "DIRECT_REPORTS" } }. */
  scopes?: Record<string, ScopeInfo>;
  /** First-party sessions only: the session (refresh-token family) the access token belongs to, and how the user authenticated. */
  sessionId?: string;
  amr?: string[];
  /** "local" = first-party password sign-in, "oidc" = external IdP, "demo" = local demo headers. */
  authMethod?: "local" | "oidc" | "demo";
};

declare module "fastify" {
  interface FastifyRequest {
    identity?: AuthIdentity;
  }
}

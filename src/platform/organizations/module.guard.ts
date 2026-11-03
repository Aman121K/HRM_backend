import { BadRequestException, CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { RuntimeConfig } from "../config/runtime-config";
import { canonicalPath, underPrefix, UnsafePathError } from "../config/request-path";
import { brandFromHost } from "./brand-host";
import { OrganizationsService } from "./organizations.service";

/** API prefix → organization module key. Anything not listed is core and always available. */
const PREFIXES: [string, string][] = [
  ["/api/v2/payroll", "payroll"], ["/api/v2/roster", "roster"], ["/api/v2/lms", "learning"], ["/api/v2/engagement", "engagement"],
  ["/api/v2/onboarding", "onboarding"], ["/api/v2/analytics", "reports"], ["/api/v2/integrations", "integrations"], ["/api/v2/receipts", "expenses"],
  ["/api/v2/attendance", "attendance"], ["/api/v2/loans", "payroll"], ["/api/v2/performance", "performance"], ["/api/v2/leaves", "leave"], ["/api/v2/leave-types", "leave"], ["/api/v2/approvals/leaves", "leave"],
];
/** Case-engine modules → organization module key (also enforced per case in CasesService for routes addressed by id). */
export const CASE_MODULES: Record<string, string> = {
  helpdesk: "helpdesk", assets: "assets", expenses: "expenses", travel: "travel", learning: "learning", shifts: "roster", letters: "letters",
  recognition: "recognition", requisitions: "recruitment", candidates: "recruitment", exit: "exit", regularization: "attendance",
  kpi: "performance",
};

/** Whether a case-engine module is usable with the given enabled organization modules (unmapped case modules are core). */
export const caseModuleEnabled = (caseModule: string, enabled: string[]) => {
  const key = CASE_MODULES[caseModule];
  return !key || enabled.includes(key);
};

/**
 * The path used for every decision below. Prefer the route pattern the router actually matched (e.g.
 * "/api/v2/payroll/runs/:id"), which is immune to encoding tricks because find-my-way decodes before matching; fall back
 * to a canonicalised URL. Paths that hide separators or are double-encoded are rejected outright.
 */
function decisionPath(request: FastifyRequest): string {
  let canonical: string;
  try { canonical = canonicalPath(request.url); } catch (error) {
    if (error instanceof UnsafePathError) throw new BadRequestException({ message: error.message, code: "UNSAFE_PATH" });
    throw error;
  }
  const route = (request as { routeOptions?: { url?: string } }).routeOptions?.url;
  return route ? route.toLowerCase() : canonical;
}

/**
 * Blocks API calls into modules an organization hasn't enabled, and all calls into suspended organizations.
 * Runs after AuthGuard, so request.identity is set for authenticated routes.
 */
@Injectable()
export class ModuleGuard implements CanActivate {
  constructor(private readonly orgs: OrganizationsService, private readonly config: RuntimeConfig) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const identity = request.identity;
    const path = decisionPath(request);
    // A page served from <brand>.<APP_DOMAIN> may only act inside that brand. Browsers set Origin themselves, so a script on
    // got-tea.example.com cannot use a session or headers to read Blue Tokai data (the super admin console lives on the main domain).
    const hostBrand = brandFromHost(request.headers.origin, this.config.appDomain);
    const sessionRoute = underPrefix(path, "/api/v2/auth") || path === "/api/v2/orgs/mine";
    if (hostBrand && identity && !sessionRoute) {
      if (!identity.organizationId) throw new ForbiddenException({ message: "Platform administration is only available on the main domain.", code: "BRAND_HOST_MISMATCH" });
      const current = await this.orgs.moduleState(identity.organizationId);
      if (current.slug !== hostBrand) throw new ForbiddenException({ message: "This session belongs to a different brand. Sign in on that brand's own address.", code: "BRAND_HOST_MISMATCH" });
    }
    if (identity && !identity.organizationId) {
      // Platform (super admin) identities have no brand: only platform administration and session routes.
      if (identity.roles.includes("PLATFORM_ADMIN") && (underPrefix(path, "/api/v2/platform") || underPrefix(path, "/api/v2/auth"))) return true;
      throw new ForbiddenException({ message: "Open a brand to use this area.", code: "BRAND_REQUIRED" });
    }
    if (!identity?.organizationId) return true;
    const state = await this.orgs.moduleState(identity.organizationId);
    if (state.status !== "ACTIVE" && !underPrefix(path, "/api/v2/orgs") && !underPrefix(path, "/api/v2/auth"))
      throw new ForbiddenException({ message: "This organization is suspended. Contact your platform administrator.", code: "ORG_SUSPENDED" });
    let key = PREFIXES.find(([prefix]) => underPrefix(path, prefix))?.[1];
    if (!key && underPrefix(path, "/api/v2/cases")) {
      const body = request.body as { module?: string } | undefined;
      const caseModule = (request.query as { module?: string } | undefined)?.module || body?.module;
      key = typeof caseModule === "string" ? CASE_MODULES[caseModule] : undefined;
    }
    if (key && !state.modules.includes(key))
      throw new ForbiddenException({ message: `The ${key} module isn't enabled for this organization.`, code: "MODULE_DISABLED" });
    return true;
  }
}

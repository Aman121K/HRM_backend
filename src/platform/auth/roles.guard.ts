import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { ROUTE_PERMISSION_EQUIVALENTS } from "../access/route-permissions";
import { PERMISSIONS_KEY, ROLES_KEY } from "./roles.decorator";

/**
 * Coarse authorization. Order of checks:
 *  1. No @Roles / @RequirePermissions → allowed (services do row-level checks).
 *  2. @Roles and the caller's base role matches → allowed (exactly today's behaviour).
 *  3. The caller's effective permissions contain a @RequirePermissions key, or the route's permission equivalent
 *     from ROUTE_PERMISSION_EQUIVALENTS → allowed (custom roles widen access).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext) {
    const targets = [context.getHandler(), context.getClass()];
    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, targets);
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets);
    if (!roles?.length && !required?.length) return true;
    const identity = context.switchToHttp().getRequest<FastifyRequest>().identity;
    if (!identity) throw new ForbiddenException("Your organization role does not allow this action.");
    if (roles?.length && roles.some((role) => identity.roles.includes(role))) return true;
    const held = new Set(identity.permissions || []);
    const equivalent = ROUTE_PERMISSION_EQUIVALENTS[`${context.getClass().name}.${context.getHandler().name}`];
    if ((required || []).some((permission) => held.has(permission)) || (roles?.length && equivalent && held.has(equivalent))) return true;
    throw new ForbiddenException(required?.length && !roles?.length
      ? "You don't have the access this action needs. Ask an administrator to grant it."
      : "Your organization role does not allow this action.");
  }
}

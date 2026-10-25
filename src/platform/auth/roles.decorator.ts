import { SetMetadata } from "@nestjs/common";
export const ROLES_KEY = "required_roles";
/** Base-role check (unchanged). A request also passes when the caller holds the route's permission equivalent. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

export const PERMISSIONS_KEY = "required_permissions";
/**
 * Permission check: passes when the caller's effective permissions include ANY of the listed keys (base roles map to
 * permissions through the built-in role catalogue, so HR_ADMIN/OWNER pass everything). Combined with @Roles on the
 * same handler, either check passing is enough.
 */
export const RequirePermissions = (...permissions: string[]) => SetMetadata(PERMISSIONS_KEY, permissions);

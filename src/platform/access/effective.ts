import { PERMISSION_INDEX, SCOPES, scopeRank, systemRole, type Grant, type Scope } from "./permissions";

/** Where a permission comes from — the base membership role or a custom-role assignment. */
export type GrantSource =
  | { type: "BASE"; role: string; roleName: string }
  | { type: "CUSTOM"; roleId: string; roleName: string; assignmentId: string; expiresAt: string | null; department: string | null; location: string | null };
export type SourcedGrant = Grant & { source: GrantSource };
export type ScopeInfo = { scope: Scope; departments?: string[]; locations?: string[] };
export type Effective = { permissions: string[]; scopes: Record<string, ScopeInfo>; grants: SourcedGrant[] };

export type CustomAssignmentRow = {
  assignment_id: string; role_id: string; role_name: string; permissions: unknown;
  expires_at: Date | string | null; restrict_department: string | null; restrict_location: string | null;
};

/** Parses stored role permissions, dropping anything no longer in the catalogue and normalising scopes. */
export function normaliseGrants(value: unknown): Grant[] {
  if (!Array.isArray(value)) return [];
  const seen = new Map<string, Grant>();
  for (const item of value) {
    const key = typeof item?.key === "string" ? item.key : "";
    const definition = PERMISSION_INDEX.get(key);
    if (!definition) continue;
    const scope: Scope = definition.scopable && SCOPES.includes(item.scope) ? item.scope : "ORGANIZATION";
    const existing = seen.get(key);
    if (!existing || scopeRank(scope) > scopeRank(existing.scope)) seen.set(key, { key, scope });
  }
  return [...seen.values()];
}

/**
 * Union of the base role(s) and every live custom assignment. For each permission the widest scope wins; department /
 * location restrictions survive only if every grant at that widest scope is restricted (an unrestricted grant wins).
 */
export function computeEffective(baseRoles: string[], custom: CustomAssignmentRow[]): Effective {
  const grants: SourcedGrant[] = [];
  for (const role of baseRoles) {
    const system = systemRole(role);
    if (!system) continue;
    for (const grant of system.grants) grants.push({ ...grant, source: { type: "BASE", role, roleName: system.name } });
  }
  for (const row of custom) {
    const expiresAt = row.expires_at ? new Date(row.expires_at).toISOString() : null;
    for (const grant of normaliseGrants(row.permissions))
      grants.push({ ...grant, source: { type: "CUSTOM", roleId: row.role_id, roleName: row.role_name, assignmentId: row.assignment_id, expiresAt, department: row.restrict_department, location: row.restrict_location } });
  }
  const scopes: Record<string, ScopeInfo> = {};
  const byKey = new Map<string, SourcedGrant[]>();
  for (const grant of grants) byKey.set(grant.key, [...(byKey.get(grant.key) || []), grant]);
  for (const [key, list] of byKey) {
    const top = Math.max(...list.map((grant) => scopeRank(grant.scope)));
    const widest = list.filter((grant) => scopeRank(grant.scope) === top);
    const restricted = (grant: SourcedGrant) => grant.source.type === "CUSTOM" && (grant.source.department || grant.source.location);
    const info: ScopeInfo = { scope: SCOPES[top] };
    if (widest.every(restricted)) {
      const departments = [...new Set(widest.map((grant) => grant.source.type === "CUSTOM" ? grant.source.department : null).filter(Boolean) as string[])];
      const locations = [...new Set(widest.map((grant) => grant.source.type === "CUSTOM" ? grant.source.location : null).filter(Boolean) as string[])];
      if (departments.length) info.departments = departments;
      if (locations.length) info.locations = locations;
    }
    scopes[key] = info;
  }
  return { permissions: [...byKey.keys()].sort(), scopes, grants };
}

/** True when `holder` covers `grant` (same permission, at least as wide a scope). */
export const covers = (holder: Pick<Effective, "scopes">, grant: Grant) => {
  const info = holder.scopes[grant.key];
  return !!info && !info.departments && !info.locations && scopeRank(info.scope) >= scopeRank(grant.scope);
};

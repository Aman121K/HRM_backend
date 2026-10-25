-- 013: Role & permission administration — custom roles, role assignments and the per-organization access version.
-- Built-in roles (OWNER, HR_ADMIN, PAYROLL_ADMIN, MANAGER, EMPLOYEE) and the permission catalogue live in code
-- (backend/src/platform/access/permissions.ts); only organization-defined data is stored here.

CREATE TABLE IF NOT EXISTS access_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  description text NOT NULL DEFAULT '',
  -- [{ "key": "leave.approve", "scope": "DIRECT_REPORTS" }, ...] validated against the code catalogue by the API.
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(permissions) = 'array'),
  based_on text,                                   -- e.g. 'system:MANAGER' or another role id when cloned
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Role names are unique per organization (case-insensitive); also serves the roles list ordered by name.
CREATE UNIQUE INDEX IF NOT EXISTS access_roles_org_name ON access_roles (organization_id, lower(name));

CREATE TABLE IF NOT EXISTS access_role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  role_id uuid NOT NULL REFERENCES access_roles(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,                          -- temporary access; NULL = until revoked
  restrict_department text,                        -- optional: the grant only applies within this department
  restrict_location text,                          -- optional: the grant only applies within this location
  reason text,
  granted_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  revoke_reason text,
  expiry_notified_at timestamptz,
  CHECK (expires_at IS NULL OR expires_at > starts_at)
);
-- One live assignment of a role per person; also the lookup AuthService runs on every request (org + employee).
CREATE UNIQUE INDEX IF NOT EXISTS access_assignments_live ON access_role_assignments (organization_id, employee_id, role_id) WHERE revoked_at IS NULL;
-- Role detail / "who holds this role" and assignee counts on the roles list.
CREATE INDEX IF NOT EXISTS access_assignments_role ON access_role_assignments (organization_id, role_id) WHERE revoked_at IS NULL;
-- The expiry sweeper job looks for live temporary grants that have lapsed.
CREATE INDEX IF NOT EXISTS access_assignments_expiry ON access_role_assignments (expires_at) WHERE revoked_at IS NULL AND expires_at IS NOT NULL;

-- Monotonic counter bumped on every access change; AuthService caches effective permissions keyed by this version.
CREATE TABLE IF NOT EXISTS access_org_state (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Audit log viewer: newest-first pagination across the whole organization (existing indexes are per actor / per entity).
CREATE INDEX IF NOT EXISTS audit_org_recent ON audit_log (organization_id, created_at DESC, id DESC);

ALTER TABLE access_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_org_state ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['access_roles','access_role_assignments','access_org_state'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(13) ON CONFLICT DO NOTHING;

-- 026: least-privilege grants for the runtime (tenant) role on platform tables.
--
-- hrm_runtime runs every tenant transaction with RLS enforced, but platform tables (identity, brands, platform admins)
-- have no organization_id/RLS, and the blanket "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES" let tenant code
-- (or an injection in it) create platform admins, rewrite any user's email/OIDC binding (account takeover) or edit any
-- brand. Audit of backend/src/platform (2026-10-19) — writes to these tables and the pool they use:
--   organizations          UPDATE/INSERT  organizations.service (systemQuery / platformTransaction)      -> owner pool
--   organization_groups    INSERT         organizations.service createGroup (systemQuery)                -> owner pool
--   group_admins           INSERT         organizations.service createGroup (systemQuery)                -> owner pool
--   platform_admins        DELETE         compliance.service closeReview (platformTransaction)           -> owner pool
--   users                  UPDATE         auth.service OIDC binding + last_sign_in_at (own owner pool)   -> owner pool
--   users                  INSERT/UPSERT  organizations.service addMember (platformTransaction), jobs/tenant-runner (systemQuery) -> owner pool
--   users                  INSERT         onboarding.service convert (tenantTransaction)                 -> RUNTIME (kept: email, full_name)
--   organization_memberships INSERT       onboarding.service convert (tenantTransaction)                 -> RUNTIME (kept; RLS limits to own org)
--   organization_memberships UPDATE role  access.service changeBaseRole (tenantTransaction)              -> RUNTIME (kept: role, status columns)
--   organization_memberships UPDATE status compliance.service closeReview (platformTransaction)         -> owner pool
-- Reads of platform_admins / group_admins / organization_groups all go through the owner pool, so the runtime role loses
-- every privilege on them. Tenant code still reads organizations, users and memberships, so SELECT stays (users without
-- password_hash). schema_migrations, audit_log, security_events and compliance_* were already restricted (022/024).
-- Idempotent: safe to re-run.

-- Platform-only tables: no access at all from tenant context.
REVOKE ALL ON platform_admins, group_admins, organization_groups FROM hrm_runtime;

-- Brands: read-only from tenant context (settings are changed through the owner pool after role checks).
REVOKE ALL ON organizations FROM hrm_runtime;
GRANT SELECT ON organizations TO hrm_runtime;

-- Users: readable (minus the legacy password hash), insertable for onboarding conversion; never updated/deleted.
REVOKE ALL ON users FROM hrm_runtime;
GRANT SELECT (id, email, full_name, created_at, oidc_issuer, oidc_subject, last_sign_in_at) ON users TO hrm_runtime;
GRANT INSERT (email, full_name) ON users TO hrm_runtime;

-- Memberships: RLS (tenant_isolation) keeps these to the current brand; no deletes, and only role/status may change,
-- so a tenant can't re-point a membership at another user or organization.
REVOKE ALL ON organization_memberships FROM hrm_runtime;
GRANT SELECT, INSERT ON organization_memberships TO hrm_runtime;
GRANT UPDATE (role, status) ON organization_memberships TO hrm_runtime;

-- Migration bookkeeping: read-only (re-asserted).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM hrm_runtime;
GRANT SELECT ON schema_migrations TO hrm_runtime;

-- Audit trail: append-only for the runtime role (re-asserted here so a fresh install matches; previously only
-- backend/db/runtime-role.sql revoked it, which ran outside the migration set).
REVOKE UPDATE, DELETE ON audit_log FROM hrm_runtime;

-- Never TRUNCATE/TRIGGER/REFERENCES anywhere (defence in depth; the default privileges never granted them).
REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM hrm_runtime;

INSERT INTO schema_migrations(version) VALUES(26) ON CONFLICT DO NOTHING;

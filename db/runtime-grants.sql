-- Runtime-role bootstrap grants, applied by scripts/migrate.mjs as the database owner (hrm_app) BEFORE pending
-- migrations run. Idempotent; needs no superuser (the owner of the database also owns schema public via
-- pg_database_owner on Postgres 15+). Requires the hrm_runtime role to exist (db/runtime-role.sql).
--
-- Default privileges give every table/sequence a migration creates SELECT/INSERT/UPDATE/DELETE (resp. USAGE/SELECT)
-- for hrm_runtime at CREATE time; later migrations then revoke what tenant code must not touch (022, 024, 026, 030),
-- so applying migrations in order on a fresh database reproduces the exact grant set of a long-lived one.
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO hrm_runtime', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO hrm_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hrm_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hrm_runtime;

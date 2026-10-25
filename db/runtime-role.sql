-- Step 1 of a database install (DBA / RDS master user, once per Postgres cluster). Idempotent.
--
-- Creates the least-privilege runtime role the API uses for tenant queries (DATABASE_URL_RUNTIME = hrm_runtime). It owns
-- no tables and cannot bypass RLS, so every tenant table's tenant_isolation policy is enforced by Postgres itself. The
-- owner role (hrm_app, DATABASE_URL) owns the database and runs migrations plus the few deliberate cross-tenant paths.
--
-- Plain SQL, no psql variables, so it can be run either way:
--   psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 -f db/runtime-role.sql
--   psql "$DATABASE_ADMIN_URL" -c "ALTER ROLE hrm_runtime PASSWORD '<strong secret>'"      (or \password hrm_runtime)
-- or automatically: DATABASE_ADMIN_URL=... RUNTIME_DB_PASSWORD=... npm run db:migrate
-- (scripts/migrate.mjs runs this file through the admin connection and sets the password with a bound literal).
--
-- Step 2 — grants — needs no DBA: migrate.mjs applies db/runtime-grants.sql as the database owner before every
-- migration run (CONNECT, schema USAGE, default privileges), and the migrations themselves revoke what tenant code must
-- not touch (022, 024, 026, 030). Do NOT blanket-GRANT ON ALL TABLES afterwards: that would undo those revokes.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrm_runtime') THEN
    CREATE ROLE hrm_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
END $$;
ALTER ROLE hrm_runtime WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
ALTER ROLE hrm_runtime SET statement_timeout = '15s';

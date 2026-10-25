-- Background jobs (BullMQ worker): per-tenant run history, an idempotency ledger for automated
-- notifications, and the system identity that automation writes audit rows as.

-- The automation actor. audit_log.actor_user_id is NOT NULL, so rows written by the worker use this user.
-- It has no password, no organization membership (so it can never sign in or pass a role check) and a
-- pre-bound OIDC identity under a private issuer, so no real identity provider can ever link to it.
INSERT INTO users(id,email,full_name,oidc_issuer,oidc_subject)
VALUES('00000000-0000-4000-8000-000000000001','system@northstar.invalid','Northstar Automation','urn:northstar:system','automation')
ON CONFLICT (email) DO NOTHING;

-- One row per (tenant, job execution). Written by the worker after each tenant finishes; read by the jobs console.
CREATE TABLE IF NOT EXISTS job_runs(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 job_name text NOT NULL CHECK(job_name ~ '^[a-z][a-z0-9_.-]{1,79}$'), bull_job_id text,
 trigger text NOT NULL CHECK(trigger IN ('SCHEDULE','MANUAL','QUEUED')),
 status text NOT NULL CHECK(status IN ('SUCCEEDED','FAILED','SKIPPED')),
 started_at timestamptz NOT NULL, finished_at timestamptz NOT NULL DEFAULT now(), duration_ms integer NOT NULL DEFAULT 0,
 result jsonb NOT NULL DEFAULT '{}', error text CHECK(error IS NULL OR length(error) <= 2000)
);
-- Console: "last run" per job and the recent-runs list for one tenant.
CREATE INDEX IF NOT EXISTS job_runs_recent ON job_runs(organization_id,job_name,started_at DESC);

-- Idempotency ledger: a reminder is only sent when its dedupe key is inserted for the first time, in the same
-- transaction as the notification/email it guards, so re-runs and parallel workers never send twice.
CREATE TABLE IF NOT EXISTS job_dispatch_log(
 organization_id uuid NOT NULL REFERENCES organizations(id), dedupe_key text NOT NULL CHECK(length(dedupe_key) BETWEEN 3 AND 300),
 job_name text NOT NULL, recipient_employee_id uuid, entity_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,dedupe_key)
);
-- Housekeeping purges old ledger rows by age.
CREATE INDEX IF NOT EXISTS job_dispatch_log_age ON job_dispatch_log(organization_id,created_at);

-- Email delivery: the dispatcher claims due rows; the console lists a tenant's newest messages.
CREATE INDEX IF NOT EXISTS email_outbox_recent ON email_outbox(organization_id,created_at DESC);
-- Housekeeping: expiring old notifications scans by age per tenant.
CREATE INDEX IF NOT EXISTS workflow_events_age ON workflow_events(organization_id,created_at);
-- Housekeeping: soft-deleted files past the retention window.
CREATE INDEX IF NOT EXISTS stored_files_purge ON stored_files(organization_id,deleted_at) WHERE deleted_at IS NOT NULL;

ALTER TABLE job_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_dispatch_log ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['job_runs','job_dispatch_log'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(15) ON CONFLICT DO NOTHING;

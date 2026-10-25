-- DPDP Act 2023 / DPDP Rules 2025: data-principal rights, brand privacy settings, retention & erasure, breach register,
-- customer exit (brand export + closure). Idempotent.
--
-- Brand tables (RLS ENABLE + FORCE + tenant_isolation): privacy_settings, privacy_exports, privacy_subject_state,
-- privacy_erasure_runs. Platform tables (no tenant, revoked from hrm_runtime, only the platform API on the owner role):
-- privacy_breaches, privacy_brand_exports, privacy_brand_closures.

-- 1. Brand privacy settings: grievance officer / DPO contact and retention periods per data category ------------------
CREATE TABLE IF NOT EXISTS privacy_settings(
 organization_id uuid PRIMARY KEY REFERENCES organizations(id),
 grievance_name text, grievance_email text, grievance_phone text, grievance_address text,
 significant_fiduciary boolean NOT NULL DEFAULT false,
 dpo_name text, dpo_email text, dpo_phone text,
 -- { "documents": 1, "attendanceDetail": 1, "contact": 1, "casesAndLeave": 3, "payrollTax": 8 } (years after exit)
 retention jsonb NOT NULL DEFAULT '{}'::jsonb,
 auto_erase boolean NOT NULL DEFAULT false,         -- false: the nightly run only prepares a dry-run report for HR
 version integer NOT NULL DEFAULT 1,
 updated_by uuid,                                   -- users.id
 updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Employee "Download my data" exports (files live in stored_files, entity_type='privacy_export') -------------------
CREATE TABLE IF NOT EXISTS privacy_exports(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 employee_id uuid NOT NULL REFERENCES employees(id),
 requested_by uuid NOT NULL,                        -- users.id
 status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','READY','FAILED','EXPIRED')),
 summary jsonb NOT NULL DEFAULT '{}'::jsonb,        -- section → row counts (no personal data)
 error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 expires_at timestamptz,
 purged_at timestamptz
);
CREATE INDEX IF NOT EXISTS privacy_exports_employee ON privacy_exports(organization_id, employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS privacy_exports_expiry ON privacy_exports(organization_id, expires_at) WHERE purged_at IS NULL;

-- 3. Per-person retention state: legal hold and which categories have been erased --------------------------------------
CREATE TABLE IF NOT EXISTS privacy_subject_state(
 organization_id uuid NOT NULL REFERENCES organizations(id),
 employee_id uuid NOT NULL REFERENCES employees(id),
 legal_hold boolean NOT NULL DEFAULT false,
 legal_hold_reason text,
 legal_hold_by uuid, legal_hold_at timestamptz,
 exited_on date,                                    -- first seen as exited (exit case last day, else the day it was noticed)
 erased jsonb NOT NULL DEFAULT '{}'::jsonb,         -- category → ISO timestamp when erased
 anonymised_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (organization_id, employee_id)
);
ALTER TABLE privacy_subject_state ADD COLUMN IF NOT EXISTS exited_on date;
-- Sign-in account to detach after the erasure transaction commits (memberships/users are platform tables).
ALTER TABLE privacy_subject_state ADD COLUMN IF NOT EXISTS pending_account_user uuid;

-- 4. Erasure runs: dry-run reports and executed runs (the certificate digest is also written to audit_log) -----------
CREATE TABLE IF NOT EXISTS privacy_erasure_runs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 mode text NOT NULL CHECK (mode IN ('DRY_RUN','EXECUTE')),
 trigger text NOT NULL CHECK (trigger IN ('SCHEDULE','MANUAL','REQUEST')),
 case_id uuid,                                      -- hr_cases.id for erasure requests
 employee_id uuid,                                  -- set for a single-person (request) run
 report jsonb NOT NULL DEFAULT '{}'::jsonb,
 report_sha256 text,
 created_by uuid,                                   -- users.id
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS privacy_erasure_runs_recent ON privacy_erasure_runs(organization_id, created_at DESC);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['privacy_settings','privacy_exports','privacy_subject_state','privacy_erasure_runs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)', t);
 END LOOP;
END $$;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hrm_runtime') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON privacy_settings, privacy_exports, privacy_subject_state, privacy_erasure_runs TO hrm_runtime;
 END IF;
END $$;

-- 5. Breach register (platform scope; brand owners see their own brand's incidents through the platform API) ----------
CREATE TABLE IF NOT EXISTS privacy_breaches(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 reference text NOT NULL UNIQUE,                    -- BR-2026-0001
 organization_id uuid REFERENCES organizations(id), -- NULL = platform-wide incident (several or all brands)
 title text NOT NULL,
 nature text NOT NULL,                              -- what happened
 severity text NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
 status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONTAINED','CLOSED')),
 detected_at timestamptz NOT NULL,
 occurred_at timestamptz,
 data_categories text[] NOT NULL DEFAULT '{}',
 affected_count integer,
 affected_description text,
 likely_consequences text,
 containment text,
 mitigation text,
 cert_in_reportable boolean NOT NULL DEFAULT true,
 board_notified_at timestamptz,                     -- Data Protection Board: intimation without delay
 board_report_at timestamptz,                       -- Data Protection Board: detailed report (72 h)
 cert_in_notified_at timestamptz,                   -- CERT-In: 6 h
 principals_notified_at timestamptz,                -- affected data principals: without delay
 fiduciaries_notified_at timestamptz,               -- client companies (processor → fiduciary)
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),
 version integer NOT NULL DEFAULT 1
);
-- Change history (who changed what, when). Brand incidents are also written to that brand's audit_log; platform-wide
-- incidents have no brand, so this column is their trail.
ALTER TABLE privacy_breaches ADD COLUMN IF NOT EXISTS history jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS privacy_breaches_org ON privacy_breaches(organization_id, detected_at DESC);

-- 6. Customer exit: whole-brand export and two-person-confirmed closure ----------------------------------------------
CREATE TABLE IF NOT EXISTS privacy_brand_exports(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','READY','FAILED','EXPIRED')),
 reason text,
 manifest jsonb NOT NULL DEFAULT '{}'::jsonb,       -- files: [{ name, key, driver, bytes, sha256, rows }]
 error text,
 requested_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 expires_at timestamptz,
 purged_at timestamptz
);
CREATE INDEX IF NOT EXISTS privacy_brand_exports_org ON privacy_brand_exports(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS privacy_brand_closures(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 status text NOT NULL DEFAULT 'PENDING_CONFIRMATION' CHECK (status IN ('PENDING_CONFIRMATION','SCHEDULED','CANCELLED','DELETING','DELETED','FAILED')),
 reason text NOT NULL,
 grace_days integer NOT NULL CHECK (grace_days BETWEEN 0 AND 180),
 previous_status text,
 requested_by uuid NOT NULL, requested_at timestamptz NOT NULL DEFAULT now(),
 confirmed_by uuid, confirmed_at timestamptz,
 cancelled_by uuid, cancelled_at timestamptz,
 delete_after timestamptz,
 export_id uuid REFERENCES privacy_brand_exports(id),
 deleted_at timestamptz,
 certificate jsonb,
 error text,
 CHECK (confirmed_by IS NULL OR confirmed_by <> requested_by)
);
-- One live closure per brand.
CREATE UNIQUE INDEX IF NOT EXISTS privacy_brand_closures_live ON privacy_brand_closures(organization_id)
 WHERE status IN ('PENDING_CONFIRMATION','SCHEDULED','DELETING');

REVOKE ALL ON privacy_breaches, privacy_brand_exports, privacy_brand_closures FROM hrm_runtime;

-- 7. Employee privacy notice, acknowledged through the existing policy-acceptance flow (compliance_policies) ----------
INSERT INTO compliance_policies(key, version, title, summary, body)
SELECT 'employee-privacy-notice', 1, 'Employee privacy notice',
 'How your employer uses your personal data in Northstar, how long it is kept, and how to exercise your rights.',
 E'This notice is given under the Digital Personal Data Protection Act, 2023.\n\n1. Who is responsible\nYour employer (the company that employs you) is the Data Fiduciary for your personal data. Northstar operates this platform for your employer as a Data Processor and uses your data only on your employer''s instructions.\n\n2. What we hold\nIdentity and contact details, employment details, attendance (including punch location and, if your employer enables it, a punch selfie), leave, payroll and tax details (PAN, UAN, ESI and bank account are stored encrypted), documents you upload, requests you raise, and security logs of who opened your record.\n\n3. Why\nTo run your employment: attendance, leave, pay, statutory deductions and filings, benefits, safety and security. Most processing relies on the legitimate use for employment purposes under section 7(i) of the Act; anything optional asks for your consent separately.\n\n4. Who sees it\nYour manager and authorised HR and payroll staff, each only as their role needs, and service providers listed at /legal/subprocessors. Every view of sensitive data is logged.\n\n5. How long\nWhile you work here, and after you leave only as long as the law or your employer''s retention schedule requires (payroll and tax records typically 8 years). Then it is erased or anonymised.\n\n6. Your rights\nIn My space → My data & privacy you can download a copy of your data, ask for corrections or erasure, nominate someone to act for you, and raise a grievance. We respond within the period set by the DPDP Rules (no later than 90 days). If you are not satisfied, you may complain to the Data Protection Board of India.\n\n7. Contact\nYour employer''s grievance officer is shown on the My data & privacy page.'
WHERE NOT EXISTS (SELECT 1 FROM compliance_policies WHERE key='employee-privacy-notice');

INSERT INTO schema_migrations(version) VALUES(36) ON CONFLICT DO NOTHING;

-- Risk & Compliance Center (backend/src/platform/risk): detector signals with a lifecycle, their history, per-organization
-- thresholds, the (example) minimum-wage table and manual "filed" marks for statutory obligations.

-- One row per detector + subject (e.g. "attendance.shared_device" + "device:date"); scans upsert by that key.
CREATE TABLE IF NOT EXISTS risk_signals(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 detector text NOT NULL CHECK (length(detector) BETWEEN 3 AND 80),
 area text NOT NULL CHECK (area IN ('compliance','attendance','labour','payroll','expenses','people','service')),
 subject_key text NOT NULL CHECK (length(subject_key) BETWEEN 1 AND 300),
 severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
 status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED','DISMISSED')),
 title text NOT NULL CHECK (length(title) <= 300),
 explanation text NOT NULL,
 evidence jsonb NOT NULL DEFAULT '{}',
 employee_ids uuid[] NOT NULL DEFAULT '{}',
 records jsonb NOT NULL DEFAULT '[]',
 action jsonb NOT NULL DEFAULT '{}',
 -- Who besides HR admins/owners may see it: PAYROLL (payroll admins), MANAGER (direct managers of employee_ids).
 audiences text[] NOT NULL DEFAULT '{}',
 due_date date,
 -- Hash of the material evidence now, and at the moment a person resolved/dismissed it (NULL when closed automatically).
 fingerprint text NOT NULL,
 status_fingerprint text,
 status_note text,
 status_by uuid REFERENCES users(id),
 status_at timestamptz,
 first_detected_at timestamptz NOT NULL DEFAULT now(),
 last_detected_at timestamptz NOT NULL DEFAULT now(),
 -- Set when a scan no longer finds the condition but the detector does not auto-resolve (historic evidence).
 cleared_at timestamptz,
 detections integer NOT NULL DEFAULT 1,
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (organization_id, detector, subject_key)
);
-- Lists: by status/area/severity, newest first.
CREATE INDEX IF NOT EXISTS risk_signals_list ON risk_signals(organization_id, status, area, severity, last_detected_at DESC);
-- Manager scope: signals touching any of my direct reports.
CREATE INDEX IF NOT EXISTS risk_signals_people ON risk_signals USING gin (employee_ids);

CREATE TABLE IF NOT EXISTS risk_signal_events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 signal_id uuid NOT NULL REFERENCES risk_signals(id) ON DELETE CASCADE,
 actor_user_id uuid REFERENCES users(id),
 action text NOT NULL CHECK (action IN ('DETECTED','ESCALATED','ACKNOWLEDGED','RESOLVED','DISMISSED','REOPENED','AUTO_RESOLVED','CLEARED')),
 from_status text, to_status text, note text, data jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS risk_signal_events_signal ON risk_signal_events(organization_id, signal_id, created_at);

CREATE TABLE IF NOT EXISTS risk_settings(
 organization_id uuid PRIMARY KEY REFERENCES organizations(id),
 thresholds jsonb NOT NULL DEFAULT '{}',
 last_scan_at timestamptz, last_scan_result jsonb,
 version integer NOT NULL DEFAULT 1,
 updated_by uuid REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);

-- Minimum wages per state and skill category. Rows are seeded lazily per organization with is_example = true values that
-- are NOT current law and must be replaced from the applicable state notification.
CREATE TABLE IF NOT EXISTS risk_minimum_wages(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 state_code text NOT NULL CHECK (state_code ~ '^[A-Z]{2}$'),
 category text NOT NULL CHECK (category IN ('UNSKILLED','SEMI_SKILLED','SKILLED','HIGHLY_SKILLED')),
 monthly_amount numeric(12,2) NOT NULL CHECK (monthly_amount > 0),
 effective_from date NOT NULL,
 is_example boolean NOT NULL DEFAULT false,
 note text,
 updated_by uuid REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (organization_id, state_code, category, effective_from)
);

-- "Filed" marks for compliance-calendar obligations (key e.g. PF:2026-08, PT:KA:2026-08, 24Q:2026-27:Q1).
CREATE TABLE IF NOT EXISTS risk_compliance_marks(
 organization_id uuid NOT NULL REFERENCES organizations(id),
 obligation_key text NOT NULL CHECK (length(obligation_key) BETWEEN 3 AND 60),
 status text NOT NULL DEFAULT 'FILED' CHECK (status IN ('FILED')),
 reference text CHECK (reference IS NULL OR length(reference) <= 120),
 note text CHECK (note IS NULL OR length(note) <= 500),
 marked_by uuid REFERENCES users(id),
 marked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (organization_id, obligation_key)
);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['risk_signals','risk_signal_events','risk_settings','risk_minimum_wages','risk_compliance_marks'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)', t);
 END LOOP;
END $$;

INSERT INTO schema_migrations(version) VALUES(20) ON CONFLICT DO NOTHING;

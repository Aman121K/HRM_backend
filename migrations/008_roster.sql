-- Shift roster planner: shift templates, per-day assignments, weekly publication snapshots and rule settings.
-- Rules (rest gap, weekly hours, weekly off, coverage, leave conflicts) are computed in backend/src/platform/roster/roster.service.ts.

CREATE TABLE IF NOT EXISTS roster_settings(
 organization_id uuid PRIMARY KEY REFERENCES organizations(id),
 min_rest_hours numeric(4,1) NOT NULL DEFAULT 11 CHECK(min_rest_hours BETWEEN 0 AND 24),
 max_weekly_hours numeric(5,1) NOT NULL DEFAULT 48 CHECK(max_weekly_hours BETWEEN 1 AND 120),
 max_consecutive_days integer NOT NULL DEFAULT 6 CHECK(max_consecutive_days BETWEEN 1 AND 13),
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roster_shift_templates(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 code text NOT NULL CHECK(code ~ '^[A-Z0-9]{1,6}$'), name text NOT NULL CHECK(length(name) BETWEEN 2 AND 60),
 start_time time NOT NULL, end_time time NOT NULL, break_minutes integer NOT NULL DEFAULT 0 CHECK(break_minutes BETWEEN 0 AND 240),
 color text NOT NULL DEFAULT '#0b615c' CHECK(color ~ '^#[0-9a-fA-F]{6}$'),
 min_headcount integer NOT NULL DEFAULT 0 CHECK(min_headcount BETWEEN 0 AND 500),
 is_active boolean NOT NULL DEFAULT true, sort_order integer NOT NULL DEFAULT 0,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(start_time <> end_time),
 UNIQUE(organization_id,code)
);

CREATE TABLE IF NOT EXISTS roster_assignments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 employee_id uuid NOT NULL REFERENCES employees(id), work_date date NOT NULL,
 kind text NOT NULL CHECK(kind IN ('SHIFT','WEEKLY_OFF')), template_id uuid REFERENCES roster_shift_templates(id),
 location text CHECK(location IS NULL OR length(location) <= 120), note text CHECK(note IS NULL OR length(note) <= 300),
 source text NOT NULL DEFAULT 'MANUAL' CHECK(source IN ('MANUAL','COPY','PATTERN','SHIFT_REQUEST')), source_case_id uuid REFERENCES hr_cases(id),
 created_by uuid NOT NULL REFERENCES employees(id), updated_by uuid NOT NULL REFERENCES employees(id),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='SHIFT') = (template_id IS NOT NULL)),
 UNIQUE(organization_id,employee_id,work_date)
);
-- The unique constraint above serves the planner's week read (employee_id = ANY(...) AND work_date BETWEEN ...).
-- Coverage and "who is working today" across the organization.
CREATE INDEX IF NOT EXISTS roster_assignments_by_day ON roster_assignments(organization_id,work_date,template_id);
-- "Apply to roster" status for approved shift-change requests.
CREATE INDEX IF NOT EXISTS roster_assignments_by_case ON roster_assignments(organization_id,source_case_id) WHERE source_case_id IS NOT NULL;

-- What an employee was last told: a snapshot of their week at publish time. Live assignments are diffed against it
-- to show "changed since publish", and employees only ever see the snapshot (never unpublished drafts).
CREATE TABLE IF NOT EXISTS roster_publications(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 employee_id uuid NOT NULL REFERENCES employees(id), week_start date NOT NULL CHECK(extract(isodow FROM week_start) = 1),
 snapshot jsonb NOT NULL DEFAULT '[]', published_by uuid NOT NULL REFERENCES employees(id), published_at timestamptz NOT NULL DEFAULT now(),
 revision integer NOT NULL DEFAULT 1,
 UNIQUE(organization_id,employee_id,week_start)
);
-- The unique constraint serves both the planner (employee_id = ANY, week_start) and "My roster" (employee_id, week_start).

ALTER TABLE roster_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE roster_shift_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE roster_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE roster_publications ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['roster_settings','roster_shift_templates','roster_assignments','roster_publications'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(8) ON CONFLICT DO NOTHING;

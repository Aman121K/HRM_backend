CREATE TABLE IF NOT EXISTS employee_import_jobs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  created_by uuid NOT NULL REFERENCES users(id), status text NOT NULL CHECK(status IN ('REVIEWED','COMMITTED','FAILED')),
  file_name text NOT NULL, total_rows integer NOT NULL, valid_rows integer NOT NULL, invalid_rows integer NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}', committed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_jobs_org_recent ON employee_import_jobs(organization_id,created_at DESC,id);

ALTER TABLE employees ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS attendance_regularizations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 employee_id uuid NOT NULL REFERENCES employees(id), approver_id uuid NOT NULL REFERENCES employees(id), attendance_date date NOT NULL,
 expected_in time, expected_out time, reason text NOT NULL, note text, evidence jsonb,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','CHANGES_REQUESTED')),
 decision_note text, submitted_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS regularization_manager_queue ON attendance_regularizations(organization_id,approver_id,status,submitted_at,id);
CREATE INDEX IF NOT EXISTS regularization_employee_history ON attendance_regularizations(organization_id,employee_id,attendance_date DESC,id);

CREATE TABLE IF NOT EXISTS kpis(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id), employee_id uuid NOT NULL REFERENCES employees(id),
 manager_id uuid NOT NULL REFERENCES employees(id), period text NOT NULL, title text NOT NULL, metric text NOT NULL, target numeric(14,2) NOT NULL,
 actual numeric(14,2) NOT NULL DEFAULT 0, weight numeric(5,2) NOT NULL CHECK(weight>0 AND weight<=100),
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PENDING','APPROVED','REJECTED','CHANGES_REQUESTED')),
 employee_note text, manager_note text, submitted_at timestamptz, decided_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kpi_manager_queue ON kpis(organization_id,manager_id,status,submitted_at,id);
CREATE INDEX IF NOT EXISTS kpi_employee_period ON kpis(organization_id,employee_id,period,status,id);

CREATE TABLE IF NOT EXISTS payslips(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id), employee_id uuid NOT NULL REFERENCES employees(id),
 period text NOT NULL, gross numeric(14,2) NOT NULL, deductions numeric(14,2) NOT NULL, net numeric(14,2) NOT NULL, currency char(3) NOT NULL DEFAULT 'INR',
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PUBLISHED')), published_at timestamptz, storage_reference text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,employee_id,period)
);
CREATE INDEX IF NOT EXISTS payslip_employee_published ON payslips(organization_id,employee_id,status,period DESC,id);
CREATE INDEX IF NOT EXISTS payslip_period_admin ON payslips(organization_id,period,status,employee_id);

ALTER TABLE employee_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_regularizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kpis ENABLE ROW LEVEL SECURITY;
ALTER TABLE payslips ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['employee_import_jobs','attendance_regularizations','kpis','payslips'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;

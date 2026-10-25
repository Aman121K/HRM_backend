-- 034: Switch-over import — opening data for brands moving to Northstar mid financial year.
-- Import batches (idempotent by batch key, undoable through a change log), employee master extension, leave balance
-- ledger (opening balances), payroll year-to-date opening figures (+ optional month-wise history) and cut-over settings.
-- Every table is tenant data: RLS ENABLE + FORCE with the tenant_isolation policy. Idempotent.

CREATE TABLE IF NOT EXISTS import_batches(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('EMPLOYEE_MASTER','SALARY','LEAVE_OPENING','PAYROLL_YTD','PAYSLIPS')),
  batch_key text NOT NULL CHECK (length(batch_key) BETWEEN 8 AND 128),
  content_sha256 text NOT NULL,
  file_name text CHECK (file_name IS NULL OR length(file_name) <= 200),
  status text NOT NULL DEFAULT 'COMMITTED' CHECK (status IN ('COMMITTED','UNDONE')),
  total_rows integer NOT NULL DEFAULT 0,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_by uuid REFERENCES employees(id),
  undone_at timestamptz,
  undo_reason text CHECK (undo_reason IS NULL OR length(undo_reason) <= 500)
);
-- Re-importing the same batch key is a no-op while the batch is committed; after an undo it can be imported again.
CREATE UNIQUE INDEX IF NOT EXISTS import_batches_key ON import_batches(organization_id, kind, batch_key) WHERE status='COMMITTED';
CREATE INDEX IF NOT EXISTS import_batches_recent ON import_batches(organization_id, kind, created_at DESC);

-- Undo log: one row per record a batch inserted or updated. before_data/after_data hold column values only
-- (identifier columns are the *_enc ciphertext / *_hash / *_last4 — never plaintext).
CREATE TABLE IF NOT EXISTS import_batch_changes(
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  batch_id uuid NOT NULL REFERENCES import_batches(id),
  seq integer NOT NULL,
  table_name text NOT NULL CHECK (table_name IN ('employees','payroll_profiles','employee_master_details','salary_structures','leave_balance_ledger','payroll_ytd_opening','payroll_ytd_monthly','stored_files')),
  action text NOT NULL CHECK (action IN ('INSERT','UPDATE')),
  record_key jsonb NOT NULL,
  employee_id uuid REFERENCES employees(id),
  before_data jsonb,
  after_data jsonb,
  UNIQUE(batch_id, seq)
);
CREATE INDEX IF NOT EXISTS import_batch_changes_batch ON import_batch_changes(organization_id, batch_id, seq);

-- Employee master fields that are not on the employees register.
CREATE TABLE IF NOT EXISTS employee_master_details(
  organization_id uuid NOT NULL REFERENCES organizations(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  date_of_birth date,
  gender text CHECK (gender IS NULL OR gender IN ('MALE','FEMALE','OTHER','UNDISCLOSED')),
  employment_type text CHECK (employment_type IS NULL OR employment_type IN ('FULL_TIME','PART_TIME','CONTRACT','INTERN','CONSULTANT')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, employee_id)
);

-- Leave balance ledger. Balance of a type = sum(days) of OPENING/ADJUSTMENT entries − leave approved after as_of.
-- TAKEN_BEFORE_CUTOVER is informational (already netted in the opening balance) and is not summed into the balance.
CREATE TABLE IF NOT EXISTS leave_balance_ledger(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  leave_type_id uuid NOT NULL REFERENCES leave_types(id),
  entry_type text NOT NULL CHECK (entry_type IN ('OPENING','ADJUSTMENT','TAKEN_BEFORE_CUTOVER')),
  days numeric(7,2) NOT NULL CHECK (days BETWEEN -999 AND 999),
  as_of date NOT NULL,
  note text CHECK (note IS NULL OR length(note) <= 300),
  batch_id uuid REFERENCES import_batches(id),
  created_by uuid NOT NULL REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leave_balance_ledger_employee ON leave_balance_ledger(organization_id, employee_id, leave_type_id, as_of);
-- One opening balance per employee and leave type.
CREATE UNIQUE INDEX IF NOT EXISTS leave_balance_ledger_one_opening ON leave_balance_ledger(organization_id, employee_id, leave_type_id) WHERE entry_type='OPENING';

-- Payroll year-to-date paid by the previous system, per employee per FY, up to last_paid_period (inclusive).
-- Contract for payroll runs (TDS projection) and statutory returns (Form 16 / 24Q): see backend/src/platform/imports/ytd.shared.ts.
CREATE TABLE IF NOT EXISTS payroll_ytd_opening(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  fiscal_year text NOT NULL CHECK (fiscal_year ~ '^\d{4}-\d{2}$'),
  from_period text NOT NULL CHECK (from_period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  last_paid_period text NOT NULL CHECK (last_paid_period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  months integer NOT NULL CHECK (months BETWEEN 1 AND 12),
  gross numeric(14,2) NOT NULL DEFAULT 0, basic numeric(14,2) NOT NULL DEFAULT 0, hra numeric(14,2) NOT NULL DEFAULT 0,
  other_taxable numeric(14,2) NOT NULL DEFAULT 0, exempt_allowances numeric(14,2) NOT NULL DEFAULT 0, taxable numeric(14,2) NOT NULL DEFAULT 0,
  pf_employee numeric(14,2) NOT NULL DEFAULT 0, pf_employer numeric(14,2) NOT NULL DEFAULT 0, vpf numeric(14,2) NOT NULL DEFAULT 0,
  esi_employee numeric(14,2) NOT NULL DEFAULT 0, pt numeric(14,2) NOT NULL DEFAULT 0, tds numeric(14,2) NOT NULL DEFAULT 0,
  batch_id uuid NOT NULL REFERENCES import_batches(id),
  created_by uuid NOT NULL REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (gross >= 0 AND basic >= 0 AND hra >= 0 AND other_taxable >= 0 AND exempt_allowances >= 0 AND taxable >= 0
     AND pf_employee >= 0 AND pf_employer >= 0 AND vpf >= 0 AND esi_employee >= 0 AND pt >= 0 AND tds >= 0),
  UNIQUE(organization_id, employee_id, fiscal_year)
);

-- Optional month-wise history from the previous system (stored as given, never recomputed).
CREATE TABLE IF NOT EXISTS payroll_ytd_monthly(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  fiscal_year text NOT NULL,
  period text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  gross numeric(14,2) NOT NULL DEFAULT 0, basic numeric(14,2) NOT NULL DEFAULT 0, hra numeric(14,2) NOT NULL DEFAULT 0,
  other_taxable numeric(14,2) NOT NULL DEFAULT 0, exempt_allowances numeric(14,2) NOT NULL DEFAULT 0,
  pf_employee numeric(14,2) NOT NULL DEFAULT 0, pf_employer numeric(14,2) NOT NULL DEFAULT 0, vpf numeric(14,2) NOT NULL DEFAULT 0,
  esi_employee numeric(14,2) NOT NULL DEFAULT 0, pt numeric(14,2) NOT NULL DEFAULT 0, tds numeric(14,2) NOT NULL DEFAULT 0,
  batch_id uuid NOT NULL REFERENCES import_batches(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, employee_id, period)
);

-- Cut-over settings and the previous system's control totals for the reconciliation report.
CREATE TABLE IF NOT EXISTS switchover_settings(
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  cutover_date date,
  fiscal_year text CHECK (fiscal_year IS NULL OR fiscal_year ~ '^\d{4}-\d{2}$'),
  last_paid_period text CHECK (last_paid_period IS NULL OR last_paid_period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  source_system text CHECK (source_system IS NULL OR length(source_system) <= 80),
  control_totals jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(control_totals)='object'),
  version integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES employees(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['import_batches','import_batch_changes','employee_master_details','leave_balance_ledger','payroll_ytd_opening','payroll_ytd_monthly','switchover_settings'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)', t);
 END LOOP;
END $$;

-- Runtime role (default privileges normally cover this; explicit for databases created before 026).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hrm_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON import_batches, import_batch_changes, employee_master_details, leave_balance_ledger, payroll_ytd_opening, payroll_ytd_monthly, switchover_settings TO hrm_runtime;
    GRANT USAGE, SELECT ON SEQUENCE import_batch_changes_id_seq TO hrm_runtime;
  END IF;
END $$;

INSERT INTO schema_migrations(version) VALUES(34) ON CONFLICT DO NOTHING;

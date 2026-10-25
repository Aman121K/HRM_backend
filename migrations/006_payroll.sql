-- India payroll engine: effective-dated salary structures, employee payroll profiles, org settings,
-- payroll runs (DRAFT → CALCULATED → SUBMITTED → APPROVED → PUBLISHED → LOCKED, or CANCELLED),
-- per-employee run lines with a full breakdown, and per-run one-time inputs.
-- Statutory rules live in code (backend/src/platform/payroll/statutory.ts) and are versioned there;
-- each run and structure records the rule-set version it was calculated with.
-- All money columns hold whole rupees (components are rounded to the rupee when computed).

CREATE TABLE IF NOT EXISTS payroll_settings(
 organization_id uuid PRIMARY KEY REFERENCES organizations(id),
 pf_wage_mode text NOT NULL DEFAULT 'CEILING' CHECK(pf_wage_mode IN ('CEILING','ACTUAL')),
 default_state text NOT NULL DEFAULT 'KA' CHECK(default_state ~ '^[A-Z]{2,5}$'),
 include_expenses boolean NOT NULL DEFAULT true,
 pf_establishment_code text CHECK(pf_establishment_code IS NULL OR length(pf_establishment_code) <= 30),
 esi_employer_code text CHECK(esi_employer_code IS NULL OR length(esi_employer_code) <= 30),
 debit_account text CHECK(debit_account IS NULL OR debit_account ~ '^[0-9]{6,20}$'),
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payroll_profiles(
 organization_id uuid NOT NULL REFERENCES organizations(id), employee_id uuid NOT NULL REFERENCES employees(id),
 state_code text CHECK(state_code IS NULL OR state_code ~ '^[A-Z]{2,5}$'),
 tax_regime text NOT NULL DEFAULT 'NEW' CHECK(tax_regime IN ('NEW','OLD')),
 pan text CHECK(pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
 uan text CHECK(uan IS NULL OR uan ~ '^[0-9]{12}$'),
 esi_number text CHECK(esi_number IS NULL OR esi_number ~ '^[0-9]{10,17}$'),
 bank_name text CHECK(bank_name IS NULL OR length(bank_name) <= 80),
 bank_account text CHECK(bank_account IS NULL OR bank_account ~ '^[0-9]{6,20}$'),
 ifsc text CHECK(ifsc IS NULL OR ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
 pf_applicable boolean NOT NULL DEFAULT true,
 pt_category text NOT NULL DEFAULT 'STANDARD' CHECK(pt_category IN ('STANDARD','WOMAN','EXEMPT')),
 declarations jsonb NOT NULL DEFAULT '{}',
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id, employee_id)
);

CREATE TABLE IF NOT EXISTS salary_structures(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 employee_id uuid NOT NULL REFERENCES employees(id), effective_from date NOT NULL,
 annual_ctc numeric(14,2) NOT NULL CHECK(annual_ctc > 0), is_metro boolean NOT NULL DEFAULT false,
 template jsonb NOT NULL, components jsonb NOT NULL,
 fixed_monthly_gross numeric(14,2) NOT NULL CHECK(fixed_monthly_gross >= 0), monthly_ctc numeric(14,2) NOT NULL,
 annual_variable numeric(14,2) NOT NULL DEFAULT 0 CHECK(annual_variable >= 0),
 ruleset_version text NOT NULL, reason text NOT NULL DEFAULT 'REVISION' CHECK(reason IN ('JOINING','REVISION','PROMOTION','CORRECTION')),
 notes text CHECK(notes IS NULL OR length(notes) <= 1000),
 created_by uuid NOT NULL REFERENCES employees(id), created_at timestamptz NOT NULL DEFAULT now(),
 -- This unique index also serves "structure in effect for a month" (latest effective_from <= month end) and revision history.
 UNIQUE(organization_id, employee_id, effective_from)
);

CREATE TABLE IF NOT EXISTS payroll_runs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 period text NOT NULL CHECK(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','CALCULATED','SUBMITTED','APPROVED','PUBLISHED','LOCKED','CANCELLED')),
 pay_date date, include_expenses boolean NOT NULL DEFAULT true, needs_recalc boolean NOT NULL DEFAULT false,
 notes text CHECK(notes IS NULL OR length(notes) <= 1000),
 totals jsonb NOT NULL DEFAULT '{}', ruleset_version text, settings_snapshot jsonb,
 created_by uuid NOT NULL REFERENCES employees(id),
 calculated_at timestamptz, calculated_by uuid REFERENCES employees(id),
 submitted_at timestamptz, submitted_by uuid REFERENCES employees(id),
 approved_at timestamptz, approved_by uuid REFERENCES employees(id),
 published_at timestamptz, published_by uuid REFERENCES employees(id),
 locked_at timestamptz, locked_by uuid REFERENCES employees(id),
 cancelled_at timestamptz, cancelled_by uuid REFERENCES employees(id), cancel_reason text,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status <> 'APPROVED' OR approved_by IS DISTINCT FROM submitted_by)
);
-- One live run per month (a cancelled run can be replaced); also the lookup for "run for period".
CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_live_period ON payroll_runs(organization_id, period) WHERE status <> 'CANCELLED';
-- Runs list, newest month first (includes cancelled runs).
CREATE INDEX IF NOT EXISTS payroll_runs_list ON payroll_runs(organization_id, period DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS payroll_run_lines(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 run_id uuid NOT NULL REFERENCES payroll_runs(id), employee_id uuid NOT NULL REFERENCES employees(id),
 structure_id uuid REFERENCES salary_structures(id),
 status text NOT NULL CHECK(status IN ('INCLUDED','EXCLUDED')),
 held boolean NOT NULL DEFAULT false, hold_reason text, held_by uuid REFERENCES employees(id), released_at timestamptz,
 days_in_month smallint NOT NULL, payable_days numeric(5,2) NOT NULL DEFAULT 0, lop_days numeric(5,2) NOT NULL DEFAULT 0,
 gross numeric(14,2) NOT NULL DEFAULT 0, reimbursements numeric(14,2) NOT NULL DEFAULT 0, deductions numeric(14,2) NOT NULL DEFAULT 0,
 net numeric(14,2) NOT NULL DEFAULT 0, employer_cost numeric(14,2) NOT NULL DEFAULT 0, taxable_income numeric(14,2) NOT NULL DEFAULT 0,
 tds numeric(14,2) NOT NULL DEFAULT 0, pf_employee numeric(14,2) NOT NULL DEFAULT 0, esi_employee numeric(14,2) NOT NULL DEFAULT 0,
 pt numeric(14,2) NOT NULL DEFAULT 0,
 breakdown jsonb NOT NULL DEFAULT '{}', flags jsonb NOT NULL DEFAULT '[]',
 previous_net numeric(14,2), variance_pct numeric(8,2),
 payslip_id uuid REFERENCES payslips(id), published_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 -- Also serves the run review table (all lines of a run).
 UNIQUE(run_id, employee_id)
);
-- YTD / TDS-already-deducted aggregation: an employee's lines across the fiscal year's runs.
CREATE INDEX IF NOT EXISTS payroll_run_lines_employee ON payroll_run_lines(organization_id, employee_id, run_id);

CREATE TABLE IF NOT EXISTS payroll_inputs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 run_id uuid NOT NULL REFERENCES payroll_runs(id), employee_id uuid NOT NULL REFERENCES employees(id),
 kind text NOT NULL CHECK(kind IN ('EARNING','DEDUCTION','REIMBURSEMENT','LOP')),
 code text NOT NULL CHECK(code ~ '^[A-Z_]{2,30}$'), label text NOT NULL CHECK(length(label) BETWEEN 2 AND 120),
 amount numeric(14,2) NOT NULL DEFAULT 0 CHECK(amount >= 0), days numeric(5,2) CHECK(days IS NULL OR (days > 0 AND days <= 31)),
 taxable boolean NOT NULL DEFAULT true, esi_wage boolean NOT NULL DEFAULT false,
 source text NOT NULL DEFAULT 'MANUAL' CHECK(source IN ('MANUAL','EXPENSE_CLAIM')), source_ref uuid,
 note text CHECK(note IS NULL OR length(note) <= 500), voided_at timestamptz,
 created_by uuid NOT NULL REFERENCES employees(id), created_at timestamptz NOT NULL DEFAULT now()
);
-- Inputs feeding a run's calculation and the per-employee drill-down.
CREATE INDEX IF NOT EXISTS payroll_inputs_run ON payroll_inputs(organization_id, run_id, employee_id) WHERE voided_at IS NULL;
-- An approved expense claim is reimbursed through at most one live run.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_inputs_source_once ON payroll_inputs(organization_id, source, source_ref) WHERE source_ref IS NOT NULL AND voided_at IS NULL;

-- Published payslips keep the full breakdown and a link to the run that produced them.
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS breakdown jsonb;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS payroll_run_id uuid REFERENCES payroll_runs(id);

ALTER TABLE payroll_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_structures ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_run_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_inputs ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['payroll_settings','payroll_profiles','salary_structures','payroll_runs','payroll_run_lines','payroll_inputs'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(6) ON CONFLICT DO NOTHING;

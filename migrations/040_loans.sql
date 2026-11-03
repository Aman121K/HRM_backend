-- Employee loans and salary advances: request → approval (maker-checker) → disbursement → EMI schedule recovered
-- through payroll (payroll_inputs source 'LOAN', one input per installment). Logic: backend/src/platform/loans/.

CREATE TABLE IF NOT EXISTS employee_loans(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 loan_number text NOT NULL CHECK(loan_number ~ '^(LN|ADV)-[0-9]{4,}$'),
 employee_id uuid NOT NULL REFERENCES employees(id),
 kind text NOT NULL CHECK(kind IN ('LOAN','ADVANCE')),
 purpose text NOT NULL CHECK(purpose IN ('Medical','Education','Housing','Vehicle','Wedding','Family emergency','Relocation','Other')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
 principal numeric(14,2) NOT NULL CHECK(principal >= 500 AND principal <= 10000000),
 tenure_months integer NOT NULL CHECK(tenure_months BETWEEN 1 AND 60),
 emi numeric(14,2) NOT NULL CHECK(emi > 0),
 first_period text NOT NULL CHECK(first_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 status text NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','APPROVED','ACTIVE','CLOSED','REJECTED','CANCELLED')),
 requested_by uuid NOT NULL REFERENCES employees(id),
 decided_by uuid REFERENCES employees(id), decided_at timestamptz, decision_note text CHECK(decision_note IS NULL OR length(decision_note) <= 1000),
 disbursed_on date, disbursement_ref text CHECK(disbursement_ref IS NULL OR length(disbursement_ref) <= 80), disbursed_by uuid REFERENCES employees(id),
 closed_at timestamptz, closure_note text CHECK(closure_note IS NULL OR length(closure_note) <= 500),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status NOT IN ('ACTIVE','CLOSED') OR disbursed_on IS NOT NULL OR closure_note IS NOT NULL),
 UNIQUE(organization_id, loan_number)
);
CREATE INDEX IF NOT EXISTS employee_loans_by_employee ON employee_loans(organization_id, employee_id, status);
CREATE INDEX IF NOT EXISTS employee_loans_by_status ON employee_loans(organization_id, status, created_at DESC);

-- One row per month of recovery. DUE rows for a run's period are pulled into that run as LOAN_EMI deductions;
-- publishing the run marks them DEDUCTED. SKIPPED rows push the schedule out by a month; PREPAID = settled outside payroll.
CREATE TABLE IF NOT EXISTS employee_loan_installments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 loan_id uuid NOT NULL REFERENCES employee_loans(id), employee_id uuid NOT NULL REFERENCES employees(id),
 seq integer NOT NULL CHECK(seq >= 1),
 period text NOT NULL CHECK(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 amount numeric(14,2) NOT NULL CHECK(amount >= 0),
 status text NOT NULL DEFAULT 'DUE' CHECK(status IN ('DUE','DEDUCTED','SKIPPED','PREPAID')),
 run_id uuid REFERENCES payroll_runs(id), note text CHECK(note IS NULL OR length(note) <= 300),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(loan_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS employee_loan_installments_one_due_per_month
  ON employee_loan_installments(loan_id, period) WHERE status IN ('DUE','DEDUCTED');
CREATE INDEX IF NOT EXISTS employee_loan_installments_by_period ON employee_loan_installments(organization_id, period, status);

-- Payroll inputs may now come from a loan installment.
ALTER TABLE payroll_inputs DROP CONSTRAINT IF EXISTS payroll_inputs_source_check;
ALTER TABLE payroll_inputs ADD CONSTRAINT payroll_inputs_source_check CHECK (source IN ('MANUAL','EXPENSE_CLAIM','LOAN'));

ALTER TABLE employee_loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_loan_installments ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['employee_loans','employee_loan_installments'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(40) ON CONFLICT DO NOTHING;

-- Shared case engine for request/approval modules (helpdesk, assets, expenses,
-- travel, exit, recruitment, learning, shifts, letters, recognition).
-- Module definitions and state machines live in backend/src/platform/cases/case-modules.ts.
CREATE TABLE IF NOT EXISTS hr_case_counters(
 organization_id uuid NOT NULL REFERENCES organizations(id), module text NOT NULL, next_value integer NOT NULL DEFAULT 1,
 PRIMARY KEY(organization_id,module)
);

CREATE TABLE IF NOT EXISTS hr_cases(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 module text NOT NULL, case_number text NOT NULL, title text NOT NULL CHECK(length(title) BETWEEN 3 AND 200), category text,
 requester_id uuid NOT NULL REFERENCES employees(id), subject_employee_id uuid REFERENCES employees(id),
 approver_id uuid REFERENCES employees(id), assignee_id uuid REFERENCES employees(id),
 status text NOT NULL, priority text NOT NULL DEFAULT 'MEDIUM' CHECK(priority IN ('LOW','MEDIUM','HIGH','URGENT')),
 amount numeric(14,2) CHECK(amount IS NULL OR amount >= 0), currency char(3) NOT NULL DEFAULT 'INR',
 start_date date, end_date date, due_at timestamptz, details jsonb NOT NULL DEFAULT '{}',
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
 CHECK(end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
 UNIQUE(organization_id,case_number)
);
-- Employee history per module ("My requests").
CREATE INDEX IF NOT EXISTS hr_cases_requester_history ON hr_cases(organization_id,module,requester_id,created_at DESC,id);
-- Manager approval queues across modules.
CREATE INDEX IF NOT EXISTS hr_cases_approver_queue ON hr_cases(organization_id,approver_id,status,created_at,id);
-- HR desk / module board filtered by status.
CREATE INDEX IF NOT EXISTS hr_cases_module_board ON hr_cases(organization_id,module,status,created_at DESC,id);
-- Assignee work queues (helpdesk agents, IT, finance).
CREATE INDEX IF NOT EXISTS hr_cases_assignee_queue ON hr_cases(organization_id,assignee_id,status,due_at,id) WHERE assignee_id IS NOT NULL;
-- Recognition wall / anything about an employee.
CREATE INDEX IF NOT EXISTS hr_cases_subject_history ON hr_cases(organization_id,subject_employee_id,created_at DESC,id) WHERE subject_employee_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_case_events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 case_id uuid NOT NULL REFERENCES hr_cases(id), actor_id uuid NOT NULL REFERENCES employees(id),
 kind text NOT NULL CHECK(kind IN ('CREATED','TRANSITION','COMMENT')), action text, from_status text, to_status text,
 note text, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hr_case_events_timeline ON hr_case_events(organization_id,case_id,id);

ALTER TABLE hr_case_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_case_events ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['hr_case_counters','hr_cases','hr_case_events'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;

-- Onboarding: pre-boarding → day one → first 90 days.
-- Checklist templates (per org, editable by HR) are copied into per-joiner tasks when a joiner is created,
-- so later template edits never rewrite a joiner's plan. Joiner documents live in stored_files
-- (entity_type 'onboarding_joiner', category = document type); HR verification is kept per file.

CREATE TABLE IF NOT EXISTS onboarding_settings(
 organization_id uuid PRIMARY KEY REFERENCES organizations(id),
 hr_owner_id uuid REFERENCES employees(id), it_owner_id uuid REFERENCES employees(id), finance_owner_id uuid REFERENCES employees(id),
 employee_number_prefix text NOT NULL DEFAULT 'EMP' CHECK(employee_number_prefix ~ '^[A-Z]{1,6}$'),
 work_email_domain text CHECK(work_email_domain IS NULL OR work_email_domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
 welcome_message text NOT NULL DEFAULT 'Welcome aboard! We are so glad you are here.' CHECK(length(welcome_message) <= 2000),
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS onboarding_templates(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 name text NOT NULL CHECK(length(name) BETWEEN 3 AND 120), description text CHECK(description IS NULL OR length(description) <= 1000),
 is_default boolean NOT NULL DEFAULT false, archived_at timestamptz,
 version integer NOT NULL DEFAULT 1, created_by uuid REFERENCES employees(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,name)
);
-- At most one default template per organization.
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_templates_one_default ON onboarding_templates(organization_id) WHERE is_default AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS onboarding_template_tasks(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 template_id uuid NOT NULL REFERENCES onboarding_templates(id) ON DELETE CASCADE,
 phase text NOT NULL CHECK(phase IN ('PRE_BOARDING','DAY_ONE','FIRST_WEEK','FIRST_90_DAYS')),
 title text NOT NULL CHECK(length(title) BETWEEN 3 AND 160), description text CHECK(description IS NULL OR length(description) <= 1000),
 owner_type text NOT NULL CHECK(owner_type IN ('HR','IT','MANAGER','BUDDY','JOINER','FINANCE')),
 due_offset_days integer NOT NULL CHECK(due_offset_days BETWEEN -90 AND 180),
 requires_document boolean NOT NULL DEFAULT false,
 document_category text CHECK(document_category IS NULL OR document_category IN ('PAN','AADHAAR','BANK_PROOF','EDUCATION','PHOTO','OTHER')),
 completes_on_conversion boolean NOT NULL DEFAULT false,
 sort_order integer NOT NULL DEFAULT 0,
 CHECK(NOT requires_document OR document_category IS NOT NULL)
);
-- Template editor loads a template's tasks in order.
CREATE INDEX IF NOT EXISTS onboarding_template_tasks_template ON onboarding_template_tasks(organization_id,template_id,sort_order);

CREATE TABLE IF NOT EXISTS onboarding_joiners(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 full_name text NOT NULL CHECK(length(full_name) BETWEEN 2 AND 160), personal_email text NOT NULL CHECK(personal_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
 phone text CHECK(phone IS NULL OR length(phone) <= 30),
 designation text NOT NULL CHECK(length(designation) BETWEEN 2 AND 120), department text NOT NULL CHECK(length(department) BETWEEN 2 AND 120),
 location text CHECK(location IS NULL OR length(location) <= 120),
 manager_id uuid REFERENCES employees(id), buddy_id uuid REFERENCES employees(id),
 joining_date date NOT NULL,
 employment_type text NOT NULL DEFAULT 'FULL_TIME' CHECK(employment_type IN ('FULL_TIME','PART_TIME','CONTRACT','INTERN')),
 status text NOT NULL DEFAULT 'PRE_BOARDING' CHECK(status IN ('PRE_BOARDING','READY_TO_JOIN','JOINED','COMPLETED','WITHDRAWN')),
 template_id uuid REFERENCES onboarding_templates(id), candidate_case_id uuid REFERENCES hr_cases(id),
 employee_id uuid REFERENCES employees(id),
 pan_number text CHECK(pan_number IS NULL OR pan_number ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
 -- Only the last four Aadhaar digits are ever stored; the UI shows XXXX XXXX 1234.
 aadhaar_last4 char(4) CHECK(aadhaar_last4 IS NULL OR aadhaar_last4 ~ '^[0-9]{4}$'),
 notes text CHECK(notes IS NULL OR length(notes) <= 2000), withdrawn_reason text,
 created_by uuid NOT NULL REFERENCES employees(id), ready_at timestamptz, converted_at timestamptz, completed_at timestamptz, withdrawn_at timestamptz,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(buddy_id IS NULL OR manager_id IS NULL OR buddy_id <> manager_id)
);
-- A candidate is imported at most once; a joiner converts into at most one employee.
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_joiners_candidate ON onboarding_joiners(organization_id,candidate_case_id) WHERE candidate_case_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_joiners_employee ON onboarding_joiners(organization_id,employee_id) WHERE employee_id IS NOT NULL;
-- Pipeline board and "joining in the next N days" widget.
CREATE INDEX IF NOT EXISTS onboarding_joiners_pipeline ON onboarding_joiners(organization_id,status,joining_date,id);
-- Managers' view of their incoming hires.
CREATE INDEX IF NOT EXISTS onboarding_joiners_manager ON onboarding_joiners(organization_id,manager_id,joining_date) WHERE manager_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS onboarding_tasks(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 joiner_id uuid NOT NULL REFERENCES onboarding_joiners(id), template_task_id uuid REFERENCES onboarding_template_tasks(id) ON DELETE SET NULL,
 phase text NOT NULL CHECK(phase IN ('PRE_BOARDING','DAY_ONE','FIRST_WEEK','FIRST_90_DAYS')),
 title text NOT NULL CHECK(length(title) BETWEEN 3 AND 160), description text CHECK(description IS NULL OR length(description) <= 1000),
 owner_type text NOT NULL CHECK(owner_type IN ('HR','IT','MANAGER','BUDDY','JOINER','FINANCE')), owner_id uuid REFERENCES employees(id),
 due_date date NOT NULL, requires_document boolean NOT NULL DEFAULT false,
 document_category text CHECK(document_category IS NULL OR document_category IN ('PAN','AADHAAR','BANK_PROOF','EDUCATION','PHOTO','OTHER')),
 completes_on_conversion boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DONE','SKIPPED')),
 note text CHECK(note IS NULL OR length(note) <= 2000), completed_by uuid REFERENCES employees(id), completed_at timestamptz,
 sort_order integer NOT NULL DEFAULT 0, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status = 'PENDING') = (completed_at IS NULL))
);
-- Joiner detail checklist (and progress aggregation per joiner).
CREATE INDEX IF NOT EXISTS onboarding_tasks_joiner ON onboarding_tasks(organization_id,joiner_id,phase,sort_order);
-- "My onboarding tasks" queue for an owner, soonest due first.
CREATE INDEX IF NOT EXISTS onboarding_tasks_owner_queue ON onboarding_tasks(organization_id,owner_id,status,due_date) WHERE owner_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS onboarding_document_reviews(
 file_id uuid PRIMARY KEY REFERENCES stored_files(id), organization_id uuid NOT NULL REFERENCES organizations(id),
 joiner_id uuid NOT NULL REFERENCES onboarding_joiners(id),
 status text NOT NULL CHECK(status IN ('VERIFIED','REJECTED')), reason text CHECK(reason IS NULL OR length(reason) <= 500),
 reviewed_by uuid NOT NULL REFERENCES employees(id), reviewed_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status <> 'REJECTED' OR reason IS NOT NULL)
);
-- Documents panel loads all reviews for one joiner.
CREATE INDEX IF NOT EXISTS onboarding_document_reviews_joiner ON onboarding_document_reviews(organization_id,joiner_id);

ALTER TABLE onboarding_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_template_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_joiners ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_document_reviews ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['onboarding_settings','onboarding_templates','onboarding_template_tasks','onboarding_joiners','onboarding_tasks','onboarding_document_reviews'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(10) ON CONFLICT DO NOTHING;

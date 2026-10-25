CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS organizations(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata', currency char(3) NOT NULL DEFAULT 'INR',
  status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE, full_name text NOT NULL,
  password_hash text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS organization_memberships(
  organization_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK(role IN ('OWNER','HR_ADMIN','MANAGER','EMPLOYEE','PAYROLL_ADMIN')),
  status text NOT NULL DEFAULT 'ACTIVE', PRIMARY KEY(organization_id,user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_active ON organization_memberships(user_id,status,organization_id);

CREATE TABLE IF NOT EXISTS employees(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid REFERENCES users(id), employee_number text NOT NULL, full_name text NOT NULL, work_email text NOT NULL,
  manager_id uuid REFERENCES employees(id), department text, designation text, joining_date date NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,employee_number), UNIQUE(organization_id,work_email), UNIQUE(organization_id,user_id)
);
CREATE INDEX IF NOT EXISTS employees_manager_directory ON employees(organization_id,manager_id,status,full_name,id);
CREATE INDEX IF NOT EXISTS employees_department_directory ON employees(organization_id,status,department,full_name,id);

CREATE TABLE IF NOT EXISTS leave_types(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id), code text NOT NULL,
  name text NOT NULL, annual_quota numeric(6,2) NOT NULL, requires_document_after_days numeric(6,2),
  active boolean NOT NULL DEFAULT true, UNIQUE(organization_id,code)
);
CREATE INDEX IF NOT EXISTS leave_types_active ON leave_types(organization_id,active,name);
CREATE TABLE IF NOT EXISTS leave_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  employee_id uuid NOT NULL REFERENCES employees(id), approver_id uuid NOT NULL REFERENCES employees(id), leave_type_id uuid NOT NULL REFERENCES leave_types(id),
  start_date date NOT NULL, end_date date NOT NULL, days numeric(6,2) NOT NULL CHECK(days>0), reason text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN','CANCELLED')),
  decision_note text, submitted_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  CHECK(end_date>=start_date)
);
CREATE INDEX IF NOT EXISTS leave_manager_queue ON leave_requests(organization_id,approver_id,status,submitted_at DESC,id);
CREATE INDEX IF NOT EXISTS leave_employee_history ON leave_requests(organization_id,employee_id,submitted_at DESC,status,id);
CREATE INDEX IF NOT EXISTS leave_overlap_check ON leave_requests(organization_id,employee_id,start_date,end_date) WHERE status IN ('PENDING','APPROVED');

CREATE TABLE IF NOT EXISTS workflow_events(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
  employee_id uuid, event_type text NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_events_stream ON workflow_events(organization_id,employee_id,id);
CREATE INDEX IF NOT EXISTS workflow_events_entity ON workflow_events(organization_id,entity_type,entity_id,id DESC);
CREATE TABLE IF NOT EXISTS email_outbox(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
  recipient text NOT NULL, subject text NOT NULL, html text NOT NULL, status text NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_outbox_delivery ON email_outbox(status,available_at,id) WHERE status IN ('PENDING','FAILED');
CREATE TABLE IF NOT EXISTS audit_log(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), actor_user_id uuid NOT NULL,
  action text NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL, before_data jsonb, after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_entity_history ON audit_log(organization_id,entity_type,entity_id,created_at DESC,id);
CREATE INDEX IF NOT EXISTS audit_actor_history ON audit_log(organization_id,actor_user_id,created_at DESC,id);

-- Application queries must set app.organization_id for each transaction. RLS is a second isolation boundary.
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['employees','leave_types','leave_requests','workflow_events','email_outbox','audit_log'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',t);
  END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;

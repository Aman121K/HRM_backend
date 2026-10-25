-- 029: port the features that only existed on the retired legacy backend (backend/src/server.ts, :4000) onto the v2 platform.
--  * Tax declarations + proofs + reviewer decisions (legacy kept these in SQLite keyed by a free-text tenant id).
--  * Legacy KPI and attendance-regularization rows move into the case engine (modules "kpi" and "regularization").
-- The legacy tables (kpis, attendance_regularizations) are left in place, read-only by convention, for audit; nothing reads them.

CREATE TABLE IF NOT EXISTS tax_declarations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 employee_id uuid NOT NULL REFERENCES employees(id),
 tax_year text NOT NULL CHECK(tax_year ~ '^[0-9]{4}-[0-9]{2}$'),
 regime text NOT NULL CHECK(regime IN ('NEW','OLD')),
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SUBMITTED','CLARIFICATION','ACCEPTED','REJECTED','WITHDRAWN')),
 items jsonb NOT NULL DEFAULT '[]', inputs jsonb NOT NULL DEFAULT '{}', calculation jsonb NOT NULL DEFAULT '{}',
 rules_version text NOT NULL, completeness integer NOT NULL DEFAULT 0 CHECK(completeness BETWEEN 0 AND 100),
 consent boolean NOT NULL DEFAULT false,
 submitted_at timestamptz,
 reviewed_by uuid REFERENCES employees(id), reviewed_at timestamptz, review_action text, review_reason text, review_amounts jsonb,
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
-- One open declaration per employee per tax year; closed ones stay as history.
CREATE UNIQUE INDEX IF NOT EXISTS tax_declarations_one_open ON tax_declarations(organization_id,employee_id,tax_year)
 WHERE status IN ('DRAFT','SUBMITTED','CLARIFICATION');
CREATE INDEX IF NOT EXISTS tax_declarations_employee ON tax_declarations(organization_id,employee_id,updated_at DESC,id);
CREATE INDEX IF NOT EXISTS tax_declarations_review_queue ON tax_declarations(organization_id,status,submitted_at,id);

-- Proof metadata; the bytes live in stored_files (entity_type 'tax_declaration') via FilesService.
CREATE TABLE IF NOT EXISTS tax_declaration_proofs(
 file_id uuid PRIMARY KEY REFERENCES stored_files(id),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 declaration_id uuid NOT NULL REFERENCES tax_declarations(id),
 item_id text CHECK(item_id IS NULL OR length(item_id) <= 64),
 category text NOT NULL CHECK(length(category) BETWEEN 1 AND 60),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tax_declaration_proofs_declaration ON tax_declaration_proofs(organization_id,declaration_id,created_at);

ALTER TABLE tax_declarations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_declarations FORCE ROW LEVEL SECURITY;
ALTER TABLE tax_declaration_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_declaration_proofs FORCE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['tax_declarations','tax_declaration_proofs'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;

-- Legacy KPI rows → case engine module "kpi" (idempotent via details.legacyId).
DO $$ DECLARE r record; n integer; BEGIN
 FOR r IN SELECT k.* FROM kpis k
   WHERE NOT EXISTS (SELECT 1 FROM hr_cases c WHERE c.organization_id=k.organization_id AND c.module='kpi' AND c.details->>'legacyId'=k.id::text)
   ORDER BY k.organization_id, coalesce(k.submitted_at,k.updated_at)
 LOOP
  INSERT INTO hr_case_counters(organization_id,module,next_value) VALUES(r.organization_id,'kpi',2)
   ON CONFLICT (organization_id,module) DO UPDATE SET next_value=hr_case_counters.next_value+1 RETURNING next_value-1 INTO n;
  WITH c AS (
   INSERT INTO hr_cases(organization_id,module,case_number,title,category,requester_id,approver_id,status,details,created_at,updated_at,closed_at)
   VALUES(r.organization_id,'kpi','KPI-'||lpad(n::text,4,'0'),left(r.title,200),r.period,r.employee_id,r.manager_id,
     CASE r.status WHEN 'DRAFT' THEN 'SUBMITTED' WHEN 'PENDING' THEN 'SUBMITTED' ELSE r.status END,
     jsonb_build_object('legacyId',r.id,'metric',r.metric,'target',r.target,'actual',r.actual,'weight',r.weight,'note',coalesce(r.employee_note,''),'managerNote',r.manager_note),
     coalesce(r.submitted_at,r.updated_at), r.updated_at, CASE WHEN r.status IN ('APPROVED','REJECTED') THEN coalesce(r.decided_at,r.updated_at) END)
   RETURNING id)
  INSERT INTO hr_case_events(organization_id,case_id,actor_id,kind,to_status,data)
   SELECT r.organization_id, c.id, r.employee_id, 'CREATED', 'SUBMITTED', jsonb_build_object('migratedFrom','kpis') FROM c;
 END LOOP;
END $$;

-- Legacy regularization rows → case engine module "regularization".
DO $$ DECLARE r record; n integer; BEGIN
 FOR r IN SELECT a.* FROM attendance_regularizations a
   WHERE NOT EXISTS (SELECT 1 FROM hr_cases c WHERE c.organization_id=a.organization_id AND c.module='regularization' AND c.details->>'legacyId'=a.id::text)
   ORDER BY a.organization_id, a.submitted_at
 LOOP
  INSERT INTO hr_case_counters(organization_id,module,next_value) VALUES(r.organization_id,'regularization',2)
   ON CONFLICT (organization_id,module) DO UPDATE SET next_value=hr_case_counters.next_value+1 RETURNING next_value-1 INTO n;
  WITH c AS (
   INSERT INTO hr_cases(organization_id,module,case_number,title,requester_id,approver_id,status,start_date,details,created_at,updated_at,closed_at)
   VALUES(r.organization_id,'regularization','REG-'||lpad(n::text,4,'0'),left(CASE WHEN length(r.reason)>=3 THEN r.reason ELSE 'Attendance correction' END,200),
     r.employee_id,r.approver_id,
     CASE r.status WHEN 'PENDING' THEN 'SUBMITTED' WHEN 'CHANGES_REQUESTED' THEN 'REJECTED' ELSE r.status END, r.attendance_date,
     jsonb_strip_nulls(jsonb_build_object('legacyId',r.id,'expectedIn',to_char(r.expected_in,'HH24:MI'),'expectedOut',to_char(r.expected_out,'HH24:MI'),'note',r.note,'decisionNote',r.decision_note)),
     r.submitted_at, r.updated_at, CASE WHEN r.status <> 'PENDING' THEN coalesce(r.decided_at,r.updated_at) END)
   RETURNING id)
  INSERT INTO hr_case_events(organization_id,case_id,actor_id,kind,to_status,data)
   SELECT r.organization_id, c.id, r.employee_id, 'CREATED', 'SUBMITTED', jsonb_build_object('migratedFrom','attendance_regularizations') FROM c;
 END LOOP;
END $$;

INSERT INTO schema_migrations(version) VALUES(29) ON CONFLICT DO NOTHING;

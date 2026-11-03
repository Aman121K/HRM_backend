-- Performance management: appraisal cycles, weighted goals with key results (OKRs), self / manager / 360 reviews,
-- calibration and salary revision proposals applied as new salary structures. Logic: backend/src/platform/performance/.

CREATE TABLE IF NOT EXISTS perf_cycles(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 name text NOT NULL CHECK(length(name) BETWEEN 3 AND 80),
 period_start date NOT NULL, period_end date NOT NULL,
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','GOAL_SETTING','REVIEW','CALIBRATION','PUBLISHED','CLOSED')),
 goal_weight integer NOT NULL DEFAULT 70 CHECK(goal_weight BETWEEN 0 AND 100),
 self_review boolean NOT NULL DEFAULT true,
 peer_review boolean NOT NULL DEFAULT true,
 max_peers integer NOT NULL DEFAULT 3 CHECK(max_peers BETWEEN 0 AND 8),
 competencies jsonb NOT NULL DEFAULT '[]',
 department text CHECK(department IS NULL OR length(department) <= 80),
 goals_due date, reviews_due date,
 created_by uuid NOT NULL REFERENCES employees(id),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(period_end > period_start)
);
CREATE INDEX IF NOT EXISTS perf_cycles_by_org ON perf_cycles(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS perf_participants(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 cycle_id uuid NOT NULL REFERENCES perf_cycles(id), employee_id uuid NOT NULL REFERENCES employees(id),
 manager_id uuid REFERENCES employees(id),
 goals_status text NOT NULL DEFAULT 'DRAFT' CHECK(goals_status IN ('DRAFT','SUBMITTED','APPROVED')),
 goals_note text CHECK(goals_note IS NULL OR length(goals_note) <= 1000),
 self_status text NOT NULL DEFAULT 'PENDING' CHECK(self_status IN ('PENDING','SUBMITTED')),
 manager_status text NOT NULL DEFAULT 'PENDING' CHECK(manager_status IN ('PENDING','SUBMITTED')),
 computed_score numeric(4,2), final_rating numeric(3,1) CHECK(final_rating IS NULL OR final_rating BETWEEN 1 AND 5),
 calibration_note text CHECK(calibration_note IS NULL OR length(calibration_note) <= 1000),
 increment_pct numeric(5,2) CHECK(increment_pct IS NULL OR increment_pct BETWEEN 0 AND 100),
 promote boolean NOT NULL DEFAULT false, new_designation text CHECK(new_designation IS NULL OR length(new_designation) <= 80),
 revision_status text NOT NULL DEFAULT 'NONE' CHECK(revision_status IN ('NONE','PROPOSED','APPROVED','APPLIED')),
 revision_effective date, revision_ctc numeric(14,2), revision_structure_id uuid REFERENCES salary_structures(id),
 proposed_by uuid REFERENCES employees(id), approved_by uuid REFERENCES employees(id),
 published_at timestamptz,
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(cycle_id, employee_id)
);
CREATE INDEX IF NOT EXISTS perf_participants_by_manager ON perf_participants(organization_id, manager_id, cycle_id);
CREATE INDEX IF NOT EXISTS perf_participants_by_employee ON perf_participants(organization_id, employee_id);

CREATE TABLE IF NOT EXISTS perf_goals(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 cycle_id uuid NOT NULL REFERENCES perf_cycles(id), employee_id uuid NOT NULL REFERENCES employees(id),
 title text NOT NULL CHECK(length(title) BETWEEN 3 AND 160),
 description text CHECK(description IS NULL OR length(description) <= 2000),
 weight integer NOT NULL CHECK(weight BETWEEN 5 AND 100),
 key_results jsonb NOT NULL DEFAULT '[]',
 progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
 self_rating integer CHECK(self_rating IS NULL OR self_rating BETWEEN 1 AND 5), self_comment text CHECK(self_comment IS NULL OR length(self_comment) <= 2000),
 manager_rating integer CHECK(manager_rating IS NULL OR manager_rating BETWEEN 1 AND 5), manager_comment text CHECK(manager_comment IS NULL OR length(manager_comment) <= 2000),
 sort_order integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS perf_goals_by_person ON perf_goals(organization_id, cycle_id, employee_id);

-- One row per (subject, reviewer): SELF, MANAGER, PEER or REPORT (upward). Peer/report feedback is shown to the subject
-- only as an aggregate, never with names.
CREATE TABLE IF NOT EXISTS perf_reviews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 cycle_id uuid NOT NULL REFERENCES perf_cycles(id), subject_id uuid NOT NULL REFERENCES employees(id), reviewer_id uuid NOT NULL REFERENCES employees(id),
 relation text NOT NULL CHECK(relation IN ('SELF','MANAGER','PEER','REPORT')),
 status text NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','SUBMITTED','DECLINED')),
 competency_ratings jsonb NOT NULL DEFAULT '{}',
 overall_rating integer CHECK(overall_rating IS NULL OR overall_rating BETWEEN 1 AND 5),
 strengths text CHECK(strengths IS NULL OR length(strengths) <= 3000),
 improvements text CHECK(improvements IS NULL OR length(improvements) <= 3000),
 comments text CHECK(comments IS NULL OR length(comments) <= 3000),
 nominated_by uuid REFERENCES employees(id), submitted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((relation = 'SELF') = (subject_id = reviewer_id)),
 UNIQUE(cycle_id, subject_id, reviewer_id)
);
CREATE INDEX IF NOT EXISTS perf_reviews_by_reviewer ON perf_reviews(organization_id, reviewer_id, status);

ALTER TABLE perf_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE perf_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE perf_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE perf_reviews ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['perf_cycles','perf_participants','perf_goals','perf_reviews'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(41) ON CONFLICT DO NOTHING;

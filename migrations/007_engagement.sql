-- Engagement: surveys, pulse checks, eNPS and quick polls.
--
-- Anonymity model: `survey_invitations` records WHO was asked and WHETHER/WHEN (day only) they answered,
-- which is what dedupe, response rates and reminders need. `survey_responses` holds the answers. For
-- anonymous surveys a response row carries no employee id, no precise timestamp (day only) and a random
-- uuid key (no sequence that could be correlated with invitation order), so answers cannot be joined back
-- to a person. Department/location are snapshotted on the response only for thresholded breakdowns.
CREATE TABLE IF NOT EXISTS surveys(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 kind text NOT NULL DEFAULT 'SURVEY' CHECK(kind IN ('SURVEY','POLL')),
 title text NOT NULL CHECK(length(title) BETWEEN 3 AND 200), description text CHECK(description IS NULL OR length(description) <= 2000),
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','LIVE','CLOSED')),
 anonymous boolean NOT NULL DEFAULT true, allow_edit boolean NOT NULL DEFAULT false, share_results boolean NOT NULL DEFAULT false,
 audience_type text NOT NULL DEFAULT 'ALL' CHECK(audience_type IN ('ALL','DEPARTMENTS','LOCATIONS','TEAM')),
 audience_values text[] NOT NULL DEFAULT '{}',
 min_group_size integer NOT NULL DEFAULT 3 CHECK(min_group_size >= 3),
 owner_id uuid NOT NULL REFERENCES employees(id),
 opens_at timestamptz, closes_at timestamptz, launched_at timestamptz, closed_at timestamptz,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 -- Answers of anonymous surveys can never be linked to a person, so they cannot be edited later either.
 CHECK(NOT (anonymous AND allow_edit)),
 CHECK(closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at)
);
-- HR / manager "Manage" list: surveys by status, newest first.
CREATE INDEX IF NOT EXISTS surveys_board ON surveys(organization_id,kind,status,created_at DESC);
-- Manager's own surveys.
CREATE INDEX IF NOT EXISTS surveys_owner ON surveys(organization_id,owner_id,created_at DESC);
-- Lazy auto-close sweep of LIVE surveys past their close date.
CREATE INDEX IF NOT EXISTS surveys_due_close ON surveys(organization_id,closes_at) WHERE status='LIVE' AND closes_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS survey_questions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 survey_id uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, position integer NOT NULL CHECK(position >= 0),
 type text NOT NULL CHECK(type IN ('RATING','ENPS','SINGLE_CHOICE','MULTI_CHOICE','SHORT_TEXT','LONG_TEXT')),
 prompt text NOT NULL CHECK(length(prompt) BETWEEN 3 AND 500), help_text text CHECK(help_text IS NULL OR length(help_text) <= 500),
 required boolean NOT NULL DEFAULT true, options jsonb NOT NULL DEFAULT '[]', scale_labels jsonb NOT NULL DEFAULT '[]',
 UNIQUE(survey_id,position) DEFERRABLE INITIALLY DEFERRED
);
-- (survey_id, position) unique index doubles as the ordered question list lookup.

-- Participation (audience snapshot taken at launch). responded_on is a date on purpose.
CREATE TABLE IF NOT EXISTS survey_invitations(
 organization_id uuid NOT NULL REFERENCES organizations(id), survey_id uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
 employee_id uuid NOT NULL REFERENCES employees(id), invited_at timestamptz NOT NULL DEFAULT now(),
 responded_on date, reminder_count integer NOT NULL DEFAULT 0, last_reminded_at timestamptz,
 PRIMARY KEY(survey_id,employee_id)
);
-- "My surveys": everything an employee is invited to.
CREATE INDEX IF NOT EXISTS survey_invitations_employee ON survey_invitations(organization_id,employee_id,survey_id);

CREATE TABLE IF NOT EXISTS survey_responses(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 survey_id uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
 employee_id uuid REFERENCES employees(id), submitted_on date NOT NULL DEFAULT current_date,
 submitted_at timestamptz, updated_at timestamptz,
 department text, location text,
 -- Identified responses carry exact timestamps; anonymous ones carry only the day.
 CHECK((employee_id IS NULL AND submitted_at IS NULL AND updated_at IS NULL) OR (employee_id IS NOT NULL AND submitted_at IS NOT NULL))
);
-- One identified response per employee (anonymous dedupe is enforced through survey_invitations).
CREATE UNIQUE INDEX IF NOT EXISTS survey_responses_one_per_employee ON survey_responses(survey_id,employee_id) WHERE employee_id IS NOT NULL;
-- Results aggregation by survey.
CREATE INDEX IF NOT EXISTS survey_responses_by_survey ON survey_responses(organization_id,survey_id);

CREATE TABLE IF NOT EXISTS survey_answers(
 organization_id uuid NOT NULL REFERENCES organizations(id),
 response_id uuid NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
 question_id uuid NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
 numeric_value integer CHECK(numeric_value IS NULL OR numeric_value BETWEEN 0 AND 10),
 choice_values text[], text_value text CHECK(text_value IS NULL OR length(text_value) <= 4000),
 PRIMARY KEY(response_id,question_id)
);
-- Per-question distributions.
CREATE INDEX IF NOT EXISTS survey_answers_by_question ON survey_answers(organization_id,question_id);

-- Questions are immutable once a survey leaves DRAFT (defence in depth; the service also refuses).
CREATE OR REPLACE FUNCTION survey_questions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM surveys WHERE id = COALESCE(NEW.survey_id, OLD.survey_id);
  IF s IS NOT NULL AND s <> 'DRAFT' THEN
    RAISE EXCEPTION 'Questions cannot change once a survey is live' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS survey_questions_immutable ON survey_questions;
CREATE TRIGGER survey_questions_immutable BEFORE INSERT OR UPDATE OR DELETE ON survey_questions
  FOR EACH ROW EXECUTE FUNCTION survey_questions_guard();

ALTER TABLE surveys ENABLE ROW LEVEL SECURITY;
ALTER TABLE survey_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE survey_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE survey_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE survey_answers ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['surveys','survey_questions','survey_invitations','survey_responses','survey_answers'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(7) ON CONFLICT DO NOTHING;

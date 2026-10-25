-- Learning management: course catalogue, ordered lessons (text, video, PDF, quiz), enrolments with
-- per-lesson progress, server-graded quiz attempts and verifiable certificates.
CREATE TABLE IF NOT EXISTS lms_courses(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 title text NOT NULL CHECK(length(title) BETWEEN 3 AND 140), summary text NOT NULL DEFAULT '' CHECK(length(summary) <= 600),
 description text NOT NULL DEFAULT '' CHECK(length(description) <= 8000),
 category text NOT NULL CHECK(length(category) BETWEEN 2 AND 40),
 level text NOT NULL DEFAULT 'BEGINNER' CHECK(level IN ('BEGINNER','INTERMEDIATE','ADVANCED')),
 duration_minutes integer NOT NULL DEFAULT 30 CHECK(duration_minutes BETWEEN 1 AND 6000),
 cover_color text NOT NULL DEFAULT '#0b615c' CHECK(cover_color ~ '^#[0-9a-fA-F]{6}$'),
 cover_emoji text NOT NULL DEFAULT '📘' CHECK(length(cover_emoji) BETWEEN 1 AND 8),
 mandatory boolean NOT NULL DEFAULT false,
 mandatory_due_days integer NOT NULL DEFAULT 30 CHECK(mandatory_due_days BETWEEN 1 AND 365),
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PUBLISHED','ARCHIVED')),
 -- Set when a manager authors a course for their own team; NULL means company-wide.
 team_manager_id uuid REFERENCES employees(id),
 author_id uuid NOT NULL REFERENCES employees(id),
 version integer NOT NULL DEFAULT 1, published_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(NOT (mandatory AND team_manager_id IS NOT NULL))
);
-- Catalogue: published courses per tenant, filtered by category.
CREATE INDEX IF NOT EXISTS lms_courses_catalogue ON lms_courses(organization_id,status,category,title);

CREATE TABLE IF NOT EXISTS lms_lessons(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 course_id uuid NOT NULL REFERENCES lms_courses(id), position integer NOT NULL CHECK(position >= 0),
 title text NOT NULL CHECK(length(title) BETWEEN 2 AND 140),
 type text NOT NULL CHECK(type IN ('TEXT','VIDEO','PDF','QUIZ')),
 body text NOT NULL DEFAULT '' CHECK(length(body) <= 20000),
 video_url text CHECK(video_url IS NULL OR video_url ~ '^https://'),
 duration_minutes integer NOT NULL DEFAULT 5 CHECK(duration_minutes BETWEEN 1 AND 600),
 pass_mark integer CHECK(pass_mark IS NULL OR pass_mark BETWEEN 1 AND 100),
 max_attempts integer CHECK(max_attempts IS NULL OR max_attempts BETWEEN 1 AND 20),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 -- Lessons are soft-deleted so learner progress and quiz history keep their references.
 deleted_at timestamptz
);
ALTER TABLE lms_lessons ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
-- Course outline in order.
CREATE INDEX IF NOT EXISTS lms_lessons_outline ON lms_lessons(organization_id,course_id,position,id);

CREATE TABLE IF NOT EXISTS lms_questions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 lesson_id uuid NOT NULL REFERENCES lms_lessons(id), position integer NOT NULL CHECK(position >= 0),
 prompt text NOT NULL CHECK(length(prompt) BETWEEN 3 AND 1000),
 kind text NOT NULL CHECK(kind IN ('SINGLE','MULTI')),
 -- [{ "id": "a", "text": "..." }]; correct holds option ids and is never sent to learners before grading.
 options jsonb NOT NULL, correct jsonb NOT NULL, explanation text NOT NULL DEFAULT '' CHECK(length(explanation) <= 1000)
);
-- Questions of one quiz in order.
CREATE INDEX IF NOT EXISTS lms_questions_quiz ON lms_questions(organization_id,lesson_id,position);

CREATE TABLE IF NOT EXISTS lms_enrollments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 course_id uuid NOT NULL REFERENCES lms_courses(id), employee_id uuid NOT NULL REFERENCES employees(id),
 source text NOT NULL CHECK(source IN ('SELF','ASSIGNED','MANDATORY')), assigned_by uuid REFERENCES employees(id),
 due_date date, status text NOT NULL DEFAULT 'NOT_STARTED' CHECK(status IN ('NOT_STARTED','IN_PROGRESS','COMPLETED')),
 progress_pct integer NOT NULL DEFAULT 0 CHECK(progress_pct BETWEEN 0 AND 100),
 last_lesson_id uuid REFERENCES lms_lessons(id), started_at timestamptz, completed_at timestamptz, reminded_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,course_id,employee_id)
);
-- "My learning" for one employee.
CREATE INDEX IF NOT EXISTS lms_enrollments_learner ON lms_enrollments(organization_id,employee_id,status,due_date);
-- Course analytics / roster and due-date reminder sweeps.
CREATE INDEX IF NOT EXISTS lms_enrollments_course ON lms_enrollments(organization_id,course_id,status,due_date);

CREATE TABLE IF NOT EXISTS lms_lesson_progress(
 organization_id uuid NOT NULL REFERENCES organizations(id),
 enrollment_id uuid NOT NULL REFERENCES lms_enrollments(id), lesson_id uuid NOT NULL REFERENCES lms_lessons(id),
 completed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(enrollment_id,lesson_id)
);

CREATE TABLE IF NOT EXISTS lms_quiz_attempts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 enrollment_id uuid NOT NULL REFERENCES lms_enrollments(id), lesson_id uuid NOT NULL REFERENCES lms_lessons(id),
 answers jsonb NOT NULL, score integer NOT NULL CHECK(score BETWEEN 0 AND 100), passed boolean NOT NULL,
 voided_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
-- Attempts per learner per quiz (attempt limits, best score).
CREATE INDEX IF NOT EXISTS lms_quiz_attempts_learner ON lms_quiz_attempts(organization_id,enrollment_id,lesson_id,created_at);

CREATE TABLE IF NOT EXISTS lms_certificates(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 enrollment_id uuid NOT NULL UNIQUE REFERENCES lms_enrollments(id), course_id uuid NOT NULL REFERENCES lms_courses(id),
 employee_id uuid NOT NULL REFERENCES employees(id), verification_code text NOT NULL,
 course_title text NOT NULL, employee_name text NOT NULL, course_version integer NOT NULL,
 score integer, issued_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,verification_code)
);
-- Certificates wallet per employee.
CREATE INDEX IF NOT EXISTS lms_certificates_employee ON lms_certificates(organization_id,employee_id,issued_at DESC);

ALTER TABLE lms_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms_lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms_lesson_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms_quiz_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms_certificates ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['lms_courses','lms_lessons','lms_questions','lms_enrollments','lms_lesson_progress','lms_quiz_attempts','lms_certificates'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(9) ON CONFLICT DO NOTHING;

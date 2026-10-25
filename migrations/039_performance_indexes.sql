-- Indexes found missing in the multi-brand load test (12 brands, ~6,800 users, ~280k punches).
-- Plain CREATE INDEX (migrations run in a transaction); every table here is small enough to index during a deploy.

-- Sign-in, OIDC linking, onboarding and the employee import all look users up by lower(email). The only index was the
-- case-sensitive UNIQUE (email), so each of those lookups scanned the whole (cross-tenant) users table.
CREATE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));

-- Per-brand "is this work email taken" checks (employee edit, onboarding, address generation) compare lower(work_email);
-- the UNIQUE (organization_id, work_email) constraint can't serve a lower() predicate.
CREATE INDEX IF NOT EXISTS employees_work_email_lower ON employees (organization_id, lower(work_email));

-- "Who are this brand's HR admins / owners" (job automations, punch guard, account access, erasure) filtered every
-- membership of the brand; admins are a handful of rows among thousands of members.
CREATE INDEX IF NOT EXISTS memberships_org_role_active ON organization_memberships (organization_id, role, user_id) WHERE status = 'ACTIVE';

-- Punch review history (?status=APPROVED|REJECTED): only reviewed punches, so the index stays small while
-- attendance_review_queue keeps serving the PENDING queue.
CREATE INDEX IF NOT EXISTS attendance_reviewed_history ON attendance_events (organization_id, review_status, occurred_at DESC)
  WHERE review_status IN ('APPROVED', 'REJECTED');

-- Employee register / directory page order (status, full_name, id): lets a page be read straight from the index instead of
-- sorting the brand's whole register for every request (24 ms → 3 ms at 3,000 employees, once the total is counted
-- separately rather than with count(*) OVER()).
CREATE INDEX IF NOT EXISTS employees_register_order ON employees (organization_id, status, full_name, id);

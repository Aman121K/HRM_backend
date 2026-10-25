-- ISO 27001 / SOC 2 support: tamper-evident audit trail, control tracking, immutable evidence, access reviews and
-- policy acknowledgements. Compliance tables are platform-wide (the certification covers the service, not one brand):
-- only the owner role used by the platform API touches them; the runtime role has no access.

-- 1. Hash-chained audit log (ISO 27001 A.8.15, SOC 2 CC7.2) ------------------------------------------------------
-- Each brand's audit entries form a chain: row_hash = sha256(prev_hash | canonical row). Editing or deleting a row in
-- the middle breaks every later link, which the compliance verifier reports. The append-only trigger (021) still applies.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS chain_seq bigint;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS row_hash text;

CREATE OR REPLACE FUNCTION audit_row_digest(prev text, seq bigint, org uuid, actor uuid, action text, entity_type text,
                                            entity_id uuid, before_data jsonb, after_data jsonb, created_at timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws('|', coalesce(prev, ''), seq::text, org::text, actor::text, action, entity_type,
    entity_id::text, coalesce(before_data::text, ''), coalesce(after_data::text, ''),
    ((extract(epoch FROM created_at) * 1000000)::bigint)::text), 'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last record;
BEGIN
  -- One writer per brand chain at a time; the lock is released at commit.
  PERFORM pg_advisory_xact_lock(hashtextextended('audit_chain:' || NEW.organization_id::text, 0));
  SELECT chain_seq, row_hash INTO last FROM audit_log
   WHERE organization_id = NEW.organization_id AND chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1;
  NEW.created_at := coalesce(NEW.created_at, now());
  NEW.chain_seq := coalesce(last.chain_seq, 0) + 1;
  NEW.prev_hash := coalesce(last.row_hash, '');
  NEW.row_hash := audit_row_digest(NEW.prev_hash, NEW.chain_seq, NEW.organization_id, NEW.actor_user_id, NEW.action,
    NEW.entity_type, NEW.entity_id, NEW.before_data, NEW.after_data, NEW.created_at);
  RETURN NEW;
END $$;

-- Backfill existing rows in id order (needs the append-only trigger off for this one-time migration).
DO $$
DECLARE r record; prev text; seq bigint; org uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM audit_log WHERE row_hash IS NULL) THEN
    ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update;
    FOR org IN SELECT DISTINCT organization_id FROM audit_log LOOP
      SELECT chain_seq, row_hash INTO seq, prev FROM audit_log WHERE organization_id = org AND row_hash IS NOT NULL ORDER BY chain_seq DESC LIMIT 1;
      seq := coalesce(seq, 0); prev := coalesce(prev, '');
      FOR r IN SELECT * FROM audit_log WHERE organization_id = org AND row_hash IS NULL ORDER BY id LOOP
        seq := seq + 1;
        UPDATE audit_log SET chain_seq = seq, prev_hash = prev,
          row_hash = audit_row_digest(prev, seq, r.organization_id, r.actor_user_id, r.action, r.entity_type, r.entity_id, r.before_data, r.after_data, r.created_at)
         WHERE id = r.id RETURNING row_hash INTO prev;
      END LOOP;
    END LOOP;
    ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update;
  END IF;
END $$;

DROP TRIGGER IF EXISTS audit_log_chain ON audit_log;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_chain();
CREATE UNIQUE INDEX IF NOT EXISTS audit_chain_order ON audit_log(organization_id, chain_seq);

-- 2. Control status (manual part of each control) -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compliance_control_state(
 framework text NOT NULL CHECK (framework IN ('iso27001','soc2')),
 control_id text NOT NULL,
 status text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','implemented','not_applicable')),
 owner text, notes text,
 updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 version integer NOT NULL DEFAULT 1,
 PRIMARY KEY (framework, control_id)
);

-- 3. Evidence: automated check results and manual uploads. Immutable once recorded. --------------------------------
CREATE TABLE IF NOT EXISTS compliance_evidence(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source text NOT NULL CHECK (source IN ('automated','manual')),
 check_id text,                                   -- automated: the check that produced it
 framework text, control_id text,                 -- manual: the control it supports
 title text NOT NULL, detail text,
 result text NOT NULL CHECK (result IN ('pass','warn','fail','info','manual')),
 link text, data jsonb NOT NULL DEFAULT '{}',
 sha256 text NOT NULL,                            -- digest of the evidence content, shown to auditors
 collection_id uuid,                              -- groups one collection run
 collected_by uuid REFERENCES users(id),
 collected_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((source = 'automated' AND check_id IS NOT NULL) OR (source = 'manual' AND framework IS NOT NULL AND control_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS compliance_evidence_check ON compliance_evidence(check_id, collected_at DESC) WHERE check_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS compliance_evidence_control ON compliance_evidence(framework, control_id, collected_at DESC) WHERE control_id IS NOT NULL;

CREATE OR REPLACE FUNCTION compliance_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.evidence_retention', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'compliance evidence is immutable' USING ERRCODE = 'insufficient_privilege';
END $$;
DROP TRIGGER IF EXISTS compliance_evidence_immutable ON compliance_evidence;
CREATE TRIGGER compliance_evidence_immutable BEFORE UPDATE OR DELETE ON compliance_evidence FOR EACH ROW EXECUTE FUNCTION compliance_evidence_immutable();

-- 4. User access reviews (ISO 27001 A.5.18, SOC 2 CC6.2/CC6.3) ----------------------------------------------------
CREATE TABLE IF NOT EXISTS access_reviews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 title text NOT NULL,
 status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
 due_at date NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 closed_by uuid REFERENCES users(id), closed_at timestamptz,
 summary jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS access_review_items(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 review_id uuid NOT NULL REFERENCES access_reviews(id),
 kind text NOT NULL CHECK (kind IN ('membership','platform_admin')),
 organization_id uuid REFERENCES organizations(id),
 user_id uuid NOT NULL REFERENCES users(id),
 role text NOT NULL,
 employee_status text, last_sign_in_at timestamptz,
 flags text[] NOT NULL DEFAULT '{}',              -- inactive_90d, never_signed_in, employee_inactive, privileged
 decision text CHECK (decision IN ('KEEP','REVOKE')),
 note text, decided_by uuid REFERENCES users(id), decided_at timestamptz,
 applied_at timestamptz,
 UNIQUE (review_id, kind, organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS access_review_items_review ON access_review_items(review_id);

-- 5. Policies and acknowledgements (ISO 27001 A.5.1/A.6.3, SOC 2 CC1.1/CC2.2) ------------------------------------
CREATE TABLE IF NOT EXISTS compliance_policies(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 key text NOT NULL, version integer NOT NULL,
 title text NOT NULL, summary text NOT NULL, body text NOT NULL,
 status text NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED','RETIRED')),
 published_by uuid REFERENCES users(id), published_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (key, version)
);
CREATE TABLE IF NOT EXISTS policy_acknowledgements(
 policy_id uuid NOT NULL REFERENCES compliance_policies(id),
 user_id uuid NOT NULL REFERENCES users(id),
 acknowledged_at timestamptz NOT NULL DEFAULT now(),
 client_ip text,
 PRIMARY KEY (policy_id, user_id)
);

INSERT INTO compliance_policies(key, version, title, summary, body) VALUES
('information-security', 1, 'Information Security Policy',
 'How we protect employee and company information in Northstar People.',
 E'1. Purpose\nEmployee records, payroll and attendance data are confidential. Everyone with access must protect them.\n\n2. Access\nUse only your own account. Never share your password or one-time codes. Access is granted for your role and reviewed every quarter; access you no longer need is removed.\n\n3. Handling data\nOpen, download or share employee data only when your work needs it. Do not copy payroll or personal data to personal devices, personal email or unapproved apps.\n\n4. Devices\nLock your screen when away, keep your device updated, and report a lost or stolen device to IT the same day.\n\n5. Incidents\nReport anything suspicious (phishing, unexpected access, data sent to the wrong person) to security immediately. Early reporting is never punished.\n\n6. Monitoring\nSign-ins and changes are logged in a tamper-evident audit trail to protect you and the company.\n\n7. Breaches of this policy may lead to disciplinary action.'),
('acceptable-use', 1, 'Acceptable Use Policy',
 'What is and is not allowed when using company systems.',
 E'Allowed: using Northstar People for your attendance, leave, payslips, requests and learning, and for the HR or manager duties your role includes.\n\nNot allowed:\n- looking up colleagues\' salaries, documents or personal details without a work reason;\n- signing in for someone else or marking attendance on their behalf;\n- attempting to bypass security controls, scanning or testing the system without written approval;\n- uploading malicious, offensive or unlicensed content.\n\nIf you are unsure whether something is allowed, ask your manager or HR first.'),
('data-protection', 1, 'Data Protection & Privacy Notice',
 'What personal data we process about you and why (DPDP Act 2023).',
 E'We process your identity, contact, employment, attendance (including location and selfie at punch time where enabled), leave, payroll, bank and statutory details to run employment, pay you and meet legal duties.\n\nPunch selfies are kept only for the retention period your company sets and then deleted automatically. Access is limited by role and every access to sensitive records is logged.\n\nYou can ask HR to see or correct your data, and raise a grievance with the company\'s grievance officer. Data is stored in India-region infrastructure and is not sold or used for advertising.')
ON CONFLICT (key, version) DO NOTHING;

REVOKE ALL ON compliance_control_state, compliance_evidence, access_reviews, access_review_items, compliance_policies, policy_acknowledgements FROM hrm_runtime;
INSERT INTO schema_migrations(version) VALUES(24) ON CONFLICT DO NOTHING;

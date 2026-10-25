-- Selfie verification for GPS punches (buddy-punching deterrence) with face/liveness signals and manager review.
ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS selfie_file_id uuid;
ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS face_check jsonb;
ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'NONE';
ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS review_reasons text[] NOT NULL DEFAULT '{}';
ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES employees(id);
ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS review_note text;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='attendance_events_review_status_check') THEN
  ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_review_status_check CHECK (review_status IN ('NONE','PENDING','APPROVED','REJECTED'));
 END IF;
END $$;
-- Manager/HR review queue: pending punches per organization, newest first.
CREATE INDEX IF NOT EXISTS attendance_review_queue ON attendance_events(organization_id, review_status, occurred_at DESC) WHERE review_status='PENDING';

-- One attendance verification policy per organization.
CREATE TABLE IF NOT EXISTS attendance_policies(
 organization_id uuid PRIMARY KEY REFERENCES organizations(id),
 selfie_mode text NOT NULL DEFAULT 'OFF' CHECK (selfie_mode IN ('OFF','OUTSIDE_GEOFENCE','ALWAYS')),
 liveness_required boolean NOT NULL DEFAULT true,
 selfie_retention_days integer NOT NULL DEFAULT 90 CHECK (selfie_retention_days BETWEEN 7 AND 730),
 exempt_roles text[] NOT NULL DEFAULT '{}',
 version integer NOT NULL DEFAULT 1, updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE attendance_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON attendance_policies;
CREATE POLICY tenant_isolation ON attendance_policies USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);
INSERT INTO schema_migrations(version) VALUES(18) ON CONFLICT DO NOTHING;

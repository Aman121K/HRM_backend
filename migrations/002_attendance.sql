CREATE TABLE IF NOT EXISTS attendance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  event_type text NOT NULL CHECK (event_type IN ('IN','OUT')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  latitude numeric(10,7) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(10,7) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_metres numeric(8,2) NOT NULL CHECK (accuracy_metres > 0),
  location_captured_at timestamptz NOT NULL,
  timezone text,
  device_id text,
  permission text NOT NULL CHECK (permission = 'granted'),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, employee_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS attendance_employee_timeline
  ON attendance_events(organization_id,employee_id,occurred_at DESC,id);
CREATE INDEX IF NOT EXISTS attendance_daily_reporting
  ON attendance_events(organization_id,occurred_at,event_type,employee_id);
CREATE INDEX IF NOT EXISTS attendance_location_review
  ON attendance_events(organization_id,employee_id,accuracy_metres,occurred_at DESC);
ALTER TABLE attendance_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON attendance_events;
CREATE POLICY tenant_isolation ON attendance_events
  USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);
INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;

-- Attendance from several sources: mobile/web GPS punches, biometric devices and HR corrections.
-- GPS fields stay mandatory for MOBILE/WEB punches only; device punches carry the device serial instead.
ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'WEB';
ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS site_id uuid;
ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS distance_metres numeric(10,1);
ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS within_geofence boolean;
ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE attendance_events ALTER COLUMN latitude DROP NOT NULL;
ALTER TABLE attendance_events ALTER COLUMN longitude DROP NOT NULL;
ALTER TABLE attendance_events ALTER COLUMN accuracy_metres DROP NOT NULL;
ALTER TABLE attendance_events ALTER COLUMN location_captured_at DROP NOT NULL;
ALTER TABLE attendance_events ALTER COLUMN permission DROP NOT NULL;
ALTER TABLE attendance_events DROP CONSTRAINT IF EXISTS attendance_events_permission_check;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='attendance_events_source_check') THEN
  ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_source_check CHECK (source IN ('WEB','MOBILE','BIOMETRIC','MANUAL'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='attendance_events_gps_required') THEN
  ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_gps_required CHECK (
   source NOT IN ('WEB','MOBILE') OR (latitude IS NOT NULL AND longitude IS NOT NULL AND accuracy_metres IS NOT NULL
     AND location_captured_at IS NOT NULL AND permission = 'granted'));
 END IF;
END $$;

-- Work sites with a geofence radius; a punch records the nearest site and whether it was inside the fence.
CREATE TABLE IF NOT EXISTS attendance_sites(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 120), latitude numeric(10,7) NOT NULL CHECK(latitude BETWEEN -90 AND 90),
 longitude numeric(10,7) NOT NULL CHECK(longitude BETWEEN -180 AND 180), radius_metres integer NOT NULL DEFAULT 150 CHECK(radius_metres BETWEEN 25 AND 5000),
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,name)
);
ALTER TABLE attendance_sites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON attendance_sites;
CREATE POLICY tenant_isolation ON attendance_sites USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);
INSERT INTO schema_migrations(version) VALUES(11) ON CONFLICT DO NOTHING;

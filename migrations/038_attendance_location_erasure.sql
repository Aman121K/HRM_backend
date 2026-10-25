-- DPDP erasure: a WEB/MOBILE punch must carry a location when recorded, but once the employee's location data is erased
-- under the brand's retention policy the coordinates are removed entirely (not just coarsened). The erasure is
-- stamped so the "GPS required" rule still applies to every live punch.
ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS location_erased_at timestamptz;
ALTER TABLE attendance_events DROP CONSTRAINT IF EXISTS attendance_events_gps_required;
ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_gps_required CHECK (
  source NOT IN ('WEB','MOBILE') OR location_erased_at IS NOT NULL
  OR (latitude IS NOT NULL AND longitude IS NOT NULL AND accuracy_metres IS NOT NULL AND location_captured_at IS NOT NULL AND permission = 'granted'));
-- Rows erased earlier were coarsened to 0.1° with accuracy 11 km: finish the job.
UPDATE attendance_events SET latitude=NULL, longitude=NULL, accuracy_metres=NULL, location_captured_at=NULL, location_erased_at=now()
 WHERE source IN ('WEB','MOBILE') AND accuracy_metres = 11000 AND location_erased_at IS NULL;

-- Punch security chosen by HR: app/device binding (one device ↔ one employee), office network (public IP ranges) and
-- office Wi-Fi router MAC (BSSID, reported by the mobile app). Each is OFF, FLAG (record + send to review) or BLOCK.
ALTER TABLE attendance_policies ADD COLUMN IF NOT EXISTS device_binding text NOT NULL DEFAULT 'OFF' CHECK (device_binding IN ('OFF','FLAG','BLOCK'));
ALTER TABLE attendance_policies ADD COLUMN IF NOT EXISTS max_devices integer NOT NULL DEFAULT 1 CHECK (max_devices BETWEEN 1 AND 3);
ALTER TABLE attendance_policies ADD COLUMN IF NOT EXISTS device_approval text NOT NULL DEFAULT 'FIRST_AUTO' CHECK (device_approval IN ('FIRST_AUTO','ALWAYS_HR'));
ALTER TABLE attendance_policies ADD COLUMN IF NOT EXISTS office_network text NOT NULL DEFAULT 'OFF' CHECK (office_network IN ('OFF','FLAG','BLOCK'));
ALTER TABLE attendance_policies ADD COLUMN IF NOT EXISTS router_mac text NOT NULL DEFAULT 'OFF' CHECK (router_mac IN ('OFF','FLAG','BLOCK'));

-- Registered punch devices. The device key is never stored: web devices hold a non-extractable signing key (we keep its
-- public key), mobile devices hold a random secret in the Keychain/Keystore (we keep its SHA-256).
CREATE TABLE IF NOT EXISTS attendance_devices(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 employee_id uuid NOT NULL REFERENCES employees(id),
 key_hash text NOT NULL,                       -- sha256 of the public key (web) or device secret (mobile)
 public_key text,                              -- web: SPKI (base64) used to verify punch signatures
 platform text NOT NULL CHECK (platform IN ('WEB','ANDROID','IOS')),
 label text,                                   -- e.g. "Chrome on macOS", "Pixel 8"
 status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('ACTIVE','PENDING','REVOKED')),
 first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
 decided_by uuid REFERENCES users(id), decided_at timestamptz, note text,
 version integer NOT NULL DEFAULT 1
);
-- One device can be active for only one employee; an employee has at most one pending request per device.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_devices_one_owner ON attendance_devices(organization_id, key_hash) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS attendance_devices_one_request ON attendance_devices(organization_id, employee_id, key_hash) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS attendance_devices_employee ON attendance_devices(organization_id, employee_id, status);

-- Office networks: public IP ranges (CIDR) of the office internet and Wi-Fi router MACs (BSSID), optionally per site.
CREATE TABLE IF NOT EXISTS attendance_networks(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 kind text NOT NULL CHECK (kind IN ('IP_RANGE','WIFI_BSSID')),
 value text NOT NULL,
 label text,
 site_id uuid REFERENCES attendance_sites(id),
 created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (organization_id, kind, value),
 CHECK (kind <> 'IP_RANGE' OR value::cidr IS NOT NULL),
 CHECK (kind <> 'WIFI_BSSID' OR value ~ '^([0-9a-f]{2}:){5}[0-9a-f]{2}$')
);

ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS device_record_id uuid REFERENCES attendance_devices(id);
ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS client_ip inet;
ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS wifi_bssid text;

ALTER TABLE attendance_devices ENABLE ROW LEVEL SECURITY; ALTER TABLE attendance_devices FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance_networks ENABLE ROW LEVEL SECURITY; ALTER TABLE attendance_networks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON attendance_devices;
CREATE POLICY tenant_isolation ON attendance_devices
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
DROP POLICY IF EXISTS tenant_isolation ON attendance_networks;
CREATE POLICY tenant_isolation ON attendance_networks
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

INSERT INTO schema_migrations(version) VALUES(25) ON CONFLICT DO NOTHING;

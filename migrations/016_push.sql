-- Push notifications: device registry, per-employee preferences, in-app read state, and the push queue + delivery log
-- fed from workflow_events by the notifications.push_fanout job (see backend/src/platform/notifications).

-- Mobile devices that receive pushes. A token belongs to one user in one organization; re-registering it from another
-- account re-binds it (upsert on organization_id+provider+token_hash). Tokens are stored in full (providers need them)
-- but never returned by the API or written to logs; token_hash is the lookup key.
CREATE TABLE IF NOT EXISTS push_devices(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 user_id uuid NOT NULL REFERENCES users(id), employee_id uuid NOT NULL REFERENCES employees(id),
 platform text NOT NULL CHECK(platform IN ('ios','android')), provider text NOT NULL CHECK(provider IN ('apns','fcm')),
 token text NOT NULL CHECK(length(token) BETWEEN 8 AND 4096), token_hash char(64) NOT NULL,
 environment text NOT NULL DEFAULT 'production' CHECK(environment IN ('sandbox','production','simulator')),
 app_version text, device_name text, bundle_id text,
 active boolean NOT NULL DEFAULT true, deactivated_at timestamptz, deactivated_reason text,
 last_seen_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,provider,token_hash)
);
-- Fan-out looks up the active devices of one recipient; the settings screen lists one employee's devices.
CREATE INDEX IF NOT EXISTS push_devices_recipient ON push_devices(organization_id,employee_id) WHERE active;

-- One row per employee; absent row = defaults (every category on, quiet hours off, push on, email off).
CREATE TABLE IF NOT EXISTS notification_preferences(
 organization_id uuid NOT NULL REFERENCES organizations(id), employee_id uuid NOT NULL REFERENCES employees(id),
 categories jsonb NOT NULL DEFAULT '{}', quiet_enabled boolean NOT NULL DEFAULT false,
 quiet_start time NOT NULL DEFAULT '22:00', quiet_end time NOT NULL DEFAULT '07:00', timezone text NOT NULL DEFAULT 'Asia/Kolkata',
 channel_push boolean NOT NULL DEFAULT true, channel_email boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,employee_id)
);

-- In-app read state: a read-through cursor ("mark all read") plus individually read events above it.
CREATE TABLE IF NOT EXISTS notification_read_cursors(
 organization_id uuid NOT NULL REFERENCES organizations(id), employee_id uuid NOT NULL REFERENCES employees(id),
 read_through bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,employee_id)
);
CREATE TABLE IF NOT EXISTS notification_reads(
 organization_id uuid NOT NULL REFERENCES organizations(id), employee_id uuid NOT NULL REFERENCES employees(id),
 event_id bigint NOT NULL, read_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,employee_id,event_id)
);

-- Per-organization position in workflow_events already turned into pushes.
CREATE TABLE IF NOT EXISTS push_fanout_cursors(
 organization_id uuid PRIMARY KEY REFERENCES organizations(id), last_event_id bigint NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now()
);

-- The push queue. EVENT rows mirror one workflow_event; SUMMARY rows replace a burst; TEST rows come from test-push.
-- SUPPRESSED rows record why nothing was sent (preferences, quiet hours, no devices) so suppression is auditable.
CREATE TABLE IF NOT EXISTS push_notifications(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 employee_id uuid NOT NULL REFERENCES employees(id), kind text NOT NULL CHECK(kind IN ('EVENT','SUMMARY','TEST')),
 event_id bigint, category text NOT NULL, title text NOT NULL, body text NOT NULL, data jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL CHECK(status IN ('PENDING','SENDING','SENT','PARTIAL','FAILED','SUPPRESSED','COLLAPSED','NO_DEVICES')),
 reason text, collapsed_into bigint, send_after timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
-- Delivery sweep: due PENDING rows (and stale SENDING rows to recover after a crash).
CREATE INDEX IF NOT EXISTS push_notifications_due ON push_notifications(organization_id,status,send_after,id) WHERE status IN ('PENDING','SENDING');
-- Exactly one queue row per workflow event (fan-out is idempotent: re-scans skip events already queued).
CREATE UNIQUE INDEX IF NOT EXISTS push_notifications_event ON push_notifications(organization_id,event_id) WHERE kind='EVENT';
-- Burst detection counts one recipient's recent pushes.
CREATE INDEX IF NOT EXISTS push_notifications_recipient_recent ON push_notifications(organization_id,employee_id,created_at DESC);

-- Every provider attempt, with the provider's answer (never the full token).
CREATE TABLE IF NOT EXISTS push_deliveries(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 notification_id bigint NOT NULL REFERENCES push_notifications(id) ON DELETE CASCADE, device_id uuid NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
 provider text NOT NULL, outcome text NOT NULL CHECK(outcome IN ('SENT','RETRY','FAILED','INVALID_TOKEN')),
 http_status integer, provider_message_id text, response jsonb, error text, duration_ms integer,
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Delivery history per notification (test-push results, support look-ups).
CREATE INDEX IF NOT EXISTS push_deliveries_notification ON push_deliveries(organization_id,notification_id);
-- Delivery history per device (settings screen "last delivered").
CREATE INDEX IF NOT EXISTS push_deliveries_device ON push_deliveries(organization_id,device_id,created_at DESC);

ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_read_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_fanout_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_deliveries ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['push_devices','notification_preferences','notification_read_cursors','notification_reads','push_fanout_cursors','push_notifications','push_deliveries'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(16) ON CONFLICT DO NOTHING;

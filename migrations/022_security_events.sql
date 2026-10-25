-- Security telemetry: denied/failed requests aggregated per minute per (client, reason, route) so attacks are visible
-- without flooding the database. Cross-tenant by nature (many events have no brand yet); only the owner role and the
-- platform API read it.
CREATE TABLE IF NOT EXISTS security_events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 bucket timestamptz NOT NULL,                     -- minute bucket
 organization_id uuid REFERENCES organizations(id),
 user_id uuid REFERENCES users(id),
 client_ip text NOT NULL, status integer NOT NULL, reason text NOT NULL, method text NOT NULL, route text NOT NULL,
 user_agent_hash text, count integer NOT NULL DEFAULT 1, first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
 UNIQUE (bucket, client_ip, status, reason, method, route, organization_id, user_id)
);
-- Recent activity and per-brand views in the Security Center.
CREATE INDEX IF NOT EXISTS security_events_recent ON security_events(last_seen DESC);
CREATE INDEX IF NOT EXISTS security_events_org ON security_events(organization_id, last_seen DESC) WHERE organization_id IS NOT NULL;
REVOKE ALL ON security_events FROM hrm_runtime;
INSERT INTO schema_migrations(version) VALUES(22) ON CONFLICT DO NOTHING;

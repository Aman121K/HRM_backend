-- Memberships are brand data too. Identity resolution and the brand switcher read them through the owner role
-- (AuthService pool / systemQuery); every tenant-scoped read or write now goes through RLS like other tables.
ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON organization_memberships;
CREATE POLICY tenant_isolation ON organization_memberships USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);
INSERT INTO schema_migrations(version) VALUES(23) ON CONFLICT DO NOTHING;

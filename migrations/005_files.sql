-- Tenant-scoped file attachments (receipts, letters, onboarding documents, payroll exports).
-- Bytes live in object storage (local disk in development); this table holds metadata and ownership.
CREATE TABLE IF NOT EXISTS stored_files(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 entity_type text NOT NULL CHECK(entity_type ~ '^[a-z_]{2,40}$'), entity_id uuid NOT NULL,
 category text NOT NULL DEFAULT 'ATTACHMENT' CHECK(category ~ '^[A-Z0-9_]{2,40}$'),
 original_name text NOT NULL CHECK(length(original_name) BETWEEN 1 AND 180),
 mime_type text NOT NULL, byte_size integer NOT NULL CHECK(byte_size > 0), sha256 char(64) NOT NULL,
 storage_key text NOT NULL, uploaded_by uuid NOT NULL REFERENCES employees(id),
 created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
-- Attachments listed per record (the only hot read path).
CREATE INDEX IF NOT EXISTS stored_files_entity ON stored_files(organization_id,entity_type,entity_id,created_at) WHERE deleted_at IS NULL;
ALTER TABLE stored_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON stored_files;
CREATE POLICY tenant_isolation ON stored_files USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);
INSERT INTO schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;

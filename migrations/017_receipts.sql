-- Receipt OCR scans (backend/src/platform/receipts). The image/PDF itself is a stored_files row
-- (entity_type 'receipt_scan', entity_id = receipt_scans.id) until it is attached to an expenses case.
CREATE TABLE IF NOT EXISTS receipt_scans(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 employee_id uuid NOT NULL REFERENCES employees(id), file_id uuid NOT NULL REFERENCES stored_files(id),
 sha256 char(64) NOT NULL, mime_type text NOT NULL,
 provider text NOT NULL CHECK(provider IN ('tesseract','anthropic','pdf-text')),
 confidence numeric(4,3) NOT NULL DEFAULT 0 CHECK(confidence BETWEEN 0 AND 1),
 fields jsonb NOT NULL DEFAULT '{}', lines jsonb NOT NULL DEFAULT '[]', warnings jsonb NOT NULL DEFAULT '[]',
 duplicate_of jsonb, raw_text text,
 status text NOT NULL DEFAULT 'SCANNED' CHECK(status IN ('SCANNED','ATTACHED')),
 attached_case_id uuid REFERENCES hr_cases(id), attached_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Duplicate detection: has anyone in the organization scanned these exact bytes before?
CREATE INDEX IF NOT EXISTS receipt_scans_sha ON receipt_scans(organization_id,sha256);
-- An employee's recent scans (history / retention sweeps).
CREATE INDEX IF NOT EXISTS receipt_scans_employee ON receipt_scans(organization_id,employee_id,created_at DESC);
ALTER TABLE receipt_scans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON receipt_scans;
CREATE POLICY tenant_isolation ON receipt_scans USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);
INSERT INTO schema_migrations(version) VALUES(17) ON CONFLICT DO NOTHING;

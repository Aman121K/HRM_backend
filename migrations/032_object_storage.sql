-- Files can live on local disk (development) or in S3 (production). Each row remembers where its bytes are, so
-- files can be migrated to S3 gradually (backend/scripts/migrate-files-to-s3.mjs) without breaking downloads.
ALTER TABLE stored_files ADD COLUMN IF NOT EXISTS storage_driver text NOT NULL DEFAULT 'local';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stored_files_storage_driver_check') THEN
    ALTER TABLE stored_files ADD CONSTRAINT stored_files_storage_driver_check CHECK (storage_driver IN ('local','s3'));
  END IF;
  -- Every key must sit inside its own company's folder: tenants/<organization_id>/... (or the legacy <organization_id>/...).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stored_files_key_in_tenant_prefix') THEN
    ALTER TABLE stored_files ADD CONSTRAINT stored_files_key_in_tenant_prefix CHECK (
      storage_key = '' OR storage_key LIKE 'tenants/' || organization_id::text || '/%' OR storage_key LIKE organization_id::text || '/%') NOT VALID;
  END IF;
END $$;
ALTER TABLE stored_files VALIDATE CONSTRAINT stored_files_key_in_tenant_prefix;
INSERT INTO schema_migrations(version) VALUES(32) ON CONFLICT DO NOTHING;

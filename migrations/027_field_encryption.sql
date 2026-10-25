-- 027: field-level encryption for statutory and bank identifiers.
-- Adds <col>_enc (AES-256-GCM ciphertext "v1:<kid>:<iv>:<tag>:<ct>", bound to table/column/brand/row),
-- <col>_hash (keyed HMAC blind index, per brand) and <col>_last4 (display hint for masks).
-- Backfill runs in the application (it needs the keys): node backend/scripts/encrypt-sensitive-fields.mjs
-- The plaintext columns are removed by 028_drop_plaintext_pii.sql, which refuses to run before the backfill is complete.

ALTER TABLE payroll_profiles
  ADD COLUMN IF NOT EXISTS pan_enc text, ADD COLUMN IF NOT EXISTS pan_hash text, ADD COLUMN IF NOT EXISTS pan_last4 text,
  ADD COLUMN IF NOT EXISTS uan_enc text, ADD COLUMN IF NOT EXISTS uan_hash text, ADD COLUMN IF NOT EXISTS uan_last4 text,
  ADD COLUMN IF NOT EXISTS esi_number_enc text, ADD COLUMN IF NOT EXISTS esi_number_hash text, ADD COLUMN IF NOT EXISTS esi_number_last4 text,
  ADD COLUMN IF NOT EXISTS bank_account_enc text, ADD COLUMN IF NOT EXISTS bank_account_hash text, ADD COLUMN IF NOT EXISTS bank_account_last4 text;

ALTER TABLE onboarding_joiners
  ADD COLUMN IF NOT EXISTS pan_enc text, ADD COLUMN IF NOT EXISTS pan_hash text, ADD COLUMN IF NOT EXISTS pan_last4 text;

DO $$
DECLARE c text;
BEGIN
  FOREACH c IN ARRAY ARRAY['pan','uan','esi_number','bank_account'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_profiles_' || c || '_enc_format') THEN
      EXECUTE format('ALTER TABLE payroll_profiles ADD CONSTRAINT %I CHECK (%I IS NULL OR %I ~ %L)',
        'payroll_profiles_' || c || '_enc_format', c || '_enc', c || '_enc', '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$');
      EXECUTE format('ALTER TABLE payroll_profiles ADD CONSTRAINT %I CHECK (%I IS NULL OR length(%I) = 4)',
        'payroll_profiles_' || c || '_last4_len', c || '_last4', c || '_last4');
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'onboarding_joiners_pan_enc_format') THEN
    ALTER TABLE onboarding_joiners ADD CONSTRAINT onboarding_joiners_pan_enc_format
      CHECK (pan_enc IS NULL OR pan_enc ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$');
  END IF;
END $$;

-- Equality lookups by blind index (duplicate PAN within a brand, shared bank accounts).
CREATE INDEX IF NOT EXISTS payroll_profiles_pan_hash ON payroll_profiles(organization_id, pan_hash) WHERE pan_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS payroll_profiles_bank_hash ON payroll_profiles(organization_id, bank_account_hash) WHERE bank_account_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS onboarding_joiners_pan_hash ON onboarding_joiners(organization_id, pan_hash) WHERE pan_hash IS NOT NULL;

INSERT INTO schema_migrations(version) VALUES(27) ON CONFLICT DO NOTHING;

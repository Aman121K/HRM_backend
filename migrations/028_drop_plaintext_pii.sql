-- 028: remove plaintext statutory identifiers once 027 + backend/scripts/encrypt-sensitive-fields.mjs have encrypted them.
-- Guarded: aborts (nothing dropped) if any plaintext value has no ciphertext yet. Idempotent.
--

DO $$
DECLARE pending int := 0; c text;
BEGIN
  FOREACH c IN ARRAY ARRAY['pan','uan','esi_number','bank_account'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payroll_profiles' AND column_name=c) THEN
      EXECUTE format('SELECT count(*) FROM payroll_profiles WHERE %I IS NOT NULL AND %I <> %L AND %I IS NULL', c, c, '', c || '_enc') INTO pending;
      IF pending > 0 THEN RAISE EXCEPTION 'payroll_profiles.%: % plaintext value(s) not encrypted yet — run node backend/scripts/encrypt-sensitive-fields.mjs first', c, pending; END IF;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='onboarding_joiners' AND column_name='pan_number') THEN
    SELECT count(*) INTO pending FROM onboarding_joiners WHERE pan_number IS NOT NULL AND pan_number <> '' AND pan_enc IS NULL;
    IF pending > 0 THEN RAISE EXCEPTION 'onboarding_joiners.pan_number: % value(s) not encrypted yet', pending; END IF;
  END IF;
END $$;

ALTER TABLE payroll_profiles DROP COLUMN IF EXISTS pan, DROP COLUMN IF EXISTS uan, DROP COLUMN IF EXISTS esi_number;
ALTER TABLE onboarding_joiners DROP COLUMN IF EXISTS pan_number;

-- bank_account: payouts (integrations/payouts.service.ts) and risk loaders now read loadBankDetails()/bank_account_hash,
-- so the plaintext column is dropped unconditionally (the guard above already proved every value has ciphertext).
-- (Originally behind a psql `-v drop_bank_account=1` switch; rewritten as plain SQL so backend/scripts/migrate.mjs can
-- run it on a fresh database. Every existing environment had already dropped the column.)
ALTER TABLE payroll_profiles DROP COLUMN IF EXISTS bank_account;

INSERT INTO schema_migrations(version) VALUES(28) ON CONFLICT DO NOTHING;

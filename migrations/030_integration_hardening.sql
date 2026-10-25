-- 030: integration hardening (security audit F22).
-- Inbound payout-provider webhooks are verified (HMAC over a signed timestamp, ±5 min) and recorded here once, so a
-- captured request replayed later is acknowledged without effect. Webhooks arrive before any tenant is known (like
-- integration_device_nonces), so this is a platform table: no organization_id, accessed only through the owner role
-- (systemQuery); the least-privilege runtime role gets no access at all.
CREATE TABLE IF NOT EXISTS payout_webhook_receipts(
  id bigserial PRIMARY KEY,
  signature_hash text NOT NULL CHECK (signature_hash ~ '^[0-9a-f]{64}$'),
  event_id text CHECK (event_id IS NULL OR length(event_id) BETWEEN 1 AND 120),
  event_type text,
  signed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payout_webhook_receipts_signature ON payout_webhook_receipts(signature_hash);
CREATE UNIQUE INDEX IF NOT EXISTS payout_webhook_receipts_event ON payout_webhook_receipts(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payout_webhook_receipts_received ON payout_webhook_receipts(received_at);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hrm_runtime') THEN
    EXECUTE 'REVOKE ALL ON payout_webhook_receipts FROM hrm_runtime';
    EXECUTE 'REVOKE ALL ON SEQUENCE payout_webhook_receipts_id_seq FROM hrm_runtime';
  END IF;
END $$;

-- Payout bank-detail fingerprints move from sha256(org:<plaintext account>:ifsc) to sha256(org:<bank_account_hash>:ifsc)
-- (the plaintext column is being dropped). Only rows whose old fingerprint still matches the CURRENT profile are
-- converted, so a batch whose bank details changed since creation keeps failing the "bank details changed" check.
-- Runs only while the plaintext column still exists; a no-op afterwards (idempotent).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payroll_profiles' AND column_name='bank_account') THEN
    UPDATE payout_items i
       SET account_fingerprint = encode(sha256(convert_to(i.organization_id::text || ':' || p.bank_account_hash || ':' || p.ifsc, 'UTF8')), 'hex')
      FROM payroll_profiles p
     WHERE p.organization_id = i.organization_id AND p.employee_id = i.employee_id
       AND p.bank_account IS NOT NULL AND p.bank_account_hash IS NOT NULL AND p.ifsc IS NOT NULL
       AND i.account_fingerprint = encode(sha256(convert_to(i.organization_id::text || ':' || p.bank_account || ':' || p.ifsc, 'UTF8')), 'hex');
  END IF;
END $$;

-- Risk "shared bank account" signals are keyed by the account fingerprint. The detector now uses the blind index
-- (bank_account_hash:IFSC) instead of an md5 of the plaintext; re-key open/acknowledged/dismissed signals so their
-- status and history carry over instead of being auto-resolved and re-created. Only while the plaintext column exists.
DO $$
DECLARE org uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payroll_profiles' AND column_name='bank_account')
     AND to_regclass('public.risk_signals') IS NOT NULL THEN
    FOR org IN SELECT id FROM organizations LOOP
      PERFORM set_config('app.organization_id', org::text, true);
      UPDATE risk_signals s SET subject_key = m.new_key
        FROM (SELECT DISTINCT md5(organization_id::text || ':risk-bank:' || regexp_replace(bank_account,'[^0-9A-Za-z]','','g') || ':' || upper(coalesce(ifsc,''))) AS old_key,
                              bank_account_hash || ':' || upper(coalesce(ifsc,'')) AS new_key
                FROM payroll_profiles WHERE organization_id = org AND bank_account IS NOT NULL AND bank_account_hash IS NOT NULL) m
       WHERE s.organization_id = org AND s.detector = 'payroll.duplicate_bank' AND s.subject_key = m.old_key
         AND NOT EXISTS (SELECT 1 FROM risk_signals x WHERE x.organization_id = org AND x.detector = s.detector AND x.subject_key = m.new_key);
    END LOOP;
    PERFORM set_config('app.organization_id', '', true);
  END IF;
END $$;

INSERT INTO schema_migrations(version) VALUES(30) ON CONFLICT DO NOTHING;

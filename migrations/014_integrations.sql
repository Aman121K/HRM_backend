-- Integrations: biometric attendance devices, accounting (Tally / ERP) exports, bank payouts and outgoing webhooks.
-- Secrets (device keys, webhook signing keys) are never stored: the server derives them from INTEGRATIONS_MASTER_KEY
-- and a per-record random salt, and keeps only a SHA-256 hash to confirm what was shown once to the admin.
-- Bank adapter credentials live in the environment only; account numbers are stored masked (last 4) plus a fingerprint.

-- ------------------------------------------------------------------ biometric devices
CREATE TABLE IF NOT EXISTS integration_devices(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 serial_number text NOT NULL CHECK(serial_number ~ '^[A-Za-z0-9._-]{4,40}$'),
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 80),
 vendor text NOT NULL CHECK(vendor IN ('ZKTECO','ESSL','MANTRA','GENERIC')),
 site_id uuid REFERENCES attendance_sites(id), timezone text NOT NULL DEFAULT 'Asia/Kolkata',
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED','REVOKED')),
 secret_salt text, secret_hash text, secret_rotated_at timestamptz,
 last_seen_at timestamptz, last_ip text, last_punch_at timestamptz, firmware text, protocol text,
 created_by uuid NOT NULL REFERENCES employees(id), version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status = 'REVOKED' OR (secret_salt IS NOT NULL AND secret_hash IS NOT NULL))
);
-- Devices authenticate by serial number alone before a tenant is known (ADMS push), so serials are globally unique.
CREATE UNIQUE INDEX IF NOT EXISTS integration_devices_serial ON integration_devices(upper(serial_number));
-- Device registry list per organization.
CREATE INDEX IF NOT EXISTS integration_devices_org ON integration_devices(organization_id, name);

-- Employee ↔ device enrolment ID (PIN). device_id NULL = the PIN is valid on every device of the organization.
CREATE TABLE IF NOT EXISTS integration_device_users(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 device_id uuid REFERENCES integration_devices(id), device_user_id text NOT NULL CHECK(device_user_id ~ '^[A-Za-z0-9_-]{1,24}$'),
 employee_id uuid NOT NULL REFERENCES employees(id), created_by uuid NOT NULL REFERENCES employees(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Resolves a punch's PIN (device-specific mapping first, then org-wide); also prevents duplicate PINs.
CREATE UNIQUE INDEX IF NOT EXISTS integration_device_users_pin
 ON integration_device_users(organization_id, device_user_id, coalesce(device_id, '00000000-0000-0000-0000-000000000000'::uuid));
-- Mapping screen lists and "which PINs does this employee have".
CREATE INDEX IF NOT EXISTS integration_device_users_employee ON integration_device_users(organization_id, employee_id);

-- Every punch a device sent (ingestion log). UNMATCHED rows form the queue HR resolves by mapping + replay.
CREATE TABLE IF NOT EXISTS integration_device_punches(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 device_id uuid NOT NULL REFERENCES integration_devices(id), external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 80),
 device_user_id text NOT NULL, occurred_at timestamptz NOT NULL, punch_type text CHECK(punch_type IN ('IN','OUT')),
 verify_mode text, raw jsonb NOT NULL DEFAULT '{}', protocol text NOT NULL CHECK(protocol IN ('JSON','ADMS')),
 status text NOT NULL CHECK(status IN ('RECORDED','UNMATCHED','IGNORED','REJECTED')),
 employee_id uuid REFERENCES employees(id), attendance_event_id uuid, reason text,
 received_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, resolved_by uuid REFERENCES employees(id),
 -- Idempotency: a device never records the same punch twice.
 UNIQUE(device_id, external_id)
);
-- Unmatched queue (grouped by PIN) for HR.
CREATE INDEX IF NOT EXISTS integration_device_punches_unmatched ON integration_device_punches(organization_id, device_user_id, occurred_at) WHERE status = 'UNMATCHED';
-- Device health: recent punches per device.
CREATE INDEX IF NOT EXISTS integration_device_punches_recent ON integration_device_punches(device_id, received_at DESC);

-- Signatures seen inside the 5-minute replay window (rows older than the window are pruned on insert).
CREATE TABLE IF NOT EXISTS integration_device_nonces(
 device_id uuid NOT NULL REFERENCES integration_devices(id), signature text NOT NULL, seen_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(device_id, signature)
);

-- ------------------------------------------------------------------ accounting
CREATE TABLE IF NOT EXISTS accounting_settings(
 organization_id uuid PRIMARY KEY REFERENCES organizations(id),
 company_name text NOT NULL CHECK(length(company_name) BETWEEN 2 AND 120),
 ledgers jsonb NOT NULL DEFAULT '{}', journal_voucher_type text NOT NULL DEFAULT 'Journal',
 payment_voucher_type text NOT NULL DEFAULT 'Payment',
 version integer NOT NULL DEFAULT 1, updated_by uuid REFERENCES employees(id), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounting_exports(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 kind text NOT NULL CHECK(kind IN ('PAYROLL_JOURNAL','EXPENSE_PAYMENTS')), format text NOT NULL CHECK(format IN ('TALLY_XML','CSV')),
 run_id uuid REFERENCES payroll_runs(id), period text NOT NULL CHECK(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 file_name text NOT NULL, content text NOT NULL, checksum text NOT NULL, voucher_count integer NOT NULL, line_count integer NOT NULL,
 total_debit numeric(14,2) NOT NULL, total_credit numeric(14,2) NOT NULL CHECK(total_debit = total_credit),
 exported_by uuid NOT NULL REFERENCES employees(id), created_at timestamptz NOT NULL DEFAULT now()
);
-- Export history, newest first.
CREATE INDEX IF NOT EXISTS accounting_exports_history ON accounting_exports(organization_id, created_at DESC);

-- ------------------------------------------------------------------ bank payouts
CREATE TABLE IF NOT EXISTS payout_batches(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 run_id uuid NOT NULL REFERENCES payroll_runs(id), period text NOT NULL,
 adapter text NOT NULL CHECK(adapter IN ('H2H_GENERIC','H2H_BANK_CSV','API_RAZORPAYX')),
 mode text NOT NULL DEFAULT 'NEFT' CHECK(mode IN ('NEFT','IMPS','RTGS')),
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','RELEASED','PROCESSING','COMPLETED','PARTIAL','FAILED','CANCELLED')),
 run_net numeric(14,2) NOT NULL, total_amount numeric(14,2) NOT NULL, skipped_amount numeric(14,2) NOT NULL DEFAULT 0,
 payout_count integer NOT NULL, skipped_count integer NOT NULL DEFAULT 0, reference text NOT NULL,
 file_checksum text, created_by uuid NOT NULL REFERENCES employees(id), released_by uuid REFERENCES employees(id), released_at timestamptz,
 cancelled_by uuid REFERENCES employees(id), cancelled_at timestamptz,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 -- Maker-checker, enforced in the database as well as the service.
 CHECK(released_by IS NULL OR released_by <> created_by),
 -- Totals reconcile with the run: paid + skipped (unpayable but owed) = run net.
 CHECK(total_amount + skipped_amount = run_net)
);
-- At most one live batch per payroll run; also the lookup "batch for run".
CREATE UNIQUE INDEX IF NOT EXISTS payout_batches_live_run ON payout_batches(organization_id, run_id) WHERE status <> 'CANCELLED';
-- Batches list, newest first.
CREATE INDEX IF NOT EXISTS payout_batches_list ON payout_batches(organization_id, created_at DESC);
-- Sync job: batches with payouts still in flight.
CREATE INDEX IF NOT EXISTS payout_batches_in_flight ON payout_batches(status) WHERE status IN ('RELEASED','PROCESSING');

CREATE TABLE IF NOT EXISTS payout_items(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 batch_id uuid NOT NULL REFERENCES payout_batches(id), employee_id uuid NOT NULL REFERENCES employees(id),
 run_line_id uuid NOT NULL REFERENCES payroll_run_lines(id), amount numeric(14,2) NOT NULL CHECK(amount >= 0),
 status text NOT NULL CHECK(status IN ('SKIPPED','PENDING','QUEUED','PROCESSING','PROCESSED','FAILED','REVERSED')),
 skip_reason text, bank_name text, ifsc text, account_last4 text, account_fingerprint text,
 reference text NOT NULL, provider_payout_id text, utr text, failure_reason text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(batch_id, employee_id)
);
-- Batch detail rows (and per-status counts).
CREATE INDEX IF NOT EXISTS payout_items_batch ON payout_items(organization_id, batch_id, status);
-- Provider callbacks (inbound status webhook) look payouts up by the provider's id.
CREATE UNIQUE INDEX IF NOT EXISTS payout_items_provider ON payout_items(provider_payout_id) WHERE provider_payout_id IS NOT NULL;
-- H2H response files reference our payout reference.
CREATE UNIQUE INDEX IF NOT EXISTS payout_items_reference ON payout_items(organization_id, reference);

-- Status timeline for batches and individual payouts.
CREATE TABLE IF NOT EXISTS payout_events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 batch_id uuid NOT NULL REFERENCES payout_batches(id), item_id uuid REFERENCES payout_items(id),
 status text NOT NULL, note text, source text NOT NULL CHECK(source IN ('USER','SYNC','WEBHOOK','BANK_FILE','SYSTEM')),
 actor_id uuid REFERENCES employees(id), created_at timestamptz NOT NULL DEFAULT now()
);
-- Batch timeline.
CREATE INDEX IF NOT EXISTS payout_events_batch ON payout_events(organization_id, batch_id, id);

-- The built-in SANDBOX of the RazorpayX-style API adapter: it plays the bank's side and advances payouts over time.
CREATE TABLE IF NOT EXISTS payout_sandbox_payouts(
 id text PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), reference_id text NOT NULL,
 amount_paise bigint NOT NULL CHECK(amount_paise > 0), mode text NOT NULL, account_last4 text NOT NULL, ifsc text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','processed','failed','reversed')),
 utr text, failure_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 -- Idempotency key of the create call.
 UNIQUE(organization_id, reference_id)
);

-- ------------------------------------------------------------------ outgoing webhooks
CREATE TABLE IF NOT EXISTS webhook_subscriptions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 80), url text NOT NULL CHECK(length(url) BETWEEN 10 AND 500),
 event_types text[] NOT NULL CHECK(cardinality(event_types) > 0),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
 secret_salt text NOT NULL, secret_hash text NOT NULL, consecutive_failures integer NOT NULL DEFAULT 0,
 disabled_reason text, disabled_at timestamptz, last_delivery_at timestamptz, last_success_at timestamptz,
 created_by uuid NOT NULL REFERENCES employees(id), version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
-- Subscriptions list; fan-out of an event to active subscribers (event_types filtered in the query).
CREATE INDEX IF NOT EXISTS webhook_subscriptions_org ON webhook_subscriptions(organization_id, status);

CREATE TABLE IF NOT EXISTS webhook_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 event_type text NOT NULL, entity_type text, entity_id text, payload jsonb NOT NULL, source_audit_id bigint,
 occurred_at timestamptz NOT NULL DEFAULT now()
);
-- The audit-log scanner turns each audit row into at most one event.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_audit ON webhook_events(organization_id, source_audit_id) WHERE source_audit_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS webhook_deliveries(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 subscription_id uuid NOT NULL REFERENCES webhook_subscriptions(id), event_id uuid NOT NULL REFERENCES webhook_events(id),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RETRYING','SUCCEEDED','FAILED','SKIPPED')),
 attempts integer NOT NULL DEFAULT 0, is_test boolean NOT NULL DEFAULT false,
 response_code integer, response_ms integer, response_excerpt text, error text,
 last_attempt_at timestamptz, delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(subscription_id, event_id)
);
-- Delivery log per subscription, newest first.
CREATE INDEX IF NOT EXISTS webhook_deliveries_log ON webhook_deliveries(organization_id, subscription_id, created_at DESC);

-- Per-organization cursor of the audit-log scanner (last audit_log.id turned into events).
CREATE TABLE IF NOT EXISTS webhook_event_cursors(
 organization_id uuid PRIMARY KEY REFERENCES organizations(id), last_audit_id bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['integration_devices','integration_device_users','integration_device_punches','accounting_settings','accounting_exports',
   'payout_batches','payout_items','payout_events','payout_sandbox_payouts','webhook_subscriptions','webhook_events','webhook_deliveries','webhook_event_cursors'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(14) ON CONFLICT DO NOTHING;

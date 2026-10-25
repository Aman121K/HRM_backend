-- 037: SaaS billing (platform level). Plans, billing accounts (a brand or a brand group), subscriptions, daily usage
-- snapshots, GST tax invoices, credit notes, payments, reminders and the optional overdue-suspension policy.
--
-- Every table here is PLATFORM data (like compliance_*): the tenant runtime role (hrm_runtime) gets no privilege at all.
-- All reads/writes go through the owner pool (systemQuery / platformTransaction) in backend/src/platform/billing, gated by
-- platform_admins — except the brand-owner read path (/api/v2/orgs/billing/*), which checks an ACTIVE OWNER membership
-- and filters by the caller's own organization before reading (see billing.service.ts ownerAccounts()).
-- Money is stored in paise (bigint) so no rounding happens in the database.
-- Idempotent: safe to re-run.

-- 1. Operator (seller) settings — one row. NULL columns fall back to OPERATOR_* environment variables.
CREATE TABLE IF NOT EXISTS billing_settings(
 id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
 legal_name text, trade_name text, gstin text, pan text, address text, state_code text, email text, phone text,
 sac_code text NOT NULL DEFAULT '998315',
 gst_rate numeric(5,2) NOT NULL DEFAULT 18 CHECK (gst_rate >= 0 AND gst_rate <= 28),
 invoice_prefix text NOT NULL DEFAULT 'NS' CHECK (invoice_prefix ~ '^[A-Za-z0-9]{1,4}$'),
 credit_note_prefix text NOT NULL DEFAULT 'CN' CHECK (credit_note_prefix ~ '^[A-Za-z0-9]{1,4}$'),
 payment_terms_days integer NOT NULL DEFAULT 15 CHECK (payment_terms_days BETWEEN 0 AND 120),
 bank_details text,
 headcount_rule text NOT NULL DEFAULT 'ACTIVE_WITH_LOGIN' CHECK (headcount_rule IN ('ACTIVE_WITH_LOGIN','ALL_ACTIVE_EMPLOYEES')),
 auto_suspend_enabled boolean NOT NULL DEFAULT false,
 auto_suspend_after_days integer NOT NULL DEFAULT 30 CHECK (auto_suspend_after_days BETWEEN 7 AND 365),
 suspend_warning_days integer NOT NULL DEFAULT 7 CHECK (suspend_warning_days BETWEEN 1 AND 60),
 updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO billing_settings(id) VALUES (1) ON CONFLICT DO NOTHING;

-- 2. Plan catalogue.
CREATE TABLE IF NOT EXISTS billing_plans(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9-]{2,30}$'),
 name text NOT NULL, description text,
 pepm_paise bigint NOT NULL CHECK (pepm_paise >= 0),
 minimum_monthly_paise bigint NOT NULL DEFAULT 0 CHECK (minimum_monthly_paise >= 0),
 setup_fee_paise bigint NOT NULL DEFAULT 0 CHECK (setup_fee_paise >= 0),
 included_modules text[] NOT NULL DEFAULT ARRAY['core'],
 billing_cycle text NOT NULL DEFAULT 'MONTHLY' CHECK (billing_cycle IN ('MONTHLY','ANNUAL')),
 annual_discount_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (annual_discount_pct BETWEEN 0 AND 50),
 trial_days integer NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 90),
 usage_basis text NOT NULL DEFAULT 'PEAK' CHECK (usage_basis IN ('PEAK','AVERAGE')),
 active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO billing_plans(code,name,description,pepm_paise,minimum_monthly_paise,setup_fee_paise,included_modules,trial_days) VALUES
 ('starter','Starter','Core HR, attendance and leave for small teams.',4900,250000,0,ARRAY['core','attendance','leave','helpdesk','letters'],14),
 ('growth','Growth','Adds payroll, expenses, roster and engagement.',9900,750000,1500000,
   ARRAY['core','attendance','leave','roster','payroll','expenses','travel','helpdesk','letters','assets','exit','engagement','recognition','reports'],14),
 ('enterprise','Enterprise','Every module, integrations and priority support.',14900,2500000,5000000,
   ARRAY['core','attendance','leave','roster','payroll','expenses','travel','helpdesk','letters','assets','exit','learning','performance','recruitment','onboarding','engagement','recognition','reports','integrations'],0)
ON CONFLICT (code) DO NOTHING;

-- 3. Billing accounts: who is invoiced. Either one brand, or a brand group billed on one invoice.
CREATE TABLE IF NOT EXISTS billing_accounts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK (kind IN ('BRAND','GROUP')),
 organization_id uuid UNIQUE REFERENCES organizations(id),
 group_id uuid UNIQUE REFERENCES organization_groups(id),
 legal_name text NOT NULL,
 gstin text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
 billing_address text NOT NULL,
 state_code text NOT NULL,
 contact_name text, contact_email text NOT NULL, contact_phone text,
 payment_terms_days integer CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 120),
 notes text,
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((kind='BRAND' AND organization_id IS NOT NULL AND group_id IS NULL) OR (kind='GROUP' AND group_id IS NOT NULL AND organization_id IS NULL))
);

-- 4. Subscriptions: plan + contract terms + custom price overrides. A plan change ends one row and starts the next.
CREATE TABLE IF NOT EXISTS billing_subscriptions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES billing_accounts(id),
 plan_id uuid NOT NULL REFERENCES billing_plans(id),
 pepm_paise_override bigint CHECK (pepm_paise_override >= 0),
 minimum_paise_override bigint CHECK (minimum_paise_override >= 0),
 setup_fee_paise_override bigint CHECK (setup_fee_paise_override >= 0),
 discount_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
 billing_cycle text CHECK (billing_cycle IN ('MONTHLY','ANNUAL')),
 usage_basis text CHECK (usage_basis IN ('PEAK','AVERAGE')),
 trial_days integer CHECK (trial_days BETWEEN 0 AND 90),
 committed_seats integer CHECK (committed_seats >= 0),
 contract_start date NOT NULL, contract_end date,
 created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (contract_end IS NULL OR contract_end >= contract_start)
);
CREATE INDEX IF NOT EXISTS billing_subscriptions_account ON billing_subscriptions(account_id, contract_start);

-- 5. Daily billable headcount per brand (nightly job; backfilled rows are marked).
CREATE TABLE IF NOT EXISTS billing_usage_snapshots(
 organization_id uuid NOT NULL REFERENCES organizations(id),
 snapshot_date date NOT NULL,
 billable_count integer NOT NULL CHECK (billable_count >= 0),
 active_employees integer NOT NULL, with_login integer NOT NULL,
 rule text NOT NULL, source text NOT NULL CHECK (source IN ('NIGHTLY','BACKFILL')),
 captured_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (organization_id, snapshot_date)
);

-- 6. Invoices. Drafts are editable/regenerable; once issued the row and its lines are frozen by trigger.
CREATE TABLE IF NOT EXISTS billing_invoices(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES billing_accounts(id),
 period_start date NOT NULL, period_end date NOT NULL,
 status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ISSUED')),
 number text UNIQUE CHECK (number IS NULL OR (length(number) <= 16 AND number ~ '^[A-Za-z0-9/-]+$')),
 fiscal_year text, issue_date date, due_date date,
 place_of_supply text NOT NULL, supply_type text NOT NULL CHECK (supply_type IN ('INTRA','INTER')),
 sac_code text NOT NULL, gst_rate numeric(5,2) NOT NULL,
 seller jsonb NOT NULL, buyer jsonb NOT NULL,
 subtotal_paise bigint NOT NULL CHECK (subtotal_paise >= 0),
 cgst_paise bigint NOT NULL DEFAULT 0, sgst_paise bigint NOT NULL DEFAULT 0, igst_paise bigint NOT NULL DEFAULT 0,
 total_paise bigint NOT NULL,
 usage jsonb NOT NULL DEFAULT '{}', warnings text[] NOT NULL DEFAULT '{}',
 is_demo boolean NOT NULL DEFAULT false,
 generated_by uuid REFERENCES users(id), generated_at timestamptz NOT NULL DEFAULT now(),
 issued_by uuid REFERENCES users(id), issued_at timestamptz,
 CHECK (status = 'DRAFT' OR (number IS NOT NULL AND issue_date IS NOT NULL AND due_date IS NOT NULL AND fiscal_year IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_invoices_one_per_period ON billing_invoices(account_id, period_start);
CREATE INDEX IF NOT EXISTS billing_invoices_status ON billing_invoices(status, due_date);

CREATE TABLE IF NOT EXISTS billing_invoice_lines(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 invoice_id uuid NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE,
 position integer NOT NULL,
 kind text NOT NULL CHECK (kind IN ('SUBSCRIPTION','MINIMUM_TOPUP','ANNUAL','OVERAGE','SETUP','TRIAL','CREDIT','CHARGE')),
 description text NOT NULL,
 organization_id uuid REFERENCES organizations(id),
 quantity numeric(12,4), unit_price_paise bigint,
 amount_paise bigint NOT NULL,
 meta jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS billing_invoice_lines_invoice ON billing_invoice_lines(invoice_id, position);

-- 7. Credit notes (GST s.34): issued directly (no draft), immutable, own number series.
CREATE TABLE IF NOT EXISTS billing_credit_notes(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 invoice_id uuid NOT NULL REFERENCES billing_invoices(id),
 number text NOT NULL UNIQUE CHECK (length(number) <= 16 AND number ~ '^[A-Za-z0-9/-]+$'),
 fiscal_year text NOT NULL, issue_date date NOT NULL,
 reason text NOT NULL,
 taxable_paise bigint NOT NULL CHECK (taxable_paise > 0),
 cgst_paise bigint NOT NULL DEFAULT 0, sgst_paise bigint NOT NULL DEFAULT 0, igst_paise bigint NOT NULL DEFAULT 0,
 total_paise bigint NOT NULL,
 seller jsonb NOT NULL, buyer jsonb NOT NULL,
 is_demo boolean NOT NULL DEFAULT false,
 created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);

-- 8. Payments recorded manually (no gateway yet). Never deleted; a wrong entry is reversed.
CREATE TABLE IF NOT EXISTS billing_payments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 invoice_id uuid NOT NULL REFERENCES billing_invoices(id),
 amount_paise bigint NOT NULL CHECK (amount_paise > 0),
 paid_on date NOT NULL,
 mode text NOT NULL CHECK (mode IN ('NEFT','RTGS','IMPS','UPI','CHEQUE','CARD','CASH','OTHER')),
 reference text, note text,
 status text NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED','REVERSED')),
 reversed_reason text, reversed_by uuid REFERENCES users(id), reversed_at timestamptz,
 is_demo boolean NOT NULL DEFAULT false,
 recorded_by uuid REFERENCES users(id), recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_payments_invoice ON billing_payments(invoice_id);

-- 9. One-off credits/charges queued for the next draft invoice of an account.
CREATE TABLE IF NOT EXISTS billing_adjustments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES billing_accounts(id),
 kind text NOT NULL CHECK (kind IN ('CREDIT','CHARGE')),
 description text NOT NULL,
 amount_paise bigint NOT NULL CHECK (amount_paise > 0),
 applied_invoice_id uuid REFERENCES billing_invoices(id) ON DELETE SET NULL,
 created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);

-- 10. Gapless number series per (series, financial year). Incremented only inside the issuing transaction.
CREATE TABLE IF NOT EXISTS billing_number_series(
 series text NOT NULL, fiscal_year text NOT NULL, last_number integer NOT NULL,
 PRIMARY KEY (series, fiscal_year)
);

-- 11. Reminder log (idempotent) and suspension warnings/actions.
CREATE TABLE IF NOT EXISTS billing_reminders(
 invoice_id uuid NOT NULL REFERENCES billing_invoices(id),
 kind text NOT NULL CHECK (kind IN ('DUE_IN_3','DUE_TODAY','OVERDUE_7')),
 sent_at timestamptz NOT NULL DEFAULT now(), recipients text[] NOT NULL DEFAULT '{}',
 PRIMARY KEY (invoice_id, kind)
);
CREATE TABLE IF NOT EXISTS billing_suspensions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES billing_accounts(id),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 invoice_id uuid REFERENCES billing_invoices(id),
 warned_at timestamptz NOT NULL DEFAULT now(), suspend_on date NOT NULL,
 suspended_at timestamptz, reactivated_at timestamptz, reactivated_reason text
);
ALTER TABLE billing_suspensions ADD COLUMN IF NOT EXISTS suspend_on date;
ALTER TABLE billing_suspensions ALTER COLUMN suspend_on SET NOT NULL;
CREATE INDEX IF NOT EXISTS billing_suspensions_open ON billing_suspensions(organization_id) WHERE reactivated_at IS NULL;

-- 12. Platform-level billing activity log (plans, settings, accounts); brand-specific actions also go to audit_log.
CREATE TABLE IF NOT EXISTS billing_events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_user_id uuid, action text NOT NULL, entity_type text NOT NULL, entity_id uuid, data jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);

-- ---- immutability ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billing_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Issued invoice % cannot be deleted; issue a credit note instead', OLD.number; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Issued invoice % is immutable; issue a credit note instead', OLD.number; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS billing_invoice_guard ON billing_invoices;
CREATE TRIGGER billing_invoice_guard BEFORE UPDATE OR DELETE ON billing_invoices FOR EACH ROW EXECUTE FUNCTION billing_invoice_guard();

CREATE OR REPLACE FUNCTION billing_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent uuid := coalesce(NEW.invoice_id, OLD.invoice_id); st text;
BEGIN
  SELECT status INTO st FROM billing_invoices WHERE id = parent;
  IF st IS NOT NULL AND st <> 'DRAFT' THEN RAISE EXCEPTION 'Lines of an issued invoice are immutable'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS billing_line_guard ON billing_invoice_lines;
CREATE TRIGGER billing_line_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_invoice_lines FOR EACH ROW EXECUTE FUNCTION billing_line_guard();

CREATE OR REPLACE FUNCTION billing_frozen_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME; END $$;
DROP TRIGGER IF EXISTS billing_credit_note_guard ON billing_credit_notes;
CREATE TRIGGER billing_credit_note_guard BEFORE UPDATE OR DELETE ON billing_credit_notes FOR EACH ROW EXECUTE FUNCTION billing_frozen_guard();

-- Payments: only RECORDED -> REVERSED (with reason) is allowed; nothing is ever deleted.
CREATE OR REPLACE FUNCTION billing_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payments cannot be deleted; reverse them instead'; END IF;
  IF OLD.status <> 'RECORDED' OR NEW.status <> 'REVERSED' OR NEW.reversed_reason IS NULL
     OR (NEW.invoice_id, NEW.amount_paise, NEW.paid_on, NEW.mode, NEW.reference, NEW.recorded_at) IS DISTINCT FROM
        (OLD.invoice_id, OLD.amount_paise, OLD.paid_on, OLD.mode, OLD.reference, OLD.recorded_at) THEN
    RAISE EXCEPTION 'A payment can only be reversed (with a reason), not edited';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS billing_payment_guard ON billing_payments;
CREATE TRIGGER billing_payment_guard BEFORE UPDATE OR DELETE ON billing_payments FOR EACH ROW EXECUTE FUNCTION billing_payment_guard();

DROP TRIGGER IF EXISTS billing_events_guard ON billing_events;
CREATE TRIGGER billing_events_guard BEFORE UPDATE OR DELETE ON billing_events FOR EACH ROW EXECUTE FUNCTION billing_frozen_guard();

-- ---- isolation ---------------------------------------------------------------------------------------------------
-- Platform tables: no privilege for the tenant runtime role. RLS is enabled without any policy as a second fence
-- (the owner role used by systemQuery is not subject to non-forced RLS).
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['billing_settings','billing_plans','billing_accounts','billing_subscriptions','billing_usage_snapshots',
    'billing_invoices','billing_invoice_lines','billing_credit_notes','billing_payments','billing_adjustments','billing_number_series',
    'billing_reminders','billing_suspensions','billing_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hrm_runtime') THEN EXECUTE format('REVOKE ALL ON %I FROM hrm_runtime', t); END IF;
  END LOOP;
END $$;

INSERT INTO schema_migrations(version) VALUES(37) ON CONFLICT DO NOTHING;

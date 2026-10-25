CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE FUNCTION public.audit_log_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.audit_retention', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
ALTER FUNCTION public.audit_log_append_only() OWNER TO hrm_app;
CREATE FUNCTION public.audit_log_chain() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE last record;
BEGIN
  -- One writer per brand chain at a time; the lock is released at commit.
  PERFORM pg_advisory_xact_lock(hashtextextended('audit_chain:' || NEW.organization_id::text, 0));
  SELECT chain_seq, row_hash INTO last FROM audit_log
   WHERE organization_id = NEW.organization_id AND chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1;
  NEW.created_at := coalesce(NEW.created_at, now());
  NEW.chain_seq := coalesce(last.chain_seq, 0) + 1;
  NEW.prev_hash := coalesce(last.row_hash, '');
  NEW.row_hash := audit_row_digest(NEW.prev_hash, NEW.chain_seq, NEW.organization_id, NEW.actor_user_id, NEW.action,
    NEW.entity_type, NEW.entity_id, NEW.before_data, NEW.after_data, NEW.created_at);
  RETURN NEW;
END $$;
ALTER FUNCTION public.audit_log_chain() OWNER TO hrm_app;
CREATE FUNCTION public.audit_row_digest(prev text, seq bigint, org uuid, actor uuid, action text, entity_type text, entity_id uuid, before_data jsonb, after_data jsonb, created_at timestamp with time zone) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT encode(sha256(convert_to(concat_ws('|', coalesce(prev, ''), seq::text, org::text, actor::text, action, entity_type,
    entity_id::text, coalesce(before_data::text, ''), coalesce(after_data::text, ''),
    ((extract(epoch FROM created_at) * 1000000)::bigint)::text), 'UTF8')), 'hex')
$$;
ALTER FUNCTION public.audit_row_digest(prev text, seq bigint, org uuid, actor uuid, action text, entity_type text, entity_id uuid, before_data jsonb, after_data jsonb, created_at timestamp with time zone) OWNER TO hrm_app;
CREATE FUNCTION public.billing_frozen_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME; END $$;
ALTER FUNCTION public.billing_frozen_guard() OWNER TO hrm_app;
CREATE FUNCTION public.billing_invoice_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Issued invoice % cannot be deleted; issue a credit note instead', OLD.number; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Issued invoice % is immutable; issue a credit note instead', OLD.number; END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION public.billing_invoice_guard() OWNER TO hrm_app;
CREATE FUNCTION public.billing_line_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE parent uuid := coalesce(NEW.invoice_id, OLD.invoice_id); st text;
BEGIN
  SELECT status INTO st FROM billing_invoices WHERE id = parent;
  IF st IS NOT NULL AND st <> 'DRAFT' THEN RAISE EXCEPTION 'Lines of an issued invoice are immutable'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
ALTER FUNCTION public.billing_line_guard() OWNER TO hrm_app;
CREATE FUNCTION public.billing_payment_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payments cannot be deleted; reverse them instead'; END IF;
  IF OLD.status <> 'RECORDED' OR NEW.status <> 'REVERSED' OR NEW.reversed_reason IS NULL
     OR (NEW.invoice_id, NEW.amount_paise, NEW.paid_on, NEW.mode, NEW.reference, NEW.recorded_at) IS DISTINCT FROM
        (OLD.invoice_id, OLD.amount_paise, OLD.paid_on, OLD.mode, OLD.reference, OLD.recorded_at) THEN
    RAISE EXCEPTION 'A payment can only be reversed (with a reason), not edited';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION public.billing_payment_guard() OWNER TO hrm_app;
CREATE FUNCTION public.compliance_evidence_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.evidence_retention', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'compliance evidence is immutable' USING ERRCODE = 'insufficient_privilege';
END $$;
ALTER FUNCTION public.compliance_evidence_immutable() OWNER TO hrm_app;
CREATE FUNCTION public.survey_questions_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM surveys WHERE id = COALESCE(NEW.survey_id, OLD.survey_id);
  IF s IS NOT NULL AND s <> 'DRAFT' THEN
    RAISE EXCEPTION 'Questions cannot change once a survey is live' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
ALTER FUNCTION public.survey_questions_guard() OWNER TO hrm_app;
CREATE TABLE public.access_org_state (
    organization_id uuid NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version bigint DEFAULT 1 NOT NULL
);
ALTER TABLE public.access_org_state OWNER TO hrm_app;
CREATE TABLE public.access_review_items (
    CONSTRAINT access_review_items_decision_check CHECK ((decision = ANY (ARRAY['KEEP'::text, 'REVOKE'::text])))
    CONSTRAINT access_review_items_kind_check CHECK ((kind = ANY (ARRAY['membership'::text, 'platform_admin'::text])))
    applied_at timestamp with time zone
    decided_at timestamp with time zone
    decided_by uuid
    decision text
    employee_status text
    flags text[] DEFAULT '{}'::text[] NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    kind text NOT NULL
    last_sign_in_at timestamp with time zone
    note text
    organization_id uuid
    review_id uuid NOT NULL
    role text NOT NULL
    user_id uuid NOT NULL
);
ALTER TABLE public.access_review_items OWNER TO hrm_app;
CREATE TABLE public.access_reviews (
    CONSTRAINT access_reviews_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'CLOSED'::text])))
    closed_at timestamp with time zone
    closed_by uuid
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid NOT NULL
    due_at date NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    status text DEFAULT 'OPEN'::text NOT NULL
    summary jsonb DEFAULT '{}'::jsonb NOT NULL
    title text NOT NULL
);
ALTER TABLE public.access_reviews OWNER TO hrm_app;
CREATE TABLE public.access_role_assignments (
    CONSTRAINT access_role_assignments_check CHECK (((expires_at IS NULL) OR (expires_at > starts_at)))
    created_at timestamp with time zone DEFAULT now() NOT NULL
    employee_id uuid NOT NULL
    expires_at timestamp with time zone
    expiry_notified_at timestamp with time zone
    granted_by uuid NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    organization_id uuid NOT NULL
    reason text
    restrict_department text
    restrict_location text
    revoke_reason text
    revoked_at timestamp with time zone
    revoked_by uuid
    role_id uuid NOT NULL
    starts_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.access_role_assignments OWNER TO hrm_app;
CREATE TABLE public.access_roles (
    CONSTRAINT access_roles_name_check CHECK (((length(btrim(name)) >= 2) AND (length(btrim(name)) <= 80)))
    CONSTRAINT access_roles_permissions_check CHECK ((jsonb_typeof(permissions) = 'array'::text))
    CONSTRAINT access_roles_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'ARCHIVED'::text])))
    based_on text
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid NOT NULL
    description text DEFAULT ''::text NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    name text NOT NULL
    organization_id uuid NOT NULL
    permissions jsonb DEFAULT '[]'::jsonb NOT NULL
    status text DEFAULT 'ACTIVE'::text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    updated_by uuid NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.access_roles OWNER TO hrm_app;
CREATE TABLE public.accounting_exports (
    CONSTRAINT accounting_exports_check CHECK ((total_debit = total_credit))
    CONSTRAINT accounting_exports_format_check CHECK ((format = ANY (ARRAY['TALLY_XML'::text, 'CSV'::text])))
    CONSTRAINT accounting_exports_kind_check CHECK ((kind = ANY (ARRAY['PAYROLL_JOURNAL'::text, 'EXPENSE_PAYMENTS'::text])))
    CONSTRAINT accounting_exports_period_check CHECK ((period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))
    checksum text NOT NULL
    content text NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    exported_by uuid NOT NULL
    file_name text NOT NULL
    format text NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    kind text NOT NULL
    line_count integer NOT NULL
    organization_id uuid NOT NULL
    period text NOT NULL
    run_id uuid
    total_credit numeric(14,2) NOT NULL
    total_debit numeric(14,2) NOT NULL
    voucher_count integer NOT NULL
);
ALTER TABLE public.accounting_exports OWNER TO hrm_app;
CREATE TABLE public.accounting_settings (
    CONSTRAINT accounting_settings_company_name_check CHECK (((length(company_name) >= 2) AND (length(company_name) <= 120)))
    company_name text NOT NULL
    journal_voucher_type text DEFAULT 'Journal'::text NOT NULL
    ledgers jsonb DEFAULT '{}'::jsonb NOT NULL
    organization_id uuid NOT NULL
    payment_voucher_type text DEFAULT 'Payment'::text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    updated_by uuid
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.accounting_settings OWNER TO hrm_app;
CREATE TABLE public.attendance_devices (
    CONSTRAINT attendance_devices_platform_check CHECK ((platform = ANY (ARRAY['WEB'::text, 'ANDROID'::text, 'IOS'::text])))
    CONSTRAINT attendance_devices_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'PENDING'::text, 'REVOKED'::text])))
    decided_at timestamp with time zone
    decided_by uuid
    employee_id uuid NOT NULL
    first_seen timestamp with time zone DEFAULT now() NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    key_hash text NOT NULL
    label text
    last_seen timestamp with time zone DEFAULT now() NOT NULL
    note text
    organization_id uuid NOT NULL
    platform text NOT NULL
    public_key text
    status text DEFAULT 'PENDING'::text NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE ONLY public.attendance_devices FORCE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_devices OWNER TO hrm_app;
CREATE TABLE public.attendance_events (
    CONSTRAINT attendance_events_accuracy_metres_check CHECK ((accuracy_metres > (0)::numeric))
    CONSTRAINT attendance_events_event_type_check CHECK ((event_type = ANY (ARRAY['IN'::text, 'OUT'::text])))
    CONSTRAINT attendance_events_gps_required CHECK (((source <> ALL (ARRAY['WEB'::text, 'MOBILE'::text])) OR (location_erased_at IS NOT NULL) OR ((latitude IS NOT NULL) AND (longitude IS NOT NULL) AND (accuracy_metres IS NOT NULL) AND (location_captured_at IS NOT NULL) AND (permission = 'granted'::text))))
    CONSTRAINT attendance_events_latitude_check CHECK (((latitude >= ('-90'::integer)::numeric) AND (latitude <= (90)::numeric)))
    CONSTRAINT attendance_events_longitude_check CHECK (((longitude >= ('-180'::integer)::numeric) AND (longitude <= (180)::numeric)))
    CONSTRAINT attendance_events_review_status_check CHECK ((review_status = ANY (ARRAY['NONE'::text, 'PENDING'::text, 'APPROVED'::text, 'REJECTED'::text])))
    CONSTRAINT attendance_events_source_check CHECK ((source = ANY (ARRAY['WEB'::text, 'MOBILE'::text, 'BIOMETRIC'::text, 'MANUAL'::text])))
    accuracy_metres numeric(8,2)
    client_ip inet
    created_at timestamp with time zone DEFAULT now() NOT NULL
    device_id text
    device_record_id uuid
    distance_metres numeric(10,1)
    employee_id uuid NOT NULL
    event_type text NOT NULL
    face_check jsonb
    id uuid DEFAULT gen_random_uuid() NOT NULL
    idempotency_key text NOT NULL
    latitude numeric(10,7)
    location_captured_at timestamp with time zone
    location_erased_at timestamp with time zone
    longitude numeric(10,7)
    note text
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
    organization_id uuid NOT NULL
    permission text
    review_note text
    review_reasons text[] DEFAULT '{}'::text[] NOT NULL
    review_status text DEFAULT 'NONE'::text NOT NULL
    reviewed_at timestamp with time zone
    reviewed_by uuid
    selfie_file_id uuid
    site_id uuid
    source text DEFAULT 'WEB'::text NOT NULL
    timezone text
    wifi_bssid text
    within_geofence boolean
);
ALTER TABLE public.attendance_events OWNER TO hrm_app;
CREATE TABLE public.attendance_networks (
    CONSTRAINT attendance_networks_check CHECK (((kind <> 'IP_RANGE'::text) OR ((value)::cidr IS NOT NULL)))
    CONSTRAINT attendance_networks_check1 CHECK (((kind <> 'WIFI_BSSID'::text) OR (value ~ '^([0-9a-f]{2}:){5}[0-9a-f]{2}$'::text)))
    CONSTRAINT attendance_networks_kind_check CHECK ((kind = ANY (ARRAY['IP_RANGE'::text, 'WIFI_BSSID'::text])))
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid
    id uuid DEFAULT gen_random_uuid() NOT NULL
    kind text NOT NULL
    label text
    organization_id uuid NOT NULL
    site_id uuid
    value text NOT NULL
);
ALTER TABLE ONLY public.attendance_networks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_networks OWNER TO hrm_app;
CREATE TABLE public.attendance_policies (
    CONSTRAINT attendance_policies_device_approval_check CHECK ((device_approval = ANY (ARRAY['FIRST_AUTO'::text, 'ALWAYS_HR'::text])))
    CONSTRAINT attendance_policies_device_binding_check CHECK ((device_binding = ANY (ARRAY['OFF'::text, 'FLAG'::text, 'BLOCK'::text])))
    CONSTRAINT attendance_policies_max_devices_check CHECK (((max_devices >= 1) AND (max_devices <= 3)))
    CONSTRAINT attendance_policies_office_network_check CHECK ((office_network = ANY (ARRAY['OFF'::text, 'FLAG'::text, 'BLOCK'::text])))
    CONSTRAINT attendance_policies_router_mac_check CHECK ((router_mac = ANY (ARRAY['OFF'::text, 'FLAG'::text, 'BLOCK'::text])))
    CONSTRAINT attendance_policies_selfie_mode_check CHECK ((selfie_mode = ANY (ARRAY['OFF'::text, 'OUTSIDE_GEOFENCE'::text, 'ALWAYS'::text])))
    CONSTRAINT attendance_policies_selfie_retention_days_check CHECK (((selfie_retention_days >= 7) AND (selfie_retention_days <= 730)))
    device_approval text DEFAULT 'FIRST_AUTO'::text NOT NULL
    device_binding text DEFAULT 'OFF'::text NOT NULL
    exempt_roles text[] DEFAULT '{}'::text[] NOT NULL
    liveness_required boolean DEFAULT true NOT NULL
    max_devices integer DEFAULT 1 NOT NULL
    office_network text DEFAULT 'OFF'::text NOT NULL
    organization_id uuid NOT NULL
    router_mac text DEFAULT 'OFF'::text NOT NULL
    selfie_mode text DEFAULT 'OFF'::text NOT NULL
    selfie_retention_days integer DEFAULT 90 NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    updated_by uuid
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.attendance_policies OWNER TO hrm_app;
CREATE TABLE public.attendance_regularizations (
    CONSTRAINT attendance_regularizations_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text, 'CHANGES_REQUESTED'::text])))
    approver_id uuid NOT NULL
    attendance_date date NOT NULL
    decided_at timestamp with time zone
    decision_note text
    employee_id uuid NOT NULL
    evidence jsonb
    expected_in time without time zone
    expected_out time without time zone
    id uuid DEFAULT gen_random_uuid() NOT NULL
    note text
    organization_id uuid NOT NULL
    reason text NOT NULL
    status text DEFAULT 'PENDING'::text NOT NULL
    submitted_at timestamp with time zone DEFAULT now() NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.attendance_regularizations OWNER TO hrm_app;
CREATE TABLE public.attendance_sites (
    CONSTRAINT attendance_sites_latitude_check CHECK (((latitude >= ('-90'::integer)::numeric) AND (latitude <= (90)::numeric)))
    CONSTRAINT attendance_sites_longitude_check CHECK (((longitude >= ('-180'::integer)::numeric) AND (longitude <= (180)::numeric)))
    CONSTRAINT attendance_sites_name_check CHECK (((length(name) >= 2) AND (length(name) <= 120)))
    CONSTRAINT attendance_sites_radius_metres_check CHECK (((radius_metres >= 25) AND (radius_metres <= 5000)))
    active boolean DEFAULT true NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    latitude numeric(10,7) NOT NULL
    longitude numeric(10,7) NOT NULL
    name text NOT NULL
    organization_id uuid NOT NULL
    radius_metres integer DEFAULT 150 NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.attendance_sites OWNER TO hrm_app;
CREATE TABLE public.audit_log (
    action text NOT NULL
    actor_user_id uuid NOT NULL
    after_data jsonb
    before_data jsonb
    chain_seq bigint
    created_at timestamp with time zone DEFAULT now() NOT NULL
    entity_id uuid NOT NULL
    entity_type text NOT NULL
    id bigint NOT NULL
    organization_id uuid NOT NULL
    prev_hash text
    row_hash text
);
ALTER TABLE public.audit_log OWNER TO hrm_app;
ALTER TABLE public.audit_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE public.auth_events (
    created_at timestamp with time zone DEFAULT now() NOT NULL
    detail jsonb
    email_hash text
    event text NOT NULL
    id bigint NOT NULL
    ip text
    organization_id uuid
    success boolean NOT NULL
    user_agent_hash text
    user_id uuid
);
ALTER TABLE public.auth_events OWNER TO hrm_app;
ALTER TABLE public.auth_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.auth_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE public.auth_invites (
    CONSTRAINT auth_invites_check CHECK (((kind = 'BRAND'::text) = (organization_id IS NOT NULL)))
    CONSTRAINT auth_invites_kind_check CHECK ((kind = ANY (ARRAY['BRAND'::text, 'PLATFORM'::text])))
    accepted_at timestamp with time zone
    created_at timestamp with time zone DEFAULT now() NOT NULL
    email text NOT NULL
    employee_id uuid
    expires_at timestamp with time zone NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    invited_by uuid
    kind text DEFAULT 'BRAND'::text NOT NULL
    organization_id uuid
    revoked_at timestamp with time zone
    token_hash text NOT NULL
    user_id uuid NOT NULL
);
ALTER TABLE public.auth_invites OWNER TO hrm_app;
CREATE TABLE public.auth_one_time_tokens (
    CONSTRAINT auth_one_time_tokens_purpose_check CHECK ((purpose = ANY (ARRAY['RESET'::text, 'UNLOCK'::text, 'MFA_LOGIN'::text, 'EMAIL_OTP'::text])))
    attempts integer DEFAULT 0 NOT NULL
    context jsonb DEFAULT '{}'::jsonb NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    expires_at timestamp with time zone NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    organization_id uuid
    purpose text NOT NULL
    token_hash text NOT NULL
    used_at timestamp with time zone
    user_id uuid NOT NULL
);
ALTER TABLE public.auth_one_time_tokens OWNER TO hrm_app;
CREATE TABLE public.auth_password_history (
    created_at timestamp with time zone DEFAULT now() NOT NULL
    id bigint NOT NULL
    password_hash text NOT NULL
    user_id uuid NOT NULL
);
ALTER TABLE public.auth_password_history OWNER TO hrm_app;
ALTER TABLE public.auth_password_history ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.auth_password_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE public.auth_recovery_codes (
    code_hash text NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    used_at timestamp with time zone
    user_id uuid NOT NULL
);
ALTER TABLE public.auth_recovery_codes OWNER TO hrm_app;
CREATE TABLE public.auth_refresh_tokens (
    created_at timestamp with time zone DEFAULT now() NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    session_id uuid NOT NULL
    token_hash text NOT NULL
    used_at timestamp with time zone
);
ALTER TABLE public.auth_refresh_tokens OWNER TO hrm_app;
CREATE TABLE public.auth_sessions (
    CONSTRAINT auth_sessions_client_check CHECK ((client = ANY (ARRAY['web'::text, 'mobile'::text])))
    CONSTRAINT auth_sessions_idle_minutes_check CHECK (((idle_minutes >= 5) AND (idle_minutes <= 43200)))
    absolute_expires_at timestamp with time zone NOT NULL
    amr text[] DEFAULT ARRAY['pwd'::text] NOT NULL
    client text DEFAULT 'web'::text NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    device text
    id uuid DEFAULT gen_random_uuid() NOT NULL
    idle_minutes integer NOT NULL
    ip text
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
    organization_id uuid
    revoked_at timestamp with time zone
    revoked_reason text
    user_agent_hash text
    user_id uuid NOT NULL
);
ALTER TABLE public.auth_sessions OWNER TO hrm_app;
CREATE TABLE public.auth_totp_devices (
    CONSTRAINT auth_totp_devices_name_check CHECK (((length(name) >= 1) AND (length(name) <= 60)))
    confirmed_at timestamp with time zone
    created_at timestamp with time zone DEFAULT now() NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    last_used_at timestamp with time zone
    last_used_step bigint
    name text DEFAULT 'Authenticator app'::text NOT NULL
    secret_enc text NOT NULL
    user_id uuid NOT NULL
);
ALTER TABLE public.auth_totp_devices OWNER TO hrm_app;
CREATE TABLE public.billing_accounts (
    CONSTRAINT billing_accounts_check CHECK ((((kind = 'BRAND'::text) AND (organization_id IS NOT NULL) AND (group_id IS NULL)) OR ((kind = 'GROUP'::text) AND (group_id IS NOT NULL) AND (organization_id IS NULL))))
    CONSTRAINT billing_accounts_gstin_check CHECK (((gstin IS NULL) OR (gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'::text)))
    CONSTRAINT billing_accounts_kind_check CHECK ((kind = ANY (ARRAY['BRAND'::text, 'GROUP'::text])))
    CONSTRAINT billing_accounts_payment_terms_days_check CHECK (((payment_terms_days IS NULL) OR ((payment_terms_days >= 0) AND (payment_terms_days <= 120))))
    billing_address text NOT NULL
    contact_email text NOT NULL
    contact_name text
    contact_phone text
    created_at timestamp with time zone DEFAULT now() NOT NULL
    group_id uuid
    gstin text
    id uuid DEFAULT gen_random_uuid() NOT NULL
    kind text NOT NULL
    legal_name text NOT NULL
    notes text
    organization_id uuid
    payment_terms_days integer
    state_code text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.billing_accounts OWNER TO hrm_app;
CREATE TABLE public.billing_adjustments (
    CONSTRAINT billing_adjustments_amount_paise_check CHECK ((amount_paise > 0))
    CONSTRAINT billing_adjustments_kind_check CHECK ((kind = ANY (ARRAY['CREDIT'::text, 'CHARGE'::text])))
    account_id uuid NOT NULL
    amount_paise bigint NOT NULL
    applied_invoice_id uuid
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid
    description text NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    kind text NOT NULL
);
ALTER TABLE public.billing_adjustments OWNER TO hrm_app;
CREATE TABLE public.billing_credit_notes (
    CONSTRAINT billing_credit_notes_number_check CHECK (((length(number) <= 16) AND (number ~ '^[A-Za-z0-9/-]+$'::text)))
    CONSTRAINT billing_credit_notes_taxable_paise_check CHECK ((taxable_paise > 0))
    buyer jsonb NOT NULL
    cgst_paise bigint DEFAULT 0 NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid
    fiscal_year text NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    igst_paise bigint DEFAULT 0 NOT NULL
    invoice_id uuid NOT NULL
    is_demo boolean DEFAULT false NOT NULL
    issue_date date NOT NULL
    number text NOT NULL
    reason text NOT NULL
    seller jsonb NOT NULL
    sgst_paise bigint DEFAULT 0 NOT NULL
    taxable_paise bigint NOT NULL
    total_paise bigint NOT NULL
);
ALTER TABLE public.billing_credit_notes OWNER TO hrm_app;
CREATE TABLE public.billing_events (
    action text NOT NULL
    actor_user_id uuid
    created_at timestamp with time zone DEFAULT now() NOT NULL
    data jsonb
    entity_id uuid
    entity_type text NOT NULL
    id bigint NOT NULL
);
ALTER TABLE public.billing_events OWNER TO hrm_app;
ALTER TABLE public.billing_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.billing_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE public.billing_invoice_lines (
    "position" integer NOT NULL
    CONSTRAINT billing_invoice_lines_kind_check CHECK ((kind = ANY (ARRAY['SUBSCRIPTION'::text, 'MINIMUM_TOPUP'::text, 'ANNUAL'::text, 'OVERAGE'::text, 'SETUP'::text, 'TRIAL'::text, 'CREDIT'::text, 'CHARGE'::text])))
    amount_paise bigint NOT NULL
    description text NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    invoice_id uuid NOT NULL
    kind text NOT NULL
    meta jsonb DEFAULT '{}'::jsonb NOT NULL
    organization_id uuid
    quantity numeric(12,4)
    unit_price_paise bigint
);
ALTER TABLE public.billing_invoice_lines OWNER TO hrm_app;
CREATE TABLE public.billing_invoices (
    CONSTRAINT billing_invoices_check CHECK (((status = 'DRAFT'::text) OR ((number IS NOT NULL) AND (issue_date IS NOT NULL) AND (due_date IS NOT NULL) AND (fiscal_year IS NOT NULL))))
    CONSTRAINT billing_invoices_number_check CHECK (((number IS NULL) OR ((length(number) <= 16) AND (number ~ '^[A-Za-z0-9/-]+$'::text))))
    CONSTRAINT billing_invoices_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'ISSUED'::text])))
    CONSTRAINT billing_invoices_subtotal_paise_check CHECK ((subtotal_paise >= 0))
    CONSTRAINT billing_invoices_supply_type_check CHECK ((supply_type = ANY (ARRAY['INTRA'::text, 'INTER'::text])))
    account_id uuid NOT NULL
    buyer jsonb NOT NULL
    cgst_paise bigint DEFAULT 0 NOT NULL
    due_date date
    fiscal_year text
    generated_at timestamp with time zone DEFAULT now() NOT NULL
    generated_by uuid
    gst_rate numeric(5,2) NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    igst_paise bigint DEFAULT 0 NOT NULL
    is_demo boolean DEFAULT false NOT NULL
    issue_date date
    issued_at timestamp with time zone
    issued_by uuid
    number text
    period_end date NOT NULL
    period_start date NOT NULL
    place_of_supply text NOT NULL
    sac_code text NOT NULL
    seller jsonb NOT NULL
    sgst_paise bigint DEFAULT 0 NOT NULL
    status text DEFAULT 'DRAFT'::text NOT NULL
    subtotal_paise bigint NOT NULL
    supply_type text NOT NULL
    total_paise bigint NOT NULL
    usage jsonb DEFAULT '{}'::jsonb NOT NULL
    warnings text[] DEFAULT '{}'::text[] NOT NULL
);
ALTER TABLE public.billing_invoices OWNER TO hrm_app;
CREATE TABLE public.billing_number_series (
    fiscal_year text NOT NULL
    last_number integer NOT NULL
    series text NOT NULL
);
ALTER TABLE public.billing_number_series OWNER TO hrm_app;
CREATE TABLE public.billing_payments (
    CONSTRAINT billing_payments_amount_paise_check CHECK ((amount_paise > 0))
    CONSTRAINT billing_payments_mode_check CHECK ((mode = ANY (ARRAY['NEFT'::text, 'RTGS'::text, 'IMPS'::text, 'UPI'::text, 'CHEQUE'::text, 'CARD'::text, 'CASH'::text, 'OTHER'::text])))
    CONSTRAINT billing_payments_status_check CHECK ((status = ANY (ARRAY['RECORDED'::text, 'REVERSED'::text])))
    amount_paise bigint NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    invoice_id uuid NOT NULL
    is_demo boolean DEFAULT false NOT NULL
    mode text NOT NULL
    note text
    paid_on date NOT NULL
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
    recorded_by uuid
    reference text
    reversed_at timestamp with time zone
    reversed_by uuid
    reversed_reason text
    status text DEFAULT 'RECORDED'::text NOT NULL
);
ALTER TABLE public.billing_payments OWNER TO hrm_app;
CREATE TABLE public.billing_plans (
    CONSTRAINT billing_plans_annual_discount_pct_check CHECK (((annual_discount_pct >= (0)::numeric) AND (annual_discount_pct <= (50)::numeric)))
    CONSTRAINT billing_plans_billing_cycle_check CHECK ((billing_cycle = ANY (ARRAY['MONTHLY'::text, 'ANNUAL'::text])))
    CONSTRAINT billing_plans_code_check CHECK ((code ~ '^[a-z0-9-]{2,30}$'::text))
    CONSTRAINT billing_plans_minimum_monthly_paise_check CHECK ((minimum_monthly_paise >= 0))
    CONSTRAINT billing_plans_pepm_paise_check CHECK ((pepm_paise >= 0))
    CONSTRAINT billing_plans_setup_fee_paise_check CHECK ((setup_fee_paise >= 0))
    CONSTRAINT billing_plans_trial_days_check CHECK (((trial_days >= 0) AND (trial_days <= 90)))
    CONSTRAINT billing_plans_usage_basis_check CHECK ((usage_basis = ANY (ARRAY['PEAK'::text, 'AVERAGE'::text])))
    active boolean DEFAULT true NOT NULL
    annual_discount_pct numeric(5,2) DEFAULT 0 NOT NULL
    billing_cycle text DEFAULT 'MONTHLY'::text NOT NULL
    code text NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    description text
    id uuid DEFAULT gen_random_uuid() NOT NULL
    included_modules text[] DEFAULT ARRAY['core'::text] NOT NULL
    minimum_monthly_paise bigint DEFAULT 0 NOT NULL
    name text NOT NULL
    pepm_paise bigint NOT NULL
    setup_fee_paise bigint DEFAULT 0 NOT NULL
    trial_days integer DEFAULT 0 NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    usage_basis text DEFAULT 'PEAK'::text NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.billing_plans OWNER TO hrm_app;
CREATE TABLE public.billing_reminders (
    CONSTRAINT billing_reminders_kind_check CHECK ((kind = ANY (ARRAY['DUE_IN_3'::text, 'DUE_TODAY'::text, 'OVERDUE_7'::text])))
    invoice_id uuid NOT NULL
    kind text NOT NULL
    recipients text[] DEFAULT '{}'::text[] NOT NULL
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.billing_reminders OWNER TO hrm_app;
CREATE TABLE public.billing_settings (
    CONSTRAINT billing_settings_auto_suspend_after_days_check CHECK (((auto_suspend_after_days >= 7) AND (auto_suspend_after_days <= 365)))
    CONSTRAINT billing_settings_credit_note_prefix_check CHECK ((credit_note_prefix ~ '^[A-Za-z0-9]{1,4}$'::text))
    CONSTRAINT billing_settings_gst_rate_check CHECK (((gst_rate >= (0)::numeric) AND (gst_rate <= (28)::numeric)))
    CONSTRAINT billing_settings_headcount_rule_check CHECK ((headcount_rule = ANY (ARRAY['ACTIVE_WITH_LOGIN'::text, 'ALL_ACTIVE_EMPLOYEES'::text])))
    CONSTRAINT billing_settings_id_check CHECK ((id = 1))
    CONSTRAINT billing_settings_invoice_prefix_check CHECK ((invoice_prefix ~ '^[A-Za-z0-9]{1,4}$'::text))
    CONSTRAINT billing_settings_payment_terms_days_check CHECK (((payment_terms_days >= 0) AND (payment_terms_days <= 120)))
    CONSTRAINT billing_settings_suspend_warning_days_check CHECK (((suspend_warning_days >= 1) AND (suspend_warning_days <= 60)))
    address text
    auto_suspend_after_days integer DEFAULT 30 NOT NULL
    auto_suspend_enabled boolean DEFAULT false NOT NULL
    bank_details text
    credit_note_prefix text DEFAULT 'CN'::text NOT NULL
    email text
    gst_rate numeric(5,2) DEFAULT 18 NOT NULL
    gstin text
    headcount_rule text DEFAULT 'ACTIVE_WITH_LOGIN'::text NOT NULL
    id smallint DEFAULT 1 NOT NULL
    invoice_prefix text DEFAULT 'NS'::text NOT NULL
    legal_name text
    pan text
    payment_terms_days integer DEFAULT 15 NOT NULL
    phone text
    sac_code text DEFAULT '998315'::text NOT NULL
    state_code text
    suspend_warning_days integer DEFAULT 7 NOT NULL
    trade_name text
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    updated_by uuid
);
ALTER TABLE public.billing_settings OWNER TO hrm_app;
CREATE TABLE public.billing_subscriptions (
    CONSTRAINT billing_subscriptions_billing_cycle_check CHECK ((billing_cycle = ANY (ARRAY['MONTHLY'::text, 'ANNUAL'::text])))
    CONSTRAINT billing_subscriptions_check CHECK (((contract_end IS NULL) OR (contract_end >= contract_start)))
    CONSTRAINT billing_subscriptions_committed_seats_check CHECK ((committed_seats >= 0))
    CONSTRAINT billing_subscriptions_discount_pct_check CHECK (((discount_pct >= (0)::numeric) AND (discount_pct <= (100)::numeric)))
    CONSTRAINT billing_subscriptions_minimum_paise_override_check CHECK ((minimum_paise_override >= 0))
    CONSTRAINT billing_subscriptions_pepm_paise_override_check CHECK ((pepm_paise_override >= 0))
    CONSTRAINT billing_subscriptions_setup_fee_paise_override_check CHECK ((setup_fee_paise_override >= 0))
    CONSTRAINT billing_subscriptions_trial_days_check CHECK (((trial_days >= 0) AND (trial_days <= 90)))
    CONSTRAINT billing_subscriptions_usage_basis_check CHECK ((usage_basis = ANY (ARRAY['PEAK'::text, 'AVERAGE'::text])))
    account_id uuid NOT NULL
    billing_cycle text
    committed_seats integer
    contract_end date
    contract_start date NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid
    discount_pct numeric(5,2) DEFAULT 0 NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    minimum_paise_override bigint
    pepm_paise_override bigint
    plan_id uuid NOT NULL
    setup_fee_paise_override bigint
    trial_days integer
    usage_basis text
);
ALTER TABLE public.billing_subscriptions OWNER TO hrm_app;
CREATE TABLE public.billing_suspensions (
    account_id uuid NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    invoice_id uuid
    organization_id uuid NOT NULL
    reactivated_at timestamp with time zone
    reactivated_reason text
    suspend_on date NOT NULL
    suspended_at timestamp with time zone
    warned_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.billing_suspensions OWNER TO hrm_app;
CREATE TABLE public.billing_usage_snapshots (
    CONSTRAINT billing_usage_snapshots_billable_count_check CHECK ((billable_count >= 0))
    CONSTRAINT billing_usage_snapshots_source_check CHECK ((source = ANY (ARRAY['NIGHTLY'::text, 'BACKFILL'::text])))
    active_employees integer NOT NULL
    billable_count integer NOT NULL
    captured_at timestamp with time zone DEFAULT now() NOT NULL
    organization_id uuid NOT NULL
    rule text NOT NULL
    snapshot_date date NOT NULL
    source text NOT NULL
    with_login integer NOT NULL
);
ALTER TABLE public.billing_usage_snapshots OWNER TO hrm_app;
CREATE TABLE public.compliance_control_state (
    CONSTRAINT compliance_control_state_framework_check CHECK ((framework = ANY (ARRAY['iso27001'::text, 'soc2'::text])))
    CONSTRAINT compliance_control_state_status_check CHECK ((status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'implemented'::text, 'not_applicable'::text])))
    control_id text NOT NULL
    framework text NOT NULL
    notes text
    owner text
    status text DEFAULT 'not_started'::text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    updated_by uuid
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.compliance_control_state OWNER TO hrm_app;
CREATE TABLE public.compliance_evidence (
    CONSTRAINT compliance_evidence_check CHECK ((((source = 'automated'::text) AND (check_id IS NOT NULL)) OR ((source = 'manual'::text) AND (framework IS NOT NULL) AND (control_id IS NOT NULL))))
    CONSTRAINT compliance_evidence_result_check CHECK ((result = ANY (ARRAY['pass'::text, 'warn'::text, 'fail'::text, 'info'::text, 'manual'::text])))
    CONSTRAINT compliance_evidence_source_check CHECK ((source = ANY (ARRAY['automated'::text, 'manual'::text])))
    check_id text
    collected_at timestamp with time zone DEFAULT now() NOT NULL
    collected_by uuid
    collection_id uuid
    control_id text
    data jsonb DEFAULT '{}'::jsonb NOT NULL
    detail text
    framework text
    id uuid DEFAULT gen_random_uuid() NOT NULL
    link text
    result text NOT NULL
    sha256 text NOT NULL
    source text NOT NULL
    title text NOT NULL
);
ALTER TABLE public.compliance_evidence OWNER TO hrm_app;
CREATE TABLE public.compliance_policies (
    CONSTRAINT compliance_policies_status_check CHECK ((status = ANY (ARRAY['PUBLISHED'::text, 'RETIRED'::text])))
    body text NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    key text NOT NULL
    published_at timestamp with time zone DEFAULT now() NOT NULL
    published_by uuid
    status text DEFAULT 'PUBLISHED'::text NOT NULL
    summary text NOT NULL
    title text NOT NULL
    version integer NOT NULL
);
ALTER TABLE public.compliance_policies OWNER TO hrm_app;
CREATE TABLE public.email_outbox (
    attempts integer DEFAULT 0 NOT NULL
    available_at timestamp with time zone DEFAULT now() NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    html text NOT NULL
    id bigint NOT NULL
    last_error text
    organization_id uuid NOT NULL
    recipient text NOT NULL
    sent_at timestamp with time zone
    status text DEFAULT 'PENDING'::text NOT NULL
    subject text NOT NULL
);
ALTER TABLE public.email_outbox OWNER TO hrm_app;
ALTER TABLE public.email_outbox ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.email_outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE public.employee_import_jobs (
    CONSTRAINT employee_import_jobs_status_check CHECK ((status = ANY (ARRAY['REVIEWED'::text, 'COMMITTED'::text, 'FAILED'::text])))
    committed_at timestamp with time zone
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid NOT NULL
    file_name text NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    invalid_rows integer NOT NULL
    organization_id uuid NOT NULL
    status text NOT NULL
    summary jsonb DEFAULT '{}'::jsonb NOT NULL
    total_rows integer NOT NULL
    valid_rows integer NOT NULL
);
ALTER TABLE public.employee_import_jobs OWNER TO hrm_app;
CREATE TABLE public.employee_master_details (
    CONSTRAINT employee_master_details_employment_type_check CHECK (((employment_type IS NULL) OR (employment_type = ANY (ARRAY['FULL_TIME'::text, 'PART_TIME'::text, 'CONTRACT'::text, 'INTERN'::text, 'CONSULTANT'::text]))))
    CONSTRAINT employee_master_details_gender_check CHECK (((gender IS NULL) OR (gender = ANY (ARRAY['MALE'::text, 'FEMALE'::text, 'OTHER'::text, 'UNDISCLOSED'::text]))))
    date_of_birth date
    employee_id uuid NOT NULL
    employment_type text
    gender text
    organization_id uuid NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE ONLY public.employee_master_details FORCE ROW LEVEL SECURITY;
ALTER TABLE public.employee_master_details OWNER TO hrm_app;
CREATE TABLE public.employees (
    created_at timestamp with time zone DEFAULT now() NOT NULL
    department text
    designation text
    employee_number text NOT NULL
    full_name text NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    joining_date date NOT NULL
    location text
    manager_id uuid
    organization_id uuid NOT NULL
    status text DEFAULT 'ACTIVE'::text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    user_id uuid
    version integer DEFAULT 1 NOT NULL
    work_email text NOT NULL
);
ALTER TABLE public.employees OWNER TO hrm_app;
CREATE TABLE public.group_admins (
    CONSTRAINT group_admins_role_check CHECK ((role = ANY (ARRAY['GROUP_OWNER'::text, 'GROUP_HR'::text, 'GROUP_VIEWER'::text])))
    created_at timestamp with time zone DEFAULT now() NOT NULL
    group_id uuid NOT NULL
    role text NOT NULL
    user_id uuid NOT NULL
);
ALTER TABLE public.group_admins OWNER TO hrm_app;
CREATE TABLE public.hr_case_counters (
    module text NOT NULL
    next_value integer DEFAULT 1 NOT NULL
    organization_id uuid NOT NULL
);
ALTER TABLE public.hr_case_counters OWNER TO hrm_app;
CREATE TABLE public.hr_case_events (
    CONSTRAINT hr_case_events_kind_check CHECK ((kind = ANY (ARRAY['CREATED'::text, 'TRANSITION'::text, 'COMMENT'::text])))
    action text
    actor_id uuid NOT NULL
    case_id uuid NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    data jsonb DEFAULT '{}'::jsonb NOT NULL
    from_status text
    id bigint NOT NULL
    kind text NOT NULL
    note text
    organization_id uuid NOT NULL
    to_status text
);
ALTER TABLE public.hr_case_events OWNER TO hrm_app;
ALTER TABLE public.hr_case_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.hr_case_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE public.hr_cases (
    CONSTRAINT hr_cases_amount_check CHECK (((amount IS NULL) OR (amount >= (0)::numeric)))
    CONSTRAINT hr_cases_check CHECK (((end_date IS NULL) OR (start_date IS NULL) OR (end_date >= start_date)))
    CONSTRAINT hr_cases_priority_check CHECK ((priority = ANY (ARRAY['LOW'::text, 'MEDIUM'::text, 'HIGH'::text, 'URGENT'::text])))
    CONSTRAINT hr_cases_title_check CHECK (((length(title) >= 3) AND (length(title) <= 200)))
    amount numeric(14,2)
    approver_id uuid
    assignee_id uuid
    case_number text NOT NULL
    category text
    closed_at timestamp with time zone
    created_at timestamp with time zone DEFAULT now() NOT NULL
    currency character(3) DEFAULT 'INR'::bpchar NOT NULL
    details jsonb DEFAULT '{}'::jsonb NOT NULL
    due_at timestamp with time zone
    end_date date
    id uuid DEFAULT gen_random_uuid() NOT NULL
    module text NOT NULL
    organization_id uuid NOT NULL
    priority text DEFAULT 'MEDIUM'::text NOT NULL
    requester_id uuid NOT NULL
    start_date date
    status text NOT NULL
    subject_employee_id uuid
    title text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.hr_cases OWNER TO hrm_app;
CREATE TABLE public.import_batch_changes (
    CONSTRAINT import_batch_changes_action_check CHECK ((action = ANY (ARRAY['INSERT'::text, 'UPDATE'::text])))
    CONSTRAINT import_batch_changes_table_name_check CHECK ((table_name = ANY (ARRAY['employees'::text, 'payroll_profiles'::text, 'employee_master_details'::text, 'salary_structures'::text, 'leave_balance_ledger'::text, 'payroll_ytd_opening'::text, 'payroll_ytd_monthly'::text, 'stored_files'::text])))
    action text NOT NULL
    after_data jsonb
    batch_id uuid NOT NULL
    before_data jsonb
    employee_id uuid
    id bigint NOT NULL
    organization_id uuid NOT NULL
    record_key jsonb NOT NULL
    seq integer NOT NULL
    table_name text NOT NULL
);
ALTER TABLE ONLY public.import_batch_changes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.import_batch_changes OWNER TO hrm_app;
CREATE SEQUENCE public.import_batch_changes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.import_batch_changes_id_seq OWNER TO hrm_app;
ALTER SEQUENCE public.import_batch_changes_id_seq OWNED BY public.import_batch_changes.id;
CREATE TABLE public.import_batches (
    CONSTRAINT import_batches_batch_key_check CHECK (((length(batch_key) >= 8) AND (length(batch_key) <= 128)))
    CONSTRAINT import_batches_file_name_check CHECK (((file_name IS NULL) OR (length(file_name) <= 200)))
    CONSTRAINT import_batches_kind_check CHECK ((kind = ANY (ARRAY['EMPLOYEE_MASTER'::text, 'SALARY'::text, 'LEAVE_OPENING'::text, 'PAYROLL_YTD'::text, 'PAYSLIPS'::text])))
    CONSTRAINT import_batches_status_check CHECK ((status = ANY (ARRAY['COMMITTED'::text, 'UNDONE'::text])))
    CONSTRAINT import_batches_undo_reason_check CHECK (((undo_reason IS NULL) OR (length(undo_reason) <= 500)))
    batch_key text NOT NULL
    content_sha256 text NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid NOT NULL
    file_name text
    id uuid DEFAULT gen_random_uuid() NOT NULL
    kind text NOT NULL
    options jsonb DEFAULT '{}'::jsonb NOT NULL
    organization_id uuid NOT NULL
    status text DEFAULT 'COMMITTED'::text NOT NULL
    summary jsonb DEFAULT '{}'::jsonb NOT NULL
    total_rows integer DEFAULT 0 NOT NULL
    undo_reason text
    undone_at timestamp with time zone
    undone_by uuid
);
ALTER TABLE ONLY public.import_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE public.import_batches OWNER TO hrm_app;
CREATE TABLE public.integration_device_nonces (
    device_id uuid NOT NULL
    seen_at timestamp with time zone DEFAULT now() NOT NULL
    signature text NOT NULL
);
ALTER TABLE public.integration_device_nonces OWNER TO hrm_app;
CREATE TABLE public.integration_device_punches (
    CONSTRAINT integration_device_punches_external_id_check CHECK (((length(external_id) >= 1) AND (length(external_id) <= 80)))
    CONSTRAINT integration_device_punches_protocol_check CHECK ((protocol = ANY (ARRAY['JSON'::text, 'ADMS'::text])))
    CONSTRAINT integration_device_punches_punch_type_check CHECK ((punch_type = ANY (ARRAY['IN'::text, 'OUT'::text])))
    CONSTRAINT integration_device_punches_status_check CHECK ((status = ANY (ARRAY['RECORDED'::text, 'UNMATCHED'::text, 'IGNORED'::text, 'REJECTED'::text])))
    attendance_event_id uuid
    device_id uuid NOT NULL
    device_user_id text NOT NULL
    employee_id uuid
    external_id text NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    occurred_at timestamp with time zone NOT NULL
    organization_id uuid NOT NULL
    protocol text NOT NULL
    punch_type text
    raw jsonb DEFAULT '{}'::jsonb NOT NULL
    reason text
    received_at timestamp with time zone DEFAULT now() NOT NULL
    resolved_at timestamp with time zone
    resolved_by uuid
    status text NOT NULL
    verify_mode text
);
ALTER TABLE public.integration_device_punches OWNER TO hrm_app;
CREATE TABLE public.integration_device_users (
    CONSTRAINT integration_device_users_device_user_id_check CHECK ((device_user_id ~ '^[A-Za-z0-9_-]{1,24}$'::text))
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid NOT NULL
    device_id uuid
    device_user_id text NOT NULL
    employee_id uuid NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    organization_id uuid NOT NULL
);
ALTER TABLE public.integration_device_users OWNER TO hrm_app;
CREATE TABLE public.integration_devices (
    CONSTRAINT integration_devices_check CHECK (((status = 'REVOKED'::text) OR ((secret_salt IS NOT NULL) AND (secret_hash IS NOT NULL))))
    CONSTRAINT integration_devices_name_check CHECK (((length(name) >= 2) AND (length(name) <= 80)))
    CONSTRAINT integration_devices_serial_number_check CHECK ((serial_number ~ '^[A-Za-z0-9._-]{4,40}$'::text))
    CONSTRAINT integration_devices_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'DISABLED'::text, 'REVOKED'::text])))
    CONSTRAINT integration_devices_vendor_check CHECK ((vendor = ANY (ARRAY['ZKTECO'::text, 'ESSL'::text, 'MANTRA'::text, 'GENERIC'::text])))
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid NOT NULL
    firmware text
    id uuid DEFAULT gen_random_uuid() NOT NULL
    last_ip text
    last_punch_at timestamp with time zone
    last_seen_at timestamp with time zone
    name text NOT NULL
    organization_id uuid NOT NULL
    protocol text
    secret_hash text
    secret_rotated_at timestamp with time zone
    secret_salt text
    serial_number text NOT NULL
    site_id uuid
    status text DEFAULT 'ACTIVE'::text NOT NULL
    timezone text DEFAULT 'Asia/Kolkata'::text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    vendor text NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.integration_devices OWNER TO hrm_app;
CREATE TABLE public.job_dispatch_log (
    CONSTRAINT job_dispatch_log_dedupe_key_check CHECK (((length(dedupe_key) >= 3) AND (length(dedupe_key) <= 300)))
    created_at timestamp with time zone DEFAULT now() NOT NULL
    dedupe_key text NOT NULL
    entity_id uuid
    job_name text NOT NULL
    organization_id uuid NOT NULL
    recipient_employee_id uuid
);
ALTER TABLE public.job_dispatch_log OWNER TO hrm_app;
CREATE TABLE public.job_runs (
    CONSTRAINT job_runs_error_check CHECK (((error IS NULL) OR (length(error) <= 2000)))
    CONSTRAINT job_runs_job_name_check CHECK ((job_name ~ '^[a-z][a-z0-9_.-]{1,79}$'::text))
    CONSTRAINT job_runs_status_check CHECK ((status = ANY (ARRAY['SUCCEEDED'::text, 'FAILED'::text, 'SKIPPED'::text])))
    CONSTRAINT job_runs_trigger_check CHECK ((trigger = ANY (ARRAY['SCHEDULE'::text, 'MANUAL'::text, 'QUEUED'::text])))
    bull_job_id text
    duration_ms integer DEFAULT 0 NOT NULL
    error text
    finished_at timestamp with time zone DEFAULT now() NOT NULL
    id bigint NOT NULL
    job_name text NOT NULL
    organization_id uuid NOT NULL
    result jsonb DEFAULT '{}'::jsonb NOT NULL
    started_at timestamp with time zone NOT NULL
    status text NOT NULL
    trigger text NOT NULL
);
ALTER TABLE public.job_runs OWNER TO hrm_app;
ALTER TABLE public.job_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.job_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE public.kpis (
    CONSTRAINT kpis_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'PENDING'::text, 'APPROVED'::text, 'REJECTED'::text, 'CHANGES_REQUESTED'::text])))
    CONSTRAINT kpis_weight_check CHECK (((weight > (0)::numeric) AND (weight <= (100)::numeric)))
    actual numeric(14,2) DEFAULT 0 NOT NULL
    decided_at timestamp with time zone
    employee_id uuid NOT NULL
    employee_note text
    id uuid DEFAULT gen_random_uuid() NOT NULL
    manager_id uuid NOT NULL
    manager_note text
    metric text NOT NULL
    organization_id uuid NOT NULL
    period text NOT NULL
    status text DEFAULT 'DRAFT'::text NOT NULL
    submitted_at timestamp with time zone
    target numeric(14,2) NOT NULL
    title text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    weight numeric(5,2) NOT NULL
);
ALTER TABLE public.kpis OWNER TO hrm_app;
CREATE TABLE public.leave_balance_ledger (
    CONSTRAINT leave_balance_ledger_days_check CHECK (((days >= ('-999'::integer)::numeric) AND (days <= (999)::numeric)))
    CONSTRAINT leave_balance_ledger_entry_type_check CHECK ((entry_type = ANY (ARRAY['OPENING'::text, 'ADJUSTMENT'::text, 'TAKEN_BEFORE_CUTOVER'::text])))
    CONSTRAINT leave_balance_ledger_note_check CHECK (((note IS NULL) OR (length(note) <= 300)))
    as_of date NOT NULL
    batch_id uuid
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid NOT NULL
    days numeric(7,2) NOT NULL
    employee_id uuid NOT NULL
    entry_type text NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    leave_type_id uuid NOT NULL
    note text
    organization_id uuid NOT NULL
);
ALTER TABLE ONLY public.leave_balance_ledger FORCE ROW LEVEL SECURITY;
ALTER TABLE public.leave_balance_ledger OWNER TO hrm_app;
CREATE TABLE public.leave_requests (
    CONSTRAINT leave_requests_check CHECK ((end_date >= start_date))
    CONSTRAINT leave_requests_days_check CHECK ((days > (0)::numeric))
    CONSTRAINT leave_requests_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text, 'WITHDRAWN'::text, 'CANCELLED'::text])))
    approver_id uuid NOT NULL
    days numeric(6,2) NOT NULL
    decided_at timestamp with time zone
    decision_note text
    employee_id uuid NOT NULL
    end_date date NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    leave_type_id uuid NOT NULL
    organization_id uuid NOT NULL
    reason text NOT NULL
    start_date date NOT NULL
    status text DEFAULT 'PENDING'::text NOT NULL
    submitted_at timestamp with time zone DEFAULT now() NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.leave_requests OWNER TO hrm_app;
CREATE TABLE public.leave_types (
    active boolean DEFAULT true NOT NULL
    annual_quota numeric(6,2) NOT NULL
    code text NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    name text NOT NULL
    organization_id uuid NOT NULL
    requires_document_after_days numeric(6,2)
);
ALTER TABLE public.leave_types OWNER TO hrm_app;
CREATE TABLE public.lms_certificates (
    course_id uuid NOT NULL
    course_title text NOT NULL
    course_version integer NOT NULL
    employee_id uuid NOT NULL
    employee_name text NOT NULL
    enrollment_id uuid NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    issued_at timestamp with time zone DEFAULT now() NOT NULL
    organization_id uuid NOT NULL
    score integer
    verification_code text NOT NULL
);
ALTER TABLE public.lms_certificates OWNER TO hrm_app;
CREATE TABLE public.lms_courses (
    CONSTRAINT lms_courses_category_check CHECK (((length(category) >= 2) AND (length(category) <= 40)))
    CONSTRAINT lms_courses_check CHECK ((NOT (mandatory AND (team_manager_id IS NOT NULL))))
    CONSTRAINT lms_courses_cover_color_check CHECK ((cover_color ~ '^#[0-9a-fA-F]{6}$'::text))
    CONSTRAINT lms_courses_cover_emoji_check CHECK (((length(cover_emoji) >= 1) AND (length(cover_emoji) <= 8)))
    CONSTRAINT lms_courses_description_check CHECK ((length(description) <= 8000))
    CONSTRAINT lms_courses_duration_minutes_check CHECK (((duration_minutes >= 1) AND (duration_minutes <= 6000)))
    CONSTRAINT lms_courses_level_check CHECK ((level = ANY (ARRAY['BEGINNER'::text, 'INTERMEDIATE'::text, 'ADVANCED'::text])))
    CONSTRAINT lms_courses_mandatory_due_days_check CHECK (((mandatory_due_days >= 1) AND (mandatory_due_days <= 365)))
    CONSTRAINT lms_courses_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'PUBLISHED'::text, 'ARCHIVED'::text])))
    CONSTRAINT lms_courses_summary_check CHECK ((length(summary) <= 600))
    CONSTRAINT lms_courses_title_check CHECK (((length(title) >= 3) AND (length(title) <= 140)))
    author_id uuid NOT NULL
    category text NOT NULL
    cover_color text DEFAULT '#0b615c'::text NOT NULL
    cover_emoji text DEFAULT '📘'::text NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    description text DEFAULT ''::text NOT NULL
    duration_minutes integer DEFAULT 30 NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    level text DEFAULT 'BEGINNER'::text NOT NULL
    mandatory boolean DEFAULT false NOT NULL
    mandatory_due_days integer DEFAULT 30 NOT NULL
    organization_id uuid NOT NULL
    published_at timestamp with time zone
    status text DEFAULT 'DRAFT'::text NOT NULL
    summary text DEFAULT ''::text NOT NULL
    team_manager_id uuid
    title text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.lms_courses OWNER TO hrm_app;
CREATE TABLE public.lms_enrollments (
    CONSTRAINT lms_enrollments_progress_pct_check CHECK (((progress_pct >= 0) AND (progress_pct <= 100)))
    CONSTRAINT lms_enrollments_source_check CHECK ((source = ANY (ARRAY['SELF'::text, 'ASSIGNED'::text, 'MANDATORY'::text])))
    CONSTRAINT lms_enrollments_status_check CHECK ((status = ANY (ARRAY['NOT_STARTED'::text, 'IN_PROGRESS'::text, 'COMPLETED'::text])))
    assigned_by uuid
    completed_at timestamp with time zone
    course_id uuid NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    due_date date
    employee_id uuid NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    last_lesson_id uuid
    organization_id uuid NOT NULL
    progress_pct integer DEFAULT 0 NOT NULL
    reminded_at timestamp with time zone
    source text NOT NULL
    started_at timestamp with time zone
    status text DEFAULT 'NOT_STARTED'::text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.lms_enrollments OWNER TO hrm_app;
CREATE TABLE public.lms_lesson_progress (
    completed_at timestamp with time zone DEFAULT now() NOT NULL
    enrollment_id uuid NOT NULL
    lesson_id uuid NOT NULL
    organization_id uuid NOT NULL
);
ALTER TABLE public.lms_lesson_progress OWNER TO hrm_app;
CREATE TABLE public.lms_lessons (
    "position" integer NOT NULL
    CONSTRAINT lms_lessons_body_check CHECK ((length(body) <= 20000))
    CONSTRAINT lms_lessons_duration_minutes_check CHECK (((duration_minutes >= 1) AND (duration_minutes <= 600)))
    CONSTRAINT lms_lessons_max_attempts_check CHECK (((max_attempts IS NULL) OR ((max_attempts >= 1) AND (max_attempts <= 20))))
    CONSTRAINT lms_lessons_pass_mark_check CHECK (((pass_mark IS NULL) OR ((pass_mark >= 1) AND (pass_mark <= 100))))
    CONSTRAINT lms_lessons_position_check CHECK (("position" >= 0))
    CONSTRAINT lms_lessons_title_check CHECK (((length(title) >= 2) AND (length(title) <= 140)))
    CONSTRAINT lms_lessons_type_check CHECK ((type = ANY (ARRAY['TEXT'::text, 'VIDEO'::text, 'PDF'::text, 'QUIZ'::text])))
    CONSTRAINT lms_lessons_video_url_check CHECK (((video_url IS NULL) OR (video_url ~ '^https://'::text)))
    body text DEFAULT ''::text NOT NULL
    course_id uuid NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    deleted_at timestamp with time zone
    duration_minutes integer DEFAULT 5 NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    max_attempts integer
    organization_id uuid NOT NULL
    pass_mark integer
    title text NOT NULL
    type text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    video_url text
);
ALTER TABLE public.lms_lessons OWNER TO hrm_app;
CREATE TABLE public.lms_questions (
    "position" integer NOT NULL
    CONSTRAINT lms_questions_explanation_check CHECK ((length(explanation) <= 1000))
    CONSTRAINT lms_questions_kind_check CHECK ((kind = ANY (ARRAY['SINGLE'::text, 'MULTI'::text])))
    CONSTRAINT lms_questions_position_check CHECK (("position" >= 0))
    CONSTRAINT lms_questions_prompt_check CHECK (((length(prompt) >= 3) AND (length(prompt) <= 1000)))
    correct jsonb NOT NULL
    explanation text DEFAULT ''::text NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    kind text NOT NULL
    lesson_id uuid NOT NULL
    options jsonb NOT NULL
    organization_id uuid NOT NULL
    prompt text NOT NULL
);
ALTER TABLE public.lms_questions OWNER TO hrm_app;
CREATE TABLE public.lms_quiz_attempts (
    CONSTRAINT lms_quiz_attempts_score_check CHECK (((score >= 0) AND (score <= 100)))
    answers jsonb NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    enrollment_id uuid NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    lesson_id uuid NOT NULL
    organization_id uuid NOT NULL
    passed boolean NOT NULL
    score integer NOT NULL
    voided_at timestamp with time zone
);
ALTER TABLE public.lms_quiz_attempts OWNER TO hrm_app;
CREATE TABLE public.notification_preferences (
    categories jsonb DEFAULT '{}'::jsonb NOT NULL
    channel_email boolean DEFAULT false NOT NULL
    channel_push boolean DEFAULT true NOT NULL
    employee_id uuid NOT NULL
    organization_id uuid NOT NULL
    quiet_enabled boolean DEFAULT false NOT NULL
    quiet_end time without time zone DEFAULT '07:00:00'::time without time zone NOT NULL
    quiet_start time without time zone DEFAULT '22:00:00'::time without time zone NOT NULL
    timezone text DEFAULT 'Asia/Kolkata'::text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.notification_preferences OWNER TO hrm_app;
CREATE TABLE public.notification_read_cursors (
    employee_id uuid NOT NULL
    organization_id uuid NOT NULL
    read_through bigint DEFAULT 0 NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.notification_read_cursors OWNER TO hrm_app;
CREATE TABLE public.notification_reads (
    employee_id uuid NOT NULL
    event_id bigint NOT NULL
    organization_id uuid NOT NULL
    read_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.notification_reads OWNER TO hrm_app;
CREATE TABLE public.onboarding_document_reviews (
    CONSTRAINT onboarding_document_reviews_check CHECK (((status <> 'REJECTED'::text) OR (reason IS NOT NULL)))
    CONSTRAINT onboarding_document_reviews_reason_check CHECK (((reason IS NULL) OR (length(reason) <= 500)))
    CONSTRAINT onboarding_document_reviews_status_check CHECK ((status = ANY (ARRAY['VERIFIED'::text, 'REJECTED'::text])))
    file_id uuid NOT NULL
    joiner_id uuid NOT NULL
    organization_id uuid NOT NULL
    reason text
    reviewed_at timestamp with time zone DEFAULT now() NOT NULL
    reviewed_by uuid NOT NULL
    status text NOT NULL
);
ALTER TABLE public.onboarding_document_reviews OWNER TO hrm_app;
CREATE TABLE public.onboarding_joiners (
    CONSTRAINT onboarding_joiners_aadhaar_last4_check CHECK (((aadhaar_last4 IS NULL) OR (aadhaar_last4 ~ '^[0-9]{4}$'::text)))
    CONSTRAINT onboarding_joiners_check CHECK (((buddy_id IS NULL) OR (manager_id IS NULL) OR (buddy_id <> manager_id)))
    CONSTRAINT onboarding_joiners_department_check CHECK (((length(department) >= 2) AND (length(department) <= 120)))
    CONSTRAINT onboarding_joiners_designation_check CHECK (((length(designation) >= 2) AND (length(designation) <= 120)))
    CONSTRAINT onboarding_joiners_employment_type_check CHECK ((employment_type = ANY (ARRAY['FULL_TIME'::text, 'PART_TIME'::text, 'CONTRACT'::text, 'INTERN'::text])))
    CONSTRAINT onboarding_joiners_full_name_check CHECK (((length(full_name) >= 2) AND (length(full_name) <= 160)))
    CONSTRAINT onboarding_joiners_location_check CHECK (((location IS NULL) OR (length(location) <= 120)))
    CONSTRAINT onboarding_joiners_notes_check CHECK (((notes IS NULL) OR (length(notes) <= 2000)))
    CONSTRAINT onboarding_joiners_pan_enc_format CHECK (((pan_enc IS NULL) OR (pan_enc ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$'::text)))
    CONSTRAINT onboarding_joiners_personal_email_check CHECK ((personal_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'::text))
    CONSTRAINT onboarding_joiners_phone_check CHECK (((phone IS NULL) OR (length(phone) <= 30)))
    CONSTRAINT onboarding_joiners_status_check CHECK ((status = ANY (ARRAY['PRE_BOARDING'::text, 'READY_TO_JOIN'::text, 'JOINED'::text, 'COMPLETED'::text, 'WITHDRAWN'::text])))
    aadhaar_last4 character(4)
    buddy_id uuid
    candidate_case_id uuid
    completed_at timestamp with time zone
    converted_at timestamp with time zone
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid NOT NULL
    department text NOT NULL
    designation text NOT NULL
    employee_id uuid
    employment_type text DEFAULT 'FULL_TIME'::text NOT NULL
    full_name text NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    joining_date date NOT NULL
    location text
    manager_id uuid
    notes text
    organization_id uuid NOT NULL
    pan_enc text
    pan_hash text
    pan_last4 text
    personal_email text NOT NULL
    phone text
    ready_at timestamp with time zone
    status text DEFAULT 'PRE_BOARDING'::text NOT NULL
    template_id uuid
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
    withdrawn_at timestamp with time zone
    withdrawn_reason text
);
ALTER TABLE public.onboarding_joiners OWNER TO hrm_app;
CREATE TABLE public.onboarding_settings (
    CONSTRAINT onboarding_settings_employee_number_prefix_check CHECK ((employee_number_prefix ~ '^[A-Z]{1,6}$'::text))
    CONSTRAINT onboarding_settings_welcome_message_check CHECK ((length(welcome_message) <= 2000))
    CONSTRAINT onboarding_settings_work_email_domain_check CHECK (((work_email_domain IS NULL) OR (work_email_domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'::text)))
    employee_number_prefix text DEFAULT 'EMP'::text NOT NULL
    finance_owner_id uuid
    hr_owner_id uuid
    it_owner_id uuid
    organization_id uuid NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
    welcome_message text DEFAULT 'Welcome aboard! We are so glad you are here.'::text NOT NULL
    work_email_domain text
);
ALTER TABLE public.onboarding_settings OWNER TO hrm_app;
CREATE TABLE public.onboarding_tasks (
    CONSTRAINT onboarding_tasks_check CHECK (((status = 'PENDING'::text) = (completed_at IS NULL)))
    CONSTRAINT onboarding_tasks_description_check CHECK (((description IS NULL) OR (length(description) <= 1000)))
    CONSTRAINT onboarding_tasks_document_category_check CHECK (((document_category IS NULL) OR (document_category = ANY (ARRAY['PAN'::text, 'AADHAAR'::text, 'BANK_PROOF'::text, 'EDUCATION'::text, 'PHOTO'::text, 'OTHER'::text]))))
    CONSTRAINT onboarding_tasks_note_check CHECK (((note IS NULL) OR (length(note) <= 2000)))
    CONSTRAINT onboarding_tasks_owner_type_check CHECK ((owner_type = ANY (ARRAY['HR'::text, 'IT'::text, 'MANAGER'::text, 'BUDDY'::text, 'JOINER'::text, 'FINANCE'::text])))
    CONSTRAINT onboarding_tasks_phase_check CHECK ((phase = ANY (ARRAY['PRE_BOARDING'::text, 'DAY_ONE'::text, 'FIRST_WEEK'::text, 'FIRST_90_DAYS'::text])))
    CONSTRAINT onboarding_tasks_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'DONE'::text, 'SKIPPED'::text])))
    CONSTRAINT onboarding_tasks_title_check CHECK (((length(title) >= 3) AND (length(title) <= 160)))
    completed_at timestamp with time zone
    completed_by uuid
    completes_on_conversion boolean DEFAULT false NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    description text
    document_category text
    due_date date NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    joiner_id uuid NOT NULL
    note text
    organization_id uuid NOT NULL
    owner_id uuid
    owner_type text NOT NULL
    phase text NOT NULL
    requires_document boolean DEFAULT false NOT NULL
    sort_order integer DEFAULT 0 NOT NULL
    status text DEFAULT 'PENDING'::text NOT NULL
    template_task_id uuid
    title text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.onboarding_tasks OWNER TO hrm_app;
CREATE TABLE public.onboarding_template_tasks (
    CONSTRAINT onboarding_template_tasks_check CHECK (((NOT requires_document) OR (document_category IS NOT NULL)))
    CONSTRAINT onboarding_template_tasks_description_check CHECK (((description IS NULL) OR (length(description) <= 1000)))
    CONSTRAINT onboarding_template_tasks_document_category_check CHECK (((document_category IS NULL) OR (document_category = ANY (ARRAY['PAN'::text, 'AADHAAR'::text, 'BANK_PROOF'::text, 'EDUCATION'::text, 'PHOTO'::text, 'OTHER'::text]))))
    CONSTRAINT onboarding_template_tasks_due_offset_days_check CHECK (((due_offset_days >= '-90'::integer) AND (due_offset_days <= 180)))
    CONSTRAINT onboarding_template_tasks_owner_type_check CHECK ((owner_type = ANY (ARRAY['HR'::text, 'IT'::text, 'MANAGER'::text, 'BUDDY'::text, 'JOINER'::text, 'FINANCE'::text])))
    CONSTRAINT onboarding_template_tasks_phase_check CHECK ((phase = ANY (ARRAY['PRE_BOARDING'::text, 'DAY_ONE'::text, 'FIRST_WEEK'::text, 'FIRST_90_DAYS'::text])))
    CONSTRAINT onboarding_template_tasks_title_check CHECK (((length(title) >= 3) AND (length(title) <= 160)))
    completes_on_conversion boolean DEFAULT false NOT NULL
    description text
    document_category text
    due_offset_days integer NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    organization_id uuid NOT NULL
    owner_type text NOT NULL
    phase text NOT NULL
    requires_document boolean DEFAULT false NOT NULL
    sort_order integer DEFAULT 0 NOT NULL
    template_id uuid NOT NULL
    title text NOT NULL
);
ALTER TABLE public.onboarding_template_tasks OWNER TO hrm_app;
CREATE TABLE public.onboarding_templates (
    CONSTRAINT onboarding_templates_description_check CHECK (((description IS NULL) OR (length(description) <= 1000)))
    CONSTRAINT onboarding_templates_name_check CHECK (((length(name) >= 3) AND (length(name) <= 120)))
    archived_at timestamp with time zone
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid
    description text
    id uuid DEFAULT gen_random_uuid() NOT NULL
    is_default boolean DEFAULT false NOT NULL
    name text NOT NULL
    organization_id uuid NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.onboarding_templates OWNER TO hrm_app;
CREATE TABLE public.organization_auth_policies (
    CONSTRAINT organization_auth_policies_session_idle_minutes_check CHECK (((session_idle_minutes >= 5) AND (session_idle_minutes <= 720)))
    CONSTRAINT organization_auth_policies_session_max_hours_check CHECK (((session_max_hours >= 1) AND (session_max_hours <= 720)))
    CONSTRAINT organization_auth_policies_sign_in_methods_check CHECK ((sign_in_methods = ANY (ARRAY['PASSWORD'::text, 'SSO'::text, 'BOTH'::text])))
    email_otp_fallback boolean DEFAULT true NOT NULL
    mfa_required_all boolean DEFAULT false NOT NULL
    organization_id uuid NOT NULL
    session_idle_minutes integer DEFAULT 720 NOT NULL
    session_max_hours integer DEFAULT 720 NOT NULL
    sign_in_methods text DEFAULT 'BOTH'::text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    updated_by uuid
);
ALTER TABLE public.organization_auth_policies OWNER TO hrm_app;
CREATE TABLE public.organization_groups (
    CONSTRAINT organization_groups_name_check CHECK (((length(name) >= 2) AND (length(name) <= 120)))
    created_at timestamp with time zone DEFAULT now() NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    name text NOT NULL
    slug text NOT NULL
);
ALTER TABLE public.organization_groups OWNER TO hrm_app;
CREATE TABLE public.organization_memberships (
    CONSTRAINT organization_memberships_role_check CHECK ((role = ANY (ARRAY['OWNER'::text, 'HR_ADMIN'::text, 'MANAGER'::text, 'EMPLOYEE'::text, 'PAYROLL_ADMIN'::text])))
    organization_id uuid NOT NULL
    role text NOT NULL
    status text DEFAULT 'ACTIVE'::text NOT NULL
    user_id uuid NOT NULL
);
ALTER TABLE public.organization_memberships OWNER TO hrm_app;
CREATE TABLE public.organizations (
    CONSTRAINT organizations_accent_color_check CHECK ((accent_color ~ '^#[0-9a-fA-F]{6}$'::text))
    CONSTRAINT organizations_brand_color_check CHECK ((brand_color ~ '^#[0-9a-fA-F]{6}$'::text))
    CONSTRAINT organizations_employee_prefix_check CHECK ((employee_prefix ~ '^[A-Z]{2,6}$'::text))
    CONSTRAINT organizations_logo_data_url_check CHECK (((logo_data_url IS NULL) OR ((length(logo_data_url) < 200000) AND (logo_data_url ~ '^data:image/(png|jpeg|webp|svg\+xml);base64,'::text))))
    CONSTRAINT organizations_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'SUSPENDED'::text])))
    accent_color text DEFAULT '#c78c2b'::text NOT NULL
    brand_color text DEFAULT '#0b615c'::text NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    currency character(3) DEFAULT 'INR'::bpchar NOT NULL
    default_state text DEFAULT 'KA'::text NOT NULL
    display_name text
    employee_prefix text DEFAULT 'EMP'::text NOT NULL
    enabled_modules text[] DEFAULT ARRAY['core'::text, 'attendance'::text, 'leave'::text, 'roster'::text, 'payroll'::text, 'expenses'::text, 'travel'::text, 'helpdesk'::text, 'letters'::text, 'assets'::text, 'exit'::text, 'learning'::text, 'performance'::text, 'recruitment'::text, 'onboarding'::text, 'engagement'::text, 'recognition'::text, 'reports'::text, 'integrations'::text] NOT NULL
    group_id uuid
    id uuid DEFAULT gen_random_uuid() NOT NULL
    industry text
    legal_name text
    logo_data_url text
    name text NOT NULL
    short_name text
    slug text NOT NULL
    status text DEFAULT 'ACTIVE'::text NOT NULL
    timezone text DEFAULT 'Asia/Kolkata'::text NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.organizations OWNER TO hrm_app;
CREATE TABLE public.payout_batches (
    CONSTRAINT payout_batches_adapter_check CHECK ((adapter = ANY (ARRAY['H2H_GENERIC'::text, 'H2H_BANK_CSV'::text, 'API_RAZORPAYX'::text])))
    CONSTRAINT payout_batches_check CHECK (((released_by IS NULL) OR (released_by <> created_by)))
    CONSTRAINT payout_batches_check1 CHECK (((total_amount + skipped_amount) = run_net))
    CONSTRAINT payout_batches_mode_check CHECK ((mode = ANY (ARRAY['NEFT'::text, 'IMPS'::text, 'RTGS'::text])))
    CONSTRAINT payout_batches_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'RELEASED'::text, 'PROCESSING'::text, 'COMPLETED'::text, 'PARTIAL'::text, 'FAILED'::text, 'CANCELLED'::text])))
    adapter text NOT NULL
    cancelled_at timestamp with time zone
    cancelled_by uuid
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid NOT NULL
    file_checksum text
    id uuid DEFAULT gen_random_uuid() NOT NULL
    mode text DEFAULT 'NEFT'::text NOT NULL
    organization_id uuid NOT NULL
    payout_count integer NOT NULL
    period text NOT NULL
    reference text NOT NULL
    released_at timestamp with time zone
    released_by uuid
    run_id uuid NOT NULL
    run_net numeric(14,2) NOT NULL
    skipped_amount numeric(14,2) DEFAULT 0 NOT NULL
    skipped_count integer DEFAULT 0 NOT NULL
    status text DEFAULT 'DRAFT'::text NOT NULL
    total_amount numeric(14,2) NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.payout_batches OWNER TO hrm_app;
CREATE TABLE public.payout_events (
    CONSTRAINT payout_events_source_check CHECK ((source = ANY (ARRAY['USER'::text, 'SYNC'::text, 'WEBHOOK'::text, 'BANK_FILE'::text, 'SYSTEM'::text])))
    actor_id uuid
    batch_id uuid NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    id bigint NOT NULL
    item_id uuid
    note text
    organization_id uuid NOT NULL
    source text NOT NULL
    status text NOT NULL
);
ALTER TABLE public.payout_events OWNER TO hrm_app;
ALTER TABLE public.payout_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.payout_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE public.payout_items (
    CONSTRAINT payout_items_amount_check CHECK ((amount >= (0)::numeric))
    CONSTRAINT payout_items_status_check CHECK ((status = ANY (ARRAY['SKIPPED'::text, 'PENDING'::text, 'QUEUED'::text, 'PROCESSING'::text, 'PROCESSED'::text, 'FAILED'::text, 'REVERSED'::text])))
    account_fingerprint text
    account_last4 text
    amount numeric(14,2) NOT NULL
    bank_name text
    batch_id uuid NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    employee_id uuid NOT NULL
    failure_reason text
    id uuid DEFAULT gen_random_uuid() NOT NULL
    ifsc text
    organization_id uuid NOT NULL
    provider_payout_id text
    reference text NOT NULL
    run_line_id uuid NOT NULL
    skip_reason text
    status text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    utr text
);
ALTER TABLE public.payout_items OWNER TO hrm_app;
CREATE TABLE public.payout_sandbox_payouts (
    CONSTRAINT payout_sandbox_payouts_amount_paise_check CHECK ((amount_paise > 0))
    CONSTRAINT payout_sandbox_payouts_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'processing'::text, 'processed'::text, 'failed'::text, 'reversed'::text])))
    account_last4 text NOT NULL
    amount_paise bigint NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    failure_reason text
    id text NOT NULL
    ifsc text NOT NULL
    mode text NOT NULL
    organization_id uuid NOT NULL
    reference_id text NOT NULL
    status text DEFAULT 'queued'::text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    utr text
);
ALTER TABLE public.payout_sandbox_payouts OWNER TO hrm_app;
CREATE TABLE public.payout_webhook_receipts (
    CONSTRAINT payout_webhook_receipts_event_id_check CHECK (((event_id IS NULL) OR ((length(event_id) >= 1) AND (length(event_id) <= 120))))
    CONSTRAINT payout_webhook_receipts_signature_hash_check CHECK ((signature_hash ~ '^[0-9a-f]{64}$'::text))
    event_id text
    event_type text
    id bigint NOT NULL
    received_at timestamp with time zone DEFAULT now() NOT NULL
    signature_hash text NOT NULL
    signed_at timestamp with time zone NOT NULL
);
ALTER TABLE public.payout_webhook_receipts OWNER TO hrm_app;
CREATE SEQUENCE public.payout_webhook_receipts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.payout_webhook_receipts_id_seq OWNER TO hrm_app;
ALTER SEQUENCE public.payout_webhook_receipts_id_seq OWNED BY public.payout_webhook_receipts.id;
CREATE TABLE public.payroll_inputs (
    CONSTRAINT payroll_inputs_amount_check CHECK ((amount >= (0)::numeric))
    CONSTRAINT payroll_inputs_code_check CHECK ((code ~ '^[A-Z_]{2,30}$'::text))
    CONSTRAINT payroll_inputs_days_check CHECK (((days IS NULL) OR ((days > (0)::numeric) AND (days <= (31)::numeric))))
    CONSTRAINT payroll_inputs_kind_check CHECK ((kind = ANY (ARRAY['EARNING'::text, 'DEDUCTION'::text, 'REIMBURSEMENT'::text, 'LOP'::text])))
    CONSTRAINT payroll_inputs_label_check CHECK (((length(label) >= 2) AND (length(label) <= 120)))
    CONSTRAINT payroll_inputs_note_check CHECK (((note IS NULL) OR (length(note) <= 500)))
    CONSTRAINT payroll_inputs_source_check CHECK ((source = ANY (ARRAY['MANUAL'::text, 'EXPENSE_CLAIM'::text])))
    amount numeric(14,2) DEFAULT 0 NOT NULL
    code text NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid NOT NULL
    days numeric(5,2)
    employee_id uuid NOT NULL
    esi_wage boolean DEFAULT false NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    kind text NOT NULL
    label text NOT NULL
    note text
    organization_id uuid NOT NULL
    run_id uuid NOT NULL
    source text DEFAULT 'MANUAL'::text NOT NULL
    source_ref uuid
    taxable boolean DEFAULT true NOT NULL
    voided_at timestamp with time zone
);
ALTER TABLE public.payroll_inputs OWNER TO hrm_app;
CREATE TABLE public.payroll_profiles (
    CONSTRAINT payroll_profiles_bank_account_enc_format CHECK (((bank_account_enc IS NULL) OR (bank_account_enc ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$'::text)))
    CONSTRAINT payroll_profiles_bank_account_last4_len CHECK (((bank_account_last4 IS NULL) OR (length(bank_account_last4) = 4)))
    CONSTRAINT payroll_profiles_bank_name_check CHECK (((bank_name IS NULL) OR (length(bank_name) <= 80)))
    CONSTRAINT payroll_profiles_esi_number_enc_format CHECK (((esi_number_enc IS NULL) OR (esi_number_enc ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$'::text)))
    CONSTRAINT payroll_profiles_esi_number_last4_len CHECK (((esi_number_last4 IS NULL) OR (length(esi_number_last4) = 4)))
    CONSTRAINT payroll_profiles_ifsc_check CHECK (((ifsc IS NULL) OR (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'::text)))
    CONSTRAINT payroll_profiles_pan_enc_format CHECK (((pan_enc IS NULL) OR (pan_enc ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$'::text)))
    CONSTRAINT payroll_profiles_pan_last4_len CHECK (((pan_last4 IS NULL) OR (length(pan_last4) = 4)))
    CONSTRAINT payroll_profiles_pt_category_check CHECK ((pt_category = ANY (ARRAY['STANDARD'::text, 'WOMAN'::text, 'EXEMPT'::text])))
    CONSTRAINT payroll_profiles_state_code_check CHECK (((state_code IS NULL) OR (state_code ~ '^[A-Z]{2,5}$'::text)))
    CONSTRAINT payroll_profiles_statutory_flags_obj CHECK ((jsonb_typeof(statutory_flags) = 'object'::text))
    CONSTRAINT payroll_profiles_tax_regime_check CHECK ((tax_regime = ANY (ARRAY['NEW'::text, 'OLD'::text])))
    CONSTRAINT payroll_profiles_uan_enc_format CHECK (((uan_enc IS NULL) OR (uan_enc ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$'::text)))
    CONSTRAINT payroll_profiles_uan_last4_len CHECK (((uan_last4 IS NULL) OR (length(uan_last4) = 4)))
    bank_account_enc text
    bank_account_hash text
    bank_account_last4 text
    bank_name text
    declarations jsonb DEFAULT '{}'::jsonb NOT NULL
    employee_id uuid NOT NULL
    esi_number_enc text
    esi_number_hash text
    esi_number_last4 text
    ifsc text
    organization_id uuid NOT NULL
    pan_enc text
    pan_hash text
    pan_last4 text
    pf_applicable boolean DEFAULT true NOT NULL
    pt_category text DEFAULT 'STANDARD'::text NOT NULL
    state_code text
    statutory_flags jsonb DEFAULT '{}'::jsonb NOT NULL
    tax_regime text DEFAULT 'NEW'::text NOT NULL
    uan_enc text
    uan_hash text
    uan_last4 text
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.payroll_profiles OWNER TO hrm_app;
CREATE TABLE public.payroll_run_lines (
    CONSTRAINT payroll_run_lines_status_check CHECK ((status = ANY (ARRAY['INCLUDED'::text, 'EXCLUDED'::text])))
    breakdown jsonb DEFAULT '{}'::jsonb NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    days_in_month smallint NOT NULL
    deductions numeric(14,2) DEFAULT 0 NOT NULL
    employee_id uuid NOT NULL
    employer_cost numeric(14,2) DEFAULT 0 NOT NULL
    esi_employee numeric(14,2) DEFAULT 0 NOT NULL
    flags jsonb DEFAULT '[]'::jsonb NOT NULL
    gross numeric(14,2) DEFAULT 0 NOT NULL
    held boolean DEFAULT false NOT NULL
    held_by uuid
    hold_reason text
    id uuid DEFAULT gen_random_uuid() NOT NULL
    lop_days numeric(5,2) DEFAULT 0 NOT NULL
    net numeric(14,2) DEFAULT 0 NOT NULL
    organization_id uuid NOT NULL
    payable_days numeric(5,2) DEFAULT 0 NOT NULL
    payslip_id uuid
    pf_employee numeric(14,2) DEFAULT 0 NOT NULL
    previous_net numeric(14,2)
    pt numeric(14,2) DEFAULT 0 NOT NULL
    published_at timestamp with time zone
    reimbursements numeric(14,2) DEFAULT 0 NOT NULL
    released_at timestamp with time zone
    run_id uuid NOT NULL
    status text NOT NULL
    structure_id uuid
    taxable_income numeric(14,2) DEFAULT 0 NOT NULL
    tds numeric(14,2) DEFAULT 0 NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    variance_pct numeric(8,2)
);
ALTER TABLE public.payroll_run_lines OWNER TO hrm_app;
CREATE TABLE public.payroll_runs (
    CONSTRAINT payroll_runs_check CHECK (((status <> 'APPROVED'::text) OR (approved_by IS DISTINCT FROM submitted_by)))
    CONSTRAINT payroll_runs_notes_check CHECK (((notes IS NULL) OR (length(notes) <= 1000)))
    CONSTRAINT payroll_runs_period_check CHECK ((period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))
    CONSTRAINT payroll_runs_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'CALCULATED'::text, 'SUBMITTED'::text, 'APPROVED'::text, 'PUBLISHED'::text, 'LOCKED'::text, 'CANCELLED'::text])))
    approved_at timestamp with time zone
    approved_by uuid
    calculated_at timestamp with time zone
    calculated_by uuid
    cancel_reason text
    cancelled_at timestamp with time zone
    cancelled_by uuid
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    include_expenses boolean DEFAULT true NOT NULL
    locked_at timestamp with time zone
    locked_by uuid
    needs_recalc boolean DEFAULT false NOT NULL
    notes text
    organization_id uuid NOT NULL
    pay_date date
    period text NOT NULL
    published_at timestamp with time zone
    published_by uuid
    ruleset_version text
    settings_snapshot jsonb
    status text DEFAULT 'DRAFT'::text NOT NULL
    submitted_at timestamp with time zone
    submitted_by uuid
    totals jsonb DEFAULT '{}'::jsonb NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.payroll_runs OWNER TO hrm_app;
CREATE TABLE public.payroll_settings (
    CONSTRAINT payroll_settings_debit_account_check CHECK (((debit_account IS NULL) OR (debit_account ~ '^[0-9]{6,20}$'::text)))
    CONSTRAINT payroll_settings_default_state_check CHECK ((default_state ~ '^[A-Z]{2,5}$'::text))
    CONSTRAINT payroll_settings_esi_employer_code_check CHECK (((esi_employer_code IS NULL) OR (length(esi_employer_code) <= 30)))
    CONSTRAINT payroll_settings_pf_establishment_code_check CHECK (((pf_establishment_code IS NULL) OR (length(pf_establishment_code) <= 30)))
    CONSTRAINT payroll_settings_pf_wage_mode_check CHECK ((pf_wage_mode = ANY (ARRAY['CEILING'::text, 'ACTUAL'::text])))
    CONSTRAINT payroll_settings_statutory_options_obj CHECK ((jsonb_typeof(statutory_options) = 'object'::text))
    debit_account text
    default_state text DEFAULT 'KA'::text NOT NULL
    esi_employer_code text
    include_expenses boolean DEFAULT true NOT NULL
    organization_id uuid NOT NULL
    pf_establishment_code text
    pf_wage_mode text DEFAULT 'CEILING'::text NOT NULL
    statutory_options jsonb DEFAULT '{}'::jsonb NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.payroll_settings OWNER TO hrm_app;
CREATE TABLE public.payroll_ytd_monthly (
    CONSTRAINT payroll_ytd_monthly_period_check CHECK ((period ~ '^\d{4}-(0[1-9]|1[0-2])$'::text))
    basic numeric(14,2) DEFAULT 0 NOT NULL
    batch_id uuid NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    employee_id uuid NOT NULL
    esi_employee numeric(14,2) DEFAULT 0 NOT NULL
    exempt_allowances numeric(14,2) DEFAULT 0 NOT NULL
    fiscal_year text NOT NULL
    gross numeric(14,2) DEFAULT 0 NOT NULL
    hra numeric(14,2) DEFAULT 0 NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    organization_id uuid NOT NULL
    other_taxable numeric(14,2) DEFAULT 0 NOT NULL
    period text NOT NULL
    pf_employee numeric(14,2) DEFAULT 0 NOT NULL
    pf_employer numeric(14,2) DEFAULT 0 NOT NULL
    pt numeric(14,2) DEFAULT 0 NOT NULL
    tds numeric(14,2) DEFAULT 0 NOT NULL
    vpf numeric(14,2) DEFAULT 0 NOT NULL
);
ALTER TABLE ONLY public.payroll_ytd_monthly FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_ytd_monthly OWNER TO hrm_app;
CREATE TABLE public.payroll_ytd_opening (
    CONSTRAINT payroll_ytd_opening_check CHECK (((gross >= (0)::numeric) AND (basic >= (0)::numeric) AND (hra >= (0)::numeric) AND (other_taxable >= (0)::numeric) AND (exempt_allowances >= (0)::numeric) AND (taxable >= (0)::numeric) AND (pf_employee >= (0)::numeric) AND (pf_employer >= (0)::numeric) AND (vpf >= (0)::numeric) AND (esi_employee >= (0)::numeric) AND (pt >= (0)::numeric) AND (tds >= (0)::numeric)))
    CONSTRAINT payroll_ytd_opening_fiscal_year_check CHECK ((fiscal_year ~ '^\d{4}-\d{2}$'::text))
    CONSTRAINT payroll_ytd_opening_from_period_check CHECK ((from_period ~ '^\d{4}-(0[1-9]|1[0-2])$'::text))
    CONSTRAINT payroll_ytd_opening_last_paid_period_check CHECK ((last_paid_period ~ '^\d{4}-(0[1-9]|1[0-2])$'::text))
    CONSTRAINT payroll_ytd_opening_months_check CHECK (((months >= 1) AND (months <= 12)))
    basic numeric(14,2) DEFAULT 0 NOT NULL
    batch_id uuid NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid NOT NULL
    employee_id uuid NOT NULL
    esi_employee numeric(14,2) DEFAULT 0 NOT NULL
    exempt_allowances numeric(14,2) DEFAULT 0 NOT NULL
    fiscal_year text NOT NULL
    from_period text NOT NULL
    gross numeric(14,2) DEFAULT 0 NOT NULL
    hra numeric(14,2) DEFAULT 0 NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    last_paid_period text NOT NULL
    months integer NOT NULL
    organization_id uuid NOT NULL
    other_taxable numeric(14,2) DEFAULT 0 NOT NULL
    pf_employee numeric(14,2) DEFAULT 0 NOT NULL
    pf_employer numeric(14,2) DEFAULT 0 NOT NULL
    pt numeric(14,2) DEFAULT 0 NOT NULL
    taxable numeric(14,2) DEFAULT 0 NOT NULL
    tds numeric(14,2) DEFAULT 0 NOT NULL
    vpf numeric(14,2) DEFAULT 0 NOT NULL
);
ALTER TABLE ONLY public.payroll_ytd_opening FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_ytd_opening OWNER TO hrm_app;
CREATE TABLE public.payslips (
    CONSTRAINT payslips_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'PUBLISHED'::text])))
    breakdown jsonb
    created_at timestamp with time zone DEFAULT now() NOT NULL
    currency character(3) DEFAULT 'INR'::bpchar NOT NULL
    deductions numeric(14,2) NOT NULL
    employee_id uuid NOT NULL
    gross numeric(14,2) NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    net numeric(14,2) NOT NULL
    organization_id uuid NOT NULL
    payroll_run_id uuid
    period text NOT NULL
    published_at timestamp with time zone
    status text DEFAULT 'DRAFT'::text NOT NULL
    storage_reference text
);
ALTER TABLE public.payslips OWNER TO hrm_app;
CREATE TABLE public.platform_admins (
    created_at timestamp with time zone DEFAULT now() NOT NULL
    user_id uuid NOT NULL
);
ALTER TABLE public.platform_admins OWNER TO hrm_app;
CREATE TABLE public.policy_acknowledgements (
    acknowledged_at timestamp with time zone DEFAULT now() NOT NULL
    client_ip text
    policy_id uuid NOT NULL
    user_id uuid NOT NULL
);
ALTER TABLE public.policy_acknowledgements OWNER TO hrm_app;
CREATE TABLE public.privacy_brand_closures (
    CONSTRAINT privacy_brand_closures_check CHECK (((confirmed_by IS NULL) OR (confirmed_by <> requested_by)))
    CONSTRAINT privacy_brand_closures_grace_days_check CHECK (((grace_days >= 0) AND (grace_days <= 180)))
    CONSTRAINT privacy_brand_closures_status_check CHECK ((status = ANY (ARRAY['PENDING_CONFIRMATION'::text, 'SCHEDULED'::text, 'CANCELLED'::text, 'DELETING'::text, 'DELETED'::text, 'FAILED'::text])))
    cancelled_at timestamp with time zone
    cancelled_by uuid
    certificate jsonb
    confirmed_at timestamp with time zone
    confirmed_by uuid
    delete_after timestamp with time zone
    deleted_at timestamp with time zone
    error text
    export_id uuid
    grace_days integer NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    organization_id uuid NOT NULL
    previous_status text
    reason text NOT NULL
    requested_at timestamp with time zone DEFAULT now() NOT NULL
    requested_by uuid NOT NULL
    status text DEFAULT 'PENDING_CONFIRMATION'::text NOT NULL
);
ALTER TABLE public.privacy_brand_closures OWNER TO hrm_app;
CREATE TABLE public.privacy_brand_exports (
    CONSTRAINT privacy_brand_exports_status_check CHECK ((status = ANY (ARRAY['QUEUED'::text, 'RUNNING'::text, 'READY'::text, 'FAILED'::text, 'EXPIRED'::text])))
    completed_at timestamp with time zone
    created_at timestamp with time zone DEFAULT now() NOT NULL
    error text
    expires_at timestamp with time zone
    id uuid DEFAULT gen_random_uuid() NOT NULL
    manifest jsonb DEFAULT '{}'::jsonb NOT NULL
    organization_id uuid NOT NULL
    purged_at timestamp with time zone
    reason text
    requested_by uuid NOT NULL
    status text DEFAULT 'QUEUED'::text NOT NULL
);
ALTER TABLE public.privacy_brand_exports OWNER TO hrm_app;
CREATE TABLE public.privacy_breaches (
    CONSTRAINT privacy_breaches_severity_check CHECK ((severity = ANY (ARRAY['LOW'::text, 'MEDIUM'::text, 'HIGH'::text, 'CRITICAL'::text])))
    CONSTRAINT privacy_breaches_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'CONTAINED'::text, 'CLOSED'::text])))
    affected_count integer
    affected_description text
    board_notified_at timestamp with time zone
    board_report_at timestamp with time zone
    cert_in_notified_at timestamp with time zone
    cert_in_reportable boolean DEFAULT true NOT NULL
    containment text
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid NOT NULL
    data_categories text[] DEFAULT '{}'::text[] NOT NULL
    detected_at timestamp with time zone NOT NULL
    fiduciaries_notified_at timestamp with time zone
    history jsonb DEFAULT '[]'::jsonb NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    likely_consequences text
    mitigation text
    nature text NOT NULL
    occurred_at timestamp with time zone
    organization_id uuid
    principals_notified_at timestamp with time zone
    reference text NOT NULL
    severity text DEFAULT 'MEDIUM'::text NOT NULL
    status text DEFAULT 'OPEN'::text NOT NULL
    title text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    updated_by uuid
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.privacy_breaches OWNER TO hrm_app;
CREATE TABLE public.privacy_erasure_runs (
    CONSTRAINT privacy_erasure_runs_mode_check CHECK ((mode = ANY (ARRAY['DRY_RUN'::text, 'EXECUTE'::text])))
    CONSTRAINT privacy_erasure_runs_trigger_check CHECK ((trigger = ANY (ARRAY['SCHEDULE'::text, 'MANUAL'::text, 'REQUEST'::text])))
    case_id uuid
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid
    employee_id uuid
    id uuid DEFAULT gen_random_uuid() NOT NULL
    mode text NOT NULL
    organization_id uuid NOT NULL
    report jsonb DEFAULT '{}'::jsonb NOT NULL
    report_sha256 text
    trigger text NOT NULL
);
ALTER TABLE ONLY public.privacy_erasure_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_erasure_runs OWNER TO hrm_app;
CREATE TABLE public.privacy_exports (
    CONSTRAINT privacy_exports_status_check CHECK ((status = ANY (ARRAY['QUEUED'::text, 'RUNNING'::text, 'READY'::text, 'FAILED'::text, 'EXPIRED'::text])))
    completed_at timestamp with time zone
    created_at timestamp with time zone DEFAULT now() NOT NULL
    employee_id uuid NOT NULL
    error text
    expires_at timestamp with time zone
    id uuid DEFAULT gen_random_uuid() NOT NULL
    organization_id uuid NOT NULL
    purged_at timestamp with time zone
    requested_by uuid NOT NULL
    status text DEFAULT 'QUEUED'::text NOT NULL
    summary jsonb DEFAULT '{}'::jsonb NOT NULL
);
ALTER TABLE ONLY public.privacy_exports FORCE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_exports OWNER TO hrm_app;
CREATE TABLE public.privacy_settings (
    auto_erase boolean DEFAULT false NOT NULL
    dpo_email text
    dpo_name text
    dpo_phone text
    grievance_address text
    grievance_email text
    grievance_name text
    grievance_phone text
    organization_id uuid NOT NULL
    retention jsonb DEFAULT '{}'::jsonb NOT NULL
    significant_fiduciary boolean DEFAULT false NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    updated_by uuid
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE ONLY public.privacy_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_settings OWNER TO hrm_app;
CREATE TABLE public.privacy_subject_state (
    anonymised_at timestamp with time zone
    employee_id uuid NOT NULL
    erased jsonb DEFAULT '{}'::jsonb NOT NULL
    exited_on date
    legal_hold boolean DEFAULT false NOT NULL
    legal_hold_at timestamp with time zone
    legal_hold_by uuid
    legal_hold_reason text
    organization_id uuid NOT NULL
    pending_account_user uuid
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE ONLY public.privacy_subject_state FORCE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_subject_state OWNER TO hrm_app;
CREATE TABLE public.push_deliveries (
    CONSTRAINT push_deliveries_outcome_check CHECK ((outcome = ANY (ARRAY['SENT'::text, 'RETRY'::text, 'FAILED'::text, 'INVALID_TOKEN'::text])))
    created_at timestamp with time zone DEFAULT now() NOT NULL
    device_id uuid NOT NULL
    duration_ms integer
    error text
    http_status integer
    id bigint NOT NULL
    notification_id bigint NOT NULL
    organization_id uuid NOT NULL
    outcome text NOT NULL
    provider text NOT NULL
    provider_message_id text
    response jsonb
);
ALTER TABLE public.push_deliveries OWNER TO hrm_app;
ALTER TABLE public.push_deliveries ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.push_deliveries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE public.push_devices (
    CONSTRAINT push_devices_environment_check CHECK ((environment = ANY (ARRAY['sandbox'::text, 'production'::text, 'simulator'::text])))
    CONSTRAINT push_devices_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text])))
    CONSTRAINT push_devices_provider_check CHECK ((provider = ANY (ARRAY['apns'::text, 'fcm'::text])))
    CONSTRAINT push_devices_token_check CHECK (((length(token) >= 8) AND (length(token) <= 4096)))
    active boolean DEFAULT true NOT NULL
    app_version text
    bundle_id text
    created_at timestamp with time zone DEFAULT now() NOT NULL
    deactivated_at timestamp with time zone
    deactivated_reason text
    device_name text
    employee_id uuid NOT NULL
    environment text DEFAULT 'production'::text NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
    organization_id uuid NOT NULL
    platform text NOT NULL
    provider text NOT NULL
    token text NOT NULL
    token_hash character(64) NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    user_id uuid NOT NULL
);
ALTER TABLE public.push_devices OWNER TO hrm_app;
CREATE TABLE public.push_fanout_cursors (
    last_event_id bigint DEFAULT 0 NOT NULL
    organization_id uuid NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.push_fanout_cursors OWNER TO hrm_app;
CREATE TABLE public.push_notifications (
    CONSTRAINT push_notifications_kind_check CHECK ((kind = ANY (ARRAY['EVENT'::text, 'SUMMARY'::text, 'TEST'::text])))
    CONSTRAINT push_notifications_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'SENDING'::text, 'SENT'::text, 'PARTIAL'::text, 'FAILED'::text, 'SUPPRESSED'::text, 'COLLAPSED'::text, 'NO_DEVICES'::text])))
    attempts integer DEFAULT 0 NOT NULL
    body text NOT NULL
    category text NOT NULL
    collapsed_into bigint
    created_at timestamp with time zone DEFAULT now() NOT NULL
    data jsonb DEFAULT '{}'::jsonb NOT NULL
    employee_id uuid NOT NULL
    event_id bigint
    id bigint NOT NULL
    kind text NOT NULL
    organization_id uuid NOT NULL
    reason text
    send_after timestamp with time zone DEFAULT now() NOT NULL
    sent_at timestamp with time zone
    status text NOT NULL
    title text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.push_notifications OWNER TO hrm_app;
ALTER TABLE public.push_notifications ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.push_notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE public.receipt_scans (
    CONSTRAINT receipt_scans_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))
    CONSTRAINT receipt_scans_provider_check CHECK ((provider = ANY (ARRAY['tesseract'::text, 'anthropic'::text, 'pdf-text'::text])))
    CONSTRAINT receipt_scans_status_check CHECK ((status = ANY (ARRAY['SCANNED'::text, 'ATTACHED'::text])))
    attached_at timestamp with time zone
    attached_case_id uuid
    confidence numeric(4,3) DEFAULT 0 NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    duplicate_of jsonb
    employee_id uuid NOT NULL
    fields jsonb DEFAULT '{}'::jsonb NOT NULL
    file_id uuid NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    lines jsonb DEFAULT '[]'::jsonb NOT NULL
    mime_type text NOT NULL
    organization_id uuid NOT NULL
    provider text NOT NULL
    raw_text text
    sha256 character(64) NOT NULL
    status text DEFAULT 'SCANNED'::text NOT NULL
    warnings jsonb DEFAULT '[]'::jsonb NOT NULL
);
ALTER TABLE public.receipt_scans OWNER TO hrm_app;
CREATE TABLE public.risk_compliance_marks (
    CONSTRAINT risk_compliance_marks_note_check CHECK (((note IS NULL) OR (length(note) <= 500)))
    CONSTRAINT risk_compliance_marks_obligation_key_check CHECK (((length(obligation_key) >= 3) AND (length(obligation_key) <= 60)))
    CONSTRAINT risk_compliance_marks_reference_check CHECK (((reference IS NULL) OR (length(reference) <= 120)))
    CONSTRAINT risk_compliance_marks_status_check CHECK ((status = 'FILED'::text))
    marked_at timestamp with time zone DEFAULT now() NOT NULL
    marked_by uuid
    note text
    obligation_key text NOT NULL
    organization_id uuid NOT NULL
    reference text
    status text DEFAULT 'FILED'::text NOT NULL
);
ALTER TABLE ONLY public.risk_compliance_marks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.risk_compliance_marks OWNER TO hrm_app;
CREATE TABLE public.risk_minimum_wages (
    CONSTRAINT risk_minimum_wages_category_check CHECK ((category = ANY (ARRAY['UNSKILLED'::text, 'SEMI_SKILLED'::text, 'SKILLED'::text, 'HIGHLY_SKILLED'::text])))
    CONSTRAINT risk_minimum_wages_monthly_amount_check CHECK ((monthly_amount > (0)::numeric))
    CONSTRAINT risk_minimum_wages_state_code_check CHECK ((state_code ~ '^[A-Z]{2}$'::text))
    category text NOT NULL
    effective_from date NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    is_example boolean DEFAULT false NOT NULL
    monthly_amount numeric(12,2) NOT NULL
    note text
    organization_id uuid NOT NULL
    state_code text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    updated_by uuid
);
ALTER TABLE ONLY public.risk_minimum_wages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.risk_minimum_wages OWNER TO hrm_app;
CREATE TABLE public.risk_settings (
    last_scan_at timestamp with time zone
    last_scan_result jsonb
    organization_id uuid NOT NULL
    thresholds jsonb DEFAULT '{}'::jsonb NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    updated_by uuid
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE ONLY public.risk_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.risk_settings OWNER TO hrm_app;
CREATE TABLE public.risk_signal_events (
    CONSTRAINT risk_signal_events_action_check CHECK ((action = ANY (ARRAY['DETECTED'::text, 'ESCALATED'::text, 'ACKNOWLEDGED'::text, 'RESOLVED'::text, 'DISMISSED'::text, 'REOPENED'::text, 'AUTO_RESOLVED'::text, 'CLEARED'::text])))
    action text NOT NULL
    actor_user_id uuid
    created_at timestamp with time zone DEFAULT now() NOT NULL
    data jsonb DEFAULT '{}'::jsonb NOT NULL
    from_status text
    id bigint NOT NULL
    note text
    organization_id uuid NOT NULL
    signal_id uuid NOT NULL
    to_status text
);
ALTER TABLE ONLY public.risk_signal_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.risk_signal_events OWNER TO hrm_app;
ALTER TABLE public.risk_signal_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.risk_signal_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE public.risk_signals (
    CONSTRAINT risk_signals_area_check CHECK ((area = ANY (ARRAY['compliance'::text, 'attendance'::text, 'labour'::text, 'payroll'::text, 'expenses'::text, 'people'::text, 'service'::text])))
    CONSTRAINT risk_signals_detector_check CHECK (((length(detector) >= 3) AND (length(detector) <= 80)))
    CONSTRAINT risk_signals_severity_check CHECK ((severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text])))
    CONSTRAINT risk_signals_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'ACKNOWLEDGED'::text, 'RESOLVED'::text, 'DISMISSED'::text])))
    CONSTRAINT risk_signals_subject_key_check CHECK (((length(subject_key) >= 1) AND (length(subject_key) <= 300)))
    CONSTRAINT risk_signals_title_check CHECK ((length(title) <= 300))
    action jsonb DEFAULT '{}'::jsonb NOT NULL
    area text NOT NULL
    audiences text[] DEFAULT '{}'::text[] NOT NULL
    cleared_at timestamp with time zone
    created_at timestamp with time zone DEFAULT now() NOT NULL
    detections integer DEFAULT 1 NOT NULL
    detector text NOT NULL
    due_date date
    employee_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL
    explanation text NOT NULL
    fingerprint text NOT NULL
    first_detected_at timestamp with time zone DEFAULT now() NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    last_detected_at timestamp with time zone DEFAULT now() NOT NULL
    organization_id uuid NOT NULL
    records jsonb DEFAULT '[]'::jsonb NOT NULL
    severity text NOT NULL
    status text DEFAULT 'OPEN'::text NOT NULL
    status_at timestamp with time zone
    status_by uuid
    status_fingerprint text
    status_note text
    subject_key text NOT NULL
    title text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE ONLY public.risk_signals FORCE ROW LEVEL SECURITY;
ALTER TABLE public.risk_signals OWNER TO hrm_app;
CREATE TABLE public.roster_assignments (
    CONSTRAINT roster_assignments_check CHECK (((kind = 'SHIFT'::text) = (template_id IS NOT NULL)))
    CONSTRAINT roster_assignments_kind_check CHECK ((kind = ANY (ARRAY['SHIFT'::text, 'WEEKLY_OFF'::text])))
    CONSTRAINT roster_assignments_location_check CHECK (((location IS NULL) OR (length(location) <= 120)))
    CONSTRAINT roster_assignments_note_check CHECK (((note IS NULL) OR (length(note) <= 300)))
    CONSTRAINT roster_assignments_source_check CHECK ((source = ANY (ARRAY['MANUAL'::text, 'COPY'::text, 'PATTERN'::text, 'SHIFT_REQUEST'::text])))
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid NOT NULL
    employee_id uuid NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    kind text NOT NULL
    location text
    note text
    organization_id uuid NOT NULL
    source text DEFAULT 'MANUAL'::text NOT NULL
    source_case_id uuid
    template_id uuid
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    updated_by uuid NOT NULL
    version integer DEFAULT 1 NOT NULL
    work_date date NOT NULL
);
ALTER TABLE public.roster_assignments OWNER TO hrm_app;
CREATE TABLE public.roster_publications (
    CONSTRAINT roster_publications_week_start_check CHECK ((EXTRACT(isodow FROM week_start) = (1)::numeric))
    employee_id uuid NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    organization_id uuid NOT NULL
    published_at timestamp with time zone DEFAULT now() NOT NULL
    published_by uuid NOT NULL
    revision integer DEFAULT 1 NOT NULL
    snapshot jsonb DEFAULT '[]'::jsonb NOT NULL
    week_start date NOT NULL
);
ALTER TABLE public.roster_publications OWNER TO hrm_app;
CREATE TABLE public.roster_settings (
    CONSTRAINT roster_settings_max_consecutive_days_check CHECK (((max_consecutive_days >= 1) AND (max_consecutive_days <= 13)))
    CONSTRAINT roster_settings_max_weekly_hours_check CHECK (((max_weekly_hours >= (1)::numeric) AND (max_weekly_hours <= (120)::numeric)))
    CONSTRAINT roster_settings_min_rest_hours_check CHECK (((min_rest_hours >= (0)::numeric) AND (min_rest_hours <= (24)::numeric)))
    max_consecutive_days integer DEFAULT 6 NOT NULL
    max_weekly_hours numeric(5,1) DEFAULT 48 NOT NULL
    min_rest_hours numeric(4,1) DEFAULT 11 NOT NULL
    organization_id uuid NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.roster_settings OWNER TO hrm_app;
CREATE TABLE public.roster_shift_templates (
    CONSTRAINT roster_shift_templates_break_minutes_check CHECK (((break_minutes >= 0) AND (break_minutes <= 240)))
    CONSTRAINT roster_shift_templates_check CHECK ((start_time <> end_time))
    CONSTRAINT roster_shift_templates_code_check CHECK ((code ~ '^[A-Z0-9]{1,6}$'::text))
    CONSTRAINT roster_shift_templates_color_check CHECK ((color ~ '^#[0-9a-fA-F]{6}$'::text))
    CONSTRAINT roster_shift_templates_min_headcount_check CHECK (((min_headcount >= 0) AND (min_headcount <= 500)))
    CONSTRAINT roster_shift_templates_name_check CHECK (((length(name) >= 2) AND (length(name) <= 60)))
    break_minutes integer DEFAULT 0 NOT NULL
    code text NOT NULL
    color text DEFAULT '#0b615c'::text NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    end_time time without time zone NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    is_active boolean DEFAULT true NOT NULL
    min_headcount integer DEFAULT 0 NOT NULL
    name text NOT NULL
    organization_id uuid NOT NULL
    sort_order integer DEFAULT 0 NOT NULL
    start_time time without time zone NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.roster_shift_templates OWNER TO hrm_app;
CREATE TABLE public.salary_structures (
    CONSTRAINT salary_structures_annual_ctc_check CHECK ((annual_ctc > (0)::numeric))
    CONSTRAINT salary_structures_annual_variable_check CHECK ((annual_variable >= (0)::numeric))
    CONSTRAINT salary_structures_fixed_monthly_gross_check CHECK ((fixed_monthly_gross >= (0)::numeric))
    CONSTRAINT salary_structures_notes_check CHECK (((notes IS NULL) OR (length(notes) <= 1000)))
    CONSTRAINT salary_structures_reason_check CHECK ((reason = ANY (ARRAY['JOINING'::text, 'REVISION'::text, 'PROMOTION'::text, 'CORRECTION'::text])))
    annual_ctc numeric(14,2) NOT NULL
    annual_variable numeric(14,2) DEFAULT 0 NOT NULL
    components jsonb NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid NOT NULL
    effective_from date NOT NULL
    employee_id uuid NOT NULL
    fixed_monthly_gross numeric(14,2) NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    is_metro boolean DEFAULT false NOT NULL
    monthly_ctc numeric(14,2) NOT NULL
    notes text
    organization_id uuid NOT NULL
    reason text DEFAULT 'REVISION'::text NOT NULL
    ruleset_version text NOT NULL
    template jsonb NOT NULL
);
ALTER TABLE public.salary_structures OWNER TO hrm_app;
CREATE TABLE public.schema_migrations (
    applied_at timestamp with time zone DEFAULT now() NOT NULL
    checksum text
    filename text
    version integer NOT NULL
);
ALTER TABLE public.schema_migrations OWNER TO hrm_app;
CREATE TABLE public.security_events (
    bucket timestamp with time zone NOT NULL
    client_ip text NOT NULL
    count integer DEFAULT 1 NOT NULL
    first_seen timestamp with time zone DEFAULT now() NOT NULL
    id bigint NOT NULL
    last_seen timestamp with time zone DEFAULT now() NOT NULL
    method text NOT NULL
    organization_id uuid
    reason text NOT NULL
    route text NOT NULL
    status integer NOT NULL
    user_agent_hash text
    user_id uuid
);
ALTER TABLE public.security_events OWNER TO hrm_app;
ALTER TABLE public.security_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.security_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE public.stored_files (
    CONSTRAINT stored_files_byte_size_check CHECK ((byte_size > 0))
    CONSTRAINT stored_files_category_check CHECK ((category ~ '^[A-Z0-9_]{2,40}$'::text))
    CONSTRAINT stored_files_entity_type_check CHECK ((entity_type ~ '^[a-z_]{2,40}$'::text))
    CONSTRAINT stored_files_key_in_tenant_prefix CHECK (((storage_key = ''::text) OR (storage_key ~~ (('tenants/'::text || (organization_id)::text) || '/%'::text)) OR (storage_key ~~ ((organization_id)::text || '/%'::text))))
    CONSTRAINT stored_files_original_name_check CHECK (((length(original_name) >= 1) AND (length(original_name) <= 180)))
    CONSTRAINT stored_files_storage_driver_check CHECK ((storage_driver = ANY (ARRAY['local'::text, 's3'::text])))
    byte_size integer NOT NULL
    category text DEFAULT 'ATTACHMENT'::text NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    deleted_at timestamp with time zone
    entity_id uuid NOT NULL
    entity_type text NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    mime_type text NOT NULL
    organization_id uuid NOT NULL
    original_name text NOT NULL
    sha256 character(64) NOT NULL
    storage_driver text DEFAULT 'local'::text NOT NULL
    storage_key text NOT NULL
    uploaded_by uuid NOT NULL
);
ALTER TABLE public.stored_files OWNER TO hrm_app;
CREATE TABLE public.survey_answers (
    CONSTRAINT survey_answers_numeric_value_check CHECK (((numeric_value IS NULL) OR ((numeric_value >= 0) AND (numeric_value <= 10))))
    CONSTRAINT survey_answers_text_value_check CHECK (((text_value IS NULL) OR (length(text_value) <= 4000)))
    choice_values text[]
    numeric_value integer
    organization_id uuid NOT NULL
    question_id uuid NOT NULL
    response_id uuid NOT NULL
    text_value text
);
ALTER TABLE public.survey_answers OWNER TO hrm_app;
CREATE TABLE public.survey_invitations (
    employee_id uuid NOT NULL
    invited_at timestamp with time zone DEFAULT now() NOT NULL
    last_reminded_at timestamp with time zone
    organization_id uuid NOT NULL
    reminder_count integer DEFAULT 0 NOT NULL
    responded_on date
    survey_id uuid NOT NULL
);
ALTER TABLE public.survey_invitations OWNER TO hrm_app;
CREATE TABLE public.survey_questions (
    "position" integer NOT NULL
    CONSTRAINT survey_questions_help_text_check CHECK (((help_text IS NULL) OR (length(help_text) <= 500)))
    CONSTRAINT survey_questions_position_check CHECK (("position" >= 0))
    CONSTRAINT survey_questions_prompt_check CHECK (((length(prompt) >= 3) AND (length(prompt) <= 500)))
    CONSTRAINT survey_questions_type_check CHECK ((type = ANY (ARRAY['RATING'::text, 'ENPS'::text, 'SINGLE_CHOICE'::text, 'MULTI_CHOICE'::text, 'SHORT_TEXT'::text, 'LONG_TEXT'::text])))
    help_text text
    id uuid DEFAULT gen_random_uuid() NOT NULL
    options jsonb DEFAULT '[]'::jsonb NOT NULL
    organization_id uuid NOT NULL
    prompt text NOT NULL
    required boolean DEFAULT true NOT NULL
    scale_labels jsonb DEFAULT '[]'::jsonb NOT NULL
    survey_id uuid NOT NULL
    type text NOT NULL
);
ALTER TABLE public.survey_questions OWNER TO hrm_app;
CREATE TABLE public.survey_responses (
    CONSTRAINT survey_responses_check CHECK ((((employee_id IS NULL) AND (submitted_at IS NULL) AND (updated_at IS NULL)) OR ((employee_id IS NOT NULL) AND (submitted_at IS NOT NULL))))
    department text
    employee_id uuid
    id uuid DEFAULT gen_random_uuid() NOT NULL
    location text
    organization_id uuid NOT NULL
    submitted_at timestamp with time zone
    submitted_on date DEFAULT CURRENT_DATE NOT NULL
    survey_id uuid NOT NULL
    updated_at timestamp with time zone
);
ALTER TABLE public.survey_responses OWNER TO hrm_app;
CREATE TABLE public.surveys (
    CONSTRAINT surveys_audience_type_check CHECK ((audience_type = ANY (ARRAY['ALL'::text, 'DEPARTMENTS'::text, 'LOCATIONS'::text, 'TEAM'::text])))
    CONSTRAINT surveys_check CHECK ((NOT (anonymous AND allow_edit)))
    CONSTRAINT surveys_check1 CHECK (((closes_at IS NULL) OR (opens_at IS NULL) OR (closes_at > opens_at)))
    CONSTRAINT surveys_description_check CHECK (((description IS NULL) OR (length(description) <= 2000)))
    CONSTRAINT surveys_kind_check CHECK ((kind = ANY (ARRAY['SURVEY'::text, 'POLL'::text])))
    CONSTRAINT surveys_min_group_size_check CHECK ((min_group_size >= 3))
    CONSTRAINT surveys_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'LIVE'::text, 'CLOSED'::text])))
    CONSTRAINT surveys_title_check CHECK (((length(title) >= 3) AND (length(title) <= 200)))
    allow_edit boolean DEFAULT false NOT NULL
    anonymous boolean DEFAULT true NOT NULL
    audience_type text DEFAULT 'ALL'::text NOT NULL
    audience_values text[] DEFAULT '{}'::text[] NOT NULL
    closed_at timestamp with time zone
    closes_at timestamp with time zone
    created_at timestamp with time zone DEFAULT now() NOT NULL
    description text
    id uuid DEFAULT gen_random_uuid() NOT NULL
    kind text DEFAULT 'SURVEY'::text NOT NULL
    launched_at timestamp with time zone
    min_group_size integer DEFAULT 3 NOT NULL
    opens_at timestamp with time zone
    organization_id uuid NOT NULL
    owner_id uuid NOT NULL
    share_results boolean DEFAULT false NOT NULL
    status text DEFAULT 'DRAFT'::text NOT NULL
    title text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.surveys OWNER TO hrm_app;
CREATE TABLE public.switchover_settings (
    CONSTRAINT switchover_settings_control_totals_check CHECK ((jsonb_typeof(control_totals) = 'object'::text))
    CONSTRAINT switchover_settings_fiscal_year_check CHECK (((fiscal_year IS NULL) OR (fiscal_year ~ '^\d{4}-\d{2}$'::text)))
    CONSTRAINT switchover_settings_last_paid_period_check CHECK (((last_paid_period IS NULL) OR (last_paid_period ~ '^\d{4}-(0[1-9]|1[0-2])$'::text)))
    CONSTRAINT switchover_settings_source_system_check CHECK (((source_system IS NULL) OR (length(source_system) <= 80)))
    control_totals jsonb DEFAULT '{}'::jsonb NOT NULL
    cutover_date date
    fiscal_year text
    last_paid_period text
    organization_id uuid NOT NULL
    source_system text
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    updated_by uuid
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE ONLY public.switchover_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.switchover_settings OWNER TO hrm_app;
CREATE TABLE public.tax_declaration_proofs (
    CONSTRAINT tax_declaration_proofs_category_check CHECK (((length(category) >= 1) AND (length(category) <= 60)))
    CONSTRAINT tax_declaration_proofs_item_id_check CHECK (((item_id IS NULL) OR (length(item_id) <= 64)))
    category text NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    declaration_id uuid NOT NULL
    file_id uuid NOT NULL
    item_id text
    organization_id uuid NOT NULL
);
ALTER TABLE ONLY public.tax_declaration_proofs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tax_declaration_proofs OWNER TO hrm_app;
CREATE TABLE public.tax_declarations (
    CONSTRAINT tax_declarations_completeness_check CHECK (((completeness >= 0) AND (completeness <= 100)))
    CONSTRAINT tax_declarations_regime_check CHECK ((regime = ANY (ARRAY['NEW'::text, 'OLD'::text])))
    CONSTRAINT tax_declarations_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'SUBMITTED'::text, 'CLARIFICATION'::text, 'ACCEPTED'::text, 'REJECTED'::text, 'WITHDRAWN'::text])))
    CONSTRAINT tax_declarations_tax_year_check CHECK ((tax_year ~ '^[0-9]{4}-[0-9]{2}$'::text))
    calculation jsonb DEFAULT '{}'::jsonb NOT NULL
    completeness integer DEFAULT 0 NOT NULL
    consent boolean DEFAULT false NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    employee_id uuid NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    inputs jsonb DEFAULT '{}'::jsonb NOT NULL
    items jsonb DEFAULT '[]'::jsonb NOT NULL
    organization_id uuid NOT NULL
    regime text NOT NULL
    review_action text
    review_amounts jsonb
    review_reason text
    reviewed_at timestamp with time zone
    reviewed_by uuid
    rules_version text NOT NULL
    status text DEFAULT 'DRAFT'::text NOT NULL
    submitted_at timestamp with time zone
    tax_year text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE ONLY public.tax_declarations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tax_declarations OWNER TO hrm_app;
CREATE TABLE public.tax_document_sets (
    CONSTRAINT tax_document_sets_check CHECK (((published_by IS NULL) OR (published_by IS DISTINCT FROM generated_by)))
    CONSTRAINT tax_document_sets_fy_start_check CHECK (((fy_start >= 2000) AND (fy_start <= 2100)))
    CONSTRAINT tax_document_sets_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'GENERATING'::text, 'GENERATED'::text, 'PUBLISHED'::text])))
    fy_start integer NOT NULL
    generated integer DEFAULT 0 NOT NULL
    generated_at timestamp with time zone
    generated_by uuid
    id uuid DEFAULT gen_random_uuid() NOT NULL
    organization_id uuid NOT NULL
    published_at timestamp with time zone
    published_by uuid
    status text DEFAULT 'DRAFT'::text NOT NULL
    total integer DEFAULT 0 NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE ONLY public.tax_document_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tax_document_sets OWNER TO hrm_app;
CREATE TABLE public.tax_documents (
    created_at timestamp with time zone DEFAULT now() NOT NULL
    data jsonb DEFAULT '{}'::jsonb NOT NULL
    data_sha256 text
    employee_id uuid NOT NULL
    fy_start integer NOT NULL
    generated_at timestamp with time zone
    id uuid DEFAULT gen_random_uuid() NOT NULL
    organization_id uuid NOT NULL
    part_a_file_id uuid
    set_id uuid NOT NULL
    warnings jsonb DEFAULT '[]'::jsonb NOT NULL
);
ALTER TABLE ONLY public.tax_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tax_documents OWNER TO hrm_app;
CREATE TABLE public.tds_challan_allocations (
    CONSTRAINT tds_challan_allocations_amount_paid_check CHECK ((amount_paid >= (0)::numeric))
    CONSTRAINT tds_challan_allocations_period_check CHECK ((period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))
    CONSTRAINT tds_challan_allocations_tds_check CHECK ((tds >= (0)::numeric))
    amount_paid numeric(14,2) DEFAULT 0 NOT NULL
    challan_id uuid NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    employee_id uuid NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    organization_id uuid NOT NULL
    payment_date date NOT NULL
    period text NOT NULL
    run_id uuid
    tds numeric(14,2) NOT NULL
);
ALTER TABLE ONLY public.tds_challan_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tds_challan_allocations OWNER TO hrm_app;
CREATE TABLE public.tds_challans (
    CONSTRAINT tds_challans_bsr_code_check CHECK ((bsr_code ~ '^[0-9]{7}$'::text))
    CONSTRAINT tds_challans_cess_check CHECK ((cess >= (0)::numeric))
    CONSTRAINT tds_challans_challan_serial_check CHECK ((challan_serial ~ '^[0-9]{1,5}$'::text))
    CONSTRAINT tds_challans_fee_check CHECK ((fee >= (0)::numeric))
    CONSTRAINT tds_challans_fy_start_check CHECK (((fy_start >= 2000) AND (fy_start <= 2100)))
    CONSTRAINT tds_challans_interest_check CHECK ((interest >= (0)::numeric))
    CONSTRAINT tds_challans_minor_head_check CHECK ((minor_head = ANY (ARRAY['200'::text, '400'::text])))
    CONSTRAINT tds_challans_mode_check CHECK ((mode = ANY (ARRAY['C'::text, 'B'::text])))
    CONSTRAINT tds_challans_notes_check CHECK (((notes IS NULL) OR (length(notes) <= 500)))
    CONSTRAINT tds_challans_penalty_check CHECK ((penalty >= (0)::numeric))
    CONSTRAINT tds_challans_period_check CHECK ((period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))
    CONSTRAINT tds_challans_quarter_check CHECK ((quarter = ANY (ARRAY['Q1'::text, 'Q2'::text, 'Q3'::text, 'Q4'::text])))
    CONSTRAINT tds_challans_section_code_check CHECK ((section_code = ANY (ARRAY['392'::text, '192'::text])))
    CONSTRAINT tds_challans_surcharge_check CHECK ((surcharge >= (0)::numeric))
    CONSTRAINT tds_challans_tax_check CHECK ((tax >= (0)::numeric))
    allocated_at timestamp with time zone
    bsr_code text NOT NULL
    cess numeric(14,2) DEFAULT 0 NOT NULL
    challan_serial text NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid NOT NULL
    deposit_date date NOT NULL
    fee numeric(14,2) DEFAULT 0 NOT NULL
    fy_start integer NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    interest numeric(14,2) DEFAULT 0 NOT NULL
    minor_head text DEFAULT '200'::text NOT NULL
    mode text DEFAULT 'C'::text NOT NULL
    notes text
    organization_id uuid NOT NULL
    penalty numeric(14,2) DEFAULT 0 NOT NULL
    period text NOT NULL
    quarter text NOT NULL
    section_code text DEFAULT '392'::text NOT NULL
    surcharge numeric(14,2) DEFAULT 0 NOT NULL
    tax numeric(14,2) DEFAULT 0 NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE ONLY public.tds_challans FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tds_challans OWNER TO hrm_app;
CREATE TABLE public.tds_deductor_profiles (
    CONSTRAINT tds_deductor_profiles_address_check CHECK ((jsonb_typeof(address) = 'object'::text))
    CONSTRAINT tds_deductor_profiles_deductor_category_check CHECK ((deductor_category ~ '^[ASDEGHLNKMPTJBQF]$'::text))
    CONSTRAINT tds_deductor_profiles_deductor_name_check CHECK (((deductor_name IS NULL) OR (length(deductor_name) <= 75)))
    CONSTRAINT tds_deductor_profiles_deductor_pan_check CHECK (((deductor_pan IS NULL) OR (deductor_pan ~ '^([A-Z]{5}[0-9]{4}[A-Z]|PANNOTREQD)$'::text)))
    CONSTRAINT tds_deductor_profiles_email_check CHECK (((email IS NULL) OR (length(email) <= 75)))
    CONSTRAINT tds_deductor_profiles_gstin_check CHECK (((gstin IS NULL) OR (gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'::text)))
    CONSTRAINT tds_deductor_profiles_phone_check CHECK (((phone IS NULL) OR (phone ~ '^[0-9]{6,10}$'::text)))
    CONSTRAINT tds_deductor_profiles_responsible_check CHECK ((jsonb_typeof(responsible) = 'object'::text))
    CONSTRAINT tds_deductor_profiles_responsible_pan_enc_check CHECK (((responsible_pan_enc IS NULL) OR (responsible_pan_enc ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$'::text)))
    CONSTRAINT tds_deductor_profiles_responsible_pan_last4_check CHECK (((responsible_pan_last4 IS NULL) OR (length(responsible_pan_last4) = 4)))
    CONSTRAINT tds_deductor_profiles_tan_check CHECK (((tan IS NULL) OR (tan ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'::text)))
    address jsonb DEFAULT '{}'::jsonb NOT NULL
    deductor_category text DEFAULT 'K'::text NOT NULL
    deductor_name text
    deductor_pan text
    email text
    gstin text
    organization_id uuid NOT NULL
    phone text
    responsible jsonb DEFAULT '{}'::jsonb NOT NULL
    responsible_pan_enc text
    responsible_pan_hash text
    responsible_pan_last4 text
    tan text
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    updated_by uuid
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE ONLY public.tds_deductor_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tds_deductor_profiles OWNER TO hrm_app;
CREATE TABLE public.tds_returns (
    CONSTRAINT tds_returns_fy_start_check CHECK (((fy_start >= 2000) AND (fy_start <= 2100)))
    CONSTRAINT tds_returns_quarter_check CHECK ((quarter = ANY (ARRAY['Q1'::text, 'Q2'::text, 'Q3'::text, 'Q4'::text])))
    CONSTRAINT tds_returns_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'GENERATED'::text, 'FILED'::text])))
    CONSTRAINT tds_returns_token_number_check CHECK (((token_number IS NULL) OR (token_number ~ '^[0-9]{15}$'::text)))
    file_sha256 text
    filed_externally boolean DEFAULT false NOT NULL
    filed_on date
    fy_start integer NOT NULL
    generated_at timestamp with time zone
    generated_by uuid
    id uuid DEFAULT gen_random_uuid() NOT NULL
    organization_id uuid NOT NULL
    quarter text NOT NULL
    status text DEFAULT 'DRAFT'::text NOT NULL
    token_number text
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    validation jsonb DEFAULT '{}'::jsonb NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE ONLY public.tds_returns FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tds_returns OWNER TO hrm_app;
CREATE TABLE public.users (
    created_at timestamp with time zone DEFAULT now() NOT NULL
    email text NOT NULL
    failed_login_count integer DEFAULT 0 NOT NULL
    full_name text NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    last_failed_login_at timestamp with time zone
    last_sign_in_at timestamp with time zone
    locked_until timestamp with time zone
    oidc_issuer text
    oidc_subject text
    password_changed_at timestamp with time zone
    password_hash text
);
ALTER TABLE public.users OWNER TO hrm_app;
CREATE TABLE public.webhook_deliveries (
    CONSTRAINT webhook_deliveries_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'RETRYING'::text, 'SUCCEEDED'::text, 'FAILED'::text, 'SKIPPED'::text])))
    attempts integer DEFAULT 0 NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    delivered_at timestamp with time zone
    error text
    event_id uuid NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    is_test boolean DEFAULT false NOT NULL
    last_attempt_at timestamp with time zone
    organization_id uuid NOT NULL
    response_code integer
    response_excerpt text
    response_ms integer
    status text DEFAULT 'PENDING'::text NOT NULL
    subscription_id uuid NOT NULL
);
ALTER TABLE public.webhook_deliveries OWNER TO hrm_app;
CREATE TABLE public.webhook_event_cursors (
    last_audit_id bigint DEFAULT 0 NOT NULL
    organization_id uuid NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.webhook_event_cursors OWNER TO hrm_app;
CREATE TABLE public.webhook_events (
    entity_id text
    entity_type text
    event_type text NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
    organization_id uuid NOT NULL
    payload jsonb NOT NULL
    source_audit_id bigint
);
ALTER TABLE public.webhook_events OWNER TO hrm_app;
CREATE TABLE public.webhook_subscriptions (
    CONSTRAINT webhook_subscriptions_event_types_check CHECK ((cardinality(event_types) > 0))
    CONSTRAINT webhook_subscriptions_name_check CHECK (((length(name) >= 2) AND (length(name) <= 80)))
    CONSTRAINT webhook_subscriptions_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'DISABLED'::text])))
    CONSTRAINT webhook_subscriptions_url_check CHECK (((length(url) >= 10) AND (length(url) <= 500)))
    consecutive_failures integer DEFAULT 0 NOT NULL
    created_at timestamp with time zone DEFAULT now() NOT NULL
    created_by uuid NOT NULL
    disabled_at timestamp with time zone
    disabled_reason text
    event_types text[] NOT NULL
    id uuid DEFAULT gen_random_uuid() NOT NULL
    last_delivery_at timestamp with time zone
    last_success_at timestamp with time zone
    name text NOT NULL
    organization_id uuid NOT NULL
    secret_hash text NOT NULL
    secret_salt text NOT NULL
    status text DEFAULT 'ACTIVE'::text NOT NULL
    updated_at timestamp with time zone DEFAULT now() NOT NULL
    url text NOT NULL
    version integer DEFAULT 1 NOT NULL
);
ALTER TABLE public.webhook_subscriptions OWNER TO hrm_app;
CREATE TABLE public.workflow_events (
    created_at timestamp with time zone DEFAULT now() NOT NULL
    employee_id uuid
    entity_id uuid NOT NULL
    entity_type text NOT NULL
    event_type text NOT NULL
    id bigint NOT NULL
    organization_id uuid NOT NULL
    payload jsonb DEFAULT '{}'::jsonb NOT NULL
);
ALTER TABLE public.workflow_events OWNER TO hrm_app;
ALTER TABLE public.workflow_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.workflow_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
ALTER TABLE ONLY public.import_batch_changes ALTER COLUMN id SET DEFAULT nextval('public.import_batch_changes_id_seq'::regclass);
ALTER TABLE ONLY public.payout_webhook_receipts ALTER COLUMN id SET DEFAULT nextval('public.payout_webhook_receipts_id_seq'::regclass);
ALTER TABLE ONLY public.access_org_state
    ADD CONSTRAINT access_org_state_pkey PRIMARY KEY (organization_id);
ALTER TABLE ONLY public.access_review_items
    ADD CONSTRAINT access_review_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.access_review_items
    ADD CONSTRAINT access_review_items_review_id_kind_organization_id_user_id_key UNIQUE (review_id, kind, organization_id, user_id);
ALTER TABLE ONLY public.access_reviews
    ADD CONSTRAINT access_reviews_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.access_role_assignments
    ADD CONSTRAINT access_role_assignments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.access_roles
    ADD CONSTRAINT access_roles_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.accounting_exports
    ADD CONSTRAINT accounting_exports_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.accounting_settings
    ADD CONSTRAINT accounting_settings_pkey PRIMARY KEY (organization_id);
ALTER TABLE ONLY public.attendance_devices
    ADD CONSTRAINT attendance_devices_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.attendance_events
    ADD CONSTRAINT attendance_events_organization_id_employee_id_idempotency_k_key UNIQUE (organization_id, employee_id, idempotency_key);
ALTER TABLE ONLY public.attendance_events
    ADD CONSTRAINT attendance_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.attendance_networks
    ADD CONSTRAINT attendance_networks_organization_id_kind_value_key UNIQUE (organization_id, kind, value);
ALTER TABLE ONLY public.attendance_networks
    ADD CONSTRAINT attendance_networks_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.attendance_policies
    ADD CONSTRAINT attendance_policies_pkey PRIMARY KEY (organization_id);
ALTER TABLE ONLY public.attendance_regularizations
    ADD CONSTRAINT attendance_regularizations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.attendance_sites
    ADD CONSTRAINT attendance_sites_organization_id_name_key UNIQUE (organization_id, name);
ALTER TABLE ONLY public.attendance_sites
    ADD CONSTRAINT attendance_sites_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.auth_events
    ADD CONSTRAINT auth_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.auth_invites
    ADD CONSTRAINT auth_invites_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.auth_invites
    ADD CONSTRAINT auth_invites_token_hash_key UNIQUE (token_hash);
ALTER TABLE ONLY public.auth_one_time_tokens
    ADD CONSTRAINT auth_one_time_tokens_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.auth_one_time_tokens
    ADD CONSTRAINT auth_one_time_tokens_token_hash_key UNIQUE (token_hash);
ALTER TABLE ONLY public.auth_password_history
    ADD CONSTRAINT auth_password_history_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.auth_recovery_codes
    ADD CONSTRAINT auth_recovery_codes_code_hash_key UNIQUE (code_hash);
ALTER TABLE ONLY public.auth_recovery_codes
    ADD CONSTRAINT auth_recovery_codes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.auth_refresh_tokens
    ADD CONSTRAINT auth_refresh_tokens_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.auth_refresh_tokens
    ADD CONSTRAINT auth_refresh_tokens_token_hash_key UNIQUE (token_hash);
ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.auth_totp_devices
    ADD CONSTRAINT auth_totp_devices_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.billing_accounts
    ADD CONSTRAINT billing_accounts_group_id_key UNIQUE (group_id);
ALTER TABLE ONLY public.billing_accounts
    ADD CONSTRAINT billing_accounts_organization_id_key UNIQUE (organization_id);
ALTER TABLE ONLY public.billing_accounts
    ADD CONSTRAINT billing_accounts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.billing_adjustments
    ADD CONSTRAINT billing_adjustments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.billing_credit_notes
    ADD CONSTRAINT billing_credit_notes_number_key UNIQUE (number);
ALTER TABLE ONLY public.billing_credit_notes
    ADD CONSTRAINT billing_credit_notes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.billing_events
    ADD CONSTRAINT billing_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.billing_invoice_lines
    ADD CONSTRAINT billing_invoice_lines_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.billing_invoices
    ADD CONSTRAINT billing_invoices_number_key UNIQUE (number);
ALTER TABLE ONLY public.billing_invoices
    ADD CONSTRAINT billing_invoices_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.billing_number_series
    ADD CONSTRAINT billing_number_series_pkey PRIMARY KEY (series, fiscal_year);
ALTER TABLE ONLY public.billing_payments
    ADD CONSTRAINT billing_payments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.billing_plans
    ADD CONSTRAINT billing_plans_code_key UNIQUE (code);
ALTER TABLE ONLY public.billing_plans
    ADD CONSTRAINT billing_plans_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.billing_reminders
    ADD CONSTRAINT billing_reminders_pkey PRIMARY KEY (invoice_id, kind);
ALTER TABLE ONLY public.billing_settings
    ADD CONSTRAINT billing_settings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.billing_subscriptions
    ADD CONSTRAINT billing_subscriptions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.billing_suspensions
    ADD CONSTRAINT billing_suspensions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.billing_usage_snapshots
    ADD CONSTRAINT billing_usage_snapshots_pkey PRIMARY KEY (organization_id, snapshot_date);
ALTER TABLE ONLY public.compliance_control_state
    ADD CONSTRAINT compliance_control_state_pkey PRIMARY KEY (framework, control_id);
ALTER TABLE ONLY public.compliance_evidence
    ADD CONSTRAINT compliance_evidence_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.compliance_policies
    ADD CONSTRAINT compliance_policies_key_version_key UNIQUE (key, version);
ALTER TABLE ONLY public.compliance_policies
    ADD CONSTRAINT compliance_policies_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.email_outbox
    ADD CONSTRAINT email_outbox_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.employee_import_jobs
    ADD CONSTRAINT employee_import_jobs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.employee_master_details
    ADD CONSTRAINT employee_master_details_pkey PRIMARY KEY (organization_id, employee_id);
ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_organization_id_employee_number_key UNIQUE (organization_id, employee_number);
ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_organization_id_user_id_key UNIQUE (organization_id, user_id);
ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_organization_id_work_email_key UNIQUE (organization_id, work_email);
ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.group_admins
    ADD CONSTRAINT group_admins_pkey PRIMARY KEY (group_id, user_id);
ALTER TABLE ONLY public.hr_case_counters
    ADD CONSTRAINT hr_case_counters_pkey PRIMARY KEY (organization_id, module);
ALTER TABLE ONLY public.hr_case_events
    ADD CONSTRAINT hr_case_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.hr_cases
    ADD CONSTRAINT hr_cases_organization_id_case_number_key UNIQUE (organization_id, case_number);
ALTER TABLE ONLY public.hr_cases
    ADD CONSTRAINT hr_cases_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.import_batch_changes
    ADD CONSTRAINT import_batch_changes_batch_id_seq_key UNIQUE (batch_id, seq);
ALTER TABLE ONLY public.import_batch_changes
    ADD CONSTRAINT import_batch_changes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.integration_device_nonces
    ADD CONSTRAINT integration_device_nonces_pkey PRIMARY KEY (device_id, signature);
ALTER TABLE ONLY public.integration_device_punches
    ADD CONSTRAINT integration_device_punches_device_id_external_id_key UNIQUE (device_id, external_id);
ALTER TABLE ONLY public.integration_device_punches
    ADD CONSTRAINT integration_device_punches_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.integration_device_users
    ADD CONSTRAINT integration_device_users_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.integration_devices
    ADD CONSTRAINT integration_devices_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.job_dispatch_log
    ADD CONSTRAINT job_dispatch_log_pkey PRIMARY KEY (organization_id, dedupe_key);
ALTER TABLE ONLY public.job_runs
    ADD CONSTRAINT job_runs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.kpis
    ADD CONSTRAINT kpis_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.leave_balance_ledger
    ADD CONSTRAINT leave_balance_ledger_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.leave_types
    ADD CONSTRAINT leave_types_organization_id_code_key UNIQUE (organization_id, code);
ALTER TABLE ONLY public.leave_types
    ADD CONSTRAINT leave_types_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.lms_certificates
    ADD CONSTRAINT lms_certificates_enrollment_id_key UNIQUE (enrollment_id);
ALTER TABLE ONLY public.lms_certificates
    ADD CONSTRAINT lms_certificates_organization_id_verification_code_key UNIQUE (organization_id, verification_code);
ALTER TABLE ONLY public.lms_certificates
    ADD CONSTRAINT lms_certificates_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.lms_courses
    ADD CONSTRAINT lms_courses_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.lms_enrollments
    ADD CONSTRAINT lms_enrollments_organization_id_course_id_employee_id_key UNIQUE (organization_id, course_id, employee_id);
ALTER TABLE ONLY public.lms_enrollments
    ADD CONSTRAINT lms_enrollments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.lms_lesson_progress
    ADD CONSTRAINT lms_lesson_progress_pkey PRIMARY KEY (enrollment_id, lesson_id);
ALTER TABLE ONLY public.lms_lessons
    ADD CONSTRAINT lms_lessons_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.lms_questions
    ADD CONSTRAINT lms_questions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.lms_quiz_attempts
    ADD CONSTRAINT lms_quiz_attempts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (organization_id, employee_id);
ALTER TABLE ONLY public.notification_read_cursors
    ADD CONSTRAINT notification_read_cursors_pkey PRIMARY KEY (organization_id, employee_id);
ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_pkey PRIMARY KEY (organization_id, employee_id, event_id);
ALTER TABLE ONLY public.onboarding_document_reviews
    ADD CONSTRAINT onboarding_document_reviews_pkey PRIMARY KEY (file_id);
ALTER TABLE ONLY public.onboarding_joiners
    ADD CONSTRAINT onboarding_joiners_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.onboarding_settings
    ADD CONSTRAINT onboarding_settings_pkey PRIMARY KEY (organization_id);
ALTER TABLE ONLY public.onboarding_tasks
    ADD CONSTRAINT onboarding_tasks_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.onboarding_template_tasks
    ADD CONSTRAINT onboarding_template_tasks_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.onboarding_templates
    ADD CONSTRAINT onboarding_templates_organization_id_name_key UNIQUE (organization_id, name);
ALTER TABLE ONLY public.onboarding_templates
    ADD CONSTRAINT onboarding_templates_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.organization_auth_policies
    ADD CONSTRAINT organization_auth_policies_pkey PRIMARY KEY (organization_id);
ALTER TABLE ONLY public.organization_groups
    ADD CONSTRAINT organization_groups_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.organization_groups
    ADD CONSTRAINT organization_groups_slug_key UNIQUE (slug);
ALTER TABLE ONLY public.organization_memberships
    ADD CONSTRAINT organization_memberships_pkey PRIMARY KEY (organization_id, user_id);
ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_slug_key UNIQUE (slug);
ALTER TABLE ONLY public.payout_batches
    ADD CONSTRAINT payout_batches_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payout_events
    ADD CONSTRAINT payout_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payout_items
    ADD CONSTRAINT payout_items_batch_id_employee_id_key UNIQUE (batch_id, employee_id);
ALTER TABLE ONLY public.payout_items
    ADD CONSTRAINT payout_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payout_sandbox_payouts
    ADD CONSTRAINT payout_sandbox_payouts_organization_id_reference_id_key UNIQUE (organization_id, reference_id);
ALTER TABLE ONLY public.payout_sandbox_payouts
    ADD CONSTRAINT payout_sandbox_payouts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payout_webhook_receipts
    ADD CONSTRAINT payout_webhook_receipts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payroll_inputs
    ADD CONSTRAINT payroll_inputs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payroll_profiles
    ADD CONSTRAINT payroll_profiles_pkey PRIMARY KEY (organization_id, employee_id);
ALTER TABLE ONLY public.payroll_run_lines
    ADD CONSTRAINT payroll_run_lines_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payroll_run_lines
    ADD CONSTRAINT payroll_run_lines_run_id_employee_id_key UNIQUE (run_id, employee_id);
ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payroll_settings
    ADD CONSTRAINT payroll_settings_pkey PRIMARY KEY (organization_id);
ALTER TABLE ONLY public.payroll_ytd_monthly
    ADD CONSTRAINT payroll_ytd_monthly_organization_id_employee_id_period_key UNIQUE (organization_id, employee_id, period);
ALTER TABLE ONLY public.payroll_ytd_monthly
    ADD CONSTRAINT payroll_ytd_monthly_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payroll_ytd_opening
    ADD CONSTRAINT payroll_ytd_opening_organization_id_employee_id_fiscal_year_key UNIQUE (organization_id, employee_id, fiscal_year);
ALTER TABLE ONLY public.payroll_ytd_opening
    ADD CONSTRAINT payroll_ytd_opening_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payslips
    ADD CONSTRAINT payslips_organization_id_employee_id_period_key UNIQUE (organization_id, employee_id, period);
ALTER TABLE ONLY public.payslips
    ADD CONSTRAINT payslips_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_pkey PRIMARY KEY (user_id);
ALTER TABLE ONLY public.policy_acknowledgements
    ADD CONSTRAINT policy_acknowledgements_pkey PRIMARY KEY (policy_id, user_id);
ALTER TABLE ONLY public.privacy_brand_closures
    ADD CONSTRAINT privacy_brand_closures_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.privacy_brand_exports
    ADD CONSTRAINT privacy_brand_exports_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.privacy_breaches
    ADD CONSTRAINT privacy_breaches_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.privacy_breaches
    ADD CONSTRAINT privacy_breaches_reference_key UNIQUE (reference);
ALTER TABLE ONLY public.privacy_erasure_runs
    ADD CONSTRAINT privacy_erasure_runs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.privacy_exports
    ADD CONSTRAINT privacy_exports_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.privacy_settings
    ADD CONSTRAINT privacy_settings_pkey PRIMARY KEY (organization_id);
ALTER TABLE ONLY public.privacy_subject_state
    ADD CONSTRAINT privacy_subject_state_pkey PRIMARY KEY (organization_id, employee_id);
ALTER TABLE ONLY public.push_deliveries
    ADD CONSTRAINT push_deliveries_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.push_devices
    ADD CONSTRAINT push_devices_organization_id_provider_token_hash_key UNIQUE (organization_id, provider, token_hash);
ALTER TABLE ONLY public.push_devices
    ADD CONSTRAINT push_devices_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.push_fanout_cursors
    ADD CONSTRAINT push_fanout_cursors_pkey PRIMARY KEY (organization_id);
ALTER TABLE ONLY public.push_notifications
    ADD CONSTRAINT push_notifications_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.receipt_scans
    ADD CONSTRAINT receipt_scans_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.risk_compliance_marks
    ADD CONSTRAINT risk_compliance_marks_pkey PRIMARY KEY (organization_id, obligation_key);
ALTER TABLE ONLY public.risk_minimum_wages
    ADD CONSTRAINT risk_minimum_wages_organization_id_state_code_category_effe_key UNIQUE (organization_id, state_code, category, effective_from);
ALTER TABLE ONLY public.risk_minimum_wages
    ADD CONSTRAINT risk_minimum_wages_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.risk_settings
    ADD CONSTRAINT risk_settings_pkey PRIMARY KEY (organization_id);
ALTER TABLE ONLY public.risk_signal_events
    ADD CONSTRAINT risk_signal_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.risk_signals
    ADD CONSTRAINT risk_signals_organization_id_detector_subject_key_key UNIQUE (organization_id, detector, subject_key);
ALTER TABLE ONLY public.risk_signals
    ADD CONSTRAINT risk_signals_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.roster_assignments
    ADD CONSTRAINT roster_assignments_organization_id_employee_id_work_date_key UNIQUE (organization_id, employee_id, work_date);
ALTER TABLE ONLY public.roster_assignments
    ADD CONSTRAINT roster_assignments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.roster_publications
    ADD CONSTRAINT roster_publications_organization_id_employee_id_week_start_key UNIQUE (organization_id, employee_id, week_start);
ALTER TABLE ONLY public.roster_publications
    ADD CONSTRAINT roster_publications_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.roster_settings
    ADD CONSTRAINT roster_settings_pkey PRIMARY KEY (organization_id);
ALTER TABLE ONLY public.roster_shift_templates
    ADD CONSTRAINT roster_shift_templates_organization_id_code_key UNIQUE (organization_id, code);
ALTER TABLE ONLY public.roster_shift_templates
    ADD CONSTRAINT roster_shift_templates_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.salary_structures
    ADD CONSTRAINT salary_structures_organization_id_employee_id_effective_fro_key UNIQUE (organization_id, employee_id, effective_from);
ALTER TABLE ONLY public.salary_structures
    ADD CONSTRAINT salary_structures_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);
ALTER TABLE ONLY public.security_events
    ADD CONSTRAINT security_events_bucket_client_ip_status_reason_method_route_key UNIQUE (bucket, client_ip, status, reason, method, route, organization_id, user_id);
ALTER TABLE ONLY public.security_events
    ADD CONSTRAINT security_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.stored_files
    ADD CONSTRAINT stored_files_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.survey_answers
    ADD CONSTRAINT survey_answers_pkey PRIMARY KEY (response_id, question_id);
ALTER TABLE ONLY public.survey_invitations
    ADD CONSTRAINT survey_invitations_pkey PRIMARY KEY (survey_id, employee_id);
ALTER TABLE ONLY public.survey_questions
    ADD CONSTRAINT survey_questions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.survey_questions
    ADD CONSTRAINT survey_questions_survey_id_position_key UNIQUE (survey_id, "position") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY public.survey_responses
    ADD CONSTRAINT survey_responses_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.surveys
    ADD CONSTRAINT surveys_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.switchover_settings
    ADD CONSTRAINT switchover_settings_pkey PRIMARY KEY (organization_id);
ALTER TABLE ONLY public.tax_declaration_proofs
    ADD CONSTRAINT tax_declaration_proofs_pkey PRIMARY KEY (file_id);
ALTER TABLE ONLY public.tax_declarations
    ADD CONSTRAINT tax_declarations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.tax_document_sets
    ADD CONSTRAINT tax_document_sets_organization_id_fy_start_key UNIQUE (organization_id, fy_start);
ALTER TABLE ONLY public.tax_document_sets
    ADD CONSTRAINT tax_document_sets_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.tax_documents
    ADD CONSTRAINT tax_documents_organization_id_fy_start_employee_id_key UNIQUE (organization_id, fy_start, employee_id);
ALTER TABLE ONLY public.tax_documents
    ADD CONSTRAINT tax_documents_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.tds_challan_allocations
    ADD CONSTRAINT tds_challan_allocations_challan_id_employee_id_run_id_key UNIQUE (challan_id, employee_id, run_id);
ALTER TABLE ONLY public.tds_challan_allocations
    ADD CONSTRAINT tds_challan_allocations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.tds_challans
    ADD CONSTRAINT tds_challans_organization_id_bsr_code_deposit_date_challan__key UNIQUE (organization_id, bsr_code, deposit_date, challan_serial);
ALTER TABLE ONLY public.tds_challans
    ADD CONSTRAINT tds_challans_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.tds_deductor_profiles
    ADD CONSTRAINT tds_deductor_profiles_pkey PRIMARY KEY (organization_id);
ALTER TABLE ONLY public.tds_returns
    ADD CONSTRAINT tds_returns_organization_id_fy_start_quarter_key UNIQUE (organization_id, fy_start, quarter);
ALTER TABLE ONLY public.tds_returns
    ADD CONSTRAINT tds_returns_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_subscription_id_event_id_key UNIQUE (subscription_id, event_id);
ALTER TABLE ONLY public.webhook_event_cursors
    ADD CONSTRAINT webhook_event_cursors_pkey PRIMARY KEY (organization_id);
ALTER TABLE ONLY public.webhook_events
    ADD CONSTRAINT webhook_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.workflow_events
    ADD CONSTRAINT workflow_events_pkey PRIMARY KEY (id);
CREATE INDEX access_assignments_expiry ON public.access_role_assignments USING btree (expires_at) WHERE ((revoked_at IS NULL) AND (expires_at IS NOT NULL));
CREATE UNIQUE INDEX access_assignments_live ON public.access_role_assignments USING btree (organization_id, employee_id, role_id) WHERE (revoked_at IS NULL);
CREATE INDEX access_assignments_role ON public.access_role_assignments USING btree (organization_id, role_id) WHERE (revoked_at IS NULL);
CREATE INDEX access_review_items_review ON public.access_review_items USING btree (review_id);
CREATE UNIQUE INDEX access_roles_org_name ON public.access_roles USING btree (organization_id, lower(name));
CREATE INDEX accounting_exports_history ON public.accounting_exports USING btree (organization_id, created_at DESC);
CREATE INDEX attendance_daily_reporting ON public.attendance_events USING btree (organization_id, occurred_at, event_type, employee_id);
CREATE INDEX attendance_devices_employee ON public.attendance_devices USING btree (organization_id, employee_id, status);
CREATE UNIQUE INDEX attendance_devices_one_owner ON public.attendance_devices USING btree (organization_id, key_hash) WHERE (status = 'ACTIVE'::text);
CREATE UNIQUE INDEX attendance_devices_one_request ON public.attendance_devices USING btree (organization_id, employee_id, key_hash) WHERE (status = 'PENDING'::text);
CREATE INDEX attendance_employee_timeline ON public.attendance_events USING btree (organization_id, employee_id, occurred_at DESC, id);
CREATE INDEX attendance_location_review ON public.attendance_events USING btree (organization_id, employee_id, accuracy_metres, occurred_at DESC);
CREATE INDEX attendance_review_queue ON public.attendance_events USING btree (organization_id, review_status, occurred_at DESC) WHERE (review_status = 'PENDING'::text);
CREATE INDEX attendance_reviewed_history ON public.attendance_events USING btree (organization_id, review_status, occurred_at DESC) WHERE (review_status = ANY (ARRAY['APPROVED'::text, 'REJECTED'::text]));
CREATE INDEX audit_actor_history ON public.audit_log USING btree (organization_id, actor_user_id, created_at DESC, id);
CREATE UNIQUE INDEX audit_chain_order ON public.audit_log USING btree (organization_id, chain_seq);
CREATE INDEX audit_entity_history ON public.audit_log USING btree (organization_id, entity_type, entity_id, created_at DESC, id);
CREATE INDEX audit_org_recent ON public.audit_log USING btree (organization_id, created_at DESC, id DESC);
CREATE INDEX auth_events_recent ON public.auth_events USING btree (created_at DESC);
CREATE INDEX auth_events_user ON public.auth_events USING btree (user_id, created_at DESC);
CREATE INDEX auth_invites_org ON public.auth_invites USING btree (organization_id, employee_id, created_at DESC);
CREATE INDEX auth_invites_user ON public.auth_invites USING btree (user_id) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL));
CREATE INDEX auth_ott_user ON public.auth_one_time_tokens USING btree (user_id, purpose) WHERE (used_at IS NULL);
CREATE INDEX auth_password_history_user ON public.auth_password_history USING btree (user_id, created_at DESC);
CREATE INDEX auth_recovery_user ON public.auth_recovery_codes USING btree (user_id) WHERE (used_at IS NULL);
CREATE INDEX auth_refresh_session ON public.auth_refresh_tokens USING btree (session_id);
CREATE INDEX auth_sessions_user ON public.auth_sessions USING btree (user_id, revoked_at, last_seen_at DESC);
CREATE INDEX auth_totp_user ON public.auth_totp_devices USING btree (user_id) WHERE (confirmed_at IS NOT NULL);
CREATE INDEX billing_invoice_lines_invoice ON public.billing_invoice_lines USING btree (invoice_id, "position");
CREATE UNIQUE INDEX billing_invoices_one_per_period ON public.billing_invoices USING btree (account_id, period_start);
CREATE INDEX billing_invoices_status ON public.billing_invoices USING btree (status, due_date);
CREATE INDEX billing_payments_invoice ON public.billing_payments USING btree (invoice_id);
CREATE INDEX billing_subscriptions_account ON public.billing_subscriptions USING btree (account_id, contract_start);
CREATE INDEX billing_suspensions_open ON public.billing_suspensions USING btree (organization_id) WHERE (reactivated_at IS NULL);
CREATE INDEX compliance_evidence_check ON public.compliance_evidence USING btree (check_id, collected_at DESC) WHERE (check_id IS NOT NULL);
CREATE INDEX compliance_evidence_control ON public.compliance_evidence USING btree (framework, control_id, collected_at DESC) WHERE (control_id IS NOT NULL);
CREATE INDEX email_outbox_delivery ON public.email_outbox USING btree (status, available_at, id) WHERE (status = ANY (ARRAY['PENDING'::text, 'FAILED'::text]));
CREATE INDEX email_outbox_recent ON public.email_outbox USING btree (organization_id, created_at DESC);
CREATE INDEX employees_department_directory ON public.employees USING btree (organization_id, status, department, full_name, id);
CREATE INDEX employees_manager_directory ON public.employees USING btree (organization_id, manager_id, status, full_name, id);
CREATE INDEX employees_register_order ON public.employees USING btree (organization_id, status, full_name, id);
CREATE INDEX employees_work_email_lower ON public.employees USING btree (organization_id, lower(work_email));
CREATE INDEX hr_case_events_timeline ON public.hr_case_events USING btree (organization_id, case_id, id);
CREATE INDEX hr_cases_approver_queue ON public.hr_cases USING btree (organization_id, approver_id, status, created_at, id);
CREATE INDEX hr_cases_assignee_queue ON public.hr_cases USING btree (organization_id, assignee_id, status, due_at, id) WHERE (assignee_id IS NOT NULL);
CREATE INDEX hr_cases_module_board ON public.hr_cases USING btree (organization_id, module, status, created_at DESC, id);
CREATE INDEX hr_cases_requester_history ON public.hr_cases USING btree (organization_id, module, requester_id, created_at DESC, id);
CREATE INDEX hr_cases_subject_history ON public.hr_cases USING btree (organization_id, subject_employee_id, created_at DESC, id) WHERE (subject_employee_id IS NOT NULL);
CREATE INDEX import_batch_changes_batch ON public.import_batch_changes USING btree (organization_id, batch_id, seq);
CREATE UNIQUE INDEX import_batches_key ON public.import_batches USING btree (organization_id, kind, batch_key) WHERE (status = 'COMMITTED'::text);
CREATE INDEX import_batches_recent ON public.import_batches USING btree (organization_id, kind, created_at DESC);
CREATE INDEX import_jobs_org_recent ON public.employee_import_jobs USING btree (organization_id, created_at DESC, id);
CREATE INDEX integration_device_punches_recent ON public.integration_device_punches USING btree (device_id, received_at DESC);
CREATE INDEX integration_device_punches_unmatched ON public.integration_device_punches USING btree (organization_id, device_user_id, occurred_at) WHERE (status = 'UNMATCHED'::text);
CREATE INDEX integration_device_users_employee ON public.integration_device_users USING btree (organization_id, employee_id);
CREATE UNIQUE INDEX integration_device_users_pin ON public.integration_device_users USING btree (organization_id, device_user_id, COALESCE(device_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX integration_devices_org ON public.integration_devices USING btree (organization_id, name);
CREATE UNIQUE INDEX integration_devices_serial ON public.integration_devices USING btree (upper(serial_number));
CREATE INDEX job_dispatch_log_age ON public.job_dispatch_log USING btree (organization_id, created_at);
CREATE INDEX job_runs_recent ON public.job_runs USING btree (organization_id, job_name, started_at DESC);
CREATE INDEX kpi_employee_period ON public.kpis USING btree (organization_id, employee_id, period, status, id);
CREATE INDEX kpi_manager_queue ON public.kpis USING btree (organization_id, manager_id, status, submitted_at, id);
CREATE INDEX leave_balance_ledger_employee ON public.leave_balance_ledger USING btree (organization_id, employee_id, leave_type_id, as_of);
CREATE UNIQUE INDEX leave_balance_ledger_one_opening ON public.leave_balance_ledger USING btree (organization_id, employee_id, leave_type_id) WHERE (entry_type = 'OPENING'::text);
CREATE INDEX leave_employee_history ON public.leave_requests USING btree (organization_id, employee_id, submitted_at DESC, status, id);
CREATE INDEX leave_manager_queue ON public.leave_requests USING btree (organization_id, approver_id, status, submitted_at DESC, id);
CREATE INDEX leave_overlap_check ON public.leave_requests USING btree (organization_id, employee_id, start_date, end_date) WHERE (status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text]));
CREATE INDEX leave_types_active ON public.leave_types USING btree (organization_id, active, name);
CREATE INDEX lms_certificates_employee ON public.lms_certificates USING btree (organization_id, employee_id, issued_at DESC);
CREATE INDEX lms_courses_catalogue ON public.lms_courses USING btree (organization_id, status, category, title);
CREATE INDEX lms_enrollments_course ON public.lms_enrollments USING btree (organization_id, course_id, status, due_date);
CREATE INDEX lms_enrollments_learner ON public.lms_enrollments USING btree (organization_id, employee_id, status, due_date);
CREATE INDEX lms_lessons_outline ON public.lms_lessons USING btree (organization_id, course_id, "position", id);
CREATE INDEX lms_questions_quiz ON public.lms_questions USING btree (organization_id, lesson_id, "position");
CREATE INDEX lms_quiz_attempts_learner ON public.lms_quiz_attempts USING btree (organization_id, enrollment_id, lesson_id, created_at);
CREATE INDEX memberships_org_role_active ON public.organization_memberships USING btree (organization_id, role, user_id) WHERE (status = 'ACTIVE'::text);
CREATE INDEX memberships_user_active ON public.organization_memberships USING btree (user_id, status, organization_id);
CREATE INDEX onboarding_document_reviews_joiner ON public.onboarding_document_reviews USING btree (organization_id, joiner_id);
CREATE UNIQUE INDEX onboarding_joiners_candidate ON public.onboarding_joiners USING btree (organization_id, candidate_case_id) WHERE (candidate_case_id IS NOT NULL);
CREATE UNIQUE INDEX onboarding_joiners_employee ON public.onboarding_joiners USING btree (organization_id, employee_id) WHERE (employee_id IS NOT NULL);
CREATE INDEX onboarding_joiners_manager ON public.onboarding_joiners USING btree (organization_id, manager_id, joining_date) WHERE (manager_id IS NOT NULL);
CREATE INDEX onboarding_joiners_pan_hash ON public.onboarding_joiners USING btree (organization_id, pan_hash) WHERE (pan_hash IS NOT NULL);
CREATE INDEX onboarding_joiners_pipeline ON public.onboarding_joiners USING btree (organization_id, status, joining_date, id);
CREATE INDEX onboarding_tasks_joiner ON public.onboarding_tasks USING btree (organization_id, joiner_id, phase, sort_order);
CREATE INDEX onboarding_tasks_owner_queue ON public.onboarding_tasks USING btree (organization_id, owner_id, status, due_date) WHERE (owner_id IS NOT NULL);
CREATE INDEX onboarding_template_tasks_template ON public.onboarding_template_tasks USING btree (organization_id, template_id, sort_order);
CREATE UNIQUE INDEX onboarding_templates_one_default ON public.onboarding_templates USING btree (organization_id) WHERE (is_default AND (archived_at IS NULL));
CREATE INDEX organizations_group ON public.organizations USING btree (group_id, status);
CREATE INDEX payout_batches_in_flight ON public.payout_batches USING btree (status) WHERE (status = ANY (ARRAY['RELEASED'::text, 'PROCESSING'::text]));
CREATE INDEX payout_batches_list ON public.payout_batches USING btree (organization_id, created_at DESC);
CREATE UNIQUE INDEX payout_batches_live_run ON public.payout_batches USING btree (organization_id, run_id) WHERE (status <> 'CANCELLED'::text);
CREATE INDEX payout_events_batch ON public.payout_events USING btree (organization_id, batch_id, id);
CREATE INDEX payout_items_batch ON public.payout_items USING btree (organization_id, batch_id, status);
CREATE UNIQUE INDEX payout_items_provider ON public.payout_items USING btree (provider_payout_id) WHERE (provider_payout_id IS NOT NULL);
CREATE UNIQUE INDEX payout_items_reference ON public.payout_items USING btree (organization_id, reference);
CREATE UNIQUE INDEX payout_webhook_receipts_event ON public.payout_webhook_receipts USING btree (event_id) WHERE (event_id IS NOT NULL);
CREATE INDEX payout_webhook_receipts_received ON public.payout_webhook_receipts USING btree (received_at);
CREATE UNIQUE INDEX payout_webhook_receipts_signature ON public.payout_webhook_receipts USING btree (signature_hash);
CREATE INDEX payroll_inputs_run ON public.payroll_inputs USING btree (organization_id, run_id, employee_id) WHERE (voided_at IS NULL);
CREATE UNIQUE INDEX payroll_inputs_source_once ON public.payroll_inputs USING btree (organization_id, source, source_ref) WHERE ((source_ref IS NOT NULL) AND (voided_at IS NULL));
CREATE INDEX payroll_profiles_bank_hash ON public.payroll_profiles USING btree (organization_id, bank_account_hash) WHERE (bank_account_hash IS NOT NULL);
CREATE INDEX payroll_profiles_pan_hash ON public.payroll_profiles USING btree (organization_id, pan_hash) WHERE (pan_hash IS NOT NULL);
CREATE INDEX payroll_run_lines_employee ON public.payroll_run_lines USING btree (organization_id, employee_id, run_id);
CREATE INDEX payroll_runs_list ON public.payroll_runs USING btree (organization_id, period DESC, created_at DESC);
CREATE UNIQUE INDEX payroll_runs_live_period ON public.payroll_runs USING btree (organization_id, period) WHERE (status <> 'CANCELLED'::text);
CREATE INDEX payslip_employee_published ON public.payslips USING btree (organization_id, employee_id, status, period DESC, id);
CREATE INDEX payslip_period_admin ON public.payslips USING btree (organization_id, period, status, employee_id);
CREATE UNIQUE INDEX privacy_brand_closures_live ON public.privacy_brand_closures USING btree (organization_id) WHERE (status = ANY (ARRAY['PENDING_CONFIRMATION'::text, 'SCHEDULED'::text, 'DELETING'::text]));
CREATE INDEX privacy_brand_exports_org ON public.privacy_brand_exports USING btree (organization_id, created_at DESC);
CREATE INDEX privacy_breaches_org ON public.privacy_breaches USING btree (organization_id, detected_at DESC);
CREATE INDEX privacy_erasure_runs_recent ON public.privacy_erasure_runs USING btree (organization_id, created_at DESC);
CREATE INDEX privacy_exports_employee ON public.privacy_exports USING btree (organization_id, employee_id, created_at DESC);
CREATE INDEX privacy_exports_expiry ON public.privacy_exports USING btree (organization_id, expires_at) WHERE (purged_at IS NULL);
CREATE INDEX push_deliveries_device ON public.push_deliveries USING btree (organization_id, device_id, created_at DESC);
CREATE INDEX push_deliveries_notification ON public.push_deliveries USING btree (organization_id, notification_id);
CREATE INDEX push_devices_recipient ON public.push_devices USING btree (organization_id, employee_id) WHERE active;
CREATE INDEX push_notifications_due ON public.push_notifications USING btree (organization_id, status, send_after, id) WHERE (status = ANY (ARRAY['PENDING'::text, 'SENDING'::text]));
CREATE UNIQUE INDEX push_notifications_event ON public.push_notifications USING btree (organization_id, event_id) WHERE (kind = 'EVENT'::text);
CREATE INDEX push_notifications_recipient_recent ON public.push_notifications USING btree (organization_id, employee_id, created_at DESC);
CREATE INDEX receipt_scans_employee ON public.receipt_scans USING btree (organization_id, employee_id, created_at DESC);
CREATE INDEX receipt_scans_sha ON public.receipt_scans USING btree (organization_id, sha256);
CREATE INDEX regularization_employee_history ON public.attendance_regularizations USING btree (organization_id, employee_id, attendance_date DESC, id);
CREATE INDEX regularization_manager_queue ON public.attendance_regularizations USING btree (organization_id, approver_id, status, submitted_at, id);
CREATE INDEX risk_signal_events_signal ON public.risk_signal_events USING btree (organization_id, signal_id, created_at);
CREATE INDEX risk_signals_list ON public.risk_signals USING btree (organization_id, status, area, severity, last_detected_at DESC);
CREATE INDEX risk_signals_people ON public.risk_signals USING gin (employee_ids);
CREATE INDEX roster_assignments_by_case ON public.roster_assignments USING btree (organization_id, source_case_id) WHERE (source_case_id IS NOT NULL);
CREATE INDEX roster_assignments_by_day ON public.roster_assignments USING btree (organization_id, work_date, template_id);
CREATE INDEX security_events_org ON public.security_events USING btree (organization_id, last_seen DESC) WHERE (organization_id IS NOT NULL);
CREATE INDEX security_events_recent ON public.security_events USING btree (last_seen DESC);
CREATE INDEX stored_files_entity ON public.stored_files USING btree (organization_id, entity_type, entity_id, created_at) WHERE (deleted_at IS NULL);
CREATE INDEX stored_files_purge ON public.stored_files USING btree (organization_id, deleted_at) WHERE (deleted_at IS NOT NULL);
CREATE INDEX survey_answers_by_question ON public.survey_answers USING btree (organization_id, question_id);
CREATE INDEX survey_invitations_employee ON public.survey_invitations USING btree (organization_id, employee_id, survey_id);
CREATE INDEX survey_responses_by_survey ON public.survey_responses USING btree (organization_id, survey_id);
CREATE UNIQUE INDEX survey_responses_one_per_employee ON public.survey_responses USING btree (survey_id, employee_id) WHERE (employee_id IS NOT NULL);
CREATE INDEX surveys_board ON public.surveys USING btree (organization_id, kind, status, created_at DESC);
CREATE INDEX surveys_due_close ON public.surveys USING btree (organization_id, closes_at) WHERE ((status = 'LIVE'::text) AND (closes_at IS NOT NULL));
CREATE INDEX surveys_owner ON public.surveys USING btree (organization_id, owner_id, created_at DESC);
CREATE INDEX tax_declaration_proofs_declaration ON public.tax_declaration_proofs USING btree (organization_id, declaration_id, created_at);
CREATE INDEX tax_declarations_employee ON public.tax_declarations USING btree (organization_id, employee_id, updated_at DESC, id);
CREATE UNIQUE INDEX tax_declarations_one_open ON public.tax_declarations USING btree (organization_id, employee_id, tax_year) WHERE (status = ANY (ARRAY['DRAFT'::text, 'SUBMITTED'::text, 'CLARIFICATION'::text]));
CREATE INDEX tax_declarations_review_queue ON public.tax_declarations USING btree (organization_id, status, submitted_at, id);
CREATE INDEX tds_alloc_employee ON public.tds_challan_allocations USING btree (organization_id, employee_id, period);
CREATE INDEX tds_challans_period ON public.tds_challans USING btree (organization_id, fy_start, period);
CREATE INDEX users_email_lower ON public.users USING btree (lower(email));
CREATE UNIQUE INDEX users_oidc_identity ON public.users USING btree (oidc_issuer, oidc_subject) WHERE (oidc_subject IS NOT NULL);
CREATE INDEX webhook_deliveries_log ON public.webhook_deliveries USING btree (organization_id, subscription_id, created_at DESC);
CREATE UNIQUE INDEX webhook_events_audit ON public.webhook_events USING btree (organization_id, source_audit_id) WHERE (source_audit_id IS NOT NULL);
CREATE INDEX webhook_subscriptions_org ON public.webhook_subscriptions USING btree (organization_id, status);
CREATE INDEX workflow_events_age ON public.workflow_events USING btree (organization_id, created_at);
CREATE INDEX workflow_events_entity ON public.workflow_events USING btree (organization_id, entity_type, entity_id, id DESC);
CREATE INDEX workflow_events_stream ON public.workflow_events USING btree (organization_id, employee_id, id);
CREATE TRIGGER audit_log_chain BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.audit_log_chain();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON public.audit_log FOR EACH STATEMENT EXECUTE FUNCTION public.audit_log_append_only();
CREATE TRIGGER audit_log_no_update BEFORE DELETE OR UPDATE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.audit_log_append_only();
CREATE TRIGGER billing_credit_note_guard BEFORE DELETE OR UPDATE ON public.billing_credit_notes FOR EACH ROW EXECUTE FUNCTION public.billing_frozen_guard();
CREATE TRIGGER billing_events_guard BEFORE DELETE OR UPDATE ON public.billing_events FOR EACH ROW EXECUTE FUNCTION public.billing_frozen_guard();
CREATE TRIGGER billing_invoice_guard BEFORE DELETE OR UPDATE ON public.billing_invoices FOR EACH ROW EXECUTE FUNCTION public.billing_invoice_guard();
CREATE TRIGGER billing_line_guard BEFORE INSERT OR DELETE OR UPDATE ON public.billing_invoice_lines FOR EACH ROW EXECUTE FUNCTION public.billing_line_guard();
CREATE TRIGGER billing_payment_guard BEFORE DELETE OR UPDATE ON public.billing_payments FOR EACH ROW EXECUTE FUNCTION public.billing_payment_guard();
CREATE TRIGGER compliance_evidence_immutable BEFORE DELETE OR UPDATE ON public.compliance_evidence FOR EACH ROW EXECUTE FUNCTION public.compliance_evidence_immutable();
CREATE TRIGGER survey_questions_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.survey_questions FOR EACH ROW EXECUTE FUNCTION public.survey_questions_guard();
ALTER TABLE ONLY public.access_org_state
    ADD CONSTRAINT access_org_state_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.access_review_items
    ADD CONSTRAINT access_review_items_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.access_review_items
    ADD CONSTRAINT access_review_items_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.access_review_items
    ADD CONSTRAINT access_review_items_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.access_reviews(id);
ALTER TABLE ONLY public.access_review_items
    ADD CONSTRAINT access_review_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.access_reviews
    ADD CONSTRAINT access_reviews_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.access_reviews
    ADD CONSTRAINT access_reviews_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.access_role_assignments
    ADD CONSTRAINT access_role_assignments_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.access_role_assignments
    ADD CONSTRAINT access_role_assignments_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.access_role_assignments
    ADD CONSTRAINT access_role_assignments_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.access_role_assignments
    ADD CONSTRAINT access_role_assignments_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.access_role_assignments
    ADD CONSTRAINT access_role_assignments_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.access_roles(id);
ALTER TABLE ONLY public.access_roles
    ADD CONSTRAINT access_roles_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.access_roles
    ADD CONSTRAINT access_roles_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.access_roles
    ADD CONSTRAINT access_roles_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.accounting_exports
    ADD CONSTRAINT accounting_exports_exported_by_fkey FOREIGN KEY (exported_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.accounting_exports
    ADD CONSTRAINT accounting_exports_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.accounting_exports
    ADD CONSTRAINT accounting_exports_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.payroll_runs(id);
ALTER TABLE ONLY public.accounting_settings
    ADD CONSTRAINT accounting_settings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.accounting_settings
    ADD CONSTRAINT accounting_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.attendance_devices
    ADD CONSTRAINT attendance_devices_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.attendance_devices
    ADD CONSTRAINT attendance_devices_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.attendance_devices
    ADD CONSTRAINT attendance_devices_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.attendance_events
    ADD CONSTRAINT attendance_events_device_record_id_fkey FOREIGN KEY (device_record_id) REFERENCES public.attendance_devices(id);
ALTER TABLE ONLY public.attendance_events
    ADD CONSTRAINT attendance_events_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.attendance_events
    ADD CONSTRAINT attendance_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.attendance_events
    ADD CONSTRAINT attendance_events_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.attendance_networks
    ADD CONSTRAINT attendance_networks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.attendance_networks
    ADD CONSTRAINT attendance_networks_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.attendance_networks
    ADD CONSTRAINT attendance_networks_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.attendance_sites(id);
ALTER TABLE ONLY public.attendance_policies
    ADD CONSTRAINT attendance_policies_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.attendance_policies
    ADD CONSTRAINT attendance_policies_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.attendance_regularizations
    ADD CONSTRAINT attendance_regularizations_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.attendance_regularizations
    ADD CONSTRAINT attendance_regularizations_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.attendance_regularizations
    ADD CONSTRAINT attendance_regularizations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.attendance_sites
    ADD CONSTRAINT attendance_sites_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.auth_events
    ADD CONSTRAINT auth_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.auth_events
    ADD CONSTRAINT auth_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.auth_invites
    ADD CONSTRAINT auth_invites_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.auth_invites
    ADD CONSTRAINT auth_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.auth_invites
    ADD CONSTRAINT auth_invites_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.auth_invites
    ADD CONSTRAINT auth_invites_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.auth_one_time_tokens
    ADD CONSTRAINT auth_one_time_tokens_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.auth_one_time_tokens
    ADD CONSTRAINT auth_one_time_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.auth_password_history
    ADD CONSTRAINT auth_password_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.auth_recovery_codes
    ADD CONSTRAINT auth_recovery_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.auth_refresh_tokens
    ADD CONSTRAINT auth_refresh_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.auth_sessions(id);
ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.auth_totp_devices
    ADD CONSTRAINT auth_totp_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.billing_accounts
    ADD CONSTRAINT billing_accounts_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.organization_groups(id);
ALTER TABLE ONLY public.billing_accounts
    ADD CONSTRAINT billing_accounts_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.billing_adjustments
    ADD CONSTRAINT billing_adjustments_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.billing_accounts(id);
ALTER TABLE ONLY public.billing_adjustments
    ADD CONSTRAINT billing_adjustments_applied_invoice_id_fkey FOREIGN KEY (applied_invoice_id) REFERENCES public.billing_invoices(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.billing_adjustments
    ADD CONSTRAINT billing_adjustments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.billing_credit_notes
    ADD CONSTRAINT billing_credit_notes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.billing_credit_notes
    ADD CONSTRAINT billing_credit_notes_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.billing_invoices(id);
ALTER TABLE ONLY public.billing_invoice_lines
    ADD CONSTRAINT billing_invoice_lines_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.billing_invoices(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.billing_invoice_lines
    ADD CONSTRAINT billing_invoice_lines_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.billing_invoices
    ADD CONSTRAINT billing_invoices_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.billing_accounts(id);
ALTER TABLE ONLY public.billing_invoices
    ADD CONSTRAINT billing_invoices_generated_by_fkey FOREIGN KEY (generated_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.billing_invoices
    ADD CONSTRAINT billing_invoices_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.billing_payments
    ADD CONSTRAINT billing_payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.billing_invoices(id);
ALTER TABLE ONLY public.billing_payments
    ADD CONSTRAINT billing_payments_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.billing_payments
    ADD CONSTRAINT billing_payments_reversed_by_fkey FOREIGN KEY (reversed_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.billing_reminders
    ADD CONSTRAINT billing_reminders_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.billing_invoices(id);
ALTER TABLE ONLY public.billing_settings
    ADD CONSTRAINT billing_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.billing_subscriptions
    ADD CONSTRAINT billing_subscriptions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.billing_accounts(id);
ALTER TABLE ONLY public.billing_subscriptions
    ADD CONSTRAINT billing_subscriptions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.billing_subscriptions
    ADD CONSTRAINT billing_subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.billing_plans(id);
ALTER TABLE ONLY public.billing_suspensions
    ADD CONSTRAINT billing_suspensions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.billing_accounts(id);
ALTER TABLE ONLY public.billing_suspensions
    ADD CONSTRAINT billing_suspensions_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.billing_invoices(id);
ALTER TABLE ONLY public.billing_suspensions
    ADD CONSTRAINT billing_suspensions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.billing_usage_snapshots
    ADD CONSTRAINT billing_usage_snapshots_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.compliance_control_state
    ADD CONSTRAINT compliance_control_state_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.compliance_evidence
    ADD CONSTRAINT compliance_evidence_collected_by_fkey FOREIGN KEY (collected_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.compliance_policies
    ADD CONSTRAINT compliance_policies_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.email_outbox
    ADD CONSTRAINT email_outbox_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.employee_import_jobs
    ADD CONSTRAINT employee_import_jobs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.employee_import_jobs
    ADD CONSTRAINT employee_import_jobs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.employee_master_details
    ADD CONSTRAINT employee_master_details_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.employee_master_details
    ADD CONSTRAINT employee_master_details_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.group_admins
    ADD CONSTRAINT group_admins_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.organization_groups(id);
ALTER TABLE ONLY public.group_admins
    ADD CONSTRAINT group_admins_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.hr_case_counters
    ADD CONSTRAINT hr_case_counters_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.hr_case_events
    ADD CONSTRAINT hr_case_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.hr_case_events
    ADD CONSTRAINT hr_case_events_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.hr_cases(id);
ALTER TABLE ONLY public.hr_case_events
    ADD CONSTRAINT hr_case_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.hr_cases
    ADD CONSTRAINT hr_cases_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.hr_cases
    ADD CONSTRAINT hr_cases_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.hr_cases
    ADD CONSTRAINT hr_cases_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.hr_cases
    ADD CONSTRAINT hr_cases_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.hr_cases
    ADD CONSTRAINT hr_cases_subject_employee_id_fkey FOREIGN KEY (subject_employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.import_batch_changes
    ADD CONSTRAINT import_batch_changes_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.import_batches(id);
ALTER TABLE ONLY public.import_batch_changes
    ADD CONSTRAINT import_batch_changes_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.import_batch_changes
    ADD CONSTRAINT import_batch_changes_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_undone_by_fkey FOREIGN KEY (undone_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.integration_device_nonces
    ADD CONSTRAINT integration_device_nonces_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.integration_devices(id);
ALTER TABLE ONLY public.integration_device_punches
    ADD CONSTRAINT integration_device_punches_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.integration_devices(id);
ALTER TABLE ONLY public.integration_device_punches
    ADD CONSTRAINT integration_device_punches_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.integration_device_punches
    ADD CONSTRAINT integration_device_punches_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.integration_device_punches
    ADD CONSTRAINT integration_device_punches_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.integration_device_users
    ADD CONSTRAINT integration_device_users_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.integration_device_users
    ADD CONSTRAINT integration_device_users_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.integration_devices(id);
ALTER TABLE ONLY public.integration_device_users
    ADD CONSTRAINT integration_device_users_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.integration_device_users
    ADD CONSTRAINT integration_device_users_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.integration_devices
    ADD CONSTRAINT integration_devices_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.integration_devices
    ADD CONSTRAINT integration_devices_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.integration_devices
    ADD CONSTRAINT integration_devices_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.attendance_sites(id);
ALTER TABLE ONLY public.job_dispatch_log
    ADD CONSTRAINT job_dispatch_log_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.job_runs
    ADD CONSTRAINT job_runs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.kpis
    ADD CONSTRAINT kpis_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.kpis
    ADD CONSTRAINT kpis_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.kpis
    ADD CONSTRAINT kpis_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.leave_balance_ledger
    ADD CONSTRAINT leave_balance_ledger_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.import_batches(id);
ALTER TABLE ONLY public.leave_balance_ledger
    ADD CONSTRAINT leave_balance_ledger_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.leave_balance_ledger
    ADD CONSTRAINT leave_balance_ledger_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.leave_balance_ledger
    ADD CONSTRAINT leave_balance_ledger_leave_type_id_fkey FOREIGN KEY (leave_type_id) REFERENCES public.leave_types(id);
ALTER TABLE ONLY public.leave_balance_ledger
    ADD CONSTRAINT leave_balance_ledger_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_leave_type_id_fkey FOREIGN KEY (leave_type_id) REFERENCES public.leave_types(id);
ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.leave_types
    ADD CONSTRAINT leave_types_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.lms_certificates
    ADD CONSTRAINT lms_certificates_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.lms_courses(id);
ALTER TABLE ONLY public.lms_certificates
    ADD CONSTRAINT lms_certificates_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.lms_certificates
    ADD CONSTRAINT lms_certificates_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES public.lms_enrollments(id);
ALTER TABLE ONLY public.lms_certificates
    ADD CONSTRAINT lms_certificates_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.lms_courses
    ADD CONSTRAINT lms_courses_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.lms_courses
    ADD CONSTRAINT lms_courses_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.lms_courses
    ADD CONSTRAINT lms_courses_team_manager_id_fkey FOREIGN KEY (team_manager_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.lms_enrollments
    ADD CONSTRAINT lms_enrollments_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.lms_enrollments
    ADD CONSTRAINT lms_enrollments_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.lms_courses(id);
ALTER TABLE ONLY public.lms_enrollments
    ADD CONSTRAINT lms_enrollments_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.lms_enrollments
    ADD CONSTRAINT lms_enrollments_last_lesson_id_fkey FOREIGN KEY (last_lesson_id) REFERENCES public.lms_lessons(id);
ALTER TABLE ONLY public.lms_enrollments
    ADD CONSTRAINT lms_enrollments_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.lms_lesson_progress
    ADD CONSTRAINT lms_lesson_progress_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES public.lms_enrollments(id);
ALTER TABLE ONLY public.lms_lesson_progress
    ADD CONSTRAINT lms_lesson_progress_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES public.lms_lessons(id);
ALTER TABLE ONLY public.lms_lesson_progress
    ADD CONSTRAINT lms_lesson_progress_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.lms_lessons
    ADD CONSTRAINT lms_lessons_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.lms_courses(id);
ALTER TABLE ONLY public.lms_lessons
    ADD CONSTRAINT lms_lessons_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.lms_questions
    ADD CONSTRAINT lms_questions_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES public.lms_lessons(id);
ALTER TABLE ONLY public.lms_questions
    ADD CONSTRAINT lms_questions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.lms_quiz_attempts
    ADD CONSTRAINT lms_quiz_attempts_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES public.lms_enrollments(id);
ALTER TABLE ONLY public.lms_quiz_attempts
    ADD CONSTRAINT lms_quiz_attempts_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES public.lms_lessons(id);
ALTER TABLE ONLY public.lms_quiz_attempts
    ADD CONSTRAINT lms_quiz_attempts_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.notification_read_cursors
    ADD CONSTRAINT notification_read_cursors_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.notification_read_cursors
    ADD CONSTRAINT notification_read_cursors_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.onboarding_document_reviews
    ADD CONSTRAINT onboarding_document_reviews_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.stored_files(id);
ALTER TABLE ONLY public.onboarding_document_reviews
    ADD CONSTRAINT onboarding_document_reviews_joiner_id_fkey FOREIGN KEY (joiner_id) REFERENCES public.onboarding_joiners(id);
ALTER TABLE ONLY public.onboarding_document_reviews
    ADD CONSTRAINT onboarding_document_reviews_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.onboarding_document_reviews
    ADD CONSTRAINT onboarding_document_reviews_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.onboarding_joiners
    ADD CONSTRAINT onboarding_joiners_buddy_id_fkey FOREIGN KEY (buddy_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.onboarding_joiners
    ADD CONSTRAINT onboarding_joiners_candidate_case_id_fkey FOREIGN KEY (candidate_case_id) REFERENCES public.hr_cases(id);
ALTER TABLE ONLY public.onboarding_joiners
    ADD CONSTRAINT onboarding_joiners_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.onboarding_joiners
    ADD CONSTRAINT onboarding_joiners_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.onboarding_joiners
    ADD CONSTRAINT onboarding_joiners_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.onboarding_joiners
    ADD CONSTRAINT onboarding_joiners_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.onboarding_joiners
    ADD CONSTRAINT onboarding_joiners_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.onboarding_templates(id);
ALTER TABLE ONLY public.onboarding_settings
    ADD CONSTRAINT onboarding_settings_finance_owner_id_fkey FOREIGN KEY (finance_owner_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.onboarding_settings
    ADD CONSTRAINT onboarding_settings_hr_owner_id_fkey FOREIGN KEY (hr_owner_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.onboarding_settings
    ADD CONSTRAINT onboarding_settings_it_owner_id_fkey FOREIGN KEY (it_owner_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.onboarding_settings
    ADD CONSTRAINT onboarding_settings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.onboarding_tasks
    ADD CONSTRAINT onboarding_tasks_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.onboarding_tasks
    ADD CONSTRAINT onboarding_tasks_joiner_id_fkey FOREIGN KEY (joiner_id) REFERENCES public.onboarding_joiners(id);
ALTER TABLE ONLY public.onboarding_tasks
    ADD CONSTRAINT onboarding_tasks_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.onboarding_tasks
    ADD CONSTRAINT onboarding_tasks_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.onboarding_tasks
    ADD CONSTRAINT onboarding_tasks_template_task_id_fkey FOREIGN KEY (template_task_id) REFERENCES public.onboarding_template_tasks(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.onboarding_template_tasks
    ADD CONSTRAINT onboarding_template_tasks_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.onboarding_template_tasks
    ADD CONSTRAINT onboarding_template_tasks_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.onboarding_templates(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.onboarding_templates
    ADD CONSTRAINT onboarding_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.onboarding_templates
    ADD CONSTRAINT onboarding_templates_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.organization_auth_policies
    ADD CONSTRAINT organization_auth_policies_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.organization_auth_policies
    ADD CONSTRAINT organization_auth_policies_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.organization_memberships
    ADD CONSTRAINT organization_memberships_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.organization_memberships
    ADD CONSTRAINT organization_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_group_fk FOREIGN KEY (group_id) REFERENCES public.organization_groups(id);
ALTER TABLE ONLY public.payout_batches
    ADD CONSTRAINT payout_batches_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payout_batches
    ADD CONSTRAINT payout_batches_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payout_batches
    ADD CONSTRAINT payout_batches_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.payout_batches
    ADD CONSTRAINT payout_batches_released_by_fkey FOREIGN KEY (released_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payout_batches
    ADD CONSTRAINT payout_batches_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.payroll_runs(id);
ALTER TABLE ONLY public.payout_events
    ADD CONSTRAINT payout_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payout_events
    ADD CONSTRAINT payout_events_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.payout_batches(id);
ALTER TABLE ONLY public.payout_events
    ADD CONSTRAINT payout_events_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.payout_items(id);
ALTER TABLE ONLY public.payout_events
    ADD CONSTRAINT payout_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.payout_items
    ADD CONSTRAINT payout_items_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.payout_batches(id);
ALTER TABLE ONLY public.payout_items
    ADD CONSTRAINT payout_items_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payout_items
    ADD CONSTRAINT payout_items_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.payout_items
    ADD CONSTRAINT payout_items_run_line_id_fkey FOREIGN KEY (run_line_id) REFERENCES public.payroll_run_lines(id);
ALTER TABLE ONLY public.payout_sandbox_payouts
    ADD CONSTRAINT payout_sandbox_payouts_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.payroll_inputs
    ADD CONSTRAINT payroll_inputs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payroll_inputs
    ADD CONSTRAINT payroll_inputs_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payroll_inputs
    ADD CONSTRAINT payroll_inputs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.payroll_inputs
    ADD CONSTRAINT payroll_inputs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.payroll_runs(id);
ALTER TABLE ONLY public.payroll_profiles
    ADD CONSTRAINT payroll_profiles_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payroll_profiles
    ADD CONSTRAINT payroll_profiles_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.payroll_run_lines
    ADD CONSTRAINT payroll_run_lines_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payroll_run_lines
    ADD CONSTRAINT payroll_run_lines_held_by_fkey FOREIGN KEY (held_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payroll_run_lines
    ADD CONSTRAINT payroll_run_lines_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.payroll_run_lines
    ADD CONSTRAINT payroll_run_lines_payslip_id_fkey FOREIGN KEY (payslip_id) REFERENCES public.payslips(id);
ALTER TABLE ONLY public.payroll_run_lines
    ADD CONSTRAINT payroll_run_lines_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.payroll_runs(id);
ALTER TABLE ONLY public.payroll_run_lines
    ADD CONSTRAINT payroll_run_lines_structure_id_fkey FOREIGN KEY (structure_id) REFERENCES public.salary_structures(id);
ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_calculated_by_fkey FOREIGN KEY (calculated_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_locked_by_fkey FOREIGN KEY (locked_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payroll_settings
    ADD CONSTRAINT payroll_settings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.payroll_ytd_monthly
    ADD CONSTRAINT payroll_ytd_monthly_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.import_batches(id);
ALTER TABLE ONLY public.payroll_ytd_monthly
    ADD CONSTRAINT payroll_ytd_monthly_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payroll_ytd_monthly
    ADD CONSTRAINT payroll_ytd_monthly_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.payroll_ytd_opening
    ADD CONSTRAINT payroll_ytd_opening_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.import_batches(id);
ALTER TABLE ONLY public.payroll_ytd_opening
    ADD CONSTRAINT payroll_ytd_opening_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payroll_ytd_opening
    ADD CONSTRAINT payroll_ytd_opening_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payroll_ytd_opening
    ADD CONSTRAINT payroll_ytd_opening_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.payslips
    ADD CONSTRAINT payslips_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.payslips
    ADD CONSTRAINT payslips_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.payslips
    ADD CONSTRAINT payslips_payroll_run_id_fkey FOREIGN KEY (payroll_run_id) REFERENCES public.payroll_runs(id);
ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.policy_acknowledgements
    ADD CONSTRAINT policy_acknowledgements_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES public.compliance_policies(id);
ALTER TABLE ONLY public.policy_acknowledgements
    ADD CONSTRAINT policy_acknowledgements_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.privacy_brand_closures
    ADD CONSTRAINT privacy_brand_closures_export_id_fkey FOREIGN KEY (export_id) REFERENCES public.privacy_brand_exports(id);
ALTER TABLE ONLY public.privacy_brand_closures
    ADD CONSTRAINT privacy_brand_closures_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.privacy_brand_exports
    ADD CONSTRAINT privacy_brand_exports_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.privacy_breaches
    ADD CONSTRAINT privacy_breaches_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.privacy_erasure_runs
    ADD CONSTRAINT privacy_erasure_runs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.privacy_exports
    ADD CONSTRAINT privacy_exports_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.privacy_exports
    ADD CONSTRAINT privacy_exports_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.privacy_settings
    ADD CONSTRAINT privacy_settings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.privacy_subject_state
    ADD CONSTRAINT privacy_subject_state_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.privacy_subject_state
    ADD CONSTRAINT privacy_subject_state_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.push_deliveries
    ADD CONSTRAINT push_deliveries_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.push_devices(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.push_deliveries
    ADD CONSTRAINT push_deliveries_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.push_notifications(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.push_deliveries
    ADD CONSTRAINT push_deliveries_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.push_devices
    ADD CONSTRAINT push_devices_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.push_devices
    ADD CONSTRAINT push_devices_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.push_devices
    ADD CONSTRAINT push_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.push_fanout_cursors
    ADD CONSTRAINT push_fanout_cursors_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.push_notifications
    ADD CONSTRAINT push_notifications_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.push_notifications
    ADD CONSTRAINT push_notifications_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.receipt_scans
    ADD CONSTRAINT receipt_scans_attached_case_id_fkey FOREIGN KEY (attached_case_id) REFERENCES public.hr_cases(id);
ALTER TABLE ONLY public.receipt_scans
    ADD CONSTRAINT receipt_scans_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.receipt_scans
    ADD CONSTRAINT receipt_scans_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.stored_files(id);
ALTER TABLE ONLY public.receipt_scans
    ADD CONSTRAINT receipt_scans_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.risk_compliance_marks
    ADD CONSTRAINT risk_compliance_marks_marked_by_fkey FOREIGN KEY (marked_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.risk_compliance_marks
    ADD CONSTRAINT risk_compliance_marks_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.risk_minimum_wages
    ADD CONSTRAINT risk_minimum_wages_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.risk_minimum_wages
    ADD CONSTRAINT risk_minimum_wages_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.risk_settings
    ADD CONSTRAINT risk_settings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.risk_settings
    ADD CONSTRAINT risk_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.risk_signal_events
    ADD CONSTRAINT risk_signal_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.risk_signal_events
    ADD CONSTRAINT risk_signal_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.risk_signal_events
    ADD CONSTRAINT risk_signal_events_signal_id_fkey FOREIGN KEY (signal_id) REFERENCES public.risk_signals(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.risk_signals
    ADD CONSTRAINT risk_signals_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.risk_signals
    ADD CONSTRAINT risk_signals_status_by_fkey FOREIGN KEY (status_by) REFERENCES public.users(id);
ALTER TABLE ONLY public.roster_assignments
    ADD CONSTRAINT roster_assignments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.roster_assignments
    ADD CONSTRAINT roster_assignments_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.roster_assignments
    ADD CONSTRAINT roster_assignments_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.roster_assignments
    ADD CONSTRAINT roster_assignments_source_case_id_fkey FOREIGN KEY (source_case_id) REFERENCES public.hr_cases(id);
ALTER TABLE ONLY public.roster_assignments
    ADD CONSTRAINT roster_assignments_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.roster_shift_templates(id);
ALTER TABLE ONLY public.roster_assignments
    ADD CONSTRAINT roster_assignments_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.roster_publications
    ADD CONSTRAINT roster_publications_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.roster_publications
    ADD CONSTRAINT roster_publications_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.roster_publications
    ADD CONSTRAINT roster_publications_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.roster_settings
    ADD CONSTRAINT roster_settings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.roster_shift_templates
    ADD CONSTRAINT roster_shift_templates_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.salary_structures
    ADD CONSTRAINT salary_structures_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.salary_structures
    ADD CONSTRAINT salary_structures_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.salary_structures
    ADD CONSTRAINT salary_structures_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.security_events
    ADD CONSTRAINT security_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.security_events
    ADD CONSTRAINT security_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.stored_files
    ADD CONSTRAINT stored_files_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.stored_files
    ADD CONSTRAINT stored_files_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.survey_answers
    ADD CONSTRAINT survey_answers_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.survey_answers
    ADD CONSTRAINT survey_answers_question_id_fkey FOREIGN KEY (question_id) REFERENCES public.survey_questions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.survey_answers
    ADD CONSTRAINT survey_answers_response_id_fkey FOREIGN KEY (response_id) REFERENCES public.survey_responses(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.survey_invitations
    ADD CONSTRAINT survey_invitations_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.survey_invitations
    ADD CONSTRAINT survey_invitations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.survey_invitations
    ADD CONSTRAINT survey_invitations_survey_id_fkey FOREIGN KEY (survey_id) REFERENCES public.surveys(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.survey_questions
    ADD CONSTRAINT survey_questions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.survey_questions
    ADD CONSTRAINT survey_questions_survey_id_fkey FOREIGN KEY (survey_id) REFERENCES public.surveys(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.survey_responses
    ADD CONSTRAINT survey_responses_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.survey_responses
    ADD CONSTRAINT survey_responses_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.survey_responses
    ADD CONSTRAINT survey_responses_survey_id_fkey FOREIGN KEY (survey_id) REFERENCES public.surveys(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.surveys
    ADD CONSTRAINT surveys_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.surveys
    ADD CONSTRAINT surveys_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.switchover_settings
    ADD CONSTRAINT switchover_settings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.switchover_settings
    ADD CONSTRAINT switchover_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.tax_declaration_proofs
    ADD CONSTRAINT tax_declaration_proofs_declaration_id_fkey FOREIGN KEY (declaration_id) REFERENCES public.tax_declarations(id);
ALTER TABLE ONLY public.tax_declaration_proofs
    ADD CONSTRAINT tax_declaration_proofs_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.stored_files(id);
ALTER TABLE ONLY public.tax_declaration_proofs
    ADD CONSTRAINT tax_declaration_proofs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.tax_declarations
    ADD CONSTRAINT tax_declarations_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.tax_declarations
    ADD CONSTRAINT tax_declarations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.tax_declarations
    ADD CONSTRAINT tax_declarations_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.tax_document_sets
    ADD CONSTRAINT tax_document_sets_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.tax_documents
    ADD CONSTRAINT tax_documents_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.tax_documents
    ADD CONSTRAINT tax_documents_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.tax_documents
    ADD CONSTRAINT tax_documents_part_a_file_id_fkey FOREIGN KEY (part_a_file_id) REFERENCES public.stored_files(id);
ALTER TABLE ONLY public.tax_documents
    ADD CONSTRAINT tax_documents_set_id_fkey FOREIGN KEY (set_id) REFERENCES public.tax_document_sets(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.tds_challan_allocations
    ADD CONSTRAINT tds_challan_allocations_challan_id_fkey FOREIGN KEY (challan_id) REFERENCES public.tds_challans(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.tds_challan_allocations
    ADD CONSTRAINT tds_challan_allocations_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);
ALTER TABLE ONLY public.tds_challan_allocations
    ADD CONSTRAINT tds_challan_allocations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.tds_challan_allocations
    ADD CONSTRAINT tds_challan_allocations_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.payroll_runs(id);
ALTER TABLE ONLY public.tds_challans
    ADD CONSTRAINT tds_challans_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.tds_deductor_profiles
    ADD CONSTRAINT tds_deductor_profiles_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.tds_returns
    ADD CONSTRAINT tds_returns_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.webhook_events(id);
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.webhook_subscriptions(id);
ALTER TABLE ONLY public.webhook_event_cursors
    ADD CONSTRAINT webhook_event_cursors_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.webhook_events
    ADD CONSTRAINT webhook_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id);
ALTER TABLE ONLY public.webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE ONLY public.workflow_events
    ADD CONSTRAINT workflow_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);
ALTER TABLE public.access_org_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_networks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_regularizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_one_time_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_password_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_totp_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_number_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_suspensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_usage_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_master_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_case_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_batch_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_device_punches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_device_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_dispatch_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kpis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_balance_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lms_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lms_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lms_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lms_lesson_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lms_lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lms_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lms_quiz_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_read_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_document_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_joiners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_template_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_auth_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payout_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payout_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payout_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payout_sandbox_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_run_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_ytd_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_ytd_opening ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payslips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_erasure_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_subject_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_fanout_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipt_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_compliance_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_minimum_wages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_signal_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roster_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roster_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roster_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roster_shift_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_structures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stored_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.survey_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.survey_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.survey_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.survey_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.surveys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.switchover_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_declaration_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_declarations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_document_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tds_challan_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tds_challans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tds_deductor_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tds_returns ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.access_org_state USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.access_role_assignments USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.access_roles USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.accounting_exports USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.accounting_settings USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.attendance_devices USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.attendance_events USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.attendance_networks USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.attendance_policies USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.attendance_regularizations USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.attendance_sites USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.audit_log USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.auth_invites USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.email_outbox USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.employee_import_jobs USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.employee_master_details USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.employees USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.hr_case_counters USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.hr_case_events USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.hr_cases USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.import_batch_changes USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.import_batches USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.integration_device_punches USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.integration_device_users USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.integration_devices USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.job_dispatch_log USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.job_runs USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.kpis USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.leave_balance_ledger USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.leave_requests USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.leave_types USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.lms_certificates USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.lms_courses USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.lms_enrollments USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.lms_lesson_progress USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.lms_lessons USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.lms_questions USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.lms_quiz_attempts USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.notification_preferences USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.notification_read_cursors USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.notification_reads USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.onboarding_document_reviews USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.onboarding_joiners USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.onboarding_settings USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.onboarding_tasks USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.onboarding_template_tasks USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.onboarding_templates USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.organization_auth_policies USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.organization_memberships USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.payout_batches USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.payout_events USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.payout_items USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.payout_sandbox_payouts USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.payroll_inputs USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.payroll_profiles USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.payroll_run_lines USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.payroll_runs USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.payroll_settings USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.payroll_ytd_monthly USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.payroll_ytd_opening USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.payslips USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.privacy_erasure_runs USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.privacy_exports USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.privacy_settings USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.privacy_subject_state USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.push_deliveries USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.push_devices USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.push_fanout_cursors USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.push_notifications USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.receipt_scans USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.risk_compliance_marks USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.risk_minimum_wages USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.risk_settings USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.risk_signal_events USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.risk_signals USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.roster_assignments USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.roster_publications USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.roster_settings USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.roster_shift_templates USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.salary_structures USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.stored_files USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.survey_answers USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.survey_invitations USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.survey_questions USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.survey_responses USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.surveys USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.switchover_settings USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.tax_declaration_proofs USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.tax_declarations USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.tax_document_sets USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.tax_documents USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.tds_challan_allocations USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.tds_challans USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.tds_deductor_profiles USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.tds_returns USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.webhook_deliveries USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.webhook_event_cursors USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.webhook_events USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.webhook_subscriptions USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY tenant_isolation ON public.workflow_events USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_event_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_events ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.access_org_state TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.access_role_assignments TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.access_roles TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.accounting_exports TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.accounting_settings TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.attendance_devices TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.attendance_events TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.attendance_networks TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.attendance_policies TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.attendance_regularizations TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.attendance_sites TO hrm_runtime;
GRANT SELECT,INSERT ON TABLE public.audit_log TO hrm_runtime;
GRANT SELECT,USAGE ON SEQUENCE public.audit_log_id_seq TO hrm_runtime;
GRANT SELECT,USAGE ON SEQUENCE public.auth_events_id_seq TO hrm_runtime;
GRANT SELECT,USAGE ON SEQUENCE public.auth_password_history_id_seq TO hrm_runtime;
GRANT SELECT,USAGE ON SEQUENCE public.billing_events_id_seq TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.email_outbox TO hrm_runtime;
GRANT SELECT,USAGE ON SEQUENCE public.email_outbox_id_seq TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.employee_import_jobs TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.employee_master_details TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.employees TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.hr_case_counters TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.hr_case_events TO hrm_runtime;
GRANT SELECT,USAGE ON SEQUENCE public.hr_case_events_id_seq TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.hr_cases TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.import_batch_changes TO hrm_runtime;
GRANT SELECT,USAGE ON SEQUENCE public.import_batch_changes_id_seq TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.import_batches TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.integration_device_nonces TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.integration_device_punches TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.integration_device_users TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.integration_devices TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.job_dispatch_log TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.job_runs TO hrm_runtime;
GRANT SELECT,USAGE ON SEQUENCE public.job_runs_id_seq TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.kpis TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.leave_balance_ledger TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.leave_requests TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.leave_types TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lms_certificates TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lms_courses TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lms_enrollments TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lms_lesson_progress TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lms_lessons TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lms_questions TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lms_quiz_attempts TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notification_preferences TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notification_read_cursors TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notification_reads TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.onboarding_document_reviews TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.onboarding_joiners TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.onboarding_settings TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.onboarding_tasks TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.onboarding_template_tasks TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.onboarding_templates TO hrm_runtime;
GRANT SELECT,INSERT ON TABLE public.organization_memberships TO hrm_runtime;
GRANT UPDATE(role) ON TABLE public.organization_memberships TO hrm_runtime;
GRANT UPDATE(status) ON TABLE public.organization_memberships TO hrm_runtime;
GRANT SELECT ON TABLE public.organizations TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payout_batches TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payout_events TO hrm_runtime;
GRANT SELECT,USAGE ON SEQUENCE public.payout_events_id_seq TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payout_items TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payout_sandbox_payouts TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payroll_inputs TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payroll_profiles TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payroll_run_lines TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payroll_runs TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payroll_settings TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payroll_ytd_monthly TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payroll_ytd_opening TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payslips TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.privacy_erasure_runs TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.privacy_exports TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.privacy_settings TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.privacy_subject_state TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.push_deliveries TO hrm_runtime;
GRANT SELECT,USAGE ON SEQUENCE public.push_deliveries_id_seq TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.push_devices TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.push_fanout_cursors TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.push_notifications TO hrm_runtime;
GRANT SELECT,USAGE ON SEQUENCE public.push_notifications_id_seq TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.receipt_scans TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.risk_compliance_marks TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.risk_minimum_wages TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.risk_settings TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.risk_signal_events TO hrm_runtime;
GRANT SELECT,USAGE ON SEQUENCE public.risk_signal_events_id_seq TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.risk_signals TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.roster_assignments TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.roster_publications TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.roster_settings TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.roster_shift_templates TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.salary_structures TO hrm_runtime;
GRANT SELECT ON TABLE public.schema_migrations TO hrm_runtime;
GRANT SELECT,USAGE ON SEQUENCE public.security_events_id_seq TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.stored_files TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.survey_answers TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.survey_invitations TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.survey_questions TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.survey_responses TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.surveys TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.switchover_settings TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tax_declaration_proofs TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tax_declarations TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tax_document_sets TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tax_documents TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tds_challan_allocations TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tds_challans TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tds_deductor_profiles TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tds_returns TO hrm_runtime;
GRANT SELECT(id) ON TABLE public.users TO hrm_runtime;
GRANT SELECT(email),INSERT(email) ON TABLE public.users TO hrm_runtime;
GRANT SELECT(full_name),INSERT(full_name) ON TABLE public.users TO hrm_runtime;
GRANT SELECT(created_at) ON TABLE public.users TO hrm_runtime;
GRANT SELECT(oidc_issuer) ON TABLE public.users TO hrm_runtime;
GRANT SELECT(oidc_subject) ON TABLE public.users TO hrm_runtime;
GRANT SELECT(last_sign_in_at) ON TABLE public.users TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.webhook_deliveries TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.webhook_event_cursors TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.webhook_events TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.webhook_subscriptions TO hrm_runtime;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.workflow_events TO hrm_runtime;
GRANT SELECT,USAGE ON SEQUENCE public.workflow_events_id_seq TO hrm_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE hrm_app IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO hrm_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE hrm_app IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO hrm_runtime;

-- 035: TDS deposits (challans), quarterly salary TDS statements (Form 138 / formerly 24Q) and annual salary TDS
-- certificates (Form 130 / formerly Form 16 + 12BA). Owned by backend/src/platform/payroll-returns. Idempotent.
-- Every table: ENABLE + FORCE ROW LEVEL SECURITY with the tenant_isolation policy (see 004_hr_cases.sql).

-- Deductor (employer) details printed on the statement and the certificate. One row per organisation.
-- The responsible person's PAN is a personal identifier: stored field-encrypted (security/field-crypto.ts).
CREATE TABLE IF NOT EXISTS tds_deductor_profiles(
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  tan text CHECK (tan IS NULL OR tan ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'),
  deductor_pan text CHECK (deductor_pan IS NULL OR deductor_pan ~ '^([A-Z]{5}[0-9]{4}[A-Z]|PANNOTREQD)$'),
  deductor_name text CHECK (deductor_name IS NULL OR length(deductor_name) <= 75),
  deductor_category text NOT NULL DEFAULT 'K' CHECK (deductor_category ~ '^[ASDEGHLNKMPTJBQF]$'),
  gstin text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  address jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(address) = 'object'),
  email text CHECK (email IS NULL OR length(email) <= 75),
  phone text CHECK (phone IS NULL OR phone ~ '^[0-9]{6,10}$'),
  responsible jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(responsible) = 'object'),
  responsible_pan_enc text CHECK (responsible_pan_enc IS NULL OR responsible_pan_enc ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$'),
  responsible_pan_hash text,
  responsible_pan_last4 text CHECK (responsible_pan_last4 IS NULL OR length(responsible_pan_last4) = 4),
  version integer NOT NULL DEFAULT 1,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One TDS deposit (challan ITNS 281 / book adjustment) for salary TDS of one month.
CREATE TABLE IF NOT EXISTS tds_challans(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  fy_start integer NOT NULL CHECK (fy_start BETWEEN 2000 AND 2100),
  quarter text NOT NULL CHECK (quarter IN ('Q1','Q2','Q3','Q4')),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  section_code text NOT NULL DEFAULT '392' CHECK (section_code IN ('392','192')),
  minor_head text NOT NULL DEFAULT '200' CHECK (minor_head IN ('200','400')),
  mode text NOT NULL DEFAULT 'C' CHECK (mode IN ('C','B')),
  bsr_code text NOT NULL CHECK (bsr_code ~ '^[0-9]{7}$'),
  challan_serial text NOT NULL CHECK (challan_serial ~ '^[0-9]{1,5}$'),
  deposit_date date NOT NULL,
  tax numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  surcharge numeric(14,2) NOT NULL DEFAULT 0 CHECK (surcharge >= 0),
  cess numeric(14,2) NOT NULL DEFAULT 0 CHECK (cess >= 0),
  interest numeric(14,2) NOT NULL DEFAULT 0 CHECK (interest >= 0),
  fee numeric(14,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  penalty numeric(14,2) NOT NULL DEFAULT 0 CHECK (penalty >= 0),
  notes text CHECK (notes IS NULL OR length(notes) <= 500),
  allocated_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (organization_id, bsr_code, deposit_date, challan_serial)
);
CREATE INDEX IF NOT EXISTS tds_challans_period ON tds_challans(organization_id, fy_start, period);

-- Deducted TDS (from published/locked payroll run lines) mapped onto a challan: one Form 138 deductee (DD) row each.
CREATE TABLE IF NOT EXISTS tds_challan_allocations(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  challan_id uuid NOT NULL REFERENCES tds_challans(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id),
  run_id uuid REFERENCES payroll_runs(id),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  amount_paid numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  tds numeric(14,2) NOT NULL CHECK (tds >= 0),
  payment_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (challan_id, employee_id, run_id)
);
CREATE INDEX IF NOT EXISTS tds_alloc_employee ON tds_challan_allocations(organization_id, employee_id, period);

-- Quarterly statement status per FY/quarter (generated here, or filed elsewhere before the switch-over).
CREATE TABLE IF NOT EXISTS tds_returns(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  fy_start integer NOT NULL CHECK (fy_start BETWEEN 2000 AND 2100),
  quarter text NOT NULL CHECK (quarter IN ('Q1','Q2','Q3','Q4')),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','GENERATED','FILED')),
  filed_externally boolean NOT NULL DEFAULT false,
  token_number text CHECK (token_number IS NULL OR token_number ~ '^[0-9]{15}$'),
  filed_on date,
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  file_sha256 text,
  generated_by uuid,
  generated_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, fy_start, quarter)
);

-- Annual certificate batch per FY: generation progress and maker-checker publication.
CREATE TABLE IF NOT EXISTS tax_document_sets(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  fy_start integer NOT NULL CHECK (fy_start BETWEEN 2000 AND 2100),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','GENERATING','GENERATED','PUBLISHED')),
  total integer NOT NULL DEFAULT 0,
  generated integer NOT NULL DEFAULT 0,
  generated_by uuid,
  generated_at timestamptz,
  published_by uuid,
  published_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, fy_start),
  CHECK (published_by IS NULL OR published_by IS DISTINCT FROM generated_by)
);

-- Per-employee certificate snapshot (Part B / perquisites / quarterly TDS) and the uploaded TRACES Part A.
-- PDFs are rendered deterministically from `data`; once published the snapshot is not regenerated.
CREATE TABLE IF NOT EXISTS tax_documents(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  set_id uuid NOT NULL REFERENCES tax_document_sets(id) ON DELETE CASCADE,
  fy_start integer NOT NULL,
  employee_id uuid NOT NULL REFERENCES employees(id),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_sha256 text,
  part_a_file_id uuid REFERENCES stored_files(id),
  generated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, fy_start, employee_id)
);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['tds_deductor_profiles','tds_challans','tds_challan_allocations','tds_returns','tax_document_sets','tax_documents'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;

INSERT INTO schema_migrations(version) VALUES(35) ON CONFLICT DO NOTHING;

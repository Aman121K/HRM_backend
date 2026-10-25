-- 031: statutory switches for the payroll engine (see docs/payroll-statutory-review.md).
-- Rates/thresholds live in versioned code tables (backend/src/platform/payroll/rules/); these columns only hold the
-- per-organisation and per-employee choices the law leaves to the employer / CA. Idempotent.

-- Organisation options consumed by engine.ts LineContext.settings:
--   labourCodeWages: 'AUTO' | 'ON' | 'OFF'   (Labour Code 50% wage rule for PF; default AUTO = from Nov 2025)
--   lwfEnabled: boolean                      (deduct Labour Welfare Fund; default false until registration confirmed)
--   minimumWageMonthly: number | null        (monthly Basic + DA floor for the establishment's State / skill)
ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS statutory_options jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Employee flags consumed by engine.ts LineContext.profile:
--   epsEligible (default true), disabled (ESI ₹25,000 threshold), vpfRate (0–0.88), internationalWorker,
--   ageCategory ('BELOW_60' | 'SENIOR' | 'SUPER_SENIOR' — old-regime slabs / 80D)
ALTER TABLE payroll_profiles ADD COLUMN IF NOT EXISTS statutory_flags jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_settings_statutory_options_obj') THEN
    ALTER TABLE payroll_settings ADD CONSTRAINT payroll_settings_statutory_options_obj CHECK (jsonb_typeof(statutory_options) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_profiles_statutory_flags_obj') THEN
    ALTER TABLE payroll_profiles ADD CONSTRAINT payroll_profiles_statutory_flags_obj CHECK (jsonb_typeof(statutory_flags) = 'object');
  END IF;
END $$;

INSERT INTO schema_migrations(version) VALUES(31) ON CONFLICT DO NOTHING;

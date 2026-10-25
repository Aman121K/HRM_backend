-- Multi-brand operation: organizations carry branding, statutory defaults and enabled modules; brands roll up into groups
-- whose admins see consolidated metrics; platform admins provision new organizations.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS legal_name text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS short_name text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS brand_color text NOT NULL DEFAULT '#0b615c' CHECK (brand_color ~ '^#[0-9a-fA-F]{6}$');
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS accent_color text NOT NULL DEFAULT '#c78c2b' CHECK (accent_color ~ '^#[0-9a-fA-F]{6}$');
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_data_url text CHECK (logo_data_url IS NULL OR (length(logo_data_url) < 200000 AND logo_data_url ~ '^data:image/(png|jpeg|webp|svg\+xml);base64,'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS industry text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_state text NOT NULL DEFAULT 'KA';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS employee_prefix text NOT NULL DEFAULT 'EMP' CHECK (employee_prefix ~ '^[A-Z]{2,6}$');
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enabled_modules text[] NOT NULL DEFAULT ARRAY['core','attendance','leave','roster','payroll','expenses','travel','helpdesk','letters','assets','exit','learning','performance','recruitment','onboarding','engagement','recognition','reports','integrations'];
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS group_id uuid;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
UPDATE organizations SET display_name = coalesce(display_name, name), short_name = coalesce(short_name, left(name, 24));

CREATE TABLE IF NOT EXISTS organization_groups(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(name) BETWEEN 2 AND 120), slug text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='organizations_group_fk') THEN
  ALTER TABLE organizations ADD CONSTRAINT organizations_group_fk FOREIGN KEY (group_id) REFERENCES organization_groups(id);
 END IF;
END $$;
-- Brands of a group (group dashboard, brand switcher).
CREATE INDEX IF NOT EXISTS organizations_group ON organizations(group_id, status);

CREATE TABLE IF NOT EXISTS group_admins(
 group_id uuid NOT NULL REFERENCES organization_groups(id), user_id uuid NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK (role IN ('GROUP_OWNER','GROUP_HR','GROUP_VIEWER')), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS platform_admins(
 user_id uuid PRIMARY KEY REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
-- Platform/group tables are cross-tenant by design and never exposed without the platform/group checks in the API.
INSERT INTO schema_migrations(version) VALUES(19) ON CONFLICT DO NOTHING;

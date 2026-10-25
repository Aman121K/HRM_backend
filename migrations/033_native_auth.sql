-- 033: first-party (native) authentication — passwords, TOTP MFA, recovery codes, refresh-token sessions, invites,
-- password reset / unlock tokens, password history, login events and the per-brand sign-in policy.
--
-- Access model: these are identity tables. They are read and written ONLY through the owner pool (AuthService /
-- NativeAuthService, systemQuery / platformTransaction) after explicit checks; the runtime (tenant) role gets no
-- privilege on any of them, so tenant code — or an injection in it — can never read a password hash, a TOTP secret,
-- a refresh-token hash or an invite token. Org-scoped tables additionally carry the standard tenant_isolation policy
-- (defence in depth should a grant ever be added back). Idempotent: safe to re-run.

-- users.password_hash already exists (scrypt format string, see backend/src/platform/auth/local/password.ts).
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_failed_login_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamptz;

-- Authenticator apps (RFC 6238). secret_enc is AES-256-GCM via field-crypto, AAD bound to users/<user id>/<row id>.
CREATE TABLE IF NOT EXISTS auth_totp_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL DEFAULT 'Authenticator app' CHECK (length(name) BETWEEN 1 AND 60),
  secret_enc text NOT NULL,
  confirmed_at timestamptz,
  last_used_step bigint,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_totp_user ON auth_totp_devices(user_id) WHERE confirmed_at IS NOT NULL;

-- Single-use recovery codes (80-bit, stored as SHA-256 over user id + code).
CREATE TABLE IF NOT EXISTS auth_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  code_hash text NOT NULL UNIQUE,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_recovery_user ON auth_recovery_codes(user_id) WHERE used_at IS NULL;

-- One row per signed-in device (a refresh-token family).
CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  organization_id uuid REFERENCES organizations(id),
  client text NOT NULL DEFAULT 'web' CHECK (client IN ('web','mobile')),
  device text,
  user_agent_hash text,
  ip text,
  amr text[] NOT NULL DEFAULT ARRAY['pwd'],
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_minutes integer NOT NULL CHECK (idle_minutes BETWEEN 5 AND 43200),
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text
);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id, revoked_at, last_seen_at DESC);

-- Rotating refresh tokens. Presenting a token that was already rotated (used_at set) revokes the whole family.
CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES auth_sessions(id),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_refresh_session ON auth_refresh_tokens(session_id);

-- Invitations (brand: organization_id set; platform super-admin invites: organization_id NULL, kind PLATFORM).
CREATE TABLE IF NOT EXISTS auth_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'BRAND' CHECK (kind IN ('BRAND','PLATFORM')),
  organization_id uuid REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  employee_id uuid REFERENCES employees(id),
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  CHECK ((kind = 'BRAND') = (organization_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS auth_invites_org ON auth_invites(organization_id, employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS auth_invites_user ON auth_invites(user_id) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Short-lived single-use tokens: password reset (30 min), account unlock, sign-in MFA challenge, MFA enrolment, email OTP.
CREATE TABLE IF NOT EXISTS auth_one_time_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN ('RESET','UNLOCK','MFA_LOGIN','EMAIL_OTP')),
  token_hash text NOT NULL UNIQUE,
  organization_id uuid REFERENCES organizations(id),
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_ott_user ON auth_one_time_tokens(user_id, purpose) WHERE used_at IS NULL;

-- Last password hashes (re-use of the last 5 is refused).
CREATE TABLE IF NOT EXISTS auth_password_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_password_history_user ON auth_password_history(user_id, created_at DESC);

-- Sign-in and account-security events (success and failure). The email is stored only as a keyed hash.
CREATE TABLE IF NOT EXISTS auth_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  organization_id uuid REFERENCES organizations(id),
  event text NOT NULL,
  success boolean NOT NULL,
  email_hash text,
  ip text,
  user_agent_hash text,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_events_user ON auth_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS auth_events_recent ON auth_events(created_at DESC);

-- Brand sign-in policy (owner / HR editable, audited).
CREATE TABLE IF NOT EXISTS organization_auth_policies (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  sign_in_methods text NOT NULL DEFAULT 'BOTH' CHECK (sign_in_methods IN ('PASSWORD','SSO','BOTH')),
  mfa_required_all boolean NOT NULL DEFAULT false,
  email_otp_fallback boolean NOT NULL DEFAULT true,
  session_max_hours integer NOT NULL DEFAULT 720 CHECK (session_max_hours BETWEEN 1 AND 720),
  session_idle_minutes integer NOT NULL DEFAULT 720 CHECK (session_idle_minutes BETWEEN 5 AND 720),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Owner-only: no tenant (runtime) access to any identity secret.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrm_runtime') THEN
    REVOKE ALL ON auth_totp_devices, auth_recovery_codes, auth_sessions, auth_refresh_tokens, auth_invites,
      auth_one_time_tokens, auth_password_history, auth_events, organization_auth_policies FROM hrm_runtime;
    -- Re-assert: the runtime role can never read the password hash or the new lockout columns.
    REVOKE ALL ON users FROM hrm_runtime;
    GRANT SELECT (id, email, full_name, created_at, oidc_issuer, oidc_subject, last_sign_in_at) ON users TO hrm_runtime;
    GRANT INSERT (email, full_name) ON users TO hrm_runtime;
  END IF;
END $$;

ALTER TABLE auth_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_auth_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON auth_invites;
CREATE POLICY tenant_isolation ON auth_invites USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
DROP POLICY IF EXISTS tenant_isolation ON organization_auth_policies;
CREATE POLICY tenant_isolation ON organization_auth_policies USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
-- Sessions, tokens, devices and history are per user, not per brand (one person can belong to several brands), and
-- have no runtime grants at all; RLS with no policy would only deny the (already denied) runtime role.
ALTER TABLE auth_totp_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_one_time_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_password_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_events ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations(version) VALUES(33) ON CONFLICT DO NOTHING;

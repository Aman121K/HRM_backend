-- OIDC identity binding: the identity provider's stable subject is linked to a user on first verified sign-in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_issuer text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_subject text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_sign_in_at timestamptz;
-- Token → user lookup on every authenticated request.
CREATE UNIQUE INDEX IF NOT EXISTS users_oidc_identity ON users(oidc_issuer, oidc_subject) WHERE oidc_subject IS NOT NULL;
INSERT INTO schema_migrations(version) VALUES(12) ON CONFLICT DO NOTHING;

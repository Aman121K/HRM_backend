#!/usr/bin/env bash
# Writes .env.production for the single-server stack with freshly generated secrets.
# Run ON THE SERVER from the backend checkout. Never run it again over a live install: new encryption keys make
# existing encrypted data unreadable. It refuses to overwrite an existing file.
#
#   RDS_ENDPOINT=clanchief-db.xxxx.ap-south-1.rds.amazonaws.com HRM_APP_PASSWORD='...' \
#   RDS_MASTER_USER=postgres RDS_MASTER_PASSWORD='...' FILES_S3_BUCKET=clanchief-files-prod \
#   bash deploy/single-server/generate-env.sh
set -euo pipefail
OUT="${OUT:-.env.production}"
DOMAIN="${APP_DOMAIN:-clanchief.com}"
: "${RDS_ENDPOINT:?RDS endpoint, e.g. clanchief-db.xxxx.ap-south-1.rds.amazonaws.com}"
: "${HRM_APP_PASSWORD:?password you gave the hrm_app role}"
: "${RDS_MASTER_USER:?RDS master user (first install only)}"
: "${RDS_MASTER_PASSWORD:?RDS master password (first install only)}"
: "${FILES_S3_BUCKET:?S3 bucket for uploads}"
if [ -e "$OUT" ]; then echo "$OUT already exists — refusing to overwrite (it holds the encryption keys)." >&2; exit 1; fi
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

enc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1" 2>/dev/null || python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""),end="")' "$1"; }
pw() { openssl rand -hex 24; }
TLS="sslmode=verify-full&sslrootcert=/etc/ssl/certs/rds-global-bundle.pem"
RUNTIME_PW="$(pw)"; REDIS_PW="$(pw)"
SIGNING_KEY="$(openssl genpkey -algorithm ed25519 | awk 'BEGIN{ORS="\\n"} {print}')"
KID="k$(date +%Y%m)"

umask 077
cat > "$OUT" <<EOF
# Generated $(date -u +%Y-%m-%dT%H:%MZ) by deploy/single-server/generate-env.sh — keep a copy in a password manager.
APP_VERSION=1.0.0
REGISTRY=clanchief
APP_DOMAIN=$DOMAIN
APP_BASE_URL=https://app.$DOMAIN
CORS_ORIGIN=https://app.$DOMAIN
TRUST_PROXY=1
NEXT_PUBLIC_PLATFORM_API_URL=https://api.$DOMAIN
NEXT_PUBLIC_APP_DOMAIN=$DOMAIN
NEXT_PUBLIC_APP_MAIN_HOST=app.$DOMAIN
NEXT_PUBLIC_OIDC_ISSUER=
FRONTEND_DIR=../frontend

DATABASE_URL=postgresql://hrm_app:$(enc "$HRM_APP_PASSWORD")@$RDS_ENDPOINT:5432/hrm?$TLS
DATABASE_URL_RUNTIME=postgresql://hrm_runtime:$RUNTIME_PW@$RDS_ENDPOINT:5432/hrm?$TLS
# First install only — the migrate job creates hrm_runtime with this password. Delete both lines after the first run.
DATABASE_ADMIN_URL=postgresql://$(enc "$RDS_MASTER_USER"):$(enc "$RDS_MASTER_PASSWORD")@$RDS_ENDPOINT:5432/hrm?$TLS
RUNTIME_DB_PASSWORD=$RUNTIME_PW

REDIS_PASSWORD=$REDIS_PW
REDIS_URL=redis://:$REDIS_PW@redis:6379

OIDC_ISSUER=
OIDC_AUDIENCE=
OIDC_JWKS_URL=
OIDC_CLIENT_ID=
AUTH_SIGNING_KEY="$SIGNING_KEY"
AUTH_ISSUER=https://api.$DOMAIN

DATA_ENCRYPTION_KEYS=$KID:$(openssl rand -base64 32)
DATA_ENCRYPTION_ACTIVE_KEY=$KID
DATA_INDEX_KEY=$(openssl rand -base64 32)
INTEGRATIONS_MASTER_KEY=$(openssl rand -hex 32)
PAYOUTS_WEBHOOK_SECRET=$(openssl rand -hex 24)

FILES_S3_BUCKET=$FILES_S3_BUCKET
FILES_S3_REGION=ap-south-1
FILES_S3_PREFIX=prod
FILES_S3_KMS_KEY_ID=

# Amazon SES SMTP credentials (fill in after SES setup)
SMTP_HOST=email-smtp.ap-south-1.amazonaws.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_FROM=ClanChief <no-reply@$DOMAIN>

SENTRY_DSN=
LOG_LEVEL=info
JOBS_CONCURRENCY=2
EOF
echo "Wrote $OUT (mode 600). Back it up to your password manager now — losing DATA_ENCRYPTION_KEYS loses encrypted data."

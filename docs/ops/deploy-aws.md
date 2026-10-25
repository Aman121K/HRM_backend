# Deploying Northstar HRM on AWS (Mumbai, ap-south-1)

Audience: the engineer doing the first production install. Every step lists what to do and how to check it.
Companion runbooks: [go-live-checklist.md](go-live-checklist.md), [backup-restore.md](backup-restore.md),
[incident-response.md](incident-response.md).

> Status: the Dockerfiles and compose files in this repo have **not been built here** (Docker is not installed on the
> machine they were written on). CI (`.github/workflows/ci.yml`, job `docker`) builds them on every push — run CI green
> before the first deploy.

## 0. What you are deploying

| Component | Image / artefact | Port | Scales | Health |
|---|---|---|---|---|
| Web (Next.js 16, standalone) | `Dockerfile.web` target `web` | 3000 | horizontally | `GET /login` (<500) |
| Platform API (NestJS + Fastify) | `Dockerfile.backend` target `api` | 4100 | horizontally | live `GET /api/v2/health/live`, ready `GET /api/v2/health/ready` |
| Jobs worker (BullMQ) | `Dockerfile.backend` target `worker` | 4190 (health only) | horizontally (2+) | `GET /health/live`, `/health/ready` |
| Migrations (one-shot) | `Dockerfile.backend` target `migrate` | — | run once per release, before api/worker | exit code |
| Postgres 16 | Amazon RDS (Multi-AZ) | 5432 | — | RDS events |
| Redis 7 | ElastiCache (TLS + AUTH) | 6379 | — | — |
| Files | S3 bucket (SSE-KMS, versioned) | — | — | readiness `storage` check |
| Email | Amazon SES (SMTP interface) | 587 | — | outbox status in the jobs console |

Domains (example `APP_DOMAIN=people.example.in`):
- `people.example.in` — main web domain (sign-in, super-admin console `/platform`)
- `*.people.example.in` — one subdomain per brand (`blue-tokai.people.example.in`), same web service
- `api.people.example.in` — platform API

## 1. Network (VPC)

1. One VPC in ap-south-1 across **3 AZs** (`ap-south-1a/b/c`), e.g. `10.40.0.0/16`.
2. Subnets per AZ: **public** (ALB, NAT gateway), **private-app** (ECS tasks), **private-data** (RDS, ElastiCache) — no route to the internet from data subnets.
3. NAT gateway per AZ (or one to save cost in staging) so tasks can reach SES, the IdP, Sentry and bank APIs.
4. VPC endpoints (gateway) for **S3**; interface endpoints for **Secrets Manager**, **KMS**, **ECR (api + dkr)**, **CloudWatch Logs** — keeps that traffic off the NAT.
5. Security groups:
   - `sg-alb`: 443 from 0.0.0.0/0 (and 80 only to redirect).
   - `sg-web`: 3000 from `sg-alb`. `sg-api`: 4100 from `sg-alb`. `sg-worker`: no inbound (4190 only from the VPC CIDR if you scrape it).
   - `sg-rds`: 5432 from `sg-api`, `sg-worker`, `sg-migrate`. `sg-redis`: 6379 from `sg-api`, `sg-worker`.
6. Enable VPC Flow Logs (to S3, 90-day retention) — needed for incident forensics and CERT-In log retention.

## 2. Database — RDS for PostgreSQL 16

1. Create a **DB subnet group** on the private-data subnets.
2. Parameter group (family `postgres16`): `rds.force_ssl=1`, `log_min_duration_statement=1000`, `log_connections=1`,
   `log_disconnections=1`, `shared_preload_libraries=pg_stat_statements`, `idle_in_transaction_session_timeout=60000`.
3. Instance: `db.m7g.large` (start), **Multi-AZ**, gp3 100 GB with storage autoscaling, **encryption at rest with a
   customer-managed KMS key** (`alias/northstar-rds`), **deletion protection on**, Performance Insights on (7 days, KMS),
   Enhanced Monitoring 60 s, CloudWatch export of the `postgresql` log.
4. **Backups / PITR**: automated backups **35 days** retention (maximum), backup window 20:30–21:00 UTC (02:00–02:30 IST),
   copy automated backups to a second region (ap-southeast-1 or ap-south-2 Hyderabad) with AWS Backup for DR.
5. Master user: let RDS manage it in Secrets Manager (`manage-master-user-password`). Never give it to the app.
6. Create the database roles (one time, as the master user, from a bastion/SSM session or a one-off ECS task):

   ```sql
   CREATE ROLE hrm_app LOGIN PASSWORD '<from Secrets Manager: northstar/prod/db-owner>' NOSUPERUSER NOCREATEDB NOCREATEROLE;
   GRANT hrm_app TO <master user>;            -- RDS: lets the master create a DB owned by hrm_app
   CREATE DATABASE hrm OWNER hrm_app;
   ```
   then the runtime role (least privilege, RLS enforced — no table ownership, NOBYPASSRLS):
   ```bash
   psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 -f db/runtime-role.sql
   psql "$DATABASE_ADMIN_URL" -c "ALTER ROLE hrm_runtime PASSWORD '<northstar/prod/db-runtime>'"
   ```
   Alternatively let the migrate job do the runtime-role step once by giving it `DATABASE_ADMIN_URL` and
   `RUNTIME_DB_PASSWORD` for the first run only (then remove both from its task definition).
7. Connection strings (store in Secrets Manager, see §6):
   - `DATABASE_URL=postgresql://hrm_app:…@<rds-endpoint>:5432/hrm?sslmode=verify-full&sslrootcert=/etc/ssl/certs/rds-global-bundle.pem`
   - `DATABASE_URL_RUNTIME=postgresql://hrm_runtime:…@<rds-endpoint>:5432/hrm?sslmode=verify-full&sslrootcert=…`

   The RDS CA bundle: add `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` to the image (a small
   `COPY` in `Dockerfile.backend` runtime stage) or mount it; `sslmode=require` is the minimum if you skip verification.
8. Migrations — every release, before new api/worker tasks start (ECS one-off task of the `migrate` image):
   ```bash
   node scripts/migrate.mjs            # image default CMD
   ```
   It takes an advisory lock (safe if two run), applies each pending file in its own transaction, records a SHA-256
   checksum, and **refuses to run if an already-applied file changed**. `--status` / `--verify` are read-only.
   The API's `/api/v2/health/ready` reports `migrations.pending > 0` as not ready, so a forgotten migration blocks
   the rollout instead of serving errors.

Check: `node scripts/migrate.mjs --verify` → `0 pending, 0 changed`; the Security Center "Tenant queries use a
least-privilege role" check passes.

## 3. Redis — ElastiCache

1. ElastiCache for **Redis OSS 7.x** (or Valkey 7.2+), cluster mode **disabled**, 1 primary + 1 replica across AZs, automatic failover on.
2. **In-transit encryption ON**, **at-rest encryption ON** (KMS), **AUTH token** (or RBAC user) from Secrets Manager.
3. Parameter group: `maxmemory-policy noeviction` (BullMQ requires it — evicting job keys loses jobs).
4. `REDIS_URL=rediss://:<auth-token>@<primary-endpoint>:6379` (note `rediss://` = TLS).

Redis holds: the job queue, cross-instance rate limits, worker heartbeats, the backup marker. Nothing in Redis is the
system of record; losing it loses queued jobs (the outbox in Postgres is re-dispatched).

## 4. Files — S3

1. Create the bucket in ap-south-1, e.g. `northstar-people-files-prod`, **Object Ownership = BucketOwnerEnforced**.
2. Customer-managed KMS key `alias/northstar-files` (key policy: the API/worker task role may `kms:GenerateDataKey`,
   `kms:Decrypt` via S3 only).
3. Lock it down with the script (admin profile, NOT the app role):
   ```bash
   FILES_S3_BUCKET=northstar-people-files-prod FILES_S3_REGION=ap-south-1 \
   FILES_S3_KMS_KEY_ID=arn:aws:kms:ap-south-1:<acct>:key/<id> FILES_S3_PREFIX=prod \
   AWS_PROFILE=admin node scripts/s3-bucket-setup.mjs
   ```
   It applies Block Public Access, default SSE-KMS + bucket key, TLS-only bucket policy, **versioning**, lifecycle for
   noncurrent versions, and reports each step.
4. App env: `FILES_STORAGE=s3`, `FILES_S3_BUCKET`, `FILES_S3_REGION=ap-south-1`, `FILES_S3_PREFIX=prod`,
   `FILES_S3_KMS_KEY_ID`. **No access keys** — the ECS task role grants access.
5. Moving existing local files: `node scripts/migrate-files-to-s3.mjs` (from a host that has the old `.data/uploads`).

Readiness probes S3 with a `HeadObject` on a key that never exists — the task role needs `s3:ListBucket` on the prefix
so S3 answers 404 (without it S3 answers 403 and readiness reports `storage: http_403`).

## 5. Email — Amazon SES

1. Verify the sending domain (e.g. `people.example.in`) in SES ap-south-1 with **Easy DKIM (2048-bit)**.
2. DNS:
   - SPF on the MAIL FROM domain: custom MAIL FROM `mail.people.example.in` → `MX 10 feedback-smtp.ap-south-1.amazonses.com`, `TXT "v=spf1 include:amazonses.com -all"`.
   - DKIM: the three `CNAME`s SES gives you.
   - DMARC: `_dmarc.people.example.in TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.in; adkim=s; aspf=s; pct=100"` — move to `p=reject` after 2–4 clean weeks of reports.
3. Request production access (leave the sandbox) — state transactional HR mail only, expected volume.
4. Create SMTP credentials for a dedicated IAM user limited to `ses:SendRawEmail` with a `ses:FromAddress` condition;
   store in Secrets Manager. Env: `SMTP_HOST=email-smtp.ap-south-1.amazonaws.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`
   (STARTTLS), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM="Northstar People <no-reply@people.example.in>"`.
5. Configuration set with bounce/complaint → SNS → (email to ops) so bad addresses are noticed.

## 6. Secrets — Secrets Manager + KMS

One KMS key `alias/northstar-secrets` encrypts every secret. Secret names `northstar/prod/<name>`; ECS injects them as
environment variables (`secrets:` in the task definition), so they never appear in task definitions, images or logs.

| Secret | How to generate | Used by |
|---|---|---|
| `DATABASE_URL` / `DATABASE_URL_RUNTIME` | RDS roles (§2) | api, worker (+ migrate: owner only) |
| `REDIS_URL` | ElastiCache AUTH token (§3) | api, worker |
| `DATA_ENCRYPTION_KEYS` | `kid:base64`, key = `openssl rand -base64 32`, e.g. `k2026a:<b64>`; comma-separated for rotation | api, worker |
| `DATA_ENCRYPTION_ACTIVE_KEY` | the kid new data is sealed with (`k2026a`) | api, worker |
| `DATA_INDEX_KEY` | `openssl rand -base64 32` — blind-index HMAC key; **never rotate casually** (re-index required) | api, worker |
| `INTEGRATIONS_MASTER_KEY` | `openssl rand -hex 32` (32+ chars) | api, worker |
| `PAYOUTS_WEBHOOK_SECRET` | value agreed with the payout provider (24+ chars) | api |
| `AUTH_SIGNING_KEY` | Ed25519 private key PEM: `openssl genpkey -algorithm ed25519` | api |
| `SMTP_USER` / `SMTP_PASS` | SES SMTP credentials (§5) | worker (and api) |
| `RAZORPAYX_KEY_ID` / `RAZORPAYX_KEY_SECRET` / `RAZORPAYX_ACCOUNT_NUMBER` | provider dashboard | worker |
| `FCM_SERVICE_ACCOUNT_JSON`, `APNS_KEY_P8` | Firebase / Apple developer portal | worker |
| `ANTHROPIC_API_KEY` | only if receipt OCR uses the LLM provider | api, worker |
| `SENTRY_DSN` | Sentry project (optional) | api, worker |

Rules: separate secrets per environment; rotation procedure in [backup-restore.md](backup-restore.md#key-rotation);
CloudTrail data events on Secrets Manager `GetSecretValue`; nobody needs these values on a laptop.

## 7. Compute — ECS on Fargate + ALB

(EC2 + docker compose works too — `docker-compose.prod.yml` is the reference — but Fargate removes host patching.)

1. **ECR** repositories `northstar/web`, `northstar/api`, `northstar/worker`, `northstar/migrate`; scan on push;
   immutable tags (`<semver>-<git sha>`).
2. **IAM** (least privilege):
   - *Task execution role* (pull from ECR, write CloudWatch Logs, read `northstar/prod/*` secrets, `kms:Decrypt` on the secrets key).
   - *api/worker task role*: `s3:GetObject/PutObject/DeleteObject` on `arn:aws:s3:::<bucket>/prod/*`, `s3:ListBucket`
     on the bucket with `s3:prefix` = `prod/*`, `kms:GenerateDataKey`/`kms:Decrypt` on the files key. Nothing else.
   - *web task role*: none.
   - *migrate task role*: none (it only needs the DB secret through the execution role).
   - Humans: SSO (IAM Identity Center) with MFA; break-glass role audited.
3. **Task definitions** (all `readonlyRootFilesystem: true`, non-root user from the image, `/tmp` as an ephemeral
   volume, `stopTimeout: 45`, log driver `awslogs` with 1-year retention — CERT-In asks for 180 days minimum):

   | Service | CPU/mem | Desired | Env (non-secret) |
   |---|---|---|---|
   | web | 0.5 vCPU / 1 GB | 2 | `NODE_ENV=production`, `OIDC_ISSUER` (CSP); mount `/app/.next/cache` as ephemeral |
   | api | 1 vCPU / 2 GB | 2 (autoscale on CPU 60% / ALB requests) | see §9; `BIND_HOST=0.0.0.0`, `TRUST_PROXY=1`, `SHUTDOWN_DRAIN_MS=5000` |
   | worker | 1 vCPU / 2 GB | 2 | same as api + `JOBS_CONCURRENCY=4`, `WORKER_HEALTH_PORT=4190` |
   | migrate | 0.25 vCPU / 0.5 GB | one-off | `DATABASE_URL` only |

   Container health checks are in the images (`HEALTHCHECK`); ECS uses them.
4. **ALB** (internet-facing, public subnets, `drop_invalid_header_fields=true`, deletion protection, access logs to S3):
   - Listener 80 → redirect 301 to 443.
   - Listener 443, policy `ELBSecurityPolicy-TLS13-1-2-2021-06`, certificate from **ACM**:
     `people.example.in` + `*.people.example.in` (wildcard covers brand subdomains and `api.`), DNS-validated.
   - Rules: host `api.people.example.in` → TG `api` (health `/api/v2/health/ready`, 200, interval 15 s, deregistration delay 30 s);
     host `people.example.in` and `*.people.example.in` → TG `web` (health `/login`, 200–399).
   - **AWS WAF** web ACL on the ALB: AWS managed Core rule set, Known bad inputs, IP reputation, plus a rate rule
     (e.g. 2,000 req / 5 min / IP) as a backstop to the app's own limits.
5. **DNS (Route 53)**: `A/AAAA alias` for `people.example.in`, `*.people.example.in` and `api.people.example.in` → ALB.
   The wildcard is required for brand subdomains; with a CDN in front, configure the same three names there.
6. **Deploy order per release**: run `migrate` task (wait for exit 0) → update `api` and `worker` services (rolling,
   minimumHealthyPercent 100, maximumPercent 200, circuit breaker with rollback on) → update `web`. Migrations must stay
   backwards compatible with the previous release (expand → deploy → contract).
7. **First install only**: after the first `migrate`, run the bootstrap as a one-off task of the `migrate` image:
   ```bash
   node scripts/bootstrap-production.mjs --email <first super admin> --name "<Name>"   # APP_BASE_URL set
   ```
   It creates that user + `platform_admins` row (nothing else) and prints a 72-hour activation link (native sign-in)
   or SSO next steps. Seed scripts refuse to run with `NODE_ENV=production` or against a non-local database.
8. Smoke test: `node scripts/smoke-prod.mjs --api https://api.people.example.in --web https://people.example.in --brand https://<brand>.people.example.in --token <test account token>`.

## 8. Observability

- Logs: API lines are pino JSON (`requestId`, `route`, `res.statusCode`, `responseTimeMs`, `organizationId`, `userId`
  — ids only, never names/emails/PII); the worker writes JSON lines (`event`, `job`, `org`). The API honours and
  echoes `x-request-id` (or the ALB `X-Amzn-Trace-Id`) — quote it in support tickets.
- CloudWatch alarms: ALB 5xx > 1% (5 min), target response time p95 > 2 s, unhealthy hosts ≥ 1, RDS CPU > 80%,
  free storage < 20%, replica lag, ElastiCache memory > 75% / evictions > 0, worker task count < 2,
  log metric filter on `"level":50` and `"event":"job_failed"`.
- Errors: set `SENTRY_DSN` to send 5xx, failed jobs and crashes (no SDK; ids only).
- Super-admin status page: `GET /api/v2/platform/ops/status` — versions, uptime, DB size/connections, migrations,
  queue depth, recent failed jobs, live worker heartbeats, last backup marker.

## 9. Environment variable reference

Generated from `process.env` usage in `src/platform`, `src` and `mobile/src/config` (2026-10-20).
"Prod" = what production needs. `NEXT_PUBLIC_*` are build-time (web image build args).

### Core / platform API
| Variable | Req. in prod | Default | Production value / notes |
|---|---|---|---|
| `NODE_ENV` | yes | `development` | `production` (images set it) — turns on all fail-closed checks |
| `DATABASE_URL` | yes | — | owner role `hrm_app`, TLS |
| `DATABASE_URL_RUNTIME` | yes | — | `hrm_runtime`; must differ from `DATABASE_URL` (boot fails otherwise) |
| `REDIS_URL` | yes | — | `rediss://…` ElastiCache |
| `BACKEND_V2_PORT` | no | `4100` | |
| `BIND_HOST` | yes (containers) | `127.0.0.1` | `0.0.0.0` (image default) |
| `TRUST_PROXY` | yes | off | `1` behind one ALB (or the ALB subnet CIDRs) |
| `CORS_ORIGIN` | yes | `http://localhost:3000` | `https://people.example.in` (brand subdomains of `APP_DOMAIN` are allowed automatically) |
| `APP_DOMAIN` | yes | `localhost` | `people.example.in` |
| `APP_BASE_URL` | yes | — | `https://people.example.in` (links in emails, HTTPS posture check) |
| `ALLOW_DEMO_IDENTITY` | must be `false` | `false` | boot fails if `true` in production |
| `EXPOSE_OPENAPI` | no | `false` in prod | keep unset |
| `LOG_LEVEL` | no | `info` | `info` |
| `LOG_FORMAT` | no | JSON in prod | `json` forces Nest boot logs to JSON outside production |
| `APP_VERSION`, `GIT_SHA` | no | — | image build args; shown in ops status and error reports |
| `SENTRY_DSN` | optional | — | enables the fetch-based error reporter |
| `SHUTDOWN_DRAIN_MS` | no | `5000` prod / `0` dev | readiness 503 before close |
| `SHUTDOWN_TIMEOUT_MS` | no | `20000` | keep drain + timeout < ECS `stopTimeout` (45 s) |
| `HEALTH_READY_CACHE_MS` | no | `5000` | readiness result cache |
| `MIGRATIONS_DIR` | no | `migrations` | image sets `/app/migrations` |
| `RATE_LIMIT_PUBLIC` / `_ENUMERATION` / `_DEVICES` / `_IP_CEILING` / `_AUTHENTICATED` / `_AUTH_FAILURES` | no | 600 / 30 / 1200 / 6000 / 600 / 120 | per IP per minute |

### Sign-in
| Variable | Req. | Notes |
|---|---|---|
| `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL` | yes (current `RuntimeConfig.validate`) | your IdP (Entra ID / Okta / Google), MFA enforced there |
| `OIDC_CLIENT_ID`, `OIDC_SCOPE` | for SSO on web | public PKCE client; scope default `openid profile email` |
| `AUTH_SIGNING_KEY` | yes (native auth) | Ed25519/P-256 private key — production refuses to start without it |
| `AUTH_ISSUER` | yes (native auth) | e.g. `https://api.people.example.in`; must differ from `OIDC_ISSUER` |
| `AUTH_AUDIENCE` | no | defaults to `OIDC_AUDIENCE` then `northstar-api` |
| `AUTH_PREVIOUS_PUBLIC_KEYS` | during rotation | JSON array of old public JWKs |
| `AUTH_ACCESS_TTL_SECONDS` | no | 300–900, default 600 |
| `AUTH_COOKIE_SECURE` | no | Secure is forced in production |
| `AUTH_SCRYPT_N`, `AUTH_SCRYPT_P` | no | password hashing cost (leave defaults) |

### Data protection
| Variable | Req. | Notes |
|---|---|---|
| `DATA_ENCRYPTION_KEYS` | yes | `kid:base64key[,kid2:…]` — PAN/UAN/ESI/bank field encryption |
| `DATA_ENCRYPTION_ACTIVE_KEY` | yes | kid used for new writes |
| `DATA_ENCRYPTION_WRAPPED_KEYS` | alternative | KMS-wrapped data keys (see `field-crypto.ts initFieldCryptoFromKms`) |
| `DATA_INDEX_KEY` | yes | blind-index key for searching encrypted fields |
| `INTEGRATIONS_MASTER_KEY` | yes | 32+ chars; device/webhook secrets derive from it |
| `PAYOUTS_WEBHOOK_SECRET` | yes | 24+ chars |
| `DATA_DIR` | no | dev-only secret files; image sets `/tmp/northstar` (unused in prod) |

### Files
| Variable | Req. | Notes |
|---|---|---|
| `FILES_STORAGE` | yes | `s3` (production refuses `local`) |
| `FILES_S3_BUCKET`, `FILES_S3_REGION`, `FILES_S3_PREFIX` | yes | bucket, `ap-south-1`, `prod` |
| `FILES_S3_KMS_KEY_ID` | recommended | SSE-KMS |
| `FILES_S3_SSE` | no | `AES256` default on AWS without KMS |
| `FILES_S3_ENDPOINT`, `FILES_S3_FORCE_PATH_STYLE`, `FILES_S3_ACCESS_KEY_ID`, `FILES_S3_SECRET_ACCESS_KEY` | no | S3-compatible stores only — on AWS use the task role |
| `AWS_REGION` | no | `ap-south-1` |
| `HRM_UPLOAD_PATH` | no | local driver only |
| `FILE_RETENTION_DAYS`, `NOTIFICATION_RETENTION_DAYS` | no | housekeeping job |

### Email, push, jobs, integrations, OCR, billing
| Variable | Req. | Notes |
|---|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | yes | SES (§5); without `SMTP_HOST` mail is written to `MAIL_DIR` |
| `MAIL_DIR`, `MAIL_MAX_ATTEMPTS` | no | |
| `JOBS_CONCURRENCY`, `JOBS_TIMEOUT_MS`, `JOBS_SHUTDOWN_GRACE_MS`, `JOBS_PRUNE_SCHEDULERS`, `JOBS_ANNIVERSARY_ANNOUNCE` | no | 4 / 300000 / 30000 / true / — |
| `WORKER_HEALTH_PORT` | no | `4190`; `0` disables |
| `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON` (or `_PATH`) | for Android push | |
| `APNS_KEY_P8` (or `APNS_KEY_PATH`), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_ENV` | for iOS push | `APNS_ENV=production` |
| `DEV_PUSH_PATH`, `DEV_PUSH_SIMCTL`, `DEV_PUSH_SIMCTL_DEVICE` | never in prod | simulator push |
| `RAZORPAYX_KEY_ID`, `RAZORPAYX_KEY_SECRET`, `RAZORPAYX_ACCOUNT_NUMBER`, `PAYOUTS_DEBIT_ACCOUNT` | for bank payouts | |
| `PAYOUT_SANDBOX_STEP_SECONDS` | never in prod | sandbox adapter |
| `RECEIPT_OCR_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_OCR_MODEL`, `OCR_DATA_PATH`, `TESSERACT_LANG_PATH` | optional | receipt OCR; with tesseract on a read-only FS point `OCR_DATA_PATH` at a baked-in or `/tmp` path |
| `OPERATOR_TRADE_NAME`, `OPERATOR_PAN`, `OPERATOR_EMAIL`, `OPERATOR_BANK_DETAILS` | for billing invoices | the SaaS operator's details |

### Web (build args, `Dockerfile.web`)
| Variable | Req. | Notes |
|---|---|---|
| `NEXT_PUBLIC_PLATFORM_API_URL` | yes | `https://api.people.example.in` (also in CSP `connect-src`) |
| `NEXT_PUBLIC_APP_DOMAIN` | yes | `people.example.in` |
| `NEXT_PUBLIC_OIDC_ISSUER` / runtime `OIDC_ISSUER` | with SSO | added to CSP |
| `NEXT_PUBLIC_ALLOW_DEMO_IDENTITY` | must be `false` | |
| `NEXT_PUBLIC_DEMO_*_ID` | never in prod | demo persona switcher |

### Mobile (`mobile/src/config/env.ts`)
Not environment variables: hosts are compiled per build flavour. Replace the placeholder `*.northstar.example` staging/
production hosts with the real `api.` and web domains before the first store build (see docs/release.md).

### Scripts only
`DATABASE_ADMIN_URL`, `RUNTIME_DB_PASSWORD` (migrate.mjs first install), `BOOTSTRAP_ADMIN_EMAIL`/`_NAME`
(bootstrap-production.mjs), `SMOKE_API_URL`/`SMOKE_WEB_URL`/`SMOKE_BRAND_URL`/`SMOKE_TOKEN` (smoke-prod.mjs),
`ALLOW_DEV_SCRIPTS_ON_REMOTE_DB` (seed scripts on a disposable remote demo DB — never production).

# Go-live checklist (production)

Tick every box before pointing real customers at the platform. Each item says how to verify it. The Security Center
(`/platform` → Security, `GET /api/v2/platform/security/posture`) must show **every automated check "pass"** — production
refuses to start for several of them anyway.

## 1. Security Center baseline (`SecurityService.baselineChecks`)

| Check id | Title | How to make it pass | Verify |
|---|---|---|---|
| `demo-identity` | Demo sign-in disabled | `ALLOW_DEMO_IDENTITY=false` (API) and build web with `NEXT_PUBLIC_ALLOW_DEMO_IDENTITY=false`. Production refuses to boot with it on. | `smoke-prod.mjs` "Demo header sign-in rejected" + `GET /api/v2/auth/config` → `demoIdentity:false` |
| `db-role` | Tenant queries use a least-privilege role | Run `db/runtime-role.sql` as DBA; `DATABASE_URL_RUNTIME` = `hrm_runtime` (owns no tables, NOBYPASSRLS). | readiness `databaseRuntime: ok`; check passes |
| `rls` | Row-level security on every brand table | Comes from migrations; never create a table with `organization_id` without ENABLE+FORCE RLS + `tenant_isolation`. | check passes; CI `migrations` job |
| `audit` | Audit trail is append-only | Migrations 021/024 (trigger `audit_log_no_update`, hash chain); runtime role has no UPDATE/DELETE on `audit_log` (026). | check passes; CI asserts runtime cannot UPDATE `audit_log` |
| `sso` | Company single sign-on | `OIDC_ISSUER`/`OIDC_AUDIENCE`/`OIDC_JWKS_URL`/`OIDC_CLIENT_ID` → real IdP (not `localhost:4200`), MFA enforced at the IdP. | check passes; smoke "Auth config" shows an https issuer |
| `master-key` | Integration secrets key | `INTEGRATIONS_MASTER_KEY` ≥ 32 random chars from Secrets Manager. | check passes (boot fails otherwise) |
| `payout-secret` | Bank payout webhook secret | `PAYOUTS_WEBHOOK_SECRET` ≥ 24 chars, same value at the provider. | check passes; one signed test callback in staging |
| `redis` | Shared rate limits and background jobs | `REDIS_URL=rediss://…` ElastiCache with TLS + AUTH. | readiness `redis: ok`; ops status shows ≥ 2 worker heartbeats |
| `smtp` | Outgoing email | SES SMTP settings; SPF, DKIM, DMARC published (deploy-aws.md §5). | check passes; send a password-reset to a test inbox, inspect headers: `spf=pass dkim=pass dmarc=pass` |
| `https` | HTTPS everywhere | `APP_BASE_URL=https://…`; ALB 443 only (80 → 301); HSTS sent by API and web in production. | smoke "HSTS", "plain HTTP redirects" |
| `cors` | API accepts only your web origins | `CORS_ORIGIN=https://<APP_DOMAIN>` (no `*`, all https). | smoke "CORS rejects a foreign origin" / "allows the web origin" |
| `runtime-secret` | Database credentials separated | Different `DATABASE_URL` and `DATABASE_URL_RUNTIME`. The owner URL goes only to the migrate task, the API and the worker (for the few reviewed system paths) — never to people or other services. | check passes |
| `file-storage` | Employee files in encrypted object storage | `FILES_STORAGE=s3`, bucket in ap-south-1 set up with `s3-bucket-setup.mjs` (SSE-KMS, versioning, TLS-only, no public access). | check passes; readiness `storage: ok, driver s3` |
| `backups` (manual) | Encrypted backups with PITR | RDS encrypted, PITR 35 days, cross-region copy; first restore drill done (backup-restore.md). | drill report filed; ops status `lastBackup` set |
| `pentest` (manual) | Independent penetration test | CERT-In empanelled auditor on the production-like staging; all high/critical closed, mediums with dated plan. | report + retest letter in compliance evidence |

## 2. Infrastructure

- [ ] RDS Postgres 16 Multi-AZ, encrypted (CMK), deletion protection, PITR 35 days, `rds.force_ssl=1`, cross-region backup copy.
- [ ] `npm run db:migrate` (migrate task) exit 0; `migrate.mjs --verify` → 0 pending, 0 changed; readiness `migrations: ok`.
- [ ] ElastiCache TLS + AUTH, `noeviction`, replica + failover.
- [ ] S3 bucket script output all "ok"; app role has only the prefix-scoped policy.
- [ ] Secrets in Secrets Manager (KMS); no secret in task definitions, images (`docker history`), git, or CI logs.
- [ ] `.env` files never shipped: `.dockerignore` excludes them; images contain no `.env` (`docker run --rm --entrypoint ls <image> -a /app`).
- [ ] Containers: non-root (`node`), read-only root FS, `/tmp` ephemeral, health checks green, `stopTimeout` 45 s.
- [ ] Two+ api tasks and two+ worker tasks across AZs; ALB target health uses `/api/v2/health/ready`.
- [ ] WAF attached (managed rules + rate rule); ALB access logs on; VPC flow logs on; CloudTrail (all regions) on.
- [ ] Log retention ≥ 180 days in India (CERT-In) — we use 1 year in ap-south-1.
- [ ] Alarms from deploy-aws.md §8 created and routed to the on-call rotation; test page received.
- [ ] `SENTRY_DSN` set (optional) — trigger a test 5xx in staging and see the event (ids only, no PII).

## 3. DNS & TLS

- [ ] ACM certificate for `<APP_DOMAIN>` + `*.<APP_DOMAIN>` issued (DNS validation records kept).
- [ ] Route 53: apex, **wildcard `*.<APP_DOMAIN>`** (brand subdomains) and `api.<APP_DOMAIN>` → ALB.
- [ ] Every brand slug resolves: `https://<slug>.<APP_DOMAIN>/login` shows that brand's sign-in page; `/platform` on a
      brand subdomain bounces to the main domain.
- [ ] CAA record allowing only `amazon.com` (ACM).
- [ ] HSTS preload submitted only after a week of clean HTTPS on all subdomains (`includeSubDomains; preload` is sent).

## 4. Data & identity

- [ ] **No demo data**: the production DB was created by migrations + `bootstrap-production.mjs` only. Check:
      `SELECT slug FROM organizations` lists only real brands created through `/platform`;
      `SELECT count(*) FROM users WHERE email LIKE '%northstar.example' OR email LIKE '%@example.%'` = 0.
- [ ] **Seeds blocked**: `NODE_ENV=production node scripts/seed.mjs` exits 2 with "refusing to run"; seed/
      simulator/dev-IdP scripts are not in the runtime images at all.
- [ ] Dev OIDC provider (`dev-oidc-provider.mjs`, localhost:4200) not referenced anywhere (`OIDC_*`, CSP).
- [ ] First platform super admin created with `bootstrap-production.mjs`, activated, MFA enrolled; a second admin
      invited from `/platform` (no single point of failure); break-glass procedure documented.
- [ ] Field-encryption keys set (`DATA_ENCRYPTION_KEYS`, `DATA_ENCRYPTION_ACTIVE_KEY`, `DATA_INDEX_KEY`) and **backed up
      in two places** (Secrets Manager + offline escrow with the CTO). Losing them = losing PAN/UAN/bank data.
- [ ] Customer DPAs signed (ClanChief = processor; breach notice to customer within 24 h — see incident-response.md);
      privacy notice and grievance officer contact published in the app.

## 5. Release & smoke tests

- [ ] CI green on the release commit (type-check, backend build + tests, mobile, `npm audit --omit=dev` high=0,
      fresh-install migrations, Docker builds).
- [ ] Images tagged `<version>-<sha>`, scanned by ECR (no critical/high unfixed).
- [ ] `node scripts/smoke-prod.mjs --api https://api.<APP_DOMAIN> --web https://<APP_DOMAIN> --brand https://<slug>.<APP_DOMAIN> --token <test token>` → **PASS** (all checks).
- [ ] Manual: sign in as a test employee on a brand subdomain, punch attendance, apply leave, approve as manager,
      upload and download a document (S3), receive the email notification, open the mobile app against production.
- [ ] `GET /api/v2/platform/ops/status` as super admin: migrations ok, queue depth ~0, no unexpected failed jobs,
      worker heartbeats from every worker task, `errorReporting.enabled` as intended.
- [ ] Rollback plan written: previous task definitions noted; migrations in this release are backwards compatible.
- [ ] On-call rota, incident contacts and the CERT-In / DPDP notification owners filled in (incident-response.md).

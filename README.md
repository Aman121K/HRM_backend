# Northstar People — Platform API

Multi-brand HRM platform API: NestJS 11 + Fastify 5, PostgreSQL 16 with row-level security per brand, Redis + BullMQ
jobs worker. The web app ([HRM_frontend](https://github.com/Aman121K/HRM_frontend)) and the mobile app
([HRM_Mobile_App](https://github.com/Aman121K/HRM_Mobile_App)) talk to it over HTTPS only.

## Repositories

Northstar People is split into four repositories:

| Repository | What it is |
|---|---|
| [HRM_backend](https://github.com/Aman121K/HRM_backend) | Platform API (NestJS + Fastify), jobs worker, PostgreSQL migrations, deploy files and runbooks |
| [HRM_frontend](https://github.com/Aman121K/HRM_frontend) | Web app (Next.js 16, React 19) |
| [HRM_Mobile_App](https://github.com/Aman121K/HRM_Mobile_App) | iOS + Android app (React Native CLI) |
| [HRM](https://github.com/Aman121K/HRM) | Marketing website |

## Run locally

Needs Node 22+, PostgreSQL 16 and Redis 7 (Homebrew, or `docker compose -f docker-compose.dev.yml up -d`).

```bash
npm install
cp .env.example .env            # then fill DATABASE_URL, DATABASE_URL_RUNTIME, REDIS_URL, DATA_ENCRYPTION_* …
npm run db:migrate              # applies migrations/NNN_*.sql (owner role)
npm run db:seed && npm run db:seed:brands   # demo data — local only, refuses NODE_ENV=production
npm run dev                     # API on http://localhost:4100 (docs: /api/v2/docs)
npm run jobs:dev                # jobs worker (health on :4190)
npm run dev:idp                 # optional: development-only OIDC provider on :4200
```

| Command | What it does |
|---|---|
| `npm run build` | Type-check and compile `src/platform` → `dist-v2` |
| `npm test` | Every `src/**/*.test.ts` |
| `npm run db:migrate:status` / `db:migrate:verify` | Applied / pending migrations, checksum check |
| `npm run ci:migrate-check` | Fresh install from zero + schema snapshot compare (empty DB owned by `hrm_app`) |
| `npm run bootstrap:prod` | First super admin on a new production database (no demo data) |
| `npm run smoke:prod` | Post-deploy smoke test |

Production: `Dockerfile` (targets `api`, `worker`, `migrate`), `docker-compose.prod.yml`, `deploy/env.production.example`
and the runbooks in `docs/ops/` (AWS deploy, backup/restore, incident response, go-live checklist). Payroll statutory
items for CA review: `docs/payroll-statutory-review.md`.

## Application backend

All features run on the v2 platform API (NestJS + Fastify, PostgreSQL with row-level security per brand) under
`src/platform`, on port 4100 (`npm run dev`). Identity comes only from verified SSO tokens (or, in
local development with `ALLOW_DEMO_IDENTITY=true`, demo headers). The original SQLite prototype backend (`/api/v1`, port
4000) has been retired and moved to the archive (not in this repository) for reference; nothing in the product depends on it.

## Case engine (Helpdesk, Assets, Expenses, Travel, Learning, Shifts, Letters, Recognition, Jobs, Candidates, Exit)

Eleven request/approval modules share one tenant-scoped engine in the NestJS platform API (`src/platform/cases`).
Each module is declared once in `case-modules.ts` — form fields, statuses, the state machine, who may take each action
(requester, approver, assignee, HR), SLA targets and policy limits. The API publishes these definitions and the UI
(`src/components/cases`) renders forms, badges, steppers and action buttons from them.

- Routing: `manager` modules go to the requester's reporting manager (HR when none); `hr` modules go straight to the HR desk.
- Requesters never approve, pay or settle their own case. Managers only see their reports' cases in manager-routed modules,
  so helpdesk tickets (including confidential grievances) and letters stay private between the employee and HR.
- Every create, transition and comment writes an `hr_case_events` timeline row, an `audit_log` entry and a notification.
- Optimistic concurrency: transitions require the case `version` the user saw.

Endpoints (`/api/v2/cases`): `GET modules`, `GET inbox` (everything awaiting the viewer), `GET summary` (dashboard),
`GET ?module=&scope=mine|team|all&status=&search=`, `POST` (create), `GET :id`, `POST :id/transitions`, `POST :id/comments`.

```bash
npm run db:migrate                 # applies 004_hr_cases.sql
npm run dev             # platform API on :4100
npm run db:seed:cases -- --reset   # demo colleagues and requests in every module (local only)
```

In local demo mode the sidebar's **View as** switcher changes which seeded identity (employee, manager, HR) the browser acts as.

## Sign-in (OIDC single sign-on)

The web app uses the OpenID Connect Authorization Code flow with PKCE as a public client (`src/lib/auth.ts`); the API
verifies RS256 access tokens against the IdP's JWKS (`src/platform/auth/auth.service.ts`). On first sign-in a
user is matched by a **verified** email and the IdP's `(issuer, subject)` is bound to the account; later sign-ins use
only that binding. MFA, password policy and SSO federation are enforced by your identity provider (Okta, Entra ID,
Auth0, Keycloak, Google Workspace…). Tokens live in `sessionStorage` and an expired token redirects to `/login`.

Configure: `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL`, `OIDC_CLIENT_ID` (public client, redirect URI
`<web origin>/auth/callback`, post-logout URI `<web origin>/login`). With `ALLOW_DEMO_IDENTITY=false` every page requires
sign-in. For local testing, `npm run dev:idp` starts a development-only identity provider on :4200 that prints the values
to put in `.env` — never deploy it.

## Background jobs, access control, integrations and mobile

- **Jobs (Redis + BullMQ):** the API only enqueues; `npm run jobs:dev` runs the worker (`src/platform/jobs/worker.ts`)
  with email delivery (SMTP when `SMTP_HOST` is set, otherwise JSON files in `.data/mail/`), SLA/approval/survey/LMS/onboarding/
  roster reminders, work anniversaries and housekeeping. Console: `/settings/jobs`. Needs `REDIS_URL`.
- **Access & roles:** `/settings/access` — custom roles from a permission catalogue with data scopes, temporary grants,
  separation-of-duties warnings, access review and the audit log. Guardrails: no self-assignment, no escalation, CRITICAL grants
  need a reason.
- **Integrations:** `/settings/integrations` — biometric devices (signed JSON API and ZKTeco/eSSL ADMS `/iclock`), Tally XML and
  CSV accounting exports, bank payout batches with maker-checker (H2H file, bank CSV, RazorpayX-style API with sandbox), signed
  outgoing webhooks. Set `INTEGRATIONS_MASTER_KEY` (32+ chars) and `PAYOUTS_WEBHOOK_SECRET` before production.
  `node scripts/simulate-biometric.mjs` sends demo device punches.
- **Attendance:** `/api/v2/attendance/*` — GPS punches from web and mobile checked against geofenced sites
  (`/settings/attendance`), plus biometric punches.
- **Mobile app:** React Native CLI app in `mobile/` (iOS + Android) — punch in/out with location, roster, attendance history,
  payslips, leave, approvals. See `mobile/README.md` (`cd mobile && npm start`, then `npm run ios`).

## Multiple brands (organizations)

Every brand is its own organization: people, payroll, policies, files and audit are isolated by `organization_id` with
Postgres row-level security. One person can belong to several brands (e.g. a group owner) and switches from the sidebar.

- **Platform admins** (`platform_admins`) manage brands at `/platform`: add a brand (defaults: statutory leave types,
  attendance selfie policy, first HR admin; payroll/roster/onboarding defaults on first use), switch modules on/off per
  brand (disabled modules disappear from navigation and their APIs return `MODULE_DISABLED`), suspend/reactivate.
- **Group admins** (`group_admins`) see every brand side by side at `/group` (headcount, attendance today, approvals,
  tickets, payroll) — read-only totals; drilling in switches brand.
- **Owners/HR** edit their own brand's name, colours, logo, PT state and employee ID prefix at `/settings/organization`.
- API: `GET /api/v2/orgs/mine`, `GET|PATCH /api/v2/orgs/current`, `GET|POST|PATCH /api/v2/platform/orgs`,
  `POST /api/v2/platform/groups`, `GET /api/v2/group/overview`. SSO clients pick a brand with the `x-organization-id` header.
- Demo: `npm run db:seed:brands` creates Got Tea and Suchali's next to Blue Tokai, a "Brands Group", and a Group Owner
  (platform admin) — sign in from `/login` by brand.

## Brand subdomains (`<brand>.<APP_DOMAIN>`)

Every brand gets its own address, like PeopleStrong's `client.peoplestrong.com`: `got-tea.people.example.com` shows only
Got Tea's sign-in page and can only use Got Tea data. The super admin console lives on the main domain only.

- Locally nothing is needed: browsers resolve `*.localhost`, so open `http://got-tea.localhost:3000/login`.
- Config: `APP_DOMAIN` (API) and `NEXT_PUBLIC_APP_DOMAIN` (web), e.g. `people.example.com`. `CORS_ORIGIN` is the main
  web origin; brand subdomains on the same scheme/port are allowed automatically.
- Routing: `src/middleware.ts` rewrites `/login` to the brand's page, blocks `/b/<other brand>`, and sends `/admin` to the
  main domain. The API (`ModuleGuard`) rejects a request whose `Origin` is a brand subdomain when the session belongs to a
  different brand or to the super admin (`BRAND_HOST_MISMATCH`). Names like `www`, `api`, `admin` are reserved
  (`src/platform/organizations/brand-host.ts`, mirrored in `src/lib/brand-host.ts`).

Going live:
1. DNS: `people.example.com` and `*.people.example.com` → the web server/load balancer (one wildcard record; new brands need no DNS change).
2. TLS: a wildcard certificate for `*.people.example.com` + `people.example.com` (Let's Encrypt DNS-01 challenge, or Cloudflare).
3. Proxy: forward the original `Host` header to Next.js (Nginx `server_name people.example.com *.people.example.com;
   proxy_set_header Host $host;`, or Caddy `*.people.example.com, people.example.com { tls { dns cloudflare … } reverse_proxy web:3000 }`).
4. SSO: register `https://*.people.example.com/auth/callback` if your IdP supports wildcards (the dev IdP does via
   `DEV_IDP_REDIRECTS`); otherwise register each brand's callback when the brand is created.

## ISO 27001 & SOC 2 (Compliance Center)

Super admin → **Compliance** (`/admin`). Certification is granted by an accredited auditor; this module keeps the
controls running and the evidence ready (`src/platform/compliance/`, migration `024_compliance.sql`).

- **Control catalog** (`catalog.ts`): 28 ISO/IEC 27001:2022 Annex A controls and 25 SOC 2 Trust Services Criteria, each
  mapped to automated checks. Control status = automated results + the owner's implementation status + documents.
- **Evidence**: job `compliance.collect_evidence` (02:30 daily, or "Collect evidence now") stores every check result in
  `compliance_evidence` with a SHA-256 digest. Evidence rows can't be updated or deleted (trigger).
- **Tamper-evident audit log**: every `audit_log` row is hash-chained per brand (`chain_seq`, `prev_hash`, `row_hash`).
  Audit trail tab recomputes the chain and reports altered rows, broken links and missing rows.
- **Access reviews**: quarterly review of every brand membership and platform admin, with flags (privileged, left,
  dormant). Nobody can decide their own access; closing applies revocations and records evidence.
- **Policies**: versioned policies (security, acceptable use, DPDP privacy notice seeded). Employees must accept the
  current versions on first open (`PolicyGate`); acceptances are stored with time and IP.
- **Auditor pack**: JSON export of controls, evidence, reviews, policy stats and chain verification, with a manifest
  digest (`sha256(JSON.stringify(pack, null, 2))`).

Still procedural (record them as documents per control): risk register, incident response plan, vendor reviews, backup
restore tests, penetration test, HR screening, secure development process. Known technical gap reported by the checks:
PAN/UAN/bank account fields need field-level encryption before production.

## Punch security (anti buddy-punching)

HR head → **Attendance → Punch security**. Each rule is Off / Flag for review / Block (`src/platform/attendance/punch-guard.ts`, migration `025_punch_devices.sql`).

1. **App binding** — punches only from the employee's registered device, and one device marks attendance for one
   employee only. Web: a non-extractable ECDSA P-256 key in IndexedDB signs every punch (`src/lib/punch-device.ts`);
   mobile: a server-issued secret kept in the Keychain/Keystore (`mobile/src/lib/punchDevice.ts`). First device
   registers automatically up to the limit (or always via HR); new devices become requests HR approves (old one is
   removed when the limit is 1).
2. **Office Wi-Fi** — the request's public IP must be inside the office IP ranges (works for web and app). Needs
   `TRUST_PROXY` set correctly behind a load balancer so the real client IP is seen.
3. **Router MAC** — the mobile app sends the BSSID (MAC of the Wi-Fi access point); only listed office routers pass.
   Phones' own MAC addresses aren't readable by apps (randomized and hidden since Android 10 / iOS 14), so device
   identity uses the key above instead. iOS needs the "Access Wi-Fi Information" capability on the App ID.

## Security hardening (audit findings F1–F22)

Every finding from the internal security audit is closed and verified with live requests (reports in the project history):

- **Identity & gateway:** demo header sign-in is off unless `ALLOW_DEMO_IDENTITY=true` (refused in production); API binds to
  `BIND_HOST` (default 127.0.0.1); JWTs pinned to RS256/ES256/PS256 with exp/iat/sub/iss/aud required; module checks run on the
  matched route (encoded-path bypasses return 400); rate limits keyed by client IP at the edge and by verified identity after
  auth; `TRUST_PROXY` trusts exactly the configured hops; secrets in query strings are redacted from logs; returnTo is
  same-origin only; brand logos are raster only.
- **Database:** tenant queries run as `hrm_runtime` (no ownership, no BYPASSRLS, no writes to platform tables — migration 026);
  audit log is append-only and hash-chained (024).
- **Personal data:** PAN, UAN, ESI number and bank account are AES-256-GCM encrypted per field, bound to row/column/brand
  (`src/platform/security/field-crypto.ts`, keys `DATA_ENCRYPTION_KEYS`, `DATA_ENCRYPTION_ACTIVE_KEY`,
  `DATA_INDEX_KEY`); plaintext columns dropped (028). APIs return masks; "reveal" is role-checked and audited. Sensitive
  reads (payslips, profiles, exports, file downloads) are audited.
- **Payroll controls:** maker-checker on approval, bank files and payout release (preparer can never approve, release or
  download); exports carry SHA-256 + control totals; CSV formula injection neutralised.
- **Integrations:** outbound webhooks vetted against private/metadata IPs with DNS pinning and no redirects; payout webhooks
  timestamped and replay-protected; no hard-coded secrets (production refuses to start without them); jobs can't be retried
  across brands; email HTML/header injection escaped.
- **Web:** Next.js 16 / React 19; per-request CSP nonce (no `unsafe-inline` scripts) set in `src/proxy.ts`; legacy `/api/v1`
  backend retired to `archive/`. `npm audit` reports 0 vulnerabilities.

Payroll statutory rules (FY 2026-27, versioned by date) and the CA review pack: `docs/payroll-statutory-review.md`.

## File storage (per-company folders, S3)

Uploaded files (ID proofs, punch selfies, receipts, tax proofs, case attachments) go through `FilesService` →
`src/platform/files/storage.ts`. Every file lives in its company's own folder:

```
<bucket>/<FILES_S3_PREFIX>/tenants/<organization_id>/<entity_type>/<category>/<yyyy>/<mm>/<file_id>.<ext>
e.g. prod/tenants/68c6…/attendance_event/punch_selfie/2026/10/1d93….jpg
```

- The folder is built on the server from the signed-in identity, never from request data; a database constraint
  (migration 032) rejects any row whose key is outside its own company's folder; every read re-checks it.
- Objects are private (block public access, ACLs disabled, HTTPS-only bucket policy), encrypted (SSE-KMS or SSE-S3),
  versioned, and stored with a SHA-256 checksum. Downloads stream through the API (access check + audit row) and the
  bytes are verified against the recorded SHA-256 before they are served.
- `FILES_STORAGE=local` keeps the same layout under `.data/uploads` for development. Production refuses to start
  unless `FILES_STORAGE=s3`.

Going live:
1. Create the bucket in `ap-south-1` and set `FILES_STORAGE=s3`, `FILES_S3_BUCKET`, `FILES_S3_PREFIX=prod` (optionally
   `FILES_S3_KMS_KEY_ID`). Give the API/worker an IAM role — no access keys.
2. `AWS_PROFILE=admin node scripts/s3-bucket-setup.mjs` — locks the bucket down and prints the least-privilege
   IAM policy for the app role (only `…/tenants/*`).
3. `npm run build && node scripts/migrate-files-to-s3.mjs --dry-run`, then without `--dry-run`
   (add `--delete-source` once verified). Each file is read back and SHA-checked before switching; a manifest is written to
   `.data/migrations/`. `--to local` rolls back.


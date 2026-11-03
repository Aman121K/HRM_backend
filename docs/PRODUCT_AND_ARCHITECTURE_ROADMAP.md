# ClanChief product and architecture roadmap

## Product decision

ClanChief will be a modular, multi-tenant HRM. Organizations enable only the modules they purchase. The first production release is the core system of record and employee/manager workflow platform; advanced talent, recruitment, payroll compliance, and AI are later releases built on the same identity, workflow, document, notification, and audit foundations.

The attached 24-module checklist is the target product catalogue, not one release.

## Current verified coverage

| Capability | Status | Notes |
|---|---|---|
| Tenant isolation | Working foundation | PostgreSQL organization membership, RLS, tenant-scoped indexes |
| Employee CSV import | Working core | Template, dry run, row validation, transactional commit, audit |
| Employee administration | Working core | Search, detail, reporting manager, optimistic update |
| Directory and reporting hierarchy | Working core | Tenant directory and organization tree |
| GPS attendance punch | Working core | Permission, location, accuracy, idempotency, tenant storage |
| Attendance regularization | Working core | Employee submission, manager decision, history, mail outbox |
| Leave | Working core | Types, submission, overlap check, manager decision, employee history, email |
| KPI workflow | Working core | Employee submission, manager decision, history, email |
| Unified approvals | Working core | Leave plus every case-engine module in one inbox |
| Travel, letters, recognition | Working core | Travel approval and booking, HR letter requests, public recognition wall (case engine) |
| Payslip visibility | Working core | Published metadata, employee-only access; not a payroll engine |
| Profile / ESS | Partial | Profile and core self-service work; production authentication is pending |
| Notifications | Partial | Email outbox and local delivery work; templates, retries dashboard, SMS/push pending |
| Audit | Partial foundation | Core workflow audit exists; immutable retention/export policy pending |
| Full payroll | Working core | Salary structures, PF/ESI/PT/TDS rule set IN-FY2026-27.1, maker-checker runs, payslips, bank/ECR/ESI/PT exports — needs payroll-specialist validation before real use |
| Recruitment / ATS | Working core | Requisitions with HR approval, internal job board, referrals and candidate pipeline (case engine); interview scheduling integrations pending |
| Onboarding | Working core | Joiner pipeline, checklist templates, owner tasks, document verification, day-one conversion to employee; BGV integration pending |
| Performance suite | Partial | KPI core works; appraisal cycles, calibration and 360 feedback pending |
| Learning | Working core | LMS catalogue, lessons (text/video/PDF/quiz), assignments, mandatory compliance, certificates, plus external training requests |
| Assets | Working core | Request, approval, allocation with asset tag, return and condition (case engine); inventory register pending |
| Expenses | Working core | Claims with category limits, manager approval, send-back, payment reference (case engine); receipt upload and bank integration pending |
| Documents / e-sign | Partial prototype | Encrypted object storage, scanning, templates and signing pending |
| Shifts / roster | Working core | Weekly roster planner with rest/hours/weekly-off/coverage rules, publish + notify, shift-swap requests applied to roster |
| Helpdesk | Working core | Tickets with priority SLA, pick-up, request-info loop, resolve/close/reopen, private from managers (case engine) |
| Exit management | Working core | Resignation, manager acceptance with agreed LWD, clearance, full-and-final amount (case engine); clearance checklists pending |
| Reports / analytics | Working core | Executive overview + 16 reports with CSV export, role scoping and small-group suppression; warehouse pending |
| Security / administration | Partial | OIDC Authorization Code + PKCE sign-in with verified-email binding (MFA via IdP); permission administration UI pending |
| Integrations / mobile | Not implemented | Versioned public APIs/webhooks first; native app later |

## Recommended stack

### Frontend

- Next.js App Router with React and TypeScript.
- Keep UI code in `src/`; no database or server-domain imports.
- Use a typed API client generated from OpenAPI.
- Use TanStack Query (or equivalent) for server state, retries, cache invalidation and loading/error behavior.
- Maintain the existing ClanChief design system and accessible right-drawer pattern.

### Backend

- Node.js LTS with TypeScript.
- Migrate the raw `node:http` server to **NestJS using its Fastify adapter**.
  - NestJS provides clear domain modules, controllers, services, dependency injection, guards and testing seams.
  - Fastify provides schema-based request validation/serialization and an efficient HTTP runtime.
- Keep PostgreSQL as the transactional database and preserve tenant RLS.
- Use SQL migrations as the source of truth. Use Kysely/Drizzle or carefully structured `pg` repositories; do not hide tenant/session behavior behind an ORM that makes RLS hard to verify.
- Generate an OpenAPI contract and frontend client.
- Use Redis + BullMQ (or a managed equivalent) for email, document generation, payroll, imports and integration jobs.
- Use S3-compatible encrypted object storage with signed URLs for documents, proofs, resumes and payslips.
- Use an OIDC/SAML identity provider for passwordless/MFA/SSO; never accept tenant or user identity from browser-selected headers in production.

### Operations

- Structured logs, request IDs, metrics, traces and error monitoring.
- Secrets manager, rate limits, dependency scanning and security headers.
- Automated PostgreSQL backups with point-in-time recovery and restoration drills.
- Separate transactional queries from heavy analytics; add a replica/warehouse when reporting load justifies it.

## Backend module boundaries

```text
identity-access       organizations, memberships, sessions, roles, permissions
people                employees, departments, designations, reporting hierarchy
documents             metadata, storage, access grants, retention, signatures
attendance            punches, shifts, rosters, regularization, overtime
leave                 policies, balances, requests, holidays, comp-off
workflow              definitions, stages, decisions, delegation, escalation
notifications         templates, preferences, email/SMS/push delivery
payroll                structures, inputs, runs, statutory rules, payslips
recruitment            jobs, candidates, applications, interviews, offers
onboarding             joiner cases, tasks, BGV, assets, readiness
performance            cycles, goals, appraisals, feedback, calibration
learning               catalogue, enrollment, attendance, certification, skills
expenses               claims, receipts, approval, payment status
assets                 inventory, assignment, custody, return, loss/damage
helpdesk               tickets, queues, SLA, comments, resolution
separation             resignation, notice, clearances, settlement, letters
reporting              operational exports and analytics projections
integrations           webhooks, API clients, sync state and failure recovery
audit-compliance       immutable events, consent, retention, legal export
```

Each module owns its controllers, application services, repositories, policies, DTO/schema validation, events and tests. Cross-module work happens through explicit service contracts or durable events, not direct table access from UI handlers.

## Delivery phases

### Phase 0 — production foundation (must precede customer data)

- NestJS/Fastify backend skeleton and migration of current core endpoints.
- OIDC authentication, organization selection, MFA/SSO readiness.
- Role/permission guards and trusted tenant context.
- OpenAPI contract, central validation and consistent errors.
- Redis-backed jobs and transactional outbox worker.
- Encrypted object storage and malware scanning pipeline.
- CI tests, observability, backups/PITR and environment/secrets management.

Exit criteria: no browser-selected identity headers; cross-tenant integration tests; recovery drill; security review.

### Phase 1 — core HRIS release

- Employee master, departments, designations, reporting hierarchy.
- CSV import and controlled updates.
- ESS profile and document workflows.
- Attendance, shifts baseline, regularization and reports.
- Leave policies, balances, holidays, half-days and comp-off.
- Unified configurable manager approvals.
- Payslip publication and basic payroll inputs.
- Employee/manager notifications and operational reports.

Exit criteria: HR-import-to-manager-approval-to-employee-update acceptance tests for at least two isolated tenants.

### Phase 2 — India payroll and operations

- Effective-dated salary structures and revisions.
- Payroll run state machine, maker-checker approval and reruns.
- PF, ESI, PT and TDS rules versioned by jurisdiction/effective date.
- Reimbursements, bonuses, deductions, bank files and accounting exports.
- Payslip/PDF and statutory report generation.
- Assets, expenses, helpdesk and exit clearance/final settlement.

Exit criteria: parallel payroll comparison against a known payroll system and statutory review by qualified payroll/legal specialists.

### Phase 3 — talent platform

- ATS, offers and onboarding.
- Appraisal cycles, 360 feedback, calibration and promotion recommendations.
- Learning catalogue, certifications and skills matrix.
- Advanced dashboards and analytics projections.

### Phase 4 — ecosystem and intelligence

- Versioned public API, signed webhooks and integration marketplace.
- Biometric, accounting, ERP, calendar and collaboration integrations.
- Mobile/PWA capabilities.
- AI features only after permissions, source citations, human review, privacy and evaluation controls exist.

## Rules for AI capabilities

- AI recommendations never directly approve, reject, terminate, promote or change pay.
- Every result identifies source data and uncertainty and supports human review.
- Tenant data is isolated and excluded from model training unless explicitly contracted and consented.
- Policy/document answers cite the tenant-approved source and version.
- Attrition/performance models require bias, explainability, privacy and legal review before use.

## Immediate engineering backlog

1. Freeze new feature work in the raw `src/postgres/server.ts` monolith.
2. Add architecture decision records for identity provider, backend framework, SQL layer, job queue and object storage.
3. Scaffold modular NestJS/Fastify backend in `backend-v2/` or migrate `backend/` behind compatibility tests.
4. Write black-box tests for every current core endpoint before moving it.
5. Remove the legacy SQLite server and documentation after PostgreSQL parity is proven.
6. Replace hard-coded demo identities and fixture fallbacks with authenticated session context.
7. Build Phase 1 backlog from the acceptance criteria above; do not mark a module complete because a screen exists.

## Definition of done for every module

- Tenant-isolated schema and indexes based on measured query paths.
- Server-side authorization and validation.
- Loading, empty, error, permission and conflict states.
- Audit and notification events where relevant.
- Responsive, keyboard-accessible UI.
- Unit, integration and cross-tenant tests.
- Migration rollback/forward strategy and documented operational ownership.
- No fixture-only success paths in production mode.

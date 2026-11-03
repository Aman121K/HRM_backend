# Incident response

For outages, security incidents and personal-data breaches affecting ClanChief. Keep this page printed/offline
too — it must be usable when the app or SSO is down.

> **Legal timelines below must be confirmed with counsel** before go-live and re-checked yearly. They summarise the
> Digital Personal Data Protection Act 2023 (DPDP) + DPDP Rules and the CERT-In Directions of 28 April 2022 as we
> understand them; they are not legal advice.

## Severity levels

| Sev | Definition | Examples | Response | Updates |
|---|---|---|---|---|
| **SEV-1** | Personal data breach suspected/confirmed, OR full outage, OR payroll/payout integrity at risk | leaked DB/S3 data, cross-brand data visible, payout sent to wrong account, API down for all brands | page on-call immediately, incident commander (IC) within 15 min, war room | every 30 min to leadership; customers within 2 h |
| **SEV-2** | Major feature down or degraded for one or more brands; security control failing without known exposure | sign-in failing for a brand, jobs/email not processing > 30 min, WAF/rate limit disabled, audit chain check failing | on-call within 30 min | every 2 h |
| **SEV-3** | Minor degradation, workaround exists | one report slow, a single job type failing, one device not syncing | next business day | daily |
| **SEV-4** | Cosmetic / question | | backlog | — |

Anything touching **personal data** starts as SEV-1 until proven otherwise.

## Who to call

Fill in before go-live; keep phone numbers here (not only in Slack).

| Role | Primary | Backup |
|---|---|---|
| Incident commander (IC) | Platform lead — name / phone | CTO — name / phone |
| On-call engineer | rotation (PagerDuty/Opsgenie schedule `northstar-prod`) | secondary rotation |
| Security lead | name / phone | |
| Data Protection Officer / grievance officer (DPDP) | name / email / phone | |
| Legal counsel | firm / name / phone | |
| Customer communications | Customer success lead | |
| AWS Support | Business/Enterprise support case, severity "Production system down" | TAM if any |
| Payout provider (RazorpayX) | support / escalation contact | |
| IdP vendor (Entra ID / Okta / Google) | support | |
| CERT-In | incident@cert-in.org.in, phone +91-1800-11-4949, fax +91-1800-11-6969 (verify on cert-in.org.in) | |
| Data Protection Board of India | per the Board's notified portal/procedure (confirm with counsel) | |

## First 30 minutes (any SEV-1)

1. **Declare**: open `#inc-<date>-<slug>`, name the IC and a scribe. Start the timeline (UTC + IST) — every action, who, when.
2. **Stabilise / contain** (preserve evidence first where possible):
   - Snapshot before changing: `aws rds create-db-snapshot`, copy relevant CloudWatch log groups/ALB logs to a locked S3 prefix.
   - Stop the bleeding: scale api/worker to 0 or block at WAF/ALB; revoke sessions (affected users: `POST /api/v2/auth/sessions/revoke-all`;
     everyone: rotate `AUTH_SIGNING_KEY` without keeping the old public key, which invalidates every native token;
     SSO: revoke sessions at the IdP); disable a compromised integration/device;
     rotate exposed secrets (see backup-restore.md → Key rotation).
   - Suspend an affected brand from `/platform` if only one brand is involved.
3. **Assess**: what data, which brands, how many people, since when. Sources: `audit_log` (append-only, hash-chained —
   run the integrity check), Security Center events (401/403/429 aggregates), app logs by `requestId`/`organizationId`,
   CloudTrail, S3 access logs, VPC flow logs, RDS logs.
4. **Decide notifications** (below) — the clock starts when we become *aware* of the incident.

## Notification obligations (confirm with counsel)

### CERT-In — within **6 hours** of noticing
CERT-In Directions (April 2022) require reporting listed cyber incidents (including data breaches/leaks, unauthorised
access to systems or data, compromise of critical systems, attacks on servers/databases/applications, identity theft,
malicious code) **within 6 hours of noticing or being notified**. Use the incident reporting form on cert-in.org.in;
send what you know — it can be updated later. Also required: keep **logs of all ICT systems for 180 days in India**
(our CloudWatch/S3 retention is 1 year in ap-south-1) and provide them on request; synchronise clocks to NTP
(Fargate/RDS use Amazon Time Sync).

### DPDP Act — personal data breach
- The **Data Fiduciary** must notify the **Data Protection Board** and **each affected Data Principal** of a personal
  data breach. Under the DPDP Rules as notified, an intimation goes to the Board **without delay**, followed by a
  detailed report **within 72 hours** of becoming aware (or longer if the Board allows) — **confirm the current rule
  text and timelines with counsel**.
- **Who is the fiduciary?** For employee data, each **customer brand (the employer) is the Data Fiduciary**; ClanChief
  is their **Data Processor**. Our contracts/DPAs must say how fast we tell them (target: **within 24 hours**, earlier
  for SEV-1) so they can meet their own obligations. Where we act for ourselves (our own staff, billing contacts),
  ClanChief is the fiduciary.
- Content for affected people (plain language): what happened, when, what data, likely consequences, what we did,
  what they should do, contact of the DPO/grievance officer.
- Report to the Board (detailed): nature/extent/timing/location, cause, mitigation, findings about the person
  responsible, remedial measures, reports sent to Data Principals.

### Others
- Customers (brand owners/HR admins): SEV-1 within 2 hours of confirmation, then per update cadence.
- Payout provider / bank: immediately if payouts or bank details are involved.
- Police / cyber crime cell (cybercrime.gov.in) for fraud or extortion, per counsel.
- Cyber insurance carrier: per policy notice clause (often 24–72 h).

## Playbooks (short)

- **Cross-brand data exposure**: confirm with `audit_log` + request logs; check that the runtime role still has RLS
  (`Security Center → Tenant queries use a least-privilege role`); fix forward; list exposed records per brand for the
  fiduciaries.
- **Credential/secret leak** (key in a repo, laptop lost): rotate the secret immediately, invalidate tokens, review
  CloudTrail for use of the credential, then assess data access.
- **Payout to wrong account**: freeze payouts (disable the payout integration), contact the provider to recall, check
  maker-checker audit entries and bank-detail changes (`bank_account_hash` history), notify the brand's payroll admin.
- **Ransomware / mass deletion**: isolate (revoke IAM sessions, block SGs), restore DB via PITR to a clean time and S3
  via versions (backup-restore.md), rotate every secret before reconnecting.
- **Outage**: check `/api/v2/health/ready` (which dependency fails), `/api/v2/platform/ops/status` (queue depth,
  workers, DB connections), RDS/ElastiCache events, last deploy (roll back the ECS service to the previous task
  definition; never roll back migrations — fix forward).

## After the incident

- Post-incident review within 5 business days, blameless: timeline, root cause, what went well/badly, action items
  with owners and dates.
- Evidence (timeline, notifications sent with timestamps, logs) stored in the compliance evidence store for the
  retention period counsel advises.
- Update this runbook and the go-live checklist with anything that would have helped.

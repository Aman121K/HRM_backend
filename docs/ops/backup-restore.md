# Backup, restore and key rotation

What is backed up, how to restore it, and the quarterly drill that proves it works. Targets: **RPO ≤ 5 minutes**
(RDS point-in-time recovery), **RTO ≤ 2 hours** for the database, ≤ 30 minutes for files.

| Data | System of record | Backup | Retention |
|---|---|---|---|
| All HR, payroll, audit data | RDS Postgres 16 | Automated snapshots + transaction logs (PITR), cross-region copy via AWS Backup | 35 days PITR; monthly snapshots kept 1 year (AWS Backup plan); yearly kept 8 years where payroll law requires (confirm with counsel) |
| Employee files | S3 bucket (versioned, SSE-KMS) | Object versioning; optional Cross-Region Replication | noncurrent versions 90 days (lifecycle set by `s3-bucket-setup.mjs`) |
| Secrets & keys | Secrets Manager / KMS | Secrets Manager versions; KMS keys are never deleted (schedule-deletion disabled by SCP) | — |
| Queue state | ElastiCache Redis | none needed — rebuildable; the email outbox lives in Postgres | — |
| Audit trail | `audit_log` (append-only, hash-chained) | part of the database | per policy |

**Encryption keys are part of the backup.** Field-encrypted columns (PAN, UAN, ESI, bank) can only be read with the
`DATA_ENCRYPTION_KEYS` that were active when they were written, and blind indexes with the same `DATA_INDEX_KEY`.
A database restore without the matching key set is useless — never delete an old kid from Secrets Manager.

## Recording the last good backup (ops status marker)

`GET /api/v2/platform/ops/status` shows `queue.lastBackup` from the Redis key `northstar:ops:backup-marker`. Write it
from your backup automation (e.g. an EventBridge rule on "RDS automated backup completed" → small Lambda) and after
every drill:

```bash
redis-cli -u "$REDIS_URL" --tls SET northstar:ops:backup-marker \
  '{"at":"2026-10-20T21:00:00Z","kind":"rds-automated","latestRestorableTime":"2026-10-20T21:04:00Z","verifiedRestore":"2026-10-05","by":"ops"}'
```

## Restore the database to a point in time (PITR)

Use when: data was corrupted/deleted by a bug or a person, or for the drill. RDS restores to a **new** instance;
the old one is untouched until you switch.

1. Freeze writes if the incident is ongoing: scale `api` and `worker` services to 0 (web shows an error page), or put
   the ALB rule to a fixed 503 response.
2. Find the target time (UTC) just before the damage — from `audit_log` (`created_at` of the bad action) or app logs
   (`requestId`).
3. Restore:
   ```bash
   aws rds restore-db-instance-to-point-in-time --region ap-south-1 \
     --source-db-instance-identifier hrm-prod --target-db-instance-identifier hrm-prod-restore-$(date +%Y%m%d%H%M) \
     --restore-time 2026-10-20T08:14:00Z --db-subnet-group-name hrm-data --vpc-security-group-ids sg-rds \
     --db-parameter-group-name hrm-pg16 --multi-az --deletion-protection --copy-tags-to-snapshot
   aws rds wait db-instance-available --db-instance-identifier hrm-prod-restore-…
   ```
   (KMS encryption and the instance class are inherited from the source.)
4. Verify the restored instance before switching (from a bastion / one-off task):
   ```bash
   DATABASE_URL=<owner url to restored instance> node scripts/migrate.mjs --verify   # 0 pending, 0 changed
   psql "<restored>" -c "SELECT max(created_at) FROM audit_log"                               # ≈ restore time
   psql "<restored>" -c "SELECT count(*) FROM employees; SELECT count(*) FROM payroll_runs"  # plausible counts
   ```
   Then point a staging API at it and confirm a PII decrypt works (open an employee's payroll profile as HR) — proves
   the keys match.
5. Switch: either (a) update the `DATABASE_URL` / `DATABASE_URL_RUNTIME` secrets to the new endpoint and redeploy api +
   worker, or (b) rename instances (`hrm-prod` → `hrm-prod-old`, restored → `hrm-prod`) so the endpoint is unchanged.
   The `hrm_app` / `hrm_runtime` roles and passwords come with the restore.
6. Partial recovery instead (only some rows lost): keep production running, restore to a side instance, and copy the
   missing rows back with reviewed SQL. Never UPDATE/DELETE `audit_log`; record the repair as new audit entries.
7. Keep the old instance (stopped, deletion protection on) for 7 days, then snapshot and delete.

## Restore files from S3 versioning

Deleted or overwritten objects keep their previous versions for 90 days.

```bash
# list versions for one file key (the key is in stored_files.storage_key, prefixed with FILES_S3_PREFIX)
aws s3api list-object-versions --bucket northstar-people-files-prod --prefix prod/tenants/<org>/<…>/<file-id>.pdf
# undelete: remove the delete marker
aws s3api delete-object --bucket northstar-people-files-prod --key <key> --version-id <delete-marker-version-id>
# or restore an older version over the current one
aws s3api copy-object --bucket northstar-people-files-prod --key <key> \
  --copy-source "northstar-people-files-prod/<key>?versionId=<version>" --server-side-encryption aws:kms --ssekms-key-id <key-arn>
```
The API verifies every download against `stored_files.sha256`; after a restore, open the file in the app to confirm
the hash matches. For a bulk restore (ransomware/mass delete) use S3 Batch Operations with a manifest of keys and the
version before the incident time.

## Key rotation

| Key | Rotate | How |
|---|---|---|
| `DATA_ENCRYPTION_KEYS` (field encryption) | yearly, and on suspected exposure | Add a new `kid:key` to the list (keep the old ones), set `DATA_ENCRYPTION_ACTIVE_KEY` to the new kid, deploy. New writes use it; old rows still decrypt. Re-encrypt old rows with `node scripts/encrypt-sensitive-fields.mjs --rotate` (re-seals rows written under older kids with the active kid), then — only after a backup older than the cut-over has expired — remove the old kid. |
| `DATA_INDEX_KEY` (blind index) | only on exposure | Requires recomputing every `*_hash` column: plan downtime, run the re-index, deploy. Treat as a project, not a routine. |
| `AUTH_SIGNING_KEY` (native tokens) | every 6 months | Generate a new key; put the old public JWK into `AUTH_PREVIOUS_PUBLIC_KEYS`; deploy; after the max token lifetime + refresh window, remove it. |
| `INTEGRATIONS_MASTER_KEY` | yearly / on exposure | Derived device/webhook secrets change: schedule with integration owners, re-pair biometric devices and re-share webhook secrets. |
| `PAYOUTS_WEBHOOK_SECRET` | with the provider | Set the new secret at the provider and here in the same window; failed callbacks are retried by the provider. |
| DB passwords (`hrm_app`, `hrm_runtime`) | 90 days (Secrets Manager rotation Lambda, alternating-users not needed) | `ALTER ROLE … PASSWORD`, update the secret, rolling-restart api/worker. |
| Redis AUTH token | 90 days | ElastiCache `modify-replication-group --auth-token … --auth-token-update-strategy ROTATE`, update secret, restart, then `SET`. |
| SES SMTP credentials | 90 days | new IAM access key → SMTP password → secret → restart worker → delete old key. |
| KMS keys (RDS, S3, secrets) | automatic yearly rotation ON | nothing to do; never schedule deletion. |

Every rotation: record who/when in the change log, run `smoke-prod.mjs`, and check the Security Center score.

## Quarterly restore drill (checklist)

Owner: platform on-call lead. Evidence goes to the compliance evidence store (Security Center → Compliance).

- [ ] Pick a random restore time in the last 7 days; restore RDS to a new instance (above).
- [ ] `migrate.mjs --verify` on the restore: 0 pending, 0 changed.
- [ ] Row counts within expectation for `employees`, `payroll_runs`, `attendance_records`, `audit_log`.
- [ ] Audit chain intact: run the Security Center audit-integrity check against a staging API pointed at the restore.
- [ ] Decrypt test: a staging API with production key set opens one payroll profile (PAN masked/unmasked as per role).
- [ ] Restore 3 random S3 objects from older versions; SHA-256 matches `stored_files.sha256`.
- [ ] Measure: time from start to verified restore (RTO) and data gap (RPO). Record both.
- [ ] Update `northstar:ops:backup-marker` with `verifiedRestore`.
- [ ] Delete the restored instance (snapshot first if evidence needs it); confirm no restored data was left in staging.
- [ ] File the drill report; open tickets for anything that took longer than the targets.

# ClanChief on one AWS server (starter setup, ~$30/month)

A low-cost way to go live while the customer count is small. One EC2 server runs the web app, API, worker,
Redis and Caddy in Docker. The database runs on Amazon RDS and uploaded files go to S3. DNS and HTTPS run
through Cloudflare (free plan), which also covers every brand subdomain.

```
clanchief.com, www      → your website (already live, unchanged)
app.clanchief.com       → EC2 → Caddy → web     (main sign-in / workspace finder, super admin)
*.clanchief.com         → EC2 → Caddy → web     (each brand: abc.clanchief.com, xyz.clanchief.com …)
api.clanchief.com       → EC2 → Caddy → api
EC2 → RDS PostgreSQL (private) · EC2 → S3 (instance role, no access keys)
```

| Item | Choice (Mumbai, ap-south-1) | ≈ per month |
|---|---|---|
| Server | EC2 `t4g.small` (2 vCPU, 2 GB), Ubuntu 24.04 arm64, 30 GB gp3 | $12–15 |
| Database | RDS PostgreSQL 16 `db.t4g.micro`, 20 GB gp3, single-AZ | $13–15 |
| Public IP | Elastic IP | $3.60 |
| Files, email | S3, SES | < $2 |

When you outgrow this setup (roughly 5–10 paying brands, or when you need high availability), move to the full
setup in [../../docs/ops/deploy-aws.md](../../docs/ops/deploy-aws.md). The Docker images and environment variables
are the same.

---

## Step 0 — Protect the budget (5 min)

1. **Billing → Budgets → Create budget → Monthly cost budget**: $30, with email alerts at 50%, 80% and 100%.
2. Turn on MFA for the AWS root user. Then create an IAM user (or use Identity Center) for daily work.
3. Pick the **Asia Pacific (Mumbai) ap-south-1** region (top-right in the console) for every step below.

## Step 1 — Move DNS to Cloudflare (15 min, propagation can take a few hours)

1. Create a free account at cloudflare.com and add the site `clanchief.com`.
2. Cloudflare imports your existing records. **Check that the website records (`@` and `www`) are still
   there and point where they do today.**
3. At your domain registrar, replace the nameservers with the two Cloudflare gives you.
4. **SSL/TLS → Overview**: set the mode to **Full (strict)**.
5. **SSL/TLS → Origin Server → Create certificate**: keep the hostnames `clanchief.com` and `*.clanchief.com`,
   set validity to 15 years, and use PEM format. Save the two blocks of text as `origin.pem` (the certificate) and
   `origin.key` (the private key). You copy them to the server in Step 5. The key is shown only once, so keep it
   in your password manager.

You add the `app`, `api` and `*` records in Step 7, once the server is running.

## Step 2 — Security groups (5 min)

**EC2 → Security Groups → Create**:

- `clanchief-web` (for the server)
  - inbound **HTTPS 443** and **HTTP 80** from the Cloudflare IP ranges only. The current list is at
    https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6; add one rule per range.
    This makes sure nobody can bypass Cloudflare and reach the server directly.
  - **No SSH rule.** You connect with Session Manager (Step 4).
- `clanchief-db` (for RDS)
  - inbound **PostgreSQL 5432** from the security group `clanchief-web` only (pick the group, not an IP).

## Step 3 — Database: RDS PostgreSQL (15 min + ~10 min to create)

**RDS → Create database**:

| Setting | Value |
|---|---|
| Creation method | Standard create |
| Engine | PostgreSQL **16.x** |
| Template | **Free tier** (if offered) or Dev/Test |
| Identifier | `clanchief-db` |
| Master username | `postgres`; let RDS manage the password in Secrets Manager, or set your own and keep it in a password manager |
| Instance | `db.t4g.micro` |
| Storage | gp3, 20 GB. Turn storage autoscaling on, with a maximum of 50 GB |
| Availability | Single-AZ (Multi-AZ doubles the cost; turn it on later) |
| Public access | **No** |
| VPC security group | `clanchief-db` (remove `default`) |
| Initial database name | leave empty (created below) |
| Backups | automated, **7 days** retention |
| Encryption | **On** (default AWS key) |
| Deletion protection | **On** |

When the status is *Available*, copy the **Endpoint** (for example
`clanchief-db.abc123.ap-south-1.rds.amazonaws.com`).

## Step 4 — Server: EC2 (20 min)

1. **IAM → Roles → Create role**: trusted entity *AWS service → EC2*.
   - Attach the managed policy **AmazonSSMManagedInstanceCore** (needed for Session Manager).
   - Add an inline policy named `clanchief-files`, created after you make the bucket in Step 6:
     ```json
     { "Version": "2012-10-17", "Statement": [
       { "Effect": "Allow", "Action": ["s3:PutObject","s3:GetObject","s3:DeleteObject"], "Resource": "arn:aws:s3:::clanchief-files-prod/prod/tenants/*" },
       { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::clanchief-files-prod", "Condition": { "StringLike": { "s3:prefix": ["prod/tenants/*"] } } }
     ] }
     ```
   - Name the role `clanchief-server`.
2. **EC2 → Launch instance**:
   - AMI: **Ubuntu Server 24.04 LTS (arm64)**. Instance type: **t4g.small**. Key pair: none.
   - Security group: `clanchief-web`. Storage: 30 GB gp3.
   - Advanced details:
     - IAM instance profile: `clanchief-server`.
     - Metadata version: **V2 only**.
     - Metadata response hop limit: **2**. Docker containers need this to reach the instance role.
3. **EC2 → Elastic IPs → Allocate**, then associate it with the instance. Note the IP.
4. Connect: **EC2 → instance → Connect → Session Manager**. Then run:
   ```bash
   sudo -i
   # Docker + compose plugin, git, openssl, postgres client
   apt-get update && apt-get install -y ca-certificates curl git openssl postgresql-client
   curl -fsSL https://get.docker.com | sh
   # 2 GB swap: the Next.js build needs more than 2 GB RAM for a moment
   fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   # Code: both repositories side by side
   mkdir -p /opt/clanchief && cd /opt/clanchief
   git clone https://github.com/Aman121K/HRM_backend.git backend
   git clone https://github.com/Aman121K/HRM_frontend.git frontend
   ```

## Step 5 — Create the database roles and the env file (10 min)

Run on the server, as root, from `/opt/clanchief/backend`:

```bash
cd /opt/clanchief/backend
mkdir -p deploy/single-server/certs
# RDS CA bundle, so connections are TLS-verified
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o deploy/single-server/certs/rds-global-bundle.pem

export RDS_ENDPOINT=clanchief-db.abc123.ap-south-1.rds.amazonaws.com   # yours
export RDS_MASTER_USER=postgres
read -rsp "RDS master password: " RDS_MASTER_PASSWORD; echo; export RDS_MASTER_PASSWORD
export HRM_APP_PASSWORD=$(openssl rand -hex 24)

# hrm_app owns the schema; the API itself runs as the least-privilege hrm_runtime role (created by migrate below)
PGPASSWORD="$RDS_MASTER_PASSWORD" psql "host=$RDS_ENDPOINT user=$RDS_MASTER_USER dbname=postgres sslmode=verify-full sslrootcert=deploy/single-server/certs/rds-global-bundle.pem" -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE hrm_app LOGIN PASSWORD '$HRM_APP_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT hrm_app TO $RDS_MASTER_USER;
CREATE DATABASE hrm OWNER hrm_app;
SQL

FILES_S3_BUCKET=clanchief-files-prod bash deploy/single-server/generate-env.sh
```

`generate-env.sh` writes `.env.production` with every secret already generated, including the encryption keys,
sign-in key, Redis password and runtime database password.

**Copy the whole file into your password manager straight away.** If the encryption keys are lost, the encrypted
employee data (PAN, bank details, Aadhaar) cannot be recovered. Never run the script again on a live server; it
refuses to overwrite an existing file.

Now paste the Cloudflare origin certificate from Step 1:

```bash
nano deploy/single-server/certs/origin.pem   # paste the certificate
nano deploy/single-server/certs/origin.key   # paste the private key
chmod 600 deploy/single-server/certs/origin.key
```

Everything in `certs/` and `.env.production` is git-ignored.

## Step 6 — S3 bucket and email (15 min)

1. **S3 → Create bucket** `clanchief-files-prod` in ap-south-1. Leave *Block all public access* on.
   Then go back to Step 4.1 and add the inline policy to the `clanchief-server` role.
2. Lock the bucket down (encryption, TLS-only, versioning). Run this from your laptop with an admin AWS profile,
   from the backend checkout:
   ```bash
   FILES_S3_BUCKET=clanchief-files-prod FILES_S3_REGION=ap-south-1 FILES_S3_PREFIX=prod AWS_PROFILE=admin node scripts/s3-bucket-setup.mjs
   ```
   You can also apply the same settings in the console: default encryption SSE-S3, versioning on, and a bucket
   policy that denies non-TLS requests.
3. **SES → Identities → Create identity → Domain** `clanchief.com`, with Easy DKIM.
   - Add the 3 CNAME records in Cloudflare as **DNS only (grey cloud)**.
   - Add a DMARC record: `_dmarc` TXT `v=DMARC1; p=quarantine; adkim=s; aspf=s`.
4. **SES → Account dashboard → Request production access**. Use case: transactional HR email (invites, password
   resets, payslip notices). Until AWS approves it, mail only reaches addresses you have verified in SES.
5. **SES → SMTP settings → Create SMTP credentials**. Put the username and password in `.env.production`
   (`SMTP_USER`, `SMTP_PASS`).

## Step 7 — Build, migrate, start (20–30 min the first time)

```bash
cd /opt/clanchief/backend
C="docker compose -f docker-compose.prod.yml -f deploy/single-server/docker-compose.single.yml --env-file .env.production"
$C build                      # builds api, worker, migrate and web on the server (first build ~15 min)
$C run --rm migrate           # creates all tables and the hrm_runtime role
```

**Then edit `.env.production` and delete the `DATABASE_ADMIN_URL=` and `RUNTIME_DB_PASSWORD=` lines.** The app
never needs the master password again.

```bash
$C up -d
$C ps                         # api, worker, web, redis, caddy → running / healthy
```

**Cloudflare → DNS → Add record.** Create all three as type A, pointing at the Elastic IP, with Proxy on (orange cloud):

| Name | Content | Proxy |
|---|---|---|
| `app` | Elastic IP | Proxied |
| `api` | Elastic IP | Proxied |
| `*` | Elastic IP | Proxied |

Leave `@` and `www` pointing at the website. Because those records exist by name, the wildcard never takes them over.

Check: `https://api.clanchief.com/api/v2/health/ready` returns `ready`, and `https://app.clanchief.com/login`
shows the sign-in page.

## Step 8 — First super admin (5 min)

```bash
$C run --rm -e NODE_ENV=production -e APP_BASE_URL=https://app.clanchief.com migrate \
  node scripts/bootstrap-production.mjs --email you@yourcompany.com --name "Your Name"
```

It prints a one-time activation link, valid for 72 hours. Open it, set a password and enrol two-step
verification. Then go to `https://app.clanchief.com/admin/login` to add your first brand.

## Adding a brand (no DNS work, ever)

In the super admin console, choose **Add brand** and set the subdomain, for example `abc`. The brand is live at
`https://abc.clanchief.com` straight away. The `*` record, the wildcard certificate and Caddy already cover it.
A few names, such as `www`, `app`, `api`, `admin` and `mail`, are reserved and can't be used as a brand slug.

## Updating to a new version

```bash
cd /opt/clanchief && git -C backend pull && git -C frontend pull
cd backend && $C build && $C run --rm migrate && $C up -d
docker image prune -f
```

## Backups and checks

- RDS takes a snapshot every day (kept 7 days). Before a risky update, also take a manual snapshot:
  **RDS → clanchief-db → Actions → Take snapshot**.
- `.env.production` and the origin certificate live only on the server and in your password manager. Keep the copy current.
- Logs: `$C logs -f api` (or `worker`, `web`, `caddy`).
- If the server is replaced, nothing is lost: the database is in RDS and the files are in S3. Rebuild from this
  guide and put back the same `.env.production`.

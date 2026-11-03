import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { AuthIdentity } from "../auth/auth.types";
import { RuntimeConfig } from "../config/runtime-config";
import { DatabaseService } from "../database/database.service";
import { JobRegistry } from "../jobs/job-registry";
import { SecurityService, type PostureCheck } from "../security/security.service";
import { CHECK_TITLES, CONTROLS, FRAMEWORKS, type Control, type Framework } from "./catalog";
import type { AddEvidenceDto, PublishPolicyDto, StartReviewDto, UpdateControlDto } from "./compliance.dto";

type Check = PostureCheck & { data?: Record<string, unknown> };
type Evidence = { id: string; checkId: string | null; title: string; detail: string | null; result: string; link: string | null; sha256: string; collectedAt: string; collectedBy: string | null; data?: unknown };
export type ControlStatus = "passing" | "attention" | "failing" | "in_progress" | "needs_evidence" | "not_applicable";

const sha256 = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const DAY = 86_400_000;
const SENSITIVE = "^(pan|pan_number|aadhaar|aadhaar_number|uan|bank_account|bank_account_number|account_number)$";
/** Manual evidence counts for this long; auditors expect it refreshed at least yearly. */
const MANUAL_EVIDENCE_DAYS = 365;

/**
 * Compliance Center: maps live checks to ISO 27001 / SOC 2 controls, keeps immutable evidence, runs user access
 * reviews and policy acknowledgements, and produces an auditor pack. All of it is platform scope (super admins).
 */
@Injectable()
export class ComplianceService implements OnModuleInit {
  constructor(private readonly database: DatabaseService, private readonly security: SecurityService,
              private readonly jobs: JobRegistry, private readonly config: RuntimeConfig) {}

  onModuleInit() {
    this.jobs.register("compliance.collect_evidence", () => this.collect(null),
      { cron: "30 2 * * *", description: "Runs every ISO 27001 / SOC 2 check and stores the results as immutable evidence." });
  }

  private async requirePlatform(identity: AuthIdentity) {
    const ok = identity.userId && (await this.database.systemQuery(`SELECT 1 FROM platform_admins WHERE user_id=$1`, [identity.userId])).rowCount;
    if (!ok) throw new ForbiddenException("Only platform administrators can manage compliance.");
  }
  private framework(value: string): Framework {
    if (value !== "iso27001" && value !== "soc2") throw new NotFoundException("Unknown framework.");
    return value;
  }
  private control(framework: Framework, id: string): Control {
    const control = CONTROLS[framework].find((item) => item.id === id);
    if (!control) throw new NotFoundException("Unknown control.");
    return control;
  }

  // ---------- checks ----------

  /** Baseline configuration checks plus compliance-specific ones computed from the database. */
  async runChecks(): Promise<Check[]> {
    const checks: Check[] = await this.security.baselineChecks();
    const prod = this.config.nodeEnv === "production";
    const q = <T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []) => this.database.systemQuery<T>(sql, params).then((result) => result.rows);

    const chain = await this.verifyAuditChain();
    const broken = chain.brands.filter((brand) => brand.tampered || brand.broken || brand.gaps);
    checks.push(broken.length
      ? { id: "audit-chain", title: CHECK_TITLES["audit-chain"], status: "fail", detail: `Tampering detected in ${broken.map((brand) => brand.name).join(", ")}.`, fix: "Investigate immediately: compare with backups and treat as a security incident.", data: chain }
      : { id: "audit-chain", title: CHECK_TITLES["audit-chain"], status: "pass", detail: `${chain.total} audit entries across ${chain.brands.length} brands verified — every hash link is intact.`, data: chain });

    const [review] = await q(`SELECT max(closed_at) AS "lastClosed", (SELECT min(due_at) FROM access_reviews WHERE status='OPEN') AS "openDue" FROM access_reviews WHERE status='CLOSED'`);
    const lastClosed = review.lastClosed ? new Date(review.lastClosed) : null;
    const ageDays = lastClosed ? Math.floor((Date.now() - lastClosed.getTime()) / DAY) : null;
    checks.push(ageDays !== null && ageDays <= 100
      ? { id: "access-review", title: CHECK_TITLES["access-review"], status: "pass", detail: `Last access review closed ${ageDays} day(s) ago.`, data: review }
      : { id: "access-review", title: CHECK_TITLES["access-review"], status: ageDays === null && !review.openDue ? "fail" : "warn",
          detail: ageDays === null ? (review.openDue ? `A review is open (due ${String(review.openDue).slice(0, 10)}); none completed yet.` : "No user access review has been completed.") : `Last review closed ${ageDays} days ago (due every quarter).`,
          fix: "Start an access review in Compliance → Access reviews and decide every item.", data: review });

    const privileged = await q(`SELECT coalesce(o.display_name,o.name) AS brand, m.role, count(*)::int AS count FROM organization_memberships m
        JOIN organizations o ON o.id=m.organization_id WHERE m.status='ACTIVE' AND m.role IN ('OWNER','HR_ADMIN','PAYROLL_ADMIN') GROUP BY 1,2 ORDER BY 1,2`);
    const [{ admins }] = await q(`SELECT count(*)::int AS admins FROM platform_admins`);
    checks.push({ id: "privileged-access", title: CHECK_TITLES["privileged-access"], status: admins > 5 ? "warn" : "pass",
      detail: `${admins} platform administrator(s); ${privileged.reduce((sum, row) => sum + row.count, 0)} brand owner/HR/payroll admin account(s).`,
      fix: admins > 5 ? "Keep platform administrators to the few people who need it." : undefined, data: { platformAdmins: admins, byBrand: privileged } });

    const orphaned = await q(`SELECT coalesce(o.display_name,o.name) AS brand, u.email, m.role, coalesce(e.status,'NO_EMPLOYEE_RECORD') AS "employeeStatus"
        FROM organization_memberships m JOIN users u ON u.id=m.user_id JOIN organizations o ON o.id=m.organization_id
        LEFT JOIN employees e ON e.organization_id=m.organization_id AND e.user_id=m.user_id
       WHERE m.status='ACTIVE' AND (e.id IS NULL OR e.status <> 'ACTIVE') LIMIT 200`);
    const [{ inactive }] = await q(`SELECT count(DISTINCT m.user_id)::int AS inactive FROM organization_memberships m JOIN users u ON u.id=m.user_id
       WHERE m.status='ACTIVE' AND u.last_sign_in_at < now() - interval '90 days'`);
    checks.push(orphaned.length
      ? { id: "orphaned-access", title: CHECK_TITLES["orphaned-access"], status: "fail", detail: `${orphaned.length} active account(s) belong to people who have left or have no employee record.`, fix: "Revoke them in an access review or complete the exit process.", data: { orphaned, inactive90d: inactive } }
      : { id: "orphaned-access", title: CHECK_TITLES["orphaned-access"], status: inactive ? "warn" : "pass",
          detail: inactive ? `${inactive} account(s) haven't signed in for 90+ days.` : "Every active account belongs to an active employee.", fix: inactive ? "Review dormant accounts in the next access review." : undefined, data: { orphaned, inactive90d: inactive } });

    const policies = await this.policyStats();
    const lowest = policies.reduce((min, policy) => Math.min(min, policy.percent), 100);
    checks.push({ id: "policy-acks", title: CHECK_TITLES["policy-acks"], status: !policies.length ? "fail" : lowest >= 95 ? "pass" : lowest >= 50 ? "warn" : "fail",
      detail: policies.length ? policies.map((policy) => `${policy.title} v${policy.version}: ${policy.acknowledged}/${policy.audience} (${policy.percent}%)`).join(" · ") : "No published policies.",
      fix: lowest >= 95 ? undefined : "Employees are asked to accept policies when they open the app; remind those who haven't.", data: { policies } });

    const [events] = await q(`SELECT coalesce(sum(count),0)::int AS denied, count(DISTINCT client_ip)::int AS sources FROM security_events WHERE last_seen > now() - interval '7 days'`);
    checks.push({ id: "security-monitoring", title: CHECK_TITLES["security-monitoring"], status: "pass",
      detail: `Monitoring active: ${events.denied} denied request(s) from ${events.sources} source(s) in the last 7 days, visible in the Security Center.`, data: events });

    const migrations = await q(`SELECT version, applied_at AS "appliedAt" FROM schema_migrations ORDER BY version`);
    checks.push({ id: "change-log", title: CHECK_TITLES["change-log"], status: "pass",
      detail: `${migrations.length} versioned database migrations; latest #${migrations.at(-1)?.version ?? "—"} applied ${String(migrations.at(-1)?.appliedAt ?? "").slice(0, 10)}.`, data: { migrations } });

    const runs = await q(`SELECT job_name AS job, max(finished_at) FILTER (WHERE status='SUCCEEDED') AS "lastSuccess", count(*) FILTER (WHERE status='FAILED' AND finished_at > now() - interval '7 days')::int AS "recentFailures"
        FROM job_runs WHERE job_name LIKE '%retention%' GROUP BY 1`);
    const fresh = runs.some((run) => run.lastSuccess && Date.now() - new Date(run.lastSuccess).getTime() < 3 * DAY);
    checks.push({ id: "data-retention", title: CHECK_TITLES["data-retention"], status: fresh ? "pass" : "warn",
      detail: fresh ? "Retention jobs ran successfully in the last 3 days (punch selfies are deleted after the configured period)." : "No successful retention run in the last 3 days.",
      fix: fresh ? undefined : "Keep the jobs worker running (npm run jobs:dev / a worker container) so retention jobs execute nightly.", data: { runs } });

    const columns = (await q(`SELECT table_name||'.'||column_name AS name FROM information_schema.columns WHERE table_schema='public' AND column_name ~ $1 AND data_type='text' ORDER BY 1`, [SENSITIVE])).map((row) => row.name);
    checks.push(columns.length
      ? { id: "sensitive-fields", title: CHECK_TITLES["sensitive-fields"], status: prod ? "fail" : "warn", detail: `Stored without field-level encryption: ${columns.join(", ")}. Disk encryption still applies.`, fix: "Encrypt PAN, UAN and bank account numbers with envelope encryption (KMS key) and show only masked values.", data: { columns } }
      : { id: "sensitive-fields", title: CHECK_TITLES["sensitive-fields"], status: "pass", detail: "Statutory and bank identifiers are encrypted at field level." });
    return checks;
  }

  /** Recomputes every audit row hash and link. Deleting old rows through the retention path only moves the chain start. */
  async verifyAuditChain() {
    const brands = (await this.database.systemQuery<{ id: string; name: string; total: number; tampered: number; broken: number; gaps: number; unchained: number; lastEntry: string | null }>(
      `SELECT o.id, coalesce(o.display_name,o.name) AS name, count(a.*)::int AS total,
              count(*) FILTER (WHERE a.row_hash IS DISTINCT FROM audit_row_digest(a.prev_hash, a.chain_seq, a.organization_id, a.actor_user_id, a.action,
                a.entity_type, a.entity_id, a.before_data, a.after_data, a.created_at))::int AS tampered,
              count(*) FILTER (WHERE a.prev_row IS NOT NULL AND a.prev_hash IS DISTINCT FROM a.prev_row)::int AS broken,
              count(*) FILTER (WHERE a.prev_seq IS NOT NULL AND a.chain_seq <> a.prev_seq + 1)::int AS gaps,
              count(*) FILTER (WHERE a.chain_seq IS NULL)::int AS unchained, max(a.created_at) AS "lastEntry"
         FROM (SELECT x.*, lag(row_hash) OVER w AS prev_row, lag(chain_seq) OVER w AS prev_seq FROM audit_log x
                WINDOW w AS (PARTITION BY organization_id ORDER BY chain_seq)) a
         JOIN organizations o ON o.id=a.organization_id GROUP BY o.id, 2 ORDER BY 2`)).rows;
    return { verifiedAt: new Date().toISOString(), total: brands.reduce((sum, brand) => sum + brand.total, 0), intact: brands.every((brand) => !brand.tampered && !brand.broken && !brand.gaps && !brand.unchained), brands };
  }

  /** Runs all checks and stores each result as an immutable evidence record. */
  async collect(userId: string | null) {
    const checks = await this.runChecks();
    const collectionId = randomUUID();
    for (const check of checks) {
      const content = { id: check.id, status: check.status, detail: check.detail, fix: check.fix ?? null, data: check.data ?? null };
      await this.database.systemQuery(
        `INSERT INTO compliance_evidence(source, check_id, title, detail, result, data, sha256, collection_id, collected_by) VALUES('automated',$1,$2,$3,$4,$5,$6,$7,$8)`,
        [check.id, check.title, check.detail, check.status, JSON.stringify(content), sha256(content), collectionId, userId]);
    }
    return { collectionId, collectedAt: new Date().toISOString(), checks: checks.length, failing: checks.filter((check) => check.status === "fail").length };
  }

  async collectNow(identity: AuthIdentity) { await this.requirePlatform(identity); return this.collect(identity.userId); }

  // ---------- controls ----------

  private async latestAutomated(): Promise<Map<string, Evidence>> {
    const rows = (await this.database.systemQuery<Evidence>(`SELECT DISTINCT ON (check_id) id, check_id AS "checkId", title, detail, result, link, sha256, collected_at AS "collectedAt", collected_by AS "collectedBy"
        FROM compliance_evidence WHERE source='automated' ORDER BY check_id, collected_at DESC`)).rows;
    return new Map(rows.map((row) => [row.checkId!, row]));
  }

  private statusOf(control: Control, latest: Map<string, Evidence>, state: { status: string } | undefined, manualCount: number): ControlStatus {
    if (state?.status === "not_applicable") return "not_applicable";
    const automated = control.checks.map((id) => latest.get(id)).filter((row): row is Evidence => !!row && row.result !== "manual");
    const needsManual = control.checks.length === 0 || control.checks.some((id) => latest.get(id)?.result === "manual" || !latest.get(id));
    if (automated.some((row) => row.result === "fail")) return "failing";
    if (automated.some((row) => row.result === "warn")) return "attention";
    if (!needsManual) return "passing";
    if (state?.status === "implemented" && manualCount > 0) return "passing";
    return state?.status === "in_progress" || state?.status === "implemented" ? "in_progress" : "needs_evidence";
  }

  async overview(identity: AuthIdentity, frameworkValue: string) {
    await this.requirePlatform(identity);
    const framework = this.framework(frameworkValue);
    let latest = await this.latestAutomated();
    if (!latest.size) { await this.collect(identity.userId); latest = await this.latestAutomated(); }
    const states = new Map((await this.database.systemQuery<{ id: string; status: string; owner: string | null; notes: string | null; version: number; updatedAt: string }>(`SELECT control_id AS id, status, owner, notes, version, updated_at AS "updatedAt" FROM compliance_control_state WHERE framework=$1`, [framework])).rows.map((row) => [row.id, row]));
    const manual = new Map((await this.database.systemQuery(`SELECT control_id AS id, count(*)::int AS count, max(collected_at) AS last FROM compliance_evidence
        WHERE source='manual' AND framework=$1 AND collected_at > now() - make_interval(days => $2) GROUP BY 1`, [framework, MANUAL_EVIDENCE_DAYS])).rows.map((row) => [row.id, row]));
    const controls = CONTROLS[framework].map((control) => {
      const state = states.get(control.id);
      return {
        ...control, status: this.statusOf(control, latest, state, manual.get(control.id)?.count || 0),
        state: state ? { status: state.status, owner: state.owner, notes: state.notes, version: state.version, updatedAt: state.updatedAt } : { status: "not_started", owner: null, notes: null, version: 0, updatedAt: null },
        manualEvidence: manual.get(control.id)?.count || 0,
        checkResults: control.checks.map((id) => ({ id, title: CHECK_TITLES[id] || id, result: latest.get(id)?.result || "pending", detail: latest.get(id)?.detail || null })),
      };
    });
    const counts = controls.reduce((sum, control) => ({ ...sum, [control.status]: (sum[control.status] || 0) + 1 }), {} as Record<string, number>);
    const applicable = controls.filter((control) => control.status !== "not_applicable").length;
    const readiness = Math.round(((counts.passing || 0) / Math.max(applicable, 1)) * 100);
    const lastCollected = [...latest.values()].reduce((max, row) => (row.collectedAt > max ? row.collectedAt : max), "");
    return { framework, ...FRAMEWORKS[framework], readiness, counts, total: controls.length, lastCollected, controls,
      checks: [...latest.values()].map((row) => ({ id: row.checkId, title: row.title, result: row.result, detail: row.detail, collectedAt: row.collectedAt, sha256: row.sha256 })) };
  }

  async controlDetail(identity: AuthIdentity, frameworkValue: string, id: string) {
    await this.requirePlatform(identity);
    const framework = this.framework(frameworkValue);
    const control = this.control(framework, id);
    const [automated, manual] = await Promise.all([
      control.checks.length ? this.database.systemQuery(`SELECT e.id, e.check_id AS "checkId", e.title, e.detail, e.result, e.sha256, e.collected_at AS "collectedAt"
          FROM (SELECT *, row_number() OVER (PARTITION BY check_id ORDER BY collected_at DESC) AS n FROM compliance_evidence WHERE source='automated' AND check_id = ANY($1)) e
         WHERE e.n <= 5 ORDER BY e.check_id, e.collected_at DESC`, [control.checks]).then((result) => result.rows) : Promise.resolve([]),
      this.database.systemQuery(`SELECT e.id, e.title, e.detail, e.link, e.sha256, e.collected_at AS "collectedAt", u.full_name AS "collectedBy"
          FROM compliance_evidence e LEFT JOIN users u ON u.id=e.collected_by WHERE e.source='manual' AND e.framework=$1 AND e.control_id=$2 ORDER BY e.collected_at DESC`, [framework, id]).then((result) => result.rows),
    ]);
    return { control, automated, manual };
  }

  async updateControl(identity: AuthIdentity, frameworkValue: string, id: string, input: UpdateControlDto) {
    await this.requirePlatform(identity);
    const framework = this.framework(frameworkValue);
    this.control(framework, id);
    const row = (await this.database.systemQuery(
      `INSERT INTO compliance_control_state(framework, control_id, status, owner, notes, updated_by) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (framework, control_id) DO UPDATE SET status=excluded.status, owner=excluded.owner, notes=excluded.notes, updated_by=excluded.updated_by,
         updated_at=now(), version=compliance_control_state.version+1
       WHERE compliance_control_state.version = $7 RETURNING version`,
      [framework, id, input.status, input.owner?.trim() || null, input.notes?.trim() || null, identity.userId, input.version])).rows[0];
    if (!row) throw new ConflictException("Someone else updated this control. Reload and try again.");
    return { version: row.version };
  }

  async addEvidence(identity: AuthIdentity, frameworkValue: string, id: string, input: AddEvidenceDto) {
    await this.requirePlatform(identity);
    const framework = this.framework(frameworkValue);
    this.control(framework, id);
    if (input.link && !/^https:\/\//i.test(input.link)) throw new BadRequestException("Evidence links must start with https://");
    const content = { framework, control: id, title: input.title.trim(), detail: input.detail?.trim() || null, link: input.link || null, by: identity.userId, at: new Date().toISOString() };
    const row = (await this.database.systemQuery(
      `INSERT INTO compliance_evidence(source, framework, control_id, title, detail, result, link, data, sha256, collected_by) VALUES('manual',$1,$2,$3,$4,'info',$5,$6,$7,$8) RETURNING id, sha256`,
      [framework, id, content.title, content.detail, content.link, JSON.stringify(content), sha256(content), identity.userId])).rows[0];
    return row;
  }

  async auditChain(identity: AuthIdentity) { await this.requirePlatform(identity); return this.verifyAuditChain(); }

  // ---------- access reviews ----------

  async reviews(identity: AuthIdentity) {
    await this.requirePlatform(identity);
    return { items: (await this.database.systemQuery(`SELECT r.id, r.title, r.status, r.due_at AS "dueAt", r.created_at AS "createdAt", r.closed_at AS "closedAt", r.summary,
        cu.full_name AS "createdBy", count(i.*)::int AS total, count(i.decision)::int AS decided, count(*) FILTER (WHERE i.decision='REVOKE')::int AS revoked,
        count(*) FILTER (WHERE cardinality(i.flags) > 0 AND NOT ('privileged' = ALL(i.flags)))::int AS flagged
       FROM access_reviews r JOIN users cu ON cu.id=r.created_by LEFT JOIN access_review_items i ON i.review_id=r.id
      GROUP BY r.id, cu.full_name ORDER BY r.created_at DESC`)).rows };
  }

  async startReview(identity: AuthIdentity, input: StartReviewDto) {
    await this.requirePlatform(identity);
    return this.database.platformTransaction(async (client) => {
      if ((await client.query(`SELECT 1 FROM access_reviews WHERE status='OPEN' FOR UPDATE`)).rowCount) throw new ConflictException("Finish the open access review before starting another.");
      const due = input.dueAt || new Date(Date.now() + 14 * DAY).toISOString().slice(0, 10);
      const quarter = `Q${Math.floor(new Date().getMonth() / 3) + 1} ${new Date().getFullYear()}`;
      const review = (await client.query(`INSERT INTO access_reviews(title, due_at, created_by) VALUES($1,$2,$3) RETURNING id`, [input.title?.trim() || `User access review — ${quarter}`, due, identity.userId])).rows[0];
      await client.query(
        `INSERT INTO access_review_items(review_id, kind, organization_id, user_id, role, employee_status, last_sign_in_at, flags)
         SELECT $1, 'membership', m.organization_id, m.user_id, m.role, coalesce(e.status,'NO_EMPLOYEE_RECORD'), u.last_sign_in_at,
                array_remove(ARRAY[
                  CASE WHEN m.role IN ('OWNER','HR_ADMIN','PAYROLL_ADMIN') THEN 'privileged' END,
                  CASE WHEN e.id IS NULL OR e.status <> 'ACTIVE' THEN 'employee_inactive' END,
                  CASE WHEN u.last_sign_in_at < now() - interval '90 days' THEN 'inactive_90d' END,
                  CASE WHEN u.last_sign_in_at IS NULL THEN 'never_signed_in' END], NULL)
           FROM organization_memberships m JOIN users u ON u.id=m.user_id JOIN organizations o ON o.id=m.organization_id AND o.status='ACTIVE'
           LEFT JOIN employees e ON e.organization_id=m.organization_id AND e.user_id=m.user_id
          WHERE m.status='ACTIVE'`, [review.id]);
      await client.query(
        `INSERT INTO access_review_items(review_id, kind, user_id, role, last_sign_in_at, flags)
         SELECT $1, 'platform_admin', p.user_id, 'PLATFORM_ADMIN', u.last_sign_in_at,
                array_remove(ARRAY['privileged', CASE WHEN u.last_sign_in_at < now() - interval '90 days' THEN 'inactive_90d' END], NULL)
           FROM platform_admins p JOIN users u ON u.id=p.user_id`, [review.id]);
      return { id: review.id };
    });
  }

  async review(identity: AuthIdentity, id: string) {
    await this.requirePlatform(identity);
    const review = (await this.database.systemQuery(`SELECT id, title, status, due_at AS "dueAt", created_at AS "createdAt", closed_at AS "closedAt", summary FROM access_reviews WHERE id=$1`, [id])).rows[0];
    if (!review) throw new NotFoundException("Access review not found.");
    const items = (await this.database.systemQuery(`SELECT i.id, i.kind, i.role, i.employee_status AS "employeeStatus", i.last_sign_in_at AS "lastSignInAt", i.flags, i.decision, i.note,
        i.decided_at AS "decidedAt", i.applied_at AS "appliedAt", i.user_id = $2 AS "isSelf",
        u.full_name AS "fullName", u.email, coalesce(o.display_name, o.name, 'Platform') AS brand, d.full_name AS "decidedBy"
       FROM access_review_items i JOIN users u ON u.id=i.user_id LEFT JOIN organizations o ON o.id=i.organization_id LEFT JOIN users d ON d.id=i.decided_by
      WHERE i.review_id=$1 ORDER BY (i.kind='platform_admin') DESC, brand, cardinality(i.flags) DESC, u.full_name`, [id, identity.userId])).rows;
    return { ...review, items };
  }

  async decide(identity: AuthIdentity, itemId: string, decision: "KEEP" | "REVOKE", note?: string) {
    await this.requirePlatform(identity);
    const item = (await this.database.systemQuery(`SELECT i.user_id, r.status FROM access_review_items i JOIN access_reviews r ON r.id=i.review_id WHERE i.id=$1`, [itemId])).rows[0];
    if (!item) throw new NotFoundException("Review item not found.");
    if (item.status !== "OPEN") throw new ConflictException("This review is closed.");
    // Segregation of duties: nobody certifies their own access.
    if (item.user_id === identity.userId) throw new ForbiddenException("You can't review your own access — another administrator must decide this item.");
    if (decision === "REVOKE" && !note?.trim()) throw new BadRequestException("Add a short reason when revoking access.");
    await this.database.systemQuery(`UPDATE access_review_items SET decision=$2, note=$3, decided_by=$4, decided_at=now() WHERE id=$1`, [itemId, decision, note?.trim() || null, identity.userId]);
    return { ok: true };
  }

  /** Closes a fully decided review and applies every REVOKE (brand membership suspended / platform admin removed). */
  async closeReview(identity: AuthIdentity, id: string) {
    await this.requirePlatform(identity);
    return this.database.platformTransaction(async (client) => {
      const review = (await client.query(`SELECT status FROM access_reviews WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!review) throw new NotFoundException("Access review not found.");
      if (review.status !== "OPEN") throw new ConflictException("This review is already closed.");
      const pending = (await client.query(`SELECT count(*)::int AS n FROM access_review_items WHERE review_id=$1 AND decision IS NULL`, [id])).rows[0].n;
      if (pending) throw new BadRequestException(`${pending} item(s) still need a decision.`);
      const revokes = (await client.query(`SELECT id, kind, organization_id, user_id FROM access_review_items WHERE review_id=$1 AND decision='REVOKE'`, [id])).rows;
      const admins = (await client.query(`SELECT count(*)::int AS n FROM platform_admins`)).rows[0].n;
      if (admins - revokes.filter((row) => row.kind === "platform_admin").length < 1) throw new BadRequestException("At least one platform administrator must keep access.");
      for (const row of revokes) {
        if (row.kind === "membership") await client.query(`UPDATE organization_memberships SET status='REVOKED' WHERE organization_id=$1 AND user_id=$2`, [row.organization_id, row.user_id]);
        else await client.query(`DELETE FROM platform_admins WHERE user_id=$1`, [row.user_id]);
        await client.query(`UPDATE access_review_items SET applied_at=now() WHERE id=$1`, [row.id]);
      }
      const [summary] = (await client.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE decision='KEEP')::int AS kept, count(*) FILTER (WHERE decision='REVOKE')::int AS revoked FROM access_review_items WHERE review_id=$1`, [id])).rows;
      await client.query(`UPDATE access_reviews SET status='CLOSED', closed_by=$2, closed_at=now(), summary=$3 WHERE id=$1`, [id, identity.userId, JSON.stringify(summary)]);
      const content = { review: id, ...summary, closedBy: identity.userId, closedAt: new Date().toISOString() };
      await client.query(`INSERT INTO compliance_evidence(source, framework, control_id, title, detail, result, data, sha256, collected_by) VALUES
          ('manual','iso27001','A.5.18',$1,$2,'info',$3,$4,$5), ('manual','soc2','CC6.3',$1,$2,'info',$3,$4,$5)`,
        ["User access review completed", `${summary.total} accounts reviewed, ${summary.kept} kept, ${summary.revoked} revoked.`, JSON.stringify(content), sha256(content), identity.userId]);
      return summary;
    });
  }

  // ---------- policies ----------

  private async policyStats() {
    return (await this.database.systemQuery<{ id: string; key: string; version: number; title: string; summary: string; publishedAt: string; audience: number; acknowledged: number; percent: number }>(
      `WITH audience AS (SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id AND o.status='ACTIVE' WHERE m.status='ACTIVE')
       SELECT p.id, p.key, p.version, p.title, p.summary, p.published_at AS "publishedAt",
              (SELECT count(*)::int FROM audience) AS audience,
              (SELECT count(*)::int FROM policy_acknowledgements a JOIN audience x ON x.user_id=a.user_id WHERE a.policy_id=p.id) AS acknowledged
         FROM compliance_policies p WHERE p.status='PUBLISHED' ORDER BY p.title`)).rows
      .map((row) => ({ ...row, percent: row.audience ? Math.floor((row.acknowledged / row.audience) * 100) : 100 }));
  }

  async policies(identity: AuthIdentity) {
    await this.requirePlatform(identity);
    const history = (await this.database.systemQuery(`SELECT key, version, status, published_at AS "publishedAt" FROM compliance_policies ORDER BY key, version DESC`)).rows;
    const bodies = new Map((await this.database.systemQuery(`SELECT id, body FROM compliance_policies WHERE status='PUBLISHED'`)).rows.map((row) => [row.id, row.body]));
    return { items: (await this.policyStats()).map((policy) => ({ ...policy, body: bodies.get(policy.id), history: history.filter((row) => row.key === policy.key) })) };
  }

  /** Publishes a new version; everyone must accept it again. */
  async publishPolicy(identity: AuthIdentity, input: PublishPolicyDto) {
    await this.requirePlatform(identity);
    const key = input.key || input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    if (!key) throw new BadRequestException("Give the policy a title.");
    return this.database.platformTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('policy:' || $1))`, [key]);
      const version = (await client.query(`SELECT coalesce(max(version),0)+1 AS v FROM compliance_policies WHERE key=$1`, [key])).rows[0].v;
      await client.query(`UPDATE compliance_policies SET status='RETIRED' WHERE key=$1 AND status='PUBLISHED'`, [key]);
      const row = (await client.query(`INSERT INTO compliance_policies(key, version, title, summary, body, published_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id, version`,
        [key, version, input.title.trim(), input.summary.trim(), input.body.trim(), identity.userId])).rows[0];
      return { id: row.id, key, version: row.version };
    });
  }

  /** Policies the signed-in person hasn't accepted yet (current versions only). */
  async pending(identity: AuthIdentity) {
    if (!identity.userId) return { items: [] };
    return { items: (await this.database.systemQuery(`SELECT p.id, p.title, p.summary, p.body, p.version, p.published_at AS "publishedAt" FROM compliance_policies p
        WHERE p.status='PUBLISHED' AND NOT EXISTS (SELECT 1 FROM policy_acknowledgements a WHERE a.policy_id=p.id AND a.user_id=$1) ORDER BY p.title`, [identity.userId])).rows };
  }

  async acknowledge(identity: AuthIdentity, policyId: string, ip: string) {
    if (!identity.userId) throw new ForbiddenException("Sign in to accept policies.");
    const policy = (await this.database.systemQuery(`SELECT 1 FROM compliance_policies WHERE id=$1 AND status='PUBLISHED'`, [policyId])).rowCount;
    if (!policy) throw new NotFoundException("This policy has been replaced. Reload to see the current version.");
    await this.database.systemQuery(`INSERT INTO policy_acknowledgements(policy_id, user_id, client_ip) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [policyId, identity.userId, ip]);
    return { ok: true };
  }

  // ---------- auditor pack ----------

  /** A self-describing JSON pack for the auditor: controls, latest evidence, reviews, policies and chain verification, with a digest. */
  async exportPack(identity: AuthIdentity, frameworkValue: string) {
    const overview = await this.overview(identity, frameworkValue);
    const framework = overview.framework;
    const [manual, reviews, policies, chain, admin] = await Promise.all([
      this.database.systemQuery(`SELECT e.control_id AS "controlId", e.title, e.detail, e.link, e.sha256, e.collected_at AS "collectedAt", u.full_name AS "collectedBy"
          FROM compliance_evidence e LEFT JOIN users u ON u.id=e.collected_by WHERE e.source='manual' AND e.framework=$1 ORDER BY e.control_id, e.collected_at DESC`, [framework]).then((result) => result.rows),
      this.reviews(identity).then((result) => result.items),
      this.policyStats(),
      this.verifyAuditChain(),
      this.database.systemQuery(`SELECT full_name AS "fullName", email FROM users WHERE id=$1`, [identity.userId]).then((result) => result.rows[0]),
    ]);
    const evidence = (await this.database.systemQuery(`SELECT DISTINCT ON (check_id) check_id AS "checkId", title, result, detail, data, sha256, collected_at AS "collectedAt"
        FROM compliance_evidence WHERE source='automated' ORDER BY check_id, collected_at DESC`)).rows;
    const body = {
      generatedAt: new Date().toISOString(), generatedBy: admin, product: "ClanChief", environment: this.config.nodeEnv,
      framework: { id: framework, name: overview.name }, readiness: overview.readiness, counts: overview.counts,
      controls: overview.controls.map((control) => ({ id: control.id, title: control.title, theme: control.theme, description: control.description, status: control.status,
        owner: control.state.owner, implementationNotes: control.state.notes, automatedChecks: control.checkResults, manualEvidence: manual.filter((row) => row.controlId === control.id) })),
      automatedEvidence: evidence, accessReviews: reviews, policies, auditTrail: chain,
      note: "Evidence records are immutable in the database; each carries the SHA-256 of its content. Verify this file with the manifest digest below.",
    };
    const json = JSON.stringify(body, null, 2);
    const digest = sha256(json);
    const file = JSON.stringify({ manifest: { sha256: digest, algorithm: "SHA-256 of the 'pack' field serialized with 2-space indentation" }, pack: body }, null, 2);
    return { name: `northstar-${framework}-auditor-pack-${body.generatedAt.slice(0, 10)}.json`, body: file, digest };
  }
}

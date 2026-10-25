import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { escapeHtml, emailButton, headerSafe } from "../jobs/email-layout";
import { JobRegistry } from "../jobs/job-registry";
import { TenantJobRunner } from "../jobs/tenant-runner";
import { MODULE_KEYS } from "../organizations/organizations.dto";
import {
  addDays, agingBucket, composeInvoice, daysBetween, effectivePepm, fiscalYear, formatDocumentNumber, formatInr, GST_STATES, gstinProblem, gstSplit,
  monthRange, paymentState, reminderFor, todayIst, type Adjustment, type SubscriptionTerms,
} from "./billing.engine";
import type { AccountDto, AdjustmentDto, AssignPlanDto, CreditNoteDto, GenerateDto, InvoiceQuery, PaymentDto, PlanDto, ReceivablesRunDto, SnapshotDto, UpdateSettingsDto } from "./billing.dto";
import { renderBillingPdf, type BillingDocument, type Party } from "./invoice-pdf";
import { nextDocumentNumber } from "./numbering";
export { nextDocumentNumber };

type Row = Record<string, any>;
const paise = (rupees: number) => Math.round(rupees * 100);
/** Demo documents use their own series so the real invoice series stays gapless and starts at 0001. */
const DEMO_INVOICE_SERIES = "DM";
const DEMO_CREDIT_SERIES = "DC";

export const HEADCOUNT_RULES: Record<string, string> = {
  ACTIVE_WITH_LOGIN: "Employees with status ACTIVE, joined on or before the day, who hold an ACTIVE sign-in membership of the brand. Platform (operator) staff are never counted.",
  ALL_ACTIVE_EMPLOYEES: "Every employee record with status ACTIVE that joined on or before the day, with or without a login. Platform (operator) staff are never counted.",
};

const INVOICE_SELECT = `SELECT i.id, i.account_id AS "accountId", i.period_start::text AS "periodStart", i.period_end::text AS "periodEnd", i.status, i.number,
  i.fiscal_year AS "fiscalYear", i.issue_date::text AS "issueDate", i.due_date::text AS "dueDate", i.place_of_supply AS "placeOfSupply", i.supply_type AS "supplyType",
  i.sac_code AS "sacCode", i.gst_rate::float8 AS "gstRate", i.seller, i.buyer, i.subtotal_paise::float8 AS "subtotalPaise", i.cgst_paise::float8 AS "cgstPaise",
  i.sgst_paise::float8 AS "sgstPaise", i.igst_paise::float8 AS "igstPaise", i.total_paise::float8 AS "totalPaise", i.usage, i.warnings, i.is_demo AS "isDemo",
  i.generated_at AS "generatedAt", i.issued_at AS "issuedAt",
  coalesce((SELECT sum(p.amount_paise) FROM billing_payments p WHERE p.invoice_id=i.id AND p.status='RECORDED'),0)::float8 AS "paidPaise",
  coalesce((SELECT sum(c.total_paise) FROM billing_credit_notes c WHERE c.invoice_id=i.id),0)::float8 AS "creditedPaise",
  a.legal_name AS "accountName", a.kind AS "accountKind"
  FROM billing_invoices i JOIN billing_accounts a ON a.id=i.account_id`;

/**
 * SaaS billing for the operator. Everything here is platform data on the owner pool (systemQuery/platformTransaction):
 * the tenant runtime role has no privilege on billing_* (migration 037). Platform-admin routes check platform_admins;
 * the brand-owner routes check an ACTIVE OWNER membership in the database and filter every query by that brand's account.
 */
@Injectable()
export class BillingService implements OnModuleInit {
  constructor(private readonly database: DatabaseService, private readonly jobs: JobRegistry, private readonly runner: TenantJobRunner) {}

  onModuleInit() {
    this.jobs.register("billing.usage_snapshot", (payload) => this.snapshotUsage(null, payload as SnapshotDto),
      { cron: "50 23 * * *", tz: "Asia/Kolkata", timeoutMs: 5 * 60_000,
        description: "Nightly: records each brand's billable headcount for the day (the monthly bill uses the peak or average of these)." });
    this.jobs.register("billing.generate_invoices", (payload) => this.generateInvoices(null, { period: String(payload.period || previousPeriod()) }),
      { cron: "0 6 1 * *", tz: "Asia/Kolkata", timeoutMs: 10 * 60_000,
        description: "1st of every month: drafts last month's invoices for every billing account (a super admin reviews and issues them)." });
    this.jobs.register("billing.receivables", (payload) => this.runReceivables(null, payload as ReceivablesRunDto),
      { cron: "0 10 * * *", tz: "Asia/Kolkata", timeoutMs: 10 * 60_000,
        description: "Daily: payment reminders 3 days before, on, and 7 days after the due date; applies the overdue-suspension policy when it is switched on." });
  }

  // ==== access ============================================================================================================

  private q<T extends Row = Row>(sql: string, values: unknown[] = []) { return this.database.systemQuery<T>(sql, values).then((result) => result.rows); }

  async requirePlatform(identity: AuthIdentity) {
    const ok = identity.userId && (await this.database.systemQuery(`SELECT 1 FROM platform_admins WHERE user_id=$1`, [identity.userId])).rowCount;
    if (!ok) throw new ForbiddenException("Only platform administrators can manage billing.");
  }

  /**
   * Brand-owner scope. Billing tables are revoked from the tenant runtime role on purpose (tenant code must never be able
   * to read or alter invoices), so this read path deliberately uses the owner pool. It is safe because:
   *  1. the caller's base membership must be ACTIVE + OWNER for the brand in their session (checked in the database here,
   *     not from custom-role permissions), and
   *  2. every subsequent query is filtered by the account resolved from that organization_id (own BRAND account, or the
   *     GROUP account only when the caller is also an administrator of that group). Drafts are never shown.
   */
  private async ownerScope(identity: AuthIdentity) {
    if (!identity.organizationId || !identity.userId) throw new ForbiddenException("Open a brand to see its billing.");
    const owner = await this.q(`SELECT 1 FROM organization_memberships WHERE organization_id=$1 AND user_id=$2 AND status='ACTIVE' AND role='OWNER'`,
      [identity.organizationId, identity.userId]);
    if (!owner.length) throw new ForbiddenException("Only the brand owner can see the plan, usage and invoices.");
    const [org] = await this.q(`SELECT id, group_id AS "groupId", coalesce(display_name,name) AS name, status FROM organizations WHERE id=$1`, [identity.organizationId]);
    const [own] = await this.q(`SELECT * FROM billing_accounts WHERE organization_id=$1`, [org.id]);
    if (own) return { org, account: own as Row | null, viaGroup: null as null | { name: string; visible: boolean } };
    if (org.groupId) {
      const [group] = await this.q(`SELECT a.*, g.name AS group_name FROM billing_accounts a JOIN organization_groups g ON g.id=a.group_id WHERE a.group_id=$1`, [org.groupId]);
      if (group) {
        const admin = (await this.q(`SELECT 1 FROM group_admins WHERE group_id=$1 AND user_id=$2`, [org.groupId, identity.userId])).length > 0;
        return { org, account: admin ? group : null, viaGroup: { name: group.group_name as string, visible: admin } };
      }
    }
    return { org, account: null, viaGroup: null };
  }

  // ==== settings ==========================================================================================================

  async settings() {
    const [row] = await this.q(`SELECT *, gst_rate::float8 AS gst_rate FROM billing_settings WHERE id=1`);
    const env = process.env;
    const pick = (column: string, envKey: string, fallback = "") => ({ value: (row?.[column] || env[envKey] || fallback) as string, source: row?.[column] ? "settings" : env[envKey] ? "env" : fallback ? "default" : "missing" });
    const legalName = pick("legal_name", "OPERATOR_LEGAL_NAME"), gstin = pick("gstin", "OPERATOR_GSTIN"), address = pick("address", "OPERATOR_ADDRESS"), state = pick("state_code", "OPERATOR_STATE", "KA");
    return {
      legalName: legalName.value, tradeName: (row?.trade_name || env.OPERATOR_TRADE_NAME || "Northstar People") as string, gstin: gstin.value,
      pan: (row?.pan || env.OPERATOR_PAN || "") as string, address: address.value, stateCode: state.value, email: (row?.email || env.OPERATOR_EMAIL || "") as string,
      phone: (row?.phone || "") as string, sacCode: row.sac_code as string, gstRate: Number(row.gst_rate), invoicePrefix: row.invoice_prefix as string,
      creditNotePrefix: row.credit_note_prefix as string, paymentTermsDays: Number(row.payment_terms_days), bankDetails: (row.bank_details || env.OPERATOR_BANK_DETAILS || "") as string,
      headcountRule: row.headcount_rule as string, headcountRuleText: HEADCOUNT_RULES[row.headcount_rule],
      autoSuspendEnabled: !!row.auto_suspend_enabled, autoSuspendAfterDays: Number(row.auto_suspend_after_days), suspendWarningDays: Number(row.suspend_warning_days),
      sources: { legalName: legalName.source, gstin: gstin.source, address: address.source, stateCode: state.source },
      readiness: this.readiness({ legalName: legalName.value, gstin: gstin.value, address: address.value, stateCode: state.value }),
    };
  }
  private readiness(seller: { legalName: string; gstin: string; address: string; stateCode: string }) {
    const problems: string[] = [];
    if (!seller.legalName) problems.push("Operator legal name is not set.");
    if (!seller.address) problems.push("Operator address is not set.");
    if (!GST_STATES[seller.stateCode]) problems.push("Operator state is not a GST state code.");
    if (!seller.gstin) problems.push("Operator GSTIN is not set.");
    else { const problem = gstinProblem(seller.gstin, seller.stateCode); if (problem) problems.push(`Operator GSTIN: ${problem}`); }
    return { canIssue: problems.length === 0, problems };
  }
  private sellerParty(settings: Awaited<ReturnType<BillingService["settings"]>>): Party {
    return { legalName: settings.legalName, tradeName: settings.tradeName, gstin: settings.gstin || null, pan: settings.pan || null, address: settings.address,
      stateCode: settings.stateCode, email: settings.email || null, phone: settings.phone || null };
  }

  async getSettings(identity: AuthIdentity) { await this.requirePlatform(identity); return this.settings(); }

  async updateSettings(identity: AuthIdentity, input: UpdateSettingsDto) {
    await this.requirePlatform(identity);
    if (input.gstin) {
      const state = input.stateCode || (await this.settings()).stateCode;
      const problem = gstinProblem(input.gstin, state);
      if (problem) throw new BadRequestException(problem);
    }
    const map: Record<string, string> = { legalName: "legal_name", tradeName: "trade_name", gstin: "gstin", pan: "pan", address: "address", stateCode: "state_code", email: "email",
      phone: "phone", sacCode: "sac_code", gstRate: "gst_rate", invoicePrefix: "invoice_prefix", creditNotePrefix: "credit_note_prefix", paymentTermsDays: "payment_terms_days",
      bankDetails: "bank_details", headcountRule: "headcount_rule", autoSuspendEnabled: "auto_suspend_enabled", autoSuspendAfterDays: "auto_suspend_after_days", suspendWarningDays: "suspend_warning_days" };
    const sets: string[] = []; const values: unknown[] = [];
    for (const [key, column] of Object.entries(map)) {
      const value = (input as Record<string, unknown>)[key];
      if (value !== undefined) { values.push(value === "" ? null : value); sets.push(`${column}=$${values.length}`); }
    }
    if (input.invoicePrefix) formatDocumentNumber(input.invoicePrefix, "2026-27", 1);
    if (!sets.length) throw new BadRequestException("Nothing to change.");
    values.push(identity.userId);
    await this.database.systemQuery(`UPDATE billing_settings SET ${sets.join(",")}, updated_by=$${values.length}, updated_at=now() WHERE id=1`, values);
    await this.event(identity, "BILLING_SETTINGS_UPDATED", "billing_settings", null, input);
    return this.settings();
  }

  // ==== plans =============================================================================================================

  private planSelect = `SELECT id, code, name, description, pepm_paise::float8 AS "pepmPaise", minimum_monthly_paise::float8 AS "minimumPaise", setup_fee_paise::float8 AS "setupFeePaise",
    included_modules AS "includedModules", billing_cycle AS "billingCycle", annual_discount_pct::float8 AS "annualDiscountPct", trial_days AS "trialDays", usage_basis AS "usageBasis",
    active, version, (SELECT count(DISTINCT s.account_id)::int FROM billing_subscriptions s WHERE s.plan_id=billing_plans.id AND (s.contract_end IS NULL OR s.contract_end >= (now() AT TIME ZONE 'Asia/Kolkata')::date)) AS "accounts"
    FROM billing_plans`;

  async plans(identity: AuthIdentity) {
    await this.requirePlatform(identity);
    return { items: await this.q(`${this.planSelect} ORDER BY active DESC, pepm_paise`), modules: MODULE_KEYS };
  }

  async createPlan(identity: AuthIdentity, input: PlanDto) {
    await this.requirePlatform(identity);
    if (!input.code || !input.name || input.pepm === undefined) throw new BadRequestException("Code, name and PEPM price are required.");
    const [row] = await this.q(
      `INSERT INTO billing_plans(code,name,description,pepm_paise,minimum_monthly_paise,setup_fee_paise,included_modules,billing_cycle,annual_discount_pct,trial_days,usage_basis)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (code) DO NOTHING RETURNING id`,
      [input.code, input.name, input.description || null, paise(input.pepm), paise(input.minimumMonthly || 0), paise(input.setupFee || 0),
        [...new Set(["core", ...(input.includedModules || [])])], input.billingCycle || "MONTHLY", input.annualDiscountPct || 0, input.trialDays || 0, input.usageBasis || "PEAK"]);
    if (!row) throw new ConflictException("A plan with this code already exists.");
    await this.event(identity, "BILLING_PLAN_CREATED", "billing_plan", row.id, input);
    return (await this.q(`${this.planSelect} WHERE id=$1`, [row.id]))[0];
  }

  /** Price changes apply to invoices generated afterwards; issued invoices never change. */
  async updatePlan(identity: AuthIdentity, id: string, input: PlanDto) {
    await this.requirePlatform(identity);
    if (input.version === undefined) throw new BadRequestException("version is required.");
    const map: Record<string, [string, (value: any) => unknown]> = {
      name: ["name", (v) => v], description: ["description", (v) => v || null], pepm: ["pepm_paise", paise], minimumMonthly: ["minimum_monthly_paise", paise],
      setupFee: ["setup_fee_paise", paise], includedModules: ["included_modules", (v: string[]) => [...new Set(["core", ...v])]], billingCycle: ["billing_cycle", (v) => v],
      annualDiscountPct: ["annual_discount_pct", (v) => v], trialDays: ["trial_days", (v) => v], usageBasis: ["usage_basis", (v) => v], active: ["active", (v) => v],
    };
    const sets: string[] = []; const values: unknown[] = [id, input.version];
    for (const [key, [column, convert]] of Object.entries(map)) {
      const value = (input as Record<string, unknown>)[key];
      if (value !== undefined) { values.push(convert(value)); sets.push(`${column}=$${values.length}`); }
    }
    if (!sets.length) throw new BadRequestException("Nothing to change.");
    const result = await this.database.systemQuery(`UPDATE billing_plans SET ${sets.join(",")}, version=version+1, updated_at=now() WHERE id=$1 AND version=$2 RETURNING id`, values);
    if (!result.rowCount) throw new ConflictException("This plan changed since you opened it. Refresh and try again.");
    await this.event(identity, "BILLING_PLAN_UPDATED", "billing_plan", id, input);
    return (await this.q(`${this.planSelect} WHERE id=$1`, [id]))[0];
  }

  // ==== accounts & subscriptions ==========================================================================================

  private async accountBrands(account: Row) {
    if (account.kind === "BRAND")
      return this.q<{ organizationId: string; name: string; slug: string; status: string }>(
        `SELECT id AS "organizationId", coalesce(display_name,name) AS name, slug, status FROM organizations WHERE id=$1`, [account.organization_id]);
    return this.q<{ organizationId: string; name: string; slug: string; status: string }>(
      `SELECT o.id AS "organizationId", coalesce(o.display_name,o.name) AS name, o.slug, o.status FROM organizations o
        WHERE o.group_id=$1 AND NOT EXISTS (SELECT 1 FROM billing_accounts a WHERE a.organization_id=o.id) ORDER BY 2`, [account.group_id]);
  }
  /** The organization audit rows and emails of an account are filed under (the brand, or the group's first brand). */
  private async primaryOrg(account: Row) {
    if (account.kind === "BRAND") return account.organization_id as string;
    const [first] = await this.accountBrands(account);
    if (first) return first.organizationId;
    const [any] = await this.q(`SELECT id FROM organizations WHERE group_id=$1 ORDER BY created_at LIMIT 1`, [account.group_id]);
    return (any?.id as string) || null;
  }
  private async account(id: string) {
    const [row] = await this.q(`SELECT * FROM billing_accounts WHERE id=$1`, [id]);
    if (!row) throw new NotFoundException("Billing account not found.");
    return row;
  }
  private subscriptionsSql = `SELECT s.id, s.account_id AS "accountId", s.plan_id AS "planId", p.name AS "planName", p.code AS "planCode", p.included_modules AS "includedModules",
    coalesce(s.pepm_paise_override, p.pepm_paise)::float8 AS "pepmPaise", coalesce(s.minimum_paise_override, p.minimum_monthly_paise)::float8 AS "minimumPaise",
    coalesce(s.setup_fee_paise_override, p.setup_fee_paise)::float8 AS "setupFeePaise", s.discount_pct::float8 AS "discountPct",
    coalesce(s.billing_cycle, p.billing_cycle) AS cycle, p.annual_discount_pct::float8 AS "annualDiscountPct", coalesce(s.usage_basis, p.usage_basis) AS "usageBasis",
    coalesce(s.trial_days, p.trial_days) AS "trialDays", s.committed_seats AS "committedSeats", s.contract_start::text AS "contractStart", s.contract_end::text AS "contractEnd",
    (s.pepm_paise_override IS NOT NULL OR s.minimum_paise_override IS NOT NULL OR s.setup_fee_paise_override IS NOT NULL OR s.discount_pct > 0) AS "customPrice", s.created_at AS "createdAt"
    FROM billing_subscriptions s JOIN billing_plans p ON p.id=s.plan_id`;

  async accounts(identity: AuthIdentity) {
    await this.requirePlatform(identity);
    const today = todayIst();
    const settings = await this.settings();
    const live = await this.liveCounts(today, settings.headcountRule);
    const accounts = await this.q(`SELECT a.*, g.name AS group_name FROM billing_accounts a LEFT JOIN organization_groups g ON g.id=a.group_id ORDER BY a.legal_name`);
    const items = [];
    for (const account of accounts) {
      const brands = (await this.accountBrands(account)).map((brand) => ({ ...brand, liveCount: live.get(brand.organizationId)?.billable ?? 0 }));
      const subscriptions = await this.q(`${this.subscriptionsSql} WHERE s.account_id=$1 ORDER BY s.contract_start`, [account.id]);
      const current = subscriptions.find((s) => s.contractStart <= today && (!s.contractEnd || s.contractEnd >= today)) || subscriptions.find((s) => s.contractStart > today) || null;
      const [money] = await this.q(`SELECT coalesce(sum(i.total_paise),0)::float8 AS billed,
          coalesce(sum((SELECT coalesce(sum(p.amount_paise),0) FROM billing_payments p WHERE p.invoice_id=i.id AND p.status='RECORDED')),0)::float8 AS paid,
          coalesce(sum((SELECT coalesce(sum(c.total_paise),0) FROM billing_credit_notes c WHERE c.invoice_id=i.id)),0)::float8 AS credited,
          count(*) FILTER (WHERE i.status='DRAFT')::int AS drafts
        FROM billing_invoices i WHERE i.account_id=$1`, [account.id]);
      const suspensions = await this.q(`SELECT s.organization_id AS "organizationId", s.warned_at AS "warnedAt", s.suspend_on::text AS "suspendOn", s.suspended_at AS "suspendedAt"
        FROM billing_suspensions s WHERE s.account_id=$1 AND s.reactivated_at IS NULL`, [account.id]);
      const liveTotal = brands.reduce((sum, brand) => sum + brand.liveCount, 0);
      items.push({ ...this.accountView(account), brands, subscriptions, current, liveTotal, suspensions,
        estimate: current ? this.estimate(current as unknown as SubscriptionTerms, liveTotal) : null,
        receivable: { billedPaise: money.billed, paidPaise: money.paid, creditedPaise: money.credited, outstandingPaise: Math.max(0, money.billed - money.paid - money.credited), drafts: money.drafts } });
    }
    const unbilled = await this.q(`SELECT o.id AS "organizationId", coalesce(o.display_name,o.name) AS name, o.slug, o.status, o.group_id AS "groupId", g.name AS "groupName",
        o.legal_name AS "legalName", o.default_state AS "defaultState"
      FROM organizations o LEFT JOIN organization_groups g ON g.id=o.group_id
      WHERE NOT EXISTS (SELECT 1 FROM billing_accounts a WHERE a.organization_id=o.id) AND NOT EXISTS (SELECT 1 FROM billing_accounts a WHERE a.group_id=o.group_id) ORDER BY 2`);
    const groups = await this.q(`SELECT g.id, g.name, (SELECT count(*)::int FROM organizations o WHERE o.group_id=g.id) AS brands,
      EXISTS (SELECT 1 FROM billing_accounts a WHERE a.group_id=g.id) AS "hasAccount" FROM organization_groups g ORDER BY g.name`);
    const plans = await this.q(`${this.planSelect} WHERE active ORDER BY pepm_paise`);
    return { items, unbilled: unbilled.map((brand) => ({ ...brand, liveCount: live.get(brand.organizationId)?.billable ?? 0 })), groups, plans, states: GST_STATES, today,
      rule: { key: settings.headcountRule, text: settings.headcountRuleText } };
  }
  private accountView(row: Row) {
    return { id: row.id as string, kind: row.kind as string, organizationId: row.organization_id as string | null, groupId: row.group_id as string | null, groupName: (row.group_name || null) as string | null,
      legalName: row.legal_name as string, gstin: row.gstin as string | null, billingAddress: row.billing_address as string, stateCode: row.state_code as string,
      contactName: row.contact_name as string | null, contactEmail: row.contact_email as string, contactPhone: row.contact_phone as string | null,
      paymentTermsDays: row.payment_terms_days as number | null, notes: row.notes as string | null, version: row.version as number };
  }
  /** Rough run-rate for the current month (what the next invoice would be at today's headcount, before tax). */
  private estimate(terms: SubscriptionTerms & { minimumPaise: number }, headcount: number) {
    const pepm = effectivePepm(terms);
    const usage = pepm * headcount;
    return terms.cycle === "ANNUAL"
      ? { pepmPaise: pepm, usagePaise: usage, minimumPaise: terms.minimumPaise, monthlyPaise: Math.max(0, headcount - (terms.committedSeats || 0)) * pepm, annual: true }
      : { pepmPaise: pepm, usagePaise: usage, minimumPaise: terms.minimumPaise, monthlyPaise: Math.max(usage, terms.minimumPaise), annual: false };
  }

  async saveAccount(identity: AuthIdentity, id: string | null, input: AccountDto) {
    await this.requirePlatform(identity);
    const existing = id ? await this.account(id) : null;
    const state = input.stateCode || existing?.state_code;
    if (input.gstin) { const problem = gstinProblem(input.gstin, state); if (problem) throw new BadRequestException(problem); }
    if (!existing) {
      if (!input.legalName || !input.billingAddress || !input.stateCode || !input.contactEmail) throw new BadRequestException("Legal name, billing address, state and billing contact email are required.");
      const kind = input.kind || (input.groupId ? "GROUP" : "BRAND");
      if (kind === "BRAND" && !input.organizationId) throw new BadRequestException("Choose the brand to bill.");
      if (kind === "GROUP" && !input.groupId) throw new BadRequestException("Choose the group to bill.");
      if (kind === "BRAND" && !(await this.q(`SELECT 1 FROM organizations WHERE id=$1`, [input.organizationId])).length) throw new NotFoundException("Brand not found.");
      if (kind === "GROUP" && !(await this.q(`SELECT 1 FROM organization_groups WHERE id=$1`, [input.groupId])).length) throw new NotFoundException("Group not found.");
      const [row] = await this.q(
        `INSERT INTO billing_accounts(kind,organization_id,group_id,legal_name,gstin,billing_address,state_code,contact_name,contact_email,contact_phone,payment_terms_days,notes)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING *`,
        [kind, kind === "BRAND" ? input.organizationId : null, kind === "GROUP" ? input.groupId : null, input.legalName, input.gstin || null, input.billingAddress, input.stateCode,
          input.contactName || null, input.contactEmail.toLowerCase(), input.contactPhone || null, input.paymentTermsDays ?? null, input.notes || null]);
      if (!row) throw new ConflictException("This brand or group already has a billing account.");
      await this.audit(identity.userId, row, "BILLING_ACCOUNT_CREATED", "billing_account", row.id, null, input);
      return this.accountView(row);
    }
    if (input.version === undefined) throw new BadRequestException("version is required.");
    const map: Record<string, string> = { legalName: "legal_name", gstin: "gstin", billingAddress: "billing_address", stateCode: "state_code", contactName: "contact_name",
      contactEmail: "contact_email", contactPhone: "contact_phone", paymentTermsDays: "payment_terms_days", notes: "notes" };
    const sets: string[] = []; const values: unknown[] = [existing.id, input.version];
    for (const [key, column] of Object.entries(map)) {
      const value = (input as Record<string, unknown>)[key];
      if (value !== undefined) { values.push(value === "" ? null : value); sets.push(`${column}=$${values.length}`); }
    }
    if (!sets.length) throw new BadRequestException("Nothing to change.");
    const [row] = await this.q(`UPDATE billing_accounts SET ${sets.join(",")}, version=version+1, updated_at=now() WHERE id=$1 AND version=$2 RETURNING *`, values);
    if (!row) throw new ConflictException("This account changed since you opened it. Refresh and try again.");
    if (row.gstin && gstinProblem(row.gstin, row.state_code)) throw new BadRequestException(gstinProblem(row.gstin, row.state_code)!);
    await this.audit(identity.userId, row, "BILLING_ACCOUNT_UPDATED", "billing_account", row.id, this.accountView(existing), input);
    return this.accountView(row);
  }

  /**
   * Assigns a plan from `contractStart`. A subscription running at that date is ended the day before (a mid-month change
   * is prorated by the invoice engine). Periods already covered by an issued invoice can't be re-priced: use a credit note.
   */
  async assignPlan(identity: AuthIdentity, accountId: string, input: AssignPlanDto) {
    await this.requirePlatform(identity);
    if (input.contractEnd && input.contractEnd < input.contractStart) throw new BadRequestException("Contract end must be on or after the start.");
    const [plan] = await this.q(`SELECT * FROM billing_plans WHERE id=$1 AND active`, [input.planId]);
    if (!plan) throw new NotFoundException("Plan not found or retired.");
    const cycle = input.billingCycle || plan.billing_cycle;
    if (cycle === "ANNUAL" && input.committedSeats === undefined) throw new BadRequestException("Annual contracts need the number of committed seats.");
    const result = await this.database.platformTransaction(async (client) => {
      const account = (await client.query(`SELECT * FROM billing_accounts WHERE id=$1 FOR UPDATE`, [accountId])).rows[0];
      if (!account) throw new NotFoundException("Billing account not found.");
      const [issued] = (await client.query(`SELECT max(period_end)::text AS last FROM billing_invoices WHERE account_id=$1 AND status='ISSUED'`, [accountId])).rows;
      if (issued?.last && input.contractStart <= issued.last)
        throw new BadRequestException(`Invoices are already issued up to ${issued.last}. Start the new plan after that date, or correct the past with a credit note.`);
      const later = (await client.query(`SELECT 1 FROM billing_subscriptions WHERE account_id=$1 AND contract_start >= $2`, [accountId, input.contractStart])).rowCount;
      if (later) throw new ConflictException("Another subscription already starts on or after this date. Change dates so contracts don't overlap.");
      const ended = (await client.query(
        `UPDATE billing_subscriptions SET contract_end=$2::date - 1 WHERE account_id=$1 AND contract_start < $2 AND (contract_end IS NULL OR contract_end >= $2) RETURNING id`,
        [accountId, input.contractStart])).rows;
      const row = (await client.query(
        `INSERT INTO billing_subscriptions(account_id,plan_id,pepm_paise_override,minimum_paise_override,setup_fee_paise_override,discount_pct,billing_cycle,usage_basis,trial_days,
           committed_seats,contract_start,contract_end,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [accountId, plan.id, input.pepmOverride === undefined ? null : paise(input.pepmOverride), input.minimumOverride === undefined ? null : paise(input.minimumOverride),
          input.setupFeeOverride === undefined ? null : paise(input.setupFeeOverride), input.discountPct || 0, input.billingCycle || null, input.usageBasis || null,
          input.trialDays ?? null, input.committedSeats ?? null, input.contractStart, input.contractEnd || null, identity.userId])).rows[0];
      return { account, subscriptionId: row.id as string, endedSubscriptions: ended.map((item) => item.id) };
    });
    const brands = await this.accountBrands(result.account);
    if (input.applyModules) {
      for (const brand of brands) {
        await this.database.systemQuery(`UPDATE organizations SET enabled_modules=$2, version=version+1 WHERE id=$1`, [brand.organizationId, plan.included_modules]);
        await this.audit(identity.userId, result.account, "BILLING_PLAN_MODULES_APPLIED", "organization", brand.organizationId, null, { plan: plan.code, modules: plan.included_modules }, brand.organizationId);
      }
    }
    await this.audit(identity.userId, result.account, "BILLING_PLAN_ASSIGNED", "billing_subscription", result.subscriptionId, null, { ...input, plan: plan.code });
    return { ...result, account: undefined, brands, modulesApplied: !!input.applyModules };
  }

  async addAdjustment(identity: AuthIdentity, accountId: string, input: AdjustmentDto) {
    await this.requirePlatform(identity);
    const account = await this.account(accountId);
    const [row] = await this.q(`INSERT INTO billing_adjustments(account_id,kind,description,amount_paise,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [accountId, input.kind, input.description, paise(input.amount), identity.userId]);
    await this.audit(identity.userId, account, "BILLING_ADJUSTMENT_ADDED", "billing_adjustment", row.id, null, input);
    return { id: row.id, ...input, applied: false };
  }

  async adjustments(identity: AuthIdentity, accountId: string) {
    await this.requirePlatform(identity);
    return { items: await this.q(`SELECT a.id, a.kind, a.description, a.amount_paise::float8 AS "amountPaise", a.applied_invoice_id AS "appliedInvoiceId", a.created_at AS "createdAt"
      FROM billing_adjustments a WHERE a.account_id=$1 ORDER BY a.created_at DESC`, [accountId]) };
  }

  // ==== usage ==============================================================================================================

  /** Billable headcount per brand on `day` (state as of now, joiners after `day` excluded). */
  private async liveCounts(day: string, rule: string) {
    const rows = await this.q(`SELECT o.id, count(e.id)::int AS active_employees, count(m.user_id)::int AS with_login
      FROM organizations o
      LEFT JOIN employees e ON e.organization_id=o.id AND e.status='ACTIVE' AND e.joining_date <= $1::date
        AND NOT EXISTS (SELECT 1 FROM platform_admins p WHERE p.user_id=e.user_id)
      LEFT JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.user_id=e.user_id AND m.status='ACTIVE'
      GROUP BY o.id`, [day]);
    return new Map(rows.map((row) => [row.id as string, {
      activeEmployees: row.active_employees as number, withLogin: row.with_login as number,
      billable: (rule === "ALL_ACTIVE_EMPLOYEES" ? row.active_employees : row.with_login) as number,
    }]));
  }

  /**
   * Records billable headcount for one day (default: today, IST) or a backfill range. Past days can only be estimated from
   * today's employee and login state (joining dates are honoured), so they are stored with source BACKFILL.
   */
  async snapshotUsage(identity: AuthIdentity | null, input: SnapshotDto = {}) {
    if (identity) await this.requirePlatform(identity);
    const today = todayIst();
    const from = input.from || input.date || today, to = input.to || input.date || today;
    if (to < from) throw new BadRequestException("'to' must be on or after 'from'.");
    if (to > today) throw new BadRequestException("Usage can't be recorded for future days.");
    if (daysBetween(from, to) > 92) throw new BadRequestException("Backfill at most 93 days at a time.");
    const settings = await this.settings();
    let rows = 0;
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const counts = await this.liveCounts(day, settings.headcountRule);
      for (const [organizationId, count] of counts) {
        await this.database.systemQuery(
          `INSERT INTO billing_usage_snapshots(organization_id,snapshot_date,billable_count,active_employees,with_login,rule,source) VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (organization_id,snapshot_date) DO UPDATE SET billable_count=excluded.billable_count, active_employees=excluded.active_employees,
             with_login=excluded.with_login, rule=excluded.rule, source=excluded.source, captured_at=now()`,
          [organizationId, day, count.billable, count.activeEmployees, count.withLogin, settings.headcountRule, day === today ? "NIGHTLY" : "BACKFILL"]);
        rows += 1;
      }
    }
    if (identity) await this.event(identity, "BILLING_USAGE_SNAPSHOT", "billing_usage", null, { from, to, rows });
    return { from, to, rows, rule: settings.headcountRule, ruleText: settings.headcountRuleText };
  }

  async usage(identity: AuthIdentity, month?: string) {
    await this.requirePlatform(identity);
    const period = month || todayIst().slice(0, 7);
    const { start, end } = monthRange(period);
    const settings = await this.settings();
    const live = await this.liveCounts(todayIst(), settings.headcountRule);
    const brands = await this.q(`SELECT id, coalesce(display_name,name) AS name, slug, status FROM organizations ORDER BY 2`);
    const snaps = await this.q(`SELECT organization_id AS "organizationId", snapshot_date::text AS day, billable_count AS count, source FROM billing_usage_snapshots
      WHERE snapshot_date BETWEEN $1 AND $2 ORDER BY snapshot_date`, [start, end]);
    return {
      period, start, end, rule: { key: settings.headcountRule, text: settings.headcountRuleText },
      items: brands.map((brand) => {
        const days = snaps.filter((snap) => snap.organizationId === brand.id);
        const counts = days.map((day) => day.count as number);
        return { organizationId: brand.id, name: brand.name, slug: brand.slug, status: brand.status, live: live.get(brand.id),
          days: days.map((day) => ({ day: day.day, count: day.count, source: day.source })),
          peak: counts.length ? Math.max(...counts) : null, average: counts.length ? Math.ceil(counts.reduce((a, b) => a + b, 0) / counts.length) : null };
      }),
    };
  }

  // ==== invoices ===========================================================================================================

  /**
   * Drafts invoices for a month: every account with a subscription overlapping it. An existing DRAFT for the same
   * account+month is replaced (so re-running after fixing usage is safe); an ISSUED one is left alone.
   */
  async generateInvoices(identity: AuthIdentity | null, input: GenerateDto) {
    if (identity) await this.requirePlatform(identity);
    const { start, end } = monthRange(input.period);
    if (start > todayIst()) throw new BadRequestException("That month hasn't started yet.");
    const settings = await this.settings();
    const seller = this.sellerParty(settings);
    const accounts = await this.q(
      `SELECT DISTINCT a.* FROM billing_accounts a JOIN billing_subscriptions s ON s.account_id=a.id
        WHERE s.contract_start <= $1 AND (s.contract_end IS NULL OR s.contract_end >= $2) AND ($3::uuid IS NULL OR a.id=$3) ORDER BY a.legal_name`,
      [end, start, input.accountId || null]);
    const results: Row[] = [];
    const actor = identity?.userId || null;
    for (const account of accounts) {
      const brands = await this.accountBrands(account);
      const subscriptions = (await this.q(`${this.subscriptionsSql} WHERE s.account_id=$1 AND s.contract_start <= $2 AND (s.contract_end IS NULL OR s.contract_end >= $3)`,
        [account.id, end, start])) as unknown as SubscriptionTerms[];
      const snaps = await this.q(`SELECT organization_id AS org, snapshot_date::text AS day, billable_count AS count FROM billing_usage_snapshots
        WHERE organization_id = ANY($1::uuid[]) AND snapshot_date BETWEEN $2 AND $3`, [brands.map((brand) => brand.organizationId), start, end]);
      const usage: Record<string, Record<string, number>> = {};
      for (const snap of snaps) (usage[snap.org] ||= {})[snap.day] = snap.count;
      const live = await this.liveCounts(todayIst(), settings.headcountRule);
      const liveCounts = Object.fromEntries(brands.map((brand) => [brand.organizationId, live.get(brand.organizationId)?.billable ?? 0]));

      const outcome = await this.database.platformTransaction(async (client) => {
        await client.query(`SELECT 1 FROM billing_accounts WHERE id=$1 FOR UPDATE`, [account.id]);
        const existing = (await client.query(`SELECT id, status, number FROM billing_invoices WHERE account_id=$1 AND period_start=$2`, [account.id, start])).rows[0];
        if (existing?.status === "ISSUED") return { accountId: account.id, accountName: account.legal_name, skipped: `Already issued as ${existing.number}.` };
        if (existing) await client.query(`DELETE FROM billing_invoices WHERE id=$1`, [existing.id]);
        const prior = (await client.query(`SELECT l.kind, l.meta FROM billing_invoice_lines l JOIN billing_invoices i ON i.id=l.invoice_id
          WHERE i.account_id=$1 AND l.kind IN ('SETUP','ANNUAL')`, [account.id])).rows;
        const adjustments = (await client.query(`SELECT id, kind, description, amount_paise::float8 AS "amountPaise" FROM billing_adjustments
          WHERE account_id=$1 AND applied_invoice_id IS NULL ORDER BY created_at`, [account.id])).rows as Adjustment[];
        const draft = composeInvoice({ period: input.period, brands: brands.map((brand) => ({ organizationId: brand.organizationId, name: brand.name })), subscriptions, usage, liveCounts,
          setupFeeAlreadyBilled: prior.some((line) => line.kind === "SETUP"),
          annualAlreadyBilled: prior.filter((line) => line.kind === "ANNUAL").map((line) => `${line.meta.subscriptionId}:${line.meta.contractYearStart}`), adjustments });
        if (!draft.lines.some((line) => line.amountPaise !== 0))
          return { accountId: account.id, accountName: account.legal_name, skipped: draft.lines.length ? "Free trial only — nothing to invoice." : "No billable lines." };
        const tax = gstSplit(draft.subtotalPaise, settings.gstRate, seller.stateCode, account.state_code);
        const buyer: Party = { legalName: account.legal_name, gstin: account.gstin, address: account.billing_address, stateCode: account.state_code, email: account.contact_email };
        const invoice = (await client.query(
          `INSERT INTO billing_invoices(account_id,period_start,period_end,place_of_supply,supply_type,sac_code,gst_rate,seller,buyer,subtotal_paise,cgst_paise,sgst_paise,igst_paise,
             total_paise,usage,warnings,is_demo,generated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
          [account.id, start, end, account.state_code, tax.supplyType, settings.sacCode, settings.gstRate, JSON.stringify(seller), JSON.stringify(buyer), draft.subtotalPaise,
            tax.cgst, tax.sgst, tax.igst, tax.total, JSON.stringify(draft.usage), draft.warnings, !!input.demo, actor])).rows[0];
        for (const [position, line] of draft.lines.entries())
          await client.query(`INSERT INTO billing_invoice_lines(invoice_id,position,kind,description,organization_id,quantity,unit_price_paise,amount_paise,meta) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [invoice.id, position + 1, line.kind, line.description, line.organizationId || null, line.quantity ?? null, line.unitPricePaise ?? null, line.amountPaise, JSON.stringify(line.meta || {})]);
        for (const applied of draft.appliedAdjustments) {
          const original = adjustments.find((item) => item.id === applied.id)!;
          if (applied.amountPaise < original.amountPaise) {
            await client.query(`INSERT INTO billing_adjustments(account_id,kind,description,amount_paise,created_by) SELECT account_id,kind,description || ' (carried forward)',$2,created_by FROM billing_adjustments WHERE id=$1`,
              [applied.id, original.amountPaise - applied.amountPaise]);
            await client.query(`UPDATE billing_adjustments SET amount_paise=$2 WHERE id=$1`, [applied.id, applied.amountPaise]);
          }
          await client.query(`UPDATE billing_adjustments SET applied_invoice_id=$2 WHERE id=$1`, [applied.id, invoice.id]);
        }
        return { accountId: account.id, accountName: account.legal_name, invoiceId: invoice.id as string, totalPaise: tax.total, warnings: draft.warnings, replacedDraft: !!existing };
      });
      if (outcome.invoiceId) await this.audit(actor, account, "BILLING_INVOICE_DRAFTED", "billing_invoice", outcome.invoiceId, null, { period: input.period, demo: !!input.demo });
      results.push(outcome);
    }
    return { period: input.period, generated: results.filter((item) => item.invoiceId).length, results };
  }

  private decorate(row: Row, today = todayIst()): Row {
    const state = paymentState(row.totalPaise, row.paidPaise, row.creditedPaise);
    const overdue = row.status === "ISSUED" && state.outstandingPaise > 0 && row.dueDate < today;
    return { ...row, paymentState: state.state, outstandingPaise: state.outstandingPaise, overdue, daysOverdue: overdue ? daysBetween(row.dueDate, today) : 0,
      excessPaise: Math.max(0, row.paidPaise + row.creditedPaise - row.totalPaise) };
  }

  async invoices(identity: AuthIdentity, query: InvoiceQuery) {
    await this.requirePlatform(identity);
    const where: string[] = []; const values: unknown[] = [];
    if (query.status) { values.push(query.status); where.push(`i.status=$${values.length}`); }
    if (query.period) { values.push(`${query.period}-01`); where.push(`i.period_start=$${values.length}`); }
    if (query.accountId) { values.push(query.accountId); where.push(`i.account_id=$${values.length}`); }
    const rows = await this.q(`${INVOICE_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY i.period_start DESC, a.legal_name LIMIT 500`, values);
    return { items: rows.map((row) => this.decorate(row)) };
  }

  private async loadInvoice(id: string) {
    const [row] = await this.q(`${INVOICE_SELECT} WHERE i.id=$1`, [id]);
    if (!row) throw new NotFoundException("Invoice not found.");
    const lines = await this.q(`SELECT id, position, kind, description, organization_id AS "organizationId", quantity::float8 AS quantity, unit_price_paise::float8 AS "unitPricePaise",
      amount_paise::float8 AS "amountPaise", meta FROM billing_invoice_lines WHERE invoice_id=$1 ORDER BY position`, [id]);
    const payments = await this.q(`SELECT id, amount_paise::float8 AS "amountPaise", paid_on::text AS "paidOn", mode, reference, note, status, reversed_reason AS "reversedReason",
      is_demo AS "isDemo", recorded_at AS "recordedAt" FROM billing_payments WHERE invoice_id=$1 ORDER BY paid_on, recorded_at`, [id]);
    const creditNotes = await this.q(`SELECT id, number, issue_date::text AS "issueDate", reason, taxable_paise::float8 AS "taxablePaise", cgst_paise::float8 AS "cgstPaise",
      sgst_paise::float8 AS "sgstPaise", igst_paise::float8 AS "igstPaise", total_paise::float8 AS "totalPaise", is_demo AS "isDemo" FROM billing_credit_notes WHERE invoice_id=$1 ORDER BY created_at`, [id]);
    const reminders = await this.q(`SELECT kind, sent_at AS "sentAt" FROM billing_reminders WHERE invoice_id=$1 ORDER BY sent_at`, [id]);
    return { ...this.decorate(row), lines, payments, creditNotes, reminders } as Row;
  }

  async invoice(identity: AuthIdentity, id: string) {
    await this.requirePlatform(identity);
    return this.loadInvoice(id);
  }

  async deleteDraft(identity: AuthIdentity, id: string) {
    await this.requirePlatform(identity);
    const invoice = await this.loadInvoice(id);
    if (invoice.status !== "DRAFT") throw new BadRequestException("Issued invoices can't be deleted. Issue a credit note instead.");
    await this.database.systemQuery(`DELETE FROM billing_invoices WHERE id=$1 AND status='DRAFT'`, [id]);
    await this.audit(identity.userId, await this.account(invoice.accountId), "BILLING_INVOICE_DRAFT_DELETED", "billing_invoice", id, { period: invoice.periodStart, totalPaise: invoice.totalPaise }, null);
    return { deleted: true };
  }

  /**
   * Issues a draft: assigns the next consecutive number of the FY series inside the same transaction (gapless), refreshes
   * the seller block and tax from the current settings, sets the due date. After this the row is immutable (DB trigger).
   */
  async issue(identity: AuthIdentity, id: string, issueDateInput?: string) {
    await this.requirePlatform(identity);
    const settings = await this.settings();
    if (!settings.readiness.canIssue) throw new BadRequestException(`Complete the operator details first: ${settings.readiness.problems.join(" ")}`);
    const today = todayIst();
    const issueDate = issueDateInput || today;
    if (issueDate > today) throw new BadRequestException("The invoice date can't be in the future.");
    const seller = this.sellerParty(settings);
    const issued = await this.database.platformTransaction(async (client) => {
      const invoice = (await client.query(`SELECT i.*, i.period_end::text AS period_end_text, i.subtotal_paise::float8 AS subtotal, a.payment_terms_days AS terms
        FROM billing_invoices i JOIN billing_accounts a ON a.id=i.account_id WHERE i.id=$1 FOR UPDATE OF i`, [id])).rows[0];
      if (!invoice) throw new NotFoundException("Invoice not found.");
      if (invoice.status !== "DRAFT") throw new ConflictException(`Already issued as ${invoice.number}.`);
      if (invoice.subtotal <= 0) throw new BadRequestException("A zero-value invoice can't be issued. Delete the draft instead.");
      if (issueDate < invoice.period_end_text) throw new BadRequestException("Invoice the month after it ends (the invoice date must be on or after the period end).");
      const series = invoice.is_demo ? DEMO_INVOICE_SERIES : settings.invoicePrefix;
      const numbering = await nextDocumentNumber(client, series, issueDate);
      const [latest] = (await client.query(`SELECT max(issue_date)::text AS last FROM billing_invoices WHERE status='ISSUED' AND fiscal_year=$1 AND number LIKE $2`,
        [numbering.fy, `${series}/%`])).rows;
      if (latest?.last && latest.last > issueDate) throw new BadRequestException(`Invoice ${series}/${numbering.fy} numbers must follow date order: the last one is dated ${latest.last}.`);
      const tax = gstSplit(Number(invoice.subtotal), settings.gstRate, seller.stateCode, invoice.place_of_supply);
      const dueDate = addDays(issueDate, invoice.terms ?? settings.paymentTermsDays);
      await client.query(
        `UPDATE billing_invoices SET status='ISSUED', number=$2, fiscal_year=$3, issue_date=$4, due_date=$5, seller=$6, supply_type=$7, gst_rate=$8, sac_code=$9,
           cgst_paise=$10, sgst_paise=$11, igst_paise=$12, total_paise=$13, issued_by=$14, issued_at=now() WHERE id=$1`,
        [id, numbering.number, numbering.fy, issueDate, dueDate, JSON.stringify(seller), tax.supplyType, settings.gstRate, settings.sacCode, tax.cgst, tax.sgst, tax.igst, tax.total, identity.userId]);
      return { number: numbering.number, accountId: invoice.account_id as string, dueDate, totalPaise: tax.total };
    });
    await this.audit(identity.userId, await this.account(issued.accountId), "BILLING_INVOICE_ISSUED", "billing_invoice", id, null, issued);
    return this.loadInvoice(id);
  }

  /** Credit note against an issued invoice (GST s.34): reduces taxable value; tax is split exactly like the invoice. */
  async creditNote(identity: AuthIdentity, invoiceId: string, input: CreditNoteDto) {
    await this.requirePlatform(identity);
    const settings = await this.settings();
    const today = todayIst();
    const created = await this.database.platformTransaction(async (client) => {
      const invoice = (await client.query(`SELECT i.*, i.subtotal_paise::float8 AS subtotal, i.gst_rate::float8 AS rate,
          coalesce((SELECT sum(taxable_paise) FROM billing_credit_notes c WHERE c.invoice_id=i.id),0)::float8 AS credited
        FROM billing_invoices i WHERE i.id=$1 FOR UPDATE`, [invoiceId])).rows[0];
      if (!invoice) throw new NotFoundException("Invoice not found.");
      if (invoice.status !== "ISSUED") throw new BadRequestException("Credit notes can only be raised against issued invoices. Edit or delete the draft instead.");
      const taxable = paise(input.amount);
      const room = invoice.subtotal - invoice.credited;
      if (taxable > room) throw new BadRequestException(`At most INR ${formatInr(room)} of taxable value is left to credit on ${invoice.number}.`);
      const tax = gstSplit(taxable, invoice.rate, invoice.seller.stateCode, invoice.place_of_supply);
      const series = invoice.is_demo ? DEMO_CREDIT_SERIES : settings.creditNotePrefix;
      const numbering = await nextDocumentNumber(client, series, today);
      const row = (await client.query(
        `INSERT INTO billing_credit_notes(invoice_id,number,fiscal_year,issue_date,reason,taxable_paise,cgst_paise,sgst_paise,igst_paise,total_paise,seller,buyer,is_demo,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [invoiceId, numbering.number, numbering.fy, today, input.reason, taxable, tax.cgst, tax.sgst, tax.igst, tax.total, JSON.stringify(this.sellerParty(settings)),
          JSON.stringify(invoice.buyer), invoice.is_demo, identity.userId])).rows[0];
      return { id: row.id as string, number: numbering.number, accountId: invoice.account_id as string, totalPaise: tax.total, isDemo: !!invoice.is_demo };
    });
    const account = await this.account(created.accountId);
    await this.audit(identity.userId, account, "BILLING_CREDIT_NOTE_ISSUED", "billing_credit_note", created.id, null, { ...input, invoiceId, number: created.number });
    await this.reconcileSuspensions(account, identity.userId, todayIst(), false, created.isDemo);
    return { ...created, invoice: await this.loadInvoice(invoiceId) };
  }

  async recordPayment(identity: AuthIdentity, invoiceId: string, input: PaymentDto) {
    await this.requirePlatform(identity);
    if (input.paidOn > todayIst()) throw new BadRequestException("The payment date can't be in the future.");
    const invoice = await this.loadInvoice(invoiceId);
    if (invoice.status !== "ISSUED") throw new BadRequestException("Issue the invoice before recording payments against it.");
    const amount = paise(input.amount);
    if (amount > invoice.outstandingPaise) throw new BadRequestException(`Only INR ${formatInr(invoice.outstandingPaise)} is outstanding on ${invoice.number}.`);
    const [row] = await this.q(`INSERT INTO billing_payments(invoice_id,amount_paise,paid_on,mode,reference,note,is_demo,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [invoiceId, amount, input.paidOn, input.mode, input.reference || null, input.note || null, invoice.isDemo, identity.userId]);
    const account = await this.account(invoice.accountId);
    await this.audit(identity.userId, account, "BILLING_PAYMENT_RECORDED", "billing_payment", row.id, null, { ...input, invoice: invoice.number });
    const reactivated = await this.reconcileSuspensions(account, identity.userId, todayIst(), false, invoice.isDemo);
    return { id: row.id, invoice: await this.loadInvoice(invoiceId), reactivated };
  }

  async reversePayment(identity: AuthIdentity, paymentId: string, reason: string) {
    await this.requirePlatform(identity);
    const [payment] = await this.q(`SELECT p.*, i.account_id FROM billing_payments p JOIN billing_invoices i ON i.id=p.invoice_id WHERE p.id=$1`, [paymentId]);
    if (!payment) throw new NotFoundException("Payment not found.");
    if (payment.status !== "RECORDED") throw new BadRequestException("This payment is already reversed.");
    await this.database.systemQuery(`UPDATE billing_payments SET status='REVERSED', reversed_reason=$2, reversed_by=$3, reversed_at=now() WHERE id=$1`, [paymentId, reason, identity.userId]);
    await this.audit(identity.userId, await this.account(payment.account_id), "BILLING_PAYMENT_REVERSED", "billing_payment", paymentId, { amountPaise: Number(payment.amount_paise) }, { reason });
    return this.loadInvoice(payment.invoice_id);
  }

  async aging(identity: AuthIdentity, today = todayIst()) {
    await this.requirePlatform(identity);
    const rows = (await this.q(`${INVOICE_SELECT} WHERE i.status='ISSUED' ORDER BY i.due_date`)).map((row) => this.decorate(row, today)).filter((row) => row.outstandingPaise > 0);
    const empty = () => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 });
    const byAccount = new Map<string, { accountId: string; accountName: string; buckets: ReturnType<typeof empty>; invoices: Row[] }>();
    const totals = empty();
    for (const row of rows) {
      const bucket = agingBucket(row.dueDate, today) as keyof ReturnType<typeof empty>;
      const entry = byAccount.get(row.accountId) || { accountId: row.accountId, accountName: row.accountName, buckets: empty(), invoices: [] as Row[] };
      entry.buckets[bucket] += row.outstandingPaise; entry.buckets.total += row.outstandingPaise; entry.invoices.push(row);
      totals[bucket] += row.outstandingPaise; totals.total += row.outstandingPaise;
      byAccount.set(row.accountId, entry);
    }
    return { today, totals, accounts: [...byAccount.values()] };
  }

  // ==== documents ==========================================================================================================

  private toDocument(invoice: Awaited<ReturnType<BillingService["loadInvoice"]>>, bankDetails: string): BillingDocument {
    return {
      kind: "INVOICE", number: invoice.number, issueDate: invoice.issueDate, dueDate: invoice.dueDate, periodStart: invoice.periodStart, periodEnd: invoice.periodEnd,
      placeOfSupply: invoice.placeOfSupply, supplyType: invoice.supplyType, sacCode: invoice.sacCode, gstRate: invoice.gstRate, seller: invoice.seller, buyer: invoice.buyer,
      lines: invoice.lines.filter((line: Row) => line.amountPaise !== 0 || line.kind === "TRIAL"),
      subtotalPaise: invoice.subtotalPaise, cgstPaise: invoice.cgstPaise, sgstPaise: invoice.sgstPaise, igstPaise: invoice.igstPaise, totalPaise: invoice.totalPaise,
      isDemo: invoice.isDemo, draft: invoice.status === "DRAFT", bankDetails,
      receivable: { paidPaise: invoice.paidPaise, creditedPaise: invoice.creditedPaise, outstandingPaise: invoice.outstandingPaise },
    };
  }
  private fileName(prefix: string, number: string | null, id: string) { return `${prefix}-${(number || `draft-${id.slice(0, 8)}`).replace(/[^A-Za-z0-9-]+/g, "-")}.pdf`; }

  async invoicePdf(identity: AuthIdentity, id: string) {
    await this.requirePlatform(identity);
    const invoice = await this.loadInvoice(id);
    const settings = await this.settings();
    return { name: this.fileName("invoice", invoice.number, id), body: renderBillingPdf(this.toDocument(invoice, settings.bankDetails)) };
  }

  private async creditNoteDocument(id: string) {
    const [note] = await this.q(`SELECT c.*, c.issue_date::text AS issue_text, i.number AS invoice_number, i.issue_date::text AS invoice_date, i.place_of_supply, i.supply_type,
      i.sac_code, i.gst_rate::float8 AS rate, i.account_id FROM billing_credit_notes c JOIN billing_invoices i ON i.id=c.invoice_id WHERE c.id=$1`, [id]);
    if (!note) throw new NotFoundException("Credit note not found.");
    const doc: BillingDocument = {
      kind: "CREDIT_NOTE", number: note.number, issueDate: note.issue_text, placeOfSupply: note.place_of_supply, supplyType: note.supply_type, sacCode: note.sac_code, gstRate: note.rate,
      seller: note.seller, buyer: note.buyer, original: { number: note.invoice_number, issueDate: note.invoice_date }, reason: note.reason, isDemo: note.is_demo,
      lines: [{ description: `Credit against invoice ${note.invoice_number}: ${note.reason}`, amountPaise: Number(note.taxable_paise) }],
      subtotalPaise: Number(note.taxable_paise), cgstPaise: Number(note.cgst_paise), sgstPaise: Number(note.sgst_paise), igstPaise: Number(note.igst_paise), totalPaise: Number(note.total_paise),
    };
    return { accountId: note.account_id as string, name: this.fileName("credit-note", note.number, id), body: renderBillingPdf(doc) };
  }
  async creditNotePdf(identity: AuthIdentity, id: string) {
    await this.requirePlatform(identity);
    const file = await this.creditNoteDocument(id);
    return { name: file.name, body: file.body };
  }

  // ==== receivables: reminders + suspension ================================================================================

  private async recipients(account: Row) {
    const orgIds = (await this.accountBrands(account)).map((brand) => brand.organizationId);
    const owners = await this.q(`SELECT DISTINCT lower(u.email) AS email FROM organization_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.organization_id = ANY($1::uuid[]) AND m.status='ACTIVE' AND m.role='OWNER'`, [orgIds]);
    return [...new Set([String(account.contact_email).toLowerCase(), ...owners.map((row) => row.email as string)])].filter(Boolean);
  }
  private async email(organizationId: string, recipients: string[], subject: string, html: string) {
    await this.database.platformTransaction(async (client) => {
      await client.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
      for (const recipient of recipients)
        await client.query(`INSERT INTO email_outbox(organization_id,recipient,subject,html) VALUES($1,$2,$3,$4)`, [organizationId, recipient, headerSafe(subject), html]);
    });
  }

  /** Daily: reminders (due −3 d, due day, +7 d) and, only when the policy is on, warn-then-suspend for long-overdue accounts. */
  async runReceivables(identity: AuthIdentity | null, input: ReceivablesRunDto = {}) {
    if (identity) await this.requirePlatform(identity);
    const today = input.today || todayIst();
    const settings = await this.settings();
    const actor = identity?.userId || null;
    if (input.includeDemo && !input.accountId) throw new BadRequestException("includeDemo needs an accountId, so a verification run can't affect other brands.");
    const open = (await this.q(`${INVOICE_SELECT} WHERE i.status='ISSUED' ${input.includeDemo ? "" : "AND NOT i.is_demo"} AND ($1::uuid IS NULL OR i.account_id=$1)`, [input.accountId || null]))
      .map((row) => this.decorate(row, today))
      .filter((row) => row.outstandingPaise > 0);
    const reminders: Row[] = [];
    for (const invoice of open) {
      const kind = reminderFor(invoice.dueDate, today);
      if (!kind) continue;
      const claimed = await this.database.systemQuery(`INSERT INTO billing_reminders(invoice_id,kind) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING invoice_id`, [invoice.id, kind]);
      if (!claimed.rowCount) continue;
      const account = await this.account(invoice.accountId);
      const to = await this.recipients(account);
      const org = await this.primaryOrg(account);
      if (!org) continue;
      const when = kind === "DUE_IN_3" ? "is due in 3 days" : kind === "DUE_TODAY" ? "is due today" : "is 7 days overdue";
      const subject = `${invoice.isDemo ? "[DEMO] " : ""}Invoice ${invoice.number} ${when}`;
      const html = `<p>Hello,</p><p>Invoice <b>${escapeHtml(invoice.number)}</b> for <b>${escapeHtml(account.legal_name)}</b> (service period ${escapeHtml(invoice.periodStart)} to ${escapeHtml(invoice.periodEnd)}) ${escapeHtml(when)}.</p>` +
        `<p>Invoice total: INR ${escapeHtml(formatInr(invoice.totalPaise))}<br>Balance due: <b>INR ${escapeHtml(formatInr(invoice.outstandingPaise))}</b><br>Due date: ${escapeHtml(invoice.dueDate)}</p>` +
        (settings.bankDetails ? `<p>Pay by bank transfer to:<br>${escapeHtml(settings.bankDetails).replace(/\n/g, "<br>")}<br>Please quote ${escapeHtml(invoice.number)} as the reference.</p>` : "") +
        emailButton("View invoices", "/settings/billing") + `<p style="color:#6b716c;font-size:12px">Already paid? Thank you — please ignore this message; payments can take a day to be recorded.</p>`;
      await this.email(org, to, subject, html);
      await this.database.systemQuery(`UPDATE billing_reminders SET recipients=$3 WHERE invoice_id=$1 AND kind=$2`, [invoice.id, kind, to]);
      reminders.push({ invoice: invoice.number, kind, recipients: to.length });
    }
    // Pay-off may have happened since yesterday: lift billing suspensions first.
    const reactivated: Row[] = [];
    for (const account of await this.q(`SELECT DISTINCT a.* FROM billing_accounts a JOIN billing_suspensions s ON s.account_id=a.id WHERE s.reactivated_at IS NULL AND ($1::uuid IS NULL OR a.id=$1)`, [input.accountId || null]))
      reactivated.push(...await this.reconcileSuspensions(account, actor, today, false, !!input.includeDemo));
    // Demo invoices never suspend anyone unless a platform admin explicitly runs the job with includeDemo (verification only).
    const suspension = await this.applySuspensionPolicy(settings, open, today, actor);
    return { today, reminders, reactivated, suspension };
  }

  private async applySuspensionPolicy(settings: Awaited<ReturnType<BillingService["settings"]>>, open: Row[], today: string, actor: string | null) {
    if (!settings.autoSuspendEnabled) return { policy: "OFF", warned: [], suspended: [] };
    const warned: Row[] = [], suspended: Row[] = [];
    const oldest = new Map<string, Row>();
    for (const invoice of open.filter((row) => row.overdue))
      if (!oldest.has(invoice.accountId) || oldest.get(invoice.accountId)!.dueDate > invoice.dueDate) oldest.set(invoice.accountId, invoice);
    for (const [accountId, invoice] of oldest) {
      const daysOverdue = daysBetween(invoice.dueDate, today);
      if (daysOverdue < settings.autoSuspendAfterDays - settings.suspendWarningDays) continue;
      const account = await this.account(accountId);
      for (const brand of await this.accountBrands(account)) {
        const [current] = await this.q(`SELECT id, suspend_on::text AS suspend_on, suspended_at FROM billing_suspensions WHERE organization_id=$1 AND reactivated_at IS NULL`, [brand.organizationId]);
        if (!current) {
          // Warn first, always: suspension can never happen sooner than `suspendWarningDays` after this warning.
          const suspendOn = [addDays(invoice.dueDate, settings.autoSuspendAfterDays), addDays(today, settings.suspendWarningDays)].sort()[1];
          await this.database.systemQuery(`INSERT INTO billing_suspensions(account_id,organization_id,invoice_id,suspend_on) VALUES($1,$2,$3,$4)`, [accountId, brand.organizationId, invoice.id, suspendOn]);
          const to = await this.recipients(account);
          await this.email(brand.organizationId, to, `Action needed: ${brand.name} will be suspended on ${suspendOn}`,
            `<p>Hello,</p><p>Invoice <b>${escapeHtml(invoice.number)}</b> (INR ${escapeHtml(formatInr(invoice.outstandingPaise))} outstanding) is ${escapeHtml(daysOverdue)} days overdue.</p>` +
            `<p>If it is not paid by <b>${escapeHtml(suspendOn)}</b>, access to <b>${escapeHtml(brand.name)}</b> on Northstar will be paused. No data is deleted, and access is restored as soon as the payment is recorded.</p>` +
            emailButton("View invoices", "/settings/billing"));
          await this.audit(actor, account, "BILLING_SUSPENSION_WARNING", "organization", brand.organizationId, null, { invoice: invoice.number, suspendOn, daysOverdue }, brand.organizationId);
          warned.push({ brand: brand.name, suspendOn });
        } else if (!current.suspended_at && today >= current.suspend_on) {
          const result = await this.database.systemQuery(`UPDATE organizations SET status='SUSPENDED', version=version+1 WHERE id=$1 AND status='ACTIVE' RETURNING id`, [brand.organizationId]);
          await this.database.systemQuery(`UPDATE billing_suspensions SET suspended_at=now() WHERE id=$1`, [current.id]);
          await this.audit(actor, account, "BILLING_SUSPENDED", "organization", brand.organizationId, { status: "ACTIVE" }, { status: "SUSPENDED", invoice: invoice.number, daysOverdue, changed: !!result.rowCount }, brand.organizationId);
          suspended.push({ brand: brand.name, changed: !!result.rowCount });
        }
      }
    }
    return { policy: "ON", warned, suspended };
  }

  /** Lifts billing warnings/suspensions of an account once nothing (non-demo) is overdue. Never touches brands suspended for other reasons. */
  private async reconcileSuspensions(account: Row, actor: string | null, today: string, force = false, includeDemo = false) {
    const openRows = await this.q(`SELECT s.id, s.organization_id, s.suspended_at FROM billing_suspensions s WHERE s.account_id=$1 AND s.reactivated_at IS NULL`, [account.id]);
    if (!openRows.length) return [];
    if (!force) {
      const overdue = (await this.q(`${INVOICE_SELECT} WHERE i.account_id=$1 AND i.status='ISSUED' AND ($2 OR NOT i.is_demo)`, [account.id, includeDemo]))
        .map((row) => this.decorate(row, today)).some((row) => row.overdue);
      if (overdue) return [];
    }
    const done: Row[] = [];
    for (const row of openRows) {
      let restored = false;
      if (row.suspended_at)
        restored = !!(await this.database.systemQuery(`UPDATE organizations SET status='ACTIVE', version=version+1 WHERE id=$1 AND status='SUSPENDED' RETURNING id`, [row.organization_id])).rowCount;
      await this.database.systemQuery(`UPDATE billing_suspensions SET reactivated_at=now(), reactivated_reason=$2 WHERE id=$1`, [row.id, force ? "Reactivated by platform admin" : "Overdue invoices settled"]);
      if (row.suspended_at) await this.audit(actor, account, "BILLING_REACTIVATED", "organization", row.organization_id, { status: "SUSPENDED" }, { status: "ACTIVE", restored, force }, row.organization_id);
      done.push({ organizationId: row.organization_id, restored });
    }
    return done;
  }

  async reactivate(identity: AuthIdentity, accountId: string) {
    await this.requirePlatform(identity);
    return { reactivated: await this.reconcileSuspensions(await this.account(accountId), identity.userId, todayIst(), true) };
  }

  // ==== brand owner ========================================================================================================

  async ownerSummary(identity: AuthIdentity) {
    const scope = await this.ownerScope(identity);
    const settings = await this.settings();
    const today = todayIst();
    const live = (await this.liveCounts(today, settings.headcountRule)).get(scope.org.id);
    const since = `${addDays(`${today.slice(0, 7)}-01`, -170).slice(0, 7)}-01`;
    // Usage of the caller's own brand only — even when billed through a group.
    const snaps = await this.q(`SELECT snapshot_date::text AS day, billable_count AS count FROM billing_usage_snapshots WHERE organization_id=$1 AND snapshot_date >= $2 ORDER BY snapshot_date`,
      [scope.org.id, since]);
    const months = new Map<string, number[]>();
    for (const snap of snaps) (months.get(snap.day.slice(0, 7)) || months.set(snap.day.slice(0, 7), []).get(snap.day.slice(0, 7))!).push(snap.count);
    const base = {
      brand: { id: scope.org.id, name: scope.org.name, status: scope.org.status },
      rule: settings.headcountRuleText, liveCount: live?.billable ?? 0,
      thisMonth: snaps.filter((snap) => snap.day.startsWith(today.slice(0, 7))),
      months: [...months.entries()].map(([month, counts]) => ({ month, peak: Math.max(...counts), average: Math.ceil(counts.reduce((a, b) => a + b, 0) / counts.length), days: counts.length })),
      viaGroup: scope.viaGroup,
    };
    if (!scope.account) return { ...base, account: null, subscription: null, invoices: [], creditNotes: [], outstandingPaise: 0, overduePaise: 0, suspension: null, payTo: null };
    const account = scope.account;
    const subscriptions = await this.q(`${this.subscriptionsSql} WHERE s.account_id=$1 ORDER BY s.contract_start`, [account.id]);
    const current = subscriptions.find((s) => s.contractStart <= today && (!s.contractEnd || s.contractEnd >= today)) || subscriptions.find((s) => s.contractStart > today) || null;
    const invoices = (await this.q(`${INVOICE_SELECT} WHERE i.account_id=$1 AND i.status='ISSUED' ORDER BY i.issue_date DESC, i.number DESC`, [account.id]))
      .map((row) => this.decorate(row, today))
      .map(({ seller: _seller, buyer: _buyer, usage: _usage, warnings: _warnings, ...rest }) => rest);
    const creditNotes = await this.q(`SELECT c.id, c.number, c.issue_date::text AS "issueDate", c.reason, c.total_paise::float8 AS "totalPaise", i.number AS "invoiceNumber", c.is_demo AS "isDemo"
      FROM billing_credit_notes c JOIN billing_invoices i ON i.id=c.invoice_id WHERE i.account_id=$1 ORDER BY c.created_at DESC`, [account.id]);
    const [suspension] = await this.q(`SELECT suspend_on::text AS "suspendOn", suspended_at AS "suspendedAt" FROM billing_suspensions WHERE organization_id=$1 AND reactivated_at IS NULL`, [scope.org.id]);
    const brandsOnAccount = (await this.accountBrands(account)).length;
    return {
      ...base,
      account: { kind: account.kind, legalName: account.legal_name, gstin: account.gstin, billingAddress: account.billing_address, stateCode: account.state_code,
        contactName: account.contact_name, contactEmail: account.contact_email, brands: brandsOnAccount },
      subscription: current && {
        planName: current.planName, planCode: current.planCode, includedModules: current.includedModules, pepmPaise: effectivePepm(current as unknown as SubscriptionTerms),
        listPepmPaise: current.pepmPaise, minimumPaise: current.minimumPaise, cycle: current.cycle, usageBasis: current.usageBasis, committedSeats: current.committedSeats,
        contractStart: current.contractStart, contractEnd: current.contractEnd, trialEnds: current.trialDays ? addDays(current.contractStart, current.trialDays - 1) : null,
        estimate: this.estimate(current as unknown as SubscriptionTerms, live?.billable ?? 0),
      },
      invoices, creditNotes,
      outstandingPaise: invoices.reduce((sum, row) => sum + row.outstandingPaise, 0),
      overduePaise: invoices.filter((row) => row.overdue).reduce((sum, row) => sum + row.outstandingPaise, 0),
      suspension: suspension || null,
      payTo: settings.bankDetails ? { bankDetails: settings.bankDetails, legalName: settings.legalName } : null,
    };
  }

  async ownerInvoicePdf(identity: AuthIdentity, id: string) {
    const scope = await this.ownerScope(identity);
    if (!scope.account) throw new NotFoundException("Invoice not found.");
    const [row] = await this.q(`SELECT 1 FROM billing_invoices WHERE id=$1 AND account_id=$2 AND status='ISSUED'`, [id, scope.account.id]);
    if (!row) throw new NotFoundException("Invoice not found.");
    const invoice = await this.loadInvoice(id);
    return { name: this.fileName("invoice", invoice.number, id), body: renderBillingPdf(this.toDocument(invoice, (await this.settings()).bankDetails)) };
  }
  async ownerCreditNotePdf(identity: AuthIdentity, id: string) {
    const scope = await this.ownerScope(identity);
    if (!scope.account) throw new NotFoundException("Credit note not found.");
    const file = await this.creditNoteDocument(id);
    if (file.accountId !== scope.account.id) throw new NotFoundException("Credit note not found.");
    return { name: file.name, body: file.body };
  }

  // ==== logging ============================================================================================================

  private async event(identity: AuthIdentity | null, action: string, entityType: string, entityId: string | null, data: unknown) {
    await this.database.systemQuery(`INSERT INTO billing_events(actor_user_id,action,entity_type,entity_id,data) VALUES($1,$2,$3,$4,$5)`,
      [identity?.userId || null, action, entityType, entityId, JSON.stringify(data ?? null)]);
  }
  /** Brand-visible audit trail (hash-chained audit_log) plus the platform billing log. Jobs act as the platform system user. */
  private async audit(actor: string | null, account: Row, action: string, entityType: string, entityId: string, before: unknown, after: unknown, organizationId?: string) {
    const orgId = organizationId || (await this.primaryOrg(account));
    const userId = actor || (orgId ? (await this.runner.systemIdentity(orgId)).userId : null);
    await this.database.systemQuery(`INSERT INTO billing_events(actor_user_id,action,entity_type,entity_id,data) VALUES($1,$2,$3,$4,$5)`,
      [actor, action, entityType, entityId, JSON.stringify({ accountId: account.id, before: before ?? null, after: after ?? null })]);
    if (!orgId || !userId) return;
    await this.database.systemQuery(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [orgId, userId, action, entityType, entityId, before === null || before === undefined ? null : JSON.stringify(before), JSON.stringify(after ?? null)]);
  }
}

export function previousPeriod(today = todayIst()) {
  const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7));
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

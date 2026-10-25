import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException, type OnModuleInit } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import type { CreateStructureDto, PreviewStructureDto, UpdateProfileDto, UpdateSettingsDto } from "./payroll.dto";
import {
  PII_FIELDS, audit, auditRead, decryptProfileField, isPayrollAdmin, loadSettings, maskedField, monthLabel, num, profileContext, requireAdmin,
  statutoryFlags, type PiiField, type Settings, type StatutoryFlags,
} from "./payroll.shared";
import { FieldDecryptError, assertFieldCryptoConfigured, sealField } from "../security/field-crypto";
import { DISCLAIMER, PT_STATES, RULESET, computeEsi, computePf, computePt, isMetroLocation, parsePeriod, resolveState, type PtCategory } from "./statutory";
import { buildStructure } from "./structure";
import { TAX_RULES, projectTds, type Declarations, type Regime } from "./tax-engine";
import { payslipHtml } from "./documents";

/** Payroll profile as the API returns it. pan/uan/esiNumber/bankAccount are always MASKED (from the stored last-4 hint);
 *  full values are only available through the audited reveal endpoint or inside statutory/bank exports. */
export type Profile = {
  stateCode: string | null; taxRegime: Regime; pan: string | null; uan: string | null; esiNumber: string | null;
  bankName: string | null; bankAccount: string | null; ifsc: string | null; pfApplicable: boolean; ptCategory: PtCategory;
  declarations: Declarations; version: number;
  /** EPS eligibility, disability (ESI), VPF rate, international worker, age category — payroll_profiles.statutory_flags. */
  statutoryFlags: StatutoryFlags;
};
export const presentProfile = (row: any): Profile => ({
  stateCode: row?.state_code || null, taxRegime: row?.tax_regime || "NEW", pan: maskedField(row, "pan"), uan: maskedField(row, "uan"),
  esiNumber: maskedField(row, "esiNumber"), bankName: row?.bank_name || null, bankAccount: maskedField(row, "bankAccount"), ifsc: row?.ifsc || null,
  pfApplicable: row ? row.pf_applicable : true, ptCategory: row?.pt_category || "STANDARD", declarations: row?.declarations || {}, version: row?.version || 0,
  statutoryFlags: statutoryFlags(row?.statutory_flags),
});
/** presentProfile is already masked; kept as a named step for readability at call sites. */
const maskedProfile = (profile: Profile) => profile;

export const presentStructure = (row: any) => row && ({
  id: row.id, employeeId: row.employee_id, effectiveFrom: row.effective_from_text, annualCtc: num(row.annual_ctc), isMetro: row.is_metro,
  template: row.template, components: row.components, fixedMonthlyGross: num(row.fixed_monthly_gross), monthlyCtc: num(row.monthly_ctc),
  annualVariable: num(row.annual_variable), rulesetVersion: row.ruleset_version, reason: row.reason, notes: row.notes,
  createdBy: row.created_by_name || null, createdAt: row.created_at,
});
const STRUCTURE_COLUMNS = `s.*, to_char(s.effective_from,'YYYY-MM-DD') AS effective_from_text`;

@Injectable()
export class PayrollService implements OnModuleInit {
  constructor(private readonly database: DatabaseService) {}

  /** Refuse to start without field-encryption keys (PAN/UAN/ESI/bank are stored encrypted). */
  onModuleInit() { assertFieldCryptoConfigured(); }

  meta(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const settings = await loadSettings(client, identity.organizationId);
      return {
        ruleset: { ...RULESET, pt: { ...RULESET.pt, states: Object.values(PT_STATES).map(({ code, name, note, source, frequency }) => ({ code, name, note, source, frequency })) } },
        tax: { version: TAX_RULES.version, newStandardDeduction: TAX_RULES.newStandardDeduction, rebateLimit: TAX_RULES.rebateLimit },
        disclaimer: DISCLAIMER, settings: isPayrollAdmin(identity) ? settings : null,
        viewer: { employeeId: identity.employeeId, roles: identity.roles, canManage: isPayrollAdmin(identity) },
      };
    });
  }

  updateSettings(identity: AuthIdentity, input: UpdateSettingsDto) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const before = await loadSettings(client, identity.organizationId);
      if (before.version !== input.version) throw new ConflictException("Payroll settings changed since you opened them. Reload and try again.");
      await client.query(
        `INSERT INTO payroll_settings(organization_id,pf_wage_mode,default_state,include_expenses,pf_establishment_code,esi_employer_code,debit_account,statutory_options,version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)
         ON CONFLICT(organization_id) DO UPDATE SET pf_wage_mode=$2, default_state=$3, include_expenses=$4, pf_establishment_code=$5,
           esi_employer_code=$6, debit_account=$7, statutory_options=$8, version=payroll_settings.version+1, updated_at=now()`,
        [identity.organizationId, input.pfWageMode, input.defaultState, input.includeExpenses, input.pfEstablishmentCode || null, input.esiEmployerCode || null, input.debitAccount || null,
          JSON.stringify({
            labourCodeWages: input.labourCodeWages ?? before.labourCodeWages, lwfEnabled: input.lwfEnabled ?? before.lwfEnabled,
            minimumWageMonthly: input.minimumWageMonthly === undefined ? before.minimumWageMonthly : input.minimumWageMonthly,
          })]);
      // Statutory switches change the numbers of runs not yet submitted.
      await this.markRunsStale(client, identity, null);
      const after = await loadSettings(client, identity.organizationId);
      await audit(client, identity, "PAYROLL_SETTINGS_UPDATED", "payroll_settings", identity.organizationId, before, after);
      return after;
    });
  }

  // ------------------------------------------------------------ structures

  listStructures(identity: AuthIdentity, search?: string) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const settings = await loadSettings(client, identity.organizationId);
      const rows = (await client.query(
        `SELECT e.id, e.employee_number, e.full_name, e.department, e.designation, e.location, to_char(e.joining_date,'YYYY-MM-DD') AS joining_date,
                cur.id AS structure_id, cur.annual_ctc, cur.fixed_monthly_gross, to_char(cur.effective_from,'YYYY-MM-DD') AS effective_from,
                nxt.effective_from AS upcoming_from, nxt.annual_ctc AS upcoming_ctc,
                (SELECT count(*)::int FROM salary_structures h WHERE h.organization_id=e.organization_id AND h.employee_id=e.id) AS revisions,
                pp.state_code, pp.tax_regime, pp.bank_account_enc IS NOT NULL AS has_bank, pp.pan_enc IS NOT NULL AS has_pan
           FROM employees e
           LEFT JOIN LATERAL (SELECT * FROM salary_structures s WHERE s.organization_id=e.organization_id AND s.employee_id=e.id AND s.effective_from<=current_date
                               ORDER BY s.effective_from DESC LIMIT 1) cur ON true
           LEFT JOIN LATERAL (SELECT to_char(s.effective_from,'YYYY-MM-DD') AS effective_from, s.annual_ctc FROM salary_structures s
                               WHERE s.organization_id=e.organization_id AND s.employee_id=e.id AND s.effective_from>current_date ORDER BY s.effective_from LIMIT 1) nxt ON true
           LEFT JOIN payroll_profiles pp ON pp.organization_id=e.organization_id AND pp.employee_id=e.id
          WHERE e.organization_id=$1 AND e.status='ACTIVE'
            AND ($2::text IS NULL OR e.full_name ILIKE '%'||$2||'%' OR e.employee_number ILIKE '%'||$2||'%' OR e.department ILIKE '%'||$2||'%')
          ORDER BY e.employee_number`, [identity.organizationId, search?.trim() || null])).rows;
      return {
        items: rows.map((row) => ({
          id: row.id, number: row.employee_number, name: row.full_name, department: row.department, designation: row.designation, location: row.location,
          joiningDate: row.joining_date, state: resolveState(row.state_code, row.location, settings.defaultState).state, taxRegime: row.tax_regime || "NEW",
          hasBank: row.has_bank === true, hasPan: row.has_pan === true, revisions: row.revisions,
          current: row.structure_id ? { id: row.structure_id, annualCtc: num(row.annual_ctc), fixedMonthlyGross: num(row.fixed_monthly_gross), effectiveFrom: row.effective_from } : null,
          upcoming: row.upcoming_from ? { effectiveFrom: row.upcoming_from, annualCtc: num(row.upcoming_ctc) } : null,
        })),
        settings,
      };
    });
  }

  employeeStructures(identity: AuthIdentity, employeeId: string) {
    const self = employeeId === identity.employeeId;
    if (!self && !isPayrollAdmin(identity)) throw new ForbiddenException("You can only view your own salary structure.");
    return this.database.tenantTransaction(identity, async (client) => {
      const employee = await this.employee(client, identity, employeeId);
      const settings = await loadSettings(client, identity.organizationId);
      const profile = presentProfile((await client.query(`SELECT * FROM payroll_profiles WHERE organization_id=$1 AND employee_id=$2`, [identity.organizationId, employeeId])).rows[0]);
      const history = (await client.query(
        `SELECT ${STRUCTURE_COLUMNS}, c.full_name AS created_by_name,
                EXISTS(SELECT 1 FROM payroll_run_lines l JOIN payroll_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
                        WHERE l.organization_id=s.organization_id AND l.structure_id=s.id AND r.status IN ('PUBLISHED','LOCKED')) AS used
           FROM salary_structures s LEFT JOIN employees c ON c.id=s.created_by AND c.organization_id=s.organization_id
          WHERE s.organization_id=$1 AND s.employee_id=$2 ORDER BY s.effective_from DESC`, [identity.organizationId, employeeId])).rows;
      const today = new Date().toISOString().slice(0, 10);
      const items = history.map((row) => ({ ...presentStructure(row), used: row.used, current: false, upcoming: row.effective_from_text > today }));
      const current = items.find((item) => item.effectiveFrom <= today);
      if (current) current.current = true;
      const state = resolveState(profile.stateCode, employee.location, settings.defaultState);
      if (!self) await auditRead(client, identity, "PII_READ", "employee", employeeId, { view: "payroll_profile", masked: true });
      return {
        employee: { ...employee, state: state.state, stateSource: state.source, metro: isMetroLocation(employee.location) },
        profile: maskedProfile(profile),
        structures: items, settings: isPayrollAdmin(identity) ? settings : null,
        lockedThrough: await this.lockedThrough(client, identity),
      };
    });
  }

  preview(identity: AuthIdentity, input: PreviewStructureDto) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const settings = await loadSettings(client, identity.organizationId);
      let location: string | null = null, profile = presentProfile(null);
      if (input.employeeId) {
        location = (await this.employee(client, identity, input.employeeId)).location;
        profile = presentProfile((await client.query(`SELECT * FROM payroll_profiles WHERE organization_id=$1 AND employee_id=$2`, [identity.organizationId, input.employeeId])).rows[0]);
      }
      return this.previewStructure(input, settings, profile, location);
    });
  }

  /** Structure plus an indicative monthly take-home (full month, no LOP, no one-time items). */
  previewStructure(input: PreviewStructureDto, settings: Settings, profile: Profile, location: string | null) {
    const isMetro = input.isMetro ?? isMetroLocation(location);
    const pfApplicable = input.pfApplicable ?? profile.pfApplicable;
    // Rules in force on the structure's effective date (preview: the date chosen in the form, else today).
    const asOf = (input as { effectiveFrom?: string }).effectiveFrom || new Date().toISOString().slice(0, 10);
    const period = asOf.slice(0, 7);
    const flags = profile.statutoryFlags;
    const built = buildStructure({ annualCtc: input.annualCtc, template: input.template, isMetro, pfWageMode: settings.pfWageMode, pfApplicable, asOf });
    const state = input.stateCode || resolveState(profile.stateCode, location, settings.defaultState).state;
    const regime = input.taxRegime || profile.taxRegime;
    const basic = built.monthly.BASIC, gross = built.fixedMonthlyGross;
    const pf = computePf({
      basicEarned: basic, applicable: pfApplicable, wageMode: settings.pfWageMode, period, totalRemuneration: gross, labourCodeMode: settings.labourCodeWages,
      epsEligible: flags.epsEligible, vpfRate: flags.vpfRate, internationalWorker: flags.internationalWorker,
    });
    const esi = computeEsi({ covered: built.esiApplicable, wages: gross, payableDays: 30, period });
    // PT for each month of the financial year the structure starts in, with that month's rules.
    const fyStart = Number(period.slice(5, 7)) >= 4 ? Number(period.slice(0, 4)) : Number(period.slice(0, 4)) - 1;
    const fyMonth = (month: number) => `${month >= 4 ? fyStart : fyStart + 1}-${String(month).padStart(2, "0")}`;
    let annualPt = 0;
    for (let month = 1; month <= 12; month++) annualPt += computePt(state, gross, month, profile.ptCategory, fyMonth(month)).amount;
    const typicalPt = computePt(state, gross, Number(period.slice(5, 7)), profile.ptCategory, period).amount;
    const tax = projectTds({
      regime, monthsRemainingIncludingCurrent: 12, fyStartYear: fyStart, priorTaxable: 0, priorTds: 0, priorPf: 0, priorPt: 0,
      currentRegular: gross, currentOneTime: 0, currentPf: pf.employee + pf.vpf, currentPt: typicalPt,
      futureMonthlyTaxable: gross, futureMonthlyPf: pf.employee + pf.vpf, futurePt: annualPt - typicalPt,
      annualBasic: basic * 12, annualHra: built.monthly.HRA * 12, metro: isMetro,
      declarations: { ...profile.declarations, ageCategory: profile.declarations.ageCategory || flags.ageCategory },
    });
    const monthlyTds = Math.round(tax.annualLiability / 12);
    const deductions = pf.employee + pf.vpf + esi.employee + typicalPt + monthlyTds;
    return {
      ...built, state, stateName: PT_STATES[state]?.name || state, regime,
      takeHome: {
        gross, pfEmployee: pf.employee, vpf: pf.vpf, esiEmployee: esi.employee, pt: typicalPt, annualPt, tds: monthlyTds, deductions, net: gross - deductions,
        annualTax: tax.annualLiability, taxableIncome: tax.taxableIncome,
      },
    };
  }

  async createStructure(identity: AuthIdentity, input: CreateStructureDto) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const employee = await this.employee(client, identity, input.employeeId);
      const settings = await loadSettings(client, identity.organizationId);
      const profile = presentProfile((await client.query(`SELECT * FROM payroll_profiles WHERE organization_id=$1 AND employee_id=$2`, [identity.organizationId, input.employeeId])).rows[0]);
      if (input.effectiveFrom < employee.joiningDate) throw new BadRequestException(`The structure cannot start before the joining date (${employee.joiningDate}).`);
      if (!input.effectiveFrom.endsWith("-01") && input.effectiveFrom !== employee.joiningDate)
        throw new BadRequestException("Revisions take effect from the 1st of a month (or the joining date). Pay mid-month differences as arrears.");
      const locked = await this.lockedThrough(client, identity);
      if (locked && input.effectiveFrom.slice(0, 7) <= locked)
        throw new ConflictException(`Payroll is published through ${monthLabel(locked)}. Back-dated revisions must start after that — pay the difference as salary arrears in the next run.`);
      const pending = (await client.query(
        `SELECT period, status FROM payroll_runs WHERE organization_id=$1 AND status IN ('SUBMITTED','APPROVED') AND period >= $2 ORDER BY period LIMIT 1`,
        [identity.organizationId, input.effectiveFrom.slice(0, 7)])).rows[0];
      if (pending) throw new ConflictException(`The ${monthLabel(pending.period)} run is ${pending.status.toLowerCase()} — send it back before changing salaries it covers.`);
      const built = this.previewStructure(input, settings, profile, employee.location);
      if (built.errors.length) throw new BadRequestException(built.errors.join(" "));
      let row;
      try {
        row = (await client.query(
          `INSERT INTO salary_structures(organization_id,employee_id,effective_from,annual_ctc,is_metro,template,components,fixed_monthly_gross,monthly_ctc,annual_variable,ruleset_version,reason,notes,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${STRUCTURE_COLUMNS.replace(/s\./g, "")}`,
          [identity.organizationId, input.employeeId, input.effectiveFrom, built.annualCtc, built.isMetro, JSON.stringify(built.template), JSON.stringify(built.components),
            built.fixedMonthlyGross, built.monthlyCtc, built.annualVariable, RULESET.version, input.reason || "REVISION", input.notes?.trim() || null, identity.employeeId])).rows[0];
      } catch (error: any) {
        if (error?.code === "23505") throw new ConflictException(`A structure effective ${input.effectiveFrom} already exists for this employee.`);
        throw error;
      }
      await this.markRunsStale(client, identity, input.effectiveFrom.slice(0, 7));
      await audit(client, identity, "SALARY_STRUCTURE_CREATED", "salary_structure", row.id, null,
        { employeeId: input.employeeId, effectiveFrom: input.effectiveFrom, annualCtc: built.annualCtc, fixedMonthlyGross: built.fixedMonthlyGross, template: built.template });
      return { ...presentStructure(row), warnings: built.warnings };
    });
  }

  deleteStructure(identity: AuthIdentity, id: string) {
    requireAdmin(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(`SELECT ${STRUCTURE_COLUMNS} FROM salary_structures s WHERE s.organization_id=$1 AND s.id=$2 FOR UPDATE`, [identity.organizationId, id])).rows[0];
      if (!row) throw new NotFoundException("Salary structure not found.");
      const used = (await client.query(
        `SELECT r.period, r.status FROM payroll_run_lines l JOIN payroll_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
          WHERE l.organization_id=$1 AND l.structure_id=$2 AND r.status IN ('SUBMITTED','APPROVED','PUBLISHED','LOCKED') LIMIT 1`, [identity.organizationId, id])).rows[0];
      if (used) throw new ConflictException(`This structure was used by the ${monthLabel(used.period)} run (${used.status.toLowerCase()}) and is part of the pay record. Add a correcting revision instead.`);
      await client.query(`UPDATE payroll_run_lines SET structure_id=NULL WHERE organization_id=$1 AND structure_id=$2`, [identity.organizationId, id]);
      await client.query(`DELETE FROM salary_structures WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id]);
      await this.markRunsStale(client, identity, row.effective_from_text.slice(0, 7));
      await audit(client, identity, "SALARY_STRUCTURE_DELETED", "salary_structure", id, presentStructure(row), null);
      return { deleted: true };
    });
  }

  updateProfile(identity: AuthIdentity, employeeId: string, input: UpdateProfileDto) {
    requireAdmin(identity);
    const org = identity.organizationId;
    return this.database.tenantTransaction(identity, async (client) => {
      await this.employee(client, identity, employeeId);
      const existing = (await client.query(`SELECT * FROM payroll_profiles WHERE organization_id=$1 AND employee_id=$2 FOR UPDATE`, [org, employeeId])).rows[0];
      const before = presentProfile(existing);
      if (before.version !== input.version) throw new ConflictException("This payroll profile changed since you opened it. Reload and try again.");
      const pick = <K extends keyof Profile>(key: K, value: Profile[K] | undefined) => (value === undefined ? before[key] : value);
      // Identifiers: undefined keeps the stored ciphertext, null clears it, a value is re-encrypted for this brand + employee.
      const sealed = {} as Record<PiiField, { enc: string | null; hash: string | null; last4: string | null }>;
      const changed: PiiField[] = [];
      for (const field of Object.keys(PII_FIELDS) as PiiField[]) {
        const { column, kind } = PII_FIELDS[field];
        const kept = { enc: existing?.[`${column}_enc`] ?? null, hash: existing?.[`${column}_hash`] ?? null, last4: existing?.[`${column}_last4`] ?? null };
        const value = input[field];
        if (value === undefined) { sealed[field] = kept; continue; }
        const next = sealField(kind, value, profileContext(org, employeeId, column));
        if (next.hash === kept.hash) { sealed[field] = kept; continue; }
        sealed[field] = next; changed.push(field);
      }
      if (changed.includes("pan") && sealed.pan.hash) {
        const duplicate = (await client.query(
          `SELECT e.employee_number, e.full_name FROM payroll_profiles p JOIN employees e ON e.id=p.employee_id AND e.organization_id=p.organization_id
            WHERE p.organization_id=$1 AND p.pan_hash=$2 AND p.employee_id<>$3 LIMIT 1`, [org, sealed.pan.hash, employeeId])).rows[0];
        if (duplicate) throw new ConflictException(`This PAN is already on file for ${duplicate.full_name} (${duplicate.employee_number}). Each employee needs their own PAN.`);
      }
      const plain = {
        stateCode: pick("stateCode", input.stateCode), taxRegime: pick("taxRegime", input.taxRegime),
        bankName: input.bankName === undefined ? before.bankName : input.bankName?.trim() || null, ifsc: pick("ifsc", input.ifsc),
        pfApplicable: pick("pfApplicable", input.pfApplicable), ptCategory: pick("ptCategory", input.ptCategory),
        declarations: input.declarations ? { ...input.declarations } : before.declarations,
        // Partial update: only the flags sent change; the rest keep their stored (or default) values.
        statutoryFlags: statutoryFlags({ ...before.statutoryFlags, ...Object.fromEntries(Object.entries(input.statutoryFlags || {}).filter(([, value]) => value !== undefined)) }),
      };
      const row = (await client.query(
        `INSERT INTO payroll_profiles(organization_id,employee_id,state_code,tax_regime,bank_name,ifsc,pf_applicable,pt_category,declarations,statutory_flags,version,
            pan_enc,pan_hash,pan_last4,uan_enc,uan_hash,uan_last4,esi_number_enc,esi_number_hash,esi_number_last4,bank_account_enc,bank_account_hash,bank_account_last4)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$22,1,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT(organization_id,employee_id) DO UPDATE SET state_code=$3,tax_regime=$4,bank_name=$5,ifsc=$6,pf_applicable=$7,pt_category=$8,declarations=$9,statutory_flags=$22,
           pan_enc=$10,pan_hash=$11,pan_last4=$12,uan_enc=$13,uan_hash=$14,uan_last4=$15,esi_number_enc=$16,esi_number_hash=$17,esi_number_last4=$18,
           bank_account_enc=$19,bank_account_hash=$20,bank_account_last4=$21,version=payroll_profiles.version+1,updated_at=now()
         RETURNING *`,
        [org, employeeId, plain.stateCode, plain.taxRegime, plain.bankName, plain.ifsc, plain.pfApplicable, plain.ptCategory, JSON.stringify(plain.declarations),
          ...(Object.keys(PII_FIELDS) as PiiField[]).flatMap((field) => [sealed[field].enc, sealed[field].hash, sealed[field].last4]), JSON.stringify(plain.statutoryFlags)])).rows[0];
      await this.markRunsStale(client, identity, null);
      const next = presentProfile(row);
      // Identifiers are masked in the audit trail.
      await audit(client, identity, "PAYROLL_PROFILE_UPDATED", "employee", employeeId, maskedProfile(before), { ...maskedProfile(next), identifiersChanged: changed });
      return next;
    });
  }

  /** Full value of one identifier for HR/payroll admins (or the employee themself). Every reveal is audited. */
  reveal(identity: AuthIdentity, employeeId: string, field: PiiField, reason?: string) {
    const self = employeeId === identity.employeeId;
    if (!self && !isPayrollAdmin(identity)) throw new ForbiddenException("Only payroll or HR administrators can reveal another employee's identifiers.");
    return this.database.tenantTransaction(identity, async (client) => {
      await this.employee(client, identity, employeeId);
      const row = (await client.query(`SELECT * FROM payroll_profiles WHERE organization_id=$1 AND employee_id=$2`, [identity.organizationId, employeeId])).rows[0];
      let value: string | null;
      try { value = decryptProfileField(row, field); } catch (error) {
        if (error instanceof FieldDecryptError) throw new UnprocessableEntityException("The stored value failed its integrity check (it does not belong to this employee or brand). Re-enter it.");
        throw error;
      }
      if (!value) throw new NotFoundException("Nothing is on file for this field.");
      await auditRead(client, identity, "PII_REVEALED", "employee", employeeId, { table: "payroll_profiles", field, self, reason: reason?.trim() || null });
      return { field, value, masked: maskedField(row, field) };
    });
  }


  // ------------------------------------------------------------ employee self-service

  me(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const employee = await this.employee(client, identity, identity.employeeId);
      const settings = await loadSettings(client, identity.organizationId);
      const profile = presentProfile((await client.query(`SELECT * FROM payroll_profiles WHERE organization_id=$1 AND employee_id=$2`, [identity.organizationId, identity.employeeId])).rows[0]);
      const structure = presentStructure((await client.query(
        `SELECT ${STRUCTURE_COLUMNS} FROM salary_structures s WHERE s.organization_id=$1 AND s.employee_id=$2 AND s.effective_from<=current_date ORDER BY s.effective_from DESC LIMIT 1`,
        [identity.organizationId, identity.employeeId])).rows[0]);
      const payslips = (await client.query(
        `SELECT id, period, gross::float, deductions::float, net::float, published_at, breakdown IS NOT NULL AS detailed,
                (breakdown->'totals'->>'reimbursements')::float AS reimbursements, (breakdown->'statutory'->'tds'->>'amount')::float AS tds,
                (breakdown->'statutory'->'pf'->>'employee')::float AS pf, (breakdown->'days'->>'payableDays')::float AS payable_days,
                (breakdown->'days'->>'lopDays')::float AS lop_days, breakdown->'tax' AS tax, breakdown->'ytd' AS ytd
           FROM payslips WHERE organization_id=$1 AND employee_id=$2 AND status='PUBLISHED' ORDER BY period DESC LIMIT 36`,
        [identity.organizationId, identity.employeeId])).rows;
      const fy = parsePeriod(new Date().toISOString().slice(0, 7));
      const inFy = payslips.filter((row) => row.period >= fy.fyFirstPeriod && row.period <= fy.fyLastPeriod);
      const ytd = inFy.reduce((acc, row) => ({
        gross: acc.gross + num(row.gross), deductions: acc.deductions + num(row.deductions), net: acc.net + num(row.net),
        tds: acc.tds + num(row.tds), pf: acc.pf + num(row.pf), reimbursements: acc.reimbursements + num(row.reimbursements), months: acc.months + 1,
      }), { gross: 0, deductions: 0, net: 0, tds: 0, pf: 0, reimbursements: 0, months: 0 });
      const latestDetailed = payslips.find((row) => row.detailed);
      return {
        employee: { ...employee, state: resolveState(profile.stateCode, employee.location, settings.defaultState).state },
        profile: maskedProfile(profile), structure, fiscalYear: fy.fyLabel, ytd,
        taxProjection: latestDetailed?.tax ? { ...latestDetailed.tax, period: latestDetailed.period } : null,
        payslips: payslips.map((row) => ({
          id: row.id, period: row.period, label: monthLabel(row.period), gross: num(row.gross), deductions: num(row.deductions), net: num(row.net),
          tds: num(row.tds), payableDays: row.payable_days, lopDays: row.lop_days, publishedAt: row.published_at, detailed: row.detailed,
        })),
        disclaimer: DISCLAIMER,
      };
    });
  }

  payslip(identity: AuthIdentity, period: string, employeeId?: string, auditAction?: "PAYSLIP_DOWNLOADED") {
    const target = employeeId || identity.employeeId;
    if (target !== identity.employeeId && !isPayrollAdmin(identity)) throw new ForbiddenException("You can only view your own payslips.");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new BadRequestException("Period must be YYYY-MM.");
    return this.database.tenantTransaction(identity, async (client) => {
      const employee = await this.employee(client, identity, target);
      const row = (await client.query(
        `SELECT p.id, p.period, p.gross::float, p.deductions::float, p.net::float, p.status, p.published_at, p.breakdown, p.payroll_run_id, o.name AS organization_name
           FROM payslips p JOIN organizations o ON o.id=p.organization_id
          WHERE p.organization_id=$1 AND p.employee_id=$2 AND p.period=$3 AND p.status='PUBLISHED'`, [identity.organizationId, target, period])).rows[0];
      if (!row) throw new NotFoundException(`No published payslip for ${monthLabel(period)}.`);
      // Admins opening someone else's payslip, and every document download, leave a read-audit row (own on-screen views do not).
      const action = auditAction || (target !== identity.employeeId ? "PAYSLIP_VIEWED" : null);
      if (action) await auditRead(client, identity, action, "payslip", row.id, { employeeId: target, period, self: target === identity.employeeId });
      const periods = (await client.query(`SELECT period FROM payslips WHERE organization_id=$1 AND employee_id=$2 AND status='PUBLISHED' ORDER BY period DESC LIMIT 36`,
        [identity.organizationId, target])).rows.map((item) => item.period);
      return {
        id: row.id, period: row.period, label: monthLabel(row.period), gross: row.gross, deductions: row.deductions, net: row.net,
        publishedAt: row.published_at, runId: row.payroll_run_id, organizationName: row.organization_name, breakdown: row.breakdown,
        employee, periods, disclaimer: DISCLAIMER,
      };
    });
  }

  async payslipDocument(identity: AuthIdentity, period: string, employeeId?: string) {
    const slip = await this.payslip(identity, period, employeeId, "PAYSLIP_DOWNLOADED");
    return { html: payslipHtml(slip), fileName: `payslip-${slip.employee.number}-${slip.period}.html` };
  }

  // ------------------------------------------------------------ helpers

  async employee(client: PoolClient, identity: AuthIdentity, employeeId: string) {
    const row = (await client.query(
      `SELECT id, employee_number, full_name, work_email, department, designation, location, status, to_char(joining_date,'YYYY-MM-DD') AS joining_date
         FROM employees WHERE organization_id=$1 AND id=$2`, [identity.organizationId, employeeId])).rows[0];
    if (!row) throw new NotFoundException("Employee not found.");
    return { id: row.id as string, number: row.employee_number as string, name: row.full_name as string, email: row.work_email as string, department: row.department as string | null,
      designation: row.designation as string | null, location: row.location as string | null, status: row.status as string, joiningDate: row.joining_date as string };
  }

  /** Latest period with a published or locked run — salary history up to it is part of the pay record. */
  async lockedThrough(client: PoolClient, identity: AuthIdentity): Promise<string | null> {
    return (await client.query(`SELECT max(period) AS period FROM payroll_runs WHERE organization_id=$1 AND status IN ('PUBLISHED','LOCKED')`, [identity.organizationId])).rows[0]?.period || null;
  }

  /** Salary or profile data changed: calculated runs covering the change must be recalculated before submission. */
  async markRunsStale(client: PoolClient, identity: AuthIdentity, fromPeriod: string | null) {
    await client.query(
      `UPDATE payroll_runs SET needs_recalc=true, updated_at=now() WHERE organization_id=$1 AND status='CALCULATED' AND ($2::text IS NULL OR period >= $2)`,
      [identity.organizationId, fromPeriod]);
  }
}

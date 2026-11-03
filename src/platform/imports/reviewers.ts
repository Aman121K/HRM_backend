/**
 * Server-side validation for each switch-over import kind. A reviewer reads the CSV and the current state of the brand
 * (inside the caller's tenant transaction) and returns row-level errors/warnings, a preview of what will change and the
 * normalized operations the commit applies. Commit always re-runs the reviewer inside its own locked transaction.
 */
import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { parseCsv } from "../people/people-admin.service";
import { PII_FIELDS, loadSettings, monthLabel, profileContext, statutoryFlags, type PiiField, type Settings } from "../payroll/payroll.shared";
import { presentProfile, type PayrollService } from "../payroll/payroll.service";
import { PT_STATES, addMonths, parsePeriod } from "../payroll/statutory";
import { MINIMUM_WAGES } from "../payroll/rules";
import { blindIndex, mask as maskSensitive, normalize as normalizeSensitive, sealField } from "../security/field-crypto";
import { COLUMNS, type ImportKind } from "./templates";

export const MAX_ROWS = 5000;
export type Outcome = "CREATE" | "UPDATE" | "UNCHANGED" | "INVALID";
export type ReviewRow = {
  row: number; employeeNumber: string; employeeName: string | null; outcome: Outcome;
  /** What will change (identifiers masked). */
  changes: Record<string, unknown>; errors: string[]; warnings: string[];
};
export type Review<Op> = { rows: ReviewRow[]; ops: Op[]; totals: Record<string, unknown>; options: Record<string, unknown> };
export type Options = { cutoverDate?: string | null; fiscalYear?: string | null; lastPaidPeriod?: string | null };

type Employee = {
  id: string; employee_number: string; full_name: string; status: string; joining_date: string; department: string | null;
  designation: string | null; location: string | null; manager_id: string | null;
};

// ------------------------------------------------------------ parsing helpers

export const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const isPeriod = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
/** Money/number cell: blank → fallback, commas / ₹ / spaces stripped; null when not a number. */
export function parseNumber(raw: string, fallback: number | undefined = 0): number | null | undefined {
  const text = raw.replace(/[₹,\s]/g, "");
  if (!text) return fallback;
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return null;
  return Number(text);
}
function parseYn(raw: string): boolean | undefined | "invalid" {
  const text = raw.trim().toUpperCase();
  if (!text) return undefined;
  if (["Y", "YES", "TRUE", "1"].includes(text)) return true;
  if (["N", "NO", "FALSE", "0"].includes(text)) return false;
  return "invalid";
}
const yearsBetween = (from: string, to: string) => {
  const a = new Date(`${from}T00:00:00Z`), b = new Date(`${to}T00:00:00Z`);
  let years = b.getUTCFullYear() - a.getUTCFullYear();
  if (b.getUTCMonth() < a.getUTCMonth() || (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate())) years--;
  return years;
};
const monthsBetween = (from: string, to: string) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;

/** Parses the CSV, checks the header against the kind's columns and returns rows as column→value maps. */
export function readCsv(kind: Exclude<ImportKind, "PAYSLIPS">, csv: string) {
  const parsed = parseCsv(csv);
  if (!parsed.length) throw new BadRequestException("The CSV file is empty.");
  const header = parsed[0].map((cell) => cell.trim().toLowerCase());
  const columns = COLUMNS[kind];
  const missing = columns.filter((column) => column.required && !header.includes(column.name)).map((column) => column.name);
  if (missing.length) throw new BadRequestException(`Missing required columns: ${missing.join(", ")}. Download the template for this step.`);
  const unknown = header.filter((cell) => cell && !columns.some((column) => column.name === cell));
  if (unknown.length) throw new BadRequestException(`Unknown columns: ${unknown.join(", ")}. Use the column names from the template.`);
  if (parsed.length - 1 > MAX_ROWS) throw new BadRequestException(`Import at most ${MAX_ROWS} rows per file.`);
  if (parsed.length < 2) throw new BadRequestException("The file has a header but no data rows.");
  return parsed.slice(1).map((values, index) => ({
    row: index + 2,
    get: (name: string) => { const at = header.indexOf(name); return at < 0 ? "" : (values[at] || "").trim(); },
    has: (name: string) => header.includes(name),
  }));
}

async function loadEmployees(client: PoolClient, organizationId: string) {
  const rows = (await client.query(
    `SELECT id, employee_number, full_name, status, to_char(joining_date,'YYYY-MM-DD') AS joining_date, department, designation, location, manager_id
       FROM employees WHERE organization_id=$1`, [organizationId])).rows as Employee[];
  return { byNumber: new Map(rows.map((row) => [row.employee_number, row])), byId: new Map(rows.map((row) => [row.id, row])) };
}

const row0 = (row: number, employeeNumber: string, employee?: Employee): ReviewRow =>
  ({ row, employeeNumber, employeeName: employee?.full_name || null, outcome: "CREATE", changes: {}, errors: [], warnings: [] });
const finish = (item: ReviewRow, changed: boolean, update = true) => {
  item.outcome = item.errors.length ? "INVALID" : !changed ? "UNCHANGED" : update ? "UPDATE" : "CREATE";
};

// ------------------------------------------------------------ 1. employee master

export type MasterOp = {
  employeeId: string; employeeNumber: string;
  employee: Partial<Record<"department" | "designation" | "location" | "joining_date", string | null>> & { manager_number?: string | null };
  details: Partial<Record<"date_of_birth" | "gender" | "employment_type", string>>;
  profile: Partial<{ state_code: string; tax_regime: string; bank_name: string; ifsc: string; pf_applicable: boolean; pt_category: string; statutory_flags: Record<string, unknown> }>;
  /** Sealed identifiers (ciphertext, blind index, last-4) — never plaintext. */
  sealed: Partial<Record<PiiField, { enc: string | null; hash: string | null; last4: string | null }>>;
};

const GENDERS = ["MALE", "FEMALE", "OTHER", "UNDISCLOSED"];
const EMPLOYMENT = ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN", "CONSULTANT"];
const PATTERNS: Record<PiiField, { pattern: RegExp; message: string }> = {
  pan: { pattern: /^[A-Z]{5}[0-9]{4}[A-Z]$/, message: "PAN must be 5 letters, 4 digits and a letter (e.g. ABCPE1234F)" },
  uan: { pattern: /^\d{12}$/, message: "UAN must be 12 digits" },
  esiNumber: { pattern: /^(\d{10}|\d{17})$/, message: "ESI IP number must be 10 or 17 digits" },
  bankAccount: { pattern: /^\d{6,18}$/, message: "Bank account must be 6–18 digits" },
};
const PII_COLUMNS: Record<PiiField, string> = { pan: "pan", uan: "uan", esiNumber: "esi_number", bankAccount: "bank_account" };

export async function reviewMaster(client: PoolClient, identity: AuthIdentity, csv: string, options: Options): Promise<Review<MasterOp>> {
  const org = identity.organizationId;
  const input = readCsv("EMPLOYEE_MASTER", csv);
  const { byNumber, byId } = await loadEmployees(client, org);
  const profiles = new Map((await client.query(`SELECT * FROM payroll_profiles WHERE organization_id=$1`, [org])).rows.map((row) => [row.employee_id, row]));
  const details = new Map((await client.query(
    `SELECT employee_id, to_char(date_of_birth,'YYYY-MM-DD') AS date_of_birth, gender, employment_type FROM employee_master_details WHERE organization_id=$1`, [org])).rows.map((row) => [row.employee_id, row]));
  const panOwner = new Map<string, string>(), bankOwner = new Map<string, string>();
  for (const profile of profiles.values()) {
    const number = byId.get(profile.employee_id)?.employee_number;
    if (!number) continue;
    if (profile.pan_hash) panOwner.set(profile.pan_hash, number);
    if (profile.bank_account_hash) bankOwner.set(profile.bank_account_hash, number);
  }
  const fyEnd = (() => { const base = options.cutoverDate || todayIst(); const p = parsePeriod(base.slice(0, 7)); return `${p.fyStartYear + 1}-03-31`; })();
  const seen = new Set<string>(), filePans = new Map<string, string>();
  const managerOverride = new Map<string, string>();
  const rows: ReviewRow[] = [], ops: MasterOp[] = [];
  const counts = { employees: 0, pan: 0, uan: 0, esiNumber: 0, bankAccount: 0, dateOfBirth: 0, manager: 0, taxRegime: 0 };

  for (const line of input) {
    const number = line.get("employee_number");
    const employee = byNumber.get(number);
    const item = row0(line.row, number, employee);
    const { errors, warnings, changes } = item;
    rows.push(item);
    if (!number) { errors.push("employee_number is required"); finish(item, false); continue; }
    if (seen.has(number)) errors.push("Employee appears more than once in this file");
    seen.add(number);
    if (!employee) { errors.push(`Employee ${number} does not exist — add them with the basic employee import first`); finish(item, false); continue; }
    if (employee.status !== "ACTIVE") warnings.push("Employee is inactive");
    const profile = profiles.get(employee.id);
    const current = presentProfile(profile);
    const currentDetails = details.get(employee.id) || {};
    const op: MasterOp = { employeeId: employee.id, employeeNumber: number, employee: {}, details: {}, profile: {}, sealed: {} };

    // Register fields.
    const joining = line.get("joining_date");
    let joiningDate = employee.joining_date;
    if (joining) {
      if (!isDate(joining)) errors.push("joining_date must be YYYY-MM-DD");
      else {
        joiningDate = joining;
        if (joining !== employee.joining_date) { op.employee.joining_date = joining; changes.joiningDate = `${employee.joining_date} → ${joining}`; }
        if (joining > todayIst()) warnings.push("Joining date is in the future");
      }
    }
    for (const column of ["department", "designation", "location"] as const) {
      const value = line.get(column);
      if (!value) continue;
      if (value.length > 120) { errors.push(`${column} must be 120 characters or fewer`); continue; }
      if (value !== employee[column]) { op.employee[column] = value; changes[column] = value; }
    }
    const manager = line.get("manager_employee_number");
    if (manager) {
      const target = byNumber.get(manager);
      if (manager === number) errors.push("An employee cannot report to themselves");
      else if (!target || target.status !== "ACTIVE") errors.push(`Manager ${manager} is not an active employee of this organization`);
      else {
        managerOverride.set(number, manager);
        if (target.id !== employee.manager_id) { op.employee.manager_number = manager; changes.manager = manager; counts.manager++; }
      }
    }
    // Master details.
    const dob = line.get("date_of_birth");
    if (dob) {
      if (!isDate(dob)) errors.push("date_of_birth must be YYYY-MM-DD");
      else if (dob >= todayIst()) errors.push("date_of_birth cannot be today or in the future");
      else {
        const ageAtJoining = yearsBetween(dob, joiningDate);
        if (ageAtJoining < 14) errors.push(`Age at joining would be ${ageAtJoining} — check the date of birth`);
        else if (ageAtJoining < 18) warnings.push(`Employee was ${ageAtJoining} at joining (adolescent worker rules apply)`);
        if (yearsBetween(dob, todayIst()) > 100) errors.push("date_of_birth is more than 100 years ago");
        if (dob !== currentDetails.date_of_birth) { op.details.date_of_birth = dob; changes.dateOfBirth = dob; counts.dateOfBirth++; }
      }
    }
    const gender = line.get("gender").toUpperCase();
    if (gender) {
      if (!GENDERS.includes(gender)) errors.push(`gender must be one of ${GENDERS.join(", ")}`);
      else if (gender !== currentDetails.gender) { op.details.gender = gender; changes.gender = gender; }
    }
    const employment = line.get("employment_type").toUpperCase().replace(/[\s-]/g, "_");
    if (employment) {
      if (!EMPLOYMENT.includes(employment)) errors.push(`employment_type must be one of ${EMPLOYMENT.join(", ")}`);
      else if (employment !== currentDetails.employment_type) { op.details.employment_type = employment; changes.employmentType = employment; }
    }
    // Payroll profile — plain fields.
    const state = line.get("state_code").toUpperCase();
    if (state) {
      if (!/^[A-Z]{2,5}$/.test(state)) errors.push("state_code must be a 2–5 letter state code (e.g. KA)");
      else {
        if (!PT_STATES[state]) warnings.push(`No professional-tax rules are configured for ${state}; PT will be nil`);
        if (state !== current.stateCode) { op.profile.state_code = state; changes.stateCode = state; }
      }
    }
    const regime = line.get("tax_regime").toUpperCase();
    if (regime) {
      if (!["NEW", "OLD"].includes(regime)) errors.push("tax_regime must be NEW or OLD");
      else if (regime !== current.taxRegime) { op.profile.tax_regime = regime; changes.taxRegime = regime; counts.taxRegime++; }
    }
    const ptCategory = line.get("pt_category").toUpperCase();
    if (ptCategory) {
      if (!["STANDARD", "WOMAN", "EXEMPT"].includes(ptCategory)) errors.push("pt_category must be STANDARD, WOMAN or EXEMPT");
      else if (ptCategory !== current.ptCategory) { op.profile.pt_category = ptCategory; changes.ptCategory = ptCategory; }
    }
    const bankName = line.get("bank_name");
    if (bankName) {
      if (bankName.length > 80) errors.push("bank_name must be 80 characters or fewer");
      else if (bankName !== current.bankName) { op.profile.bank_name = bankName; changes.bankName = bankName; }
    }
    const ifsc = line.get("ifsc").toUpperCase();
    if (ifsc) {
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) errors.push("IFSC must be 11 characters: 4 letters, 0, then 6 letters/digits");
      else if (ifsc !== current.ifsc) { op.profile.ifsc = ifsc; changes.ifsc = ifsc; }
    }
    const pf = parseYn(line.get("pf_applicable"));
    if (pf === "invalid") errors.push("pf_applicable must be Y or N");
    else if (pf !== undefined && pf !== current.pfApplicable) { op.profile.pf_applicable = pf; changes.pfApplicable = pf; }
    // Statutory flags (merged into the stored flags).
    const flags = { ...current.statutoryFlags } as Record<string, unknown>;
    let flagsChanged = false;
    for (const [column, key] of [["eps_eligible", "epsEligible"], ["international_worker", "internationalWorker"], ["disability", "disabled"]] as const) {
      const value = parseYn(line.get(column));
      if (value === "invalid") errors.push(`${column} must be Y or N`);
      else if (value !== undefined && value !== flags[key]) { flags[key] = value; flagsChanged = true; changes[key] = value; }
    }
    const effectiveDob = op.details.date_of_birth || currentDetails.date_of_birth;
    if (effectiveDob && isDate(effectiveDob)) {
      const age = yearsBetween(effectiveDob, fyEnd);
      const category = age >= 80 ? "SUPER_SENIOR" : age >= 60 ? "SENIOR" : "BELOW_60";
      if (category !== flags.ageCategory) { flags.ageCategory = category; flagsChanged = true; changes.ageCategory = category; }
      if ((flags.epsEligible ?? true) && yearsBetween(effectiveDob, todayIst()) >= 58) warnings.push("Employee is 58 or older — EPS contributions normally stop (set eps_eligible to N)");
    }
    if (flagsChanged) op.profile.statutory_flags = statutoryFlags(flags);
    // Identifiers: validated, duplicate-checked by blind index, sealed (encrypted) here; plaintext never leaves this function.
    for (const field of Object.keys(PII_FIELDS) as PiiField[]) {
      const raw = line.get(PII_COLUMNS[field]);
      if (!raw) continue;
      const { kind, column } = PII_FIELDS[field];
      const value = normalizeSensitive(kind, raw).toUpperCase();
      if (!PATTERNS[field].pattern.test(value)) { errors.push(PATTERNS[field].message); continue; }
      const hash = blindIndex(kind, value, org);
      if (field === "pan") {
        if (value[3] !== "P") warnings.push("PAN's 4th character is not P — this is not an individual's PAN");
        const fileDuplicate = filePans.get(hash!);
        if (fileDuplicate && fileDuplicate !== number) errors.push(`The same PAN is given for ${fileDuplicate} in this file`);
        filePans.set(hash!, number);
        const owner = panOwner.get(hash!);
        if (owner && owner !== number) errors.push(`This PAN is already on file for ${owner}. Each employee needs their own PAN.`);
      }
      if (field === "bankAccount") {
        const owner = bankOwner.get(hash!);
        if (owner && owner !== number) warnings.push(`The same bank account is on file for ${owner}`);
      }
      if (hash === profile?.[`${column}_hash`]) continue; // unchanged
      op.sealed[field] = sealField(kind, value, profileContext(org, employee.id, column));
      changes[field] = maskSensitive(kind, op.sealed[field]!.last4);
      counts[field]++;
    }
    if ((op.sealed.bankAccount && !op.profile.ifsc && !current.ifsc)) errors.push("A bank account needs an IFSC (none is on file)");
    if (op.profile.ifsc && !op.sealed.bankAccount && !profile?.bank_account_enc) warnings.push("IFSC given without a bank account on file");
    const changed = Object.keys(changes).length > 0;
    finish(item, changed);
    if (!errors.length && changed) { ops.push(op); counts.employees++; }
  }
  // Reporting-line cycles across the register and the file.
  const managerOf = new Map<string, string | null>();
  for (const employee of byNumber.values()) managerOf.set(employee.employee_number, employee.manager_id ? byId.get(employee.manager_id)?.employee_number || null : null);
  for (const [number, manager] of managerOverride) managerOf.set(number, manager);
  for (const item of rows) {
    if (item.errors.length || !managerOverride.has(item.employeeNumber)) continue;
    const visited = new Set([item.employeeNumber]);
    let cursor = managerOf.get(item.employeeNumber) || null;
    while (cursor) {
      if (visited.has(cursor)) {
        item.errors.push("Reporting line forms a loop"); item.outcome = "INVALID";
        const at = ops.findIndex((op) => op.employeeNumber === item.employeeNumber);
        if (at >= 0) { ops.splice(at, 1); counts.employees--; }
        break;
      }
      visited.add(cursor); cursor = managerOf.get(cursor) || null;
    }
  }
  return { rows, ops, totals: { employeesChanging: counts.employees, panSet: counts.pan, uanSet: counts.uan, esiSet: counts.esiNumber, bankSet: counts.bankAccount, dobSet: counts.dateOfBirth, managerChanges: counts.manager, regimeChanges: counts.taxRegime }, options: {} };
}

// ------------------------------------------------------------ 2. salary structures

export type SalaryOp = { employeeId: string; employeeNumber: string; effectiveFrom: string; reason: string; notes: string | null; built: any };
const REASONS = ["JOINING", "REVISION", "PROMOTION", "CORRECTION"];
const pct = (raw: string) => {
  const value = parseNumber(raw, undefined);
  if (value === undefined || value === null) return value;
  return value > 1 ? value / 100 : value;
};

export async function reviewSalary(client: PoolClient, identity: AuthIdentity, csv: string, payroll: PayrollService): Promise<Review<SalaryOp>> {
  const org = identity.organizationId;
  const input = readCsv("SALARY", csv);
  const { byNumber } = await loadEmployees(client, org);
  const settings: Settings = await loadSettings(client, org);
  const profiles = new Map((await client.query(`SELECT * FROM payroll_profiles WHERE organization_id=$1`, [org])).rows.map((row) => [row.employee_id, row]));
  const existing = new Map((await client.query(
    `SELECT employee_id || '|' || to_char(effective_from,'YYYY-MM-DD') AS k, annual_ctc::float AS ctc FROM salary_structures WHERE organization_id=$1`, [org])).rows.map((row) => [row.k, row.ctc]));
  const locked = (await client.query(`SELECT max(period) AS period FROM payroll_runs WHERE organization_id=$1 AND status IN ('PUBLISHED','LOCKED')`, [org])).rows[0]?.period || null;
  const pending = (await client.query(`SELECT min(period) AS period FROM payroll_runs WHERE organization_id=$1 AND status IN ('SUBMITTED','APPROVED')`, [org])).rows[0]?.period || null;
  const seen = new Set<string>();
  const rows: ReviewRow[] = [], ops: SalaryOp[] = [];
  let annualCtc = 0, monthlyGross = 0;
  for (const line of input) {
    const number = line.get("employee_number");
    const employee = byNumber.get(number);
    const item = row0(line.row, number, employee);
    rows.push(item);
    const { errors, warnings, changes } = item;
    if (!employee) { errors.push(number ? `Employee ${number} does not exist` : "employee_number is required"); finish(item, false); continue; }
    if (employee.status !== "ACTIVE") errors.push("Employee is inactive");
    const effectiveFrom = line.get("effective_from");
    if (!isDate(effectiveFrom)) errors.push("effective_from must be YYYY-MM-DD");
    else {
      if (effectiveFrom < employee.joining_date) errors.push(`Cannot start before the joining date (${employee.joining_date})`);
      if (!effectiveFrom.endsWith("-01") && effectiveFrom !== employee.joining_date) errors.push("Must be the 1st of a month or the joining date");
      if (locked && effectiveFrom.slice(0, 7) <= locked) errors.push(`Payroll is published in ClanChief through ${monthLabel(locked)} — the structure must start after that`);
      if (pending && effectiveFrom.slice(0, 7) <= pending) errors.push(`The ${monthLabel(pending)} run is awaiting approval — send it back first`);
      const key = `${employee.id}|${effectiveFrom}`;
      if (seen.has(key)) errors.push("Same employee and effective date appear twice in this file");
      seen.add(key);
    }
    const ctc = parseNumber(line.get("annual_ctc"), undefined);
    if (ctc === undefined || ctc === null || ctc < 10_000) errors.push("annual_ctc must be at least ₹10,000");
    else if (ctc > 1_000_000_000) errors.push("annual_ctc looks too large");
    const template: Record<string, number | boolean> = {};
    for (const [column, key] of [["basic_pct", "basicPct"], ["hra_pct", "hraPct"], ["variable_pct", "variablePct"]] as const) {
      const value = pct(line.get(column));
      if (value === null) errors.push(`${column} must be a number`);
      else if (value !== undefined) template[key] = value;
    }
    for (const [column, key] of [["conveyance_monthly", "conveyance"], ["other_allowance_monthly", "otherAllowance"]] as const) {
      const value = parseNumber(line.get(column), undefined);
      if (value === null) errors.push(`${column} must be a number`);
      else if (value !== undefined) template[key] = value;
    }
    const gratuity = parseYn(line.get("include_gratuity"));
    if (gratuity === "invalid") errors.push("include_gratuity must be Y or N"); else if (gratuity !== undefined) template.includeGratuity = gratuity;
    const metro = parseYn(line.get("is_metro"));
    if (metro === "invalid") errors.push("is_metro must be Y, N or blank");
    const reason = (line.get("reason") || "REVISION").toUpperCase();
    if (!REASONS.includes(reason)) errors.push(`reason must be one of ${REASONS.join(", ")}`);
    const notes = line.get("notes");
    if (notes.length > 1000) errors.push("notes must be 1000 characters or fewer");
    if (errors.length) { finish(item, false); continue; }
    if (existing.has(`${employee.id}|${effectiveFrom}`)) {
      if (Math.abs(existing.get(`${employee.id}|${effectiveFrom}`)! - ctc!) < 1) { warnings.push("Identical structure already on file — skipped"); finish(item, false); continue; }
      errors.push(`A different structure effective ${effectiveFrom} already exists — use another date or remove it first`); finish(item, false); continue;
    }
    const profile = presentProfile(profiles.get(employee.id));
    const built = payroll.previewStructure({ annualCtc: ctc!, template, isMetro: metro === undefined ? undefined : metro, effectiveFrom } as any, settings, profile, employee.location);
    errors.push(...built.errors);
    warnings.push(...built.warnings);
    const floor = settings.minimumWageMonthly ?? MINIMUM_WAGES[built.state]?.monthlyFloor ?? null;
    if (floor && built.monthly.BASIC < floor) errors.push(`Monthly Basic ₹${built.monthly.BASIC.toLocaleString("en-IN")} is below the configured minimum wage ₹${floor.toLocaleString("en-IN")}`);
    Object.assign(changes, {
      effectiveFrom, annualCtc: built.annualCtc, monthlyGross: built.fixedMonthlyGross, basic: built.monthly.BASIC, hra: built.monthly.HRA,
      employerPf: built.monthly.EMPLOYER_PF, takeHome: built.takeHome.net, metro: built.isMetro,
    });
    finish(item, true, false);
    if (!errors.length) {
      ops.push({ employeeId: employee.id, employeeNumber: number, effectiveFrom, reason, notes: notes || null, built });
      annualCtc += built.annualCtc; monthlyGross += built.fixedMonthlyGross;
    }
  }
  return { rows, ops, totals: { structures: ops.length, annualCtc, monthlyGross }, options: {} };
}

// ------------------------------------------------------------ 3. opening leave balances

export type LeaveOp = { employeeId: string; employeeNumber: string; leaveTypeId: string; code: string; opening: number; taken: number; asOf: string };

export async function reviewLeave(client: PoolClient, identity: AuthIdentity, csv: string, options: Options): Promise<Review<LeaveOp>> {
  const org = identity.organizationId;
  const cutover = options.cutoverDate;
  if (!cutover || !isDate(cutover)) throw new BadRequestException("Set the cut-over date (YYYY-MM-DD) on the checklist before importing leave balances.");
  const input = readCsv("LEAVE_OPENING", csv);
  const { byNumber } = await loadEmployees(client, org);
  const types = new Map((await client.query(`SELECT id, code, name, annual_quota::float AS quota, active FROM leave_types WHERE organization_id=$1`, [org])).rows.map((row) => [row.code.toUpperCase(), row]));
  const openings = new Map((await client.query(
    `SELECT l.employee_id || '|' || l.leave_type_id AS k, b.id AS batch_id FROM leave_balance_ledger l LEFT JOIN import_batches b ON b.id=l.batch_id AND b.organization_id=l.organization_id
      WHERE l.organization_id=$1 AND l.entry_type='OPENING'`, [org])).rows.map((row) => [row.k, row.batch_id]));
  const approvedAfter = new Map<string, { start: string; days: number }[]>();
  for (const row of (await client.query(
    `SELECT employee_id || '|' || leave_type_id AS k, to_char(start_date,'YYYY-MM-DD') AS start, days::float FROM leave_requests WHERE organization_id=$1 AND status='APPROVED'`, [org])).rows)
    approvedAfter.set(row.k, [...(approvedAfter.get(row.k) || []), { start: row.start, days: row.days }]);
  const seen = new Set<string>();
  const rows: ReviewRow[] = [], ops: LeaveOp[] = [];
  const byType = new Map<string, { code: string; name: string; employees: number; opening: number; taken: number }>();
  for (const line of input) {
    const number = line.get("employee_number");
    const employee = byNumber.get(number);
    const item = row0(line.row, number, employee);
    rows.push(item);
    const { errors, warnings, changes } = item;
    if (!employee) { errors.push(number ? `Employee ${number} does not exist` : "employee_number is required"); finish(item, false); continue; }
    if (employee.status !== "ACTIVE") warnings.push("Employee is inactive");
    const code = line.get("leave_type_code").toUpperCase();
    const type = types.get(code);
    if (!type) errors.push(`Leave type ${code || "(blank)"} is not configured — use one of ${[...types.keys()].join(", ")}`);
    else {
      if (!type.active) errors.push(`Leave type ${code} is inactive`);
      if (/LOP|UNPAID/.test(code) || /loss of pay|unpaid/i.test(type.name)) errors.push("Loss-of-pay leave has no balance to import");
    }
    const opening = parseNumber(line.get("opening_balance"), undefined);
    if (opening === undefined || opening === null) errors.push("opening_balance must be a number of days");
    else if (opening < -30 || opening > 999) errors.push("opening_balance must be between -30 and 999 days");
    else if (opening < 0) warnings.push("Negative opening balance (leave taken in advance)");
    else if (type && type.quota > 0 && opening > type.quota * 3) warnings.push(`Unusually high: more than 3× the annual quota of ${type.quota}`);
    if (opening && Math.round(opening * 4) !== opening * 4) warnings.push("Balance is not a multiple of a quarter day");
    const taken = parseNumber(line.get("taken_this_year"), 0);
    if (taken === null || taken === undefined || taken < 0 || taken > 366) errors.push("taken_this_year must be between 0 and 366 days");
    const asOf = line.get("as_of_date") || cutover;
    if (!isDate(asOf)) errors.push("as_of_date must be YYYY-MM-DD");
    else {
      if (asOf < employee.joining_date) errors.push(`as_of_date is before the joining date (${employee.joining_date})`);
      if (asOf > todayIst()) warnings.push("as_of_date is in the future");
    }
    if (type) {
      const key = `${employee.id}|${type.id}`;
      if (seen.has(key)) errors.push("Same employee and leave type appear twice in this file");
      seen.add(key);
      if (openings.has(key)) errors.push(`An opening balance for ${code} is already on file${openings.get(key) ? " from an earlier import — undo that batch first" : ""}`);
      const after = (approvedAfter.get(key) || []).filter((leave) => leave.start > asOf).reduce((sum, leave) => sum + leave.days, 0);
      if (after > 0 && !errors.length) warnings.push(`${after} day(s) approved in ClanChief after ${asOf} will be deducted from this balance`);
      if (opening !== null && opening !== undefined) changes.balanceAfterNorthstarLeave = Math.round((opening - after) * 100) / 100;
    }
    Object.assign(changes, { leaveType: code, opening, taken, asOf });
    finish(item, true, false);
    if (!errors.length && type) {
      ops.push({ employeeId: employee.id, employeeNumber: number, leaveTypeId: type.id, code, opening: opening!, taken: taken!, asOf });
      const bucket = byType.get(code) || { code, name: type.name, employees: 0, opening: 0, taken: 0 };
      bucket.employees++; bucket.opening += opening!; bucket.taken += taken!;
      byType.set(code, bucket);
    }
  }
  return { rows, ops, totals: { entries: ops.length, employees: new Set(ops.map((op) => op.employeeId)).size, byType: [...byType.values()] }, options: { cutoverDate: cutover } };
}

// ------------------------------------------------------------ 4. payroll year-to-date

export const YTD_FIELDS = ["gross", "basic", "hra", "other_taxable", "exempt_allowances", "pf_employee", "pf_employer", "vpf", "esi_employee", "pt", "tds"] as const;
export type YtdAmounts = Record<(typeof YTD_FIELDS)[number], number>;
export type YtdOp = {
  employeeId: string; employeeNumber: string; fiscalYear: string; fromPeriod: string; lastPaidPeriod: string; months: number;
  totals: YtdAmounts & { taxable: number }; monthly: (YtdAmounts & { period: string })[];
};

export async function reviewYtd(client: PoolClient, identity: AuthIdentity, csv: string, options: Options): Promise<Review<YtdOp>> {
  const org = identity.organizationId;
  const lastPaid = options.lastPaidPeriod;
  if (!lastPaid || !isPeriod(lastPaid)) throw new BadRequestException("Set the last month paid by the old system (YYYY-MM) on the checklist before importing year-to-date payroll.");
  const fy = parsePeriod(lastPaid);
  if (options.fiscalYear && options.fiscalYear !== fy.fyLabel) throw new BadRequestException(`The last paid month ${lastPaid} is not in FY ${options.fiscalYear}.`);
  const input = readCsv("PAYROLL_YTD", csv);
  const { byNumber } = await loadEmployees(client, org);
  const existing = new Map((await client.query(`SELECT employee_id, batch_id FROM payroll_ytd_opening WHERE organization_id=$1 AND fiscal_year=$2`, [org, fy.fyLabel])).rows.map((row) => [row.employee_id, row.batch_id]));
  const paidHere = (await client.query(
    `SELECT l.employee_id, r.period, r.status FROM payroll_run_lines l JOIN payroll_runs r ON r.id=l.run_id AND r.organization_id=l.organization_id
      WHERE l.organization_id=$1 AND l.status='INCLUDED' AND r.period BETWEEN $2 AND $3 AND r.status IN ('SUBMITTED','APPROVED','PUBLISHED','LOCKED')`,
    [org, fy.fyFirstPeriod, fy.fyLastPeriod])).rows as { employee_id: string; period: string; status: string }[];
  const spans = new Map<string, { from: string; to: string; row: number }[]>();
  const groups = new Map<string, { employee: Employee; items: ReviewRow[]; amounts: (YtdAmounts & { from: string; to: string })[] }>();
  const rows: ReviewRow[] = [];
  for (const line of input) {
    const number = line.get("employee_number");
    const employee = byNumber.get(number);
    const item = row0(line.row, number, employee);
    rows.push(item);
    const { errors, warnings, changes } = item;
    if (!employee) { errors.push(number ? `Employee ${number} does not exist` : "employee_number is required"); finish(item, false); continue; }
    if (employee.status !== "ACTIVE") warnings.push("Employee is inactive (figures still count for Form 16)");
    const from = line.get("from_period"), to = line.get("to_period");
    if (!isPeriod(from) || !isPeriod(to)) errors.push("from_period and to_period must be YYYY-MM");
    else {
      if (from > to) errors.push("from_period is after to_period");
      if (from < fy.fyFirstPeriod || to > fy.fyLastPeriod) errors.push(`Periods must be inside FY ${fy.fyLabel} (${fy.fyFirstPeriod} … ${fy.fyLastPeriod})`);
      if (to > lastPaid) errors.push(`to_period is after the last month paid by the old system (${lastPaid})`);
      if (from < employee.joining_date.slice(0, 7)) errors.push(`from_period is before the joining month (${employee.joining_date.slice(0, 7)}) — previous-employer salary belongs on the tax declaration`);
      const mine = spans.get(employee.id) || [];
      const overlap = mine.find((span) => !(to < span.from || from > span.to));
      if (overlap) errors.push(`Overlaps row ${overlap.row} for the same employee`);
      mine.push({ from, to, row: line.row }); spans.set(employee.id, mine);
      const clash = paidHere.find((paid) => paid.employee_id === employee.id && paid.period >= from && paid.period <= to);
      if (clash) errors.push(`${monthLabel(clash.period)} was already paid by ClanChief (${clash.status.toLowerCase()} run) — it would be counted twice`);
    }
    if (existing.has(employee.id)) errors.push(`Year-to-date for FY ${fy.fyLabel} is already imported for ${number} — undo that batch first`);
    const amounts = {} as YtdAmounts;
    for (const field of YTD_FIELDS) {
      const required = field === "gross" || field === "tds";
      const value = parseNumber(line.get(field), required ? undefined : 0);
      if (value === undefined) { errors.push(`${field} is required (0 if none)`); continue; }
      if (value === null || value < 0) { errors.push(`${field} must be a non-negative amount`); continue; }
      amounts[field] = value;
    }
    if (!errors.length) {
      const months = monthsBetween(from, to);
      const parts = amounts.basic + amounts.hra + amounts.other_taxable + amounts.exempt_allowances;
      if (amounts.exempt_allowances > amounts.gross) errors.push("exempt_allowances cannot exceed gross");
      if (amounts.tds > amounts.gross) errors.push("tds cannot exceed gross");
      if (parts > 0 && Math.abs(parts - amounts.gross) > 1) warnings.push(`basic + hra + other_taxable + exempt_allowances = ₹${parts.toLocaleString("en-IN")}, gross is ₹${amounts.gross.toLocaleString("en-IN")}`);
      if (amounts.basic > 0 && amounts.pf_employee > Math.ceil(amounts.basic * 0.12) + months) warnings.push("pf_employee is more than 12% of Basic — put voluntary PF in the vpf column");
      if (amounts.esi_employee > 0 && amounts.gross / months > 25_000) warnings.push("ESI deducted although average monthly gross is above the ESI wage limit (continues to the end of the contribution period)");
      if (amounts.gross > 0 && amounts.gross / months > 2_500_000) warnings.push("Average monthly gross above ₹25 lakh — check the figures");
      const later = paidHere.filter((paid) => paid.employee_id === employee.id && paid.period > lastPaid);
      if (later.length) warnings.push(`ClanChief runs after ${lastPaid} already computed TDS without these figures; the next run trues up the remaining TDS`);
      Object.assign(changes, { period: from === to ? monthLabel(from) : `${from} … ${to}`, months, gross: amounts.gross, taxable: amounts.gross - amounts.exempt_allowances, tds: amounts.tds, pf: amounts.pf_employee + amounts.vpf });
    }
    finish(item, true, false);
    if (!errors.length) {
      const group = groups.get(employee.id) || { employee, items: [], amounts: [] };
      group.items.push(item); group.amounts.push({ ...amounts, from, to });
      groups.set(employee.id, group);
    }
  }
  const ops: YtdOp[] = [];
  const grand = Object.fromEntries([...YTD_FIELDS, "taxable"].map((field) => [field, 0])) as YtdAmounts & { taxable: number };
  for (const [employeeId, group] of groups) {
    if (group.items.some((item) => item.errors.length)) continue;
    const totals = Object.fromEntries(YTD_FIELDS.map((field) => [field, group.amounts.reduce((sum, row) => sum + row[field], 0)])) as YtdAmounts & { taxable: number };
    totals.taxable = totals.gross - totals.exempt_allowances;
    const fromPeriod = group.amounts.map((row) => row.from).sort()[0];
    const months = group.amounts.reduce((sum, row) => sum + monthsBetween(row.from, row.to), 0);
    const covered = group.amounts.map((row) => row.to).sort().pop()!;
    const expected = monthsBetween(fromPeriod, lastPaid);
    if (months < expected || covered < lastPaid) group.items[group.items.length - 1].warnings.push(`Covers ${months} of the ${expected} month(s) from ${fromPeriod} to ${lastPaid} — missing months are treated as unpaid`);
    ops.push({
      employeeId, employeeNumber: group.employee.employee_number, fiscalYear: fy.fyLabel, fromPeriod, lastPaidPeriod: lastPaid, months, totals,
      monthly: group.amounts.filter((row) => row.from === row.to).map(({ from, to: _to, ...rest }) => ({ ...rest, period: from })),
    });
    for (const field of [...YTD_FIELDS, "taxable"] as const) grand[field] += totals[field];
  }
  return { rows, ops, totals: { employees: ops.length, fiscalYear: fy.fyLabel, lastPaidPeriod: lastPaid, monthlyRows: ops.reduce((sum, op) => sum + op.monthly.length, 0), ...grand }, options: { fiscalYear: fy.fyLabel, lastPaidPeriod: lastPaid } };
}

export const nextPeriodAfter = (period: string) => addMonths(period, 1);

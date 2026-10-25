/**
 * Switch-over import templates: one CSV per import kind (header + example row) and a column-help sheet.
 * Column names are the contract with the validator in imports.service.ts.
 */
export type ImportKind = "EMPLOYEE_MASTER" | "SALARY" | "LEAVE_OPENING" | "PAYROLL_YTD" | "PAYSLIPS";
export type Column = { name: string; required: boolean; example: string; help: string };

/** URL slug ↔ kind. */
export const KIND_SLUGS: Record<string, ImportKind> = {
  "employee-master": "EMPLOYEE_MASTER", salary: "SALARY", "leave-opening": "LEAVE_OPENING", "payroll-ytd": "PAYROLL_YTD", payslips: "PAYSLIPS",
};
export const slugOf = (kind: ImportKind) => Object.entries(KIND_SLUGS).find(([, value]) => value === kind)![0];

/** Who may run each import. Employees never; HR owns people data, payroll owns money data. */
export const KIND_ROLES: Record<ImportKind, string[]> = {
  EMPLOYEE_MASTER: ["HR_ADMIN", "OWNER"], LEAVE_OPENING: ["HR_ADMIN", "OWNER"],
  SALARY: ["PAYROLL_ADMIN", "OWNER"], PAYROLL_YTD: ["PAYROLL_ADMIN", "OWNER"], PAYSLIPS: ["PAYROLL_ADMIN", "OWNER"],
};

export const KIND_LABELS: Record<ImportKind, { step: number; title: string; summary: string }> = {
  EMPLOYEE_MASTER: { step: 1, title: "Employee master details", summary: "Date of birth, gender, department, state, manager, statutory IDs (encrypted), bank and tax regime." },
  SALARY: { step: 2, title: "Salary structures (CTC)", summary: "Annual CTC per employee with an effective date, split into the standard components." },
  LEAVE_OPENING: { step: 3, title: "Opening leave balances", summary: "Balance per leave type as of the cut-over date, plus leave taken so far this year." },
  PAYROLL_YTD: { step: 4, title: "Payroll year-to-date", summary: "Salary, PF, ESI, PT and TDS already paid this financial year by the old system." },
  PAYSLIPS: { step: 5, title: "Previous payslips (PDF)", summary: "Optional: a zip of old payslip PDFs named <employee number>_<YYYY-MM>.pdf." },
};

const yn = "Y or N. Leave blank to keep what is on file.";
const keep = "Leave blank to keep what is on file.";
const money = (what: string) => `${what} for the whole period, in rupees (no ₹ sign; commas allowed). 0 if none.`;

export const COLUMNS: Record<Exclude<ImportKind, "PAYSLIPS">, Column[]> = {
  EMPLOYEE_MASTER: [
    { name: "employee_number", required: true, example: "BT003", help: "Existing employee number. Create new people first with the basic employee import (Core HRIS → Import employees)." },
    { name: "date_of_birth", required: false, example: "1994-06-15", help: `YYYY-MM-DD. Sets the income-tax age category (60+ senior, 80+ super senior). ${keep}` },
    { name: "gender", required: false, example: "FEMALE", help: `MALE, FEMALE, OTHER or UNDISCLOSED. ${keep}` },
    { name: "joining_date", required: false, example: "2024-04-01", help: `YYYY-MM-DD — the original date of joining in the old system. ${keep}` },
    { name: "department", required: false, example: "Operations", help: `Up to 120 characters. ${keep}` },
    { name: "designation", required: false, example: "Barista", help: `Up to 120 characters. ${keep}` },
    { name: "location", required: false, example: "Bengaluru — Indiranagar", help: `Work location (city in it is used to infer the PT state and metro HRA). ${keep}` },
    { name: "state_code", required: false, example: "KA", help: `Professional-tax state: two-letter code (KA, MH, TN, TS, AP, WB, GJ, KL, PB, DL, HR, UP, RJ, GA …). ${keep}` },
    { name: "manager_employee_number", required: false, example: "BT001", help: `Reporting manager's employee number. ${keep}` },
    { name: "employment_type", required: false, example: "FULL_TIME", help: `FULL_TIME, PART_TIME, CONTRACT, INTERN or CONSULTANT. ${keep}` },
    { name: "pan", required: false, example: "ABCPE1234F", help: `Permanent Account Number (10 characters). Stored encrypted; must be unique across employees. ${keep}` },
    { name: "uan", required: false, example: "100200300400", help: `EPF Universal Account Number (12 digits). Stored encrypted. ${keep}` },
    { name: "esi_number", required: false, example: "3100123456", help: `ESIC IP number (10 or 17 digits). Stored encrypted. ${keep}` },
    { name: "bank_account", required: false, example: "50100012345678", help: `Salary account number (6–18 digits). Stored encrypted. ${keep}` },
    { name: "ifsc", required: false, example: "HDFC0001234", help: `11-character IFSC (required when a bank account is given and none is on file). ${keep}` },
    { name: "bank_name", required: false, example: "HDFC Bank", help: `Up to 80 characters. ${keep}` },
    { name: "pf_applicable", required: false, example: "Y", help: `Employee is an EPF member. ${yn}` },
    { name: "eps_eligible", required: false, example: "Y", help: `Employer share goes to EPS (N for members who joined after 1 Sep 2014 above the wage ceiling, or 58+). ${yn}` },
    { name: "international_worker", required: false, example: "N", help: `International worker under EPF (no wage ceiling). ${yn}` },
    { name: "disability", required: false, example: "N", help: `Person with disability (ESI wage limit ₹25,000). ${yn}` },
    { name: "tax_regime", required: false, example: "NEW", help: `NEW or OLD income-tax regime for FY 2026-27. ${keep}` },
    { name: "pt_category", required: false, example: "STANDARD", help: `STANDARD, WOMAN (Maharashtra concession) or EXEMPT. ${keep}` },
  ],
  SALARY: [
    { name: "employee_number", required: true, example: "BT003", help: "Existing employee number." },
    { name: "effective_from", required: true, example: "2026-04-01", help: "YYYY-MM-DD. The 1st of a month or the joining date; not inside a month already published in Northstar." },
    { name: "annual_ctc", required: true, example: "600000", help: "Annual cost to company in rupees (fixed + variable)." },
    { name: "basic_pct", required: false, example: "50", help: "Basic as % of monthly fixed pay (30–80). Default 50." },
    { name: "hra_pct", required: false, example: "40", help: "HRA as % of Basic (0–50). Default 50 for metro cities, 40 otherwise." },
    { name: "conveyance_monthly", required: false, example: "1600", help: "Fixed conveyance allowance per month. Default 1600." },
    { name: "other_allowance_monthly", required: false, example: "0", help: "Other fixed allowance per month. Default 0." },
    { name: "variable_pct", required: false, example: "0", help: "Annual variable pay as % of CTC (0–40). Default 0." },
    { name: "include_gratuity", required: false, example: "N", help: "Y if the CTC includes the 4.81% gratuity provision. Default N." },
    { name: "is_metro", required: false, example: "", help: "Y/N for 50% metro HRA. Blank = inferred from the work location." },
    { name: "reason", required: false, example: "JOINING", help: "JOINING, REVISION, PROMOTION or CORRECTION. Default REVISION." },
    { name: "notes", required: false, example: "Migrated from PeopleStrong", help: "Up to 1000 characters." },
  ],
  LEAVE_OPENING: [
    { name: "employee_number", required: true, example: "BT003", help: "Existing employee number." },
    { name: "leave_type_code", required: true, example: "EL", help: "Leave type code as configured in Northstar (e.g. CL, SL, EL)." },
    { name: "opening_balance", required: true, example: "12.5", help: "Balance available on the cut-over date (after leave already taken), in days; halves allowed." },
    { name: "taken_this_year", required: false, example: "3", help: "Optional: days of this type already taken this leave year in the old system (for reports; not deducted again)." },
    { name: "as_of_date", required: false, example: "2026-09-30", help: "YYYY-MM-DD. Blank = the cut-over date set on the checklist. Leave approved in Northstar after this date reduces the balance." },
  ],
  PAYROLL_YTD: [
    { name: "employee_number", required: true, example: "BT003", help: "Existing employee number." },
    { name: "from_period", required: true, example: "2026-04", help: "YYYY-MM — first month covered by this row (inside the financial year)." },
    { name: "to_period", required: true, example: "2026-08", help: "YYYY-MM — last month covered (≤ the last month paid by the old system). Use one row per month for month-wise history, or one row for the whole period." },
    { name: "gross", required: true, example: "250000", help: money("Total earnings paid (Basic + HRA + all allowances + bonus)") },
    { name: "basic", required: false, example: "125000", help: money("Basic (+DA) paid") },
    { name: "hra", required: false, example: "50000", help: money("HRA paid (do NOT subtract the HRA exemption — Northstar computes it for the year)") },
    { name: "other_taxable", required: false, example: "75000", help: money("Other taxable earnings (special allowance, bonus, arrears …)") },
    { name: "exempt_allowances", required: false, example: "0", help: money("Non-taxable components included in gross (tax-free reimbursements, LTA claimed …)") },
    { name: "pf_employee", required: false, example: "15000", help: money("Employee PF deducted (12%)") },
    { name: "pf_employer", required: false, example: "15000", help: money("Employer PF + EPS contribution") },
    { name: "vpf", required: false, example: "0", help: money("Voluntary PF deducted") },
    { name: "esi_employee", required: false, example: "0", help: money("Employee ESI deducted") },
    { name: "pt", required: false, example: "1000", help: money("Professional tax deducted") },
    { name: "tds", required: true, example: "4200", help: money("Income tax (TDS) deducted and deposited") },
  ],
};

const quote = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export function templateCsv(kind: Exclude<ImportKind, "PAYSLIPS">) {
  const columns = COLUMNS[kind];
  return `${columns.map((column) => column.name).join(",")}\n${columns.map((column) => quote(column.example)).join(",")}\n`;
}

export function helpCsv(kind: Exclude<ImportKind, "PAYSLIPS">) {
  return `column,required,example,how to fill\n${COLUMNS[kind].map((column) => [column.name, column.required ? "yes" : "no", column.example, column.help].map(quote).join(",")).join("\n")}\n`;
}

export const PAYSLIP_HELP = [
  "Upload one .zip (≤ 8 MB) or several PDF files. Name each PDF <employee number>_<YYYY-MM>.pdf, e.g. BT003_2026-07.pdf (folders inside the zip are ignored).",
  "Only PDF files are accepted (checked by content, not just the extension). Each file ≤ 8 MB.",
  "Employees see these under “Previous payslips (imported)”. Payroll admins can undo the whole batch.",
];

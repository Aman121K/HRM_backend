import { csvSafe } from "./shared";

/**
 * Accounting voucher model and file builders.
 * Amounts are integer paise throughout so debits and credits balance exactly.
 *
 * Tally Prime import convention (XML "Import Data" envelope): inside a voucher each ALLLEDGERENTRIES.LIST line has
 * ISDEEMEDPOSITIVE=Yes and a negative AMOUNT for a debit, ISDEEMEDPOSITIVE=No and a positive AMOUNT for a credit; the
 * AMOUNTs of a voucher sum to zero.
 */
export type VoucherLine = { ledgerKey: string; ledger: string; debit: number; credit: number; note?: string };
export type Voucher = { number: string; type: string; date: string; narration: string; reference?: string; lines: VoucherLine[] };

export const LEDGER_LABELS: Record<string, string> = {
  salaryExpense: "Salary & wages expense", employerContributionExpense: "Employer statutory contributions (PF/ESI/gratuity)",
  reimbursementExpense: "Staff reimbursements", pfPayable: "PF payable", esiPayable: "ESI payable", ptPayable: "Professional tax payable",
  tdsPayable: "TDS payable (salary, 192)", otherDeductions: "Recoveries & loan deductions", gratuityProvision: "Gratuity provision",
  salaryPayable: "Salary payable", bank: "Bank (salary / reimbursement account)",
};
export const DEFAULT_LEDGERS: Record<string, string> = {
  salaryExpense: "Salaries & Wages", employerContributionExpense: "Employer Contribution to PF & ESI", reimbursementExpense: "Staff Reimbursements",
  pfPayable: "PF Payable", esiPayable: "ESI Payable", ptPayable: "Professional Tax Payable", tdsPayable: "TDS Payable - Salary",
  otherDeductions: "Salary Recoveries", gratuityProvision: "Provision for Gratuity", salaryPayable: "Salary Payable", bank: "HDFC Current Account",
};

export const totalsOf = (vouchers: Voucher[]) => {
  let debit = 0;
  let credit = 0;
  for (const voucher of vouchers) for (const line of voucher.lines) { debit += line.debit; credit += line.credit; }
  return { debit, credit, lines: vouchers.reduce((sum, voucher) => sum + voucher.lines.length, 0) };
};

export const unbalanced = (vouchers: Voucher[]) => vouchers.filter((voucher) => {
  const t = totalsOf([voucher]);
  return t.debit !== t.credit;
});

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const amount = (paise: number) => (paise / 100).toFixed(2);

export function tallyXml(company: string, vouchers: Voucher[]) {
  const body = vouchers.map((voucher) => {
    const entries = voucher.lines.map((line) => [
      "        <ALLLEDGERENTRIES.LIST>",
      `          <LEDGERNAME>${xml(line.ledger)}</LEDGERNAME>`,
      `          <ISDEEMEDPOSITIVE>${line.debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
      `          <AMOUNT>${line.debit ? `-${amount(line.debit)}` : amount(line.credit)}</AMOUNT>`,
      "        </ALLLEDGERENTRIES.LIST>",
    ].join("\n")).join("\n");
    return [
      `      <TALLYMESSAGE xmlns:UDF="TallyUDF">`,
      `      <VOUCHER VCHTYPE="${xml(voucher.type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
      `        <DATE>${voucher.date.replace(/-/g, "")}</DATE>`,
      `        <EFFECTIVEDATE>${voucher.date.replace(/-/g, "")}</EFFECTIVEDATE>`,
      `        <VOUCHERTYPENAME>${xml(voucher.type)}</VOUCHERTYPENAME>`,
      `        <VOUCHERNUMBER>${xml(voucher.number)}</VOUCHERNUMBER>`,
      voucher.reference ? `        <REFERENCE>${xml(voucher.reference)}</REFERENCE>` : "",
      `        <NARRATION>${xml(voucher.narration)}</NARRATION>`,
      `        <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>`,
      entries,
      "      </VOUCHER>",
      "      </TALLYMESSAGE>",
    ].filter(Boolean).join("\n");
  }).join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    "<ENVELOPE>",
    "  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>",
    "  <BODY>",
    "    <IMPORTDATA>",
    "      <REQUESTDESC>",
    "        <REPORTNAME>Vouchers</REPORTNAME>",
    `        <STATICVARIABLES><SVCURRENTCOMPANY>${xml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>`,
    "      </REQUESTDESC>",
    "      <REQUESTDATA>",
    body,
    "      </REQUESTDATA>",
    "    </IMPORTDATA>",
    "  </BODY>",
    "</ENVELOPE>",
    "",
  ].join("\n");
}

const csvCell = csvSafe;

/** Generic double-entry CSV for other ERPs (SAP B1, Zoho Books, NetSuite, Busy…): one row per voucher line. */
export function voucherCsv(vouchers: Voucher[]) {
  const rows = [["voucher_number", "voucher_type", "date", "ledger", "ledger_key", "debit", "credit", "reference", "narration"]];
  for (const voucher of vouchers)
    for (const line of voucher.lines)
      rows.push([voucher.number, voucher.type, voucher.date, line.ledger, line.ledgerKey, line.debit ? amount(line.debit) : "", line.credit ? amount(line.credit) : "",
        voucher.reference || "", line.note ? `${voucher.narration} — ${line.note}` : voucher.narration]);
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

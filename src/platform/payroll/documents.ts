/** Export builders: CSV / ECR text files and the printable payslip HTML. Pure functions. */

const esc = (value: unknown) => String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]!);
const inr = (value: unknown) => `₹${Math.round(Number(value) || 0).toLocaleString("en-IN")}`;

// CSV writing lives in ./csv (formula-injection safe); re-exported for existing importers.
export { csvCell, toCsv } from "./csv";

export function amountInWords(value: number) {
  const ones = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const under100 = (n: number) => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ""}`);
  const under1000 = (n: number) => (n < 100 ? under100(n) : `${ones[Math.floor(n / 100)]} hundred${n % 100 ? ` ${under100(n % 100)}` : ""}`);
  let rest = Math.max(0, Math.round(value));
  if (!rest) return "Zero rupees only";
  const parts: string[] = [];
  if (rest >= 10000000) { parts.push(`${under1000(Math.floor(rest / 10000000))} crore`); rest %= 10000000; }
  if (rest >= 100000) { parts.push(`${under100(Math.floor(rest / 100000))} lakh`); rest %= 100000; }
  if (rest >= 1000) { parts.push(`${under100(Math.floor(rest / 1000))} thousand`); rest %= 1000; }
  if (rest) parts.push(under1000(rest));
  return `${parts.join(" ")} rupees only`.replace(/^./, (c) => c.toUpperCase());
}

type Slip = {
  period: string; label: string; gross: number; deductions: number; net: number; publishedAt: string | Date | null; organizationName: string;
  breakdown: any; employee: { number: string; name: string; designation: string | null; department: string | null; location: string | null; joiningDate: string };
  disclaimer: string;
};

export function payslipHtml(slip: Slip) {
  const b = slip.breakdown || {};
  const snap = b.employee || {};
  const rows = (items: { label: string; amount: number; note?: string; full?: number }[] = [], showFull = false) =>
    items.map((item) => `<tr><td>${esc(item.label)}${item.note ? `<small>${esc(item.note)}</small>` : ""}</td>${showFull ? `<td class="num muted">${item.full !== undefined ? inr(item.full) : ""}</td>` : ""}<td class="num">${inr(item.amount)}</td></tr>`).join("");
  const earnings = [...(b.earnings || []), ...(b.oneTime || [])];
  const ytd = b.ytd || {};
  const tax = b.tax || null;
  const days = b.days || {};
  const published = slip.publishedAt ? new Date(slip.publishedAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : "";
  const detail = b.earnings ? `
  <section class="grid2">
    <div><h2>Earnings</h2><table><thead><tr><th>Component</th><th class="num">Monthly rate</th><th class="num">Earned</th></tr></thead><tbody>${rows(earnings, true)}</tbody>
      <tfoot><tr><td>Gross earnings</td><td></td><td class="num">${inr(b.totals?.gross)}</td></tr></tfoot></table>
      ${b.reimbursements?.length ? `<h3>Reimbursements (non-taxable)</h3><table><tbody>${rows(b.reimbursements)}</tbody></table>` : ""}</div>
    <div><h2>Deductions</h2><table><thead><tr><th>Component</th><th class="num">Amount</th></tr></thead><tbody>${rows(b.deductions)}</tbody>
      <tfoot><tr><td>Total deductions</td><td class="num">${inr(b.totals?.deductions)}</td></tr></tfoot></table></div>
  </section>
  <section class="net"><div><small>Gross earnings</small><b>${inr(b.totals?.gross)}</b></div><span>+</span><div><small>Reimbursements</small><b>${inr(b.totals?.reimbursements)}</b></div><span>−</span>
    <div><small>Deductions</small><b>${inr(b.totals?.deductions)}</b></div><span>=</span><div class="hl"><small>Net pay</small><b>${inr(slip.net)}</b></div></section>
  <p class="words">${esc(amountInWords(slip.net))}</p>
  <section class="grid2">
    <div><h2>Employer contributions <small>(not part of take-home)</small></h2><table><tbody>${rows(b.employer)}</tbody></table></div>
    <div><h2>Year to date (FY ${esc(b.fiscalYear || "")})</h2><table><tbody>
      <tr><td>Gross earnings</td><td class="num">${inr(ytd.gross)}</td></tr><tr><td>Taxable salary</td><td class="num">${inr(ytd.taxable)}</td></tr>
      <tr><td>Income tax deducted</td><td class="num">${inr(ytd.tds)}</td></tr><tr><td>Provident fund</td><td class="num">${inr(ytd.pf)}</td></tr>
      <tr><td>Professional tax</td><td class="num">${inr(ytd.pt)}</td></tr><tr><td>Net pay</td><td class="num">${inr(ytd.net)}</td></tr></tbody></table></div>
  </section>
  ${tax ? `<section><h2>Income-tax projection · ${esc(tax.regime === "OLD" ? "Old" : "New")} regime</h2><table><tbody>
    <tr><td>Projected annual income</td><td class="num">${inr(tax.projectedAnnualIncome)}</td></tr>
    <tr><td>Standard deduction, exemptions &amp; deductions</td><td class="num">${inr((tax.standardDeduction || 0) + (tax.exemptions || 0) + (tax.deductions || 0))}</td></tr>
    <tr><td>Taxable income</td><td class="num">${inr(tax.taxableIncome)}</td></tr>
    <tr><td>Annual tax incl. 4% cess${tax.rebate ? " (after s.87A rebate)" : ""}</td><td class="num">${inr(tax.annualLiability)}</td></tr>
    <tr><td>Deducted before this month</td><td class="num">${inr(tax.tdsDeductedSoFar)}</td></tr>
    <tr><td>Deducted this month</td><td class="num">${inr(tax.monthlyTds)}</td></tr>
    <tr><td>Remaining for the year</td><td class="num">${inr(tax.remainingAfterThisMonth)}</td></tr></tbody></table></section>` : ""}` : `
  <section class="net"><div><small>Gross</small><b>${inr(slip.gross)}</b></div><span>−</span><div><small>Deductions</small><b>${inr(slip.deductions)}</b></div><span>=</span><div class="hl"><small>Net pay</small><b>${inr(slip.net)}</b></div></section>
  <p class="words">${esc(amountInWords(slip.net))}</p><p class="muted">A detailed breakdown is not available for this legacy payslip.</p>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payslip ${esc(slip.label)} — ${esc(slip.employee.name)}</title>
<style>
@page{size:A4;margin:14mm}
*{box-sizing:border-box}body{margin:0;background:#f4f1ea;color:#17343e;font:13px/1.5 Manrope,"Avenir Next","Segoe UI",system-ui,sans-serif}
main{max-width:860px;margin:24px auto;background:#fff;border:1px solid #dcd8cc;padding:34px 38px}
header{display:flex;justify-content:space-between;gap:20px;border-bottom:3px solid #0b615c;padding-bottom:16px}
header h1{margin:0;font-size:24px;letter-spacing:-.02em}header p{margin:2px 0 0;color:#60757b}
.badge{align-self:flex-start;text-align:right}.badge b{display:block;font-size:18px}.badge small{color:#60757b}
.facts{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #e3e0d6;margin:18px 0}
.facts div{padding:9px 12px;border-right:1px solid #e3e0d6;border-bottom:1px solid #e3e0d6}.facts div:nth-child(4n){border-right:0}
.facts small,.net small{display:block;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#60757b}.facts b{font-weight:700}
h2{font-size:14px;margin:18px 0 6px}h2 small{font-weight:500;color:#60757b}h3{font-size:12px;margin:12px 0 4px;color:#60757b}
table{width:100%;border-collapse:collapse}td,th{padding:6px 4px;border-bottom:1px solid #eeebe3;text-align:left;vertical-align:top}
th{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#60757b}td small{display:block;color:#7a8b90;font-size:11px}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.muted{color:#7a8b90}tfoot td{font-weight:800;border-top:2px solid #17343e;border-bottom:0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:28px}
.net{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:22px 0 6px;padding:14px 18px;border:2px solid #b58a32;background:#fdf9ef}
.net b{font-size:18px}.net span{font-size:18px;color:#b58a32}.net .hl b{font-size:22px;color:#0b615c}
.words{margin:4px 0 0;font-weight:700}
footer{margin-top:22px;padding-top:12px;border-top:1px solid #e3e0d6;color:#60757b;font-size:11px}
.toolbar{max-width:860px;margin:16px auto 0;display:flex;justify-content:flex-end}.toolbar button{font:700 13px inherit;padding:9px 16px;border:0;background:#0b615c;color:#fff;cursor:pointer}
@media (max-width:700px){main{padding:20px}.facts{grid-template-columns:1fr 1fr}.grid2{grid-template-columns:1fr}.net{flex-wrap:wrap}}
@media print{body{background:#fff}main{margin:0;border:0;padding:0;max-width:none}.toolbar{display:none}section,table{break-inside:avoid}}
</style></head><body>
<div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div>
<main>
<header><div><p>${esc(slip.organizationName)}</p><h1>Payslip · ${esc(slip.label)}</h1><p>Salary statement for the month of ${esc(slip.label)}</p></div>
<div class="badge"><small>Net pay</small><b>${inr(slip.net)}</b><small>${published ? `Published ${esc(published)}` : ""}</small></div></header>
<section class="facts">
<div><small>Employee</small><b>${esc(slip.employee.name)}</b></div><div><small>Employee ID</small><b>${esc(slip.employee.number)}</b></div>
<div><small>Designation</small><b>${esc(slip.employee.designation || "—")}</b></div><div><small>Department</small><b>${esc(slip.employee.department || "—")}</b></div>
<div><small>Location / PT state</small><b>${esc(slip.employee.location || "—")}${b.statutory?.pt?.stateName ? ` · ${esc(b.statutory.pt.stateName)}` : ""}</b></div><div><small>Date of joining</small><b>${esc(slip.employee.joiningDate)}</b></div>
<div><small>PAN</small><b>${esc(snap.pan || "—")}</b></div><div><small>UAN</small><b>${esc(snap.uan || "—")}</b></div>
<div><small>Bank account</small><b>${esc(snap.bank || "—")}</b></div><div><small>Days in month</small><b>${esc(days.daysInMonth ?? "—")}</b></div>
<div><small>Payable days</small><b>${esc(days.payableDays ?? "—")}</b></div><div><small>Loss of pay</small><b>${esc(days.lopDays ?? 0)}</b></div>
</section>
${detail}
<footer>System-generated payslip — no signature required. Sensitive identifiers are masked. ${b.rulesetVersion ? `Statutory rule set ${esc(b.rulesetVersion)}.` : ""}<br>${esc(slip.disclaimer)}</footer>
</main></body></html>`;
}

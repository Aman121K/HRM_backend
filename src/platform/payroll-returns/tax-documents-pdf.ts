/** PDF renderers for the annual salary TDS certificate, the perquisite statement and the quarterly TDS summary. */
import { PdfDocument, wrapText, type Attachment } from "./pdf";
import type { Form16Data } from "./form16";
import { displayDate, inr } from "./tds-math";

const INK = "#17343e", MUTED = "#60757b", ACCENT = "#0b615c", BAND = "#eef4f2", WARN = "#8a5a00";
const rs = (n: number) => `Rs. ${inr(n)}`;

type Row = { label: string; amount?: number | string; sub?: boolean; bold?: boolean; note?: string };

function header(doc: PdfDocument, title: string, subtitle: string, data: Form16Data, pan: string) {
  doc.rect(0, doc.y - 8, 595.28, 56, BAND);
  doc.text(doc.margin, doc.y + 30, data.employer.name, { size: 9, color: MUTED });
  doc.text(doc.margin, doc.y + 12, title, { size: 14, bold: true, color: ACCENT });
  doc.text(doc.margin, doc.y - 2, subtitle, { size: 8.5, color: MUTED });
  doc.y -= 26;
  const facts: [string, string][] = [
    ["Employer (deductor)", data.employer.name], ["TAN of deductor", data.employer.tan || "Not set"],
    ["PAN of deductor", data.employer.panMasked || "Not set"], ["Address", data.employer.address || "-"],
    ["Employee", `${data.employee.name} (${data.employee.number})`], ["PAN of employee", pan],
    ["Designation", data.employee.designation || "-"], [data.forms.yearLabel.startsWith("Tax") ? "Tax year" : "Financial year", data.forms.yearLabel],
    ["Period with employer", `${displayDate(data.period.from)} to ${displayDate(data.period.to)}`], ["Tax regime", data.regime === "NEW" ? "New regime (s.202 / formerly s.115BAC)" : "Old regime (opted out)"],
  ];
  const colWidth = doc.contentWidth / 2;
  for (let i = 0; i < facts.length; i += 2) {
    doc.ensure(24);
    doc.y -= 22;
    for (let j = 0; j < 2 && i + j < facts.length; j++) {
      const x = doc.margin + j * colWidth;
      doc.text(x, doc.y + 10, facts[i + j][0].toUpperCase(), { size: 6.5, color: MUTED });
      doc.text(x, doc.y, wrapText(facts[i + j][1], colWidth - 8, 9, true)[0] || "", { size: 9, bold: true });
    }
  }
  doc.y -= 8;
  doc.line(doc.margin, doc.y, 595.28 - doc.margin, doc.y, ACCENT, 1.2);
  doc.y -= 6;
}

function section(doc: PdfDocument, title: string) {
  doc.ensure(40);
  doc.y -= 16;
  doc.text(doc.margin, doc.y, title, { size: 10.5, bold: true, color: ACCENT });
  doc.y -= 4;
}

function rows(doc: PdfDocument, items: Row[]) {
  const amountWidth = 110;
  for (const item of items) {
    const indent = item.sub ? 16 : 0;
    const lines = wrapText(item.label, doc.contentWidth - amountWidth - indent - 8, 8.8, item.bold);
    const height = lines.length * 11 + (item.note ? 10 : 0) + 4;
    doc.ensure(height);
    doc.y -= 12;
    lines.forEach((line, index) => doc.text(doc.margin + indent, doc.y - index * 11, line, { size: 8.8, bold: item.bold, color: item.sub ? MUTED : INK }));
    if (item.amount !== undefined) doc.text(doc.margin + doc.contentWidth - amountWidth, doc.y, typeof item.amount === "number" ? rs(item.amount) : item.amount, { size: 8.8, bold: item.bold, align: "right", width: amountWidth });
    doc.y -= (lines.length - 1) * 11;
    if (item.note) { doc.y -= 10; doc.text(doc.margin + indent, doc.y, item.note, { size: 7, color: MUTED }); }
    doc.y -= 3;
    doc.line(doc.margin, doc.y, doc.margin + doc.contentWidth, doc.y, "#ece8de", 0.4);
  }
}

function table(doc: PdfDocument, columns: { label: string; width: number; align?: "left" | "right" }[], body: string[][]) {
  const total = columns.reduce((t, c) => t + c.width, 0);
  const scale = doc.contentWidth / total;
  const draw = (cells: string[], bold: boolean, fill?: string) => {
    doc.ensure(16);
    doc.y -= 14;
    if (fill) doc.rect(doc.margin, doc.y - 4, doc.contentWidth, 14, fill);
    let x = doc.margin;
    columns.forEach((column, i) => {
      const width = column.width * scale;
      const text = wrapText(cells[i] || "", width - 6, 7.8, bold)[0] || "";
      doc.text(x + 3, doc.y, text, { size: 7.8, bold, align: column.align, width: width - 6, color: bold ? INK : INK });
      x += width;
    });
  };
  draw(columns.map((c) => c.label), true, BAND);
  for (const cells of body) draw(cells, false);
  doc.y -= 4;
}

function notes(doc: PdfDocument, data: Form16Data, extra: string[] = []) {
  section(doc, "Notes");
  for (const text of [...extra, ...data.warnings]) doc.paragraph(`* ${text}`, { size: 7.8, color: WARN, gap: 1 });
  doc.paragraph(`* ${data.forms.note}`, { size: 7.5, color: MUTED, gap: 1 });
  doc.paragraph("* Prepared from payroll records by Northstar HRM. Validate with your tax adviser before relying on it; the certificate is valid only when verified and signed by the person responsible for deduction.", { size: 7.5, color: MUTED, gap: 1 });
}

function verification(doc: PdfDocument, data: Form16Data, what: string) {
  section(doc, "Verification");
  doc.paragraph(`I, ${data.employer.responsibleName || "____________________"}, working in the capacity of ${data.employer.responsibleDesignation || "____________"}, do hereby certify that the information given above is true, complete and correct and is based on the books of account, documents, TDS statements and other available records (${what}).`, { size: 8.5 });
  doc.ensure(40);
  doc.y -= 30;
  doc.text(doc.margin, doc.y, "Place: ______________    Date: ______________", { size: 8.5 });
  doc.text(doc.margin + doc.contentWidth - 200, doc.y, "Signature of person responsible for deduction", { size: 8, color: MUTED, width: 200, align: "right" });
}

const footer = (label: string) => (page: number, total: number) => `${label} · page ${page} of ${total}`;

/** Annual certificate: salary computation (Form 16 Part B / Form 130 computation) with the TDS summary; Part A attached. */
export function renderCertificatePdf(data: Form16Data, pan: string, partA?: Attachment | null) {
  const f = data.forms;
  const title = `${data.fyStart >= 2026 ? `${f.certificate} (formerly ${f.certificateOld}) - salary TDS certificate` : `${f.certificate} - Part B (Annexure)`}${data.provisional ? " - PROVISIONAL" : ""}`;
  const doc = new PdfDocument({ title: `${title} ${data.fyLabel} ${data.employee.name}`, subject: `Certificate under section ${f.section} (formerly ${f.sectionOld}) for tax deducted at source on salary`, author: data.employer.name });
  header(doc, title, `${data.provisional ? "PROVISIONAL year-to-date statement, not a final certificate · " : ""}Certificate under section ${f.section}${f.section !== f.sectionOld ? ` (formerly ${f.sectionOld})` : ""} of the ${f.act} for tax deducted at source on salary · ${f.yearLabel}`, data, pan);
  const b = data.partB;
  section(doc, data.fyStart >= 2026 ? "Details of salary paid and tax deducted (Form 16 Part B / Form 130 Annexure I)" : "Part B - details of salary paid and any other income and tax deducted");
  rows(doc, [
    { label: "1. Gross salary", bold: true },
    { label: "(a) Salary as per provisions contained in section 17(1)", amount: b.salary17_1, sub: true },
    ...b.salaryLines.map((line) => ({ label: `    ${line.label}`, amount: line.amount, sub: true })),
    { label: "(b) Value of perquisites under section 17(2) (as per Form 12BA / Annexure II)", amount: b.perquisites17_2, sub: true },
    { label: "(c) Profits in lieu of salary under section 17(3)", amount: b.profitsInLieu17_3, sub: true },
    { label: "(d) Total", amount: b.grossSalary, bold: true },
    { label: "(e) Reported total amount of salary received from other employer(s)", amount: b.previousEmployerSalary, sub: true },
    { label: "2. Less: allowances to the extent exempt under section 10", bold: true },
    ...b.exemptions10.map((e) => ({ label: `(${e.section}) ${e.label}`, amount: e.amount, sub: true, note: data.regime === "NEW" ? "Not available in the new regime" : undefined })),
    { label: "Total amount of exemption claimed under section 10", amount: b.totalExemptions },
    { label: "3. Total amount of salary received from current employer [1(d) - 2]", amount: b.grossSalary - b.totalExemptions, bold: true },
    { label: "4. Less: deductions under section 16 (s.19 of the 2025 Act)", bold: true },
    { label: "(a) Standard deduction under section 16(ia)", amount: b.standardDeduction, sub: true },
    { label: "(b) Entertainment allowance under section 16(ii)", amount: b.entertainmentAllowance, sub: true },
    { label: "(c) Tax on employment under section 16(iii)", amount: b.professionalTax, sub: true, note: data.regime === "NEW" ? "Not deductible in the new regime" : undefined },
    { label: "5. Income chargeable under the head \"Salaries\" [incl. salary from other employers]", amount: b.incomeFromSalary, bold: true },
    { label: "6. Add: any other income reported by the employee", bold: true },
    { label: "(a) Income (or admissible loss) from house property reported by employee", amount: b.housePropertyLoss, sub: true },
    { label: "(b) Income under the head Other Sources offered for TDS", amount: b.otherIncome, sub: true },
    { label: "7. Gross total income (5 + 6)", amount: b.grossTotalIncome, bold: true },
    { label: `8. Deductions under Chapter VI-A${data.fyStart >= 2026 ? " (Chapter VIII of the 2025 Act)" : ""} - gross / deductible`, bold: true },
    ...b.chapterVIA.map((c) => ({ label: `(${c.section}) ${c.label} - gross ${rs(c.gross)}`, amount: c.deductible, sub: true })),
    { label: "9. Aggregate of deductible amounts under Chapter VI-A", amount: b.totalDeductions },
    { label: "10. Total taxable income (7 - 9), rounded to the nearest Rs. 10", amount: b.totalIncome, bold: true },
    { label: "11. Tax on total income", amount: b.taxOnTotalIncome },
    { label: `12. Rebate under section 87A (s.156 of the 2025 Act), if applicable${b.rebate87A ? " - incl. marginal relief" : ""}`, amount: b.rebate87A },
    { label: "13. Surcharge, wherever applicable", amount: b.surcharge },
    { label: "14. Health and education cess", amount: b.cess },
    { label: "15. Tax payable (11 - 12 + 13 + 14), rounded to the nearest Rs. 10", amount: b.taxPayable, bold: true },
    { label: "16. Less: relief under section 89 (arrears; Form 10E)", amount: b.relief89, note: "Relief for arrears is not computed by payroll; enter it from Form 10E if claimed." },
    { label: "17. Net tax payable (15 - 16)", amount: b.netTaxPayable, bold: true },
    { label: "Tax deducted at source - this employer", amount: b.tdsCurrentEmployer },
    { label: "Tax deducted at source - previous employer(s), as reported", amount: b.tdsPreviousEmployer },
    { label: b.balance >= 0 ? "Balance tax payable (shortfall)" : "Tax deducted in excess (refund to be claimed in the return)", amount: Math.abs(b.balance), bold: true },
  ]);
  quarterSection(doc, data);
  verification(doc, data, `${f.certificate}${f.certificate !== f.certificateOld ? ` / ${f.certificateOld}` : ""}`);
  notes(doc, data, partA ? [`The TRACES-issued part (Part A) is attached to this PDF as "${partA.name}" (open the attachments panel) and is also downloadable separately; it is attached unchanged so its digital signature stays valid.`]
    : ["Part A (from TRACES) has not been attached yet - download it from TRACES and upload it in Northstar HRM."]);
  return doc.toBuffer({ footer: footer(`${f.certificate} ${data.fyLabel} · ${data.employee.number}`), attachments: partA ? [partA] : [] });
}

function quarterSection(doc: PdfDocument, data: Form16Data) {
  section(doc, `Summary of tax deducted and deposited (quarterly ${data.forms.quarterly} statements)`);
  table(doc, [{ label: "Quarter", width: 50 }, { label: "Receipt / token no. of statement", width: 150 }, { label: "Amount paid / credited", width: 105, align: "right" }, { label: "Tax deducted", width: 95, align: "right" }, { label: "Tax deposited / remitted", width: 105, align: "right" }],
    [...data.quarters.map((q) => [q.quarter, q.token || (q.statementStatus === "NOT_FILED" ? "Not yet filed" : q.statementStatus), rs(q.amountPaid), rs(q.deducted), rs(q.deposited)]),
      ...(data.openingUnsplitTds ? [["Before switch-over", "Filed through the previous system", "-", rs(data.openingUnsplitTds), rs(data.openingUnsplitTds)]] : []),
      ["Total", "", rs(data.quarters.reduce((t, q) => t + q.amountPaid, 0)), rs(data.quarters.reduce((t, q) => t + q.deducted, 0) + data.openingUnsplitTds), rs(data.quarters.reduce((t, q) => t + q.deposited, 0) + data.openingUnsplitTds)]]);
  if (data.challans.length) {
    section(doc, "Tax deposited through challans (book identification number)");
    table(doc, [{ label: "Sr", width: 25 }, { label: "Month", width: 60 }, { label: "Tax deposited for this employee", width: 120, align: "right" }, { label: "BSR code", width: 70 }, { label: "Date of deposit", width: 80 }, { label: "Challan serial", width: 70 }, { label: "Quarter", width: 45 }],
      data.challans.map((c, i) => [String(i + 1), c.period, rs(c.tds), c.bsrCode, displayDate(c.depositDate), c.challanSerial, c.quarter]));
  }
}

/** Perquisite statement (Form 12BA / Form 130 Annexure II). */
export function renderPerquisitesPdf(data: Form16Data, pan: string) {
  const f = data.forms;
  const title = data.fyStart >= 2026 ? `${f.perquisites} (formerly ${f.perquisitesOld}) - perquisites` : "Form No. 12BA - statement of perquisites";
  const doc = new PdfDocument({ title: `${title} ${data.fyLabel} ${data.employee.name}`, subject: "Statement showing particulars of perquisites, other fringe benefits or amenities and profits in lieu of salary", author: data.employer.name });
  header(doc, title, "Statement showing particulars of perquisites, other fringe benefits or amenities and profits in lieu of salary with value thereof", data, pan);
  section(doc, "Valuation of perquisites");
  const p = data.perquisites;
  table(doc, [{ label: "Sr", width: 22 }, { label: "Nature of perquisite", width: 270 }, { label: "Value as per rules", width: 80, align: "right" }, { label: "Recovered from employee", width: 80, align: "right" }, { label: "Chargeable u/s 17(2)", width: 80, align: "right" }],
    [...p.items.map((item) => [String(item.sr), item.label, rs(item.value), rs(item.recovered), rs(item.chargeable)]),
      ["", "Total value of perquisites", rs(p.total), rs(0), rs(p.total)], ["", "Total value of profits in lieu of salary as per section 17(3)", rs(0), rs(0), rs(p.profitsInLieu)]]);
  section(doc, "Details of tax");
  rows(doc, [
    { label: "(a) Tax deducted from salary of the employee under section 192(1) / 392", amount: p.taxDeductedFromSalary },
    { label: "(b) Tax paid by employer on behalf of the employee under section 192(1A)", amount: p.taxPaidByEmployer },
    { label: "(c) Total tax paid", amount: p.taxDeductedFromSalary + p.taxPaidByEmployer, bold: true },
    { label: "(d) Date of payment into Government treasury", amount: "As per challans in the certificate" },
  ]);
  verification(doc, data, f.perquisites);
  notes(doc, data, [`Employer PF for the year Rs. ${inr(p.employerPf)}, employer NPS Rs. ${inr(p.employerNps)}: only the part of employer PF + NPS + superannuation above Rs. 7,50,000 is a perquisite (row 17). Interest/accretion on that excess (row 18) and non-cash perquisites (rows 1-16, 19) are not recorded in payroll and are shown as nil.`]);
  return doc.toBuffer({ footer: footer(`${f.perquisites} ${data.fyLabel} · ${data.employee.number}`) });
}

/** Employee-facing quarterly TDS summary (what was deducted each month and where it was deposited). */
export function renderTdsSummaryPdf(data: Form16Data, pan: string, months: { period: string; taxable: number; tds: number }[]) {
  const doc = new PdfDocument({ title: `Quarterly TDS summary ${data.fyLabel} ${data.employee.name}`, subject: "Salary TDS deducted and deposited", author: data.employer.name });
  header(doc, "Quarterly TDS summary", `Tax deducted from salary and deposited with the Government · ${data.forms.yearLabel}`, data, pan);
  section(doc, "Month-wise deduction");
  table(doc, [{ label: "Month", width: 80 }, { label: "Quarter", width: 60 }, { label: "Taxable salary", width: 120, align: "right" }, { label: "TDS deducted", width: 120, align: "right" }],
    months.map((m) => [m.period, m.period.slice(5) <= "03" ? "Q4" : m.period.slice(5) <= "06" ? "Q1" : m.period.slice(5) <= "09" ? "Q2" : "Q3", rs(m.taxable), rs(m.tds)]));
  quarterSection(doc, data);
  notes(doc, data, ["Check these figures against Form 26AS / the Annual Information Statement on the income-tax portal once the quarterly statement is processed."]);
  return doc.toBuffer({ footer: footer(`TDS summary ${data.fyLabel} · ${data.employee.number}`) });
}

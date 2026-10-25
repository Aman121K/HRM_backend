/**
 * Tax invoice / credit note PDF. Carries the particulars CGST Rules 46 (tax invoice) and 53 (credit note) ask for:
 * supplier and recipient name, address and GSTIN, a consecutive serial number (≤16 chars), date, SAC, description,
 * taxable value, rate and amount of CGST+SGST or IGST, place of supply with state name and code, whether tax is payable on
 * reverse charge, and the supplier's signature block. For credit notes: the original invoice number and date.
 * Payslips (payroll/documents.ts) are printable HTML; invoices need a real file the customer's accounts team can archive,
 * so this module writes the PDF directly with the small writer in ./pdf (no new dependency).
 */
import { formatInr, rupeesInWords, stateLabel } from "./billing.engine";
import { PdfDocument } from "./pdf";

export type Party = { legalName: string; tradeName?: string | null; gstin?: string | null; pan?: string | null; address: string; stateCode: string; email?: string | null; phone?: string | null };
export type DocumentLine = { description: string; quantity?: number | null; unitPricePaise?: number | null; amountPaise: number };
export type BillingDocument = {
  kind: "INVOICE" | "CREDIT_NOTE";
  number: string | null; issueDate: string | null; dueDate?: string | null; periodStart?: string; periodEnd?: string;
  placeOfSupply: string; supplyType: "INTRA" | "INTER"; sacCode: string; gstRate: number;
  seller: Party; buyer: Party; lines: DocumentLine[];
  subtotalPaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number;
  isDemo?: boolean; draft?: boolean; bankDetails?: string | null;
  original?: { number: string; issueDate: string }; reason?: string;
  receivable?: { paidPaise: number; creditedPaise: number; outstandingPaise: number };
};

const INK: [number, number, number] = [0.09, 0.2, 0.24];
const MUTED: [number, number, number] = [0.38, 0.46, 0.48];
const TEAL: [number, number, number] = [0.04, 0.38, 0.36];
const RED: [number, number, number] = [0.64, 0.25, 0.18];
const longDate = (iso?: string | null) => {
  if (!iso) return "—";
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${Number(iso.slice(8, 10))} ${months[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
};

export function renderBillingPdf(doc: BillingDocument) {
  const isCredit = doc.kind === "CREDIT_NOTE";
  const title = isCredit ? "CREDIT NOTE" : doc.draft ? "DRAFT INVOICE" : "TAX INVOICE";
  const pdf = new PdfDocument({ title: `${title} ${doc.number || "(draft)"}`, author: doc.seller.legalName });
  const left = 40, right = pdf.width - 40, contentWidth = right - left;
  let y = 0;

  const header = () => {
    pdf.rect(0, 0, pdf.width, 6, TEAL);
    y = 44;
    if (doc.isDemo || doc.draft) {
      pdf.text(doc.isDemo ? "DEMO — NOT A VALID TAX DOCUMENT" : "DRAFT — NOT ISSUED, NOT A VALID TAX INVOICE", right, 26, { size: 9, bold: true, color: RED, align: "right" });
    }
    pdf.text(doc.seller.tradeName || doc.seller.legalName, left, y, { size: 16, bold: true });
    pdf.text(title, right, y, { size: 16, bold: true, color: TEAL, align: "right" });
    y += 14;
    const sellerLines = [doc.seller.tradeName && doc.seller.tradeName !== doc.seller.legalName ? doc.seller.legalName : null,
      ...pdf.wrap(doc.seller.address, 260, 8), `State: ${stateLabel(doc.seller.stateCode)}`,
      doc.seller.gstin ? `GSTIN: ${doc.seller.gstin}` : "GSTIN: (not configured)", doc.seller.pan ? `PAN: ${doc.seller.pan}` : null,
      [doc.seller.email, doc.seller.phone].filter(Boolean).join(" · ") || null].filter(Boolean) as string[];
    const metaRows: [string, string][] = isCredit
      ? [["Credit note no.", doc.number || "—"], ["Date", longDate(doc.issueDate)], ["Against invoice", doc.original?.number || "—"], ["Invoice date", longDate(doc.original?.issueDate)]]
      : [["Invoice no.", doc.number || "Assigned on issue"], ["Invoice date", longDate(doc.issueDate)], ["Due date", longDate(doc.dueDate)],
         ["Service period", doc.periodStart ? `${longDate(doc.periodStart)} – ${longDate(doc.periodEnd)}` : "—"]];
    metaRows.push(["Place of supply", stateLabel(doc.placeOfSupply)], ["Reverse charge", "No"]);
    let sy = y, my = y;
    for (const line of sellerLines) { pdf.text(line, left, sy, { size: 8, color: MUTED }); sy += 11; }
    for (const [label, value] of metaRows) {
      pdf.text(label, right - 150, my, { size: 8, color: MUTED });
      pdf.text(value, right, my, { size: 8, bold: true, align: "right" });
      my += 11;
    }
    y = Math.max(sy, my) + 8;
    pdf.line(left, y, right, y, 1.2, TEAL);
    y += 16;
  };
  header();

  // Recipient
  pdf.text(isCredit ? "ISSUED TO" : "BILL TO", left, y, { size: 7.5, bold: true, color: MUTED });
  y += 12;
  pdf.text(doc.buyer.legalName, left, y, { size: 10, bold: true });
  y += 12;
  for (const line of [...pdf.wrap(doc.buyer.address, 330, 8.5), `State: ${stateLabel(doc.buyer.stateCode)}`,
    doc.buyer.gstin ? `GSTIN: ${doc.buyer.gstin}` : "GSTIN: Unregistered", doc.buyer.email ? `Billing contact: ${doc.buyer.email}` : ""].filter(Boolean)) {
    pdf.text(line, left, y, { size: 8.5 }); y += 11;
  }
  y += 10;

  // Lines table
  const cols = { no: left + 4, desc: left + 26, sac: right - 205, qty: right - 150, rate: right - 80, amount: right - 4 };
  const tableHead = () => {
    pdf.rect(left, y - 11, contentWidth, 17, [0.95, 0.95, 0.92]);
    pdf.text("#", cols.no, y, { size: 7.5, bold: true, color: MUTED });
    pdf.text("DESCRIPTION OF SERVICE", cols.desc, y, { size: 7.5, bold: true, color: MUTED });
    pdf.text("SAC", cols.sac, y, { size: 7.5, bold: true, color: MUTED });
    pdf.text("QTY", cols.qty, y, { size: 7.5, bold: true, color: MUTED, align: "right" });
    pdf.text("RATE (INR)", cols.rate, y, { size: 7.5, bold: true, color: MUTED, align: "right" });
    pdf.text("AMOUNT (INR)", cols.amount, y, { size: 7.5, bold: true, color: MUTED, align: "right" });
    y += 16;
  };
  tableHead();
  doc.lines.forEach((line, index) => {
    const wrapped = pdf.wrap(line.description, cols.sac - cols.desc - 10, 8.5);
    if (y + wrapped.length * 11 > pdf.height - 230) { pdf.addPage(); header(); tableHead(); }
    pdf.text(String(index + 1), cols.no, y, { size: 8.5, color: MUTED });
    wrapped.forEach((text, row) => pdf.text(text, cols.desc, y + row * 11, { size: 8.5 }));
    pdf.text(doc.sacCode, cols.sac, y, { size: 8.5 });
    if (line.quantity !== undefined && line.quantity !== null) pdf.text(String(Number(line.quantity)), cols.qty, y, { size: 8.5, align: "right" });
    if (line.unitPricePaise !== undefined && line.unitPricePaise !== null) pdf.text(formatInr(line.unitPricePaise), cols.rate, y, { size: 8.5, align: "right" });
    pdf.text(formatInr(line.amountPaise), cols.amount, y, { size: 8.5, align: "right", bold: line.amountPaise < 0 });
    y += wrapped.length * 11 + 5;
    pdf.line(left, y - 9, right, y - 9);
  });
  if (y > pdf.height - 230) { pdf.addPage(); header(); }

  // Totals
  y += 6;
  const totals: [string, number, boolean?][] = [[isCredit ? "Taxable value reduced" : "Taxable value", doc.subtotalPaise]];
  if (doc.supplyType === "INTRA") {
    totals.push([`CGST @ ${doc.gstRate / 2}%`, doc.cgstPaise], [`SGST @ ${doc.gstRate / 2}%`, doc.sgstPaise]);
  } else totals.push([`IGST @ ${doc.gstRate}%`, doc.igstPaise]);
  totals.push([isCredit ? "Total credit (incl. GST)" : "Total (incl. GST)", doc.totalPaise, true]);
  for (const [label, value, strong] of totals) {
    if (strong) { pdf.line(right - 230, y - 9, right, y - 9, 1, INK); y += 3; }
    pdf.text(label, right - 120, y, { size: strong ? 10 : 8.5, bold: !!strong, align: "right" });
    pdf.text(formatInr(value), right - 4, y, { size: strong ? 10 : 8.5, bold: !!strong, align: "right" });
    y += strong ? 16 : 12;
  }
  pdf.text(`Amount in words: ${rupeesInWords(doc.totalPaise)}`, left, y, { size: 8.5, bold: true });
  y += 14;
  if (doc.receivable && !isCredit && (doc.receivable.paidPaise || doc.receivable.creditedPaise)) {
    pdf.text(`Received: INR ${formatInr(doc.receivable.paidPaise)} · Credit notes: INR ${formatInr(doc.receivable.creditedPaise)} · Balance due: INR ${formatInr(doc.receivable.outstandingPaise)}`,
      left, y, { size: 8.5, color: TEAL, bold: true });
    y += 14;
  }
  if (isCredit && doc.reason) {
    for (const text of pdf.wrap(`Reason: ${doc.reason}`, contentWidth, 8.5)) { pdf.text(text, left, y, { size: 8.5 }); y += 11; }
    y += 4;
  }
  pdf.text(`Tax on this ${isCredit ? "credit note" : "invoice"} is ${doc.supplyType === "INTRA" ? "CGST + SGST (intra-state supply)" : "IGST (inter-state supply)"}; SAC ${doc.sacCode}.`, left, y, { size: 8, color: MUTED });
  y += 18;

  if (!isCredit && doc.bankDetails) {
    pdf.text("PAYMENT DETAILS", left, y, { size: 7.5, bold: true, color: MUTED });
    y += 11;
    for (const text of pdf.wrap(doc.bankDetails, 300, 8)) { pdf.text(text, left, y, { size: 8 }); y += 10; }
    pdf.text(`Please quote ${doc.number || "the invoice number"} as the payment reference.`, left, y, { size: 8, color: MUTED });
  }
  // Signature block (bottom right of the last page)
  const sigY = Math.max(y - (doc.bankDetails && !isCredit ? 40 : 0), pdf.height - 150);
  pdf.text(`For ${doc.seller.legalName}`, right, sigY, { size: 8.5, bold: true, align: "right" });
  pdf.text("Authorised signatory", right, sigY + 40, { size: 8, color: MUTED, align: "right" });
  pdf.line(right - 150, sigY + 30, right, sigY + 30, 0.6, INK);

  pdf.line(left, pdf.height - 60, right, pdf.height - 60);
  pdf.text("This is a computer-generated document. Subject to the terms of the subscription agreement.", left, pdf.height - 46, { size: 7.5, color: MUTED });
  return pdf.toBuffer();
}

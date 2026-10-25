// Indian receipt text → structured fields. Pure (no I/O) so it is unit-tested in receipt-parser.test.ts
// (npx tsx --test src/platform/receipts/*.test.ts). Used on tesseract OCR output and PDF text layers.

export const EXPENSE_CATEGORIES = ["Local travel", "Fuel & mileage", "Meals", "Client entertainment", "Internet & phone", "Learning", "Store supplies", "Other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export type ReceiptFields = {
  merchant?: string; date?: string; total?: number; currency?: string; tax?: number; gstin?: string; invoiceNumber?: string; category?: ExpenseCategory;
};
export type ReceiptLine = { description: string; amount: number };
export type ParsedReceipt = { fields: ReceiptFields; lines: ReceiptLine[]; warnings: string[]; score: number };

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?";

/** An amount token: Indian (1,23,456.00) or western (123,456.00) grouping, or plain digits, with optional decimals. */
const AMOUNT_SOURCE = String.raw`(?<![\w.,/-])(?:(?:₹|rs\.?|inr)\s*)?(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?![\w%/:]|[.,]\d)`;

function amountsIn(line: string): { value: number; marked: boolean; decimals: boolean }[] {
  const cleaned = line
    .replace(/\d+(?:\.\d+)?\s*%/g, " ") // rates: "CGST @ 2.5%"
    .replace(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, " ") // dates
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi, " "); // times
  const out: { value: number; marked: boolean; decimals: boolean }[] = [];
  const re = new RegExp(AMOUNT_SOURCE, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(cleaned))) {
    const raw = match[1];
    const value = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    out.push({ value, marked: /₹|rs|inr/i.test(match[0]), decimals: raw.includes(".") });
  }
  return out;
}

function normalise(text: string) {
  return text
    .replace(/\r/g, "")
    .replace(/[₹]|&#8377;|रु/g, "₹") // ₹ / "रु"
    .replace(/\b(?:rs|r5|rs,)\s*[.:]?\s*(?=\d)/gi, "Rs ")
    .replace(/[|]/g, " ")
    .replace(/[ \t]+/g, " ");
}

const round2 = (value: number) => Math.round(value * 100) / 100;

// ---- total ------------------------------------------------------------------------------------------------------------

const TOTAL_STRONG = /(grand\s*t[o0]ta[l1]|amount\s*payable|net\s*payable|t[o0]ta[l1]\s*payable|payable\s*amount|amount\s*due|t[o0]ta[l1]\s*due|net\s*amount|bill\s*amount|invoice\s*(?:total|amount|value)|t[o0]ta[l1]\s*amount\s*(?:paid|payable)?|amount\s*paid|t[o0]ta[l1]\s*paid|t[o0]ta[l1]\s*fare|total\s*\(?incl|you\s*paid|paid\s*amount|t[o0]ta[l1]\s*(?:rs|inr|₹))/i;
const TOTAL_WEAK = /\bt[o0]ta[l1]\b|^\s*(?:amount|amt)\s*(?:\(\s*(?:rs|inr|₹)\.?\s*\)|rs|inr|₹)?\s*[:.]/i; // fuel slips: "AMOUNT(Rs): 2000.00"
const NOT_TOTAL = /(sub\s*-?\s*t[o0]ta[l1]|taxable|t[o0]ta[l1]\s*(?:tax|gst|cgst|sgst|qty|quantity|items?|savings?|discount|before)|before\s*tax|savings|you\s*saved)/i;

function findTotal(lines: string[]): { value: number; strength: "strong" | "weak" | "fallback" } | null {
  let best: { value: number; rank: number; index: number } | null = null;
  lines.forEach((line, index) => {
    const rank = NOT_TOTAL.test(line) ? 0 : TOTAL_STRONG.test(line) ? 2 : TOTAL_WEAK.test(line) ? 1 : 0;
    if (!rank) return;
    let amounts = amountsIn(line);
    if (!amounts.length && lines[index + 1]) amounts = amountsIn(lines[index + 1]); // label and value on separate lines
    if (!amounts.length) return;
    const value = amounts[amounts.length - 1].value;
    if (value <= 0) return;
    // Higher rank wins; within a rank the larger amount wins (e.g. "Total" vs "Total incl. GST").
    if (!best || rank > best.rank || (rank === best.rank && value > best.value)) best = { value, rank, index };
  });
  const chosen = best as { value: number; rank: number } | null;
  if (chosen) return { value: chosen.value, strength: chosen.rank === 2 ? "strong" : "weak" };
  // Fallback: the largest currency-marked amount, else the largest amount with paise.
  const all = lines.flatMap((line) => amountsIn(line));
  const marked = all.filter((amount) => amount.marked);
  const pool = marked.length ? marked : all.filter((amount) => amount.decimals);
  if (!pool.length) return null;
  return { value: Math.max(...pool.map((amount) => amount.value)), strength: "fallback" };
}

// ---- tax --------------------------------------------------------------------------------------------------------------

function findTax(lines: string[]): number | undefined {
  let totalTax: number | undefined;
  const parts: Record<string, number> = {};
  for (const line of lines) {
    if (/gstin|gst\s*no|gst\s*reg/i.test(line)) continue;
    const amounts = amountsIn(line);
    if (!amounts.length) continue;
    const value = amounts[amounts.length - 1].value;
    if (/t[o0]ta[l1]\s*(?:tax|gst)|tax\s*amount|gst\s*amount/i.test(line)) { totalTax = value; continue; }
    const kind = /\bcgst\b/i.test(line) ? "cgst" : /\bsgst\b/i.test(line) ? "sgst" : /\butgst\b/i.test(line) ? "utgst" : /\bigst\b/i.test(line) ? "igst"
      : /\bcess\b/i.test(line) ? "cess" : /\b(gst|vat)\b/i.test(line) && !/incl|inclusive/i.test(line) ? "gst" : null;
    if (kind && parts[kind] === undefined) parts[kind] = value;
  }
  if (totalTax !== undefined) return round2(totalTax);
  const split = (parts.cgst || 0) + (parts.sgst || 0) + (parts.utgst || 0) + (parts.igst || 0) + (parts.cess || 0);
  if (split > 0) return round2(split);
  return parts.gst !== undefined ? round2(parts.gst) : undefined;
}

// ---- date -------------------------------------------------------------------------------------------------------------

function iso(year: number, month: number, day: number): string | null {
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null;
  return date.toISOString().slice(0, 10);
}

export function datesIn(line: string): string[] {
  const found: string[] = [];
  const text = line.toLowerCase();
  let match: RegExpExecArray | null;
  const numeric = /\b(\d{1,4})[/.-](\d{1,2})[/.-](\d{2,4})\b/g;
  while ((match = numeric.exec(text))) {
    const [a, b, c] = [Number(match[1]), Number(match[2]), Number(match[3])];
    // yyyy-mm-dd, else Indian day-first (dd/mm/yyyy); mm/dd only when the "month" cannot be a month.
    const value = match[1].length === 4 ? iso(a, b, c) : b > 12 && a <= 12 ? iso(c, a, b) : iso(c, b, a);
    if (value) found.push(value);
  }
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s/.-]*${MONTH_RE}[\\s/.,'-]*(\\d{2,4})\\b`, "g");
  while ((match = dayMonth.exec(text))) {
    const value = iso(Number(match[3]), MONTHS[match[2].slice(0, 3)] || MONTHS[match[2]], Number(match[1]));
    if (value) found.push(value);
  }
  const monthDay = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "g");
  while ((match = monthDay.exec(text))) {
    const value = iso(Number(match[3]), MONTHS[match[1].slice(0, 3)], Number(match[2]));
    if (value) found.push(value);
  }
  return found;
}

function findDate(lines: string[]): string | undefined {
  const labelled = lines.filter((line) => /\b(date|dt|dated|bill\s*dt|invoice\s*date|txn\s*date)\b/i.test(line) && !/due\s*date|valid|expiry|exp\b/i.test(line));
  for (const line of labelled) { const dates = datesIn(line); if (dates.length) return dates[0]; }
  for (const line of lines) {
    if (/due\s*date|valid\s*(till|upto)|expiry/i.test(line)) continue;
    const dates = datesIn(line);
    if (dates.length) return dates[0];
  }
  return undefined;
}

// ---- identifiers ------------------------------------------------------------------------------------------------------

export const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/;

function findGstin(text: string): string | undefined {
  const upper = text.toUpperCase();
  const direct = upper.match(GSTIN_RE);
  if (direct) return direct[0];
  // OCR often reads 0 as O inside the digit blocks: retry on "GSTIN" lines with O→0 in numeric positions.
  for (const line of upper.split("\n").filter((value) => /GST/.test(value))) {
    const candidate = line.replace(/[^A-Z0-9 ]/g, " ").split(" ").find((token) => token.length === 15);
    if (!candidate) continue;
    const fixed = candidate.split("").map((char, index) => ([0, 1, 7, 8, 9, 10].includes(index) && char === "O" ? "0" : char)).join("");
    if (GSTIN_RE.test(fixed)) return fixed;
  }
  return undefined;
}

function findInvoiceNumber(lines: string[]): string | undefined {
  const re = /\b(?:tax\s*)?(?:invoice|inv|bill|receipt|rcpt|txn|transaction|order|trip)\s*(?:no|number|num|id|#)?\s*[.:#-]*\s*(?:no\.?\s*[:#-]?\s*)?([A-Z0-9][A-Z0-9/_-]{2,30})/i;
  for (const line of lines) {
    if (GSTIN_RE.test(line.toUpperCase())) continue;
    const match = re.exec(line);
    if (match && /\d/.test(match[1]) && !/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(match[1])) return match[1].replace(/[-/]+$/, "");
  }
  return undefined;
}

// ---- merchant + category ----------------------------------------------------------------------------------------------

const BRANDS: [RegExp, string][] = [
  [/\buber\b/i, "Uber"], [/\bola\b|ola\s*cabs|ani\s*technologies/i, "Ola"], [/\brapido\b/i, "Rapido"], [/blu\s*smart/i, "BluSmart"],
  [/namma\s*yatri/i, "Namma Yatri"], [/\bswiggy\b/i, "Swiggy"], [/\bzomato\b/i, "Zomato"], [/starbucks/i, "Starbucks"],
  [/blue\s*tokai/i, "Blue Tokai Coffee Roasters"], [/chaayos/i, "Chaayos"], [/hindustan\s*petroleum|\bhpcl\b|\bhp\s*petrol/i, "HPCL"],
  [/indian\s*oil|\biocl?\b/i, "Indian Oil"], [/bharat\s*petroleum|\bbpcl\b/i, "BPCL"], [/jio[-\s]?bp/i, "Jio-bp"], [/\bnayara\b/i, "Nayara Energy"],
  [/\bairtel\b|bharti\s*airtel/i, "Airtel"], [/reliance\s*jio|\bjio\b(?![-\s]?bp)/i, "Jio"], [/vodafone|\bvi\b\s*(?:postpaid|prepaid)/i, "Vi"],
  [/\bbsnl\b/i, "BSNL"], [/act\s*fibernet/i, "ACT Fibernet"],
];

const SKIP_MERCHANT = /(tax\s*invoice|\binvoice\b|\breceipt\b|bill\s*of\s*supply|cash\s*memo|\boriginal\b|\bduplicate\b|customer\s*copy|\bwelcome\b|\bthank|\bgstin\b|gst\s*no|\bfssai\b|\bph(?:one)?\b|\btel\b|\bmob(?:ile)?\s*[:.]|e-?mail|www\.|http|\bdate\b|\btime\b|\btable\b|order\s*(no|#|id)|bill\s*no|\bcashier\b|^\W*$)/i;

function findMerchant(lines: string[], text: string): string | undefined {
  const head = lines.slice(0, 8).join("\n");
  for (const [re, name] of BRANDS) if (re.test(head)) return name;
  for (const line of lines.slice(0, 10)) {
    const letters = (line.match(/[a-z]/gi) || []).length;
    if (letters < 3 || letters / line.length < 0.5 || line.length > 60 || SKIP_MERCHANT.test(line)) continue;
    if (amountsIn(line).some((amount) => amount.decimals || amount.marked)) continue;
    return line.replace(/[^\p{L}\p{N}&'.,()\- ]/gu, "").replace(/\s+/g, " ").trim().slice(0, 80) || undefined;
  }
  for (const [re, name] of BRANDS) if (re.test(text)) return name;
  return undefined;
}

const CATEGORY_RULES: [ExpenseCategory, RegExp, number][] = [
  ["Fuel & mileage", /\b(petrol|diesel|fuel|hpcl|iocl?|bpcl|indian\s*oil|bharat\s*petroleum|hindustan\s*petroleum|jio[-\s]?bp|nayara|shell|filling\s*station|petroleum|litre|ltrs?|cng)\b/gi, 3],
  ["Local travel", /\b(uber|ola|rapido|blu\s*smart|namma\s*yatri|meru|taxi|cab|auto\s*rickshaw|autorickshaw|metro|trip|ride|fare|driver|pickup|drop|parking|toll|fastag)\b/gi, 2],
  ["Internet & phone", /\b(airtel|jio|vodafone|vi\s+postpaid|bsnl|broadband|fibernet|fiber|fibre|internet|wifi|wi-fi|postpaid|prepaid|recharge|mobile\s*bill|data\s*pack|hathway|excitel|telecom)\b/gi, 3],
  ["Meals", /\b(swiggy|zomato|restaurant|caf[eé]|coffee|cappuccino|latte|espresso|tea|chai|dine|dining|food|kitchen|dhaba|biryani|pizza|burger|sandwich|meal|lunch|dinner|breakfast|starbucks|chaayos|mcdonald'?s?|domino'?s?|kfc|bakery|fssai|thali|dosa|paneer|naan)\b/gi, 2],
  ["Learning", /\b(udemy|coursera|course|certification|training|workshop|seminar|conference|books?|exam\s*fee|tuition|webinar)\b/gi, 3],
  ["Store supplies", /\b(stationery|supplies|dmart|d-mart|bigbasket|blinkit|zepto|cleaning|detergent|packaging|hardware|printer|toner|paper\s*cups|tissue|office\s*supplies)\b/gi, 2],
];

export function guessCategory(text: string): ExpenseCategory {
  const lower = text.toLowerCase().replace(/jio[-\s]?bp/g, "jio-bp fuel");
  let best: { category: ExpenseCategory; score: number } | null = null;
  for (const [category, re, weight] of CATEGORY_RULES) {
    let source = lower;
    if (category === "Internet & phone") source = source.replace(/jio-bp/g, " ");
    const hits = (source.match(new RegExp(re.source, "gi")) || []).length;
    const score = hits * weight;
    if (score > 0 && (!best || score > best.score)) best = { category, score };
  }
  return best?.category || "Other";
}

// ---- line items -------------------------------------------------------------------------------------------------------

const NOT_ITEM = /(t[o0]ta[l1]|gst|tax|cgst|sgst|igst|cess|vat|round|discount|cash|card|upi|change|paid|payable|balance|tender|date|time|invoice|bill\s*no|gstin|phone|tel|fssai|qty|rate|amount|net|savings|tip|service\s*charge|pin|km|mins?|volume|litres?|ltrs?|nozzle|taxable)\b/i;

function findLines(lines: string[], total?: number): ReceiptLine[] {
  const items: ReceiptLine[] = [];
  for (const line of lines) {
    if (NOT_ITEM.test(line)) continue;
    const amounts = amountsIn(line);
    if (!amounts.length) continue;
    const last = amounts[amounts.length - 1];
    if (!last.decimals && !last.marked) continue;
    const description = line.replace(new RegExp(`${AMOUNT_SOURCE}\\s*$`, "i"), "").replace(/\s+\d+(?:\.\d+)?\s*[x×@]\s*\d+(?:\.\d+)?\s*$/i, "").replace(/[₹:.\-\s]+$/, "").trim();
    if ((description.match(/[a-z]/gi) || []).length < 2) continue;
    if (total !== undefined && last.value > total) continue;
    items.push({ description: description.slice(0, 120), amount: last.value });
    if (items.length >= 30) break;
  }
  return items;
}

// ---- entry point ------------------------------------------------------------------------------------------------------

export function parseReceiptText(raw: string, today = new Date()): ParsedReceipt {
  const text = normalise(raw || "");
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const warnings: string[] = [];
  const fields: ReceiptFields = {};
  if (!lines.length) return { fields, lines: [], warnings: ["No text could be read from this receipt. Try a sharper, well-lit photo."], score: 0 };

  const total = findTotal(lines);
  if (total) fields.total = round2(total.value);
  else warnings.push("Couldn't find the total amount — please enter it.");
  if (total?.strength === "fallback") warnings.push("The total was guessed from the largest amount on the receipt — please check it.");

  const date = findDate(lines);
  if (date) {
    fields.date = date;
    const todayIso = today.toISOString().slice(0, 10);
    if (date > todayIso) warnings.push("The receipt date is in the future — please check it.");
    else if ((Date.parse(todayIso) - Date.parse(date)) / 86_400_000 > 60) warnings.push("This receipt is more than 60 days old; your claim may be flagged.");
  } else warnings.push("Couldn't find the receipt date — please enter it.");

  const merchant = findMerchant(lines, text);
  if (merchant) fields.merchant = merchant;
  const gstin = findGstin(text);
  if (gstin) fields.gstin = gstin;
  const invoiceNumber = findInvoiceNumber(lines);
  if (invoiceNumber) fields.invoiceNumber = invoiceNumber;
  const tax = findTax(lines);
  if (tax !== undefined && (!fields.total || tax < fields.total)) fields.tax = tax;
  const foreign = /\$\s*\d|\bUSD\b|€|\bEUR\b|£|\bGBP\b/.test(text) && !/₹|\bRs\b|\bINR\b/i.test(text);
  fields.currency = foreign ? (/€|\bEUR\b/.test(text) ? "EUR" : /£|\bGBP\b/.test(text) ? "GBP" : "USD") : "INR";
  if (foreign) warnings.push(`Amounts look like ${fields.currency}, not INR — claims are reimbursed in INR.`);
  fields.category = guessCategory(text);

  const items = findLines(lines, fields.total);
  const score = (fields.total ? (total?.strength === "strong" ? 0.4 : total?.strength === "weak" ? 0.32 : 0.18) : 0)
    + (fields.date ? 0.22 : 0) + (fields.merchant ? 0.16 : 0) + (fields.gstin ? 0.08 : 0) + (fields.invoiceNumber ? 0.07 : 0) + (fields.tax !== undefined ? 0.07 : 0);
  return { fields, lines: items, warnings, score: Math.min(1, round2(score)) };
}

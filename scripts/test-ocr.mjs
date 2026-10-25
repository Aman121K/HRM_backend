// End-to-end receipt OCR check against the running API (:4100).
//   set -a; . ./.env; set +a; node scripts/test-ocr.mjs [--keep]
// Renders synthetic receipts (PNG via @napi-rs/canvas when available — it ships with pdf-parse — plus a text-layer PDF
// and an image-only PDF written by hand), scans them as BT002, prints what was extracted, then exercises duplicate
// detection and attaching to a fresh expenses claim (flags). Claims it creates are withdrawn at the end unless --keep.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const API = process.env.PLATFORM_API_URL || "http://localhost:4100";
const headers = { "x-tenant-id": "tenant-demo-001", "x-employee-id": "BT002", "content-type": "application/json" };
const OUT = join(process.cwd(), ".data", "ocr", "samples");
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (label, ok, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); };

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : method === "GET" ? undefined : "{}" });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

// ---- synthetic receipts -----------------------------------------------------------------------------------------------
const today = new Date();
const ddmmyyyy = (d) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n) => new Date(today.getTime() - n * 86_400_000);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const run = Date.now().toString().slice(-5); // makes each run's receipts unique (fresh sha256)

const RECEIPTS = [
  { name: "restaurant.png", expect: { merchant: "THE BOMBAY CANTEEN", total: 1212, date: iso(daysAgo(3)), category: "Meals", gstin: "27AADCB2230M1ZT" }, lines: [
    "THE BOMBAY CANTEEN", "Kamala Mills, Lower Parel, Mumbai", "GSTIN: 27AADCB2230M1ZT", `Bill No: ${run}   Table: 12`, `Date: ${ddmmyyyy(daysAgo(3))}  21:37`,
    "Butter Chicken      1     645.00", "Garlic Naan         3     270.00", "Masala Chaas        2     240.00", "Sub Total               1,155.00",
    "CGST @ 2.5%                28.88", "SGST @ 2.5%                28.88", "Round Off                  -0.76", "Grand Total        Rs 1,212.00", "Thank you! Visit again"] },
  { name: "fuel.png", small: true, expect: { merchant: "HPCL", total: 2000, date: iso(daysAgo(5)), category: "Fuel & mileage" }, lines: [
    "HINDUSTAN PETROLEUM CORP LTD", "SHREE SAI AUTO SERVICES", "MG ROAD PUNE", `RECEIPT NO: 0${run}`,
    `DATE: ${String(daysAgo(5).getDate()).padStart(2, "0")}-${MON[daysAgo(5).getMonth()]}-${String(daysAgo(5).getFullYear()).slice(2)}  TIME: 09:14`,
    "PRODUCT: PETROL", "RATE(Rs/L): 104.21", "VOLUME(L): 19.19", "AMOUNT(Rs): 2000.00", "Thank you. Visit again"] },
  { name: "cab.png", tilt: true, expect: { merchant: "Uber", total: 412.63, date: iso(daysAgo(2)), category: "Local travel" }, lines: [
    "Uber", "Here's your receipt for your ride", `Total  Rs 412.63`, "Trip fare  Rs 371.20", "Booking Fee  Rs 21.00", "Subtotal  Rs 392.20",
    "CGST 2.5%  Rs 9.80", "SGST 2.5%  Rs 9.80", `${daysAgo(2).getDate()} ${MON[daysAgo(2).getMonth()]} ${daysAgo(2).getFullYear()}, 7:42 pm`, `Ride ID: 8F3A-${run}`] },
];

function renderPng(receipt) {
  let canvasLib;
  try { canvasLib = require("@napi-rs/canvas"); } catch { return null; }
  const size = receipt.small ? 22 : 28;
  const width = 760; const height = 90 + receipt.lines.length * (size + 16);
  const canvas = canvasLib.createCanvas(width, height);
  const g = canvas.getContext("2d");
  g.fillStyle = receipt.tilt ? "#eeeae2" : "#ffffff"; g.fillRect(0, 0, width, height);
  if (receipt.tilt) { g.translate(width / 2, height / 2); g.rotate((1.2 * Math.PI) / 180); g.translate(-width / 2, -height / 2); }
  g.fillStyle = "#1b1b1b"; g.font = `${size}px monospace`;
  receipt.lines.forEach((line, index) => g.fillText(line, 40, 60 + index * (size + 16)));
  return canvas.toBuffer("image/png");
}

/** Minimal single-page PDF with a Helvetica text layer (or, with image=true, only a tiny grey image — no text). */
function makePdf(lines, image = false) {
  const objects = [];
  const content = image
    ? "q 200 0 0 100 50 600 cm /Im1 Do Q"
    : `BT /F1 12 Tf 50 780 Td 16 TL ${lines.map((line) => `(${line.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj T*`).join(" ")} ET`;
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << ${image ? "/XObject << /Im1 6 0 R >>" : "/Font << /F1 5 0 R >>"} >> /Contents 4 0 R >>`);
  objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  if (image) objects.push(`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n\x80\x90\xa0\xb0\nendstream`);
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, index) => { const at = Buffer.byteLength(pdf, "latin1"); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const scans = [];
async function scan(name, mimeType, bytes, expect) {
  writeFileSync(join(OUT, name), bytes);
  const started = Date.now();
  const { status, json } = await api("POST", "/api/v2/receipts/scan", { originalName: name, mimeType, base64: bytes.toString("base64") });
  const ms = Date.now() - started;
  if (status !== 200) { check(`${name} scanned`, false, `${status} ${JSON.stringify(json)}`); return null; }
  console.log(`\n${name} (${mimeType}, ${bytes.length} B) → provider=${json.provider} confidence=${json.confidence} in ${ms} ms`);
  console.log(`      fields: ${JSON.stringify(json.fields)}`);
  if (json.lines) console.log(`      lines:  ${JSON.stringify(json.lines)}`);
  if (json.warnings?.length) console.log(`      warnings: ${JSON.stringify(json.warnings)}`);
  if (json.duplicateOf) console.log(`      duplicateOf: ${JSON.stringify(json.duplicateOf)}`);
  if (expect) for (const [key, value] of Object.entries(expect))
    check(`${name}: ${key}`, json.fields?.[key] === value, `got ${JSON.stringify(json.fields?.[key])}, expected ${JSON.stringify(value)}`);
  scans.push({ name, bytes, mimeType, result: json });
  return json;
}

const createdCases = [];
try {
  for (const receipt of RECEIPTS) {
    const png = renderPng(receipt);
    if (png) await scan(receipt.name, "image/png", png, receipt.expect);
    else console.log(`SKIP  ${receipt.name}: @napi-rs/canvas not installed (image rendering unavailable)`);
  }
  const pdfLines = ["Reliance Jio Infocomm Ltd", "JioFiber Broadband - Tax Invoice", `Invoice Number: JF${run}0231`, `Invoice Date: ${ddmmyyyy(daysAgo(4)).replace(/\//g, "-")}`,
    "Plan: 100 Mbps Monthly", "Taxable Value 846.61", "CGST 9% 76.20", "SGST 9% 76.20", "Total Amount Due Rs 999.01"];
  await scan("jiofiber.pdf", "application/pdf", makePdf(pdfLines), { merchant: "Jio", total: 999.01, date: iso(daysAgo(4)), category: "Internet & phone", tax: 152.4 });
  const imageOnly = await scan("scanned.pdf", "application/pdf", makePdf([], true));
  check("image-only PDF asks for a photo", !!imageOnly?.warnings?.some((w) => /photo/i.test(w)), imageOnly?.warnings?.[0]);

  // Attach: claim ₹1,500 for the ₹1,212 dinner on a different date → AMOUNT_MISMATCH + DATE_MISMATCH.
  const dinner = scans.find((s) => s.name === "restaurant.png") || scans.find((s) => s.name === "jiofiber.pdf");
  const claim = await api("POST", "/api/v2/cases", { module: "expenses", values: { category: "Meals", title: `OCR test — team dinner ${run}`, amount: 1500, startDate: iso(daysAgo(1)), merchant: "Bombay Canteen" } });
  check("expense claim created", claim.status === 201 || claim.status === 200, claim.json?.caseNumber);
  createdCases.push(claim.json);
  const attach = await api("POST", `/api/v2/receipts/${dinner.result.scanId}/attach`, { caseId: claim.json.id });
  check("attach → attached:true", attach.json?.attached === true, JSON.stringify(attach.json?.flags?.map((f) => f.code)));
  check("attach flags amount + date mismatch", ["AMOUNT_MISMATCH", "DATE_MISMATCH"].every((code) => attach.json?.flags?.some((f) => f.code === code)));
  const caseAfter = await api("GET", `/api/v2/cases/${claim.json.id}`);
  const files = await api("GET", `/api/v2/files?entityType=hr_case&entityId=${claim.json.id}`);
  check("file moved onto the case (category RECEIPT)", files.json?.items?.some((f) => f.id === dinner.result.fileId && f.category === "RECEIPT"));
  console.log(`      case details.ocr = ${JSON.stringify(caseAfter.json?.details?.ocr ?? caseAfter.json?.values?.ocr ?? "(not exposed by case API)")}`);
  const again = await api("POST", `/api/v2/receipts/${dinner.result.scanId}/attach`, { caseId: claim.json.id });
  check("attaching twice → 409", again.status === 409, again.json?.message);
  const other = await api("POST", `/api/v2/receipts/${dinner.result.scanId}/attach`, { caseId: claim.json.id });
  void other;
  const foreign = await fetch(`${API}/api/v2/receipts/${dinner.result.scanId}`, { headers: { ...headers, "x-employee-id": "BT003" } });
  check("another employee cannot read the scan", foreign.status === 404 || foreign.status === 401 || foreign.status === 403, String(foreign.status));

  // Duplicate 1: the same bytes again → duplicateOf the claim it is attached to.
  const dup = await scan(`${dinner.name}`, dinner.mimeType, dinner.bytes);
  check("same file again → duplicateOf (sha256)", dup?.duplicateOf?.caseId === claim.json.id, dup?.duplicateOf?.reason);

  // Duplicate 2: different bytes, same requester + total + date + similar merchant as an existing claim.
  const cab = scans.find((s) => s.name === "cab.png");
  if (cab?.result.fields.total && cab.result.fields.date) {
    const cabClaim = await api("POST", "/api/v2/cases", { module: "expenses", values: { category: "Local travel", title: `OCR test — Uber ride ${run}`, amount: cab.result.fields.total, startDate: cab.result.fields.date, merchant: "Uber India" } });
    createdCases.push(cabClaim.json);
    const variant = renderPng({ ...RECEIPTS[2], tilt: false });
    const fuzzy = await scan("cab-copy.png", "image/png", variant);
    check("same total/date/merchant on an existing claim → duplicateOf", fuzzy?.duplicateOf?.caseId === cabClaim.json.id, fuzzy?.duplicateOf?.reason);
  }
  const bad = await api("POST", "/api/v2/receipts/scan", { originalName: "x.png", mimeType: "image/png", base64: Buffer.from("not an image at all").toString("base64") });
  check("non-image bytes rejected", bad.status === 415, `${bad.status} ${bad.json?.message}`);
} finally {
  if (!process.argv.includes("--keep"))
    for (const created of createdCases.filter(Boolean)) {
      const current = await api("GET", `/api/v2/cases/${created.id}`);
      if (current.json?.version) await api("POST", `/api/v2/cases/${created.id}/transitions`, { action: "cancel", version: current.json.version, note: "OCR self-test cleanup" });
    }
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll OCR checks passed");
process.exit(failures ? 1 : 0);

// npx tsx --test src/platform/receipts/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { datesIn, guessCategory, parseReceiptText } from "./receipt-parser";

const TODAY = new Date("2026-09-26T10:00:00Z");
const parse = (text: string) => parseReceiptText(text, TODAY);

test("Uber trip receipt: total fare, date in 'dd MMM yyyy', Local travel", () => {
  const r = parse(`Uber
Here's your receipt for your ride, Vikas
We hope you enjoyed your ride this evening.
Total ₹412.63
Trip fare ₹371.20
Booking Fee ₹21.00
Subtotal ₹392.20
CGST 2.5% ₹9.80
SGST 2.5% ₹9.80
Payments
Paytm UPI ₹412.63
18 Sep 2026, 7:42 pm
Ride ID: 8F3A-22KQ-19`);
  assert.equal(r.fields.merchant, "Uber");
  assert.equal(r.fields.total, 412.63);
  assert.equal(r.fields.date, "2026-09-18");
  assert.equal(r.fields.category, "Local travel");
  assert.equal(r.fields.tax, 19.6);
  assert.equal(r.fields.currency, "INR");
});

test("Ola invoice with Amount Payable precedence over Subtotal", () => {
  const r = parse(`ANI Technologies Pvt. Ltd. (Ola)
TAX INVOICE
Invoice No: OLA-KA-2627-004511
Invoice Date: 21/09/2026
GSTIN: 29AAECA7654R1Z3
Ride Fare Rs. 286.67
Subtotal Rs. 286.67
IGST @5% Rs. 14.33
Amount Payable Rs. 301.00`);
  assert.equal(r.fields.merchant, "Ola");
  assert.equal(r.fields.total, 301);
  assert.equal(r.fields.date, "2026-09-21");
  assert.equal(r.fields.gstin, "29AAECA7654R1Z3");
  assert.equal(r.fields.invoiceNumber, "OLA-KA-2627-004511");
  assert.equal(r.fields.tax, 14.33);
  assert.equal(r.fields.category, "Local travel");
});

test("HPCL fuel slip: dd-MMM-yy date, litres, Fuel & mileage", () => {
  const r = parse(`HINDUSTAN PETROLEUM CORP LTD
SHREE SAI AUTO SERVICES
MG ROAD PUNE
RECEIPT NO: 004512
DATE: 14-Sep-26 TIME: 09:14
NOZZLE NO: 3
PRODUCT: PETROL
RATE(Rs/L): 104.21
VOLUME(L): 19.19
AMOUNT(Rs): 2000.00
Thank you. Visit again`);
  assert.equal(r.fields.merchant, "HPCL");
  assert.equal(r.fields.total, 2000);
  assert.equal(r.fields.date, "2026-09-14");
  assert.equal(r.fields.category, "Fuel & mileage");
  assert.equal(r.fields.invoiceNumber, "004512");
});

test("Restaurant bill with CGST/SGST, Indian grouping and Grand Total", () => {
  const r = parse(`THE BOMBAY CANTEEN
Kamala Mills, Lower Parel, Mumbai
GSTIN: 27AADCB2230M1ZT
FSSAI: 11517011000123
Bill No: 7781   Table: 12
Date: 05/09/2026  21:37
Item            Qty   Amount
Butter Chicken   1    645.00
Garlic Naan      3    270.00
Masala Chaas     2    240.00
Sub Total            1,155.00
CGST @ 2.5%            28.88
SGST @ 2.5%            28.88
Round Off               -0.76
Grand Total      Rs 1,212.00
Thank you! Visit again`);
  assert.equal(r.fields.merchant, "THE BOMBAY CANTEEN");
  assert.equal(r.fields.total, 1212);
  assert.equal(r.fields.tax, 57.76);
  assert.equal(r.fields.gstin, "27AADCB2230M1ZT");
  assert.equal(r.fields.date, "2026-09-05");
  assert.equal(r.fields.invoiceNumber, "7781");
  assert.equal(r.fields.category, "Meals");
  assert.deepEqual(r.lines.map((line) => line.amount), [645, 270, 240]);
});

test("Airtel postpaid bill: Amount Payable, due date ignored, Internet & phone", () => {
  const r = parse(`airtel
Bharti Airtel Limited
Your Airtel Postpaid Bill
Bill Date 02 Sep 2026
Bill Period 03 Aug 2026 to 02 Sep 2026
Bill No. MH1234567890
Due Date 20 Sep 2026
Monthly rental 499.00
Taxes (GST 18%) 89.82
Amount Payable ₹ 588.82`);
  assert.equal(r.fields.merchant, "Airtel");
  assert.equal(r.fields.total, 588.82);
  assert.equal(r.fields.date, "2026-09-02");
  assert.equal(r.fields.category, "Internet & phone");
  assert.equal(r.fields.invoiceNumber, "MH1234567890");
});

test("Jio Fiber broadband invoice (not confused with Jio-bp fuel)", () => {
  const r = parse(`Reliance Jio Infocomm Ltd
JioFiber Broadband - Tax Invoice
Invoice Number: JF26091100231
Invoice Date: 11-09-2026
Plan: 100 Mbps Monthly
Taxable Value 846.61
CGST 9% 76.20
SGST 9% 76.20
Total Amount Due Rs 999.01`);
  assert.equal(r.fields.merchant, "Jio");
  assert.equal(r.fields.total, 999.01);
  assert.equal(r.fields.tax, 152.4);
  assert.equal(r.fields.category, "Internet & phone");
});

test("Café receipt with OCR noise (Tota1, Rs.) and no GST", () => {
  const r = parse(`Third Wave Coffee
Indiranagar, Bengaluru
Order #A-1182
23/09/26 08:05 AM
1 Cappuccino (R)      210.00
1 Almond Croissant    185.00
Tota1              Rs.395.00
Paid by UPI`);
  assert.equal(r.fields.merchant, "Third Wave Coffee");
  assert.equal(r.fields.total, 395);
  assert.equal(r.fields.date, "2026-09-23");
  assert.equal(r.fields.category, "Meals");
  assert.equal(r.fields.tax, undefined);
});

test("Hotel folio: Grand Total wins over room subtotal, dd.mm.yyyy", () => {
  const r = parse(`LEMON TREE HOTEL
Electronics City, Bengaluru
GSTIN 29AABCL1234K1ZQ
Folio No: LT/EC/55621
Arrival: 15.09.2026  Departure: 17.09.2026
Room Charges 2 nights       5,000.00
Total                        5,000.00
CGST 6%                        300.00
SGST 6%                        300.00
Grand Total                  5,600.00`);
  assert.equal(r.fields.total, 5600);
  assert.equal(r.fields.tax, 600);
  assert.equal(r.fields.date, "2026-09-15");
  assert.equal(r.fields.merchant, "LEMON TREE HOTEL");
  assert.equal(r.fields.gstin, "29AABCL1234K1ZQ");
});

test("Swiggy order: total label on its own line, value on the next", () => {
  const r = parse(`Swiggy
Order ID: 158823411902
Delivered on Sep 19, 2026
Chicken Biryani x 1 ₹ 349
Delivery fee ₹ 39
Taxes ₹ 17.45
Order Total
₹ 405.45`);
  assert.equal(r.fields.merchant, "Swiggy");
  assert.equal(r.fields.total, 405.45);
  assert.equal(r.fields.date, "2026-09-19");
  assert.equal(r.fields.category, "Meals");
});

test("Rapido bike taxi, INR prefix and yyyy-mm-dd", () => {
  const r = parse(`Rapido
Ride receipt
Date 2026-09-24
Pickup: Koramangala  Drop: HSR Layout
Ride charge INR 78.00
Platform fee INR 5.00
Total Paid INR 83.00`);
  assert.equal(r.fields.merchant, "Rapido");
  assert.equal(r.fields.total, 83);
  assert.equal(r.fields.date, "2026-09-24");
  assert.equal(r.fields.category, "Local travel");
});

test("Warnings: no total, old receipt, foreign currency", () => {
  const noTotal = parse(`Some Shop\nDate: 01/09/2026\nThanks`);
  assert.equal(noTotal.fields.total, undefined);
  assert.ok(noTotal.warnings.some((warning) => /total/i.test(warning)));
  const old = parse(`Kirana Store\nDate: 01/05/2026\nTotal 120.00`);
  assert.ok(old.warnings.some((warning) => /60 days/.test(warning)));
  const usd = parse(`Hudson News\nJFK T4\n09/20/2026\nTotal $12.50`);
  assert.equal(usd.fields.currency, "USD");
  assert.equal(usd.fields.date, "2026-09-20"); // mm/dd recognised only because 20 cannot be a month
  assert.equal(parse("").warnings.length, 1);
});

test("date helpers and category keywords", () => {
  assert.deepEqual(datesIn("Date: 3-Sept-2026"), ["2026-09-03"]);
  assert.deepEqual(datesIn("31/02/2026"), []);
  assert.equal(guessCategory("JIO-BP PETROL PUMP diesel"), "Fuel & mileage");
  assert.equal(guessCategory("Udemy course: TypeScript"), "Learning");
  assert.equal(guessCategory("DMart stationery and cleaning supplies"), "Store supplies");
  assert.equal(guessCategory("random text"), "Other");
});

test("fuel slip 'AMOUNT(Rs): 2000.00' is a labelled total, not a guess", () => {
  const r = parse(`INDIAN OIL\nCOCO OUTLET\nDATE 20/09/2026\nRATE 94.72\nVOLUME(L) 21.12\nAMOUNT(Rs): 2000.00`);
  assert.equal(r.fields.total, 2000);
  assert.equal(r.fields.merchant, "Indian Oil");
  assert.ok(!r.warnings.some((warning) => /guessed/.test(warning)));
  assert.deepEqual(r.lines, []);
});

// Database-backed: set -a; . ./.env; set +a; npx tsx --test src/platform/billing/billing.numbering.test.ts
// Everything runs inside transactions that are rolled back, on a private series name, so no real number is consumed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { nextDocumentNumber } from "./numbering";

const url = process.env.DATABASE_URL;
const pool = url ? new Pool({ connectionString: url, max: 3 }) : null;
const SERIES = "ZT";

test("numbering is consecutive within a FY and restarts at 0001 on 1 April", { skip: !pool }, async () => {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    const issued = [];
    for (const day of ["2027-03-30", "2027-03-31", "2027-03-31", "2027-04-01", "2027-04-02"]) issued.push((await nextDocumentNumber(client, SERIES, day)).number);
    assert.deepEqual(issued, ["ZT/2026-27/0001", "ZT/2026-27/0002", "ZT/2026-27/0003", "ZT/2027-28/0001", "ZT/2027-28/0002"]);
    assert.ok(issued.every((number) => number.length <= 16));
  } finally { await client.query("ROLLBACK"); client.release(); }
});

test("a rolled-back issue does not leave a gap", { skip: !pool }, async () => {
  const first = await pool!.connect();
  try {
    await first.query("BEGIN");
    assert.equal((await nextDocumentNumber(first, SERIES, "2026-10-20")).number, "ZT/2026-27/0001");
    await first.query("SAVEPOINT failed_issue");
    assert.equal((await nextDocumentNumber(first, SERIES, "2026-10-20")).number, "ZT/2026-27/0002");
    await first.query("ROLLBACK TO SAVEPOINT failed_issue"); // the issue failed after taking a number
    assert.equal((await nextDocumentNumber(first, SERIES, "2026-10-20")).number, "ZT/2026-27/0002", "the number is reused, so the series has no gap");
  } finally { await first.query("ROLLBACK"); first.release(); }
});

test("concurrent issuers are serialised by the series row lock", { skip: !pool }, async () => {
  const a = await pool!.connect(), b = await pool!.connect();
  try {
    await a.query("BEGIN"); await b.query("BEGIN");
    assert.equal((await nextDocumentNumber(a, SERIES, "2026-10-20")).number, "ZT/2026-27/0001");
    const waiting = nextDocumentNumber(b, SERIES, "2026-10-20"); // blocks on a's row lock
    await new Promise((resolve) => setTimeout(resolve, 150));
    await a.query("ROLLBACK"); // a gives up → b takes 0001, not 0002
    assert.equal((await waiting).number, "ZT/2026-27/0001");
  } finally { await a.query("ROLLBACK").catch(() => {}); await b.query("ROLLBACK"); a.release(); b.release(); }
});

test("issued invoices are immutable in the database", { skip: !pool }, async () => {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    const org = (await client.query(`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)).rows[0];
    const account = (await client.query(`INSERT INTO billing_accounts(kind,organization_id,legal_name,billing_address,state_code,contact_email)
      VALUES('BRAND',$1,'Test','Addr','KA','t@example.com') ON CONFLICT (organization_id) DO UPDATE SET legal_name=billing_accounts.legal_name RETURNING id`, [org.id])).rows[0];
    const invoice = (await client.query(`INSERT INTO billing_invoices(account_id,period_start,period_end,place_of_supply,supply_type,sac_code,gst_rate,seller,buyer,subtotal_paise,total_paise)
      VALUES($1,'2001-01-01','2001-01-31','KA','INTRA','998315',18,'{}','{}',100,118) RETURNING id`, [account.id])).rows[0];
    await client.query(`UPDATE billing_invoices SET status='ISSUED', number='ZT/2000-01/0001', fiscal_year='2000-01', issue_date='2001-02-01', due_date='2001-02-15' WHERE id=$1`, [invoice.id]);
    await client.query("SAVEPOINT s");
    await assert.rejects(client.query(`UPDATE billing_invoices SET total_paise=1 WHERE id=$1`, [invoice.id]), /immutable/);
    await client.query("ROLLBACK TO SAVEPOINT s");
    await assert.rejects(client.query(`DELETE FROM billing_invoices WHERE id=$1`, [invoice.id]), /cannot be deleted/);
    await client.query("ROLLBACK TO SAVEPOINT s");
    await assert.rejects(client.query(`INSERT INTO billing_invoice_lines(invoice_id,position,kind,description,amount_paise) VALUES($1,1,'CHARGE','x',5)`, [invoice.id]), /immutable/);
  } finally { await client.query("ROLLBACK"); client.release(); }
});

test.after(async () => { await pool?.end(); });

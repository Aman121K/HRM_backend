import type { PoolClient } from "pg";
import { fiscalYear, formatDocumentNumber } from "./billing.engine";

/** Next number of a gapless series. Must run inside the issuing transaction: the row lock serialises issuers and a rollback un-uses the number. */
export async function nextDocumentNumber(client: PoolClient, series: string, issueDate: string) {
  const fy = fiscalYear(issueDate);
  const row = (await client.query(
    `INSERT INTO billing_number_series(series,fiscal_year,last_number) VALUES($1,$2,1)
     ON CONFLICT (series,fiscal_year) DO UPDATE SET last_number=billing_number_series.last_number+1 RETURNING last_number`, [series, fy])).rows[0];
  return { fy, sequence: Number(row.last_number), number: formatDocumentNumber(series, fy, Number(row.last_number)) };
}


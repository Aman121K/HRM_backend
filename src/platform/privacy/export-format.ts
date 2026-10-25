// Helpers shared by the employee "Download my data" export and the whole-brand export.
import { decryptField, FieldDecryptError } from "../security/field-crypto";

export const EXPORT_TTL_DAYS = 7;
export const SAFE_IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/** Columns never exported: credentials, tokens, keyed hashes, hash-chain internals. Encrypted columns are handled separately. */
export const SECRET_COLUMN = /(^|_)(token|secret|password|otp|totp|api_key|signing_key|private_key)(_|$)|_hash$|^row_hash$|^prev_hash$|_fingerprint$/;

/** Encrypted identifier columns we know how to open: table → column prefix list (rowId column in brackets). */
export const DECRYPTABLE: Record<string, { columns: string[]; rowId: string }> = {
  payroll_profiles: { columns: ["pan", "uan", "esi_number", "bank_account"], rowId: "employee_id" },
  onboarding_joiners: { columns: ["pan"], rowId: "id" },
};

/**
 * Replaces <col>_enc/_hash/_last4 triples with the plaintext value (for tables in DECRYPTABLE) and drops secret columns.
 * Returns the cleaned row and the names of columns that were omitted.
 */
export function cleanRow(table: string, row: Record<string, unknown>, organizationId: string, omitted: Set<string>) {
  const known = DECRYPTABLE[table];
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    if (column.endsWith("_enc")) {
      const base = column.slice(0, -4);
      if (known?.columns.includes(base)) {
        out[base] = openValue(value as string | null, { table, column: base, organizationId, rowId: String(row[known.rowId]) });
      } else omitted.add(column);
      continue;
    }
    if (SECRET_COLUMN.test(column)) { omitted.add(column); continue; }
    out[column] = value;
  }
  return out;
}

export function openValue(ciphertext: string | null, ctx: { table: string; column: string; organizationId: string; rowId: string }) {
  if (!ciphertext) return null;
  try { return decryptField(ciphertext, ctx); }
  catch (error) { return error instanceof FieldDecryptError ? "[could not be decrypted — contact HR]" : "[unavailable]"; }
}

const cell = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  // Spreadsheet formula injection: a cell starting with = + - @ (or tab/CR) is shown as text.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** RFC 4180 CSV with a header row from the union of keys (first row's order first). */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const columns: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  return [columns.map(cell).join(","), ...rows.map((row) => columns.map((column) => cell(row[column])).join(","))].join("\r\n") + "\r\n";
}

/** JSON with dates as ISO strings and bigint/numeric-safe output. */
export const toJson = (value: unknown) => JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2);

/**
 * Shared CSV writer for every payroll export (bank, ESI, PT, register …).
 * Text a spreadsheet would evaluate as a formula (= + - @, a leading tab/CR, the full-width variants, or any of those
 * after leading whitespace) is neutralised with a leading single quote (OWASP "CSV injection"). Numbers stay numbers,
 * so negative amounts are not altered.
 */
const FORMULA_START = /^[\s ]*[=+\-@＝＋－＠]|^[\t\r\n]/;

export function neutralise(text: string) {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

export function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "bigint") return value.toString();
  const text = neutralise(String(value));
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const toCsv = (rows: unknown[][]) => `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;

/** Free text inside fixed-layout text files (EPFO ECR): drop separators/control characters and leading formula characters. */
export const plainField = (value: unknown, separator = "#~#") =>
  String(value ?? "").split(separator).join(" ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/^[\s=+\-@]+/, "").trim();

/**
 * Shared types for the versioned statutory rule tables.
 *
 * Every rule row carries `effectiveFrom` (ISO date, inclusive) and a `source` describing where the number came from,
 * when it was checked and how strong the evidence is. Calculations for a pay period always look up the row in force
 * for that period (or, where a rule changes mid-month, split the month — see `segmentsForPeriod`).
 */
export type SourceStatus =
  /** Read from a government / gazette / statutory-body page (PIB, ESIC, indiabudget.gov.in, egazette). */
  | "OFFICIAL"
  /** Only corroborated by professional / secondary publications; official text not retrieved. */
  | "SECONDARY"
  /** Sources conflict or none found — UNVERIFIED, confirm with CA before relying on it. */
  | "UNVERIFIED";

export type Source = { ref: string; url?: string; checked: string; status: SourceStatus; note?: string };

export type Versioned<T> = T & { effectiveFrom: string; version: string; sources: Source[] };

/** Return the row in force on `date` (rows sorted ascending by effectiveFrom). Falls back to the earliest row. */
export function inForce<T extends { effectiveFrom: string }>(rows: readonly T[], date: string): T {
  let found = rows[0];
  for (const row of rows) if (row.effectiveFrom <= date) found = row;
  return found;
}

/**
 * Split a pay period (YYYY-MM) into consecutive day-ranges, one per rule row in force during the month.
 * A month with no mid-month change returns a single segment covering every day.
 */
export function segmentsForPeriod<T extends { effectiveFrom: string }>(rows: readonly T[], period: string) {
  const [year, month] = period.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const first = `${period}-01`, last = `${period}-${String(daysInMonth).padStart(2, "0")}`;
  const segments: { rule: T; fromDay: number; toDay: number; days: number }[] = [];
  let current = inForce(rows, first), fromDay = 1;
  for (const row of rows) {
    if (row.effectiveFrom > first && row.effectiveFrom <= last) {
      const day = Number(row.effectiveFrom.slice(8, 10));
      segments.push({ rule: current, fromDay, toDay: day - 1, days: day - fromDay });
      current = row; fromDay = day;
    }
  }
  segments.push({ rule: current, fromDay, toDay: daysInMonth, days: daysInMonth - fromDay + 1 });
  return { daysInMonth, segments };
}

/** Local calendar date (YYYY-MM-DD) in India — used when a caller does not pass a pay period. */
export function todayIst() {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}
export const lastDayOf = (period: string) => {
  const [year, month] = period.split("-").map(Number);
  return `${period}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
};

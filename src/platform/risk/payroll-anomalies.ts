// Payroll anomaly detectors. Pure functions; bank accounts arrive only as salted fingerprints + last 4 digits.
import { dayLabel, inr, monthLabel, plural, round, uniq, type SignalDraft } from "./risk.types";
import { minimumWageFor, type MinimumWage, type RiskSettings } from "./risk.settings";

export type RunLine = {
  runId: string; period: string; runStatus: string; employeeId: string; status: string;
  gross: number; net: number; previousNet: number | null; lopDays: number; payableDays: number; daysInMonth: number; oneTime: number;
  pfApplicable: boolean | null; esiCovered: boolean | null;
};
export type Structure = { employeeId: string; effectiveFrom: string; fixedMonthlyGross: number };
export type PayrollEmployee = { id: string; status: string; state: string | null; lastWorkingDay: string | null; joiningDate: string };
export type BankFingerprint = { employeeId: string; fingerprint: string; last4: string; bankName: string | null; ifsc: string | null };
export type PayrollInput = {
  latest: RunLine[]; previous: RunLine[]; structures: Structure[]; employees: PayrollEmployee[];
  presence: Map<string, { days: number; last: string }>; banks: BankFingerprint[]; minimumWages: MinimumWage[]; today: string;
};

const runHref = (runId: string) => `/payroll/admin/${runId}`;
const periodStart = (period: string) => `${period}-01`;
const periodEnd = (period: string) => { const [y, m] = period.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const prevPeriod = (period: string) => { const [y, m] = period.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };

export function payrollSignals(input: PayrollInput, settings: RiskSettings): SignalDraft[] {
  return [
    ...netPayChanges(input, settings), ...belowMinimumWage(input, settings), ...presenceWithoutStructure(input),
    ...paidAfterExit(input), ...duplicateBankAccounts(input), ...statutoryFlips(input),
  ];
}

/** Net pay moved more than X% month-on-month with no salary revision effective in either month. */
export function netPayChanges(input: PayrollInput, settings: RiskSettings): SignalDraft[] {
  const drafts: SignalDraft[] = [];
  for (const line of input.latest) {
    if (line.status !== "INCLUDED" || !line.previousNet || line.previousNet <= 0) continue;
    const pct = ((line.net - line.previousNet) / line.previousNet) * 100;
    if (Math.abs(pct) <= settings.payroll.netChangePct) continue;
    const from = periodStart(prevPeriod(line.period)), to = periodEnd(line.period);
    const revised = input.structures.some((row) => row.employeeId === line.employeeId && row.effectiveFrom > from && row.effectiveFrom <= to);
    if (revised) continue;
    const reasons = [line.lopDays > 0 ? `${line.lopDays} loss-of-pay day(s)` : null, line.oneTime ? `${inr(line.oneTime)} one-time earnings/deductions` : null].filter(Boolean);
    drafts.push({
      detector: "payroll.net_change", area: "payroll", subjectKey: `${line.period}:${line.employeeId}`, severity: Math.abs(pct) >= settings.payroll.netChangePct * 2 ? "high" : "medium",
      title: `Net pay ${pct > 0 ? "up" : "down"} ${round(Math.abs(pct), 1)}% in ${monthLabel(line.period)} with no salary revision`,
      explanation: `Net pay went from ${inr(line.previousNet)} to ${inr(line.net)} (${pct > 0 ? "+" : ""}${round(pct, 1)}%) in the ${monthLabel(line.period)} run, above the ${settings.payroll.netChangePct}% threshold, and no salary structure revision is effective in ${monthLabel(prevPeriod(line.period))} or ${monthLabel(line.period)}.${reasons.length ? ` Possible explanations in the run: ${reasons.join(", ")}.` : " The run shows no loss-of-pay or one-time items that would explain it."} Check before the run is approved.`,
      employeeIds: [line.employeeId],
      evidence: { facts: [{ label: "Previous net", value: inr(line.previousNet) }, { label: "This month", value: inr(line.net) }, { label: "Change", value: `${round(pct, 1)}%` },
        { label: "Gross", value: inr(line.gross) }, { label: "LOP days", value: String(line.lopDays) }, { label: "Run status", value: line.runStatus }] },
      action: { label: "Open payroll run", href: runHref(line.runId) }, audiences: ["PAYROLL"],
      basis: { period: line.period, employeeId: line.employeeId, pct: Math.round(pct / 5) * 5 },
      records: [{ type: "payroll_run", id: line.runId, label: monthLabel(line.period) }],
    });
  }
  return drafts;
}

/** Current fixed monthly gross below the configured minimum wage for the employee's state. */
export function belowMinimumWage(input: PayrollInput, settings: RiskSettings): SignalDraft[] {
  const drafts: SignalDraft[] = [];
  const category = settings.payroll.minimumWageCategory;
  const current = new Map<string, Structure>();
  for (const row of [...input.structures].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)))
    if (row.effectiveFrom <= input.today) current.set(row.employeeId, row);
  for (const person of input.employees) {
    if (person.status !== "ACTIVE" || !person.state) continue;
    const structure = current.get(person.id);
    if (!structure) continue;
    const floor = minimumWageFor(input.minimumWages, person.state, category, input.today);
    if (!floor || structure.fixedMonthlyGross >= floor.monthlyAmount) continue;
    const gap = floor.monthlyAmount - structure.fixedMonthlyGross;
    drafts.push({
      detector: "payroll.minimum_wage", area: "payroll", subjectKey: person.id, severity: floor.isExample ? "medium" : "high",
      title: `Fixed gross ${inr(structure.fixedMonthlyGross)} is below the ${person.state} minimum-wage setting`,
      explanation: `The salary structure effective ${dayLabel(structure.effectiveFrom)} pays ${inr(structure.fixedMonthlyGross)} a month, ${inr(gap)} below the ${person.state} ${category.toLowerCase().replace("_", "-")} minimum of ${inr(floor.monthlyAmount)} configured in Risk settings.${floor.isExample ? " That minimum is an EXAMPLE value, not the current notification — update the table before relying on this check." : ""} Paying below minimum wage exposes the employer to claims for the difference plus compensation.`,
      employeeIds: [person.id],
      evidence: { facts: [{ label: "Fixed monthly gross", value: inr(structure.fixedMonthlyGross) }, { label: "Minimum configured", value: `${inr(floor.monthlyAmount)}${floor.isExample ? " (EXAMPLE)" : ""}` },
        { label: "State / category", value: `${person.state} · ${category}` }, { label: "Minimum effective from", value: floor.effectiveFrom }], note: floor.note || undefined },
      action: { label: "Open salary structure", href: `/payroll/structures?employee=${person.id}` }, audiences: ["PAYROLL"],
      basis: { employeeId: person.id, gross: structure.fixedMonthlyGross, minimum: floor.monthlyAmount, example: floor.isExample },
    });
  }
  return drafts;
}

/** Punching in / rostered, but no salary structure — they will be missed by payroll. */
export function presenceWithoutStructure(input: PayrollInput): SignalDraft[] {
  const withStructure = new Set(input.structures.map((row) => row.employeeId));
  const active = new Set(input.employees.filter((person) => person.status === "ACTIVE").map((person) => person.id));
  const drafts: SignalDraft[] = [];
  for (const [employeeId, presence] of input.presence) {
    if (withStructure.has(employeeId) || !active.has(employeeId)) continue;
    drafts.push({
      detector: "payroll.missing_structure", area: "payroll", subjectKey: employeeId, severity: "high",
      title: `Working ${plural(presence.days, "day")} but has no salary structure`,
      explanation: `Attendance or the roster shows this person working on ${plural(presence.days, "day")} in the last 30 days (latest ${dayLabel(presence.last)}), but there is no salary structure, so the next payroll run will leave them out. Create a structure before the run is calculated.`,
      employeeIds: [employeeId], evidence: { facts: [{ label: "Days worked (30 d)", value: String(presence.days) }, { label: "Last seen", value: presence.last }] },
      action: { label: "Create salary structure", href: `/payroll/structures?employee=${employeeId}` }, audiences: ["PAYROLL"],
      basis: { employeeId },
    });
  }
  return drafts;
}

/** Salary included for someone who has left (inactive, or last working day before the pay period started). */
export function paidAfterExit(input: PayrollInput): SignalDraft[] {
  const people = new Map(input.employees.map((person) => [person.id, person]));
  const drafts: SignalDraft[] = [];
  for (const line of input.latest) {
    const person = people.get(line.employeeId);
    if (!person || line.status !== "INCLUDED" || line.net <= 0) continue;
    const leftBefore = person.lastWorkingDay && person.lastWorkingDay < periodStart(line.period);
    if (person.status === "ACTIVE" && !leftBefore) continue;
    drafts.push({
      detector: "payroll.paid_after_exit", area: "payroll", subjectKey: `${line.period}:${line.employeeId}`, severity: "critical",
      title: `${inr(line.net)} salary in ${monthLabel(line.period)} for someone who has left`,
      explanation: `The ${monthLabel(line.period)} run includes ${inr(line.net)} net pay for an employee who is ${person.status !== "ACTIVE" ? `marked ${person.status.toLowerCase()}` : "active in the system"}${person.lastWorkingDay ? ` with a last working day of ${dayLabel(person.lastWorkingDay)}` : ""}. Exclude or hold the line (full & final settlement is paid separately) before the bank file goes out.`,
      employeeIds: [line.employeeId],
      evidence: { facts: [{ label: "Net pay", value: inr(line.net) }, { label: "Payable days", value: `${line.payableDays} of ${line.daysInMonth}` }, { label: "Employee status", value: person.status }, ...(person.lastWorkingDay ? [{ label: "Last working day", value: person.lastWorkingDay }] : [])] },
      action: { label: "Open payroll run", href: runHref(line.runId) }, audiences: ["PAYROLL"],
      basis: { period: line.period, employeeId: line.employeeId, net: Math.round(line.net) },
      records: [{ type: "payroll_run", id: line.runId, label: monthLabel(line.period) }],
    });
  }
  return drafts;
}

/** Two or more employees paid into the same bank account (compared by fingerprint; numbers never leave the database). */
export function duplicateBankAccounts(input: PayrollInput): SignalDraft[] {
  const groups = new Map<string, BankFingerprint[]>();
  for (const row of input.banks) (groups.get(row.fingerprint) || groups.set(row.fingerprint, []).get(row.fingerprint)!).push(row);
  const drafts: SignalDraft[] = [];
  for (const [fingerprint, rows] of groups) {
    const people = uniq(rows.map((row) => row.employeeId)).sort();
    if (people.length < 2) continue;
    const sample = rows[0];
    drafts.push({
      detector: "payroll.duplicate_bank", area: "payroll", subjectKey: fingerprint, severity: "critical",
      title: `${people.length} employees share one bank account (…${sample.last4})`,
      explanation: `${people.length} payroll profiles have the same account number and IFSC (${sample.bankName || "bank"} ${sample.ifsc || ""}, ending ${sample.last4}). Salary for several people landing in one account is a common ghost-employee or diversion pattern; it can also be a data-entry copy-paste. Verify with a cancelled cheque before the next bank file.`,
      employeeIds: people,
      evidence: { columns: [{ key: "person", label: "Employee", kind: "person" }, { key: "account", label: "Account" }, { key: "ifsc", label: "IFSC" }],
        rows: rows.map((row) => ({ person: row.employeeId, account: `•••• ${row.last4}`, ifsc: row.ifsc })), note: "Accounts are compared by a salted fingerprint; full numbers are never shown here." },
      action: { label: "Review payroll profiles", href: "/payroll/structures" }, audiences: ["PAYROLL"],
      basis: { fingerprint, people },
    });
  }
  return drafts;
}

/** PF applicability or ESI coverage changed between the last two runs. */
export function statutoryFlips(input: PayrollInput): SignalDraft[] {
  const before = new Map(input.previous.filter((line) => line.status === "INCLUDED").map((line) => [line.employeeId, line]));
  const drafts: SignalDraft[] = [];
  for (const line of input.latest) {
    const old = before.get(line.employeeId);
    if (!old || line.status !== "INCLUDED") continue;
    const month = Number(line.period.slice(5, 7));
    if (old.pfApplicable !== null && line.pfApplicable !== null && old.pfApplicable !== line.pfApplicable)
      drafts.push(flip(line, old, "PF", line.pfApplicable ? "became applicable" : "stopped",
        line.pfApplicable ? "Check the joining form (Form 11) and UAN." : "Once a member, PF normally continues regardless of wage level — stopping it needs a documented reason.", line.pfApplicable ? "medium" : "high"));
    if (old.esiCovered !== null && line.esiCovered !== null && old.esiCovered !== line.esiCovered) {
      const midPeriod = !line.esiCovered && month !== 4 && month !== 10;
      drafts.push(flip(line, old, "ESI", line.esiCovered ? "started" : "stopped",
        midPeriod ? "ESI coverage continues until the end of the contribution period (Apr–Sep / Oct–Mar) even when wages cross ₹21,000 — stopping mid-period is usually an error."
          : line.esiCovered ? "Gross fell to or below the ₹21,000 threshold — register the employee with ESIC if not already." : "Coverage ended at a contribution-period boundary.",
        midPeriod ? "high" : "low"));
    }
  }
  return drafts;
}

function flip(line: RunLine, old: RunLine, kind: "PF" | "ESI", change: string, advice: string, severity: SignalDraft["severity"]): SignalDraft {
  return {
    detector: "payroll.statutory_flip", area: "payroll", subjectKey: `${line.period}:${line.employeeId}:${kind}`, severity,
    title: `${kind} ${change} in ${monthLabel(line.period)}`,
    explanation: `${kind} ${kind === "PF" ? "applicability" : "coverage"} ${change} between ${monthLabel(old.period)} (gross ${inr(old.gross)}) and ${monthLabel(line.period)} (gross ${inr(line.gross)}). ${advice}`,
    employeeIds: [line.employeeId],
    evidence: { facts: [{ label: `${monthLabel(old.period)} gross`, value: inr(old.gross) }, { label: `${monthLabel(line.period)} gross`, value: inr(line.gross) },
      { label: `${kind} before`, value: String(kind === "PF" ? old.pfApplicable : old.esiCovered) }, { label: `${kind} now`, value: String(kind === "PF" ? line.pfApplicable : line.esiCovered) }] },
    action: { label: "Open payroll run", href: runHref(line.runId) }, audiences: ["PAYROLL"],
    basis: { period: line.period, employeeId: line.employeeId, kind, now: kind === "PF" ? line.pfApplicable : line.esiCovered },
    records: [{ type: "payroll_run", id: line.runId, label: monthLabel(line.period) }],
  };
}

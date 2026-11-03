// India statutory compliance calendar (FY April–March) and gratuity eligibility. Pure functions, unit-tested.
//
// IMPORTANT: due dates below are commonly applied dates for private employers. States amend Professional Tax and Labour
// Welfare Fund rules often, the government extends deadlines by notification, and some dates depend on employer size.
// Every date must be validated by a compliance professional — the UI shows COMPLIANCE_DISCLAIMER next to the calendar.
import { addDays, daysBetween, dayLabel, inr, monthLabel, plural, type Severity, type SignalDraft } from "./risk.types";

export const COMPLIANCE_DISCLAIMER =
  "Due dates are commonly applied dates for private employers and are shown to help you plan. Deadlines change by notification, vary by state and employer size, and may be extended — validate every date with your compliance professional or chartered accountant.";

export type ObligationKind = "PF" | "ESI" | "TDS" | "TDS_RETURN" | "FORM16" | "PT" | "LWF";
export type Obligation = {
  key: string; kind: ObligationKind; label: string; authority: string;
  /** Wage month (YYYY-MM) for monthly items, "2026-27 Q1" for quarterly returns, the FY for annual ones. */
  period: string; periodLabel: string; dueDate: string; state?: string;
  /** True when the rule is less settled (state PT/LWF) — shown as "verify for your state". */
  verify: boolean; note: string;
  /** Wage months whose payroll data this obligation depends on. */
  months: string[];
};

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate(); // month 1-12
const ymd = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(Math.min(day, lastDay(year, month)))}`;
const nextMonth = (period: string) => { const [y, m] = period.split("-").map(Number); return m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 }; };
export const periodOf = (iso: string) => iso.slice(0, 7);
export function shiftPeriod(period: string, delta: number) {
  const [y, m] = period.split("-").map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}
/** FY label "2026-27" for a wage month. */
export function fiscalYear(period: string) {
  const [y, m] = period.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

type PtRule = { name: string; due: (period: string) => string | null; note: string };
/** State Professional Tax remittance rules for salaried employees. All are marked "verify". */
export const PT_DUE_RULES: Record<string, PtRule> = {
  KA: { name: "Karnataka", due: (p) => { const n = nextMonth(p); return ymd(n.y, n.m, 20); }, note: "Karnataka: PT deducted in a month is paid by the 20th of the following month (monthly return)." },
  MH: {
    name: "Maharashtra", due: (p) => { const n = nextMonth(p); return ymd(n.y, n.m, 31); },
    note: "Maharashtra: employers whose previous-year PT liability exceeded ₹50,000 pay monthly by the last day of the following month; smaller employers pay annually by 31 March. Confirm which applies to you.",
  },
  TS: { name: "Telangana", due: (p) => { const n = nextMonth(p); return ymd(n.y, n.m, 10); }, note: "Telangana: commonly by the 10th of the following month." },
  AP: { name: "Andhra Pradesh", due: (p) => { const n = nextMonth(p); return ymd(n.y, n.m, 10); }, note: "Andhra Pradesh: commonly by the 10th of the following month." },
  WB: { name: "West Bengal", due: (p) => { const n = nextMonth(p); return ymd(n.y, n.m, 21); }, note: "West Bengal: commonly by the 21st of the following month." },
  GJ: { name: "Gujarat", due: (p) => { const n = nextMonth(p); return ymd(n.y, n.m, 15); }, note: "Gujarat: commonly by the 15th of the following month." },
  TN: {
    name: "Tamil Nadu", due: (p) => (p.endsWith("-09") ? `${p.slice(0, 4)}-09-30` : p.endsWith("-03") ? `${p.slice(0, 4)}-03-31` : null),
    note: "Tamil Nadu: half-yearly — commonly by 30 September and 31 March (local body rules differ).",
  },
};
/** States with no PT on salaries (no obligation generated). */
export const NO_PT_STATES = new Set(["DL", "HR", "UP", "RJ", "HP", "UK", "PB", "GA", "CH"]);

type LwfRule = { name: string; items: { dueMonthDay: [number, number]; coversMonth: number; label: string }[]; note: string };
/** Labour Welfare Fund — commonly applied remittance dates; always "verify for your state". */
export const LWF_RULES: Record<string, LwfRule> = {
  KA: { name: "Karnataka", items: [{ dueMonthDay: [1, 15], coversMonth: 12, label: "annual contribution for the calendar year" }], note: "Karnataka LWF: annual employee + employer contribution, commonly due by 15 January for the previous calendar year." },
  MH: {
    name: "Maharashtra",
    items: [{ dueMonthDay: [7, 15], coversMonth: 6, label: "June deduction" }, { dueMonthDay: [1, 15], coversMonth: 12, label: "December deduction" }],
    note: "Maharashtra LWF: half-yearly, deducted from June and December wages and commonly due by 15 July and 15 January.",
  },
  TN: { name: "Tamil Nadu", items: [{ dueMonthDay: [1, 31], coversMonth: 12, label: "annual contribution" }], note: "Tamil Nadu LWF: annual, commonly due by 31 January." },
};

/** All obligations whose due date falls in [from, to] for the given PT/LWF states. */
export function obligationsBetween(from: string, to: string, states: string[]): Obligation[] {
  const items: Obligation[] = [];
  const push = (item: Obligation) => { if (item.dueDate >= from && item.dueDate <= to) items.push(item); };
  // Wage months that could have a due date in range (due dates are at most ~14 months after the wage month: Form 16).
  for (let period = shiftPeriod(periodOf(from), -15); period <= periodOf(to); period = shiftPeriod(period, 1)) {
    const n = nextMonth(period);
    const label = monthLabel(period);
    push({ key: `PF:${period}`, kind: "PF", label: `PF — ECR upload & payment for ${label}`, authority: "EPFO", period, periodLabel: label, dueDate: ymd(n.y, n.m, 15), verify: false,
      note: "Employee + employer EPF/EPS/EDLI and admin charges for the wage month, via ECR on the EPFO unified portal. Late payment attracts interest (s.7Q) and damages (s.14B).", months: [period] });
    push({ key: `ESI:${period}`, kind: "ESI", label: `ESI — contribution for ${label}`, authority: "ESIC", period, periodLabel: label, dueDate: ymd(n.y, n.m, 15), verify: false,
      note: "Employee 0.75% + employer 3.25% on covered wages, paid on the ESIC portal. Interest applies on late payment.", months: [period] });
    const isMarch = period.endsWith("-03");
    push({ key: `TDS:${period}`, kind: "TDS", label: `TDS on salaries — deposit for ${label}`, authority: "Income Tax (challan ITNS 281)", period, periodLabel: label,
      dueDate: isMarch ? `${period.slice(0, 4)}-04-30` : ymd(n.y, n.m, 7), verify: false,
      note: isMarch ? "Tax deducted in March is deposited by 30 April." : "Tax deducted under s.192 is deposited by the 7th of the following month (interest u/s 201(1A) when late).", months: [period] });
    for (const state of states) {
      const rule = PT_DUE_RULES[state];
      if (!rule) continue;
      const due = rule.due(period);
      if (due) push({ key: `PT:${state}:${period}`, kind: "PT", label: `Professional Tax (${rule.name}) — ${label}`, authority: `${rule.name} commercial taxes`, period, periodLabel: label, dueDate: due, state, verify: true,
        note: rule.note, months: state === "TN" ? [0, 1, 2, 3, 4, 5].map((back) => shiftPeriod(period, -back)) : [period] });
    }
    // Quarterly TDS return (Form 24Q) — due dates hang off the quarter's last month.
    const month = Number(period.slice(5, 7));
    const year = Number(period.slice(0, 4));
    const quarterEnd: Record<number, [string, string]> = { 6: ["Q1", `${year}-07-31`], 9: ["Q2", `${year}-10-31`], 12: ["Q3", `${year + 1}-01-31`], 3: ["Q4", `${year}-05-31`] };
    if (quarterEnd[month]) {
      const [quarter, due] = quarterEnd[month];
      const fy = fiscalYear(period);
      push({ key: `24Q:${fy}:${quarter}`, kind: "TDS_RETURN", label: `TDS return (Form 24Q) — FY ${fy} ${quarter}`, authority: "Income Tax (TRACES)", period: `${fy} ${quarter}`, periodLabel: `FY ${fy} ${quarter}`,
        dueDate: due, verify: false, note: "Quarterly statement of salary TDS. Late filing fee u/s 234E (₹200/day) and penalty u/s 271H may apply.", months: [0, 1, 2].map((back) => shiftPeriod(period, -back)) });
    }
    if (month === 3) {
      const fy = fiscalYear(period);
      push({ key: `FORM16:${fy}`, kind: "FORM16", label: `Form 16 to employees — FY ${fy}`, authority: "Income Tax (TRACES)", period: fy, periodLabel: `FY ${fy}`, dueDate: `${year}-06-15`, verify: false,
        note: "Part A (from TRACES) and Part B for every employee whose tax was deducted during the year.", months: Array.from({ length: 12 }, (_, back) => shiftPeriod(period, -back)) });
    }
    for (const state of states) {
      const rule = LWF_RULES[state];
      if (!rule) continue;
      for (const item of rule.items) if (item.coversMonth === month) {
        const dueYear = item.dueMonthDay[0] < month ? year + 1 : year;
        push({ key: `LWF:${state}:${period}`, kind: "LWF", label: `Labour Welfare Fund (${rule.name}) — ${item.label}`, authority: `${rule.name} Labour Welfare Board`, period, periodLabel: label,
          dueDate: ymd(dueYear, item.dueMonthDay[0], item.dueMonthDay[1]), state, verify: true, note: `${rule.note} Verify for your state and establishment.`, months: [period] });
      }
    }
  }
  return items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------------------------------------------- status

export type RunFact = {
  id: string; period: string; status: string;
  totals: { pfEmployee?: number; pfEmployer?: number; esiEmployee?: number; esiEmployer?: number; tds?: number; pt?: number; headcount?: number };
  ptByState: Record<string, number>;
  exports: { kind: string; at: string }[];
};
export type Mark = { status: "FILED"; reference: string | null; note: string | null; markedAt: string; markedBy: string | null };
export type ComplianceFacts = { runs: RunFact[]; marks: Record<string, Mark>; firstRunPeriod: string | null };
export type ObligationStatus = "FILED" | "READY" | "PENDING" | "NO_PAYROLL" | "AWAITING_PAYROLL" | "NOT_APPLICABLE" | "VERIFY";
export type CalendarItem = Obligation & {
  status: ObligationStatus; statusLabel: string; detail: string; amount: number | null; runId: string | null;
  daysLeft: number; bucket: "overdue" | "this_week" | "upcoming" | "done"; mark: Mark | null;
};

const LIVE_RUN = (status: string) => status !== "CANCELLED";
const FINAL_RUN = (status: string) => ["APPROVED", "PUBLISHED", "LOCKED"].includes(status);
const STATUS_LABEL: Record<ObligationStatus, string> = {
  FILED: "Marked as filed", READY: "File generated — confirm payment", PENDING: "Action needed", NO_PAYROLL: "No payroll data", AWAITING_PAYROLL: "Payroll not run yet",
  NOT_APPLICABLE: "Nothing due", VERIFY: "Verify for your state",
};

function runFor(facts: ComplianceFacts, period: string) {
  return facts.runs.filter((run) => run.period === period && LIVE_RUN(run.status)).sort((a, b) => (FINAL_RUN(b.status) ? 1 : 0) - (FINAL_RUN(a.status) ? 1 : 0))[0] || null;
}

/** Ties an obligation to the payroll data we have: runs, totals, exports, and manual "filed" marks. */
export function evaluateObligation(item: Obligation, facts: ComplianceFacts, today: string): CalendarItem {
  const mark = facts.marks[item.key] || null;
  const daysLeft = daysBetween(today, item.dueDate);
  const result = (status: ObligationStatus, detail: string, amount: number | null = null, runId: string | null = null): CalendarItem => ({
    ...item, status, statusLabel: STATUS_LABEL[status], detail, amount, runId, daysLeft, mark,
    bucket: status === "FILED" || status === "NOT_APPLICABLE" ? "done" : daysLeft < 0 ? "overdue" : daysLeft <= 7 ? "this_week" : "upcoming",
  });
  if (mark) return result("FILED", `Marked as filed${mark.reference ? ` (ref. ${mark.reference})` : ""}.`);
  const runs = item.months.map((month) => runFor(facts, month));
  const present = runs.filter((run): run is RunFact => !!run);
  const main = present[present.length - 1] || null;
  const lastMonth = [...item.months].sort().pop()!;
  const noRun = (text: string) => lastMonth >= periodOf(today)
    ? result("AWAITING_PAYROLL", `The ${monthLabel(lastMonth)} payroll hasn't been run yet — amounts appear here once it is calculated.`)
    : result("NO_PAYROLL", facts.firstRunPeriod
    ? `${text} If this was processed outside ClanChief, mark it as filed once paid.`
    : `Payroll isn't run in ClanChief for this brand, so this can't be checked against data — mark it as filed once done.`);
  const sum = (pick: (run: RunFact) => number) => present.reduce((total, run) => total + pick(run), 0);
  const exported = (run: RunFact | null, kind: string) => run?.exports.find((row) => row.kind === kind) || null;
  const draft = main && !FINAL_RUN(main.status) ? ` The ${monthLabel(main.period)} run is still ${main.status.toLowerCase()} — approve it first.` : "";

  switch (item.kind) {
    case "PF": case "ESI": {
      if (!main) return noRun(`No payroll run found for ${item.periodLabel}.`);
      const employee = Number(item.kind === "PF" ? main.totals.pfEmployee : main.totals.esiEmployee) || 0;
      const employer = Number(item.kind === "PF" ? main.totals.pfEmployer : main.totals.esiEmployer) || 0;
      const amount = employee + employer;
      if (amount <= 0) return result("NOT_APPLICABLE", `No ${item.kind} contributions in the ${item.periodLabel} run.`, 0, main.id);
      const file = exported(main, item.kind === "PF" ? "pf-ecr" : "esi");
      if (file) return result("READY", `${inr(amount)} (${inr(employee)} employee + ${inr(employer)} employer). ${item.kind === "PF" ? "ECR" : "Contribution"} file generated on ${dayLabel(file.at.slice(0, 10))} — pay on the ${item.authority} portal and mark as filed.`, amount, main.id);
      return result("PENDING", `${inr(amount)} due (${inr(employee)} employee + ${inr(employer)} employer). ${item.kind === "PF" ? "ECR" : "ESI contribution"} file not generated yet.${draft}`, amount, main.id);
    }
    case "TDS": {
      if (!main) return noRun(`No payroll run found for ${item.periodLabel}.`);
      const tds = Number(main.totals.tds) || 0;
      if (tds <= 0) return result("NOT_APPLICABLE", `No tax was deducted in the ${item.periodLabel} run.`, 0, main.id);
      return result("PENDING", `${inr(tds)} deducted from salaries — deposit with challan ITNS 281 and mark as filed.${draft}`, tds, main.id);
    }
    case "PT": {
      if (!main) return noRun(`No payroll run found for ${item.periodLabel}.`);
      const amount = sum((run) => Number(run.ptByState[item.state!] || 0));
      if (amount <= 0) return result("NOT_APPLICABLE", `No ${item.state} professional tax deducted for ${item.periodLabel}.`, 0, main.id);
      const file = exported(main, "pt");
      return result(file ? "READY" : "PENDING", `${inr(amount)} professional tax deducted for ${item.state}.${file ? ` PT register exported on ${dayLabel(file.at.slice(0, 10))}.` : ""} Due-date rule varies — verify.${draft}`, amount, main.id);
    }
    case "TDS_RETURN": case "FORM16": {
      if (!present.length) return noRun(`No payroll runs found for ${item.periodLabel}.`);
      const tds = sum((run) => Number(run.totals.tds) || 0);
      if (tds <= 0) return result("NOT_APPLICABLE", `No salary TDS in ${item.periodLabel}${item.kind === "TDS_RETURN" ? " — a nil return may still be required; verify." : "."}`, 0, main?.id || null);
      const missing = item.months.length - present.length;
      return result("PENDING", `${inr(tds)} salary TDS across ${plural(present.length, "run")}${missing > 0 ? ` (${missing} month(s) without a run in ClanChief)` : ""}.`, tds, main?.id || null);
    }
    case "LWF":
      return result("VERIFY", `${item.note}`, null, main?.id || null);
  }
}

export type CalendarSummary = { items: CalendarItem[]; counts: Record<CalendarItem["bucket"], number> };
export function complianceCalendar(from: string, to: string, states: string[], facts: ComplianceFacts, today: string): CalendarSummary {
  const items = obligationsBetween(from, to, states).map((item) => evaluateObligation(item, facts, today));
  const counts = { overdue: 0, this_week: 0, upcoming: 0, done: 0 };
  for (const item of items) counts[item.bucket] += 1;
  return { items, counts };
}

const MONEY_KINDS = new Set<ObligationKind>(["PF", "ESI", "TDS"]);
/**
 * Signals for obligations that are overdue or due within a week and not marked filed. Items before the brand's first
 * payroll run in ClanChief are listed in the calendar but not raised as signals. Returns keys that are satisfied
 * (filed / nothing due) so earlier signals for them resolve automatically.
 */
export function complianceSignals(items: CalendarItem[], facts: ComplianceFacts): { drafts: SignalDraft[]; cleared: string[] } {
  const drafts: SignalDraft[] = [];
  const cleared: string[] = [];
  for (const item of items) {
    if (item.status === "FILED" || item.status === "NOT_APPLICABLE") { cleared.push(item.key); continue; }
    if (item.daysLeft > 7 || item.status === "AWAITING_PAYROLL") continue;
    if (!facts.firstRunPeriod) continue; // no payroll in ClanChief: one summary signal instead (below)
    if (item.months.every((month) => month < facts.firstRunPeriod!)) continue;
    const overdue = item.daysLeft < 0;
    let severity: Severity;
    if (overdue) severity = item.status === "VERIFY" ? "medium" : MONEY_KINDS.has(item.kind) && -item.daysLeft > 7 ? "critical" : "high";
    else severity = item.daysLeft <= 1 ? "high" : item.status === "VERIFY" ? "low" : "medium";
    const when = overdue ? `was due ${dayLabel(item.dueDate)} — ${plural(-item.daysLeft, "day")} overdue` : item.daysLeft === 0 ? "is due today" : `is due ${dayLabel(item.dueDate)} (in ${plural(item.daysLeft, "day")})`;
    drafts.push({
      detector: "compliance.calendar", area: "compliance", subjectKey: item.key, severity,
      title: `${item.label} ${overdue ? "is overdue" : "due soon"}`,
      explanation: `${item.label} ${when}. ${item.detail}${item.verify ? " This rule varies by state — verify it." : ""}`,
      employeeIds: [],
      evidence: {
        facts: [
          { label: "Due date", value: dayLabel(item.dueDate) + ` ${item.dueDate.slice(0, 4)}` }, { label: "Authority", value: item.authority },
          { label: "Period", value: item.periodLabel }, { label: "Status", value: item.statusLabel },
          ...(item.amount ? [{ label: "Amount from payroll", value: inr(item.amount) }] : []),
        ],
        note: `${item.note} ${COMPLIANCE_DISCLAIMER}`,
      },
      action: item.runId ? { label: "Open payroll run", href: `/payroll/admin/${item.runId}` } : { label: "Open compliance calendar", href: "/risk?tab=compliance" },
      audiences: ["PAYROLL"], dueDate: item.dueDate,
      basis: { key: item.key, status: item.status, overdue, amount: item.amount },
      records: item.runId ? [{ type: "payroll_run", id: item.runId, label: item.periodLabel }] : [],
    });
  }
  return { drafts, cleared };
}

/** One low signal when a brand has no payroll runs in ClanChief at all, so filings can't be tied to data. */
export function noPayrollSignal(facts: ComplianceFacts, items: CalendarItem[]): SignalDraft | null {
  if (facts.firstRunPeriod) return null;
  const open = items.filter((item) => item.status !== "FILED" && item.daysLeft <= 7);
  if (!open.length) return null;
  return {
    detector: "compliance.calendar", area: "compliance", subjectKey: "no-payroll-data", severity: "low",
    title: `${plural(open.length, "statutory filing")} can't be checked — no payroll in ClanChief`,
    explanation: `There are no payroll runs for this brand, so ${plural(open.length, "due date")} in the next week or already past (PF, ESI, TDS, PT) can't be tied to payroll data. Mark each one as filed from the compliance calendar once your payroll provider confirms it.`,
    employeeIds: [], evidence: { columns: [{ key: "item", label: "Obligation" }, { key: "due", label: "Due", kind: "date" }], rows: open.slice(0, 20).map((item) => ({ item: item.label, due: item.dueDate })) },
    action: { label: "Open compliance calendar", href: "/risk?tab=compliance" }, audiences: ["PAYROLL"],
    basis: { keys: open.map((item) => item.key).sort() },
  };
}

// ---------------------------------------------------------------------------------------------------------------- gratuity

export type GratuityEmployee = { id: string; joiningDate: string; basicMonthly: number | null; lastWorkingDay: string | null };

/** Completed years of service; a part-year of more than six months counts as a full year (Payment of Gratuity Act s.4(2)). */
export function serviceYears(joiningDate: string, onDate: string) {
  const months = (Number(onDate.slice(0, 4)) - Number(joiningDate.slice(0, 4))) * 12 + (Number(onDate.slice(5, 7)) - Number(joiningDate.slice(5, 7))) - (onDate.slice(8) < joiningDate.slice(8) ? 1 : 0);
  return { exact: months / 12, rounded: Math.floor(months / 12) + (months % 12 > 6 ? 1 : 0) };
}
/** 15 days' wages per year of service (monthly basic × 15/26), capped at the ₹20 lakh statutory ceiling. */
export const gratuityAmount = (basicMonthly: number, years: number) => Math.min(2_000_000, Math.round((basicMonthly * 15 * years) / 26));

export function gratuitySignals(employees: GratuityEmployee[], today: string, windowDays: number): SignalDraft[] {
  const drafts: SignalDraft[] = [];
  for (const person of employees) {
    const fifth = `${Number(person.joiningDate.slice(0, 4)) + 5}${person.joiningDate.slice(4)}`;
    if (person.lastWorkingDay && person.lastWorkingDay >= addDays(today, -60)) {
      const service = serviceYears(person.joiningDate, person.lastWorkingDay);
      // Courts have read "5 years" as 4 years 240 days for some establishments — flag from 4 years 8 months.
      if (service.exact < 4 + 8 / 12) continue;
      const amount = person.basicMonthly ? gratuityAmount(person.basicMonthly, Math.max(5, service.rounded)) : null;
      drafts.push({
        detector: "compliance.gratuity", area: "compliance", subjectKey: `exit:${person.id}:${person.lastWorkingDay}`, severity: service.exact >= 5 ? "high" : "medium",
        title: `Gratuity likely payable on exit — ${service.exact.toFixed(1)} years of service`,
        explanation: `The last working day is ${dayLabel(person.lastWorkingDay)} after ${service.exact.toFixed(1)} years of service${service.exact < 5 ? " (under 5 years, but courts have counted 4 years 240 days as eligible for some establishments — verify)" : ""}. Gratuity must be paid within 30 days of becoming payable${amount ? `; at 15/26 × monthly basic × ${Math.max(5, service.rounded)} years it is about ${inr(amount)}` : ""}.`,
        employeeIds: [person.id],
        evidence: { facts: [{ label: "Joined", value: person.joiningDate }, { label: "Last working day", value: person.lastWorkingDay }, { label: "Service", value: `${service.exact.toFixed(2)} years (${service.rounded} counted)` },
          ...(person.basicMonthly ? [{ label: "Monthly basic", value: inr(person.basicMonthly) }] : []), ...(amount ? [{ label: "Estimated gratuity", value: inr(amount) }] : [])],
          note: "Estimate only: uses current basic (+DA if any) and the ₹20 lakh ceiling. Validate eligibility and the amount with your payroll specialist." },
        action: { label: "Open exit case", href: "/exit" }, audiences: ["PAYROLL"],
        basis: { id: person.id, lastDay: person.lastWorkingDay, years: service.rounded },
      });
      continue;
    }
    const until = daysBetween(today, fifth);
    if (until < 0 || until > windowDays) continue;
    const amount = person.basicMonthly ? gratuityAmount(person.basicMonthly, 5) : null;
    drafts.push({
      detector: "compliance.gratuity", area: "compliance", subjectKey: `five-years:${person.id}:${fifth}`, severity: "low",
      title: `Completes 5 years of service on ${dayLabel(fifth)}`,
      explanation: `Gratuity eligibility starts on ${dayLabel(fifth)} ${fifth.slice(0, 4)} (in ${plural(until, "day")}). From then an exit would make gratuity payable${amount ? ` — about ${inr(amount)} at the current basic` : ""}. Make sure the gratuity provision or insurance covers this person.`,
      employeeIds: [person.id],
      evidence: { facts: [{ label: "Joined", value: person.joiningDate }, { label: "5 years on", value: fifth }, ...(amount ? [{ label: "Liability at 5 years", value: inr(amount) }] : [])] },
      action: { label: "Open salary structure", href: `/payroll/structures?employee=${person.id}` }, audiences: ["PAYROLL"],
      basis: { id: person.id, fifth },
    });
  }
  return drafts;
}

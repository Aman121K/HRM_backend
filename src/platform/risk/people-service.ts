// People risk (explainable early-warning, leave liability) and service risk (SLA breaches, stuck approvals). Pure functions.
import { dayLabel, daysBetween, inr, plural, round, type SignalDraft } from "./risk.types";
import type { RiskSettings } from "./risk.settings";

export const ETHICS_NOTE =
  "This is a prompt to check in, not a prediction or a judgement. It uses only facts visible in Northstar (tenure, requests declined, overdue onboarding tasks, days with attendance) — never resignation-intent guesses, personal characteristics or private messages. It is visible only to HR and the person's direct manager. Do not use it for performance, pay or disciplinary decisions.";

export type Joiner = { id: string; joiningDate: string };
export type PeopleInput = {
  joiners: Joiner[];
  rejected: Map<string, { label: string; date: string }[]>;
  overdueOnboarding: Map<string, { count: number; oldestDue: string; joinerId: string }>;
  attendanceDays: Map<string, { recent: number; prior: number }>;
  today: string;
};

/** "Check in with this person": a new joiner with at least two independent, observable friction signals. */
export function checkInSignals(input: PeopleInput, settings: RiskSettings): SignalDraft[] {
  const s = settings.people;
  const drafts: SignalDraft[] = [];
  for (const person of input.joiners) {
    const tenure = daysBetween(person.joiningDate, input.today);
    if (tenure < 0 || tenure >= s.newJoinerDays) continue;
    const reasons: { label: string; value: string }[] = [];
    const rejected = input.rejected.get(person.id) || [];
    if (rejected.length >= s.rejectedRequests) reasons.push({ label: "Requests declined (60 days)", value: `${rejected.length}: ${rejected.map((row) => `${row.label} (${dayLabel(row.date)})`).join(", ")}` });
    const onboarding = input.overdueOnboarding.get(person.id);
    if (onboarding && onboarding.count > 0) reasons.push({ label: "Onboarding tasks overdue", value: `${onboarding.count}, oldest due ${dayLabel(onboarding.oldestDue)}` });
    const attendance = input.attendanceDays.get(person.id);
    if (attendance && attendance.prior >= 3) {
      const drop = ((attendance.prior - attendance.recent) / attendance.prior) * 100;
      if (drop >= s.attendanceDropPct) reasons.push({ label: "Days with attendance", value: `${attendance.recent} in the last 14 days vs ${attendance.prior} in the 14 before (−${round(drop, 0)}%)` });
    }
    if (reasons.length < 2) continue;
    drafts.push({
      detector: "people.check_in", area: "people", subjectKey: person.id, severity: reasons.length >= 3 ? "medium" : "low",
      title: `Check in with this new joiner (day ${tenure})`,
      explanation: `${plural(tenure, "day")} into the job, ${reasons.length} early friction signals showed up: ${reasons.map((reason) => reason.label.toLowerCase()).join("; ")}. A short, supportive conversation in the first 90 days is the single best way to keep a new hire — ask how onboarding is going and what's getting in the way.`,
      employeeIds: [person.id],
      evidence: { facts: [{ label: "Joined", value: person.joiningDate }, { label: "Tenure", value: `${tenure} days` }, ...reasons], note: ETHICS_NOTE },
      action: onboarding ? { label: "Open onboarding", href: `/onboarding/${onboarding.joinerId}` } : { label: "Open approvals history", href: "/approvals" },
      audiences: ["MANAGER"],
      basis: { id: person.id, reasons: reasons.map((reason) => reason.label).sort() },
    });
  }
  return drafts;
}

export type LeaveHolder = { id: string; joiningDate: string; basicMonthly: number | null };
export type LiabilityInput = { holders: LeaveHolder[]; quota: number; used: Map<string, number>; year: number; today: string };
export type LiabilityRow = { employeeId: string; entitled: number; used: number; balance: number; dailyRate: number; exposure: number };

/** Earned-leave encashment exposure: (pro-rated annual quota − days used this year) × monthly basic ÷ divisor. */
export function leaveLiability(input: LiabilityInput, settings: RiskSettings): { rows: LiabilityRow[]; total: number } {
  const rows: LiabilityRow[] = [];
  for (const person of input.holders) {
    if (!person.basicMonthly) continue;
    const joinYear = Number(person.joiningDate.slice(0, 4));
    const monthsInYear = joinYear < input.year ? 12 : joinYear > input.year ? 0 : 12 - Number(person.joiningDate.slice(5, 7)) + 1;
    const entitled = round((input.quota * monthsInYear) / 12, 1);
    const used = input.used.get(person.id) || 0;
    const balance = Math.max(0, round(entitled - used, 1));
    const dailyRate = person.basicMonthly / settings.people.encashmentDivisor;
    rows.push({ employeeId: person.id, entitled, used, balance, dailyRate: Math.round(dailyRate), exposure: Math.round(balance * dailyRate) });
  }
  rows.sort((a, b) => b.exposure - a.exposure);
  return { rows, total: rows.reduce((sum, row) => sum + row.exposure, 0) };
}

export function leaveLiabilitySignal(input: LiabilityInput, settings: RiskSettings): SignalDraft[] {
  const { rows, total } = leaveLiability(input, settings);
  if (total < settings.people.liabilityAlertAmount) return [];
  const days = round(rows.reduce((sum, row) => sum + row.balance, 0), 1);
  return [{
    detector: "people.leave_liability", area: "people", subjectKey: `EL:${input.year}`, severity: total >= settings.people.liabilityAlertAmount * 5 ? "medium" : "low",
    title: `Earned-leave encashment exposure ${inr(total)} (${days} days)`,
    explanation: `${plural(rows.filter((row) => row.balance > 0).length, "employee")} hold ${days} unused earned-leave days this year. If encashed on exit or at year end at monthly basic ÷ ${settings.people.encashmentDivisor}, that is about ${inr(total)} — above the ${inr(settings.people.liabilityAlertAmount)} alert level. Provide for it in the books, or encourage people to take their leave.`,
    employeeIds: rows.slice(0, 15).map((row) => row.employeeId),
    evidence: {
      columns: [{ key: "person", label: "Employee", kind: "person" }, { key: "entitled", label: "Entitled", kind: "number" }, { key: "used", label: "Used", kind: "number" }, { key: "balance", label: "Balance", kind: "number" }, { key: "rate", label: "Daily rate", kind: "money" }, { key: "exposure", label: "Exposure", kind: "money" }],
      rows: rows.slice(0, 15).map((row) => ({ person: row.employeeId, entitled: row.entitled, used: row.used, balance: row.balance, rate: row.dailyRate, exposure: row.exposure })),
      note: `Balance = earned-leave quota (${input.quota} days, pro-rated for joiners in ${input.year}) − approved earned leave this year. Carry-forward and the encashment rule in your policy may differ; basic is from each current salary structure.`,
    },
    action: { label: "Open leave", href: "/leave" }, audiences: ["PAYROLL"],
    basis: { year: input.year, total: Math.round(total / 25000) * 25000 },
  }];
}

// ------------------------------------------------------------------------------------------------------------ service

export type Ticket = { id: string; caseNumber: string; category: string | null; dueAt: string; closedAt: string | null; createdAt: string };
export function slaBreaches(tickets: Ticket[], settings: RiskSettings, now: Date): SignalDraft[] {
  const s = settings.service;
  const groups = new Map<string, (Ticket & { lateHours: number })[]>();
  for (const ticket of tickets) {
    const end = ticket.closedAt ? Date.parse(ticket.closedAt) : now.getTime();
    const late = (end - Date.parse(ticket.dueAt)) / 3_600_000;
    if (late <= 0) continue;
    const category = ticket.category || "Uncategorised";
    (groups.get(category) || groups.set(category, []).get(category)!).push({ ...ticket, lateHours: late });
  }
  const drafts: SignalDraft[] = [];
  for (const [category, list] of groups) {
    if (list.length < s.slaBreachCount) continue;
    const open = list.filter((ticket) => !ticket.closedAt).length;
    drafts.push({
      detector: "service.sla_breaches", area: "service", subjectKey: category, severity: list.length >= s.slaBreachCount * 2 || open >= 2 ? "high" : "medium",
      title: `${list.length} "${category}" tickets breached their SLA in ${s.slaWindowDays} days`,
      explanation: `${plural(list.length, "helpdesk ticket")} in "${category}" missed the SLA in the last ${s.slaWindowDays} days (${open} still open), by ${round(list.reduce((sum, ticket) => sum + ticket.lateHours, 0) / list.length, 1)} h on average. Repeated breaches in one category usually mean a missing owner, a knowledge gap or a broken process — fix the cause, not each ticket.`,
      employeeIds: [],
      evidence: { columns: [{ key: "ticket", label: "Ticket" }, { key: "due", label: "Due", kind: "datetime" }, { key: "closed", label: "Closed", kind: "datetime" }, { key: "late", label: "Hours late", kind: "number" }],
        rows: list.map((ticket) => ({ ticket: ticket.caseNumber, due: ticket.dueAt, closed: ticket.closedAt, late: round(ticket.lateHours, 1) })) },
      action: { label: "Open helpdesk", href: "/helpdesk" }, audiences: [],
      basis: { category, bucket: Math.floor(list.length / s.slaBreachCount), open: open > 0 }, records: list.map((ticket) => ({ type: "hr_case", id: ticket.id, label: ticket.caseNumber })),
    });
  }
  return drafts;
}

export type PendingApproval = { kind: "case" | "leave"; id: string; label: string; approverId: string; since: string };
export function stuckApprovals(items: PendingApproval[], settings: RiskSettings, now: Date): SignalDraft[] {
  const limit = settings.service.approvalStuckDays;
  const byApprover = new Map<string, (PendingApproval & { days: number })[]>();
  for (const item of items) {
    const days = (now.getTime() - Date.parse(item.since)) / 86_400_000;
    if (days <= limit) continue;
    (byApprover.get(item.approverId) || byApprover.set(item.approverId, []).get(item.approverId)!).push({ ...item, days });
  }
  const drafts: SignalDraft[] = [];
  for (const [approverId, list] of byApprover) {
    const oldest = Math.max(...list.map((item) => item.days));
    drafts.push({
      detector: "service.stuck_approvals", area: "service", subjectKey: approverId, severity: list.length >= 5 || oldest >= limit * 3 ? "high" : "medium",
      title: `${plural(list.length, "approval")} stuck with one approver for over ${limit} days`,
      explanation: `${plural(list.length, "request")} (${list.filter((item) => item.kind === "leave").length} leave, ${list.filter((item) => item.kind === "case").length} other) have waited on the same approver for more than ${limit} days; the oldest for ${round(oldest, 1)} days. Nudge the approver, or reassign/delegate while they are away.`,
      employeeIds: [approverId],
      evidence: { columns: [{ key: "request", label: "Request" }, { key: "kind", label: "Type" }, { key: "since", label: "Waiting since", kind: "datetime" }, { key: "days", label: "Days", kind: "number" }],
        rows: list.sort((a, b) => b.days - a.days).map((item) => ({ request: item.label, kind: item.kind === "leave" ? "Leave" : "Request", since: item.since, days: round(item.days, 1) })) },
      action: { label: "Open approvals", href: "/approvals" }, audiences: [],
      basis: { approverId, ids: list.map((item) => item.id).sort() },
      records: list.filter((item) => item.kind === "case").map((item) => ({ type: "hr_case", id: item.id, label: item.label })),
    });
  }
  return drafts;
}

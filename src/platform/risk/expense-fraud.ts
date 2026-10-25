// Expense claim fraud signals. Pure functions over claims loaded from the case engine (module "expenses").
import { dayLabel, daysBetween, inr, plural, uniq, weekday, type SignalDraft, type SkippedCheck } from "./risk.types";
import type { RiskSettings } from "./risk.settings";

export type Claim = {
  id: string; caseNumber: string; requesterId: string; category: string | null; amount: number; date: string; submittedOn: string;
  status: string; merchant: string | null; ocrDate: string | null; ocrTotal: number | null; duplicateReason: string | null;
};
export type ExpenseInput = {
  claims: Claim[]; limits: Record<string, number>;
  leaveDays: Map<string, Set<string>>; weeklyOffs: Set<string>; rostered: Set<string>;
};

export const EXPENSE_SKIPPED: SkippedCheck[] = [
  { key: "expenses.holidays", area: "expenses", label: "Claims on public holidays", reason: "Not checked: there is no holiday calendar in Northstar yet. Weekly offs from the roster (or Saturday/Sunday for people without a roster) are checked instead." },
];

const claimHref = (claim: Claim) => `/expenses?case=${claim.id}`;
const claimRow = (claim: Claim) => ({ claim: claim.caseNumber, date: claim.date, category: claim.category || "—", merchant: claim.merchant || "—", amount: claim.amount, status: claim.status });
const CLAIM_COLUMNS = [{ key: "claim", label: "Claim" }, { key: "date", label: "Expense date", kind: "date" as const }, { key: "category", label: "Category" }, { key: "merchant", label: "Merchant" }, { key: "amount", label: "Amount", kind: "money" as const }, { key: "status", label: "Status" }];
const records = (claims: Claim[]) => claims.map((claim) => ({ type: "hr_case", id: claim.id, label: claim.caseNumber }));
export const normalizeMerchant = (value: string | null) => String(value || "").toLowerCase().replace(/\b(pvt|ltd|private|limited|india|the|co)\b/g, "").replace(/[^a-z0-9]/g, "");
const live = (claim: Claim) => !["WITHDRAWN", "REJECTED", "CANCELLED", "DRAFT"].includes(claim.status);

export function expenseSignals(input: ExpenseInput, settings: RiskSettings): SignalDraft[] {
  const claims = input.claims.filter(live);
  const s = settings.expenses;
  return [
    ...duplicateReceipts(claims), ...roundNumbers(claims, s), ...splitClaims(claims, input.limits, s), ...offDayClaims(claims, input),
    ...onLeaveClaims(claims, input), ...lateClaims(claims, s), ...sameMerchantAcrossPeople(claims),
  ];
}

export function duplicateReceipts(claims: Claim[]): SignalDraft[] {
  return claims.filter((claim) => claim.duplicateReason).map((claim) => ({
    detector: "expenses.duplicate_receipt", area: "expenses" as const, subjectKey: claim.id, severity: "high" as const,
    title: `${claim.caseNumber}: receipt already used on another claim`,
    explanation: `${claim.caseNumber} (${inr(claim.amount)}, ${dayLabel(claim.date)}) was submitted with a receipt the scanner matched to an earlier claim: ${claim.duplicateReason?.replace(/ by a colleague/, " by someone else")} Reimbursing both pays for the same expense twice.`,
    employeeIds: [claim.requesterId], evidence: { columns: CLAIM_COLUMNS, rows: [claimRow(claim)], facts: [{ label: "Scanner finding", value: claim.duplicateReason || "" }] },
    action: { label: "Open claim", href: claimHref(claim) }, audiences: ["MANAGER" as const], basis: { id: claim.id }, records: records([claim]),
  }));
}

export function roundNumbers(claims: Claim[], s: RiskSettings["expenses"]): SignalDraft[] {
  const byPerson = new Map<string, Claim[]>();
  for (const claim of claims) if (claim.amount >= s.roundAmountStep && claim.amount % s.roundAmountStep === 0)
    (byPerson.get(claim.requesterId) || byPerson.set(claim.requesterId, []).get(claim.requesterId)!).push(claim);
  const drafts: SignalDraft[] = [];
  for (const [employeeId, list] of byPerson) {
    if (list.length < s.roundClaimCount) continue;
    const total = list.reduce((sum, claim) => sum + claim.amount, 0);
    drafts.push({
      detector: "expenses.round_amounts", area: "expenses", subjectKey: employeeId, severity: list.length >= s.roundClaimCount * 2 ? "high" : "medium",
      title: `${list.length} round-number claims in ${s.lookbackDays} days`,
      explanation: `${plural(list.length, "claim")} totalling ${inr(total)} are exact multiples of ${inr(s.roundAmountStep)}. Real bills rarely come to round amounts; repeated round figures often mean estimates or claims without a genuine receipt. Ask for itemised bills.`,
      employeeIds: [employeeId], evidence: { columns: CLAIM_COLUMNS, rows: list.map(claimRow) },
      action: { label: "Open claims", href: "/expenses" }, audiences: ["MANAGER"],
      basis: { employeeId, bucket: Math.floor(list.length / s.roundClaimCount) }, records: records(list),
    });
  }
  return drafts;
}

/** Several claims in the same category within a short window, each under the limit but together over it. */
export function splitClaims(claims: Claim[], limits: Record<string, number>, s: RiskSettings["expenses"]): SignalDraft[] {
  const groups = new Map<string, Claim[]>();
  for (const claim of claims) {
    if (!claim.category || !limits[claim.category]) continue;
    const key = `${claim.requesterId}|${claim.category}`;
    (groups.get(key) || groups.set(key, []).get(key)!).push(claim);
  }
  const drafts: SignalDraft[] = [];
  for (const [key, list] of groups) {
    const [employeeId, category] = key.split("|");
    const limit = limits[category];
    list.sort((a, b) => a.date.localeCompare(b.date) || a.caseNumber.localeCompare(b.caseNumber));
    const used = new Set<string>();
    for (let i = 0; i < list.length; i += 1) {
      if (used.has(list[i].id)) continue;
      const cluster = list.filter((claim) => !used.has(claim.id) && claim.amount < limit && daysBetween(list[i].date, claim.date) >= 0 && daysBetween(list[i].date, claim.date) <= s.splitWindowDays);
      const total = cluster.reduce((sum, claim) => sum + claim.amount, 0);
      if (cluster.length < 2 || total <= limit) continue;
      cluster.forEach((claim) => used.add(claim.id));
      const nearLimit = cluster.filter((claim) => claim.amount >= limit * 0.8).length;
      drafts.push({
        detector: "expenses.split_claims", area: "expenses", subjectKey: `${employeeId}:${category}:${cluster[0].date}`, severity: nearLimit >= 2 ? "high" : "medium",
        title: `${cluster.length} ${category} claims just under the ${inr(limit)} limit`,
        explanation: `${plural(cluster.length, "claim")} in ${category} between ${dayLabel(cluster[0].date)} and ${dayLabel(cluster[cluster.length - 1].date)} are each below the ${inr(limit)} policy limit but add up to ${inr(total)}${nearLimit ? `; ${nearLimit} are within 20% of the limit` : ""}. Splitting one bill into several claims avoids the limit check.`,
        employeeIds: [employeeId], evidence: { columns: CLAIM_COLUMNS, rows: cluster.map(claimRow), facts: [{ label: "Policy limit", value: inr(limit) }, { label: "Combined", value: inr(total) }] },
        action: { label: "Open first claim", href: claimHref(cluster[0]) }, audiences: ["MANAGER"],
        basis: { ids: cluster.map((claim) => claim.id).sort() }, records: records(cluster),
      });
    }
  }
  return drafts;
}

/** Claims dated on the person's rostered weekly off (or a weekend for people without a roster). */
export function offDayClaims(claims: Claim[], input: Pick<ExpenseInput, "weeklyOffs" | "rostered">): SignalDraft[] {
  const byPerson = new Map<string, { claim: Claim; why: string }[]>();
  for (const claim of claims) {
    let why: string | null = null;
    if (input.weeklyOffs.has(`${claim.requesterId}:${claim.date}`)) why = "rostered weekly off";
    else if (!input.rostered.has(claim.requesterId) && (weekday(claim.date) === 0 || weekday(claim.date) === 6)) why = weekday(claim.date) === 0 ? "Sunday" : "Saturday";
    if (why) (byPerson.get(claim.requesterId) || byPerson.set(claim.requesterId, []).get(claim.requesterId)!).push({ claim, why });
  }
  return [...byPerson].map(([employeeId, list]) => ({
    detector: "expenses.off_day", area: "expenses" as const, subjectKey: employeeId, severity: list.length >= 3 ? "medium" as const : "low" as const,
    title: `${plural(list.length, "claim")} dated on a day off`,
    explanation: `${plural(list.length, "claim")} (${inr(list.reduce((sum, row) => sum + row.claim.amount, 0))}) are dated on the person's ${uniq(list.map((row) => row.why)).join(" / ")}. Business expenses on non-working days can be legitimate (events, supplier visits) but should carry a reason.`,
    employeeIds: [employeeId], evidence: { columns: [...CLAIM_COLUMNS, { key: "why", label: "Day" }], rows: list.map((row) => ({ ...claimRow(row.claim), why: row.why })) },
    action: { label: "Open claims", href: "/expenses" }, audiences: ["MANAGER" as const],
    basis: { ids: list.map((row) => row.claim.id).sort() }, records: records(list.map((row) => row.claim)),
  }));
}

export function onLeaveClaims(claims: Claim[], input: Pick<ExpenseInput, "leaveDays">): SignalDraft[] {
  return claims.filter((claim) => input.leaveDays.get(claim.requesterId)?.has(claim.date)).map((claim) => ({
    detector: "expenses.on_leave", area: "expenses" as const, subjectKey: claim.id, severity: "medium" as const,
    title: `${claim.caseNumber}: expense dated during approved leave`,
    explanation: `${claim.caseNumber} claims ${inr(claim.amount)} for ${claim.category || "an expense"} on ${dayLabel(claim.date)}, a day the person was on approved leave. Confirm it was business-related before approving.`,
    employeeIds: [claim.requesterId], evidence: { columns: CLAIM_COLUMNS, rows: [claimRow(claim)] },
    action: { label: "Open claim", href: claimHref(claim) }, audiences: ["MANAGER" as const], basis: { id: claim.id }, records: records([claim]),
  }));
}

/** Submitted long after the receipt date (stale or recycled receipts). */
export function lateClaims(claims: Claim[], s: RiskSettings["expenses"]): SignalDraft[] {
  const drafts: SignalDraft[] = [];
  for (const claim of claims) {
    const receipt = claim.ocrDate || claim.date;
    const late = daysBetween(receipt, claim.submittedOn);
    if (late <= s.lateReceiptDays) continue;
    drafts.push({
      detector: "expenses.late_claim", area: "expenses", subjectKey: claim.id, severity: late > s.lateReceiptDays * 2 ? "medium" : "low",
      title: `${claim.caseNumber}: claimed ${late} days after the ${claim.ocrDate ? "receipt" : "expense"} date`,
      explanation: `${claim.caseNumber} (${inr(claim.amount)}) was submitted on ${dayLabel(claim.submittedOn)} for a ${claim.ocrDate ? "receipt dated" : "expense on"} ${dayLabel(receipt)} — ${late} days later, beyond the ${s.lateReceiptDays}-day window. Old receipts are a common way to recycle bills; many policies also bar claims this late.`,
      employeeIds: [claim.requesterId], evidence: { columns: CLAIM_COLUMNS, rows: [claimRow(claim)], facts: [{ label: "Receipt date", value: receipt }, { label: "Submitted", value: claim.submittedOn }, { label: "Days late", value: String(late) }] },
      action: { label: "Open claim", href: claimHref(claim) }, audiences: ["MANAGER"], basis: { id: claim.id }, records: records([claim]),
    });
  }
  return drafts;
}

/** The same merchant and amount on the same day claimed by two or more people. */
export function sameMerchantAcrossPeople(claims: Claim[]): SignalDraft[] {
  const groups = new Map<string, Claim[]>();
  for (const claim of claims) {
    const merchant = normalizeMerchant(claim.merchant);
    if (merchant.length < 3) continue;
    const key = `${merchant}|${claim.amount.toFixed(2)}|${claim.date}`;
    (groups.get(key) || groups.set(key, []).get(key)!).push(claim);
  }
  const drafts: SignalDraft[] = [];
  for (const [key, list] of groups) {
    const people = uniq(list.map((claim) => claim.requesterId)).sort();
    if (people.length < 2) continue;
    const [, amount, date] = key.split("|");
    drafts.push({
      detector: "expenses.same_merchant", area: "expenses", subjectKey: key, severity: "medium",
      title: `${people.length} people claimed ${inr(Number(amount))} at the same merchant on ${dayLabel(date)}`,
      explanation: `${plural(list.length, "claim")} from ${people.length} different employees are for exactly ${inr(Number(amount))} at ${list[0].merchant} on ${dayLabel(date)}. This is either one shared bill claimed by everyone, or the same receipt photo reused — ask for the original bill.`,
      employeeIds: people, evidence: { columns: [{ key: "person", label: "Employee", kind: "person" }, ...CLAIM_COLUMNS], rows: list.map((claim) => ({ person: claim.requesterId, ...claimRow(claim) })) },
      action: { label: "Open first claim", href: claimHref(list[0]) }, audiences: ["MANAGER"],
      basis: { ids: list.map((claim) => claim.id).sort() }, records: records(list),
    });
  }
  return drafts;
}

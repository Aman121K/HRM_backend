// The report catalogue: metadata (who may run it, metric definitions) plus a builder that turns SQL aggregates into
// KPIs, charts and one exportable table.
import { caseModuleMap } from "../cases/case-modules";
import { Ctx, MIN_GROUP, change, median, monthLabel, num, pct, previousRange, round, sum, suppress, type Range } from "./analytics.context";
import * as m from "./analytics.metrics";
import type { Chart, Kpi, ReportBody, ReportMeta } from "./analytics.types";

const PEOPLE = { manager: true, finance: false };
const HR_ONLY = { manager: false, finance: false };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SUPPRESSION_NOTE = `Groups with fewer than ${MIN_GROUP} people are pooled or hidden so individuals cannot be identified.`;

export const kpi = (key: string, label: string, value: number | null, format: Kpi["format"], extra: Partial<Kpi> = {}): Kpi => ({ key, label, value, format, ...extra });
const withDelta = (base: Kpi, previous: number | null, unit: "%" | "pts" = "%"): Kpi => ({
  ...base, previous, deltaUnit: unit,
  delta: unit === "pts" ? (base.value === null || previous === null ? null : round(base.value - previous, 1)) : change(base.value, previous),
});
const labels = (range: Range) => range.months.map(monthLabel);
const byMonth = <T extends { month: string }>(range: Range, rows: T[], pick: (rows: T[]) => number | null) =>
  range.months.map((month) => pick(rows.filter((row) => row.month === month)));
const unavailable = (message: string, title = "Details"): ReportBody => ({ available: false, unavailable: message, kpis: [], charts: [], table: { title, columns: [], rows: [] }, footnotes: [] });

// ---- shared calculations ---------------------------------------------------------------------------
export function movementSummary(rows: m.MonthMovement[]) {
  const months = rows.length || 1;
  const avgHeadcount = rows.length ? sum(rows.map((row) => (row.opening + row.headcount) / 2)) / rows.length : 0;
  const leavers = sum(rows.map((row) => row.leavers));
  const joiners = sum(rows.map((row) => row.joiners));
  return {
    opening: rows[0]?.opening ?? 0, closing: rows[rows.length - 1]?.headcount ?? 0, joiners, leavers, avgHeadcount,
    attrition: avgHeadcount > 0 ? round((leavers / avgHeadcount) * (12 / months) * 100, 1) : null,
  };
}
const monthlyAttrition = (row: m.MonthMovement) => {
  const avg = (row.opening + row.headcount) / 2;
  return avg > 0 ? round((row.leavers / avg) * 12 * 100, 1) : null;
};

// ---- builders ------------------------------------------------------------------------------------
async function headcount(ctx: Ctx): Promise<ReportBody> {
  const [rows, prev, departments] = await Promise.all([m.workforceMonthly(ctx), m.workforceMonthly(ctx, previousRange(ctx.range)), m.workforceBy(ctx, "department")]);
  const now = movementSummary(rows), before = movementSummary(prev);
  return {
    available: true,
    kpis: [
      withDelta(kpi("headcount", "Headcount", now.closing, "number", { goodWhen: "neutral", spark: rows.map((row) => row.headcount), note: `vs ${now.opening} at start` }), before.closing),
      withDelta(kpi("joiners", "Joiners", now.joiners, "number", { goodWhen: "up", spark: rows.map((row) => row.joiners) }), before.joiners),
      withDelta(kpi("leavers", "Leavers", now.leavers, "number", { goodWhen: "down", spark: rows.map((row) => row.leavers) }), before.leavers),
      kpi("net", "Net change", now.closing - now.opening, "number", { note: `${now.opening} → ${now.closing}` }),
      kpi("avg", "Average headcount", round(now.avgHeadcount, 1), "decimal", { note: "mean of month start/end" }),
    ],
    charts: [
      { id: "trend", type: "line", title: "Month-end headcount", format: "number", categories: labels(ctx.range), series: [{ name: "Headcount", values: rows.map((row) => row.headcount) }], wide: true },
      { id: "movement", type: "bar", title: "Joiners vs leavers", format: "number", categories: labels(ctx.range), series: [{ name: "Joiners", values: rows.map((row) => row.joiners) }, { name: "Leavers", values: rows.map((row) => row.leavers) }] },
      { id: "departments", type: "bar", horizontal: true, title: "Headcount by department", subtitle: "at end of range", format: "number", categories: departments.map((row) => row.label), series: [{ name: "Headcount", values: departments.map((row) => row.headcount) }] },
    ],
    table: {
      title: "Monthly movement",
      columns: [
        { key: "month", label: "Month", format: "month" }, { key: "opening", label: "Opening", format: "number" }, { key: "joiners", label: "Joiners", format: "number" },
        { key: "leavers", label: "Leavers", format: "number" }, { key: "headcount", label: "Closing", format: "number" }, { key: "net", label: "Net", format: "number" },
        { key: "attrition", label: "Attrition (annualised)", format: "percent" },
      ],
      rows: rows.map((row) => ({ ...row, net: row.headcount - row.opening, attrition: monthlyAttrition(row) })),
    },
    footnotes: ctx.range.partialLastMonth ? ["The last month is month-to-date; its closing headcount is as of today."] : [],
  };
}

async function attrition(ctx: Ctx): Promise<ReportBody> {
  const [rows, prev, departments, reasons] = await Promise.all([
    m.workforceMonthly(ctx), m.workforceMonthly(ctx, previousRange(ctx.range)), m.workforceBy(ctx, "department"), m.exitReasons(ctx),
  ]);
  const now = movementSummary(rows), before = movementSummary(prev);
  const deptRows = departments.map((row) => {
    const avg = (row.opening + row.headcount) / 2;
    return { department: row.label, size: Math.max(row.opening, row.headcount), avgHeadcount: round(avg, 1), leavers: row.leavers, attrition: avg > 0 ? round((row.leavers / avg) * (12 / ctx.range.months.length) * 100, 1) : null };
  });
  const safe = suppress(deptRows, "size", ["leavers", "attrition"], "department", (group) => {
    const avg = sum(group.map((row) => row.avgHeadcount || 0));
    const leavers = sum(group.map((row) => row.leavers));
    return { department: "", size: sum(group.map((row) => row.size)), avgHeadcount: round(avg, 1), leavers, attrition: avg > 0 ? round((leavers / avg) * (12 / ctx.range.months.length) * 100, 1) : null };
  });
  const totalLeavers = sum(reasons.map((row) => row.leavers));
  const early = sum(reasons.map((row) => row.early));
  const tenureAtExit = totalLeavers ? sum(reasons.map((row) => num(row.tenure) * row.leavers)) / totalLeavers : null;
  const charts: Chart[] = [
    { id: "rate", type: "line", title: "Attrition rate, annualised", subtitle: "leavers ÷ average headcount × 12", format: "percent", categories: labels(ctx.range), series: [{ name: "Attrition", values: rows.map(monthlyAttrition) }], wide: true },
    { id: "departments", type: "bar", horizontal: true, title: "Attrition by department", subtitle: "annualised over the range", format: "percent", categories: safe.rows.map((row) => row.department), series: [{ name: "Attrition", values: safe.rows.map((row) => row.attrition) }] },
    totalLeavers >= MIN_GROUP
      ? { id: "reasons", type: "donut", title: "Primary exit reasons", format: "number", slices: reasons.map((row) => ({ label: row.reason, value: row.leavers })) }
      : { id: "reasons", type: "empty", title: "Primary exit reasons", format: "number", message: totalLeavers ? `Hidden: fewer than ${MIN_GROUP} leavers in this selection.` : "No exits in this period." },
  ];
  return {
    available: true, suppressedGroups: safe.suppressedGroups,
    kpis: [
      withDelta(kpi("attrition", "Attrition (annualised)", now.attrition, "percent", { goodWhen: "down", spark: rows.map(monthlyAttrition) }), before.attrition, "pts"),
      withDelta(kpi("leavers", "Leavers", now.leavers, "number", { goodWhen: "down" }), before.leavers),
      kpi("early", "Left within 6 months", totalLeavers >= MIN_GROUP ? pct(early, totalLeavers) : null, "percent", { goodWhen: "down", note: totalLeavers >= MIN_GROUP ? `${early} of ${totalLeavers} leavers` : "suppressed below 3 leavers" }),
      kpi("tenure", "Avg tenure at exit", totalLeavers >= MIN_GROUP ? round(tenureAtExit, 1) : null, "months"),
    ],
    charts,
    table: {
      title: "Attrition by department",
      columns: [
        { key: "department", label: "Department", format: "text" }, { key: "avgHeadcount", label: "Avg headcount", format: "decimal" },
        { key: "leavers", label: "Leavers", format: "number" }, { key: "attrition", label: "Attrition (annualised)", format: "percent" },
      ],
      rows: safe.rows, note: SUPPRESSION_NOTE,
    },
    footnotes: [SUPPRESSION_NOTE, "Exits come from completed resignation cases (last working day) and deactivated employee records."],
  };
}

async function tenure(ctx: Ctx): Promise<ReportBody> {
  const rows = await m.tenureBands(ctx);
  const total = sum(rows.map((row) => row.people));
  const bands = m.TENURE_BANDS.map((band) => sum(rows.filter((row) => row.band === band).map((row) => row.people)));
  const avg = total ? sum(rows.map((row) => row.tenure * row.people)) / total : null;
  const departments = [...new Set(rows.map((row) => row.department))];
  const tableRows = departments.map((department) => {
    const own = rows.filter((row) => row.department === department);
    const people = sum(own.map((row) => row.people));
    const out: Record<string, unknown> = { department, people, avg: people ? round(sum(own.map((row) => row.tenure * row.people)) / people, 1) : null };
    m.TENURE_BANDS.forEach((band, index) => { out[`b${index}`] = sum(own.filter((row) => row.band === band).map((row) => row.people)); });
    return out;
  }).sort((a, b) => num(b.people) - num(a.people));
  return {
    available: true,
    kpis: [
      kpi("avg", "Average tenure", round(avg, 1), "months"),
      kpi("new", "Under 1 year", pct(bands[0] + bands[1], total), "percent", { note: `${bands[0] + bands[1]} of ${total} people` }),
      kpi("veteran", "5+ years", pct(bands[4], total), "percent", { note: `${bands[4]} people` }),
      kpi("people", "People analysed", total, "number", { note: "employed at end of range" }),
    ],
    charts: [
      { id: "bands", type: "bar", title: "Tenure distribution", format: "number", categories: m.TENURE_BANDS, series: [{ name: "People", values: bands }] },
      { id: "dept", type: "bar", horizontal: true, stacked: true, title: "Tenure mix by department", format: "number", categories: tableRows.map((row) => String(row.department)), series: m.TENURE_BANDS.map((band, index) => ({ name: band, values: tableRows.map((row) => num(row[`b${index}`])) })), wide: true },
    ],
    table: {
      title: "Tenure by department",
      columns: [{ key: "department", label: "Department", format: "text" }, { key: "people", label: "People", format: "number" }, { key: "avg", label: "Avg tenure (months)", format: "decimal" },
        ...m.TENURE_BANDS.map((band, index) => ({ key: `b${index}`, label: band, format: "number" as const }))],
      rows: tableRows,
    },
    footnotes: ["Tenure is measured from the joining date on the employee record to the end of the selected range."],
  };
}

async function span(ctx: Ctx): Promise<ReportBody> {
  const rows = await m.spanOfControl(ctx);
  const spans = rows.map((row) => row.direct as number);
  const buckets = [["1–2", 1, 2], ["3–5", 3, 5], ["6–8", 6, 8], ["9–12", 9, 12], ["13+", 13, 1e9]] as const;
  const layers = rows.length ? Math.max(...rows.map((row) => num(row.layers))) : 0;
  return {
    available: true,
    kpis: [
      kpi("managers", "People managers", rows.length, "number"),
      kpi("avg", "Average span", spans.length ? round(sum(spans) / spans.length, 1) : null, "decimal", { note: "direct reports per manager" }),
      kpi("median", "Median span", round(median(spans), 1), "decimal"),
      kpi("narrow", "Narrow spans (1–2)", spans.filter((value) => value <= 2).length, "number", { goodWhen: "down", note: "candidates for consolidation" }),
      kpi("layers", "Management layers", layers, "number", { note: "deepest reporting chain below a manager" }),
    ],
    charts: [
      { id: "distribution", type: "bar", title: "Span of control distribution", format: "number", categories: buckets.map((b) => b[0]), series: [{ name: "Managers", values: buckets.map(([, lo, hi]) => spans.filter((value) => value >= lo && value <= hi).length) }] },
      { id: "top", type: "bar", horizontal: true, title: "Largest teams", subtitle: "direct vs total reports", format: "number", categories: rows.slice(0, 10).map((row) => row.name), series: [{ name: "Direct", values: rows.slice(0, 10).map((row) => row.direct) }, { name: "Total org", values: rows.slice(0, 10).map((row) => row.total) }] },
    ],
    table: {
      title: "Managers",
      columns: [{ key: "name", label: "Manager", format: "text" }, { key: "designation", label: "Role", format: "text" }, { key: "department", label: "Department", format: "text" },
        { key: "direct", label: "Direct reports", format: "number" }, { key: "total", label: "Total org", format: "number" }, { key: "layers", label: "Layers below", format: "number" }],
      rows: rows.map(({ id: _id, ...row }) => row),
    },
    footnotes: ["Counts active employees only, as of today. Direct reports are counted even if they sit outside the department filter."],
  };
}

async function composition(ctx: Ctx): Promise<ReportBody> {
  const [locations, designations, departments, gender] = await Promise.all([m.workforceBy(ctx, "location"), m.workforceBy(ctx, "designation"), m.workforceBy(ctx, "department"), m.genderSplit(ctx)]);
  const total = sum(locations.map((row) => row.headcount));
  const genderRows = gender ? gender.map((row) => ({ label: row.label as string, people: row.people as number })) : null;
  const genderSafe = genderRows ? suppress(genderRows, "people", ["people"], "label").rows : null;
  const unknownLocation = locations.find((row) => row.label === "Unassigned")?.headcount || 0;
  return {
    available: true,
    kpis: [
      kpi("headcount", "Headcount", total, "number", { note: "at end of range" }),
      kpi("locations", "Locations", locations.filter((row) => row.headcount && row.label !== "Unassigned").length, "number"),
      kpi("departments", "Departments", departments.filter((row) => row.headcount).length, "number"),
      kpi("roles", "Distinct roles", designations.filter((row) => row.headcount).length, "number"),
      kpi("nolocation", "Missing location", unknownLocation, "number", { goodWhen: "down", note: unknownLocation ? "update employee records" : "all records complete" }),
    ],
    charts: [
      { id: "locations", type: "donut", title: "Headcount by location", format: "number", slices: locations.filter((row) => row.headcount).map((row) => ({ label: row.label, value: row.headcount })) },
      { id: "roles", type: "bar", horizontal: true, title: "Most common roles", format: "number", categories: designations.slice(0, 10).map((row) => row.label), series: [{ name: "People", values: designations.slice(0, 10).map((row) => row.headcount) }] },
      genderSafe
        ? { id: "gender", type: "donut", title: "Gender", format: "number", slices: genderSafe.filter((row) => row.people !== null).map((row) => ({ label: row.label, value: num(row.people) })) }
        : { id: "gender", type: "empty", title: "Gender", format: "number", message: "Gender is not captured on the employee record, so no split is shown. Northstar never infers it from names." },
    ],
    table: {
      title: "Headcount by location",
      columns: [{ key: "label", label: "Location", format: "text" }, { key: "headcount", label: "Headcount", format: "number" }, { key: "share", label: "Share", format: "percent" },
        { key: "joiners", label: "Joiners", format: "number" }, { key: "leavers", label: "Leavers", format: "number" }, { key: "avgTenureMonths", label: "Avg tenure (months)", format: "decimal" }],
      rows: locations.map((row) => ({ ...row, share: pct(row.headcount, total) })),
    },
    footnotes: [gender ? SUPPRESSION_NOTE : "Gender: not captured — shown as unknown rather than estimated."],
  };
}

async function leaveUtilisation(ctx: Ctx): Promise<ReportBody> {
  const [types, days, move, prevTypes] = await Promise.all([m.leaveByType(ctx), m.leaveByDay(ctx), m.workforceMonthly(ctx), m.leaveByType(ctx, previousRange(ctx.range))]);
  const avgHc = movementSummary(move).avgHeadcount;
  const years = ctx.range.months.length / 12;
  const total = sum(types.map((row) => row.days));
  const prevTotal = sum(prevTypes.map((row) => row.days));
  const capped = types.filter((row) => row.quota < 365);
  const entitlement = sum(capped.map((row) => row.quota)) * avgHc * years;
  const monthly = byMonth(ctx.range, days, (rows) => round(sum(rows.map((row) => row.days)), 1));
  return {
    available: true,
    kpis: [
      withDelta(kpi("days", "Leave days taken", round(total, 1), "days", { goodWhen: "neutral", spark: monthly }), round(prevTotal, 1)),
      kpi("perFte", "Days per employee / yr", avgHc ? round(total / avgHc / years, 1) : null, "decimal", { note: "annualised" }),
      kpi("utilisation", "Entitlement used", entitlement ? pct(sum(capped.map((row) => row.days)), entitlement) : null, "percent", { note: "pro-rated for the range" }),
      kpi("pending", "Pending approval", round(sum(types.map((row) => row.pending_days)), 1), "days", { goodWhen: "down" }),
    ],
    charts: [
      { id: "types", type: "bar", horizontal: true, title: "Days taken by leave type", format: "days", categories: types.filter((row) => row.days > 0).map((row) => row.name), series: [{ name: "Days", values: types.filter((row) => row.days > 0).map((row) => round(row.days, 1)) }] },
      { id: "monthly", type: "line", title: "Leave days by month", format: "days", categories: labels(ctx.range), series: [{ name: "Leave days", values: monthly }] },
    ],
    table: {
      title: "Leave by type",
      columns: [{ key: "name", label: "Leave type", format: "text" }, { key: "requests", label: "Approved requests", format: "number" }, { key: "days", label: "Days taken", format: "decimal" },
        { key: "employees", label: "Employees", format: "number" }, { key: "quota", label: "Annual quota", format: "decimal" }, { key: "utilisation", label: "Utilisation", format: "percent" },
        { key: "notice", label: "Avg notice (days)", format: "decimal" }, { key: "pending_days", label: "Pending days", format: "decimal" }],
      rows: types.map((row) => ({
        name: row.name, requests: row.requests, days: round(row.days, 1), employees: row.employees, quota: row.quota >= 365 ? null : row.quota,
        utilisation: row.quota < 365 && avgHc ? pct(row.days, row.quota * avgHc * years) : null, notice: round(row.notice, 1), pending_days: round(row.pending_days, 1),
      })),
    },
    footnotes: ["Requests spanning the range edges are pro-rated to the days inside it.", "Utilisation compares days taken with quota × average headcount for the period; uncapped types (e.g. loss of pay) are excluded."],
  };
}

async function unplannedLeave(ctx: Ctx): Promise<ReportBody> {
  const days = await m.leaveByDay(ctx);
  const total = sum(days.map((row) => row.days));
  const unplanned = sum(days.map((row) => row.unplanned));
  const byDow = WEEKDAYS.map((_, index) => sum(days.filter((row) => row.dow === index + 1).map((row) => row.unplanned)));
  const monFri = byDow[0] + byDow[4];
  const heat = WEEKDAYS.map((_, index) => ctx.range.months.map((month) => round(sum(days.filter((row) => row.month === month && row.dow === index + 1).map((row) => row.unplanned)), 1)));
  const tableRows = ctx.range.months.map((month) => {
    const own = days.filter((row) => row.month === month);
    const t = sum(own.map((row) => row.days)), u = sum(own.map((row) => row.unplanned));
    return { month, total: round(t, 1), unplanned: round(u, 1), share: pct(u, t), monFri: round(sum(own.filter((row) => row.dow === 1 || row.dow === 5).map((row) => row.unplanned)), 1) };
  });
  const peak = byDow.indexOf(Math.max(...byDow));
  return {
    available: true,
    kpis: [
      kpi("unplanned", "Unplanned leave days", round(unplanned, 1), "days", { goodWhen: "down", spark: tableRows.map((row) => row.unplanned) }),
      kpi("share", "Share of all leave", pct(unplanned, total), "percent", { goodWhen: "down" }),
      kpi("monfri", "On Mondays & Fridays", pct(monFri, unplanned), "percent", { goodWhen: "down", note: "40% would be an even spread (2 of 5 weekdays)" }),
      kpi("peak", "Peak weekday", null, "text", { text: unplanned ? WEEKDAYS[peak] : "—", note: unplanned ? `${round(byDow[peak], 1)} unplanned days` : "no unplanned leave" }),
    ],
    charts: [
      { id: "heatmap", type: "heatmap", title: "Unplanned leave by weekday", subtitle: "days per weekday per month", format: "days", rows: WEEKDAYS, cols: labels(ctx.range), values: heat, wide: true },
      { id: "dow", type: "bar", title: "Unplanned days by weekday", format: "days", categories: WEEKDAYS, series: [{ name: "Unplanned days", values: byDow.map((value) => round(value, 1)) }] },
      { id: "share", type: "line", title: "Unplanned share of leave", format: "percent", categories: labels(ctx.range), series: [{ name: "Unplanned share", values: tableRows.map((row) => row.share) }] },
    ],
    table: {
      title: "Unplanned leave by month",
      columns: [{ key: "month", label: "Month", format: "month" }, { key: "total", label: "All leave days", format: "decimal" }, { key: "unplanned", label: "Unplanned days", format: "decimal" },
        { key: "share", label: "Unplanned share", format: "percent" }, { key: "monFri", label: "Unplanned Mon/Fri", format: "decimal" }],
      rows: tableRows,
    },
    footnotes: ["Unplanned = sick leave, or any leave applied for on or after its first day.", "Multi-day leave is spread evenly across its calendar days."],
  };
}

async function attendance(ctx: Ctx): Promise<ReportBody> {
  const [{ roster, rows }, regs, shifts] = await Promise.all([m.attendanceMonthly(ctx), m.regularizations(ctx), m.rosterAdherence(ctx)]);
  const rostered = shifts ? shifts.filter((row) => row.kind === "SHIFT") : [];
  const rosteredTotal = sum(rostered.map((row) => row.assignments)), attendedTotal = sum(rostered.map((row) => row.attended));
  const shiftNames = [...new Set(rostered.map((row) => row.shift))];
  const monthRows = ctx.range.months.map((month) => {
    const own = rows.filter((row) => row.month === month);
    const expected = sum(own.map((row) => row.expected - row.leave_days));
    const punched = sum(own.map((row) => row.punched));
    const late = sum(own.map((row) => row.late));
    const r = regs.filter((row) => row.month === month);
    return { month, expected: round(expected, 0), punched, rate: pct(punched, expected), late, lateShare: pct(late, punched), regularizations: sum(r.map((row) => row.requests)) };
  });
  const departments = [...new Set(rows.map((row) => row.department))].map((department) => {
    const own = rows.filter((row) => row.department === department);
    const expected = sum(own.map((row) => row.expected - row.leave_days));
    const punched = sum(own.map((row) => row.punched));
    const late = sum(own.map((row) => row.late));
    return { department, expected: round(expected, 0), leave: round(sum(own.map((row) => row.leave_days)), 1), punched, rate: pct(punched, expected), late, lateShare: pct(late, punched) };
  }).sort((a, b) => num(b.expected) - num(a.expected));
  const expected = sum(monthRows.map((row) => row.expected)), punched = sum(monthRows.map((row) => row.punched)), late = sum(monthRows.map((row) => row.late));
  const regTotal = sum(regs.map((row) => row.requests));
  const regApproved = sum(regs.filter((row) => row.status === "APPROVED").map((row) => row.requests));
  const regDecided = sum(regs.filter((row) => row.status !== "PENDING").map((row) => row.requests));
  const statuses = ["APPROVED", "PENDING", "CHANGES_REQUESTED", "REJECTED"];
  return {
    available: true,
    kpis: [
      kpi("rate", "Punch-in rate", pct(punched, expected), "percent", { goodWhen: "up", spark: monthRows.map((row) => row.rate), note: `${punched} of ${round(expected, 0)} expected days` }),
      kpi("late", "Late first punch", pct(late, punched), "percent", { goodWhen: "down", note: `${late} late days` }),
      kpi("regs", "Regularization requests", regTotal, "number", { goodWhen: "down", spark: monthRows.map((row) => row.regularizations) }),
      kpi("approval", "Regularizations approved", pct(regApproved, regDecided), "percent", { note: `${regDecided} decided` }),
      ...(shifts ? [kpi("adherence", "Rostered shifts attended", pct(attendedTotal, rosteredTotal), "percent", { goodWhen: "up", note: `${attendedTotal} of ${rosteredTotal} shifts to date`, spark: byMonth(ctx.range, rostered, (own) => pct(sum(own.map((row) => row.attended)), sum(own.map((row) => row.assignments)))) })] : []),
    ],
    charts: [
      { id: "rate", type: "line", title: "Punch-in rate", subtitle: "days with a punch ÷ expected working days", format: "percent", categories: labels(ctx.range), series: [{ name: "Punch-in rate", values: monthRows.map((row) => row.rate) }], wide: true },
      { id: "late", type: "bar", title: "Late first punches", format: "number", categories: labels(ctx.range), series: [{ name: "Late days", values: monthRows.map((row) => row.late) }] },
      ...(shifts && rosteredTotal ? [{ id: "shifts", type: "bar" as const, horizontal: true, title: "Rostered shifts vs attended", subtitle: "by shift template, up to today", format: "number" as const, categories: shiftNames,
        series: [{ name: "Rostered", values: shiftNames.map((name) => sum(rostered.filter((row) => row.shift === name).map((row) => row.assignments))) }, { name: "Attended", values: shiftNames.map((name) => sum(rostered.filter((row) => row.shift === name).map((row) => row.attended))) }] }] : []),
      { id: "regs", type: "bar", stacked: true, title: "Regularizations by outcome", format: "number", categories: labels(ctx.range), series: statuses.map((status) => ({ name: status.replace("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()), values: byMonth(ctx.range, regs, (own) => sum(own.filter((row) => row.status === status).map((row) => row.requests))) })) },
    ],
    table: {
      title: "Attendance by department",
      columns: [{ key: "department", label: "Department", format: "text" }, { key: "expected", label: "Expected days", format: "number" }, { key: "leave", label: "Leave days", format: "decimal" },
        { key: "punched", label: "Days punched", format: "number" }, { key: "rate", label: "Punch-in rate", format: "percent" }, { key: "late", label: "Late days", format: "number" }, { key: "lateShare", label: "Late share", format: "percent" }],
      rows: departments,
    },
    footnotes: [
      "Expected days = Monday–Saturday while employed and since the first punch recorded in the organisation, minus approved leave on those days. Public holidays are not yet excluded.",
      roster ? "Late = first punch-in more than 10 minutes after the rostered shift start (09:30 when no shift is rostered)." : "Late = first punch-in after 09:40 (09:30 start + 10 min grace); shift rosters will refine this once published.",
      "Times are in India Standard Time.",
      ...(shifts ? ["Rostered shift attended = a punch-in on the rostered day (published or draft roster)."] : ["Shift adherence appears once shifts are rostered."]),
    ],
  };
}

async function serviceDesk(ctx: Ctx): Promise<ReportBody> {
  const [rows, monthly, categories] = await Promise.all([m.serviceDesk(ctx), m.serviceDeskMonthly(ctx), m.helpdeskCategories(ctx)]);
  const label = (key: string) => caseModuleMap.get(key)?.label || key;
  const created = sum(rows.map((row) => row.created)), closed = sum(rows.map((row) => row.closed));
  const open = sum(rows.map((row) => row.open_now)), overdue = sum(rows.map((row) => row.overdue));
  const help = rows.find((row) => row.module === "helpdesk");
  const weightedMedian = closed ? sum(rows.map((row) => num(row.median_hours) * row.closed)) / closed : null;
  const modules = rows.map((row) => row.module as string);
  return {
    available: true,
    kpis: [
      kpi("created", "Requests raised", created, "number", { spark: byMonth(ctx.range, monthly, (own) => sum(own.map((row) => row.created))) }),
      kpi("closed", "Requests closed", closed, "number"),
      kpi("median", "Typical time to close", round(weightedMedian, 1), "hours", { goodWhen: "down", note: "closed-weighted median across modules" }),
      kpi("sla", "Helpdesk SLA met", help ? pct(help.sla_met, help.sla_eligible) : null, "percent", { goodWhen: "up", note: help ? `${help.sla_met} of ${help.sla_eligible} closed tickets` : "no helpdesk tickets" }),
      kpi("backlog", "Open backlog", open, "number", { goodWhen: "down", note: `${overdue} past due` }),
    ],
    charts: [
      { id: "volume", type: "bar", title: "Raised vs closed by module", format: "number", categories: modules.map(label), series: [{ name: "Raised", values: rows.map((row) => row.created) }, { name: "Closed", values: rows.map((row) => row.closed) }], wide: true },
      { id: "ageing", type: "bar", stacked: true, horizontal: true, title: "Open backlog ageing", format: "number", categories: modules.map(label), series: [
        { name: "< 2 days", values: rows.map((row) => row.age_0_2) }, { name: "2–7 days", values: rows.map((row) => row.age_2_7) },
        { name: "7–30 days", values: rows.map((row) => row.age_7_30) }, { name: "30+ days", values: rows.map((row) => row.age_30) }] },
      { id: "categories", type: "bar", horizontal: true, title: "Helpdesk tickets by category", format: "number", categories: categories.map((row) => row.category), series: [{ name: "Tickets", values: categories.map((row) => row.tickets) }] },
    ],
    table: {
      title: "Service performance by module",
      columns: [{ key: "module", label: "Module", format: "text" }, { key: "created", label: "Raised", format: "number" }, { key: "closed", label: "Closed", format: "number" },
        { key: "median", label: "Median to close (h)", format: "hours" }, { key: "p90", label: "90th pct (h)", format: "hours" }, { key: "sla", label: "SLA met", format: "percent" },
        { key: "open", label: "Open now", format: "number" }, { key: "overdue", label: "Past due", format: "number" }, { key: "oldest", label: "Oldest open (days)", format: "decimal" }],
      rows: rows.map((row) => ({ module: label(row.module), created: row.created, closed: row.closed, median: round(row.median_hours, 1), p90: round(row.p90_hours, 1),
        sla: row.sla_eligible ? pct(row.sla_met, row.sla_eligible) : null, open: row.open_now, overdue: row.overdue, oldest: round(row.oldest_days, 1) })),
    },
    footnotes: ["Time to close runs from submission to the terminal state (approval, resolution, payment…).", "SLA applies to helpdesk tickets only: 4/24/48/72 h by priority.", "Recognition posts are excluded."],
  };
}

async function expenseSpend(ctx: Ctx): Promise<ReportBody> {
  const [rows, prev] = await Promise.all([m.expenses(ctx), m.expenses(ctx, previousRange(ctx.range))]);
  const total = sum(rows.map((row) => row.amount)), claims = sum(rows.map((row) => row.claims));
  const categories = [...new Set(rows.map((row) => row.category))].sort((a, b) => sum(rows.filter((r) => r.category === b).map((r) => r.amount)) - sum(rows.filter((r) => r.category === a).map((r) => r.amount)));
  const departments = [...new Set(rows.map((row) => row.department))];
  const paidClaims = sum(rows.map((row) => row.paid_claims));
  const monthlyTotal = byMonth(ctx.range, rows, (own) => round(sum(own.map((row) => row.amount)), 0));
  return {
    available: true,
    kpis: [
      withDelta(kpi("spend", "Claimed spend", round(total, 0), "money", { goodWhen: "down", spark: monthlyTotal }), round(sum(prev.map((row) => row.amount)), 0)),
      withDelta(kpi("claims", "Claims", claims, "number", { goodWhen: "neutral" }), sum(prev.map((row) => row.claims))),
      kpi("avg", "Average claim", claims ? round(total / claims, 0) : null, "money"),
      kpi("flagged", "Over policy limit", pct(sum(rows.map((row) => row.flagged)), claims), "percent", { goodWhen: "down", note: `${sum(rows.map((row) => row.flagged))} claims flagged` }),
      kpi("cycle", "Days to reimburse", paidClaims ? round(sum(rows.map((row) => num(row.pay_days_total))) / paidClaims, 1) : null, "days", { goodWhen: "down", note: `outstanding ₹${Math.round(sum(rows.map((row) => row.outstanding))).toLocaleString("en-IN")}` }),
    ],
    charts: [
      { id: "monthly", type: "bar", stacked: true, title: "Spend by month and category", format: "money", categories: labels(ctx.range), series: categories.map((category) => ({ name: category, values: byMonth(ctx.range, rows.filter((row) => row.category === category), (own) => round(sum(own.map((row) => row.amount)), 0)) })), wide: true },
      { id: "mix", type: "donut", title: "Category mix", format: "money", slices: categories.map((category) => ({ label: category, value: round(sum(rows.filter((row) => row.category === category).map((row) => row.amount)), 0) || 0 })) },
      { id: "departments", type: "bar", horizontal: true, title: "Spend by department", format: "money", categories: departments, series: [{ name: "Spend", values: departments.map((department) => round(sum(rows.filter((row) => row.department === department).map((row) => row.amount)), 0)) }] },
    ],
    table: {
      title: "Spend by category",
      columns: [{ key: "category", label: "Category", format: "text" }, { key: "claims", label: "Claims", format: "number" }, { key: "amount", label: "Amount", format: "money" },
        { key: "share", label: "Share", format: "percent" }, { key: "avg", label: "Avg claim", format: "money" }, { key: "flagged", label: "Over limit", format: "number" },
        { key: "paid", label: "Paid", format: "money" }, { key: "outstanding", label: "Outstanding", format: "money" }],
      rows: categories.map((category) => {
        const own = rows.filter((row) => row.category === category);
        const amount = sum(own.map((row) => row.amount)), count = sum(own.map((row) => row.claims));
        return { category, claims: count, amount: round(amount, 0), share: pct(amount, total), avg: count ? round(amount / count, 0) : null, flagged: sum(own.map((row) => row.flagged)), paid: round(sum(own.map((row) => row.paid)), 0), outstanding: round(sum(own.map((row) => row.outstanding)), 0) };
      }),
    },
    footnotes: ["Claims are dated by the expense date; rejected and withdrawn claims are excluded.", "Over policy limit = amount above the category limit when the claim was submitted."],
  };
}

async function recruitment(ctx: Ctx): Promise<ReportBody> {
  const [rows, reqs] = await Promise.all([m.candidates(ctx), m.openRequisitions(ctx)]);
  const steps = m.FUNNEL.map((stage, index) => ({ label: caseModuleMap.get("candidates")?.statuses.find((s) => s.key === stage)?.label || stage, value: rows.filter((row) => row.stage >= index + 1).length }));
  const hires = rows.filter((row) => row.status === "HIRED");
  const offersDecided = rows.filter((row) => row.stage >= 4 && ["HIRED", "WITHDRAWN", "REJECTED"].includes(row.status)).length;
  const sources = [...new Set(rows.map((row) => row.source))].map((source) => {
    const own = rows.filter((row) => row.source === source);
    return { source, candidates: own.length, interviewed: own.filter((row) => row.stage >= 3).length, offered: own.filter((row) => row.stage >= 4).length, hired: own.filter((row) => row.status === "HIRED").length, hireRate: pct(own.filter((row) => row.status === "HIRED").length, own.length) };
  }).sort((a, b) => b.candidates - a.candidates);
  const openings = sum(reqs.map((row) => row.openings));
  return {
    available: true,
    kpis: [
      kpi("candidates", "Candidates added", rows.length, "number", { spark: byMonth(ctx.range, rows, (own) => own.length) }),
      kpi("hires", "Hires", hires.length, "number", { goodWhen: "up" }),
      kpi("tth", "Median time to hire", round(median(hires.map((row) => num(row.days_open))), 1), "days", { goodWhen: "down", note: "application → hired" }),
      kpi("conversion", "Offer acceptance", pct(hires.length, offersDecided), "percent", { goodWhen: "up", note: `${offersDecided} offers decided` }),
      kpi("openings", "Open positions", openings, "number", { note: `${sum(reqs.map((row) => row.requisitions))} requisitions` }),
    ],
    charts: [
      { id: "funnel", type: "funnel", title: "Hiring funnel", subtitle: "furthest stage reached", format: "number", steps },
      { id: "sources", type: "donut", title: "Source mix", format: "number", slices: sources.map((row) => ({ label: row.source, value: row.candidates })) },
      { id: "monthly", type: "line", title: "Candidates added per month", format: "number", categories: labels(ctx.range), series: [{ name: "Candidates", values: byMonth(ctx.range, rows, (own) => own.length) }, { name: "Hired", values: byMonth(ctx.range, hires, (own) => own.length) }], wide: true },
    ],
    table: {
      title: "Source effectiveness",
      columns: [{ key: "source", label: "Source", format: "text" }, { key: "candidates", label: "Candidates", format: "number" }, { key: "interviewed", label: "Interviewed", format: "number" },
        { key: "offered", label: "Offered", format: "number" }, { key: "hired", label: "Hired", format: "number" }, { key: "hireRate", label: "Hire rate", format: "percent" }],
      rows: sources,
    },
    footnotes: ["Candidates are counted by the date they were added. Stage reached uses the case timeline, so rejected candidates still count at the stage they got to.",
      "Candidates are not yet linked to departments or locations: those filters apply to open positions only."],
  };
}

async function payroll(ctx: Ctx): Promise<ReportBody> {
  const [{ source, rows }, prev] = await Promise.all([m.payrollCost(ctx), m.payrollCost(ctx, previousRange(ctx.range))]);
  if (!rows.length && !prev.rows.length && source === "payslips")
    return { ...unavailable("No published payslips or finalised payroll runs fall in this period yet."), source };
  const gross = sum(rows.map((row) => row.gross)), net = sum(rows.map((row) => row.net));
  const employer = rows.some((row) => row.employer !== null) ? sum(rows.map((row) => row.employer)) : null;
  const periods = ctx.range.months;
  const perPeriod = periods.map((period) => rows.filter((row) => row.period === period));
  const monthlyGross = perPeriod.map((own) => (own.length ? round(sum(own.map((row) => row.gross)), 0) : null));
  const headcounts = perPeriod.map((own) => sum(own.map((row) => row.employees))).filter(Boolean);
  const departments = [...new Set(rows.map((row) => row.department))].map((department) => {
    const own = rows.filter((row) => row.department === department);
    const people = Math.max(...own.map((row) => row.employees));
    return { department, employees: people, gross: round(sum(own.map((row) => row.gross)), 0), net: round(sum(own.map((row) => row.net)), 0), employer: own.some((row) => row.employer !== null) ? round(sum(own.map((row) => row.employer)), 0) : null };
  }).sort((a, b) => num(b.gross) - num(a.gross));
  const safe = suppress(departments, "employees", ["gross", "net", "employer"], "department", (group) => ({
    department: "", employees: sum(group.map((row) => row.employees)), gross: sum(group.map((row) => row.gross)), net: sum(group.map((row) => row.net)),
    employer: group.some((row) => row.employer !== null) ? sum(group.map((row) => row.employer)) : null,
  }));
  const avgPaid = headcounts.length ? sum(headcounts) / headcounts.length : 0;
  return {
    available: true, source, suppressedGroups: safe.suppressedGroups,
    kpis: [
      withDelta(kpi("gross", "Gross pay", round(gross, 0), "money", { goodWhen: "neutral", spark: monthlyGross }), round(sum(prev.rows.map((row) => row.gross)), 0)),
      kpi("net", "Net pay", round(net, 0), "money"),
      kpi("employer", "Employer cost", employer === null ? null : round(employer, 0), "money", { note: employer === null ? "needs payroll engine runs" : "gross + employer contributions" }),
      kpi("perHead", "Avg gross per employee / month", avgPaid && headcounts.length ? round(gross / headcounts.length / avgPaid, 0) : null, "money"),
      kpi("paid", "Employees paid", Math.round(avgPaid), "number", { note: "average per period" }),
    ],
    charts: [
      { id: "trend", type: "line", title: "Pay cost by month", format: "money", categories: labels(ctx.range), series: [
        { name: "Gross", values: monthlyGross }, { name: "Net", values: perPeriod.map((own) => (own.length ? round(sum(own.map((row) => row.net)), 0) : null)) },
        ...(employer !== null ? [{ name: "Employer cost", values: perPeriod.map((own) => (own.length ? round(sum(own.map((row) => row.employer)), 0) : null)) }] : [])], wide: true },
      { id: "departments", type: "bar", horizontal: true, title: "Gross pay by department", format: "money", categories: safe.rows.map((row) => row.department), series: [{ name: "Gross", values: safe.rows.map((row) => row.gross) }] },
    ],
    table: {
      title: "Pay cost by department",
      columns: [{ key: "department", label: "Department", format: "text" }, { key: "employees", label: "Employees", format: "number" }, { key: "gross", label: "Gross", format: "money" },
        { key: "net", label: "Net", format: "money" }, { key: "employer", label: "Employer cost", format: "money" }],
      rows: safe.rows, note: SUPPRESSION_NOTE,
    },
    footnotes: [
      source === "payroll_engine" ? "Source: finalised payroll runs." : "Source: published payslips. Employer contributions (PF/ESI employer share) appear once payroll runs are finalised in the payroll engine.",
      SUPPRESSION_NOTE,
    ],
  };
}

async function learning(ctx: Ctx): Promise<ReportBody> {
  const [lms, requests] = await Promise.all([m.lmsLearning(ctx), m.trainingRequests(ctx)]);
  const reqTotal = sum(requests.map((row) => row.requests));
  const reqCharts: Chart[] = [{ id: "requests", type: "bar", horizontal: true, title: "Training requests by area", format: "number", categories: requests.map((row) => row.category), series: [{ name: "Requested", values: requests.map((row) => row.requests) }, { name: "Completed", values: requests.map((row) => row.completed) }] }];
  if (!lms) {
    return {
      available: true,
      kpis: [
        kpi("requests", "Training requests", reqTotal, "number"),
        kpi("approved", "Approved", pct(sum(requests.map((row) => row.approved)), reqTotal), "percent"),
        kpi("completed", "Completed", sum(requests.map((row) => row.completed)), "number"),
        kpi("spend", "Approved fees", round(sum(requests.map((row) => row.spend)), 0), "money"),
      ],
      charts: reqCharts,
      table: { title: "Training requests", columns: [{ key: "category", label: "Area", format: "text" }, { key: "requests", label: "Requests", format: "number" }, { key: "approved", label: "Approved", format: "number" }, { key: "completed", label: "Completed", format: "number" }, { key: "spend", label: "Fees", format: "money" }], rows: requests },
      footnotes: ["Course completion analytics appear here once the learning platform is live."],
    };
  }
  const enrolled = sum(lms.categories.map((row) => row.enrolled)), completed = sum(lms.categories.map((row) => row.completed));
  const mandatory = sum(lms.categories.map((row) => row.mandatory)), mandatoryDone = sum(lms.categories.map((row) => row.mandatory_completed));
  const monthly = byMonth(ctx.range, lms.monthly, (own) => sum(own.map((row) => row.completions)));
  return {
    available: true,
    kpis: [
      kpi("completion", "Completion rate", pct(completed, enrolled), "percent", { goodWhen: "up", note: `${completed} of ${enrolled} enrolments` }),
      kpi("completions", "Completions", sum(monthly), "number", { spark: monthly }),
      kpi("mandatory", "Mandatory complete", pct(mandatoryDone, mandatory), "percent", { goodWhen: "up", note: `${mandatory} mandatory enrolments` }),
      kpi("overdue", "Overdue", sum(lms.categories.map((row) => row.overdue)), "number", { goodWhen: "down", note: "past due date, not completed" }),
      kpi("requests", "Training requests", reqTotal, "number", { note: "external programmes" }),
    ],
    charts: [
      { id: "categories", type: "bar", horizontal: true, title: "Enrolments by category", format: "number", categories: lms.categories.map((row) => row.category), series: [{ name: "Enrolled", values: lms.categories.map((row) => row.enrolled) }, { name: "Completed", values: lms.categories.map((row) => row.completed) }] },
      { id: "monthly", type: "line", title: "Course completions by month", format: "number", categories: labels(ctx.range), series: [{ name: "Completions", values: monthly }] },
      ...reqCharts,
    ],
    table: {
      title: "Learning by category",
      columns: [{ key: "category", label: "Category", format: "text" }, { key: "enrolled", label: "Enrolled", format: "number" }, { key: "completed", label: "Completed", format: "number" },
        { key: "rate", label: "Completion", format: "percent" }, { key: "in_progress", label: "In progress", format: "number" }, { key: "overdue", label: "Overdue", format: "number" }, { key: "days", label: "Avg days to complete", format: "decimal" }],
      rows: lms.categories.map((row) => ({ category: row.category, enrolled: row.enrolled, completed: row.completed, rate: pct(row.completed, row.enrolled), in_progress: row.in_progress, overdue: row.overdue, days: round(row.days_to_complete, 1) })),
    },
    footnotes: ["Enrolments count if they were open at any point in the range.", "Training requests are external programmes requested through the Learning workflow."],
  };
}

const enpsOf = (promoters: number, detractors: number, responses: number) => (responses ? round(((promoters - detractors) / responses) * 100, 0) : null);
async function engagement(ctx: Ctx): Promise<ReportBody> {
  const rows = await m.enps(ctx);
  if (!rows) return unavailable("Engagement surveys are not available yet.");
  const minGroup = Math.max(MIN_GROUP, ...rows.map((row) => row.min_group_size || MIN_GROUP));
  const responses = sum(rows.map((row) => row.responses)), promoters = sum(rows.map((row) => row.promoters)), detractors = sum(rows.map((row) => row.detractors));
  const show = responses >= minGroup;
  const months = ctx.range.months.map((month) => { const own = rows.filter((row) => row.month === month); const n = sum(own.map((row) => row.responses)); return n >= minGroup ? enpsOf(sum(own.map((row) => row.promoters)), sum(own.map((row) => row.detractors)), n) : null; });
  const departments = [...new Set(rows.map((row) => row.department))].map((department) => {
    const own = rows.filter((row) => row.department === department); const n = sum(own.map((row) => row.responses));
    return { department, responses: n, enps: enpsOf(sum(own.map((row) => row.promoters)), sum(own.map((row) => row.detractors)), n) };
  });
  const safeDepts = departments.map((row) => (row.responses >= minGroup ? { ...row, suppressed: false } : { ...row, enps: null, suppressed: true }));
  const surveys = [...new Set(rows.map((row) => row.survey_id))].map((id) => {
    const own = rows.filter((row) => row.survey_id === id); const n = sum(own.map((row) => row.responses));
    return { survey: own[0].title, status: own[0].status, responses: n, enps: n >= minGroup ? enpsOf(sum(own.map((row) => row.promoters)), sum(own.map((row) => row.detractors)), n) : null, suppressed: n < minGroup };
  });
  return {
    available: true, suppressedGroups: safeDepts.filter((row) => row.suppressed).length,
    kpis: [
      kpi("enps", "eNPS", show ? enpsOf(promoters, detractors, responses) : null, "number", { goodWhen: "up", note: show ? "−100 to +100" : `hidden below ${minGroup} responses`, spark: months }),
      kpi("responses", "eNPS responses", responses, "number"),
      kpi("promoters", "Promoters (9–10)", show ? pct(promoters, responses) : null, "percent", { goodWhen: "up" }),
      kpi("detractors", "Detractors (0–6)", show ? pct(detractors, responses) : null, "percent", { goodWhen: "down" }),
    ],
    charts: [
      show ? { id: "mix", type: "donut", title: "Promoters, passives, detractors", format: "number", slices: [{ label: "Promoters", value: promoters }, { label: "Passives", value: responses - promoters - detractors }, { label: "Detractors", value: detractors }] }
        : { id: "mix", type: "empty", title: "Promoters, passives, detractors", format: "number", message: responses ? `Hidden until at least ${minGroup} people respond.` : "No eNPS responses in this period." },
      { id: "trend", type: "line", title: "eNPS by month", format: "number", categories: labels(ctx.range), series: [{ name: "eNPS", values: months }] },
      { id: "departments", type: "bar", horizontal: true, title: "eNPS by department", format: "number", categories: safeDepts.map((row) => row.department), series: [{ name: "eNPS", values: safeDepts.map((row) => row.enps) }] },
    ],
    table: { title: "Surveys with an eNPS question", columns: [{ key: "survey", label: "Survey", format: "text" }, { key: "status", label: "Status", format: "text" }, { key: "responses", label: "Responses", format: "number" }, { key: "enps", label: "eNPS", format: "number" }], rows: surveys, note: `Scores need at least ${minGroup} responses.` },
    footnotes: ["eNPS = % promoters (9–10) − % detractors (0–6) on “How likely are you to recommend working here?”.",
      ctx.scope.kind === "team" ? "Team view uses identified responses from your reporting line only; anonymous responses cannot be attributed to a manager." : "Department and location come from the respondent's record at the time of response.",
      `Results for any group with fewer than ${minGroup} responses are hidden.`],
  };
}

async function performance(ctx: Ctx): Promise<ReportBody> {
  const rows = await m.goals(ctx);
  const attainment = (list: typeof rows) => { const w = sum(list.map((row) => row.weight)); return w ? round((sum(list.map((row) => row.weighted)) / w) * 100, 1) : null; };
  const approved = rows.filter((row) => row.status === "APPROVED");
  const departments = [...new Set(rows.map((row) => row.department))].map((department) => {
    const own = rows.filter((row) => row.department === department);
    const ownApproved = own.filter((row) => row.status === "APPROVED");
    return { department, people: sum(own.map((row) => row.people)), goals: sum(own.map((row) => row.goals)), approved: sum(ownApproved.map((row) => row.goals)), attainment: attainment(ownApproved) };
  });
  const safe = suppress(departments, "people", ["attainment"], "department");
  const statuses = [...new Set(rows.map((row) => row.status))];
  const periods = [...new Set(rows.map((row) => row.period))].sort();
  return {
    available: true, suppressedGroups: safe.suppressedGroups,
    kpis: [
      kpi("goals", "Goals set", sum(rows.map((row) => row.goals)), "number"),
      kpi("approved", "Approved", pct(sum(approved.map((row) => row.goals)), sum(rows.map((row) => row.goals))), "percent"),
      kpi("attainment", "Weighted attainment", sum(approved.map((row) => row.people)) >= MIN_GROUP ? attainment(approved) : null, "percent", { goodWhen: "up", note: "approved goals, capped at 150%" }),
      kpi("periods", "Review periods", periods.length, "number", { note: periods.join(", ") || "none in range" }),
    ],
    charts: [
      { id: "departments", type: "bar", horizontal: true, title: "Attainment by department", format: "percent", categories: safe.rows.map((row) => row.department), series: [{ name: "Attainment", values: safe.rows.map((row) => row.attainment) }] },
      { id: "status", type: "donut", title: "Goal status", format: "number", slices: statuses.map((status) => ({ label: status.replace("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()), value: sum(rows.filter((row) => row.status === status).map((row) => row.goals)) })) },
    ],
    table: { title: "Goals by department", columns: [{ key: "department", label: "Department", format: "text" }, { key: "goals", label: "Goals", format: "number" }, { key: "approved", label: "Approved", format: "number" }, { key: "attainment", label: "Attainment", format: "percent" }], rows: safe.rows, note: SUPPRESSION_NOTE },
    footnotes: ["Goals are included when their review period (quarter, month or year) starts inside the range.", SUPPRESSION_NOTE],
  };
}

const OWNER_LABEL: Record<string, string> = { HR: "HR", IT: "IT", MANAGER: "Manager", BUDDY: "Buddy", JOINER: "Joiner", FINANCE: "Finance" };
const JOINER_STATUS: Record<string, string> = { PRE_BOARDING: "Pre-boarding", READY_TO_JOIN: "Ready to join", JOINED: "Joined", COMPLETED: "Completed", WITHDRAWN: "Withdrawn" };
async function onboardingReport(ctx: Ctx): Promise<ReportBody> {
  const data = await m.onboarding(ctx);
  if (!data) return unavailable("Onboarding is not available yet.");
  const { joiners, tasks } = data;
  const total = sum(joiners.map((row) => row.joiners));
  const withdrawn = sum(joiners.filter((row) => row.status === "WITHDRAWN").map((row) => row.joiners));
  const completed = joiners.filter((row) => row.status === "COMPLETED");
  const completedCount = sum(completed.map((row) => row.joiners));
  const taskTotal = sum(tasks.map((row) => row.tasks)), done = sum(tasks.map((row) => row.done + row.skipped));
  const overdue = sum(tasks.map((row) => row.overdue)), onTime = sum(tasks.map((row) => row.on_time));
  const owners = [...new Set(tasks.map((row) => row.owner_type))];
  const statuses = Object.keys(JOINER_STATUS).filter((status) => joiners.some((row) => row.status === status));
  return {
    available: true,
    kpis: [
      kpi("joiners", "Joiners", total, "number", { spark: byMonth(ctx.range, joiners, (own) => sum(own.map((row) => row.joiners))), note: "in period + live pipeline" }),
      kpi("tasks", "Tasks complete", pct(done, taskTotal), "percent", { goodWhen: "up", note: `${done} of ${taskTotal}` }),
      kpi("ontime", "Done on time", pct(onTime, sum(tasks.map((row) => row.done))), "percent", { goodWhen: "up" }),
      kpi("overdue", "Overdue tasks", overdue, "number", { goodWhen: "down" }),
      kpi("dropout", "Withdrew before joining", total >= MIN_GROUP ? pct(withdrawn, total) : null, "percent", { goodWhen: "down", note: total >= MIN_GROUP ? `${withdrawn} of ${total}` : "hidden below 3 joiners" }),
      kpi("days", "Days to complete", completedCount ? round(sum(completed.map((row) => num(row.days_to_complete) * row.joiners)) / completedCount, 1) : null, "days", { goodWhen: "down", note: "joining date → onboarding closed" }),
    ],
    charts: [
      { id: "pipeline", type: "funnel", title: "Joiner pipeline", subtitle: "current status of joiners in the period", format: "number", steps: statuses.map((status) => ({ label: JOINER_STATUS[status], value: sum(joiners.filter((row) => row.status === status).map((row) => row.joiners)) })) },
      { id: "owners", type: "bar", horizontal: true, stacked: true, title: "Task progress by owner", format: "number", categories: owners.map((owner) => OWNER_LABEL[owner] || owner), series: [
        { name: "Done", values: owners.map((owner) => sum(tasks.filter((row) => row.owner_type === owner).map((row) => row.done + row.skipped))) },
        { name: "Overdue", values: owners.map((owner) => sum(tasks.filter((row) => row.owner_type === owner).map((row) => row.overdue))) },
        { name: "Open, not due", values: owners.map((owner) => sum(tasks.filter((row) => row.owner_type === owner).map((row) => row.tasks - row.done - row.skipped - row.overdue))) }] },
      { id: "monthly", type: "bar", stacked: true, title: "Joiners by month", format: "number", categories: labels(ctx.range), wide: true,
        series: statuses.map((status) => ({ name: JOINER_STATUS[status], values: byMonth(ctx.range, joiners.filter((row) => row.status === status), (own) => sum(own.map((row) => row.joiners))) })) },
    ],
    table: {
      title: "Onboarding tasks by owner",
      columns: [{ key: "owner", label: "Owner", format: "text" }, { key: "tasks", label: "Tasks", format: "number" }, { key: "done", label: "Done / skipped", format: "number" },
        { key: "rate", label: "Complete", format: "percent" }, { key: "onTime", label: "On time", format: "percent" }, { key: "overdue", label: "Overdue", format: "number" }],
      rows: owners.map((owner) => {
        const own = tasks.filter((row) => row.owner_type === owner);
        const t = sum(own.map((row) => row.tasks)), d = sum(own.map((row) => row.done + row.skipped));
        return { owner: OWNER_LABEL[owner] || owner, tasks: t, done: d, rate: pct(d, t), onTime: pct(sum(own.map((row) => row.on_time)), sum(own.map((row) => row.done))), overdue: sum(own.map((row) => row.overdue)) };
      }),
    },
    footnotes: ["Joiners are counted by joining date; anyone still pre-boarding is included whatever their joining date. Withdrawn joiners are excluded from task metrics.", "On time = completed by the end of the due date.",
      ctx.scope.kind === "team" ? "Team view covers joiners whose manager is you or someone in your reporting line." : "Department and location come from the joiner record."],
  };
}

// ---- catalogue -------------------------------------------------------------------------------------
const d = (term: string, text: string) => ({ term, text });
const HEADCOUNT_DEF = d("Headcount", "Employees whose joining date is on or before the date and who have not passed their last working day.");
const ATTRITION_DEF = d("Attrition (annualised)", "Leavers ÷ average headcount (mean of month start and end), scaled to 12 months.");

export const REPORTS: (ReportMeta & { build: (ctx: Ctx) => Promise<ReportBody> })[] = [
  { slug: "headcount", title: "Headcount & movement", category: "Workforce", access: PEOPLE, build: headcount,
    summary: "Month-end headcount, joiners, leavers and net change, by department.",
    definitions: [HEADCOUNT_DEF, d("Joiner", "Joining date falls in the month."), d("Leaver", "Last working day (completed exit case) or deactivation falls in the month."), d("Average headcount", "Mean of opening and closing headcount across the months in range.")] },
  { slug: "attrition", title: "Attrition & exits", category: "Workforce", access: PEOPLE, build: attrition,
    summary: "Annualised attrition trend, department hot spots and why people leave.",
    definitions: [ATTRITION_DEF, d("Early attrition", "Leavers whose tenure at exit was under 6 months."), d("Exit reason", "Primary reason recorded on the resignation.")] },
  { slug: "tenure", title: "Tenure profile", category: "Workforce", access: PEOPLE, build: tenure,
    summary: "How long people have been with you, overall and by department.",
    definitions: [d("Tenure", "Months from joining date to the end of the selected range."), d("Tenure band", "Under 6 months, 6–12 months, 1–2 years, 2–5 years, 5+ years.")] },
  { slug: "span-of-control", title: "Span of control", category: "Workforce", access: PEOPLE, build: span,
    summary: "Direct reports per manager, total org size and management layers.",
    definitions: [d("Span of control", "Number of active direct reports of a manager."), d("Total org", "All active direct and indirect reports."), d("Layers below", "Longest reporting chain beneath the manager.")] },
  { slug: "workforce-composition", title: "Workforce composition", category: "Workforce", access: PEOPLE, build: composition,
    summary: "Where people work and in which roles; gender only where it is actually recorded.",
    definitions: [HEADCOUNT_DEF, d("Unassigned", "The employee record has no department or location."), d("Gender", "Only shown when captured on the employee record — never inferred.")] },
  { slug: "leave-utilisation", title: "Leave utilisation", category: "Time & leave", access: PEOPLE, build: leaveUtilisation,
    summary: "Days taken by leave type against entitlement, and pending approvals.",
    definitions: [d("Leave days taken", "Approved leave days inside the range (pro-rated for requests crossing its edges)."), d("Utilisation", "Days taken ÷ (annual quota × average headcount × years in range)."), d("Notice", "Days between applying and the first day of planned leave.")] },
  { slug: "unplanned-leave", title: "Unplanned leave patterns", category: "Time & leave", access: PEOPLE, build: unplannedLeave,
    summary: "Sick and same-day leave by weekday and month — spot Monday/Friday clustering.",
    definitions: [d("Unplanned leave", "Sick leave, or leave applied for on or after its first day."), d("Mon/Fri share", "Unplanned days falling on Monday or Friday; about 40% is an even spread across five weekdays.")] },
  { slug: "attendance", title: "Attendance & punctuality", category: "Time & leave", access: PEOPLE, build: attendance,
    summary: "Punch-in rate, late first punches and regularization volume.",
    definitions: [d("Punch-in rate", "Days with at least one punch-in ÷ expected working days."), d("Expected working days", "Monday–Saturday while employed, minus approved leave."), d("Late first punch", "First punch-in of the day after the shift start plus 10 minutes grace."), d("Regularization", "A request to correct a missed or wrong punch.")] },
  { slug: "service-desk", title: "Service desk performance", category: "Service delivery", access: HR_ONLY, build: serviceDesk,
    summary: "Volume, time to close, SLA attainment and backlog ageing for every request module.",
    definitions: [d("Time to close", "Hours from submission to a terminal state."), d("SLA met", "Helpdesk tickets closed before their priority-based due time."), d("Backlog ageing", "Open requests grouped by how long ago they were raised.")] },
  { slug: "expenses", title: "Expense spend", category: "Cost", access: { manager: true, finance: true }, build: expenseSpend,
    summary: "Claimed spend by category, month and department, with policy exceptions and reimbursement speed.",
    definitions: [d("Claimed spend", "Amount on submitted, approved and paid claims (excludes rejected/withdrawn)."), d("Over policy limit", "Claim amount exceeded the category limit."), d("Days to reimburse", "Average days from submission to payment for paid claims.")] },
  { slug: "recruitment", title: "Recruitment funnel", category: "Talent", access: HR_ONLY, build: recruitment,
    summary: "Candidates by stage, time to hire, source effectiveness and open positions.",
    definitions: [d("Stage reached", "Furthest of New → Screening → Interview → Offer → Hired a candidate reached."), d("Time to hire", "Days from the candidate being added to being marked hired."), d("Offer acceptance", "Hires ÷ offers that reached a final outcome.")] },
  { slug: "payroll-cost", title: "Payroll cost", category: "Cost", access: { manager: false, finance: true }, build: payroll,
    summary: "Gross, net and employer cost by month and department.",
    definitions: [d("Gross pay", "Total earnings before deductions."), d("Net pay", "Gross minus employee deductions."), d("Employer cost", "Gross plus employer statutory contributions, from finalised payroll runs.")] },
  { slug: "learning", title: "Learning & development", category: "Talent", access: PEOPLE, build: learning,
    summary: "Course completion, mandatory compliance and training requests.",
    definitions: [d("Completion rate", "Completed enrolments ÷ enrolments open during the range."), d("Mandatory complete", "Share of mandatory course enrolments completed."), d("Overdue", "Enrolments past their due date and not completed.")] },
  { slug: "onboarding", title: "Onboarding effectiveness", category: "Talent", access: PEOPLE, build: onboardingReport, requires: ["onboarding_joiners"],
    summary: "Joiner pipeline, task completion by owner, overdue actions and pre-joining drop-out.",
    definitions: [d("Joiner", "A person with an onboarding record whose joining date falls in the range."), d("Tasks complete", "Done or skipped tasks ÷ all tasks for non-withdrawn joiners."), d("Drop-out", "Joiners who withdrew before joining ÷ all joiners in the period."), d("Days to complete", "Days from joining date to onboarding being closed.")] },
  { slug: "engagement", title: "Engagement & eNPS", category: "Engagement", access: PEOPLE, build: engagement, requires: ["surveys"],
    summary: "Employee Net Promoter Score trend and department comparison.",
    definitions: [d("eNPS", "% promoters (9–10) minus % detractors (0–6); ranges from −100 to +100."), d("Minimum group", "Results are hidden for groups below the survey's minimum size (at least 3).")] },
  { slug: "performance-goals", title: "Goal attainment", category: "Talent", access: PEOPLE, build: performance,
    summary: "Goals set and approved, and weighted attainment by department.",
    definitions: [d("Attainment", "Actual ÷ target for each goal, capped at 150%, weighted by goal weight."), d("Approved", "Goals whose achievement the manager has approved.")] },
];

export const reportMap = new Map(REPORTS.map((report) => [report.slug, report]));

import { ForbiddenException, Injectable, Logger, NotFoundException, HttpException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { caseModuleMap } from "../cases/case-modules";
import {
  Ctx, MIN_GROUP, cacheKey, cached, change, isHr, monthLabel, num, parseRange, pct, previousRange, resolveScope, round, sum,
  type Filters, type Range, type Scope,
} from "./analytics.context";
import type { AnalyticsQuery } from "./analytics.dto";
import * as m from "./analytics.metrics";
import { REPORTS, kpi, movementSummary, reportMap } from "./analytics.reports";
import type { Chart, Kpi, ReportResult } from "./analytics.types";

const PEOPLE = { manager: true, finance: false };
const FINANCE = { manager: false, finance: true };
const SPEND = { manager: true, finance: true };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type Insight = { tone: "positive" | "negative" | "warning" | "neutral"; title: string; detail: string; slug: string; weight: number };
type Tile = Kpi & { slug: string };

const longMonth = (month: string) => new Intl.DateTimeFormat("en-IN", { month: "long", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
export function compactMoney(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1e7) return `₹${(value / 1e7).toFixed(abs >= 1e8 ? 0 : 1)}Cr`;
  if (abs >= 1e5) return `₹${(value / 1e5).toFixed(abs >= 1e6 ? 0 : 1)}L`;
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
}
const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger("Analytics");
  constructor(private readonly database: DatabaseService) {}

  private filters(query: AnalyticsQuery): Filters {
    return { from: query.from, to: query.to, department: query.department?.trim() || undefined, location: query.location?.trim() || undefined };
  }
  private requireAny(identity: AuthIdentity) {
    const people = resolveScope(identity, PEOPLE), finance = resolveScope(identity, FINANCE);
    if (!people && !finance) throw new ForbiddenException("People analytics are available to HR, people managers and payroll administrators.");
    return { people, finance, hr: isHr(identity) };
  }

  // ---- catalogue ---------------------------------------------------------------------------------
  catalogue(identity: AuthIdentity) {
    this.requireAny(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const present = new Set<string>();
      for (const report of REPORTS) for (const table of report.requires || [])
        if ((await client.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`])).rows[0].ok) present.add(table);
      const items = REPORTS.map((report) => {
        const scope = resolveScope(identity, report.access);
        if (!scope) return null;
        const { build: _build, access: _access, ...meta } = report;
        return { ...meta, scope: scope.label, ready: (report.requires || []).every((table) => present.has(table)) };
      }).filter(Boolean);
      return { items };
    });
  }

  /** Departments and locations the viewer may filter by (only values inside their scope). employees_department_directory. */
  filterOptions(identity: AuthIdentity) {
    const { people, finance } = this.requireAny(identity);
    const scope = (people?.kind === "org" ? people : finance?.kind === "org" ? finance : people)!;
    return this.database.tenantTransaction(identity, async (client) => {
      const range = parseRange({});
      const ctx = new Ctx(client, identity, scope, range, {});
      const rows = await ctx.pop(`
        SELECT 'department' AS kind, p.department AS value, count(*) FILTER (WHERE p.exit_date IS NULL)::int AS people FROM pop p GROUP BY 1,2
        UNION ALL
        SELECT 'location', p.location, count(*) FILTER (WHERE p.exit_date IS NULL)::int FROM pop p GROUP BY 1,2
        ORDER BY 1, 3 DESC, 2`);
      const earliest = (await client.query(`SELECT to_char(min(joining_date),'YYYY-MM') AS month FROM employees WHERE organization_id=$1`, [identity.organizationId])).rows[0]?.month;
      return {
        departments: rows.filter((row) => row.kind === "department").map((row) => ({ value: row.value, people: row.people })),
        locations: rows.filter((row) => row.kind === "location").map((row) => ({ value: row.value, people: row.people })),
        defaultRange: { from: range.fromMonth, to: range.toMonth }, currentMonth: range.toMonth, earliestMonth: earliest || range.fromMonth,
        scope: { kind: scope.kind, label: scope.label }, maxMonths: 24,
      };
    });
  }

  // ---- single report -------------------------------------------------------------------------------
  async report(identity: AuthIdentity, slug: string, query: AnalyticsQuery): Promise<ReportResult> {
    const report = reportMap.get(slug);
    if (!report) throw new NotFoundException("Report not found.");
    const scope = resolveScope(identity, report.access);
    if (!scope) throw new ForbiddenException("Your role cannot run this report.");
    const filters = this.filters(query);
    const range = parseRange(filters);
    const { value, generatedAt, cached: hit } = await cached(cacheKey(identity, scope, `report:${slug}`, filters), Boolean(query.refresh), () =>
      this.database.tenantTransaction(identity, async (client) => {
        const ctx = new Ctx(client, identity, scope, range, filters);
        try {
          return await report.build(ctx);
        } catch (error) {
          if (error instanceof HttpException) throw error;
          this.logger.error(`report ${slug} failed: ${(error as Error).message}`);
          return { available: false, unavailable: "This report could not be computed right now. The data it depends on may be changing — try again shortly.", kpis: [], charts: [], table: { title: "Details", columns: [], rows: [] }, footnotes: [] };
        }
      }));
    const { build: _build, access: _access, ...meta } = report;
    return {
      ...value, meta, scope: { kind: scope.kind, label: scope.label }, generatedAt, cached: hit,
      filters: { from: range.fromMonth, to: range.toMonth, department: filters.department || null, location: filters.location || null, partialLastMonth: range.partialLastMonth },
    };
  }

  /** CSV of the report's table with its definitions and footnotes; each export is audited. */
  async exportCsv(identity: AuthIdentity, slug: string, query: AnalyticsQuery) {
    const result = await this.report(identity, slug, query);
    const cell = (value: unknown) => {
      if (value === null || value === undefined) return "";
      let text = String(value);
      if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`; // spreadsheet formula injection
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines: string[] = [];
    const { columns, rows } = result.table;
    lines.push(columns.map((column) => cell(column.label)).join(","));
    for (const row of rows) lines.push(columns.map((column) => cell(row.suppressed && row[column.key] === null && column.format !== "text" ? "suppressed" : row[column.key])).join(","));
    lines.push("", cell(`${result.meta.title} — ${result.table.title}`),
      cell(`Period: ${result.filters.from} to ${result.filters.to}${result.filters.department ? ` · Department: ${result.filters.department}` : ""}${result.filters.location ? ` · Location: ${result.filters.location}` : ""}`),
      cell(`Scope: ${result.scope.label}`), cell(`Generated: ${result.generatedAt}`));
    for (const definition of result.meta.definitions) lines.push(cell(`${definition.term}: ${definition.text}`));
    for (const note of result.footnotes) lines.push(cell(note));
    await this.database.tenantTransaction(identity, (client) => client.query(
      `INSERT INTO audit_log(organization_id, actor_user_id, action, entity_type, entity_id, after_data) VALUES($1,$2,'analytics.export','analytics_report',$1,$3)`,
      [identity.organizationId, identity.userId, JSON.stringify({ slug, filters: result.filters, rows: rows.length })]));
    const name = `${slug}_${result.filters.from}_${result.filters.to}.csv`;
    return { name, bytes: Buffer.from(`﻿${lines.join("\r\n")}\r\n`, "utf8") };
  }

  // ---- executive overview --------------------------------------------------------------------------
  async overview(identity: AuthIdentity, query: AnalyticsQuery) {
    const { people, finance, hr } = this.requireAny(identity);
    const spend = resolveScope(identity, SPEND);
    const filters = this.filters(query);
    const range = parseRange(filters);
    const prev = previousRange(range);
    const keyScope: Scope = people || finance!;
    const { value, generatedAt, cached: hit } = await cached(cacheKey(identity, { ...keyScope, roles: identity.roles }, "overview", filters), Boolean(query.refresh), () =>
      this.database.tenantTransaction(identity, (client) => this.buildOverview(client, identity, { people, finance, spend, hr }, range, prev, filters)));
    return {
      ...value, generatedAt, cached: hit,
      scope: { kind: keyScope.kind, label: keyScope.label },
      audience: { people: Boolean(people), finance: Boolean(finance), hr },
      filters: { from: range.fromMonth, to: range.toMonth, department: filters.department || null, location: filters.location || null, partialLastMonth: range.partialLastMonth, previous: { from: prev.fromMonth, to: prev.toMonth } },
    };
  }

  /** Run one overview block inside a savepoint so a failing area degrades to "not available" instead of failing the page. */
  private async block<T>(client: PoolClient, name: string, work: () => Promise<T>): Promise<T | null> {
    await client.query(`SAVEPOINT analytics_block`);
    try {
      const result = await work();
      await client.query(`RELEASE SAVEPOINT analytics_block`);
      return result;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT analytics_block`);
      this.logger.warn(`overview block ${name} unavailable: ${(error as Error).message}`);
      return null;
    }
  }

  private async buildOverview(client: PoolClient, identity: AuthIdentity, scopes: { people: Scope | null; finance: Scope | null; spend: Scope | null; hr: boolean }, range: Range, prev: Range, filters: Filters) {
    const tiles: Tile[] = [];
    const charts: Record<string, Chart | null> = {};
    const insights: Insight[] = [];
    const unavailable: string[] = [];
    const months = range.months.map(monthLabel);

    if (scopes.people) {
      const ctx = new Ctx(client, identity, scopes.people, range, filters);
      const workforce = await this.block(client, "workforce", async () => {
        const [rows, before, departments] = await Promise.all([m.workforceMonthly(ctx), m.workforceMonthly(ctx, prev), m.workforceBy(ctx, "department")]);
        return { rows, before, departments };
      });
      if (workforce) {
        const now = movementSummary(workforce.rows), was = movementSummary(workforce.before);
        const monthlyAttr = workforce.rows.map((row) => { const avg = (row.opening + row.headcount) / 2; return avg > 0 ? round((row.leavers / avg) * 1200, 1) : null; });
        tiles.push(
          { ...kpi("headcount", "Headcount", now.closing, "number", { goodWhen: "neutral", spark: workforce.rows.map((row) => row.headcount), previous: was.closing, delta: change(now.closing, was.closing), deltaUnit: "%", note: `${now.opening} at start of period` }), slug: "headcount" },
          { ...kpi("attrition", "Attrition, annualised", now.attrition, "percent", { goodWhen: "down", spark: monthlyAttr, previous: was.attrition, delta: now.attrition !== null && was.attrition !== null ? round(now.attrition - was.attrition, 1) : null, deltaUnit: "pts", note: plural(now.leavers, "leaver") }), slug: "attrition" },
          { ...kpi("joiners", "Joiners", now.joiners, "number", { goodWhen: "up", spark: workforce.rows.map((row) => row.joiners), previous: was.joiners, delta: change(now.joiners, was.joiners), deltaUnit: "%", note: `net ${now.closing - now.opening >= 0 ? "+" : ""}${now.closing - now.opening}` }), slug: "headcount" },
        );
        charts.departments = { id: "departments", type: "bar", horizontal: true, title: "Headcount by department", format: "number", categories: workforce.departments.filter((row) => row.headcount).map((row) => row.label), series: [{ name: "Headcount", values: workforce.departments.filter((row) => row.headcount).map((row) => row.headcount) }] };
        charts.movement = { id: "movement", type: "bar", title: "Joiners vs leavers", format: "number", categories: months, series: [{ name: "Joiners", values: workforce.rows.map((row) => row.joiners) }, { name: "Leavers", values: workforce.rows.map((row) => row.leavers) }] };
        charts.attrition = { id: "attrition", type: "line", title: "Attrition trend", subtitle: "monthly, annualised", format: "percent", categories: months, series: [{ name: "Attrition", values: monthlyAttr }] };
        charts.headcount = { id: "headcount", type: "line", title: "Month-end headcount", format: "number", categories: months, series: [{ name: "Headcount", values: workforce.rows.map((row) => row.headcount) }] };
        insights.push(...this.workforceInsights(now, was, workforce.departments, range));
      } else unavailable.push("Workforce");

      const leave = await this.block(client, "leave", async () => ({ now: await m.leaveByDay(ctx), before: await m.leaveByDay(ctx, prev) }));
      if (leave) {
        const share = (rows: typeof leave.now) => pct(sum(rows.map((row) => row.unplanned)), sum(rows.map((row) => row.days)));
        const s = share(leave.now), p = share(leave.before);
        tiles.push({ ...kpi("unplanned", "Unplanned leave share", s, "percent", { goodWhen: "down", spark: range.months.map((month) => share(leave.now.filter((row) => row.month === month))), previous: p, delta: s !== null && p !== null ? round(s - p, 1) : null, deltaUnit: "pts", note: `${round(sum(leave.now.map((row) => row.days)), 1)} leave days in total` }), slug: "unplanned-leave" });
        charts.leaveHeatmap = { id: "leaveHeatmap", type: "heatmap", title: "Leave by weekday", subtitle: "approved leave days", format: "days", rows: WEEKDAYS, cols: months, values: WEEKDAYS.map((_, index) => range.months.map((month) => round(sum(leave.now.filter((row) => row.month === month && row.dow === index + 1).map((row) => row.days)), 1))) };
        insights.push(...this.leaveInsights(leave.now));
      } else unavailable.push("Leave");

      const attendance = await this.block(client, "attendance", async () => ({ now: await m.attendanceMonthly(ctx), before: await m.attendanceMonthly(ctx, prev) }));
      if (attendance) {
        const rate = (rows: typeof attendance.now.rows) => pct(sum(rows.map((row) => row.punched)), sum(rows.map((row) => row.expected - row.leave_days)));
        const r = rate(attendance.now.rows), p = rate(attendance.before.rows);
        const late = sum(attendance.now.rows.map((row) => row.late)), punched = sum(attendance.now.rows.map((row) => row.punched));
        tiles.push({ ...kpi("punch", "Punch-in rate", r, "percent", { goodWhen: "up", spark: range.months.map((month) => rate(attendance.now.rows.filter((row) => row.month === month))), previous: p, delta: r !== null && p !== null ? round(r - p, 1) : null, deltaUnit: "pts", note: punched ? `${pct(late, punched)}% of punch days late` : "no punches recorded" }), slug: "attendance" });
        if (r !== null && sum(attendance.now.rows.map((row) => row.expected)) > 20 && r < 80)
          insights.push({ tone: "warning", weight: 70, slug: "attendance", title: `Only ${r}% of expected working days have a punch-in`, detail: `${plural(punched, "punch day")} against ${Math.round(sum(attendance.now.rows.map((row) => row.expected - row.leave_days)))} expected. Check whether teams are using mobile punch or need regularizations.` });
        if (punched >= 10 && late / punched > 0.15)
          insights.push({ tone: "warning", weight: 55, slug: "attendance", title: `${pct(late, punched)}% of punch-ins are late`, detail: `${plural(late, "late first punch", "late first punches")} in the period${attendance.now.roster ? " against rostered shift starts" : " against a 09:30 start"}.` });
      } else unavailable.push("Attendance");

      const onboard = await this.block(client, "onboarding", () => m.onboarding(ctx));
      if (onboard) {
        const upcoming = sum(onboard.joiners.filter((row) => ["PRE_BOARDING", "READY_TO_JOIN"].includes(row.status)).map((row) => row.joiners));
        const overdue = sum(onboard.tasks.map((row) => row.overdue));
        const taskTotal = sum(onboard.tasks.map((row) => row.tasks)), done = sum(onboard.tasks.map((row) => row.done + row.skipped));
        if (sum(onboard.joiners.map((row) => row.joiners))) tiles.push({ ...kpi("onboarding", "Onboarding tasks done", pct(done, taskTotal), "percent", { goodWhen: "up", note: `${upcoming} pre-boarding · ${overdue} overdue` }), slug: "onboarding" });
        if (overdue) insights.push({ tone: "warning", weight: 62, slug: "onboarding", title: `${plural(overdue, "onboarding task")} overdue`, detail: (() => { const owners = new Map<string, number>(); for (const row of onboard.tasks) owners.set(row.owner_type, (owners.get(row.owner_type) || 0) + row.overdue); const top = [...owners.entries()].sort((a, b) => b[1] - a[1])[0]; return `${top[0].charAt(0) + top[0].slice(1).toLowerCase()} owns ${top[1]} of them; ${upcoming} joiner${upcoming === 1 ? " is" : "s are"} still pre-boarding.`; })() });
      }

      const engagement = await this.block(client, "engagement", async () => ({ now: await m.enps(ctx), before: await m.enps(ctx, prev) }));
      if (engagement?.now) {
        const score = (rows: NonNullable<typeof engagement.now>) => { const n = sum(rows.map((row) => row.responses)); return n >= MIN_GROUP ? round(((sum(rows.map((row) => row.promoters)) - sum(rows.map((row) => row.detractors))) / n) * 100, 0) : null; };
        const s = score(engagement.now), p = engagement.before ? score(engagement.before) : null;
        tiles.push({ ...kpi("enps", "eNPS", s, "number", { goodWhen: "up", previous: p, delta: s !== null && p !== null ? s - p : null, deltaUnit: "pts", note: s === null ? `needs ${MIN_GROUP}+ responses` : `${sum(engagement.now.map((row) => row.responses))} responses` }), slug: "engagement" });
        if (s !== null) insights.push({ tone: s >= 20 ? "positive" : s < 0 ? "negative" : "neutral", weight: 45, slug: "engagement", title: `eNPS is ${s > 0 ? "+" : ""}${s}`, detail: p !== null ? `${s >= p ? "Up" : "Down"} ${Math.abs(s - p)} points on the previous period.` : `From ${sum(engagement.now.map((row) => row.responses))} responses this period.` });
      }
    }

    if (scopes.hr) {
      const ctx = new Ctx(client, identity, scopes.people!, range, filters);
      const desk = await this.block(client, "service", () => m.serviceDesk(ctx));
      if (desk) {
        const open = sum(desk.map((row) => row.open_now)), overdue = sum(desk.map((row) => row.overdue));
        const help = desk.find((row) => row.module === "helpdesk");
        const sla = help && help.sla_eligible ? pct(help.sla_met, help.sla_eligible) : null;
        tiles.push({ ...kpi("backlog", "Open requests", open, "number", { goodWhen: "down", note: `${overdue} past due${sla !== null ? ` · helpdesk SLA ${sla}%` : ""}` }), slug: "service-desk" });
        const oldest = [...desk].filter((row) => row.open_now).sort((a, b) => num(b.oldest_days) - num(a.oldest_days))[0];
        if (overdue) insights.push({ tone: "warning", weight: 80, slug: "service-desk", title: `${plural(overdue, "request")} past due`, detail: oldest ? `The oldest open item is a ${caseModuleMap.get(oldest.module)?.singular || oldest.module} raised ${Math.round(num(oldest.oldest_days))} days ago. ${open} requests are open in total.` : `${open} requests are open in total.` });
        if (sla !== null && help!.sla_eligible >= 3) insights.push({ tone: sla >= 90 ? "positive" : "warning", weight: 50, slug: "service-desk", title: `Helpdesk met SLA on ${sla}% of tickets`, detail: `${help!.sla_met} of ${help!.sla_eligible} tickets closed within their priority target; median resolution ${round(num(help!.median_hours), 1)} h.` });
        charts.backlog = { id: "backlog", type: "bar", stacked: true, horizontal: true, title: "Open backlog ageing", format: "number", categories: desk.filter((row) => row.open_now).map((row) => caseModuleMap.get(row.module)?.label || row.module), series: [
          { name: "< 2 days", values: desk.filter((row) => row.open_now).map((row) => row.age_0_2) }, { name: "2–7 days", values: desk.filter((row) => row.open_now).map((row) => row.age_2_7) },
          { name: "7–30 days", values: desk.filter((row) => row.open_now).map((row) => row.age_7_30) }, { name: "30+ days", values: desk.filter((row) => row.open_now).map((row) => row.age_30) }] };
      } else unavailable.push("Service desk");

      const hiring = await this.block(client, "recruitment", async () => ({ candidates: await m.candidates(ctx), reqs: await m.openRequisitions(ctx) }));
      if (hiring) {
        const openings = sum(hiring.reqs.map((row) => row.openings));
        const active = hiring.candidates.filter((row) => !["HIRED", "REJECTED", "WITHDRAWN"].includes(row.status)).length;
        tiles.push({ ...kpi("openings", "Open positions", openings, "number", { note: `${active} candidates in pipeline` }), slug: "recruitment" });
        charts.funnel = { id: "funnel", type: "funnel", title: "Hiring funnel", subtitle: "candidates added this period", format: "number", steps: m.FUNNEL.map((stage, index) => ({ label: caseModuleMap.get("candidates")?.statuses.find((s) => s.key === stage)?.label || stage, value: hiring.candidates.filter((row) => row.stage >= index + 1).length })) };
        if (openings) {
          const sources = new Map<string, number>();
          for (const row of hiring.candidates) sources.set(row.source, (sources.get(row.source) || 0) + 1);
          const top = [...sources.entries()].sort((a, b) => b[1] - a[1])[0];
          insights.push({ tone: active >= openings ? "neutral" : "warning", weight: 40, slug: "recruitment", title: `${plural(active, "active candidate")} for ${plural(openings, "open position")}`, detail: top ? `${top[0]} is the biggest source (${top[1]} of ${hiring.candidates.length} candidates added).` : "No candidates were added in this period." });
        }
      } else unavailable.push("Recruitment");
    }

    if (scopes.spend) {
      const ctx = new Ctx(client, identity, scopes.spend, range, filters);
      const exp = await this.block(client, "expenses", async () => ({ now: await m.expenses(ctx), before: await m.expenses(ctx, prev) }));
      if (exp) {
        const total = sum(exp.now.map((row) => row.amount)), before = sum(exp.before.map((row) => row.amount));
        tiles.push({ ...kpi("spend", "Expense spend", round(total, 0), "money", { goodWhen: "down", spark: range.months.map((month) => round(sum(exp.now.filter((row) => row.month === month).map((row) => row.amount)), 0)), previous: round(before, 0), delta: change(total, before), deltaUnit: "%", note: plural(sum(exp.now.map((row) => row.claims)), "claim") }), slug: "expenses" });
        const categories = [...new Set(exp.now.map((row) => row.category))];
        charts.expenseMix = { id: "expenseMix", type: "donut", title: "Expense mix", format: "money", slices: categories.map((category) => ({ label: category, value: round(sum(exp.now.filter((row) => row.category === category).map((row) => row.amount)), 0) || 0 })).sort((a, b) => b.value - a.value) };
        const insight = this.expenseInsight(exp.now, range);
        if (insight) insights.push(insight);
      } else unavailable.push("Expenses");
    }

    if (scopes.finance) {
      const ctx = new Ctx(client, identity, scopes.finance, range, filters);
      const pay = await this.block(client, "payroll", async () => ({ now: await m.payrollCost(ctx), before: await m.payrollCost(ctx, prev) }));
      if (pay) {
        const gross = sum(pay.now.rows.map((row) => row.gross)), before = sum(pay.before.rows.map((row) => row.gross));
        const monthly = range.months.map((month) => { const own = pay.now.rows.filter((row) => row.period === month); return own.length ? round(sum(own.map((row) => row.gross)), 0) : null; });
        tiles.push({ ...kpi("payroll", "Gross payroll", pay.now.rows.length ? round(gross, 0) : null, "money", { goodWhen: "neutral", spark: monthly, previous: pay.before.rows.length ? round(before, 0) : null, delta: pay.before.rows.length ? change(gross, before) : null, deltaUnit: "%", note: pay.now.rows.length ? `net ${compactMoney(sum(pay.now.rows.map((row) => row.net)))}` : "no published pay in period" }), slug: "payroll-cost" });
        charts.payroll = { id: "payroll", type: "line", title: "Payroll cost", format: "money", categories: months, series: [{ name: "Gross", values: monthly }, { name: "Net", values: range.months.map((month) => { const own = pay.now.rows.filter((row) => row.period === month); return own.length ? round(sum(own.map((row) => row.net)), 0) : null; }) }] };
        const periods = [...new Set(pay.now.rows.map((row) => row.period))].sort();
        if (periods.length >= 2) {
          const [a, b] = periods.slice(-2);
          const ga = sum(pay.now.rows.filter((row) => row.period === a).map((row) => row.gross)), gb = sum(pay.now.rows.filter((row) => row.period === b).map((row) => row.gross));
          const delta = change(gb, ga);
          if (delta !== null && Math.abs(delta) >= 2) insights.push({ tone: "neutral", weight: 48, slug: "payroll-cost", title: `Gross payroll ${delta > 0 ? "up" : "down"} ${Math.abs(delta)}% in ${longMonth(b)}`, detail: `${compactMoney(gb)} vs ${compactMoney(ga)} in ${longMonth(a)}.` });
        }
      } else unavailable.push("Payroll");
    }

    insights.sort((a, b) => b.weight - a.weight);
    return { tiles, charts, insights: insights.slice(0, 6).map(({ weight: _weight, ...insight }) => insight), unavailable };
  }

  // ---- insight generators --------------------------------------------------------------------------
  private workforceInsights(now: ReturnType<typeof movementSummary>, was: ReturnType<typeof movementSummary>, departments: m.DimensionRow[], range: Range): Insight[] {
    const out: Insight[] = [];
    const from = monthLabel(range.fromMonth), to = monthLabel(range.toMonth);
    if (now.opening && now.closing !== now.opening) {
      const delta = change(now.closing, now.opening)!;
      out.push({ tone: delta > 0 ? "positive" : "negative", weight: 60, slug: "headcount", title: `Headcount ${delta > 0 ? "grew" : "fell"} ${Math.abs(delta)}% to ${now.closing}`, detail: `${plural(now.joiners, "person", "people")} joined and ${now.leavers} left between ${from} and ${to}.` });
    } else if (now.joiners || now.leavers) {
      out.push({ tone: "neutral", weight: 30, slug: "headcount", title: `Headcount steady at ${now.closing}`, detail: `${now.joiners} joiners balanced ${now.leavers} leavers between ${from} and ${to}.` });
    }
    if (now.attrition !== null && now.leavers > 0) {
      const delta = was.attrition !== null ? round(now.attrition - was.attrition, 1)! : null;
      out.push({ tone: delta !== null && delta > 0 ? "negative" : "neutral", weight: 65, slug: "attrition", title: `Attrition is running at ${now.attrition}% a year`, detail: delta !== null && was.leavers ? `${delta > 0 ? "Up" : "Down"} ${Math.abs(delta)} pts on the previous ${range.months.length} months (${was.attrition}%).` : `${plural(now.leavers, "leaver")} against an average headcount of ${round(now.avgHeadcount, 1)}.` });
    }
    const hot = departments
      .map((row) => ({ ...row, size: Math.max(row.opening, row.headcount), rate: (row.opening + row.headcount) / 2 > 0 ? (row.leavers / ((row.opening + row.headcount) / 2)) * (12 / range.months.length) * 100 : 0 }))
      .filter((row) => row.size >= MIN_GROUP && row.leavers > 0).sort((a, b) => b.rate - a.rate)[0];
    if (hot && now.attrition !== null && hot.rate > now.attrition * 1.25)
      out.push({ tone: "warning", weight: 75, slug: "attrition", title: `${hot.label} attrition is ${round(hot.rate, 1)}%`, detail: `${plural(hot.leavers, "leaver")} — well above the ${now.attrition}% average for this view.` });
    const fresh = departments.filter((row) => row.headcount >= MIN_GROUP && row.avgTenureMonths !== null && row.avgTenureMonths < 9).sort((a, b) => num(a.avgTenureMonths) - num(b.avgTenureMonths))[0];
    if (fresh) out.push({ tone: "neutral", weight: 25, slug: "tenure", title: `${fresh.label} is your newest team`, detail: `Average tenure is ${fresh.avgTenureMonths} months across ${fresh.headcount} people — plan onboarding and buddy support.` });
    return out;
  }

  private leaveInsights(days: { month: string; dow: number; days: number; unplanned: number }[]): Insight[] {
    const out: Insight[] = [];
    const total = sum(days.map((row) => row.days)), unplanned = sum(days.map((row) => row.unplanned));
    if (unplanned >= 3) {
      const byDow = WEEKDAYS.map((_, index) => sum(days.filter((row) => row.dow === index + 1).map((row) => row.unplanned)));
      const monFri = pct(byDow[0] + byDow[4], unplanned)!;
      if (monFri >= 55) out.push({ tone: "warning", weight: 58, slug: "unplanned-leave", title: `${monFri}% of unplanned leave falls on Mondays and Fridays`, detail: `${round(byDow[0], 1)} Monday and ${round(byDow[4], 1)} Friday days out of ${round(unplanned, 1)} unplanned days — an even spread would be about 40%.` });
      else out.push({ tone: "neutral", weight: 35, slug: "unplanned-leave", title: `${pct(unplanned, total)}% of leave was unplanned`, detail: `${round(unplanned, 1)} of ${round(total, 1)} leave days were sick or same-day leave; peak weekday is ${WEEKDAYS[byDow.indexOf(Math.max(...byDow))]}.` });
    } else if (unplanned > 0) {
      out.push({ tone: "neutral", weight: 22, slug: "unplanned-leave", title: `${pct(unplanned, total)}% of leave was unplanned`, detail: `${round(unplanned, 1)} of ${round(total, 1)} leave days were sick or same-day leave — too few to read a weekday pattern yet.` });
    } else if (total > 0) {
      out.push({ tone: "positive", weight: 20, slug: "leave-utilisation", title: `${round(total, 1)} leave days taken, ${unplanned ? "almost all" : "all"} planned`, detail: unplanned ? `Only ${round(unplanned, 1)} unplanned days in the period.` : "No sick or same-day leave in the period." });
    }
    return out;
  }

  /** Compare the last month with data against the month before, naming the category that moved most. */
  private expenseInsight(rows: Awaited<ReturnType<typeof m.expenses>>, range: Range): Insight | null {
    if (range.months.length < 2) return null;
    const last = range.months[range.months.length - 1], before = range.months[range.months.length - 2];
    const total = (month: string) => sum(rows.filter((row) => row.month === month).map((row) => row.amount));
    const a = total(before), b = total(last);
    if (!a && !b) return null;
    const categories = [...new Set(rows.map((row) => row.category))].map((category) => ({
      category, delta: sum(rows.filter((row) => row.month === last && row.category === category).map((row) => row.amount)) - sum(rows.filter((row) => row.month === before && row.category === category).map((row) => row.amount)),
    })).sort((x, y) => (b >= a ? y.delta - x.delta : x.delta - y.delta));
    const driver = categories[0];
    const mtd = range.partialLastMonth ? " so far" : "";
    if (!a) return { tone: "neutral", weight: 52, slug: "expenses", title: `${compactMoney(b)} of expense claims in ${longMonth(last)}${mtd}`, detail: `No claims were dated ${longMonth(before)}.${driver ? ` Largest category: ${driver.category}.` : ""}` };
    const delta = change(b, a)!;
    if (Math.abs(delta) < 5) return { tone: "neutral", weight: 30, slug: "expenses", title: `Expense claims flat vs last month`, detail: `${compactMoney(b)} in ${longMonth(last)}${mtd} vs ${compactMoney(a)} in ${longMonth(before)}.` };
    return {
      tone: delta > 0 ? "warning" : "positive", weight: delta > 0 ? 68 : 42, slug: "expenses",
      title: `Expense claims ${delta > 0 ? "up" : "down"} ${Math.abs(delta)}% vs last month${driver && Math.abs(driver.delta) > 0 ? `, mostly ${driver.category}` : ""}`,
      detail: `${compactMoney(b)} in ${longMonth(last)}${mtd} vs ${compactMoney(a)} in ${longMonth(before)}${driver && Math.abs(driver.delta) > 0 ? `; ${driver.category} ${driver.delta > 0 ? "+" : "−"}${compactMoney(Math.abs(driver.delta))}` : ""}.`,
    };
  }
}

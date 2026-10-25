import type { Access, Format, Scope } from "./analytics.context";

export type Series = { name: string; values: (number | null)[] };
type ChartBase = { id: string; title: string; subtitle?: string; format: Format; note?: string; wide?: boolean };
export type Chart = ChartBase & (
  | { type: "line" | "bar"; categories: string[]; series: Series[]; stacked?: boolean; horizontal?: boolean }
  | { type: "donut"; slices: { label: string; value: number }[] }
  | { type: "funnel"; steps: { label: string; value: number }[] }
  | { type: "heatmap"; rows: string[]; cols: string[]; values: (number | null)[][] }
  | { type: "empty"; message: string }
);

export type Kpi = {
  key: string; label: string; value: number | null; format: Format; note?: string; text?: string;
  previous?: number | null; delta?: number | null; deltaUnit?: "%" | "pts"; goodWhen?: "up" | "down" | "neutral";
  spark?: (number | null)[];
};
export type Column = { key: string; label: string; format: Format | "month"; align?: "left" | "right" };
export type Table = { title: string; columns: Column[]; rows: Record<string, unknown>[]; note?: string };
export type Definition = { term: string; text: string };

export type ReportBody = {
  available: boolean; unavailable?: string;
  kpis: Kpi[]; charts: Chart[]; table: Table; footnotes: string[];
  suppressedGroups?: number; source?: string;
};

export type ReportMeta = {
  slug: string; title: string; category: "Workforce" | "Time & leave" | "Service delivery" | "Talent" | "Cost" | "Engagement";
  summary: string; access: Access; definitions: Definition[];
  /** Tables from parallel features this report reads; shown as "coming soon" until they exist. */
  requires?: string[];
};

export type ReportResult = ReportBody & {
  meta: Omit<ReportMeta, "access">;
  scope: Pick<Scope, "kind" | "label">;
  filters: { from: string; to: string; department: string | null; location: string | null; partialLastMonth: boolean };
  generatedAt: string; cached: boolean;
};

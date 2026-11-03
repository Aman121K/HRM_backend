// Pure performance rules: competencies, score maths, rating bands and increment guidance. Unit-tested, no database.

export type Competency = { key: string; label: string; description: string };
export type KeyResult = { title: string; target: number; current: number; unit: string };

export const DEFAULT_COMPETENCIES: Competency[] = [
  { key: "ownership", label: "Ownership", description: "Takes responsibility for outcomes and follows through without being chased." },
  { key: "customer", label: "Customer focus", description: "Puts the guest / customer experience first in decisions and service." },
  { key: "collaboration", label: "Collaboration", description: "Works well across shifts, stores and teams; shares knowledge." },
  { key: "quality", label: "Quality & standards", description: "Consistently meets recipe, hygiene, process and brand standards." },
  { key: "growth", label: "Learning & growth", description: "Seeks feedback, builds skills and adapts to change." },
];

export const RATING_LABELS: Record<number, string> = { 1: "Below expectations", 2: "Partially meets", 3: "Meets expectations", 4: "Exceeds expectations", 5: "Outstanding" };

/** Guideline merit increase per final rating (HR can override per person during calibration). */
export const INCREMENT_GUIDE: Record<number, number> = { 1: 0, 2: 3, 3: 7, 4: 10, 5: 15 };

/** Next status of a cycle and what each step means. */
export const CYCLE_FLOW: Record<string, { next: string | null; label: string }> = {
  DRAFT: { next: "GOAL_SETTING", label: "Draft" },
  GOAL_SETTING: { next: "REVIEW", label: "Goal setting" },
  REVIEW: { next: "CALIBRATION", label: "Reviews" },
  CALIBRATION: { next: "PUBLISHED", label: "Calibration" },
  PUBLISHED: { next: "CLOSED", label: "Published" },
  CLOSED: { next: null, label: "Closed" },
};

/** Progress of a goal from its key results (average of current/target, capped at 100%). */
export function goalProgress(keyResults: KeyResult[]) {
  const valid = keyResults.filter((kr) => kr.target > 0);
  if (!valid.length) return null;
  return Math.round(valid.reduce((t, kr) => t + Math.min(1, Math.max(0, kr.current / kr.target)), 0) / valid.length * 100);
}

export function validateGoals(goals: { weight: number }[]) {
  const errors: string[] = [];
  if (!goals.length) errors.push("Add at least one goal.");
  if (goals.length > 10) errors.push("Keep it to 10 goals or fewer.");
  const total = goals.reduce((t, g) => t + g.weight, 0);
  if (goals.length && total !== 100) errors.push(`Goal weights must add up to 100% (currently ${total}%).`);
  return errors;
}

/**
 * Overall score on 1–5: goal part = weight-averaged manager goal ratings; competency part = average of the manager's
 * competency ratings. Missing parts fall back to the other one. Returns null until the manager has rated something.
 */
export function computeScore(goalWeightPct: number, goals: { weight: number; rating: number | null }[], competencyRatings: number[]) {
  const rated = goals.filter((g) => g.rating);
  const weightSum = rated.reduce((t, g) => t + g.weight, 0);
  const goalScore = weightSum ? rated.reduce((t, g) => t + g.weight * (g.rating as number), 0) / weightSum : null;
  const comp = competencyRatings.filter((r) => r >= 1 && r <= 5);
  const compScore = comp.length ? comp.reduce((t, r) => t + r, 0) / comp.length : null;
  if (goalScore === null && compScore === null) return null;
  if (goalScore === null) return round2(compScore as number);
  if (compScore === null) return round2(goalScore);
  return round2((goalWeightPct * goalScore + (100 - goalWeightPct) * compScore) / 100);
}

/** Nearest half-point, which is what calibration works in. */
export const toRating = (score: number) => Math.min(5, Math.max(1, Math.round(score * 2) / 2));
export const band = (rating: number) => RATING_LABELS[Math.round(rating)] || "";
export const suggestedIncrement = (rating: number) => INCREMENT_GUIDE[Math.round(rating)] ?? 0;

/** Distribution of final ratings by whole band for the calibration view. */
export function distribution(ratings: number[]) {
  const buckets = [1, 2, 3, 4, 5].map((r) => ({ rating: r, label: RATING_LABELS[r], count: 0, pct: 0 }));
  for (const rating of ratings) buckets[Math.min(4, Math.max(0, Math.round(rating) - 1))].count += 1;
  for (const bucket of buckets) bucket.pct = ratings.length ? Math.round(bucket.count / ratings.length * 100) : 0;
  return buckets;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** First of the month on or after the date (salary revisions take effect from a month start). */
export function firstOfMonthOnOrAfter(date: string) {
  if (date.endsWith("-01")) return date;
  const [y, m] = date.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

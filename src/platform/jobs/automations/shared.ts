import type { TenantJobContext } from "../tenant-runner";

export type Person = { id: string; full_name: string; work_email: string | null };

/** Active HR admins / owners of the tenant who have an employee record (so they can receive in-app notifications). */
export async function hrAdmins(ctx: TenantJobContext): Promise<Person[]> {
  return (await ctx.client.query(
    `SELECT DISTINCT e.id, e.full_name, e.work_email
       FROM organization_memberships m
       JOIN employees e ON e.organization_id=m.organization_id AND e.user_id=m.user_id AND e.status='ACTIVE'
      WHERE m.organization_id=$1 AND m.status='ACTIVE' AND m.role IN ('HR_ADMIN','OWNER')
      ORDER BY e.full_name`, [ctx.organization.id])).rows as Person[];
}

export const firstName = (name: string) => name.split(/\s+/)[0] || name;
export const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

export function formatDay(value: string | Date) {
  const date = typeof value === "string" && value.length === 10 ? new Date(`${value}T00:00:00+05:30`) : new Date(value);
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(date);
}
export function formatDateTime(value: string | Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone }).format(new Date(value));
}
export function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** Removes duplicate people (e.g. an HR admin who is also the assignee). */
export function uniquePeople(people: (Person | null | undefined)[]) {
  const seen = new Map<string, Person>();
  for (const person of people) if (person && !seen.has(person.id)) seen.set(person.id, person);
  return [...seen.values()];
}

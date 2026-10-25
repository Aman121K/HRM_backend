// Reporting clocks for a personal data breach / cyber incident, computed from the time it was detected.
// Sources (checked 2026-10-20 — confirm with counsel before relying on them):
//   - DPDP Rules 2025, rule 7 (notified 13/14 Nov 2025; substantive rules in force 18 months later, ~13 May 2027):
//     inform affected Data Principals and the Data Protection Board "without delay"; a detailed report to the Board
//     within 72 hours of becoming aware (or longer if the Board allows).
//   - CERT-In Directions of 28 Apr 2022 under IT Act s.70B(6): report listed cyber incidents within 6 hours of noticing.
//   - As a Data Processor the platform must tell the client (Data Fiduciary) promptly; the DPA commits to 24 hours so the
//     client can meet its own clocks.
// "Without delay" has no fixed hour count; the register uses 24 h as an internal target and labels it as such.

export type BreachClock = { key: string; label: string; hours: number; field: string; basis: string; internalTarget?: boolean; when?: (row: BreachLike) => boolean };
export type BreachLike = { cert_in_reportable?: boolean; organization_id?: string | null };

export const BREACH_CLOCKS: BreachClock[] = [
  { key: "certIn", label: "CERT-In report", hours: 6, field: "cert_in_notified_at", basis: "CERT-In Directions 28.04.2022 — within 6 hours", when: (row) => row.cert_in_reportable !== false },
  { key: "fiduciaries", label: "Inform client company (Data Fiduciary)", hours: 24, field: "fiduciaries_notified_at", basis: "DPA clause 7 (processor → fiduciary)", internalTarget: true },
  { key: "board", label: "Intimation to Data Protection Board", hours: 24, field: "board_notified_at", basis: "DPDP Rules 2025 rule 7 — “without delay” (24 h internal target)", internalTarget: true },
  { key: "principals", label: "Inform affected employees", hours: 24, field: "principals_notified_at", basis: "DPDP Rules 2025 rule 7 — “without delay” (24 h internal target)", internalTarget: true },
  { key: "boardReport", label: "Detailed report to Board", hours: 72, field: "board_report_at", basis: "DPDP Rules 2025 rule 7 — within 72 hours" },
];

export type ClockState = { key: string; label: string; basis: string; dueAt: string; doneAt: string | null; state: "done" | "late" | "open"; msLeft: number; internalTarget: boolean };

export function breachClocks(row: BreachLike & Record<string, unknown>, detectedAt: Date, now = new Date()): ClockState[] {
  return BREACH_CLOCKS.filter((clock) => !clock.when || clock.when(row)).map((clock) => {
    const due = new Date(detectedAt.getTime() + clock.hours * 3_600_000);
    const doneRaw = row[clock.field] as string | Date | null | undefined;
    const done = doneRaw ? new Date(doneRaw) : null;
    const state = done ? "done" : due.getTime() < now.getTime() ? "late" : "open";
    return { key: clock.key, label: clock.label, basis: clock.basis, dueAt: due.toISOString(), doneAt: done ? done.toISOString() : null, state,
      msLeft: due.getTime() - now.getTime(), internalTarget: !!clock.internalTarget };
  });
}

/** Plain-language notice to affected employees (DPDP Rules 2025 rule 7: description, consequences, mitigation, safety steps, contact). */
export function principalNotice(input: {
  brand: string; reference: string; nature: string; detectedAt: string; categories: string[]; consequences?: string | null;
  mitigation?: string | null; containment?: string | null; contactName?: string | null; contactEmail?: string | null; contactPhone?: string | null;
}) {
  const when = new Date(input.detectedAt).toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Kolkata" });
  const contact = [input.contactName, input.contactEmail, input.contactPhone].filter(Boolean).join(" · ") || "[grievance officer name · email · phone]";
  const subject = `Important: a personal data incident affecting you (${input.reference})`;
  const body = [
    `Dear [Employee name],`,
    ``,
    `We are writing to tell you about a personal data breach at ${input.brand} that involves your information.`,
    ``,
    `What happened: ${input.nature} We became aware of it on ${when} (IST).`,
    `Which information: ${input.categories.length ? input.categories.join(", ") : "[categories of personal data]"}.`,
    `What this could mean for you: ${input.consequences || "[likely consequences, e.g. risk of phishing messages or misuse of your bank details]"}`,
    `What we have done: ${[input.containment, input.mitigation].filter(Boolean).join(" ") || "[containment and mitigation steps taken]"}`,
    `What you can do: be cautious of unexpected calls, emails or messages asking for passwords, OTPs or bank details; change your password; and tell us immediately if you notice anything unusual.`,
    ``,
    `Contact: ${contact}. Please quote reference ${input.reference}.`,
    ``,
    `You also have the right to complain to the Data Protection Board of India.`,
    ``,
    `[Name, designation]`,
    `${input.brand}`,
  ].join("\n");
  return { subject, body };
}

// Signal lifecycle rules (pure): fingerprints, what a re-scan does to an existing signal, and which manual transitions are allowed.
import { createHash } from "node:crypto";
import type { SignalStatus } from "./risk.types";

/** JSON with object keys sorted, so the same facts always hash the same regardless of key order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
export const fingerprint = (basis: unknown) => createHash("sha256").update(stableJson(basis)).digest("hex").slice(0, 32);

export type ExistingSignal = { status: SignalStatus; fingerprint: string; statusFingerprint: string | null };
export type ScanOutcome =
  | { kind: "insert" }
  | { kind: "refresh" }            // still open/acknowledged: update content and last-seen
  | { kind: "suppressed" }         // resolved/dismissed and the evidence hasn't materially changed: leave it closed
  | { kind: "reopen"; reason: string };

/**
 * A detector found the problem again. Closed signals stay closed unless the material evidence (fingerprint) differs
 * from what it was when a person closed it. Signals closed automatically (condition cleared) store no fingerprint, so
 * any reappearance re-opens them.
 */
export function onDetected(existing: ExistingSignal | null, nextFingerprint: string): ScanOutcome {
  if (!existing) return { kind: "insert" };
  if (existing.status === "OPEN" || existing.status === "ACKNOWLEDGED") return { kind: "refresh" };
  if (existing.statusFingerprint && existing.statusFingerprint === nextFingerprint) return { kind: "suppressed" };
  return {
    kind: "reopen",
    reason: existing.statusFingerprint ? `The evidence changed after it was ${existing.status === "DISMISSED" ? "dismissed" : "resolved"}.` : "The condition came back after it had cleared.",
  };
}

/** A detector ran and did NOT find the problem. */
export function onCleared(status: SignalStatus, autoResolve: boolean): "resolve" | "mark-cleared" | "none" {
  if (status !== "OPEN" && status !== "ACKNOWLEDGED") return "none";
  return autoResolve ? "resolve" : "mark-cleared";
}

export const TRANSITIONS: Record<"acknowledge" | "resolve" | "dismiss" | "reopen", { from: SignalStatus[]; to: SignalStatus; noteRequired: boolean }> = {
  acknowledge: { from: ["OPEN"], to: "ACKNOWLEDGED", noteRequired: false },
  resolve: { from: ["OPEN", "ACKNOWLEDGED"], to: "RESOLVED", noteRequired: false },
  dismiss: { from: ["OPEN", "ACKNOWLEDGED"], to: "DISMISSED", noteRequired: true },
  reopen: { from: ["RESOLVED", "DISMISSED"], to: "OPEN", noteRequired: false },
};
export type LifecycleAction = keyof typeof TRANSITIONS;

export function checkTransition(action: LifecycleAction, status: SignalStatus, note: string | undefined) {
  const rule = TRANSITIONS[action];
  const past = { acknowledge: "acknowledged", resolve: "resolved", dismiss: "dismissed", reopen: "re-opened" }[action];
  if (!rule.from.includes(status)) return `A ${status.toLowerCase()} signal can't be ${past}.`;
  if (rule.noteRequired && (!note || note.trim().length < 5)) return "Say why you are dismissing this (at least 5 characters) — it is kept in the audit trail.";
  return null;
}

import { randomUUID } from "node:crypto";
import { buildInfo } from "../health/lifecycle";

/**
 * Optional error reporting without an SDK: when SENTRY_DSN is set, unexpected errors (5xx responses, failed jobs,
 * unhandled rejections) are posted to Sentry's envelope endpoint with fetch. Off when SENTRY_DSN is unset.
 *
 * Privacy: only the error type/message/stack and opaque ids (request id, organization id, user id — UUIDs) are sent.
 * Never request bodies, headers, query strings or employee data. Error messages written by this codebase must not
 * contain PII (the same rule as for logs). At most 30 reports per minute per process; identical errors are sent once
 * per minute.
 */
export type ErrorContext = {
  service: "api" | "worker";
  requestId?: string; route?: string; method?: string; statusCode?: number;
  organizationId?: string; userId?: string; job?: string; jobId?: string;
};

type Dsn = { endpoint: string; auth: string; dsn: string };
let parsed: Dsn | null | undefined;
let windowStart = 0;
let sentInWindow = 0;
const recent = new Map<string, number>();

function dsn(): Dsn | null {
  if (parsed !== undefined) return parsed;
  const raw = process.env.SENTRY_DSN || "";
  try {
    const url = new URL(raw);
    const project = url.pathname.replace(/^\/+|\/+$/g, "");
    if (!url.username || !project || url.protocol !== "https:") return (parsed = null);
    parsed = {
      endpoint: `${url.protocol}//${url.host}/api/${project}/envelope/`,
      auth: `Sentry sentry_version=7, sentry_key=${url.username}, sentry_client=northstar-reporter/1.0`,
      dsn: raw,
    };
  } catch { parsed = null; }
  return parsed;
}

export const errorReportingEnabled = () => !!dsn();

export function reportError(error: unknown, context: ErrorContext): void {
  const target = dsn();
  if (!target) return;
  const err = error instanceof Error ? error : new Error(String(error));
  const now = Date.now();
  if (now - windowStart > 60_000) { windowStart = now; sentInWindow = 0; recent.clear(); }
  const fingerprint = `${context.service}|${context.route || context.job || ""}|${err.name}|${err.message}`.slice(0, 300);
  if (recent.has(fingerprint) || sentInWindow >= 30) return;
  recent.set(fingerprint, now);
  sentInWindow += 1;

  const info = buildInfo();
  const eventId = randomUUID().replace(/-/g, "");
  const tags: Record<string, string> = { service: context.service };
  for (const key of ["requestId", "route", "method", "organizationId", "job"] as const) if (context[key]) tags[key] = String(context[key]).slice(0, 200);
  if (context.statusCode) tags.statusCode = String(context.statusCode);
  const event = {
    event_id: eventId,
    timestamp: now / 1000,
    platform: "node",
    level: "error",
    logger: `northstar-${context.service}`,
    environment: process.env.NODE_ENV || "development",
    release: info.commit ? `northstar@${info.version}+${info.commit}` : `northstar@${info.version}`,
    tags,
    ...(context.userId ? { user: { id: context.userId } } : {}),
    exception: { values: [{ type: err.name || "Error", value: err.message.slice(0, 1000) }] },
    extra: { stack: (err.stack || "").split("\n").slice(0, 30).join("\n"), jobId: context.jobId },
  };
  const body = `${JSON.stringify({ event_id: eventId, sent_at: new Date(now).toISOString(), dsn: target.dsn })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
  // Fire and forget, bounded: reporting must never slow down or crash the caller.
  void fetch(target.endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": target.auth },
    body,
    signal: AbortSignal.timeout(3_000),
  }).catch(() => { /* reporting is best effort */ });
}

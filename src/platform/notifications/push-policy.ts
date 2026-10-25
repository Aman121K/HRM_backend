// Pure push-notification policy: categories, deep links, preferences, quiet hours, burst collapsing, provider payloads
// and provider-response classification. No I/O — unit-tested in push-policy.test.ts
// (npx tsx --test src/platform/notifications/push-policy.test.ts).

export const CATEGORIES = ["approvals", "payroll", "time", "requests", "learning", "engagement", "announcements"] as const;
export type Category = (typeof CATEGORIES)[number];

export type Preferences = {
  categories: Record<Category, boolean>;
  quietHours: { enabled: boolean; start: string; end: string; timezone: string };
  channels: { push: boolean; email: boolean };
  version: number;
};

export const DEFAULT_TIMEZONE = "Asia/Kolkata";
export function defaultPreferences(): Preferences {
  return {
    categories: Object.fromEntries(CATEGORIES.map((category) => [category, true])) as Record<Category, boolean>,
    quietHours: { enabled: false, start: "22:00", end: "07:00", timezone: DEFAULT_TIMEZONE },
    channels: { push: true, email: false },
    version: 0,
  };
}

/** More than this many pushes to one person inside BURST_WINDOW_MS collapse into a single summary push. */
export const BURST_LIMIT = 5;
export const BURST_WINDOW_MS = 60_000;
/** Events older than this when the fan-out first sees them are not pushed (they stay in the in-app inbox). */
export const STALE_EVENT_MS = 60 * 60_000;
export const MAX_ATTEMPTS = 5;

export type EventLike = { id: number | string; eventType: string; entityType: string; entityId: string; payload: Record<string, unknown> };

const HR_CASE_MODULE_CATEGORY: Record<string, Category> = {
  expenses: "requests", travel: "requests", assets: "requests", helpdesk: "requests", letters: "requests", exit: "requests",
  shifts: "time", learning: "learning", recognition: "engagement", candidates: "requests", requisitions: "requests",
};

/** Maps a workflow event to one of the preference categories. Anything waiting on the recipient is "approvals". */
export function categoryFor(event: Pick<EventLike, "eventType" | "entityType" | "payload">): Category {
  const type = String(event.eventType || "").toUpperCase();
  const entity = String(event.entityType || "").toLowerCase();
  const module = typeof event.payload?.module === "string" ? String(event.payload.module) : "";
  if (/(_SUBMITTED|_APPROVAL_REQUESTED|_RELEASE_REQUESTED|_APPROVAL_NEEDED|_PENDING_APPROVAL)$/.test(type)) return "approvals";
  if (type === "APPROVALS_DIGEST" || type.startsWith("APPROVAL")) return "approvals";
  if (entity === "hr_case") {
    // The case engine notifies the approver with <MODULE>_CREATED; recognition notifies the subject instead.
    if (type.endsWith("_CREATED") && module !== "recognition") return "approvals";
    return HR_CASE_MODULE_CATEGORY[module] || HR_CASE_MODULE_CATEGORY[type.split("_")[0].toLowerCase()] || "requests";
  }
  if (["payslip", "payroll_run", "payout_batch", "tax_declaration"].includes(entity) || /^(PAYSLIP|PAYROLL|PAYOUT|SALARY|TAX)/.test(type)) return "payroll";
  if (["leave", "leave_request", "attendance", "attendance_event", "regularization", "roster_publication", "roster_shift"].includes(entity)
    || /^(LEAVE|ATTENDANCE|REGULARIZATION|ROSTER|SHIFT|TIMESHEET)/.test(type)) return "time";
  if (entity.startsWith("lms") || /^(LMS|COURSE|LEARNING)/.test(type)) return "learning";
  if (["survey", "recognition", "engagement"].includes(entity) || /^(SURVEY|RECOGNITION|KUDOS|PULSE)/.test(type)) return "engagement";
  if (entity === "announcement" || /^(ANNOUNCEMENT|ACCESS_ROLE|POLICY|WORK_ANNIVERSARY|ANNIVERSARY)/.test(type)) return "announcements";
  return "requests";
}

const CATEGORY_TITLES: Record<Category, string> = {
  approvals: "Approval needed", payroll: "Payroll", time: "Time & leave", requests: "Your requests",
  learning: "Learning", engagement: "Engagement", announcements: "Announcement",
};

/** In-app route opened when the push is tapped: payload.href / payload.link win, otherwise derived from the entity. */
export function hrefFor(event: Pick<EventLike, "eventType" | "entityType" | "entityId" | "payload">, category = categoryFor(event)): string {
  for (const key of ["href", "link"]) {
    const value = event.payload?.[key];
    if (typeof value === "string" && value.startsWith("/") && !value.startsWith("//")) return value.slice(0, 500);
  }
  const entity = String(event.entityType || "").toLowerCase();
  if (category === "approvals" && entity !== "payroll_run" && entity !== "payout_batch") return "/approvals";
  if (entity === "hr_case") {
    const module = typeof event.payload?.module === "string" && /^[a-z_]+$/.test(String(event.payload.module)) ? String(event.payload.module) : "requests";
    return `/${module}?case=${event.entityId}`;
  }
  const byEntity: Record<string, string> = {
    payslip: "/payroll", payroll_run: "/payroll", payout_batch: "/settings/integrations?tab=payouts", leave: "/time-leave",
    regularization: "/attendance", roster_publication: "/roster", lms_enrollment: "/learning", survey: "/surveys",
    onboarding_joiner: "/onboarding", access_assignment: "/settings", employee: "/my-space",
  };
  return byEntity[entity] || "/notifications";
}

function humanize(eventType: string) {
  const text = String(eventType || "Update").toLowerCase().replace(/_/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export type PushContent = { title: string; body: string; category: Category; data: PushData };
export type PushData = { href: string; eventType: string; entityType: string; entityId: string; notificationId: string };

/** Title/body/data for one event (notificationId is filled in once the queue row exists). */
export function contentFor(event: EventLike): PushContent {
  const category = categoryFor(event);
  // Push text is plain (no HTML is rendered by APNs/FCM) but user-controlled: strip control characters and cap lengths
  // before anything reaches a provider payload (APNs rejects payloads over 4 KB).
  const message = plain(event.payload?.message, 1000) || humanize(event.eventType);
  const title = plain(event.payload?.title, 200);
  const body = title && event.entityType === "hr_case" && !message.includes(title) ? `${message} — ${title}` : message;
  return {
    title: CATEGORY_TITLES[category],
    body: truncate(body, 240),
    category,
    data: { href: hrefFor(event, category), eventType: plain(event.eventType, 80), entityType: plain(event.entityType, 80), entityId: plain(event.entityId, 80), notificationId: "" },
  };
}

/** Single-line plain text: control characters → spaces, collapsed, capped. */
function plain(value: unknown, max: number) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** One push that replaces a burst of notifications. */
export function summaryContent(items: { title: string; body: string; category: string }[]): Omit<PushContent, "data"> & { data: Omit<PushData, "notificationId"> } {
  const categories = new Set(items.map((item) => item.category));
  const category = (categories.size === 1 ? [...categories][0] : "requests") as Category;
  const preview = items.slice(0, 3).map((item) => item.body).join(" · ");
  return {
    title: `${items.length} new notifications`,
    body: truncate(preview + (items.length > 3 ? ` · +${items.length - 3} more` : ""), 240),
    category,
    data: { href: "/notifications", eventType: "SUMMARY", entityType: "summary", entityId: "" },
  };
}

export function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

// ---- preferences + quiet hours --------------------------------------------------------------------------------------

export type Decision = { status: "PENDING" | "SUPPRESSED"; reason: string | null; sendAfter: Date };

/** Minutes past local midnight in `timeZone` (IST for unknown zones). */
export function localMinutes(now: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  } catch {
    return localMinutes(now, DEFAULT_TIMEZONE);
  }
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return (get("hour") % 24) * 60 + get("minute");
}

export function parseHhmm(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`Invalid time ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** When quiet hours are active at `now`, the instant they end; otherwise null. Windows may wrap midnight (22:00–07:00). */
export function quietHoursEnd(quiet: Preferences["quietHours"], now: Date): Date | null {
  if (!quiet.enabled) return null;
  const start = parseHhmm(quiet.start);
  const end = parseHhmm(quiet.end);
  if (start === end) return null;
  const minute = localMinutes(now, quiet.timezone);
  const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  if (!inside) return null;
  const minutesLeft = (end - minute + 1440) % 1440;
  const base = new Date(now);
  base.setUTCSeconds(0, 0);
  return new Date(base.getTime() + minutesLeft * 60_000);
}

/**
 * Applies the recipient's preferences to one event. Policy (documented in the report):
 * - push channel off, or the category switched off → suppressed;
 * - during quiet hours: approvals are deferred until quiet hours end (they need action); everything else is dropped
 *   from push (it is still in the in-app inbox, so nothing is lost).
 */
export function decide(preferences: Preferences, category: Category, now: Date): Decision {
  if (!preferences.channels.push) return { status: "SUPPRESSED", reason: "push_disabled", sendAfter: now };
  if (preferences.categories[category] === false) return { status: "SUPPRESSED", reason: `category_disabled:${category}`, sendAfter: now };
  const quietEnd = quietHoursEnd(preferences.quietHours, now);
  if (quietEnd) {
    if (category === "approvals") return { status: "PENDING", reason: "deferred_quiet_hours", sendAfter: quietEnd };
    return { status: "SUPPRESSED", reason: "quiet_hours", sendAfter: now };
  }
  return { status: "PENDING", reason: null, sendAfter: now };
}

/** True when this batch for one recipient must collapse into one summary push. */
export function shouldCollapse(batchSize: number, sentInWindow: number) {
  return batchSize >= 2 && batchSize + sentInWindow > BURST_LIMIT;
}

/** Retry delay for transient provider failures (attempt 1 → 30 s, 2 → 2 min, 3 → 8 min, 4 → 32 min). */
export function retryDelayMs(attempts: number) {
  return Math.min(30_000 * 4 ** Math.max(0, attempts - 1), 60 * 60_000);
}

// ---- provider payloads ----------------------------------------------------------------------------------------------

export type PushMessage = { notificationId: string; title: string; body: string; badge: number; category: string; data: PushData };

/** APNs JSON payload. Custom key "northstar" carries the routing data. */
export function apnsPayload(message: PushMessage) {
  return {
    aps: { alert: { title: message.title, body: message.body }, badge: message.badge, sound: "default", "thread-id": message.category },
    northstar: { ...message.data, notificationId: message.notificationId, category: message.category },
  };
}

/** FCM HTTP v1 message body. `data` values must all be strings. */
export function fcmMessage(message: PushMessage, token: string) {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...message.data, notificationId: message.notificationId, category: message.category }))
    data[key] = String(value ?? "");
  return {
    message: {
      token,
      notification: { title: message.title, body: message.body },
      data,
      android: {
        priority: "HIGH",
        collapse_key: message.category,
        notification: { sound: "default", tag: message.category, notification_count: message.badge, channel_id: "default" },
      },
      apns: { payload: { aps: { badge: message.badge, sound: "default", "thread-id": message.category } } },
    },
  };
}

// ---- provider responses ---------------------------------------------------------------------------------------------

export type Outcome = "SENT" | "RETRY" | "FAILED" | "INVALID_TOKEN";
export type Classified = { outcome: Outcome; reason: string | null; refreshAuth?: boolean };

/** https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns */
export function classifyApns(status: number, body: unknown): Classified {
  const reason = typeof (body as { reason?: unknown })?.reason === "string" ? String((body as { reason: string }).reason) : null;
  if (status === 200) return { outcome: "SENT", reason: null };
  if (status === 410) return { outcome: "INVALID_TOKEN", reason: reason || "Unregistered" };
  if (status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic")) return { outcome: "INVALID_TOKEN", reason };
  if (status === 403 && reason === "ExpiredProviderToken") return { outcome: "RETRY", reason, refreshAuth: true };
  if (status === 429 || status >= 500) return { outcome: "RETRY", reason: reason || `HTTP ${status}` };
  return { outcome: "FAILED", reason: reason || `HTTP ${status}` };
}

/** https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode */
export function classifyFcm(status: number, body: unknown): Classified {
  const error = (body as { error?: { status?: string; message?: string; details?: { errorCode?: string; ["@type"]?: string }[] } })?.error;
  const codes = (error?.details || []).map((detail) => detail?.errorCode).filter(Boolean) as string[];
  const code = codes[0] || error?.status || null;
  if (status === 200) return { outcome: "SENT", reason: null };
  if (codes.includes("UNREGISTERED") || (status === 404 && (error?.status === "NOT_FOUND" || !error))) return { outcome: "INVALID_TOKEN", reason: "UNREGISTERED" };
  if (codes.includes("SENDER_ID_MISMATCH")) return { outcome: "INVALID_TOKEN", reason: "SENDER_ID_MISMATCH" };
  if (status === 400 && codes.includes("INVALID_ARGUMENT") && /registration token|message\.token/i.test(error?.message || ""))
    return { outcome: "INVALID_TOKEN", reason: "INVALID_ARGUMENT (token)" };
  if (status === 401) return { outcome: "RETRY", reason: code || "UNAUTHENTICATED", refreshAuth: true };
  if (status === 429 || status >= 500) return { outcome: "RETRY", reason: code || `HTTP ${status}` };
  return { outcome: "FAILED", reason: code || `HTTP ${status}` };
}

/** Never log or return a full device token. */
export function maskToken(token: string) {
  if (!token) return "";
  return token.length <= 12 ? `${token.slice(0, 2)}…` : `${token.slice(0, 6)}…${token.slice(-4)}`;
}

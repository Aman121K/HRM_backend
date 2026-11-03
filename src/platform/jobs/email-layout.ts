// Branded HTML email shell applied to every outgoing message at send time. Pure (unit-tested).

export const appBaseUrl = () => (process.env.APP_BASE_URL || process.env.CORS_ORIGIN?.split(",")[0] || "http://localhost:3000").replace(/\/$/, "");

/** The one HTML escaper for email bodies: every interpolated value (names, reasons, titles, comments) goes through it. */
export function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/**
 * Single-line header value (Subject etc.): CR/LF and other control characters are replaced by spaces so user text can
 * never start a new header (header injection), then whitespace is collapsed and the value capped.
 */
export function headerSafe(value: unknown, max = 250) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Absolute link into the web app for a path like "/approvals". */
export function appLink(path: string) {
  return /^https?:\/\//.test(path) ? path : `${appBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Bulletproof (table-based) call-to-action button. */
export function emailButton(label: string, href: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px"><tr><td style="background:#0b615c">` +
    `<a href="${escapeHtml(appLink(href))}" style="display:inline-block;padding:12px 22px;font:700 14px/1 Manrope,Segoe UI,Arial,sans-serif;color:#ffffff;text-decoration:none;letter-spacing:.02em">${escapeHtml(label)}</a>` +
    `</td></tr></table>`;
}

/** A compact list of items for digests: [{ title, meta }]. */
export function emailList(items: { title: string; meta?: string }[]) {
  const rows = items.map((item) =>
    `<tr><td style="padding:10px 0;border-top:1px solid #e6e0d4"><div style="font:600 14px/1.4 Manrope,Segoe UI,Arial,sans-serif;color:#1d2522">${escapeHtml(item.title)}</div>` +
    (item.meta ? `<div style="font:400 12px/1.5 Manrope,Segoe UI,Arial,sans-serif;color:#6b716c">${escapeHtml(item.meta)}</div>` : "") + `</td></tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0;border-bottom:1px solid #e6e0d4">${rows}</table>`;
}

/** Wraps message HTML in the ClanChief layout. Messages that are already full documents are sent unchanged. */
export function renderEmail(input: { subject: string; html: string; organizationName?: string }) {
  if (/<html[\s>]/i.test(input.html)) return input.html;
  const org = escapeHtml(input.organizationName || "ClanChief");
  const settings = appLink("/my-space");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f5f1e8">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f1e8"><tr><td align="center" style="padding:32px 16px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e6e0d4">` +
    `<tr><td style="background:#16302b;padding:20px 28px"><span style="display:inline-block;width:10px;height:10px;background:#d7a33b;margin-right:10px"></span>` +
    `<span style="font:800 15px/1 Manrope,Segoe UI,Arial,sans-serif;color:#ffffff;letter-spacing:.04em">NORTHSTAR</span>` +
    `<span style="font:500 13px/1 Manrope,Segoe UI,Arial,sans-serif;color:#b9c9c3;margin-left:10px">${org}</span></td></tr>` +
    `<tr><td style="padding:28px 28px 8px;font:400 15px/1.6 Manrope,Segoe UI,Arial,sans-serif;color:#1d2522">` +
    `<h1 style="margin:0 0 16px;font:800 21px/1.3 Manrope,Segoe UI,Arial,sans-serif;color:#1d2522">${escapeHtml(input.subject)}</h1>${input.html}</td></tr>` +
    `<tr><td style="padding:20px 28px 28px;font:400 12px/1.6 Manrope,Segoe UI,Arial,sans-serif;color:#6b716c;border-top:1px solid #e6e0d4">` +
    `Sent by ClanChief on behalf of ${org}. This is an automated message — please don't reply.<br>` +
    `<a href="${escapeHtml(settings)}" style="color:#0b615c">Open ClanChief</a></td></tr>` +
    `</table></td></tr></table></body></html>`;
}

/** Plain-text alternative so text-only clients (and spam filters) get something readable. */
export function htmlToText(html: string) {
  return html
    .replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li)[^>]*>/gi, "\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

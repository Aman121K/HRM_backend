/**
 * Brand subdomains: `<slug>.<APP_DOMAIN>` (e.g. got-tea.people.example.com) serves exactly one brand.
 * These names can never be a brand slug because they are used by the platform itself.
 */
export const RESERVED_SUBDOMAINS = new Set([
  "www", "app", "api", "admin", "auth", "login", "sso", "idp", "mail", "smtp", "static", "cdn", "assets", "files", "status",
  "platform", "help", "support", "docs", "dev", "staging", "test", "demo", "northstar", "b", "m", "mobile", "ws",
]);

/** The brand slug a browser Origin/Host points at, or null for the main domain and anything unrelated. */
export function brandFromHost(value: string | undefined, appDomain: string): string | null {
  if (!value || !appDomain) return null;
  let host = value;
  try { if (value.includes("://")) host = new URL(value).hostname; } catch { return null; }
  host = host.split(":")[0].toLowerCase();
  const suffix = `.${appDomain.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const sub = host.slice(0, -suffix.length);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(sub) || RESERVED_SUBDOMAINS.has(sub)) return null;
  return sub;
}

/** CORS: the configured origins plus any brand subdomain of APP_DOMAIN on the same scheme/port as the main web origin. */
export function subdomainOriginPattern(appDomain: string, webOrigins: string[]) {
  const escaped = appDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ports = [...new Set(webOrigins.map((origin) => { try { return new URL(origin).port; } catch { return ""; } }))];
  const port = ports.map((value) => (value ? `:${value}` : "")).map((value) => value.replace(/[:]/g, "\\:")).join("|");
  return new RegExp(`^https?://[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\\.${escaped}(?:${port || ""})$`);
}

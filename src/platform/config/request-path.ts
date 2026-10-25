/**
 * Canonical request paths for security decisions (module gating, rate-limit tiers, logging).
 *
 * The router (find-my-way) percent-decodes paths before matching, so `/api/v2/%70ayroll/meta` reaches the payroll
 * controller. Any check that compares prefixes on the raw URL can therefore be bypassed with encoding tricks. Security
 * code must use either the matched route pattern (`request.routeOptions.url`) or `canonicalPath()` below.
 */

export class UnsafePathError extends Error {}

/** Encoded or raw separators that would change how a path is split after decoding. */
const ENCODED_SEPARATOR = /%(2f|5c)/i;

/** Path part of a URL (no query string or fragment). */
export const rawPath = (url: string) => {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
};

/**
 * Decode percent-encoding once, collapse duplicate slashes, resolve "." / ".." segments and lowercase.
 * Throws UnsafePathError for paths that hide separators (%2F, %5C, backslash), are malformed, or whose meaning would
 * change on a second decode (double encoding such as %2570).
 */
export function canonicalPath(url: string): string {
  const path = rawPath(url);
  if (path.includes("\\") || ENCODED_SEPARATOR.test(path)) throw new UnsafePathError("Encoded or backslash separators are not allowed in the path.");
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { throw new UnsafePathError("Malformed percent-encoding in the path."); }
  if (decoded.includes("\\") || /[\u0000-\u001f]/.test(decoded)) throw new UnsafePathError("Control characters or backslashes are not allowed in the path.");
  if (/%[0-9a-f]{2}/i.test(decoded)) {
    let twice: string;
    try { twice = decodeURIComponent(decoded); } catch { twice = decoded; }
    if (twice !== decoded) throw new UnsafePathError("Double-encoded paths are not allowed.");
  }
  const segments: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") { segments.pop(); continue; }
    segments.push(segment);
  }
  return `/${segments.join("/")}`.toLowerCase();
}

/** canonicalPath() that never throws: unsafe paths map to a sentinel that matches no prefix. */
export const safeCanonicalPath = (url: string) => {
  try { return canonicalPath(url); } catch { return "/__unsafe__"; }
};

/**
 * True when `path` is `prefix` itself or below it (segment-aware: /api/v2/payroll does not match /api/v2/payrollx).
 * A prefix ending in "/" or "-" is a plain string prefix (e.g. "/api/v2/auth/demo-").
 */
export const underPrefix = (path: string, prefix: string) =>
  /[/-]$/.test(prefix) ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`);

/** Query-string parameters that carry secrets (device comm keys, signed links, tokens) and must never be logged. */
const SECRET_PARAMS = /^(key|comm_?key|commkey|token|access_token|id_token|refresh_token|signature|sig|secret|password|code|code_verifier|api_?key)$/i;

/** The URL with secret query values replaced by "[REDACTED]" (for logs). */
export function redactUrl(url: string): string {
  const start = url.indexOf("?");
  if (start === -1) return url;
  const query = url.slice(start + 1).split("&").map((pair) => {
    const eq = pair.indexOf("=");
    const name = eq === -1 ? pair : pair.slice(0, eq);
    let decodedName = name;
    try { decodedName = decodeURIComponent(name.replace(/\+/g, " ")); } catch { /* keep raw */ }
    return SECRET_PARAMS.test(decodedName.trim()) ? `${name}=[REDACTED]` : pair;
  });
  return `${url.slice(0, start)}?${query.join("&")}`;
}

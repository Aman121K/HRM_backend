/**
 * TRUST_PROXY → Fastify `trustProxy`.
 *   unset/"false"   → false: request.ip is the socket peer (direct exposure, or local dev).
 *   "true"          → 1: trust exactly one proxy hop (the load balancer). Trusting *every* hop would make request.ip the
 *                     left-most X-Forwarded-For entry, which the client controls — rotating it would defeat per-IP limits.
 *   "2", "3", ...   → that many proxy hops (e.g. CDN in front of the load balancer).
 *   anything else   → a comma-separated list of trusted proxy IPs/CIDRs, e.g. "10.0.0.0/8,172.16.0.0/12".
 */
export function trustProxySetting(value: string | undefined): boolean | string | ((address: string, hop: number) => boolean) {
  const raw = (value || "").trim();
  if (!raw || raw === "false") return false;
  // Fastify 5.12+ takes hop counts as a function: trust the nearest N hops only.
  const hops = raw === "true" ? 1 : /^\d+$/.test(raw) ? Number(raw) : null;
  if (hops !== null) return (_address: string, hop: number) => hop < hops;
  return raw;
}

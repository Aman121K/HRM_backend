import { safeCanonicalPath, underPrefix } from "./request-path";

/**
 * Edge (pre-authentication) rate limits, per client IP and per minute, by risk. Offices share one public IP, so low-risk
 * public reads get a large budget while enumeration-prone endpoints stay tight. This limiter runs before authentication
 * and therefore keys ONLY on the client IP (`request.ip`, which honours TRUST_PROXY) — never on the Authorization or demo
 * headers, which anyone can rotate to mint fresh buckets. Signed-in traffic additionally gets a per-identity budget
 * (RATE_LIMIT_AUTHENTICATED) in AuthGuard once the identity is verified, and failed authentications are capped per IP
 * there; the per-IP ceiling for signed-in routes is generous so a whole office behind one NAT isn't throttled.
 */
export const LIMIT_TIERS: [string[], number][] = [
  [["/api/v2/auth/demo-"], Number(process.env.RATE_LIMIT_ENUMERATION || 30)],
  [["/api/v2/auth/config", "/api/v2/auth/brand/", "/api/v2/health"], Number(process.env.RATE_LIMIT_PUBLIC || 600)],
  [["/iclock", "/api/v2/integrations/devices/", "/api/v2/integrations/payouts/webhook"], Number(process.env.RATE_LIMIT_DEVICES || 1200)],
];
export const IP_CEILING = Number(process.env.RATE_LIMIT_IP_CEILING || 6000);

type LimitedRequest = { ip: string; url: string; method?: string; routeOptions?: { url?: string } };

/** Tier matching uses the matched route pattern (or the canonicalised path), never the raw URL, so %-encoding can't pick a tier. */
export const tierPath = (request: LimitedRequest) => (request.routeOptions?.url || safeCanonicalPath(request.url)).toLowerCase();
export const tierOf = (path: string) => LIMIT_TIERS.findIndex(([prefixes]) => prefixes.some((prefix) => underPrefix(path, prefix)));
export const limitFor = (path: string) => { const tier = tierOf(path); return tier === -1 ? IP_CEILING : LIMIT_TIERS[tier][1]; };

/** Options for @fastify/rate-limit (the store is added by the caller). */
export const edgeRateLimitOptions = () => ({
  global: true,
  timeWindow: "1 minute",
  max: (request: LimitedRequest) => limitFor(tierPath(request)),
  // CORS preflights carry no credentials and are answered without touching the app.
  allowList: (request: LimitedRequest) => request.method === "OPTIONS",
  keyGenerator: (request: LimitedRequest) => `ip:${tierOf(tierPath(request))}|${request.ip}`,
  skipOnError: true,
  errorResponseBuilder: (_request: unknown, context: { after: string }) => ({ statusCode: 429, error: "Too Many Requests", message: `Too many requests. Try again in ${context.after}.` }),
});

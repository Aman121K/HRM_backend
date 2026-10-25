import { Logger } from "@nestjs/common";

type Window = { count: number; resetAt: number };
const WINDOW_MS = 60_000;
const LOCAL_MAX_KEYS = 50_000;

/**
 * Fixed one-minute counters for limits that need a *verified* key: per signed-in identity, and failed sign-ins per IP.
 * The edge limiter in main.ts runs before authentication, so it can only key by client IP; keying it by the raw
 * Authorization header let anyone mint a fresh bucket per request with a fake token. Redis-backed (shared across API
 * instances) with an in-process fallback when Redis is unavailable.
 */
export class IdentityRateLimiter {
  private readonly logger = new Logger(IdentityRateLimiter.name);
  private readonly local = new Map<string, Window>();
  private readonly redis: any;
  private redisWarned = false;

  constructor(redisUrl: string, private readonly nameSpace = "northstar-rl:v2:") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.redis = redisUrl ? new (require("ioredis"))(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false }) : null;
    this.redis?.on?.("error", () => undefined);
  }

  /** Counts one hit; returns the new count and seconds until the window resets. */
  async hit(key: string): Promise<{ count: number; retryAfter: number }> {
    const now = Date.now();
    const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now % WINDOW_MS)) / 1000));
    const windowKey = this.windowKey(key, now);
    if (this.redis) {
      try {
        const count = Number(await this.redis.incr(windowKey));
        if (count === 1) await this.redis.pexpire(windowKey, WINDOW_MS + 5_000);
        return { count, retryAfter };
      } catch (error) { this.warn(error); }
    }
    let entry = this.local.get(windowKey);
    if (!entry || entry.resetAt <= now) {
      if (this.local.size >= LOCAL_MAX_KEYS) for (const [name, value] of this.local) if (value.resetAt <= now) this.local.delete(name);
      if (this.local.size >= LOCAL_MAX_KEYS) this.local.clear();
      entry = { count: 0, resetAt: now - (now % WINDOW_MS) + WINDOW_MS };
      this.local.set(windowKey, entry);
    }
    entry.count += 1;
    return { count: entry.count, retryAfter };
  }

  private windowKey(key: string, now = Date.now()) { return `${this.nameSpace}${key}:${Math.floor(now / WINDOW_MS)}`; }

  private warn(error: unknown) {
    if (this.redisWarned) return;
    this.redisWarned = true;
    this.logger.warn(`Rate-limit store unavailable, using in-process counters: ${(error as Error).message}`);
  }
}

import { Logger } from "@nestjs/common";

const LOCAL_MAX_KEYS = 50_000;

/**
 * Sliding counters with a TTL for sign-in throttling (failed attempts per email / per IP over minutes, not just one
 * minute). Redis-backed so every API instance shares them; in-process fallback when Redis is unavailable. Keys are
 * always hashes — never raw emails.
 */
export class AuthThrottle {
  private readonly logger = new Logger(AuthThrottle.name);
  private readonly local = new Map<string, { count: number; expiresAt: number }>();
  private readonly redis: any;
  private warned = false;

  constructor(redisUrl: string, private readonly nameSpace = "northstar-auth:v1:") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.redis = redisUrl ? new (require("ioredis"))(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false }) : null;
    this.redis?.on?.("error", () => undefined);
  }

  /** Adds one and returns the new count; the window starts at the first hit and lasts ttlSeconds. */
  async hit(key: string, ttlSeconds: number): Promise<number> {
    const name = this.nameSpace + key;
    if (this.redis) {
      try {
        const count = Number(await this.redis.incr(name));
        if (count === 1) await this.redis.expire(name, ttlSeconds);
        return count;
      } catch (error) { this.warn(error); }
    }
    const now = Date.now();
    let entry = this.local.get(name);
    if (!entry || entry.expiresAt <= now) {
      if (this.local.size >= LOCAL_MAX_KEYS) this.local.clear();
      entry = { count: 0, expiresAt: now + ttlSeconds * 1000 };
      this.local.set(name, entry);
    }
    entry.count += 1;
    return entry.count;
  }

  async peek(key: string): Promise<number> {
    const name = this.nameSpace + key;
    if (this.redis) {
      try { return Number((await this.redis.get(name)) || 0); } catch (error) { this.warn(error); }
    }
    const entry = this.local.get(name);
    return entry && entry.expiresAt > Date.now() ? entry.count : 0;
  }

  async clear(key: string) {
    const name = this.nameSpace + key;
    this.local.delete(name);
    if (this.redis) { try { await this.redis.del(name); } catch (error) { this.warn(error); } }
  }

  private warn(error: unknown) {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn(`Sign-in throttle store unavailable, using in-process counters: ${(error as Error).message}`);
  }

  async close() { try { await this.redis?.quit?.(); } catch { /* ignore */ } }
}

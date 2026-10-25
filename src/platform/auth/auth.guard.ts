import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, UnauthorizedException } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Reflector } from "@nestjs/core";
import { createHash } from "node:crypto";
import { RuntimeConfig } from "../config/runtime-config";
import { AuthService } from "./auth.service";
import { IdentityRateLimiter } from "./identity-rate-limit";
import { PUBLIC_ROUTE_KEY } from "./public.decorator";

/** Requests per minute per verified identity (people in one office share an IP but each gets their own budget). */
const IDENTITY_LIMIT = Number(process.env.RATE_LIMIT_AUTHENTICATED || 600);
/** Failed authentications (bad/expired/forged tokens, unknown demo ids) per client IP per minute before further attempts get 429. */
const AUTH_FAILURE_LIMIT = Number(process.env.RATE_LIMIT_AUTH_FAILURES || 120);

const tooMany = (retryAfter: number) =>
  new HttpException({ statusCode: 429, error: "Too Many Requests", message: `Too many requests. Try again in ${retryAfter} seconds.` }, HttpStatus.TOO_MANY_REQUESTS);

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly limiter: IdentityRateLimiter;
  constructor(private readonly auth: AuthService, private readonly reflector: Reflector, config: RuntimeConfig) {
    this.limiter = new IdentityRateLimiter(config.redisUrl);
  }

  async canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_KEY, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const failureKey = `authfail:${request.ip}`;
    let identity;
    try {
      identity = await this.auth.authenticate(request.headers);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        // Too many failures from this IP: further failures get 429 (stops credential/ID guessing and floods of junk tokens).
        // Valid credentials from the same IP still work, so colleagues behind one office NAT aren't locked out.
        const { count, retryAfter } = await this.limiter.hit(failureKey);
        if (count > AUTH_FAILURE_LIMIT) { reply.header("retry-after", String(retryAfter)); throw tooMany(retryAfter); }
      }
      throw error;
    }
    request.identity = identity;
    // Only a verified identity gets its own bucket, so rotating fake credentials can't buy fresh budgets.
    const who = createHash("sha256").update(`${identity.organizationId}|${identity.userId}|${identity.employeeId}`).digest("hex").slice(0, 24);
    const { count, retryAfter } = await this.limiter.hit(`id:${who}`);
    if (count > IDENTITY_LIMIT) {
      reply.header("retry-after", String(retryAfter));
      throw tooMany(retryAfter);
    }
    return true;
  }
}

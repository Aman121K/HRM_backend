import "dotenv/config";
import "reflect-metadata";
import { ConsoleLogger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { RuntimeConfig } from "./config/runtime-config";
import { SecurityService } from "./security/security.service";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { LogController } from "fastify";
import { subdomainOriginPattern } from "./organizations/brand-host";
import { canonicalPath, rawPath, UnsafePathError } from "./config/request-path";
import { edgeRateLimitOptions } from "./config/rate-limit";
import { loggerOptions } from "./config/logging";
import { trustProxySetting } from "./config/trust-proxy";
import { randomUUID } from "node:crypto";
import { markDraining } from "./health/lifecycle";
import { reportError } from "./ops/error-reporter";

/** Accept a caller's/load balancer's x-request-id only when it is a short opaque token; otherwise mint one. */
const REQUEST_ID = /^[A-Za-z0-9._:@=;-]{8,200}$/;
const requestIdFor = (request: { headers: Record<string, unknown> }) => {
  const incoming = request.headers["x-request-id"] ?? request.headers["x-amzn-trace-id"];
  return typeof incoming === "string" && REQUEST_ID.test(incoming) ? incoming : randomUUID();
};

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({
    logger: loggerOptions(),
    bodyLimit: 12 * 1024 * 1024,
    // Behind a load balancer set TRUST_PROXY so rate limits and audit see the real client IP (see trustProxySetting).
    trustProxy: trustProxySetting(process.env.TRUST_PROXY),
    // Request ids: honour a well-formed x-request-id (or the ALB's X-Amzn-Trace-Id), echo it on the response, and log it
    // as "requestId" on every line. One structured "request completed" line per request is written below (with ids only).
    genReqId: requestIdFor as never,
    logController: new LogController({ requestIdLogLabel: "requestId", disableRequestLogging: true }),
  } as never), {
    // Nest's own messages (boot, module warnings) as JSON lines too in production, so every log line is machine-readable.
    ...(process.env.NODE_ENV === "production" || process.env.LOG_FORMAT === "json" ? { logger: new ConsoleLogger({ json: true, colors: false }) } : {}),
  });
  const config = app.get(RuntimeConfig);
  config.validate();
  // Security headers. The API only serves JSON and file downloads, so its CSP forbids everything.
  await app.register(helmet as never, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "same-site" },
    hsts: config.nodeEnv === "production" ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    referrerPolicy: { policy: "no-referrer" },
  });
  // Edge rate limits per client IP (request.ip honours TRUST_PROXY): strict on public endpoints, a generous ceiling for
  // signed-in use (the per-identity budget is enforced in AuthGuard). Redis-backed when available so limits hold across
  // API instances.
  await app.register(rateLimit as never, {
    ...edgeRateLimitOptions(),
    ...(config.redisUrl ? { redis: new (require("ioredis"))(config.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false }), nameSpace: "northstar-rl:" } : {}),
  });
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook("onRequest", (request: any, reply: any, done: () => void) => { reply.header("x-request-id", request.id); done(); });
  // One line per request: method, redacted URL, matched route, status, duration, request id and the caller's opaque ids
  // (organizationId/userId UUIDs — never names, emails or other PII). Successful health probes log at debug.
  fastify.addHook("onResponse", (request: any, reply: any, done: () => void) => {
    const identity = request.identity;
    const route = request.routeOptions?.url;
    const probe = typeof route === "string" && route.startsWith("/api/v2/health");
    const quiet = probe && reply.statusCode < 400;
    const line = { req: request, res: { statusCode: reply.statusCode }, route, responseTimeMs: Math.round(reply.elapsedTime ?? 0),
      organizationId: identity?.organizationId || undefined, userId: identity?.userId || undefined };
    if (quiet) request.log.debug(line, "request completed");
    else if (reply.statusCode >= 500 && !probe) request.log.error(line, "request completed");
    else if (reply.statusCode >= 500) request.log.warn(line, "request completed");
    else request.log.info(line, "request completed");
    done();
  });
  // Unexpected errors go to the optional reporter (SENTRY_DSN); 4xx are expected outcomes and are not reported.
  fastify.addHook("onError", (request: any, reply: any, error: any, done: () => void) => {
    const status = Number(error?.statusCode || error?.status || reply.statusCode || 500);
    if (status >= 500) reportError(error, { service: "api", requestId: request.id, route: request.routeOptions?.url, method: request.method,
      statusCode: status, organizationId: request.identity?.organizationId || undefined, userId: request.identity?.userId || undefined });
    done();
  });
  // Paths that hide separators (%2F, %5C, backslash) or are double-encoded are refused before any routing decision uses them.
  app.getHttpAdapter().getInstance().addHook("onRequest", (request: any, reply: any, done: () => void) => {
    try { canonicalPath(request.url); } catch (error) {
      if (error instanceof UnsafePathError) { reply.code(400).send({ statusCode: 400, error: "Bad Request", message: error.message, code: "UNSAFE_PATH" }); return; }
      throw error;
    }
    done();
  });
  app.enableCors({ origin: [...config.corsOrigins, subdomainOriginPattern(config.appDomain, config.corsOrigins)], credentials: true, allowedHeaders: ["authorization", "content-type", "x-tenant-id", "x-employee-id", "x-organization-id", "idempotency-key", "x-request-id"], exposedHeaders: ["x-request-id", "content-disposition", "x-file-sha256", "x-row-count", "x-control-total"], methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  // Every denied request (401/403/429) is recorded for the Security Center, aggregated per minute.
  const security = app.get(SecurityService);
  app.getHttpAdapter().getInstance().addHook("onResponse", (request: any, reply: any, done: () => void) => {
    if (reply.statusCode === 401 || reply.statusCode === 403 || reply.statusCode === 429)
      security.record({ ip: request.ip, status: reply.statusCode, method: request.method, route: request.routeOptions?.url || rawPath(request.url),
        userAgent: request.headers["user-agent"], identity: request.identity });
    done();
  });
  if (config.nodeEnv !== "production" || process.env.EXPOSE_OPENAPI === "true") {
    const openApi = new DocumentBuilder().setTitle("ClanChief API").setDescription("Modular tenant-scoped HRM platform API").setVersion("2.0").addBearerAuth().build();
    const document = SwaggerModule.createDocument(app, openApi);
    app.getHttpAdapter().get("/api/openapi.json", (_request: unknown, reply: { send: (value: unknown) => void }) => reply.send(document));
  }
  // Loopback unless BIND_HOST says otherwise (containers: BIND_HOST=0.0.0.0 behind the load balancer).
  await app.listen({ port: config.port, host: config.bindHost });
  installShutdown(app, config.nodeEnv === "production");
}

/**
 * Graceful shutdown on SIGTERM/SIGINT: /api/v2/health/ready answers 503 "draining" at once so the load balancer stops
 * sending new requests, then after SHUTDOWN_DRAIN_MS (default 5 s in production, 0 locally) the server closes: Fastify
 * stops accepting connections, finishes in-flight requests, and Nest closes the DB pools, Redis and queue clients.
 * SHUTDOWN_TIMEOUT_MS (default 20 s) bounds the whole thing — keep drain + timeout below the orchestrator's stop
 * timeout (ECS stopTimeout / Kubernetes terminationGracePeriodSeconds; docs/ops/deploy-aws.md uses 45 s).
 */
function installShutdown(app: NestFastifyApplication, production: boolean) {
  const drainMs = Math.max(0, Number(process.env.SHUTDOWN_DRAIN_MS ?? (production ? 5_000 : 0)));
  const timeoutMs = Math.max(1_000, Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 20_000));
  const log = app.getHttpAdapter().getInstance().log;
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    markDraining();
    log.info({ signal, drainMs, timeoutMs }, "shutdown started");
    const force = setTimeout(() => { log.error({ signal }, "shutdown timed out; exiting"); process.exit(1); }, drainMs + timeoutMs);
    force.unref();
    try {
      if (drainMs) await new Promise((resolve) => setTimeout(resolve, drainMs));
      await app.close();
      log.info({ signal }, "shutdown complete");
      process.exit(0);
    } catch (error) {
      log.error({ signal, err: error }, "shutdown failed");
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  // Best-effort report of a crash before Node exits (does not change crash semantics).
  process.on("uncaughtExceptionMonitor", (error) => reportError(error, { service: "api" }));
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

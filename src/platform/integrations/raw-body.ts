import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** Exact request bytes, captured only for signed integration endpoints (HMAC is computed over these). */
    integrationRawBody?: Buffer;
  }
}

/** Paths whose signature covers the raw body. */
const SIGNED_PREFIXES = ["/api/v2/integrations/devices/punches", "/api/v2/integrations/devices/heartbeat", "/api/v2/integrations/payouts/webhook"];
const ADMS_PREFIX = "/iclock/";
const MAX_BYTES = 2 * 1024 * 1024;

const pathOf = (url: string) => url.split("?")[0];

/**
 * Installs two narrowly scoped Fastify hooks (the app's global body parsing is left untouched):
 *  - preParsing: buffers the raw body of signed integration requests so HMACs are verified over the exact bytes;
 *  - a catch-all content-type parser that accepts the plain-text ATTLOG uploads of ZKTeco/eSSL ADMS devices
 *    (which send text/plain or no/odd content types). Any other path keeps Fastify's 415 behaviour.
 */
export function installIntegrationBodyHooks(fastify: FastifyInstance | undefined) {
  if (!fastify || (fastify as unknown as { __nsIntegrationHooks?: boolean }).__nsIntegrationHooks) return;
  (fastify as unknown as { __nsIntegrationHooks?: boolean }).__nsIntegrationHooks = true;

  fastify.addHook("preParsing", async (request: FastifyRequest, _reply, payload) => {
    const path = pathOf(request.url);
    if (!SIGNED_PREFIXES.some((prefix) => path === prefix) && !path.startsWith(ADMS_PREFIX)) return payload;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of payload as AsyncIterable<Buffer | string>) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > MAX_BYTES) throw Object.assign(new Error("Payload too large"), { statusCode: 413 });
      chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks);
    request.integrationRawBody = raw;
    const replay = Readable.from([raw]) as Readable & { receivedEncodedLength?: number };
    replay.receivedEncodedLength = raw.length;
    return replay;
  });

  if (!fastify.hasContentTypeParser("*")) {
    fastify.addContentTypeParser("*", { parseAs: "string", bodyLimit: MAX_BYTES }, (request, body, done) => {
      if (!pathOf(request.url).startsWith(ADMS_PREFIX))
        return done(Object.assign(new Error(`Unsupported Media Type: ${request.headers["content-type"] || "none"}`), { statusCode: 415 }), undefined);
      done(null, body);
    });
  }
}

import { redactUrl } from "./request-path";

type LoggedRequest = { method?: string; url?: string; hostname?: string; host?: string; ip?: string; socket?: { remotePort?: number } };

/**
 * Fastify logger options. Request URLs are logged with secret query values (device comm keys, tokens, signatures)
 * replaced, and credentials in headers are redacted should any serializer ever include headers.
 */
export const loggerOptions = (level = process.env.LOG_LEVEL || "info") => ({
  level,
  redact: ["req.headers.authorization", "req.headers.cookie", "req.headers[\"x-comm-key\"]", "req.headers[\"x-signature\"]", "req.headers[\"x-razorpay-signature\"]"],
  serializers: {
    req(request: LoggedRequest) {
      return { method: request.method, url: redactUrl(String(request.url || "")), host: request.host || request.hostname, remoteAddress: request.ip, remotePort: request.socket?.remotePort };
    },
  },
});

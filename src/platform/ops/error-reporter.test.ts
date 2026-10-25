import assert from "node:assert/strict";
import test from "node:test";

test("error reporter posts a Sentry envelope with opaque ids only, deduplicated per minute", async () => {
  process.env.SENTRY_DSN = "https://publickey123@o1.ingest.example.io/4242";
  const calls: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response("{}"); }) as typeof fetch;
  try {
    const { reportError, errorReportingEnabled } = await import("./error-reporter");
    assert.equal(errorReportingEnabled(), true);
    const error = new Error("payroll run exploded");
    reportError(error, { service: "api", requestId: "req-123", route: "/api/v2/payroll/runs/:id", method: "POST", statusCode: 500,
      organizationId: "68c6308a-ac02-4c83-aa9f-fb5f06bf94bb", userId: "502ee7ba-8711-4cb4-8869-b0e951e76480" });
    reportError(error, { service: "api", route: "/api/v2/payroll/runs/:id" }); // same fingerprint → dropped
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://o1.ingest.example.io/api/4242/envelope/");
    assert.match(String((calls[0].init.headers as Record<string, string>)["x-sentry-auth"]), /sentry_key=publickey123/);
    const [header, item, event] = String(calls[0].init.body).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(item.type, "event");
    assert.equal(header.event_id, event.event_id);
    assert.equal(event.exception.values[0].value, "payroll run exploded");
    assert.equal(event.tags.requestId, "req-123");
    assert.equal(event.user.id, "502ee7ba-8711-4cb4-8869-b0e951e76480");
    assert.equal(event.request, undefined); // never request data
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.SENTRY_DSN;
  }
});

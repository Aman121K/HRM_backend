// npx tsx --test src/platform/receipts/*.test.ts — Anthropic provider request/response handling with a fake fetch.
import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicOcr } from "./ocr-providers";

function fakeClient(reply: unknown, seen: { body?: Record<string, unknown> }) {
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    seen.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
  return new Anthropic({ apiKey: "test-key", fetch: fetch as unknown as typeof globalThis.fetch, maxRetries: 0 });
}
const message = (text: string, stop = "end_turn") => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5", stop_reason: stop, stop_sequence: null,
  content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 },
});

test("sends the image with a JSON schema and maps the structured reply", async () => {
  const seen: { body?: Record<string, unknown> } = {};
  const reply = { merchant: "Third Wave Coffee", date: "2026-09-23", total: 395, currency: "INR", tax: null, gstin: "29AAACT1234A1Z5",
    invoiceNumber: "A-1182", category: "Meals", lines: [{ description: "Cappuccino", amount: 210 }], confidence: 0.93, warnings: [] };
  const result = await new AnthropicOcr(fakeClient(message(JSON.stringify(reply)), seen)).scan(Buffer.from("fake-png"), "image/png");
  assert.equal(seen.body?.model, process.env.ANTHROPIC_OCR_MODEL || "claude-haiku-4-5");
  const format = (seen.body?.output_config as { format: { type: string; schema: { required: string[] } } }).format;
  assert.equal(format.type, "json_schema");
  assert.ok(format.schema.required.includes("total"));
  const content = (seen.body?.messages as { content: { type: string; source?: { media_type: string } }[] }[])[0].content;
  assert.equal(content[0].type, "image");
  assert.equal(content[0].source?.media_type, "image/png");
  assert.equal(result.provider, "anthropic");
  assert.deepEqual(result.fields, { merchant: "Third Wave Coffee", date: "2026-09-23", total: 395, currency: "INR", gstin: "29AAACT1234A1Z5", invoiceNumber: "A-1182", category: "Meals" });
  assert.equal(result.confidence, 0.93);
});

test("PDFs go as document blocks; invalid values are dropped; refusals throw", async () => {
  const seen: { body?: Record<string, unknown> } = {};
  const reply = { merchant: null, date: "23/09/2026", total: -5, currency: "USD", tax: null, gstin: "BAD", invoiceNumber: null, category: "Nope", lines: [], confidence: 2, warnings: ["blurry"] };
  const result = await new AnthropicOcr(fakeClient(message(JSON.stringify(reply)), seen)).scan(Buffer.from("%PDF-1.4"), "application/pdf");
  const content = (seen.body?.messages as { content: { type: string }[] }[])[0].content;
  assert.equal(content[0].type, "document");
  assert.equal(result.fields.date, undefined);
  assert.equal(result.fields.total, undefined);
  assert.equal(result.fields.gstin, undefined);
  assert.equal(result.fields.category, "Other");
  assert.equal(result.confidence, 1);
  assert.ok(result.warnings.includes("blurry") && result.warnings.some((w) => /USD/.test(w)));
  await assert.rejects(new AnthropicOcr(fakeClient(message("", "refusal"), {})).scan(Buffer.from("x"), "image/jpeg"), /declined/);
});

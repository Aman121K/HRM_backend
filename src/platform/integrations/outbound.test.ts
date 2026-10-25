import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { headerSafe, escapeHtml } from "../jobs/email-layout";
import { checkUrlSyntax, isPublicAddress, OutboundUrlError, pinnedPost, vetUrl } from "./outbound";
import { csvSafe } from "./shared";

const prod = { production: true };
const dev = { production: false };

test("non-public addresses are rejected", () => {
  for (const ip of ["127.0.0.1", "127.1.2.3", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0",
    "100.64.0.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "2002:7f00:1::1", "[::1]", "fe80::1%en0"])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "104.20.23.154", "172.32.0.1", "2606:4700:10::6814:179a", "::ffff:8.8.8.8"])
    assert.equal(isPublicAddress(ip), true, ip);
});

test("scheme rules", () => {
  assert.throws(() => checkUrlSyntax("http://example.com/x", prod), OutboundUrlError);
  assert.throws(() => checkUrlSyntax("http://localhost:4298/x", prod), OutboundUrlError);
  assert.throws(() => checkUrlSyntax("http://example.com/x", dev), OutboundUrlError);
  assert.throws(() => checkUrlSyntax("https://user:pw@example.com/x", dev), OutboundUrlError);
  assert.throws(() => checkUrlSyntax("ftp://example.com/x", dev), OutboundUrlError);
  assert.ok(checkUrlSyntax("http://localhost:4298/hooks", dev));
  assert.ok(checkUrlSyntax("https://example.com/hooks", prod));
});

test("DNS names resolving to private addresses are refused (dev and prod)", async () => {
  for (const policy of [dev, prod]) {
    await assert.rejects(vetUrl("https://127.0.0.1.nip.io/x", policy), OutboundUrlError);
    await assert.rejects(vetUrl("https://169.254.169.254/latest/meta-data", policy), OutboundUrlError);
    await assert.rejects(vetUrl("https://[::ffff:127.0.0.1]/x", policy), OutboundUrlError);
    await assert.rejects(vetUrl("https://10.0.0.1/x", policy), OutboundUrlError);
  }
  await assert.rejects(vetUrl("https://localhost/x", prod), OutboundUrlError);
  await assert.rejects(vetUrl("https://app.localhost/x", prod), OutboundUrlError);
  const ok = await vetUrl("https://example.com/hooks", prod);
  assert.ok(ok.addresses.every((entry) => isPublicAddress(entry.address)));
  assert.ok(await vetUrl("http://localhost:4298/hooks", dev));
});

test("pinned POST: no redirects followed, response capped", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    if (req.url === "/redirect") { res.writeHead(302, { location: "http://169.254.169.254/latest" }); return res.end(); }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("x".repeat(200_000));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const redirect = await pinnedPost(await vetUrl(`http://localhost:${port}/redirect`, dev), { headers: {}, body: "{}", timeoutMs: 3000 });
    assert.equal(redirect.status, 302);
    assert.equal(hits, 1, "redirect must not be followed");
    const big = await pinnedPost(await vetUrl(`http://localhost:${port}/big`, dev), { headers: {}, body: "{}", timeoutMs: 3000, maxBytes: 1024 });
    assert.equal(big.status, 200);
    assert.equal(big.truncated, true);
    assert.ok(big.body.length <= 1024);
  } finally { server.close(); }
});

test("csvSafe neutralises formulas", () => {
  assert.equal(csvSafe("=HYPERLINK(\"http://x\")"), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvSafe("+91 98"), "'+91 98");
  assert.equal(csvSafe("-2+3"), "'-2+3");
  assert.equal(csvSafe("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvSafe("\tcmd"), "'\tcmd");
  assert.equal(csvSafe("-1250.00"), "-1250.00");
  assert.equal(csvSafe("Ravi Kumar"), "Ravi Kumar");
  assert.equal(csvSafe("a,b"), `"a,b"`);
});

test("email helpers", () => {
  assert.equal(escapeHtml(`<script>alert("x")</script>&'`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
  assert.equal(headerSafe("Hello\r\nBcc: victim@example.com"), "Hello Bcc: victim@example.com");
  assert.equal(headerSafe("x".repeat(400)).length, 250);
});

test("connection is pinned to the vetted address (no second DNS lookup), Host header keeps the name", async () => {
  let host = "";
  const server = createServer((req, res) => { host = String(req.headers.host); res.end("ok"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    // "rebind.invalid" cannot resolve: success proves the socket used the pinned address, not a fresh lookup.
    const response = await pinnedPost({ url: new URL(`http://rebind.invalid:${port}/hook`), addresses: [{ address: "127.0.0.1", family: 4 }] },
      { headers: {}, body: "{}", timeoutMs: 3000 });
    assert.equal(response.status, 200);
    assert.equal(host, `rebind.invalid:${port}`);
  } finally { server.close(); }
});

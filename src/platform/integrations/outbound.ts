import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * Guard for every outbound HTTP call to a URL an organization can configure (webhook subscriptions today).
 *
 *  1. Parse the URL; no credentials; https only in production (plain http only for an explicit localhost name in development).
 *  2. Resolve DNS ourselves and refuse when ANY resolved address is not public unicast (loopback, RFC 1918, CGNAT,
 *     link-local / cloud metadata, ULA, multicast, documentation, IPv4-mapped/NAT64/6to4 wrappers of those…).
 *  3. Connect to the vetted address only (custom `lookup`), so a DNS rebind between check and connect cannot redirect
 *     the request; SNI and the Host header still carry the hostname, so TLS verification is unchanged.
 *  4. Never follow redirects, cap the response body and enforce one overall timeout.
 */

export class OutboundUrlError extends Error {}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as [string, number][]) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2001:10::", 28], ["fc00::", 7], ["fe80::", 10],
  ["fec0::", 10], ["ff00::", 8],
] as [string, number][]) blocked.addSubnet(net, prefix, "ipv6");

/** IPv4 embedded in an IPv6 wrapper (::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::/96 NAT64, 2002::/16 6to4), else null. */
function embeddedV4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:(?:0:)?|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const expanded = expandV6(lower);
  if (!expanded) return null;
  const hex = (i: number) => parseInt(expanded[i], 16);
  const fromWords = (a: number, b: number) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  // ::ffff:x:y, ::x:y (IPv4-compatible), 64:ff9b::x:y
  if (expanded.slice(0, 5).every((w) => w === "0") && (expanded[5] === "ffff" || expanded[5] === "0")) return fromWords(hex(6), hex(7));
  if (expanded[0] === "64" && expanded[1] === "ff9b" && expanded.slice(2, 6).every((w) => w === "0")) return fromWords(hex(6), hex(7));
  if (expanded[0] === "2002") return fromWords(hex(1), hex(2));
  return null;
}

function expandV6(address: string): string[] | null {
  if (address.includes(".")) return null;
  const [head, tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  if (address.includes("::")) {
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    return [...left, ...Array(fill).fill("0"), ...right].map((w) => w.replace(/^0+(?=.)/, "") || "0");
  }
  return left.length === 8 ? left.map((w) => w.replace(/^0+(?=.)/, "") || "0") : null;
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  const clean = address.replace(/^\[|\]$/g, "").split("%")[0];
  const family = isIP(clean);
  if (family === 4) return !blocked.check(clean, "ipv4");
  if (family === 6) {
    const v4 = embeddedV4(clean);
    if (v4) return !blocked.check(v4, "ipv4");
    return !blocked.check(clean, "ipv6");
  }
  return false;
}

const LOCAL_NAMES = (host: string) => host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]" || host === "::1";
const isLoopback = (address: string) => {
  const clean = address.replace(/^\[|\]$/g, "");
  return clean === "::1" || (isIP(clean) === 4 && clean.startsWith("127.")) || embeddedV4(clean)?.startsWith("127.") === true;
};

export type OutboundPolicy = { production: boolean };
export type VettedTarget = { url: URL; addresses: { address: string; family: number }[] };

/** Validates syntax + scheme (no DNS). Throws OutboundUrlError with a user-facing message. */
export function checkUrlSyntax(value: string, policy: OutboundPolicy): URL {
  let url: URL;
  try { url = new URL(String(value).trim()); } catch { throw new OutboundUrlError("Enter a valid URL."); }
  if (url.username || url.password) throw new OutboundUrlError("Do not put credentials in the URL — verify our signature instead.");
  const host = url.hostname.toLowerCase();
  const devLocal = !policy.production && LOCAL_NAMES(host);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && devLocal) return url;
  throw new OutboundUrlError(policy.production
    ? "URLs must use https://."
    : "URLs must use https:// (plain http is allowed only for localhost in development).");
}

/** Full check: syntax, then DNS — every resolved address must be public (development: explicit localhost names may be loopback). */
export async function vetUrl(value: string, policy: OutboundPolicy): Promise<VettedTarget> {
  const url = checkUrlSyntax(value, policy);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const devLocal = !policy.production && LOCAL_NAMES(url.hostname.toLowerCase());
  let addresses: { address: string; family: number }[];
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
  else {
    if (host.endsWith(".localhost") || host === "localhost") addresses = [{ address: "127.0.0.1", family: 4 }];
    else {
      try { addresses = await dnsLookup(host, { all: true, verbatim: true }); } catch { throw new OutboundUrlError(`Could not resolve ${host}.`); }
    }
  }
  if (!addresses.length) throw new OutboundUrlError(`Could not resolve ${host}.`);
  const bad = addresses.filter((entry) => !(isPublicAddress(entry.address) || (devLocal && isLoopback(entry.address))));
  if (bad.length) throw new OutboundUrlError("This URL points to a private, loopback or link-local address. Use a publicly reachable endpoint.");
  return { url, addresses };
}

export type OutboundResponse = { status: number; headers: IncomingHttpHeaders; body: string; truncated: boolean };

/**
 * POSTs to a vetted target, connecting only to the vetted address(es). No redirects (3xx is returned as-is),
 * response body capped at `maxBytes`, whole exchange bounded by `timeoutMs`.
 */
export function pinnedPost(target: VettedTarget, input: { headers: Record<string, string>; body: string; timeoutMs: number; maxBytes?: number }): Promise<OutboundResponse> {
  const maxBytes = input.maxBytes ?? 64 * 1024;
  const pinned = target.addresses[0];
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [pinned]);
    else callback(null, pinned.address, pinned.family);
  };
  const send = target.url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const body = Buffer.from(input.body);
    const req = send(target.url, {
      method: "POST", lookup, agent: false,
      headers: { ...input.headers, "content-length": String(body.length) },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      res.on("data", (chunk: Buffer) => {
        if (truncated) return;
        size += chunk.length;
        if (size > maxBytes) { truncated = true; chunks.push(chunk.subarray(0, Math.max(0, maxBytes - (size - chunk.length)))); res.destroy(); finish(); return; }
        chunks.push(chunk);
      });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), truncated });
      };
      res.on("end", finish);
      res.on("close", finish);
      res.on("error", (error) => { if (!done) { done = true; clearTimeout(timer); reject(error); } });
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`Timed out after ${input.timeoutMs / 1000}s`), { name: "TimeoutError" })), input.timeoutMs);
    timer.unref?.();
    req.on("error", (error) => { clearTimeout(timer); reject(error); });
    req.end(body);
  });
}

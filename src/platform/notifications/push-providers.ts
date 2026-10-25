// Push delivery providers: APNs (HTTP/2 + ES256 provider token), FCM HTTP v1 (service-account OAuth) and a development
// provider that writes payloads to .data/push and can hand them to the iOS simulator (xcrun simctl push).
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import http2 from "node:http2";
import { join, resolve } from "node:path";
import { importPKCS8, SignJWT } from "jose";
import { apnsPayload, classifyApns, classifyFcm, fcmMessage, maskToken, type Classified, type Outcome, type PushMessage } from "./push-policy";

export type PushTarget = { deviceId: string; platform: string; provider: string; token: string; environment: string; bundleId: string | null };
export type SendResult = {
  provider: "apns" | "fcm" | "dev";
  outcome: Outcome;
  httpStatus: number | null;
  messageId: string | null;
  response: Record<string, unknown> | null;
  error: string | null;
  durationMs: number;
};

const DEFAULT_BUNDLE_ID = "com.northstar.people";
const SEND_TIMEOUT_MS = 15_000;

function result(provider: SendResult["provider"], classified: Classified, started: number, extra: Partial<SendResult> = {}): SendResult {
  return {
    provider, outcome: classified.outcome, httpStatus: null, messageId: null, response: null,
    error: classified.outcome === "SENT" ? null : classified.reason, durationMs: Date.now() - started, ...extra,
  };
}

function readSecret(inline: string | undefined, path: string | undefined) {
  if (inline && inline.trim()) return inline.includes("\\n") ? inline.replace(/\\n/g, "\n") : inline;
  if (path && path.trim()) return readFileSync(resolve(path), "utf8");
  return "";
}

// ---- APNs -----------------------------------------------------------------------------------------------------------

/** Apple Push Notification service, token-based auth. Env: APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_P8|APNS_KEY_PATH, APNS_BUNDLE_ID, APNS_ENV. */
export class ApnsProvider {
  private jwt?: { token: string; issuedAt: number };
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();
  constructor(private readonly logger: Logger) {}

  get configured() {
    return !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && (process.env.APNS_KEY_P8 || process.env.APNS_KEY_PATH));
  }

  /** Provider tokens are valid for 1 h and Apple rejects refreshing more than every 20 min: reuse for 50 min. */
  private async providerToken(force = false) {
    if (!force && this.jwt && Date.now() - this.jwt.issuedAt < 50 * 60_000) return this.jwt.token;
    const key = await importPKCS8(readSecret(process.env.APNS_KEY_P8, process.env.APNS_KEY_PATH), "ES256");
    const issuedAt = Date.now();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: process.env.APNS_KEY_ID! })
      .setIssuer(process.env.APNS_TEAM_ID!)
      .setIssuedAt(Math.floor(issuedAt / 1000))
      .sign(key);
    this.jwt = { token, issuedAt };
    return token;
  }

  private session(host: string) {
    const existing = this.sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = http2.connect(`https://${host}`);
    session.on("error", (error) => { this.logger.warn(`APNs session error (${host}): ${error.message}`); this.sessions.delete(host); });
    session.on("goaway", () => this.sessions.delete(host));
    session.on("close", () => this.sessions.delete(host));
    session.unref();
    this.sessions.set(host, session);
    return session;
  }

  private host(environment: string) {
    const env = environment === "sandbox" || environment === "production" ? environment : (process.env.APNS_ENV || "production");
    return env === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  }

  async send(target: PushTarget, message: PushMessage, retryAuth = true): Promise<SendResult> {
    const started = Date.now();
    const topic = target.bundleId || process.env.APNS_BUNDLE_ID || DEFAULT_BUNDLE_ID;
    const body = JSON.stringify(apnsPayload(message));
    try {
      const token = await this.providerToken();
      const { status, headers, text } = await new Promise<{ status: number; headers: http2.IncomingHttpHeaders; text: string }>((resolvePromise, reject) => {
        const request = this.session(this.host(target.environment)).request({
          ":method": "POST", ":path": `/3/device/${target.token}`,
          authorization: `bearer ${token}`, "apns-topic": topic, "apns-push-type": "alert", "apns-priority": "10",
          "apns-expiration": String(Math.floor(Date.now() / 1000) + 24 * 3600), "apns-collapse-id": `${message.category}-${message.notificationId}`.slice(0, 64),
          "content-type": "application/json", "content-length": Buffer.byteLength(body),
        });
        let responseHeaders: http2.IncomingHttpHeaders = {};
        let chunks = "";
        request.setEncoding("utf8");
        request.setTimeout(SEND_TIMEOUT_MS, () => request.close(http2.constants.NGHTTP2_CANCEL));
        request.on("response", (value) => { responseHeaders = value; });
        request.on("data", (chunk: string) => { chunks += chunk; });
        request.on("end", () => resolvePromise({ status: Number(responseHeaders[":status"] || 0), headers: responseHeaders, text: chunks }));
        request.on("error", reject);
        request.on("close", () => { if (!responseHeaders[":status"]) reject(new Error("APNs request closed without a response (timeout)")); });
        request.end(body);
      });
      let parsed: Record<string, unknown> | null = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 500) }; }
      const classified = classifyApns(status, parsed);
      if (classified.refreshAuth && retryAuth) { await this.providerToken(true); return this.send(target, message, false); }
      return result("apns", classified, started, {
        httpStatus: status, messageId: (headers["apns-id"] as string) || null,
        response: { ...(parsed || {}), apnsId: headers["apns-id"] || null, host: this.host(target.environment) },
      });
    } catch (error) {
      return result("apns", { outcome: "RETRY", reason: error instanceof Error ? error.message : String(error) }, started);
    }
  }

  close() { for (const session of this.sessions.values()) session.close(); this.sessions.clear(); }
}

// ---- FCM ------------------------------------------------------------------------------------------------------------

type ServiceAccount = { client_email: string; private_key: string; project_id?: string; token_uri?: string };

/** Firebase Cloud Messaging HTTP v1. Env: FCM_PROJECT_ID + FCM_SERVICE_ACCOUNT_JSON (inline JSON) or FCM_SERVICE_ACCOUNT_PATH. */
export class FcmProvider {
  private access?: { token: string; expiresAt: number };
  private account?: ServiceAccount;
  constructor(private readonly logger: Logger) {}

  get configured() {
    return !!((process.env.FCM_SERVICE_ACCOUNT_JSON || process.env.FCM_SERVICE_ACCOUNT_PATH) && (process.env.FCM_PROJECT_ID || this.loadAccount()?.project_id));
  }

  private loadAccount(): ServiceAccount | undefined {
    if (this.account) return this.account;
    try {
      const raw = process.env.FCM_SERVICE_ACCOUNT_JSON?.trim() || (process.env.FCM_SERVICE_ACCOUNT_PATH ? readFileSync(resolve(process.env.FCM_SERVICE_ACCOUNT_PATH), "utf8") : "");
      if (!raw) return undefined;
      this.account = JSON.parse(raw) as ServiceAccount;
      return this.account;
    } catch (error) {
      this.logger.error(`FCM service account could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** OAuth 2.0 access token from a self-signed RS256 assertion (cached until 60 s before expiry). */
  private async accessToken(force = false) {
    if (!force && this.access && Date.now() < this.access.expiresAt - 60_000) return this.access.token;
    const account = this.loadAccount();
    if (!account) throw new Error("FCM service account is not configured");
    const tokenUri = account.token_uri || "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(account.client_email).setSubject(account.client_email).setAudience(tokenUri)
      .setIssuedAt(now).setExpirationTime(now + 3600)
      .sign(await importPKCS8(account.private_key, "RS256"));
    const response = await fetch(tokenUri, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const json = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!response.ok || !json.access_token) throw new Error(`FCM OAuth failed: ${json.error || response.status}`);
    this.access = { token: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 };
    return this.access.token;
  }

  async send(target: PushTarget, message: PushMessage, retryAuth = true): Promise<SendResult> {
    const started = Date.now();
    try {
      const project = process.env.FCM_PROJECT_ID || this.loadAccount()?.project_id;
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(String(project))}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json" },
        body: JSON.stringify(fcmMessage(message, target.token)),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const classified = classifyFcm(response.status, json);
      if (classified.refreshAuth && retryAuth) { await this.accessToken(true); return this.send(target, message, false); }
      return result("fcm", classified, started, { httpStatus: response.status, messageId: typeof json?.name === "string" ? json.name : null, response: json });
    } catch (error) {
      return result("fcm", { outcome: "RETRY", reason: error instanceof Error ? error.message : String(error) }, started);
    }
  }
}

// ---- development ----------------------------------------------------------------------------------------------------

/**
 * Used when the real provider is not configured (outside production) and always for devices registered with
 * environment "simulator". Writes the APNs/FCM payload to .data/push/<ts>-<notification>-<device>.json and, when
 * DEV_PUSH_SIMCTL=true and the device is an iOS simulator, runs `xcrun simctl push <DEV_PUSH_SIMCTL_DEVICE|booted> <bundle> <file>`.
 * Tokens starting with "invalid-" simulate APNs 410 Unregistered / FCM UNREGISTERED so dead-token handling can be exercised.
 */
export class DevProvider {
  private readonly root = resolve(process.env.DEV_PUSH_PATH || join(process.cwd(), ".data", "push"));
  constructor(private readonly logger: Logger) {}

  async send(target: PushTarget, message: PushMessage): Promise<SendResult> {
    const started = Date.now();
    if (target.token.startsWith("invalid-")) {
      const classified = target.provider === "fcm"
        ? classifyFcm(404, { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } })
        : classifyApns(410, { reason: "Unregistered" });
      return result("dev", classified, started, { httpStatus: target.provider === "fcm" ? 404 : 410, response: { simulated: true } });
    }
    const bundleId = target.bundleId || process.env.APNS_BUNDLE_ID || DEFAULT_BUNDLE_ID;
    const payload = target.provider === "fcm" ? fcmMessage(message, maskToken(target.token)) : { ...apnsPayload(message), "Simulator Target Bundle": bundleId };
    await mkdir(this.root, { recursive: true });
    const file = join(this.root, `${new Date().toISOString().replace(/[:.]/g, "-")}-${message.notificationId}-${target.deviceId.slice(0, 8)}.json`);
    await writeFile(file, JSON.stringify(payload, null, 2));
    const response: Record<string, unknown> = { file, token: maskToken(target.token) };
    if (process.env.DEV_PUSH_SIMCTL === "true" && target.environment === "simulator" && target.platform === "ios") {
      const device = process.env.DEV_PUSH_SIMCTL_DEVICE || "booted";
      try {
        const output = await new Promise<string>((resolvePromise, reject) =>
          execFile("xcrun", ["simctl", "push", device, bundleId, file], { timeout: 10_000 }, (error, stdout, stderr) =>
            error ? reject(new Error(`${error.message}${stderr ? `: ${stderr.trim()}` : ""}`)) : resolvePromise(`${stdout}${stderr}`.trim())));
        response.simctl = { ok: true, device, output: output.slice(0, 500) };
        this.logger.log(JSON.stringify({ event: "dev_push_simctl", device, bundleId, notificationId: message.notificationId, output: output.slice(0, 200) }));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        response.simctl = { ok: false, device, error: reason.slice(0, 500) };
        this.logger.warn(JSON.stringify({ event: "dev_push_simctl_failed", device, error: reason.slice(0, 200) }));
        return result("dev", { outcome: "FAILED", reason: `simctl push failed: ${reason.slice(0, 200)}` }, started, { response });
      }
    }
    return result("dev", { outcome: "SENT", reason: null }, started, { httpStatus: 200, messageId: `dev-${message.notificationId}`, response });
  }
}

/** Chooses the provider per device. Real providers need configuration; development falls back to DevProvider. */
@Injectable()
export class PushProviders implements OnModuleDestroy {
  private readonly logger = new Logger("Push");
  readonly apns = new ApnsProvider(this.logger);
  readonly fcm = new FcmProvider(this.logger);
  readonly dev = new DevProvider(this.logger);

  mode() {
    return { apns: this.apns.configured ? "apns" : "dev", fcm: this.fcm.configured ? "fcm" : "dev", simctl: process.env.DEV_PUSH_SIMCTL === "true" };
  }

  async send(target: PushTarget, message: PushMessage): Promise<SendResult> {
    if (target.environment === "simulator") {
      if (process.env.NODE_ENV === "production") return result("dev", { outcome: "FAILED", reason: "Simulator devices are not served in production" }, Date.now());
      return this.dev.send(target, message);
    }
    if (target.provider === "apns" && this.apns.configured) return this.apns.send(target, message);
    if (target.provider === "fcm" && this.fcm.configured) return this.fcm.send(target, message);
    if (process.env.NODE_ENV === "production")
      return result(target.provider === "fcm" ? "fcm" : "apns", { outcome: "FAILED", reason: `${target.provider.toUpperCase()} is not configured` }, Date.now());
    return this.dev.send(target, message);
  }

  onModuleDestroy() { this.apns.close(); }
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Logger } from "@nestjs/common";

/**
 * Secrets for devices and webhook subscriptions are derived, never stored:
 *   secret = HMAC-SHA256(INTEGRATIONS_MASTER_KEY, "<purpose>:<record id>:<salt>")
 * The database keeps only the random salt and SHA-256(secret). A database dump alone therefore reveals no usable
 * secret, while the server can still re-derive the key it needs to verify or produce HMAC signatures.
 * Rotating a secret = new salt. Revoking = clearing the salt.
 */
const isProduction = () => (process.env.NODE_ENV || "development") === "production";
export const MIN_MASTER_KEY = 32;
export const MIN_WEBHOOK_SECRET = 24;

/**
 * Development only: a random secret generated once per install and kept in <DATA_DIR or ./.data>/secrets/<name>.key
 * (mode 0600). The API and the worker read the same file; the first process to start creates it atomically (O_EXCL).
 * Nothing secret is ever a constant in source.
 */
const devCache = new Map<string, string>();
export function devInstallSecret(name: "integrations-master" | "payouts-webhook"): string {
  if (isProduction()) throw new Error(`Refusing to use a generated ${name} secret in production.`);
  const cached = devCache.get(name);
  if (cached) return cached;
  const dir = resolve(process.env.DATA_DIR || join(process.cwd(), ".data"), "secrets");
  const file = join(dir, `${name}.key`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
    new Logger("Integrations").warn(`Generated a development ${name} secret in ${file} (set the environment variable for real deployments).`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const value = readFileSync(file, "utf8").trim();
  if (value.length < MIN_MASTER_KEY) throw new Error(`${file} is corrupt (expected 64 hex characters). Delete it to regenerate.`);
  devCache.set(name, value);
  return value;
}

let warned = false;
function masterKey() {
  const key = process.env.INTEGRATIONS_MASTER_KEY || "";
  if (key.length >= MIN_MASTER_KEY) return key;
  if (isProduction()) throw new Error(`INTEGRATIONS_MASTER_KEY (${MIN_MASTER_KEY}+ characters) is required in production.`);
  if (key && !warned) new Logger("Integrations").warn(`INTEGRATIONS_MASTER_KEY is shorter than ${MIN_MASTER_KEY} characters; ignoring it and using the per-install development key.`);
  warned = true;
  return devInstallSecret("integrations-master");
}
export const masterKeyConfigured = () => (process.env.INTEGRATIONS_MASTER_KEY || "").length >= MIN_MASTER_KEY;

/**
 * Called at boot (IntegrationsModule.onModuleInit, so both the API and the worker): in production the process refuses
 * to start without a strong INTEGRATIONS_MASTER_KEY, or with a PAYOUTS_WEBHOOK_SECRET that is set but too short.
 * (A missing PAYOUTS_WEBHOOK_SECRET only disables the inbound payout webhook, which then answers 503.)
 */
export function assertIntegrationSecrets() {
  if (!isProduction()) return;
  const problems: string[] = [];
  if ((process.env.INTEGRATIONS_MASTER_KEY || "").length < MIN_MASTER_KEY) problems.push(`INTEGRATIONS_MASTER_KEY must be set to ${MIN_MASTER_KEY}+ random characters`);
  const payout = process.env.PAYOUTS_WEBHOOK_SECRET || "";
  if (payout && payout.length < MIN_WEBHOOK_SECRET) problems.push(`PAYOUTS_WEBHOOK_SECRET must be at least ${MIN_WEBHOOK_SECRET} characters`);
  if (problems.length) throw new Error(`Integrations cannot start in production: ${problems.join("; ")}.`);
}

export const newSalt = () => randomBytes(16).toString("hex");
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const hmacHex = (key: string, value: string | Buffer) => createHmac("sha256", key).update(value).digest("hex");

export function deriveSecret(purpose: "device" | "comm" | "webhook", id: string, salt: string) {
  const raw = createHmac("sha256", masterKey()).update(`${purpose}:${id}:${salt}`).digest();
  if (purpose === "comm") {
    // ADMS comm key: 12 digits, typed into the device's cloud-server settings.
    const n = raw.readBigUInt64BE(0) % 1_000_000_000_000n;
    return n.toString().padStart(12, "0");
  }
  return `${purpose === "device" ? "nsd" : "whsec"}_${raw.toString("base64url")}`;
}

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const last4 = (value: string | null | undefined) => (value ? value.slice(-4) : null);
export const maskAccount = (lastFour: string | null | undefined) => (lastFour ? `••••${lastFour}` : "—");

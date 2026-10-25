/**
 * Field-level envelope encryption for statutory and bank identifiers (PAN, UAN, ESI IP number, bank account).
 *
 * - AES-256-GCM, fresh random 96-bit IV per value, 128-bit tag.
 * - Ciphertext format: "v1:<kid>:<iv>:<tag>:<ct>" (base64url parts). The key id makes rotation possible: new values are
 *   written with DATA_ENCRYPTION_ACTIVE_KEY, old values stay readable while their key is in the ring, and
 *   scripts/encrypt-sensitive-fields.mjs --rotate re-encrypts everything under the active key.
 * - Associated data binds every ciphertext to (table, column, organization_id, row id): a value copied into another row,
 *   column or brand fails authentication instead of decrypting.
 * - Blind index: HMAC-SHA256 under a separate key (DATA_INDEX_KEY), scoped per organization and per kind, for equality
 *   lookups (duplicate PAN, same bank account) without decrypting.
 * - Masks are computed from the stored last-4 hint so list screens never need to decrypt.
 *
 * Key sources:
 *   DATA_ENCRYPTION_KEYS="k1:<base64 32 bytes>,k2:<base64 32 bytes>"  DATA_ENCRYPTION_ACTIVE_KEY=k2  DATA_INDEX_KEY=<base64 32 bytes>
 * or a KMS: install a KmsAdapter with `initFieldCryptoFromKms()` at boot; data keys are then held wrapped in
 * DATA_ENCRYPTION_WRAPPED_KEYS="k3:<wrapped base64>" and unwrapped once into memory. Production refuses to start without keys.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type FieldContext = { table: string; column: string; organizationId: string; rowId: string };
export type SensitiveKind = "pan" | "uan" | "esi" | "bank_account" | "aadhaar";

/** Pluggable key-encryption-key provider (AWS KMS, GCP KMS, Vault transit …). Only data keys pass through it. */
export interface KmsAdapter {
  encryptDataKey(plaintextKey: Buffer, keyId: string): Promise<string>;
  decryptDataKey(wrappedKey: string, keyId: string): Promise<Buffer>;
}

type Ring = { keys: Map<string, Buffer>; active: string; indexKey: Buffer };
let ring: Ring | null = null;

const b64u = (buffer: Buffer) => buffer.toString("base64url");
const fromB64u = (text: string) => Buffer.from(text, "base64url");

function parseKey(text: string, label: string) {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== 32) throw new Error(`${label} must be 32 bytes, base64 encoded (openssl rand -base64 32).`);
  return key;
}

function parseKeyList(value: string) {
  const keys = new Map<string, Buffer>();
  for (const entry of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const at = entry.indexOf(":");
    const kid = entry.slice(0, at);
    if (at < 1 || !/^[A-Za-z0-9_-]{1,32}$/.test(kid)) throw new Error("DATA_ENCRYPTION_KEYS entries must look like <kid>:<base64 key>.");
    keys.set(kid, parseKey(entry.slice(at + 1), `DATA_ENCRYPTION_KEYS ${kid}`));
  }
  return keys;
}

function fromEnv(env: NodeJS.ProcessEnv = process.env): Ring {
  const list = env.DATA_ENCRYPTION_KEYS || "";
  if (!list || !env.DATA_INDEX_KEY) {
    throw new Error("Field encryption keys are missing: set DATA_ENCRYPTION_KEYS, DATA_ENCRYPTION_ACTIVE_KEY and DATA_INDEX_KEY "
      + (env.NODE_ENV === "production" ? "(production refuses to start without them)." : "(in development they are generated into .env)."));
  }
  const keys = parseKeyList(list);
  const active = env.DATA_ENCRYPTION_ACTIVE_KEY || [...keys.keys()].pop()!;
  if (!keys.has(active)) throw new Error(`DATA_ENCRYPTION_ACTIVE_KEY "${active}" is not in DATA_ENCRYPTION_KEYS.`);
  return { keys, active, indexKey: parseKey(env.DATA_INDEX_KEY, "DATA_INDEX_KEY") };
}

function current(): Ring {
  if (!ring) ring = fromEnv();
  return ring;
}

/** Validates configuration at boot. Throws (refusing to start) if keys are missing or malformed. */
export function assertFieldCryptoConfigured() {
  current();
  return { activeKey: ring!.active, keys: [...ring!.keys.keys()] };
}

/** Boot-time KMS path: unwraps DATA_ENCRYPTION_WRAPPED_KEYS with the adapter and merges them into the ring. */
export async function initFieldCryptoFromKms(adapter: KmsAdapter, env: NodeJS.ProcessEnv = process.env) {
  const keys = new Map<string, Buffer>(env.DATA_ENCRYPTION_KEYS ? parseKeyList(env.DATA_ENCRYPTION_KEYS) : []);
  for (const entry of (env.DATA_ENCRYPTION_WRAPPED_KEYS || "").split(",").map((item) => item.trim()).filter(Boolean)) {
    const at = entry.indexOf(":");
    const kid = entry.slice(0, at);
    const key = await adapter.decryptDataKey(entry.slice(at + 1), kid);
    if (key.length !== 32) throw new Error(`KMS data key ${kid} is not 32 bytes.`);
    keys.set(kid, key);
  }
  const active = env.DATA_ENCRYPTION_ACTIVE_KEY || [...keys.keys()].pop() || "";
  if (!keys.has(active)) throw new Error(`DATA_ENCRYPTION_ACTIVE_KEY "${active}" is not available.`);
  if (!env.DATA_INDEX_KEY) throw new Error("DATA_INDEX_KEY is required.");
  ring = { keys, active, indexKey: parseKey(env.DATA_INDEX_KEY, "DATA_INDEX_KEY") };
}

/** Generates a new data key and returns it wrapped by the KMS (for DATA_ENCRYPTION_WRAPPED_KEYS). */
export async function newWrappedDataKey(adapter: KmsAdapter, kid: string) {
  return `${kid}:${await adapter.encryptDataKey(randomBytes(32), kid)}`;
}

/** Test hook: replace the ring (or reset to env with null). */
export function setFieldCryptoEnv(env: NodeJS.ProcessEnv | null) { ring = env ? fromEnv(env) : null; }

const aad = (ctx: FieldContext) => Buffer.from(`v1|${ctx.table}|${ctx.column}|${ctx.organizationId}|${ctx.rowId}`, "utf8");

export function encryptField(plaintext: string | null | undefined, ctx: FieldContext): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === "") return null;
  if (!ctx.organizationId || !ctx.rowId) throw new Error("encryptField needs organizationId and rowId.");
  const { keys, active } = current();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.get(active)!, iv);
  cipher.setAAD(aad(ctx));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${active}:${b64u(iv)}:${b64u(cipher.getAuthTag())}:${b64u(ct)}`;
}

export class FieldDecryptError extends Error {}

export function decryptField(ciphertext: string | null | undefined, ctx: FieldContext): string | null {
  if (!ciphertext) return null;
  const parts = ciphertext.split(":");
  if (parts.length !== 5 || parts[0] !== "v1") throw new FieldDecryptError("Unsupported ciphertext format.");
  const [, kid, iv, tag, ct] = parts;
  const key = current().keys.get(kid);
  if (!key) throw new FieldDecryptError(`Encryption key "${kid}" is not in the key ring.`);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, fromB64u(iv));
    decipher.setAAD(aad(ctx));
    decipher.setAuthTag(fromB64u(tag));
    return Buffer.concat([decipher.update(fromB64u(ct)), decipher.final()]).toString("utf8");
  } catch {
    throw new FieldDecryptError(`Value in ${ctx.table}.${ctx.column} failed authentication (wrong row, brand or key).`);
  }
}

/** Key id a ciphertext was written with (rotation status). */
export const ciphertextKeyId = (ciphertext: string | null | undefined) => (ciphertext ? ciphertext.split(":")[1] || null : null);
export const activeKeyId = () => current().active;

export function normalize(kind: SensitiveKind, value: string) {
  const text = value.trim().toUpperCase();
  return kind === "pan" ? text.replace(/\s+/g, "") : text.replace(/[^0-9A-Z]/g, "");
}

/** Keyed, per-organization blind index for equality lookups. Same value + same brand + same kind → same hash. */
export function blindIndex(kind: SensitiveKind, value: string | null | undefined, organizationId: string): string | null {
  if (!value) return null;
  return `h1:${createHmac("sha256", current().indexKey).update(`${kind}|${organizationId}|${normalize(kind, value)}`).digest("base64url")}`;
}

export const sameIndex = (a: string | null, b: string | null) =>
  !!a && !!b && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const lastFour = (value: string | null | undefined) => (value ? value.replace(/\s+/g, "").slice(-4) : null);

/** Display mask from the stored last-4 hint: PAN XXXXXX234F, Aadhaar XXXX XXXX 6789, accounts/UAN XXXXXX6789. */
export function mask(kind: SensitiveKind, last4: string | null | undefined): string | null {
  if (!last4) return null;
  switch (kind) {
    case "pan": return `XXXXXX${last4}`;
    case "aadhaar": return `XXXX XXXX ${last4}`;
    case "uan": return `XXXXXXXX${last4}`;
    default: return `XXXXXX${last4}`;
  }
}

/** One sensitive column: encrypted value, blind index and last-4 hint, ready for an INSERT/UPDATE. */
export function sealField(kind: SensitiveKind, plaintext: string | null | undefined, ctx: FieldContext) {
  const value = plaintext ? normalize(kind, plaintext) : null;
  return { enc: encryptField(value, ctx), hash: blindIndex(kind, value, ctx.organizationId), last4: lastFour(value) };
}

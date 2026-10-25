/**
 * Password hashing and policy for first-party sign-in.
 *
 * Hash format (self-describing, so cost can be raised later and old hashes upgraded on the next successful sign-in):
 *   scrypt$1$N=32768,r=8,p=3$<salt base64url>$<64-byte key base64url>
 * Parameters follow the OWASP scrypt recommendation (N=2^15, r=8, p=3 ≈ 32 MiB, tens of ms per hash on a server core).
 * Every comparison is constant time. Unknown accounts still pay for one hash (dummyVerify) so timing does not reveal
 * whether an email exists.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { COMMON_PASSWORDS_TEXT } from "./common-passwords";

export type ScryptParams = { N: number; r: number; p: number };
export const CURRENT_PARAMS: ScryptParams = {
  N: Number(process.env.AUTH_SCRYPT_N || 32768),
  r: 8,
  p: Number(process.env.AUTH_SCRYPT_P || 3),
};
const KEY_LENGTH = 64;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

function scrypt(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 + 1024 * 1024 };
  return new Promise((resolve, reject) => scryptCallback(password.normalize("NFKC"), salt, KEY_LENGTH, options, (error, key) => (error ? reject(error) : resolve(key))));
}

export async function hashPassword(password: string, params: ScryptParams = CURRENT_PARAMS): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, params);
  return `scrypt$1$N=${params.N},r=${params.r},p=${params.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

function parse(stored: string): { params: ScryptParams; salt: Buffer; key: Buffer } | null {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "scrypt" || parts[1] !== "1") return null;
  const params = Object.fromEntries(parts[2].split(",").map((pair) => pair.split("=")).map(([k, v]) => [k, Number(v)])) as ScryptParams;
  if (![params.N, params.r, params.p].every((value) => Number.isInteger(value) && value > 0) || params.N > 2 ** 20 || params.p > 16 || params.r > 32) return null;
  return { params, salt: Buffer.from(parts[3], "base64url"), key: Buffer.from(parts[4], "base64url") };
}

/** Constant-time verification. Malformed or missing hashes never match (and still cost one hash). */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parsed = stored ? parse(stored) : null;
  if (!parsed || parsed.key.length !== KEY_LENGTH) { await dummyVerify(password); return false; }
  const key = await scrypt(password, parsed.salt, parsed.params);
  return timingSafeEqual(key, parsed.key);
}

let dummy: Promise<string> | null = null;
/** Burns the same work as a real verification (used when the account does not exist or has no password). */
export async function dummyVerify(password: string) {
  dummy ||= hashPassword("northstar-dummy-password-for-timing");
  const parsed = parse(await dummy)!;
  const key = await scrypt(password, parsed.salt, parsed.params);
  timingSafeEqual(key, parsed.key);
}

export function needsRehash(stored: string) {
  const parsed = parse(stored);
  return !parsed || parsed.params.N !== CURRENT_PARAMS.N || parsed.params.r !== CURRENT_PARAMS.r || parsed.params.p !== CURRENT_PARAMS.p;
}

// ---- policy ---------------------------------------------------------------------------------------------------------

let common: Set<string> | null = null;
const commonSet = () => (common ||= new Set(COMMON_PASSWORDS_TEXT.split("\n")));
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };

/** The password with leading/trailing digits and symbols removed and common leetspeak undone ("P@ssw0rd2024!" → "password"). */
function baseWord(lower: string) {
  const deLeet = lower.replace(/[013457@$!]/g, (char) => LEET[char] || char);
  const core = lower.replace(/^[^a-z]+|[^a-z]+$/g, "");
  return { core, deLeetCore: deLeet.replace(/^[^a-z]+|[^a-z]+$/g, ""), deLeet };
}

export type PolicyContext = { email?: string | null; fullName?: string | null; extraWords?: string[] };

/** Returns a user-facing reason the password is not acceptable, or null when it passes. */
export function passwordProblem(password: string, context: PolicyContext = {}): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(password)) return "Passwords can't contain control characters.";
  const lower = password.normalize("NFKC").toLowerCase();
  if (new Set(lower).size < 5) return "This password is too repetitive. Mix more different characters.";
  const set = commonSet();
  const { core, deLeetCore, deLeet } = baseWord(lower);
  const commonHit = set.has(lower) || set.has(deLeet)
    || (core.length >= 4 && set.has(core) && lower.length - core.length <= 6)
    || (deLeetCore.length >= 4 && set.has(deLeetCore) && lower.length - deLeetCore.length <= 6)
    // "passwordpassword", "qwertyqwerty"
    || [2, 3].some((times) => lower.length % times === 0 && lower === lower.slice(0, lower.length / times).repeat(times) && set.has(lower.slice(0, lower.length / times)));
  if (commonHit) return "This password is too common. Choose something harder to guess — a short phrase of unrelated words works well.";
  if (/^(?:0123456789|1234567890|abcdefghijkl|qwertyuiop|asdfghjkl)/.test(lower)) return "Avoid keyboard or number sequences.";
  const personal = [
    ...(context.email ? [context.email.split("@")[0], ...context.email.split("@")[0].split(/[._+-]/)] : []),
    ...(context.fullName ? context.fullName.split(/\s+/) : []),
    ...(context.extraWords || []),
  ].map((word) => word.toLowerCase().replace(/[^a-z0-9]/g, "")).filter((word) => word.length >= 3);
  if (personal.some((word) => lower.includes(word) || deLeet.includes(word))) return "Don't include your name or email address in your password.";
  return null;
}

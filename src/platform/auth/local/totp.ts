/**
 * TOTP (RFC 6238 over RFC 4226 HOTP): HMAC-SHA1, 6 digits, 30-second steps, ±1 step tolerance for clock drift.
 * Replay protection is done by the caller: a step is accepted only if it is greater than the device's last used step
 * (an atomic UPDATE ... WHERE last_used_step < $step), so the same code — or an older one — never works twice.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buffer: Buffer) {
  let bits = 0, value = 0, output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string) {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Invalid base32 secret.");
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

/** 160-bit secret (RFC 4226 recommends ≥ 128). */
export const newTotpSecret = () => base32Encode(randomBytes(20));

export function hotp(secret: Buffer, counter: number) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / TOTP_PERIOD);

/** The matching time step within ±window, or null. Every candidate is compared (constant time, no early exit). */
export function matchTotp(secretBase32: string, code: string, now = Date.now(), window = 1): number | null {
  const clean = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const secret = base32Decode(secretBase32);
  const step = currentStep(now);
  let matched: number | null = null;
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = hotp(secret, step + offset);
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(clean)) && matched === null) matched = step + offset;
  }
  return matched;
}

export function otpauthUrl(secretBase32: string, account: string, issuer = "Northstar People") {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---- recovery codes ---------------------------------------------------------------------------------------------------

/** 16 base32 characters (80 bits) shown as XXXX-XXXX-XXXX-XXXX. */
export function newRecoveryCode() {
  const raw = base32Encode(randomBytes(10)).slice(0, 16);
  return raw.match(/.{4}/g)!.join("-");
}
export const normalizeRecoveryCode = (code: string) => String(code || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
export const recoveryCodeHash = (userId: string, code: string) =>
  createHash("sha256").update(`northstar-recovery|${userId}|${normalizeRecoveryCode(code)}`).digest("hex");

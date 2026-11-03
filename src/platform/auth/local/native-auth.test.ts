import { test } from "node:test";
import assert from "node:assert/strict";
import { base32Decode, base32Encode, hotp, matchTotp, normalizeRecoveryCode, newRecoveryCode, otpauthUrl } from "./totp";
import { hashPassword, needsRehash, passwordProblem, verifyPassword } from "./password";

test("HOTP/TOTP match RFC 4226 / RFC 6238 test vectors", () => {
  const secret = Buffer.from("12345678901234567890");
  assert.deepEqual([0, 1, 2, 9].map((counter) => hotp(secret, counter)), ["755224", "287082", "359152", "520489"]);
  // RFC 6238 SHA1 vector T=59 → 94287082 (8 digits); 6-digit truncation is 287082
  const b32 = base32Encode(secret);
  assert.equal(base32Decode(b32).toString(), "12345678901234567890");
  assert.equal(matchTotp(b32, "287082", 59_000, 0), 1);
  assert.equal(matchTotp(b32, "287082", 89_000, 1), 1); // one step late is tolerated
  assert.equal(matchTotp(b32, "287082", 119_000, 1), null); // two steps late is not
  assert.equal(matchTotp(b32, "28708", 59_000), null);
  assert.match(otpauthUrl(b32, "a@b.example"), /^otpauth:\/\/totp\/ClanChief:a%40b.example\?secret=/);
});

test("recovery codes are 80-bit and normalise", () => {
  const code = newRecoveryCode();
  assert.match(code, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
  assert.equal(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, " ")), code.replace(/-/g, ""));
});

test("scrypt hashes verify, carry parameters and reject wrong passwords", async () => {
  const hash = await hashPassword("Copper-Lantern-Harbor-77");
  assert.match(hash, /^scrypt\$1\$N=\d+,r=8,p=\d+\$/);
  assert.equal(await verifyPassword("Copper-Lantern-Harbor-77", hash), true);
  assert.equal(await verifyPassword("Copper-Lantern-Harbor-78", hash), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
  assert.equal(needsRehash(hash), false);
  assert.equal(needsRehash(hash.replace(/N=\d+/, "N=16384")), true);
});

test("password policy", () => {
  assert.ok(passwordProblem("short"));
  assert.ok(passwordProblem("password1234"));
  assert.ok(passwordProblem("P@ssw0rd2024!"));
  assert.ok(passwordProblem("qwertyqwerty"));
  assert.ok(passwordProblem("aaaaaaaaaaaaaa"));
  assert.ok(passwordProblem("Ravi-Kumar-Coffee-2026", { fullName: "Ravi Kumar" }));
  assert.ok(passwordProblem("employee-of-the-month", { email: "employee@bluetokai.example" }));
  assert.equal(passwordProblem("Copper-Lantern-Harbor-77", { fullName: "Ravi Kumar", email: "ravi@x.example" }), null);
});

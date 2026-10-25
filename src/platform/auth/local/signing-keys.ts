/**
 * The API's own token-signing key (first-party sessions).
 *
 *   AUTH_SIGNING_KEY   PKCS#8 PEM or private JWK (JSON) — Ed25519 (EdDSA, preferred) or P-256 (ES256). "\n" escapes allowed.
 *   AUTH_PREVIOUS_PUBLIC_KEYS  optional JSON array of public JWKs still accepted during a key rotation.
 *   AUTH_ISSUER        iss of first-party tokens (must differ from OIDC_ISSUER). Required in production.
 *   AUTH_AUDIENCE      aud (defaults to OIDC_AUDIENCE, then "northstar-api").
 *   AUTH_ACCESS_TTL_SECONDS  access-token lifetime, 300–900 (default 600).
 *
 * Development without AUTH_SIGNING_KEY: an Ed25519 key is generated once into <DATA_DIR or ./.data>/secrets/
 * auth-signing-key.pem (mode 0600, O_EXCL so the API and worker agree). Production refuses to start without the env key.
 */
import { Logger } from "@nestjs/common";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { calculateJwkThumbprint, decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, SignJWT, type JWK, type JWTPayload } from "jose";

const isProduction = () => (process.env.NODE_ENV || "development") === "production";
export const LOCAL_TOKEN_TYPE = "at+jwt";

export type LocalClaims = JWTPayload & { sid: string; amr: string[] };

type VerifyKey = { kid: string; alg: "EdDSA" | "ES256"; key: KeyObject | CryptoKey | Uint8Array };

function algFor(key: KeyObject): "EdDSA" | "ES256" {
  if (key.asymmetricKeyType === "ed25519") return "EdDSA";
  if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") return "ES256";
  throw new Error("AUTH_SIGNING_KEY must be an Ed25519 or P-256 private key.");
}

function devKeyPem() {
  if (isProduction()) throw new Error("AUTH_SIGNING_KEY is required in production (Ed25519 or P-256 private key, PEM or JWK).");
  const dir = resolve(process.env.DATA_DIR || join(process.cwd(), ".data"), "secrets");
  const file = join(dir, "auth-signing-key.pem");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { flag: "wx", mode: 0o600 });
    new Logger("NativeAuth").warn(`Generated a development token-signing key in ${file} (set AUTH_SIGNING_KEY for real deployments).`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readFileSync(file, "utf8");
}

function loadPrivateKey(): KeyObject {
  const raw = (process.env.AUTH_SIGNING_KEY || "").trim();
  if (!raw) return createPrivateKey(devKeyPem());
  const text = raw.replace(/\\n/g, "\n");
  if (text.startsWith("{")) return createPrivateKey({ key: JSON.parse(text), format: "jwk" });
  return createPrivateKey(text);
}

export class LocalTokenKeys {
  private signing?: { key: KeyObject; kid: string; alg: "EdDSA" | "ES256"; publicJwk: JWK };
  private verifiers: VerifyKey[] = [];
  private ready?: Promise<void>;
  readonly issuer: string;
  readonly audience: string;
  readonly accessTtl: number;

  constructor() {
    const port = Number(process.env.BACKEND_V2_PORT || 4100);
    this.issuer = (process.env.AUTH_ISSUER || (isProduction() ? "" : `http://localhost:${port}`)).replace(/\/$/, "");
    this.audience = process.env.AUTH_AUDIENCE || process.env.OIDC_AUDIENCE || "northstar-api";
    this.accessTtl = Math.min(Math.max(Number(process.env.AUTH_ACCESS_TTL_SECONDS || 600), 300), 900);
  }

  /** Production boot check: refuse to start without a signing key and an issuer distinct from the OIDC IdP. */
  assertConfigured() {
    const problems: string[] = [];
    if (isProduction() && !process.env.AUTH_SIGNING_KEY) problems.push("AUTH_SIGNING_KEY is required in production");
    if (!this.issuer) problems.push("AUTH_ISSUER is required in production");
    if (this.issuer && process.env.OIDC_ISSUER && this.issuer === process.env.OIDC_ISSUER.replace(/\/$/, ""))
      problems.push("AUTH_ISSUER must differ from OIDC_ISSUER");
    if (problems.length) throw new Error(`Invalid native auth configuration: ${problems.join("; ")}`);
    loadPrivateKey(); // throws on a malformed key
  }

  private init() {
    this.ready ||= (async () => {
      const key = loadPrivateKey();
      const alg = algFor(key);
      const publicJwk = createPublicKey(key).export({ format: "jwk" }) as JWK;
      const kid = await calculateJwkThumbprint(publicJwk);
      this.signing = { key, kid, alg, publicJwk: { ...publicJwk, kid, alg, use: "sig" } };
      this.verifiers = [{ kid, alg, key: createPublicKey(key) }];
      for (const jwk of JSON.parse(process.env.AUTH_PREVIOUS_PUBLIC_KEYS || "[]") as JWK[]) {
        const previousAlg = jwk.crv === "Ed25519" ? "EdDSA" : jwk.crv === "P-256" ? "ES256" : null;
        if (!previousAlg || jwk.d) continue; // never accept a private or unknown key here
        this.verifiers.push({ kid: jwk.kid || (await calculateJwkThumbprint(jwk)), alg: previousAlg, key: await importJWK(jwk, previousAlg) });
      }
    })().catch((error) => { this.ready = undefined; throw error; });
    return this.ready;
  }

  async jwks() {
    await this.init();
    const previous = (JSON.parse(process.env.AUTH_PREVIOUS_PUBLIC_KEYS || "[]") as JWK[]).filter((jwk) => !jwk.d)
      .map((jwk) => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid: jwk.kid, alg: jwk.crv === "Ed25519" ? "EdDSA" : "ES256", use: "sig" }));
    return { keys: [this.signing!.publicJwk, ...previous] };
  }

  async sign(input: { userId: string; sessionId: string; amr: string[] }) {
    await this.init();
    const { key, kid, alg } = this.signing!;
    const token = await new SignJWT({ sid: input.sessionId, amr: input.amr })
      .setProtectedHeader({ alg, kid, typ: LOCAL_TOKEN_TYPE })
      .setIssuer(this.issuer).setAudience(this.audience).setSubject(input.userId)
      .setIssuedAt().setNotBefore("0s").setExpirationTime(`${this.accessTtl}s`).setJti(randomUUID())
      .sign(key);
    return { token, expiresIn: this.accessTtl };
  }

  /** Whether a bearer token claims to be ours (unverified peek, only used to pick the verification branch). */
  isLocal(token: string) {
    if (!this.issuer) return false;
    try { return decodeJwt(token).iss === this.issuer && decodeProtectedHeader(token).typ === LOCAL_TOKEN_TYPE; } catch { return false; }
  }

  async verify(token: string, clockTolerance: number): Promise<LocalClaims> {
    await this.init();
    const header = decodeProtectedHeader(token);
    const candidate = this.verifiers.find((entry) => entry.kid === header.kid);
    if (!candidate) throw new Error("Unknown signing key.");
    const { payload } = await jwtVerify(token, candidate.key as KeyObject, {
      issuer: this.issuer, audience: this.audience, algorithms: [candidate.alg], typ: LOCAL_TOKEN_TYPE, clockTolerance,
      requiredClaims: ["exp", "iat", "sub", "iss", "aud", "sid", "jti"],
    });
    if (typeof payload.sid !== "string" || !Array.isArray(payload.amr)) throw new Error("Malformed first-party token.");
    return payload as LocalClaims;
  }
}

/** One instance per process (AuthService verifies, NativeAuthService signs). */
let shared: LocalTokenKeys | null = null;
export const localTokenKeys = () => (shared ||= new LocalTokenKeys());

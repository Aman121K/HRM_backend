import './lib/dev-only.mjs'; // refuses to run in production — see the file
// Development-only OpenID Connect provider so the real Authorization Code + PKCE sign-in can be exercised locally.
// It signs RS256 tokens exactly like a production IdP (Okta, Entra ID, Auth0, Keycloak, Google Workspace).
// NEVER deploy this. Usage: npm run dev:idp   (then set the OIDC_* values it prints in .env and restart the API)
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import pg from "pg";

if (process.env.NODE_ENV === "production") throw new Error("dev-oidc-provider must never run in production.");
const port = Number(process.env.DEV_IDP_PORT || 4200);
const issuer = `http://localhost:${port}`;
const clientId = "northstar-web";
const audience = "northstar-api";
const redirects = new Set((process.env.DEV_IDP_REDIRECTS || "http://localhost:3000/auth/callback").split(","));
// Entries may use one "*" for a single subdomain label, e.g. http://*.localhost:3000/auth/callback for brand subdomains.
const redirectPatterns = [...redirects].filter((entry) => entry.includes("*"))
  .map((entry) => new RegExp(`^${entry.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?")}$`));
const allowedRedirect = (uri) => redirects.has(uri) || redirectPatterns.some((pattern) => pattern.test(uri));
const postLogout = new Set((process.env.DEV_IDP_POST_LOGOUT || "http://localhost:3000/login").split(","));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "dev-1", alg: "RS256", use: "sig" };
const codes = new Map(); // code -> { user, clientId, redirectUri, challenge, nonce, scope, expires }

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const send = (res, status, body, headers = {}) => { res.writeHead(status, { "cache-control": "no-store", ...headers }); res.end(body); };
const json = (res, status, data) => send(res, status, JSON.stringify(data), { "content-type": "application/json", "access-control-allow-origin": "http://localhost:3000" });
const readBody = async (req) => { let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 20_000) break; } return new URLSearchParams(raw); };

async function users() {
  return (await pool.query(`SELECT u.email, u.full_name, string_agg(m.role, ', ') AS roles FROM users u
    JOIN organization_memberships m ON m.user_id=u.id AND m.status='ACTIVE' GROUP BY u.email, u.full_name ORDER BY u.full_name`)).rows;
}

async function tokens(entry) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { email: entry.user.email, email_verified: true, name: entry.user.full_name };
  const sign = (payload, aud) => new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .setIssuer(issuer).setSubject(`dev|${entry.user.email}`).setAudience(aud).setIssuedAt(now).setExpirationTime(now + 3600).sign(privateKey);
  return {
    token_type: "Bearer", expires_in: 3600, scope: entry.scope,
    access_token: await sign({ ...claims, scope: entry.scope, client_id: clientId }, audience),
    id_token: await sign({ ...claims, nonce: entry.nonce }, clientId),
  };
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, issuer);
    if (req.method === "OPTIONS") return send(res, 204, "", { "access-control-allow-origin": "http://localhost:3000", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, GET" });
    if (url.pathname === "/.well-known/openid-configuration") return json(res, 200, {
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
      end_session_endpoint: `${issuer}/logout`, response_types_supported: ["code"], grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "profile", "email"], token_endpoint_auth_methods_supported: ["none"],
    });
    if (url.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
    if (url.pathname === "/logout") {
      const target = url.searchParams.get("post_logout_redirect_uri") || "";
      return postLogout.has(target) || allowedRedirect(target.replace(/\/login$/, "/auth/callback")) ? send(res, 302, "", { location: target }) : send(res, 200, "Signed out of the dev identity provider.");
    }
    if (url.pathname === "/authorize" && req.method === "GET") {
      const p = url.searchParams;
      if (p.get("client_id") !== clientId || !allowedRedirect(p.get("redirect_uri") || "")) return send(res, 400, "Unknown client or redirect URI.");
      if (p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) return send(res, 400, "PKCE (S256) authorization code flow is required.");
      const hidden = ["client_id", "redirect_uri", "scope", "state", "nonce", "code_challenge"].map((k) => `<input type="hidden" name="${k}" value="${escape(p.get(k) || "")}">`).join("");
      const list = (await users()).map((u) => `<button name="email" value="${escape(u.email)}"><b>${escape(u.full_name)}</b><small>${escape(u.email)} · ${escape(u.roles)}</small></button>`).join("");
      return send(res, 200, `<!doctype html><meta name="viewport" content="width=device-width"><title>Dev identity provider</title>
<style>body{font:15px system-ui;background:#f4f1e9;color:#152c38;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fffefa;border:1px solid #dfe3df;padding:32px;width:min(440px,92vw)}h1{font-size:20px;margin:0 0 4px}p{color:#667780;margin:0 0 20px}button{display:grid;width:100%;text-align:left;gap:3px;padding:12px 14px;margin-bottom:8px;border:1px solid #dfe3df;background:#fff;cursor:pointer;font:inherit}button:hover{border-color:#0b615c}small{color:#667780}.warn{font-size:12px;background:#faf1dc;padding:8px 10px;color:#7c5610}</style>
<main><h1>Dev identity provider</h1><p>Choose who to sign in as. This stands in for your company SSO locally.</p><form method="post">${hidden}${list}</form><p class="warn">Development only — never deploy.</p></main>`, { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" });
    }
    if (url.pathname === "/authorize" && req.method === "POST") {
      const p = await readBody(req);
      if (p.get("client_id") !== clientId || !allowedRedirect(p.get("redirect_uri") || "")) return send(res, 400, "Unknown client or redirect URI.");
      const user = (await users()).find((u) => u.email === p.get("email"));
      if (!user) return send(res, 400, "Unknown user.");
      const code = randomBytes(24).toString("base64url");
      codes.set(code, { user, redirectUri: p.get("redirect_uri"), challenge: p.get("code_challenge"), nonce: p.get("nonce"), scope: p.get("scope") || "openid", expires: Date.now() + 60_000 });
      const target = new URL(p.get("redirect_uri"));
      target.searchParams.set("code", code);
      if (p.get("state")) target.searchParams.set("state", p.get("state"));
      return send(res, 302, "", { location: target.toString() });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const p = await readBody(req);
      const entry = codes.get(p.get("code") || "");
      codes.delete(p.get("code") || ""); // single use
      if (p.get("grant_type") !== "authorization_code" || !entry || entry.expires < Date.now()) return json(res, 400, { error: "invalid_grant" });
      if (p.get("client_id") !== clientId || p.get("redirect_uri") !== entry.redirectUri) return json(res, 400, { error: "invalid_client" });
      const challenge = createHash("sha256").update(p.get("code_verifier") || "").digest("base64url");
      if (challenge !== entry.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      return json(res, 200, await tokens(entry));
    }
    send(res, 404, "Not found");
  } catch (error) {
    console.error(error);
    send(res, 500, "Internal error");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Dev OIDC provider on ${issuer}\nSet in .env:\n  OIDC_ISSUER=${issuer}\n  OIDC_AUDIENCE=${audience}\n  OIDC_JWKS_URL=${issuer}/jwks\n  OIDC_CLIENT_ID=${clientId}`);
});

#!/usr/bin/env node
// Post-deploy smoke test for a production (or staging) Northstar deployment. Read-only: only GET/OPTIONS requests.
//
//   node scripts/smoke-prod.mjs --api https://api.people.example.in --web https://people.example.in \
//        [--brand https://blue-tokai.people.example.in] [--token <bearer token of a test account>]
//   (or SMOKE_API_URL / SMOKE_WEB_URL / SMOKE_BRAND_URL / SMOKE_TOKEN; the token is never printed)
//
// Checks: liveness + readiness, auth config (SSO on, demo identity off), CSP + HSTS + framing headers on the web app,
// HSTS on the API, demo header sign-in rejected, CORS refuses a foreign origin, OpenAPI not exposed, HTTP→HTTPS, and
// (with --token) an authenticated round trip. Prints PASS/FAIL/SKIP per check; exit code 1 if anything failed.
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const strip = (value) => (value || '').replace(/\/+$/, '');
const api = strip(arg('api') || process.env.SMOKE_API_URL);
const web = strip(arg('web') || process.env.SMOKE_WEB_URL);
const brand = strip(arg('brand') || process.env.SMOKE_BRAND_URL);
const token = arg('token') || process.env.SMOKE_TOKEN || '';
const allowHttp = process.argv.includes('--allow-http'); // local dry runs only
if (!api || !web) { console.error('usage: smoke-prod.mjs --api <https://api…> --web <https://…> [--brand <https://brand.…>] [--token <bearer>]'); process.exit(2); }

const results = [];
const record = (status, name, detail = '') => { results.push({ status, name, detail }); console.log(`${status.padEnd(4)}  ${name}${detail ? ` — ${detail}` : ''}`); };
async function check(name, fn) {
  try {
    const outcome = await fn();
    if (outcome === 'skip' || outcome?.skip) record('SKIP', name, outcome?.skip || '');
    else record('PASS', name, typeof outcome === 'string' ? outcome : '');
  } catch (error) { record('FAIL', name, error.message); }
}
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const get = (url, init = {}) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000), ...init });
const hstsOk = (value) => { const m = /max-age=(\d+)/i.exec(value || ''); return m && Number(m[1]) >= 31536000 && /includesubdomains/i.test(value); };

await check('HTTPS URLs', () => { assert(allowHttp || (api.startsWith('https://') && web.startsWith('https://')), 'api and web must be https:// URLs'); });

await check('API liveness /api/v2/health/live', async () => {
  const response = await get(`${api}/api/v2/health/live`);
  assert(response.status === 200, `HTTP ${response.status}`);
});

await check('API readiness /api/v2/health/ready', async () => {
  const response = await get(`${api}/api/v2/health/ready`);
  const body = await response.json().catch(() => ({}));
  const failing = Object.entries(body.checks || {}).filter(([, c]) => c.status === 'fail').map(([k, c]) => `${k}:${c.error || 'fail'}`);
  assert(response.status === 200 && body.status === 'ready', `HTTP ${response.status} ${body.status || ''} ${failing.join(', ')}`);
  const text = JSON.stringify(body);
  assert(!/postgres(ql)?:\/\/|redis(s)?:\/\/|password|secret|amazonaws\.com/i.test(text), 'readiness output leaks connection details');
  return `migrations ${body.checks?.migrations?.applied ?? '?'}/${body.checks?.migrations?.expected ?? '?'}, storage ${body.checks?.storage?.driver ?? '?'}`;
});

await check('API HSTS header', async () => {
  const response = await get(`${api}/api/v2/health/live`);
  assert(hstsOk(response.headers.get('strict-transport-security')), `strict-transport-security: ${response.headers.get('strict-transport-security') || 'missing'}`);
});

await check('Auth config: SSO configured, demo identity off', async () => {
  const response = await get(`${api}/api/v2/auth/config`);
  assert(response.status === 200, `HTTP ${response.status}`);
  const body = await response.json();
  assert(body.demoIdentity === false, 'demoIdentity is not false');
  const issuer = body.oidc?.issuer || '';
  if (body.oidc) assert(issuer.startsWith('https://') && !/localhost|127\.0\.0\.1|:4200/.test(issuer), `OIDC issuer looks like a dev IdP: ${issuer}`);
  return body.oidc ? `OIDC issuer ${new URL(issuer).host}` : 'no OIDC block (native sign-in only?)';
});

await check('Demo header sign-in rejected', async () => {
  const response = await get(`${api}/api/v2/auth/session`, { headers: { 'x-tenant-id': 'blue-tokai', 'x-employee-id': 'BT000' } });
  assert(response.status === 401, `expected 401, got HTTP ${response.status}`);
  const platform = await get(`${api}/api/v2/platform/ops/status`, { headers: { 'x-tenant-id': 'platform', 'x-employee-id': 'superadmin@northstar.example' } });
  assert(platform.status === 401, `platform demo identity: expected 401, got HTTP ${platform.status}`);
});

await check('CORS rejects a foreign origin', async () => {
  const origin = 'https://evil.example.net';
  const preflight = await get(`${api}/api/v2/auth/session`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
  const allowed = preflight.headers.get('access-control-allow-origin');
  assert(allowed !== origin && allowed !== '*', `preflight allowed ${allowed}`);
  const simple = await get(`${api}/api/v2/auth/config`, { headers: { origin } });
  const allowedSimple = simple.headers.get('access-control-allow-origin');
  assert(allowedSimple !== origin && allowedSimple !== '*', `GET allowed ${allowedSimple}`);
});

await check('CORS allows the web origin', async () => {
  const origin = new URL(web).origin;
  const preflight = await get(`${api}/api/v2/auth/session`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
  assert(preflight.headers.get('access-control-allow-origin') === origin, `preflight answered ${preflight.headers.get('access-control-allow-origin') || 'no allow-origin'}`);
});

await check('OpenAPI document not public', async () => {
  const response = await get(`${api}/api/openapi.json`);
  assert(response.status === 404 || response.status === 401 || response.status === 403, `HTTP ${response.status} (set EXPOSE_OPENAPI=false)`);
});

const webChecks = async (base, label) => {
  await check(`${label}: CSP with per-request nonce`, async () => {
    const [first, second] = await Promise.all([get(`${base}/login`), get(`${base}/login`)]);
    assert(first.status < 500, `HTTP ${first.status}`);
    const csp = first.headers.get('content-security-policy') || '';
    assert(csp, 'content-security-policy header missing');
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    assert(nonce, 'script-src has no nonce');
    assert(/frame-ancestors 'none'|frame-ancestors 'self'/.test(csp) || first.headers.get('x-frame-options'), 'no frame-ancestors / X-Frame-Options');
    assert(!/script-src[^;]*'unsafe-eval'/.test(csp), "script-src allows 'unsafe-eval' (production build should not)");
    const otherNonce = /'nonce-([^']+)'/.exec(second.headers.get('content-security-policy') || '')?.[1];
    assert(otherNonce && otherNonce !== nonce, 'nonce is not unique per request');
  });
  await check(`${label}: HSTS + security headers`, async () => {
    const response = await get(`${base}/login`);
    assert(hstsOk(response.headers.get('strict-transport-security')), `strict-transport-security: ${response.headers.get('strict-transport-security') || 'missing'}`);
    assert(response.headers.get('x-content-type-options') === 'nosniff', 'x-content-type-options missing');
    assert(!response.headers.get('x-powered-by'), 'x-powered-by present');
  });
  await check(`${label}: plain HTTP redirects to HTTPS`, async () => {
    if (!base.startsWith('https://')) return { skip: 'base URL is not https' };
    const response = await get(base.replace(/^https:/, 'http:') + '/login').catch(() => null);
    if (!response) return { skip: 'port 80 closed (acceptable: HSTS preload)' };
    assert([301, 302, 307, 308].includes(response.status) && (response.headers.get('location') || '').startsWith('https://'), `HTTP ${response.status} location ${response.headers.get('location')}`);
  });
};
await webChecks(web, 'Web (main domain)');
if (brand) await webChecks(brand, 'Web (brand subdomain)');

await check('Authenticated request with test token', async () => {
  if (!token) return { skip: 'no --token / SMOKE_TOKEN given' };
  const response = await get(`${api}/api/v2/auth/session`, { headers: { authorization: `Bearer ${token}` } });
  assert(response.status === 200, `HTTP ${response.status}`);
  const body = await response.json();
  assert(body.userId, 'session has no userId');
  assert(response.headers.get('x-request-id'), 'x-request-id not returned');
  return body.platform ? 'platform identity' : `organization ${body.organization?.slug || body.organizationId}`;
});

const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${results.filter((r) => r.status === 'PASS').length} passed, ${failed} failed, ${results.filter((r) => r.status === 'SKIP').length} skipped`);
process.exit(failed ? 1 : 0);

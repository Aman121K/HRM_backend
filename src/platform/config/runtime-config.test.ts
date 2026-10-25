import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeConfig } from "./runtime-config";

const withEnvironment = (values: Record<string, string | undefined>, run: () => void) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("development accepts explicit demo identity mode", () =>
  withEnvironment(
    { NODE_ENV: "development", DATABASE_URL: "postgresql://local/test", ALLOW_DEMO_IDENTITY: "true" },
    () => assert.doesNotThrow(() => new RuntimeConfig().validate()),
  ));

test("production rejects demo identity and missing platform services", () =>
  withEnvironment(
    {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://local/test",
      ALLOW_DEMO_IDENTITY: "true",
      OIDC_ISSUER: undefined,
      OIDC_AUDIENCE: undefined,
      OIDC_JWKS_URL: undefined,
      REDIS_URL: undefined,
    },
    () =>
      assert.throws(
        () => new RuntimeConfig().validate(),
        /ALLOW_DEMO_IDENTITY must be false.*OIDC_ISSUER.*REDIS_URL/,
      ),
  ));

test("demo identity is off unless explicitly enabled", () =>
  withEnvironment({ ALLOW_DEMO_IDENTITY: undefined }, () => assert.equal(new RuntimeConfig().allowDemoIdentity, false)));

test("demo identity only accepts the literal true", () =>
  withEnvironment({ ALLOW_DEMO_IDENTITY: "1" }, () => assert.equal(new RuntimeConfig().allowDemoIdentity, false)));

test("API binds to loopback unless BIND_HOST overrides it", () => {
  withEnvironment({ BIND_HOST: undefined }, () => assert.equal(new RuntimeConfig().bindHost, "127.0.0.1"));
  withEnvironment({ BIND_HOST: "0.0.0.0" }, () => assert.equal(new RuntimeConfig().bindHost, "0.0.0.0"));
});

const PRODUCTION_BASE = {
  NODE_ENV: "production", DATABASE_URL: "postgresql://owner@db/hrm", DATABASE_URL_RUNTIME: "postgresql://runtime@db/hrm",
  ALLOW_DEMO_IDENTITY: undefined, REDIS_URL: "redis://cache:6379",
};

test("production accepts a native-auth-only deployment (no OIDC)", () =>
  withEnvironment(
    { ...PRODUCTION_BASE, OIDC_ISSUER: undefined, OIDC_AUDIENCE: undefined, OIDC_JWKS_URL: undefined, AUTH_SIGNING_KEY: "-----BEGIN PRIVATE KEY-----x", AUTH_ISSUER: "https://api.example.com" },
    () => assert.doesNotThrow(() => new RuntimeConfig().validate()),
  ));

test("production rejects no sign-in method and partial OIDC", () => {
  withEnvironment(
    { ...PRODUCTION_BASE, OIDC_ISSUER: undefined, OIDC_AUDIENCE: undefined, OIDC_JWKS_URL: undefined, AUTH_SIGNING_KEY: undefined, AUTH_ISSUER: undefined },
    () => assert.throws(() => new RuntimeConfig().validate(), /Configure sign-in/),
  );
  withEnvironment(
    { ...PRODUCTION_BASE, OIDC_ISSUER: "https://idp.example.com", OIDC_AUDIENCE: undefined, OIDC_JWKS_URL: undefined, AUTH_SIGNING_KEY: "k", AUTH_ISSUER: "https://api.example.com" },
    () => assert.throws(() => new RuntimeConfig().validate(), /must all be set/),
  );
});

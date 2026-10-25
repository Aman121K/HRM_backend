/**
 * Process lifecycle shared by the health endpoints and the shutdown hooks in main.ts / jobs/worker.ts.
 * When SIGTERM arrives the process first reports "draining" on /ready (so the load balancer stops routing new
 * requests to it), waits SHUTDOWN_DRAIN_MS, then closes the server and lets in-flight requests finish.
 */
export const processStartedAt = new Date();
let draining = false;
export const isDraining = () => draining;
export const markDraining = () => { draining = true; };
export const uptimeSeconds = () => Math.round(process.uptime());

/** Build/version identity (no secrets): set APP_VERSION / GIT_SHA at image build time (see Dockerfile.api). */
export const buildInfo = () => ({
  version: process.env.APP_VERSION || process.env.npm_package_version || "dev",
  commit: (process.env.GIT_SHA || "").slice(0, 12) || null,
  node: process.version,
});

/** Resolves to `work()` or rejects with Error("timeout") after `ms`. */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); timer.unref?.(); }),
  ]);
}

/** A short, secret-free reason for a failed probe: an errno-style code or "timeout", never the raw message (it can carry hosts/users). */
export function probeError(error: unknown): string {
  const e = error as { code?: string; name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  if (e?.message === "timeout") return "timeout";
  if (e?.$metadata?.httpStatusCode) return `http_${e.$metadata.httpStatusCode}`;
  if (typeof e?.code === "string" && /^[A-Z0-9_]{2,40}$/.test(e.code)) return e.code;
  return e?.name && /^[A-Za-z]{2,40}$/.test(e.name) ? e.name : "error";
}

import { AsyncLocalStorage } from "node:async_hooks";

/** What the worker knows about the job being executed. Handlers read it with currentJob() (optional). */
export type JobContext = { id: string; name: string; attempt: number; signal: AbortSignal; startedAt: Date };

const storage = new AsyncLocalStorage<JobContext>();

export function runWithJobContext<T>(context: JobContext, work: () => Promise<T>) {
  return storage.run(context, work);
}
export function currentJob(): JobContext | undefined {
  return storage.getStore();
}
/** Throws when the worker has abandoned the current job (timeout / shutdown); call between units of work. */
export function throwIfAborted() {
  const job = storage.getStore();
  if (job?.signal.aborted) throw new Error(`Job ${job.name} aborted: ${String(job.signal.reason || "timeout")}`);
}

/**
 * Races `work` against a timer. On timeout the controller is aborted (cooperative handlers stop at their next
 * throwIfAborted()) and the returned promise rejects, so BullMQ records a failure and applies its retry policy.
 */
export async function runWithTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number, controller = new AbortController()): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort("timeout");
          reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

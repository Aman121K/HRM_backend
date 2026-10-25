import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Queue, type JobsOptions } from "bullmq";
import { RuntimeConfig } from "../config/runtime-config";
import { QUEUE_NAME } from "./scheduling";

/** Retries with exponential backoff; completed jobs are trimmed, failed jobs are kept (dead-letter view in the console). */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: 500,
  removeOnFail: { count: 5000, age: 30 * 24 * 3600 },
};

@Injectable()
export class JobsService implements OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private readonly queue?: Queue;
  constructor(private readonly config: RuntimeConfig) {
    if (config.redisUrl)
      this.queue = new Queue(QUEUE_NAME, { connection: { url: config.redisUrl }, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    else this.logger.warn("REDIS_URL is not configured; background jobs use development no-op mode.");
  }
  async enqueue(name: string, payload: Record<string, unknown>, options: JobsOptions = {}) {
    if (!this.queue) {
      if (this.config.nodeEnv === "production") throw new Error("Background queue is unavailable.");
      this.logger.debug(`Development job ${name}: ${JSON.stringify(payload)}`);
      return { queued: false, mode: "development" };
    }
    const job = await this.queue.add(name, payload, { ...DEFAULT_JOB_OPTIONS, ...options });
    return { queued: true, jobId: job.id };
  }
  /** The BullMQ queue, or undefined in development no-op mode (no REDIS_URL). Used by the worker and the jobs console. */
  get bullQueue() { return this.queue; }
  async onModuleDestroy() {
    await this.queue?.close();
  }
}

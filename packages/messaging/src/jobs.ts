import { type ConnectionOptions, type JobsOptions, Queue, Worker } from "bullmq";
import type { Logger } from "pino";

export type WorkerHandler<Payload> = (payload: Payload) => Promise<void> | void;

export type DelayedScheduler<Payload> = {
  scheduleDelayed: (
    jobName: string,
    payload: Payload,
    delayMs: number,
    jobId: string,
  ) => Promise<void>;
  close: () => Promise<void>;
};

export type SchedulerOptions = {
  queueName: string;
  logger?: Logger;
  defaultJobOptions?: Pick<JobsOptions, "attempts" | "backoff">;
};

export type WorkerOptions<Payload> = {
  queueName: string;
  handler: WorkerHandler<Payload>;
  logger?: Logger;
};

export function createScheduler<Payload>(
  connection: ConnectionOptions,
  options: SchedulerOptions,
): DelayedScheduler<Payload> {
  const queueOpts =
    options.defaultJobOptions === undefined
      ? { connection }
      : { connection, defaultJobOptions: options.defaultJobOptions };
  const queue = new Queue(options.queueName, queueOpts);
  const log = options.logger?.child({ queueName: options.queueName });

  return {
    scheduleDelayed: async (jobName, payload, delayMs, jobId) => {
      await queue.add(jobName, payload, { delay: delayMs, jobId });
      log?.info({ jobId, jobName, delayMs }, "delayed job scheduled");
    },
    close: async () => {
      await queue.close();
    },
  };
}

export function createWorker<Payload>(
  connection: ConnectionOptions,
  options: WorkerOptions<Payload>,
): Worker<Payload, void> {
  const log = options.logger?.child({ queueName: options.queueName });

  return new Worker<Payload, void>(
    options.queueName,
    async (job) => {
      const start = Date.now();

      log?.info({ jobId: job.id, jobName: job.name }, "job started");

      try {
        await options.handler(job.data);
        log?.info(
          { jobId: job.id, jobName: job.name, durationMs: Date.now() - start },
          "job completed",
        );
      } catch (err) {
        log?.error(
          { jobId: job.id, jobName: job.name, durationMs: Date.now() - start, err },
          "job failed",
        );
        throw err;
      }
    },
    // BullMQ requires `maxRetriesPerRequest: null` on worker connections; without it,
    // ioredis queues retries that surface as unhandled rejections during shutdown.
    { connection: withWorkerConnectionDefaults(connection) },
  );
}

function withWorkerConnectionDefaults(connection: ConnectionOptions): ConnectionOptions {
  if (connection && typeof connection === "object" && !("connect" in connection)) {
    return { ...connection, maxRetriesPerRequest: null };
  }
  return connection;
}

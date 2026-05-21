import { type ConnectionOptions, Queue, Worker } from "bullmq";
import type { Logger } from "pino";

export type WorkerHandler<Payload> = (payload: Payload) => Promise<void> | void;

export type DelayedScheduler = {
  scheduleDelayed: <Payload>(
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
};

export type WorkerSetupOptions<Payload> = {
  queueName: string;
  handler: WorkerHandler<Payload>;
  logger?: Logger;
};

export function createScheduler(
  connection: ConnectionOptions,
  options: SchedulerOptions,
): DelayedScheduler {
  const queue = new Queue(options.queueName, { connection });
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
  options: WorkerSetupOptions<Payload>,
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
    { connection },
  );
}

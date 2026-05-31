import { type ConnectionOptions, type JobsOptions, Queue, Worker } from "bullmq";

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
  defaultJobOptions?: Pick<JobsOptions, "attempts" | "backoff">;
};

export type WorkerOptions<Payload> = {
  queueName: string;
  handler: WorkerHandler<Payload>;
};

export function createScheduler<Payload>(
  connection: ConnectionOptions,
  options: SchedulerOptions,
): DelayedScheduler<Payload> {
  const safeConnection = withWorkerConnectionDefaults(connection);
  const queueOpts =
    options.defaultJobOptions === undefined
      ? { connection: safeConnection }
      : { connection: safeConnection, defaultJobOptions: options.defaultJobOptions };
  const queue = new Queue(options.queueName, queueOpts);

  return {
    scheduleDelayed: async (jobName, payload, delayMs, jobId) => {
      await queue.add(jobName, payload, { delay: delayMs, jobId });
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
  return new Worker<Payload, void>(
    options.queueName,
    async (job) => {
      const start = Date.now();

      try {
        await options.handler(job.data);
      } catch (err) {
        // Outside Effect (BullMQ owns this callback), so failures go to `console.error`.
        // BullMQ handles retry/backoff on the rethrow.
        console.error("job failed", {
          queueName: options.queueName,
          jobId: job.id,
          jobName: job.name,
          durationMs: Date.now() - start,
          err,
        });
        throw err;
      }
    },
    { connection: withWorkerConnectionDefaults(connection) },
  );
}

// BullMQ requires `maxRetriesPerRequest: null` on any blocking-redis connection
// (workers + queues that issue blocking commands during shutdown). Without it,
// ioredis queues retries that surface as unhandled rejections after close.
function withWorkerConnectionDefaults(connection: ConnectionOptions): ConnectionOptions {
  if (connection && typeof connection === "object" && !("connect" in connection)) {
    return "maxRetriesPerRequest" in connection
      ? connection
      : { ...connection, maxRetriesPerRequest: null };
  }
  return connection;
}

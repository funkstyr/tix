// NOTE(seam): expiration is the only adapter of this module today — one adapter
// makes this a hypothetical seam (BullMQ delayed jobs, ADR-0002). Keep the
// interface stable but don't generalize it further until a second service
// schedules delayed jobs; if expiration ever absorbs it wholesale, moving this
// file into apps/expiration is the honest outcome.
import { type ConnectionOptions, type JobsOptions, Queue, Worker } from "bullmq";
import { Cause, Effect, Exit } from "effect";

export type WorkerHandler<Payload, E, R> = (payload: Payload) => Effect.Effect<void, E, R>;

export type DelayedScheduler<Payload> = {
  scheduleDelayed: (
    jobName: string,
    payload: Payload,
    delayMs: number,
    jobId: string,
  ) => Promise<void>;
  counts: () => Promise<{ waiting: number; delayed: number; active: number }>;
  close: () => Promise<void>;
};

export type SchedulerOptions = {
  queueName: string;
  defaultJobOptions?: Pick<JobsOptions, "attempts" | "backoff">;
};

export type WorkerOptions<Payload, E, R> = {
  queueName: string;
  runtime: { runPromiseExit: <A>(effect: Effect.Effect<A, E, R>) => Promise<Exit.Exit<A, E>> };
  handler: WorkerHandler<Payload, E, R>;
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
    counts: async () => {
      const c = await queue.getJobCounts("waiting", "delayed", "active");
      return { waiting: c["waiting"] ?? 0, delayed: c["delayed"] ?? 0, active: c["active"] ?? 0 };
    },
    close: async () => {
      await queue.close();
    },
  };
}

type JobContext = { queueName: string; jobId: string | undefined; jobName: string };

/**
 * Runs a job handler Effect on `runtime`, logging failures through Effect's Logger and
 * rethrowing so BullMQ applies its existing retry/backoff. `runPromiseExit` never rejects,
 * so a failure surfaces as `Exit.Failure`; we squash its cause back to a throwable. Timing
 * lives inside the handler (Clock), not here. An interruption (e.g. runtime disposed mid-job
 * on shutdown) is also a failure exit: it logs and rethrows, so BullMQ retries on restart —
 * matching the prior `runtime.runPromise` behaviour (BullMQ's `close()` drains in-flight jobs
 * first, so this is a shutdown-race edge, not the normal path).
 */
export async function runJob<E, R>(
  runtime: { runPromiseExit: <A>(effect: Effect.Effect<A, E, R>) => Promise<Exit.Exit<A, E>> },
  jobContext: JobContext,
  handler: () => Effect.Effect<void, E, R>,
): Promise<void> {
  const program = handler().pipe(
    Effect.tapErrorCause((cause) =>
      Effect.logError("job failed").pipe(
        Effect.annotateLogs({ ...jobContext, cause: Cause.pretty(cause) }),
      ),
    ),
  );
  const exit = await runtime.runPromiseExit(program);
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
}

export function createWorker<Payload, E, R>(
  connection: ConnectionOptions,
  options: WorkerOptions<Payload, E, R>,
): Worker<Payload, void> {
  return new Worker<Payload, void>(
    options.queueName,
    (job) =>
      runJob(
        options.runtime,
        { queueName: options.queueName, jobId: job.id, jobName: job.name },
        () => options.handler(job.data),
      ),
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

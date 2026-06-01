import { type Context } from "@opentelemetry/api";
import { eq, isNull } from "drizzle-orm";
import { type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Cause, Clock, Duration, Effect, Schedule, Stream } from "effect";

import { type defineOutbox } from "./schema.js";
import { captureTraceparent, contextFromTraceparent } from "./trace-context.js";

export type OutboxTable = ReturnType<typeof defineOutbox>;

// `Record<string, unknown>` accepts any per-service schema via structural typing.
type AnyDb = PostgresJsDatabase<Record<string, unknown>>;

export type EnqueueEventArgs = {
  subject: string;
  payload: unknown;
  eventId: string;
  /** Trace context to persist; defaults to the ambient active context. */
  traceContext?: Context;
};

export async function enqueueEvent(
  tx: AnyDb,
  table: OutboxTable,
  { subject, payload, eventId, traceContext }: EnqueueEventArgs,
): Promise<void> {
  // Capture the trace context now, inside the caller's transaction — this is
  // the causally meaningful moment. The relay replays it at publish time.
  await tx
    .insert(table)
    .values({ subject, payload, eventId, traceparent: captureTraceparent(traceContext) });
}

export type OutboxPublish = (
  subject: string,
  payload: unknown,
  options: { msgId: string; traceContext?: Context },
) => Promise<unknown>;

export type OutboxRelayOptions = {
  pollIntervalMs?: number;
  batchSize?: number;
};

export type RunningOutboxRelay = {
  stop: () => Promise<void>;
};

export function startOutboxRelay(
  db: AnyDb,
  table: OutboxTable,
  publish: OutboxPublish,
  options: OutboxRelayOptions = {},
): RunningOutboxRelay {
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const batchSize = options.batchSize ?? 50;

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let activePoll: Promise<void> = Promise.resolve();

  async function publishOne(row: {
    id: string;
    subject: string;
    payload: unknown;
    eventId: string;
    traceparent: string | null;
  }): Promise<void> {
    const traceContext = contextFromTraceparent(row.traceparent);

    try {
      await publish(row.subject, row.payload, {
        msgId: row.eventId,
        ...(traceContext === undefined ? {} : { traceContext }),
      });
    } catch (err) {
      // The relay runs outside Effect (a bare `setTimeout` poll loop), so failures go to
      // `console.error` rather than the Effect Logger. The row stays unsent for retry.
      console.error("outbox publish failed; leaving row for retry", {
        eventId: row.eventId,
        subject: row.subject,
        err,
      });
      return;
    }

    await db.update(table).set({ sentAt: new Date() }).where(eq(table.id, row.id));
  }

  async function pollOnce(): Promise<void> {
    const rows = await db
      .select({
        id: table.id,
        subject: table.subject,
        payload: table.payload,
        eventId: table.eventId,
        traceparent: table.traceparent,
      })
      .from(table)
      .where(isNull(table.sentAt))
      .orderBy(table.createdAt)
      .limit(batchSize);

    for (const row of rows) {
      if (stopped) return;
      // Sequential publish keeps per-event ordering intact across the batch.
      // eslint-disable-next-line no-await-in-loop
      await publishOne(row);
    }
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      activePoll = pollOnce()
        .catch((err: unknown) => {
          console.error("outbox poll failed", { err });
        })
        .finally(() => {
          if (!stopped) schedule();
        });
    }, pollIntervalMs);
  }

  schedule();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await activePoll;
    },
  };
}

type OutboxRow = {
  id: string;
  subject: string;
  payload: unknown;
  eventId: string;
  traceparent: string | null;
};

/**
 * The outbox relay as an Effect `Stream` program. Polls unsent rows on a `Clock`-driven
 * schedule and republishes them sequentially (concurrency 1) so per-event ordering holds.
 * Failures are logged through Effect's `Logger`, never `console.error`; a failed publish or
 * poll leaves the row unsent for the next poll (the relay's existing retry). `R = never`
 * (only `Clock`, a default service), so it runs on any runtime or the default runtime.
 * Callers fork it (`Effect.forkScoped` in services; `Effect.runFork` in harnesses) and
 * interrupt the fiber to stop. The first poll fires immediately (no leading delay); later
 * polls are spaced by `pollIntervalMs` from the end of each poll. (This differs from the
 * old `startOutboxRelay`, which delayed the first poll by one interval.)
 */
export function outboxRelay(
  db: AnyDb,
  table: OutboxTable,
  publish: OutboxPublish,
  options: OutboxRelayOptions = {},
): Effect.Effect<void, never, never> {
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const batchSize = options.batchSize ?? 50;

  const fetchBatch: Effect.Effect<OutboxRow[], never, never> = Effect.tryPromise(() =>
    db
      .select({
        id: table.id,
        subject: table.subject,
        payload: table.payload,
        eventId: table.eventId,
        traceparent: table.traceparent,
      })
      .from(table)
      .where(isNull(table.sentAt))
      .orderBy(table.createdAt)
      .limit(batchSize),
  ).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logError("outbox poll failed").pipe(
        Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        Effect.as([] as OutboxRow[]),
      ),
    ),
  );

  const publishOne = (row: OutboxRow): Effect.Effect<void, never, never> => {
    const traceContext = contextFromTraceparent(row.traceparent);
    return Effect.tryPromise(() =>
      publish(row.subject, row.payload, {
        msgId: row.eventId,
        ...(traceContext === undefined ? {} : { traceContext }),
      }),
    ).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          // Leave the row unsent (sentAt stays null) so the next poll retries it.
          Effect.logError("outbox publish failed; leaving row for retry").pipe(
            Effect.annotateLogs({
              eventId: row.eventId,
              subject: row.subject,
              cause: Cause.pretty(cause),
            }),
          ),
        onSuccess: () =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            yield* Effect.tryPromise(() =>
              db.update(table).set({ sentAt: new Date(now) }).where(eq(table.id, row.id)),
            );
          }).pipe(
            Effect.catchAllCause((cause) =>
              Effect.logError("outbox mark-sent failed; will republish next poll").pipe(
                Effect.annotateLogs({ eventId: row.eventId, cause: Cause.pretty(cause) }),
              ),
            ),
          ),
      }),
    );
  };

  return Stream.repeatEffectWithSchedule(
    fetchBatch,
    Schedule.spaced(Duration.millis(pollIntervalMs)),
  ).pipe(
    // concurrency 1 keeps per-event ordering intact across the batch.
    Stream.flatMap((rows) => Stream.fromIterable(rows), { concurrency: 1 }),
    Stream.runForEach(publishOne),
  );
}

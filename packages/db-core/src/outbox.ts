import { eq, isNull } from "drizzle-orm";
import { type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { pino, type Logger } from "pino";

import { type defineOutbox } from "./schema.js";

export type OutboxTable = ReturnType<typeof defineOutbox>;

// `Record<string, unknown>` accepts any per-service schema via structural typing.
type AnyDb = PostgresJsDatabase<Record<string, unknown>>;

const fallbackLogger: Logger = pino({ level: "warn" });

export type EnqueueEventArgs = {
  subject: string;
  payload: unknown;
  eventId: string;
};

export async function enqueueEvent(
  tx: AnyDb,
  table: OutboxTable,
  { subject, payload, eventId }: EnqueueEventArgs,
): Promise<void> {
  await tx.insert(table).values({ subject, payload, eventId });
}

export type OutboxPublish = (
  subject: string,
  payload: unknown,
  options: { msgId: string },
) => Promise<unknown>;

export type OutboxRelayOptions = {
  pollIntervalMs?: number;
  batchSize?: number;
  logger?: Logger;
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
  const log = options.logger ?? fallbackLogger;

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let activePoll: Promise<void> = Promise.resolve();

  async function publishOne(row: {
    id: string;
    subject: string;
    payload: unknown;
    eventId: string;
  }): Promise<void> {
    try {
      await publish(row.subject, row.payload, { msgId: row.eventId });
    } catch (err) {
      log.error(
        { eventId: row.eventId, subject: row.subject, err },
        "outbox publish failed; leaving row for retry",
      );
      return;
    }

    await db.update(table).set({ sentAt: new Date() }).where(eq(table.id, row.id));
    log.info({ eventId: row.eventId, subject: row.subject }, "outbox row published");
  }

  async function pollOnce(): Promise<void> {
    const rows = await db
      .select({
        id: table.id,
        subject: table.subject,
        payload: table.payload,
        eventId: table.eventId,
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
          log.error({ err }, "outbox poll failed");
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

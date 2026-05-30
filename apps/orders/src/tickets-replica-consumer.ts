import { type NatsConnection } from "@nats-io/transport-node";
import { Effect } from "effect";
import { and, eq, lt } from "drizzle-orm";

import { TICKETS_CREATED_V1, TICKETS_UPDATED_V1 } from "@tix/contracts/subjects";
import { ticketCreatedV1, ticketUpdatedV1 } from "@tix/contracts/tickets";
import { withInboxDedupe } from "@tix/db-core/inbox";
import { createConsumer, type RunningConsumer } from "@tix/messaging/jetstream";

import { ordersInbox, ticketsReplica } from "./orders-schema.ts";
import type { OrdersRuntime } from "./runtime.ts";
import { Database, InfraLogger } from "./services.ts";

export const TICKETS_REPLICA_CREATED_GROUP = "orders-tickets-replica-created";
export const TICKETS_REPLICA_UPDATED_GROUP = "orders-tickets-replica-updated";

export type StartTicketsReplicaConsumerArgs = {
  runtime: OrdersRuntime;
  nats: NatsConnection;
  stream: string;
  ackWaitMs?: number;
};

// Seeds the orders read-model when a seller lists a ticket. Created tickets
// always start at version 1; `onConflictDoNothing` makes a redelivery a no-op
// even before the inbox dedupe commits.
export async function startTicketsCreatedConsumer(
  args: StartTicketsReplicaConsumerArgs,
): Promise<RunningConsumer> {
  const { runtime, nats, stream, ackWaitMs } = args;

  const logger = runtime.runSync(InfraLogger);
  const ackWaitOpt = ackWaitMs === undefined ? {} : { ackWaitMs };

  return createConsumer(nats, {
    stream,
    subjectFilter: TICKETS_CREATED_V1,
    group: TICKETS_REPLICA_CREATED_GROUP,
    schema: ticketCreatedV1,
    logger,
    ...ackWaitOpt,
    handler: ({ eventId, subject, payload }) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Database;

          const result = yield* Effect.tryPromise(() =>
            db.db.transaction((tx) =>
              withInboxDedupe(tx, ordersInbox, { eventId, subject }, async () => {
                await tx
                  .insert(ticketsReplica)
                  .values({
                    id: payload.ticketId,
                    sellerId: payload.sellerId,
                    title: payload.title,
                    quantityTotal: payload.quantityTotal,
                    unitPriceCents: payload.unitPriceCents,
                    version: 1,
                    createdAt: new Date(payload.createdAt),
                  })
                  .onConflictDoNothing();
              }),
            ),
          );

          if (result.deduped) {
            yield* Effect.logInfo("skipping duplicate tickets.created.v1").pipe(
              Effect.annotateLogs({ eventId, ticketId: payload.ticketId }),
            );
          }
        }),
      ),
  });
}

// Applies a seller's edit to the read-model. The `version < payload.version`
// guard drops stale redeliveries and out-of-order updates; a missing row is a
// no-op (the created event seeds it and is published first), matching the
// unknown-id handling in the other consumers.
export async function startTicketsUpdatedConsumer(
  args: StartTicketsReplicaConsumerArgs,
): Promise<RunningConsumer> {
  const { runtime, nats, stream, ackWaitMs } = args;

  const logger = runtime.runSync(InfraLogger);
  const ackWaitOpt = ackWaitMs === undefined ? {} : { ackWaitMs };

  return createConsumer(nats, {
    stream,
    subjectFilter: TICKETS_UPDATED_V1,
    group: TICKETS_REPLICA_UPDATED_GROUP,
    schema: ticketUpdatedV1,
    logger,
    ...ackWaitOpt,
    handler: ({ eventId, subject, payload }) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Database;

          const result = yield* Effect.tryPromise(() =>
            db.db.transaction((tx) =>
              withInboxDedupe(tx, ordersInbox, { eventId, subject }, async () => {
                const updated = await tx
                  .update(ticketsReplica)
                  .set({
                    title: payload.title,
                    unitPriceCents: payload.unitPriceCents,
                    version: payload.version,
                  })
                  .where(
                    and(
                      eq(ticketsReplica.id, payload.ticketId),
                      lt(ticketsReplica.version, payload.version),
                    ),
                  )
                  .returning({ id: ticketsReplica.id });

                if (updated.length === 0) {
                  logger.warn(
                    { eventId, ticketId: payload.ticketId, version: payload.version },
                    "tickets.updated.v1 for unknown or newer replica row; skipping",
                  );
                }
              }),
            ),
          );

          if (result.deduped) {
            yield* Effect.logInfo("skipping duplicate tickets.updated.v1").pipe(
              Effect.annotateLogs({ eventId, ticketId: payload.ticketId }),
            );
          }
        }),
      ),
  });
}

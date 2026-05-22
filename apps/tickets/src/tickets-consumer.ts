import { type NatsConnection } from "@nats-io/transport-node";
import { eq } from "drizzle-orm";
import { type Logger } from "pino";

import { orderReservationReleasedV1 } from "@tix/contracts/orders";
import { ORDER_RESERVATION_RELEASED_V1 } from "@tix/contracts/subjects";
import { type DbClient } from "@tix/db-core/client";
import { withInboxDedupe } from "@tix/db-core/inbox";
import { updateVersioned } from "@tix/db-core/optimistic-version";
import { createConsumer, type RunningConsumer } from "@tix/messaging/jetstream";

import { tickets, ticketsInbox, type ticketsTables } from "./tickets-schema.ts";

export const TICKETS_RELEASE_CONSUMER_GROUP = "tickets-release";

const RESTORE_ATTEMPT_LIMIT = 5;

export type StartTicketsReleasedConsumerArgs = {
  db: DbClient<typeof ticketsTables>;
  nats: NatsConnection;
  stream: string;
  logger?: Logger;
  ackWaitMs?: number;
};

export async function startTicketsReleasedConsumer(
  args: StartTicketsReleasedConsumerArgs,
): Promise<RunningConsumer> {
  const { db, nats, stream, logger, ackWaitMs } = args;

  const loggerOpt = logger === undefined ? {} : { logger };
  const ackWaitOpt = ackWaitMs === undefined ? {} : { ackWaitMs };

  return createConsumer(nats, {
    stream,
    subjectFilter: ORDER_RESERVATION_RELEASED_V1,
    group: TICKETS_RELEASE_CONSUMER_GROUP,
    schema: orderReservationReleasedV1,
    ...loggerOpt,
    ...ackWaitOpt,
    handler: async ({ eventId, subject, payload }) => {
      await db.db.transaction(async (tx) => {
        const result = await withInboxDedupe(tx, ticketsInbox, { eventId, subject }, async () => {
          // Serial retry by design: each attempt depends on the previous attempt's
          // version having lost the race. If we exhaust the budget we throw, which
          // rolls back the inbox row inside this transaction and lets NATS redeliver
          // — preferring a redelivery over silently losing the quantity restoration.
          for (let attempt = 0; attempt < RESTORE_ATTEMPT_LIMIT; attempt++) {
            // eslint-disable-next-line no-await-in-loop -- serial retry by design
            const [row] = await tx.select().from(tickets).where(eq(tickets.id, payload.ticketId));
            if (!row) {
              // Unknown ticketId is treated as a no-op (inbox commits, no redelivery):
              // a Ticket that never existed isn't coming back, and we don't want to
              // wedge the consumer on a poison message.
              logger?.warn(
                { eventId, ticketId: payload.ticketId },
                "order.reservation_released.v1 for unknown ticket; skipping",
              );
              return;
            }

            // eslint-disable-next-line no-await-in-loop -- serial retry by design
            const updated = await updateVersioned(
              tx,
              tickets,
              { id: row.id, version: row.version },
              { quantityAvailable: row.quantityAvailable + payload.quantity },
            );

            if (updated.rowsAffected === 1) return;
          }

          throw new Error(
            `ticket ${payload.ticketId} version conflict after ${RESTORE_ATTEMPT_LIMIT} attempts; rolling back for redelivery`,
          );
        });

        if (result.deduped) {
          logger?.info(
            { eventId, ticketId: payload.ticketId },
            "skipping duplicate order.reservation_released.v1",
          );
        }
      });
    },
  });
}

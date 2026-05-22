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

const MAX_RESTORE_ATTEMPTS = 2;

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
          // version having lost the race. Two failures and we give up and let the
          // inbox row commit — re-delivery would only re-fight the same race.
          for (let attempt = 0; attempt < MAX_RESTORE_ATTEMPTS; attempt++) {
            // eslint-disable-next-line no-await-in-loop -- serial retry by design
            const [row] = await tx.select().from(tickets).where(eq(tickets.id, payload.ticketId));
            if (!row) {
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

          logger?.warn(
            { eventId, ticketId: payload.ticketId, quantity: payload.quantity },
            "ticket version conflict after retry; acking without restore (inbox commits)",
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

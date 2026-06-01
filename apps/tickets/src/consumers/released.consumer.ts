import { type NatsConnection } from "@nats-io/transport-node";
import { eq } from "drizzle-orm";
import { Effect, Metric } from "effect";

import { orderReservationReleasedV1 } from "@tix/contracts/orders";
import { ORDER_RESERVATION_RELEASED_V1 } from "@tix/contracts/subjects";
import { withInboxDedupe } from "@tix/db-core/inbox";
import { updateVersioned } from "@tix/db-core/optimistic-version";
import { consumer, runScopedConsumer, type RunningConsumer } from "@tix/messaging/jetstream";
import { externalParent } from "@tix/observability/otel-trace";
import { withTimeout } from "@tix/observability/resilience";

import { tickets, ticketsInbox } from "../domain/schema.ts";
import { reservationsReleasedTotal } from "../runtime/metrics.ts";
import type { TicketsRuntime } from "../runtime/runtime.ts";
import { Database } from "../runtime/services.ts";

export const TICKETS_RELEASE_CONSUMER_GROUP = "tickets-release";

const RESTORE_ATTEMPT_LIMIT = 5;

export type StartTicketsReleasedConsumerArgs = {
  runtime: TicketsRuntime;
  nats: NatsConnection;
  stream: string;
  ackWaitMs?: number;
};

type RestoreOutcome = { kind: "restored" } | { kind: "unknown_ticket" };

export async function startTicketsReleasedConsumer(
  args: StartTicketsReleasedConsumerArgs,
): Promise<RunningConsumer> {
  const { runtime, nats, stream, ackWaitMs } = args;

  const ackWaitOpt = ackWaitMs === undefined ? {} : { ackWaitMs };

  return runScopedConsumer(
    runtime,
    consumer(nats, {
      stream,
      subjectFilter: ORDER_RESERVATION_RELEASED_V1,
      group: TICKETS_RELEASE_CONSUMER_GROUP,
      schema: orderReservationReleasedV1,
      ...ackWaitOpt,
      handler: ({ eventId, subject, payload, traceContext }) =>
        Effect.gen(function* () {
          const db = yield* Database;

          // The transaction returns a discriminated outcome so the diagnostics that used to
          // log inside the (non-Effect) island now log through Effect — span-correlated.
          const result = yield* withTimeout(
            "tickets.db.restore_inventory",
            Effect.tryPromise(() =>
              db.db.transaction((tx) =>
                withInboxDedupe(
                  tx,
                  ticketsInbox,
                  { eventId, subject },
                  async (): Promise<RestoreOutcome> => {
                    // Serial retry by design: each attempt depends on the previous attempt's
                    // version having lost the race. If we exhaust the budget we throw, which
                    // rolls back the inbox row inside this transaction and lets NATS redeliver
                    // — preferring a redelivery over silently losing the quantity restoration.
                    for (let attempt = 0; attempt < RESTORE_ATTEMPT_LIMIT; attempt++) {
                      // eslint-disable-next-line no-await-in-loop -- serial retry by design
                      const [row] = await tx
                        .select()
                        .from(tickets)
                        .where(eq(tickets.id, payload.ticketId));
                      if (!row) {
                        // Unknown ticketId is a no-op (inbox commits, no redelivery): a Ticket
                        // that never existed isn't coming back, and we don't want to wedge the
                        // consumer on a poison message.
                        return { kind: "unknown_ticket" };
                      }

                      // eslint-disable-next-line no-await-in-loop -- serial retry by design
                      const updated = await updateVersioned(
                        tx,
                        tickets,
                        { id: row.id, version: row.version },
                        { quantityAvailable: row.quantityAvailable + payload.quantity },
                      );

                      if (updated.rowsAffected === 1) return { kind: "restored" };
                    }

                    throw new Error(
                      `ticket ${payload.ticketId} version conflict after ${RESTORE_ATTEMPT_LIMIT} attempts; rolling back for redelivery`,
                    );
                  },
                ),
              ),
            ),
          );

          if (result.deduped) {
            yield* Effect.logInfo("skipping duplicate order.reservation_released.v1").pipe(
              Effect.annotateLogs({ eventId, ticketId: payload.ticketId }),
            );

            return;
          }

          if (result.result.kind === "unknown_ticket") {
            yield* Effect.logWarning(
              "order.reservation_released.v1 for unknown ticket; skipping",
            ).pipe(Effect.annotateLogs({ eventId, ticketId: payload.ticketId }));

            return;
          }

          yield* Metric.increment(reservationsReleasedTotal);
        }).pipe(
          Effect.withSpan("tickets.consume.reservation_released", {
            parent: externalParent(traceContext),
          }),
        ),
    }),
  );
}

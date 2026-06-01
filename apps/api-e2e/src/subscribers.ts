import type { NatsConnection } from "@nats-io/transport-node";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";

import { orderCreatedV1, orderExpiredV1, orderReservationReleasedV1 } from "@tix/contracts/orders";
import {
  ORDER_CREATED_V1,
  ORDER_EXPIRED_V1,
  ORDER_RESERVATION_RELEASED_V1,
  ORDERS_STREAM,
  TICKETS_CREATED_V1,
  TICKETS_STREAM,
} from "@tix/contracts/subjects";
import { ticketCreatedV1 } from "@tix/contracts/tickets";
import {
  consumer,
  defaultScopedRunner,
  runScopedConsumer,
  type RunningConsumer,
} from "@tix/messaging/jetstream";

export type ObservedEvent = {
  subject: string;
  eventId: string;
  payload: unknown;
  observedAt: string;
};

export type Subscription = {
  observed: readonly ObservedEvent[];
  stop: () => Promise<void>;
};

export async function subscribeAll(nc: NatsConnection): Promise<Subscription> {
  const observed: ObservedEvent[] = [];
  const group = `e2e-${randomUUID().replace(/-/g, "")}`;

  function record(subject: string, eventId: string, payload: unknown): void {
    observed.push({ subject, eventId, payload, observedAt: new Date().toISOString() });
    console.log(`  • observed ${subject} eventId=${eventId}`);
  }

  const consumers: RunningConsumer[] = [];

  consumers.push(
    await runScopedConsumer(
      defaultScopedRunner,
      consumer(nc, {
        stream: TICKETS_STREAM,
        subjectFilter: TICKETS_CREATED_V1,
        group: `${group}-tickets-created`,
        schema: ticketCreatedV1,
        handler: ({ subject, eventId, payload }) =>
          Effect.sync(() => record(subject, eventId, payload)),
      }),
    ),
    await runScopedConsumer(
      defaultScopedRunner,
      consumer(nc, {
        stream: ORDERS_STREAM,
        subjectFilter: ORDER_CREATED_V1,
        group: `${group}-order-created`,
        schema: orderCreatedV1,
        handler: ({ subject, eventId, payload }) =>
          Effect.sync(() => record(subject, eventId, payload)),
      }),
    ),
    await runScopedConsumer(
      defaultScopedRunner,
      consumer(nc, {
        stream: ORDERS_STREAM,
        subjectFilter: ORDER_EXPIRED_V1,
        group: `${group}-order-expired`,
        schema: orderExpiredV1,
        handler: ({ subject, eventId, payload }) =>
          Effect.sync(() => record(subject, eventId, payload)),
      }),
    ),
    await runScopedConsumer(
      defaultScopedRunner,
      consumer(nc, {
        stream: ORDERS_STREAM,
        subjectFilter: ORDER_RESERVATION_RELEASED_V1,
        group: `${group}-order-released`,
        schema: orderReservationReleasedV1,
        handler: ({ subject, eventId, payload }) =>
          Effect.sync(() => record(subject, eventId, payload)),
      }),
    ),
  );

  return {
    observed,
    stop: async () => {
      for (const c of consumers) {
        try {
          // eslint-disable-next-line no-await-in-loop -- stop consumers serially for clean NATS shutdown
          await c.stop();
        } catch {
          // best effort
        }
      }
    },
  };
}

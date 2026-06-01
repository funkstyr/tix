import { jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { createRouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { Effect, Fiber } from "effect";
import { randomUUID } from "node:crypto";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { paymentCreatedV1 } from "@tix/contracts/payments";
import { PAYMENT_CREATED_V1 } from "@tix/contracts/subjects";
import { outboxRelay } from "@tix/db-core/outbox";
import {
  consumer,
  createPublisher,
  defaultScopedRunner,
  runScopedConsumer,
  type RunningConsumer,
} from "@tix/messaging/jetstream";
import { dockerAvailable } from "@tix/test-helpers/docker-available";
import { requireValue } from "@tix/test-helpers/require-value";

import {
  payments as paymentsTable,
  paymentsOutbox as paymentsOutboxTable,
} from "../domain/schema.ts";
import {
  type PaymentsTestStack,
  seedOrder as fixtureSeedOrder,
  signUpBuyer as fixtureSignUpBuyer,
  startPaymentsTestStack,
  stopPaymentsTestStack,
  truncatePaymentsTestStack,
} from "../payments-test-fixtures.ts";
import { createPaymentsTestRuntime } from "../runtime/test-runtime.ts";
import type { PaymentIntentClient } from "../stripe-payment-intent.ts";
import { createPaymentsRouter } from "./router.ts";

function runRelay(
  db: Parameters<typeof outboxRelay>[0],
  table: Parameters<typeof outboxRelay>[1],
  publish: Parameters<typeof outboxRelay>[2],
  options: Parameters<typeof outboxRelay>[3],
): { stop: () => Promise<void> } {
  const fiber = Effect.runFork(outboxRelay(db, table, publish, options));
  return { stop: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined) };
}

let stack: PaymentsTestStack | undefined;
let natsContainer: StartedTestContainer | undefined;
let nats: NatsConnection | undefined;
let relay: { stop: () => Promise<void> } | undefined;
let streamName: string | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  stack = await startPaymentsTestStack("payments_publish_e2e");

  natsContainer = await new GenericContainer("nats:2.10-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .start();

  const natsUrl = `nats://${natsContainer.getHost()}:${natsContainer.getMappedPort(4222)}`;
  nats = await connect({ servers: natsUrl });

  streamName = `S_${randomUUID().replace(/-/g, "")}`;
  const manager = await jetstreamManager(nats);
  await manager.streams.add({
    name: streamName,
    subjects: [PAYMENT_CREATED_V1],
    retention: RetentionPolicy.Limits,
    storage: StorageType.Memory,
  });

  const publisher = createPublisher(nats);
  relay = runRelay(stack.paymentsDb.db, paymentsOutboxTable, publisher.publish, {
    pollIntervalMs: 50,
  });
}, 180_000);

afterAll(async () => {
  await relay?.stop();
  await nats?.close();
  await natsContainer?.stop();
  if (stack) await stopPaymentsTestStack(stack);
});

beforeEach(async () => {
  if (stack) await truncatePaymentsTestStack(stack);
});

function buildClient(paymentIntentClient: PaymentIntentClient) {
  const s = requireValue(stack, "stack");
  const runtime = createPaymentsTestRuntime({
    db: s.paymentsDb,
    authClient: s.authSessionClient,
    paymentIntentClient,
  });
  const router = createPaymentsRouter(runtime);

  return createRouterClient(router, { context: { otelParent: ROOT_CONTEXT } });
}

async function signUpBuyer(): Promise<{ userId: string; token: string }> {
  return fixtureSignUpBuyer(requireValue(stack, "stack").authClient);
}

async function seedOrder(buyerId: string, priceCents: number): Promise<string> {
  return fixtureSeedOrder(requireValue(stack, "stack").paymentsDb, buyerId, priceCents);
}

function getPaymentsDb() {
  return requireValue(stack, "stack").paymentsDb;
}

describe.skipIf(!dockerAvailable)("payments.create → payment.created.v1 on NATS", () => {
  it("delivers a payment.created.v1 to a subscriber after a successful charge", async () => {
    const nc = requireValue(nats, "nats");
    const stream = requireValue(streamName, "streamName");

    const buyer = await signUpBuyer();
    const orderId = await seedOrder(buyer.userId, 4_500);

    const createPaymentIntent = vi
      .fn<PaymentIntentClient["createPaymentIntent"]>()
      .mockResolvedValue({
        stripeId: "pi_3OqVuk2eZvKYlo2C1Tt5KvP3",
        status: "succeeded",
      });

    let resolveEvent!: (args: { eventId: string; payload: unknown }) => void;
    const received = new Promise<{ eventId: string; payload: unknown }>((r) => {
      resolveEvent = r;
    });

    const group = `g-${randomUUID().replace(/-/g, "")}`;
    const consumerHandle: RunningConsumer = await runScopedConsumer(
      defaultScopedRunner,
      consumer(nc, {
        stream,
        subjectFilter: PAYMENT_CREATED_V1,
        group,
        schema: paymentCreatedV1,
        handler: ({ eventId, payload }) =>
          Effect.sync(() => {
            if (payload.orderId === orderId) resolveEvent({ eventId, payload });
          }),
      }),
    );

    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const client = buildClient({ createPaymentIntent });
      const result = await client.create({
        token: buyer.token,
        orderId,
        paymentMethodId: "pm_card_visa",
      });

      const observed = await Promise.race([
        received,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("did not receive payment.created.v1 within 2s")),
            2_000,
          );
        }),
      ]);

      expect(observed.payload).toMatchObject({
        id: result.id,
        orderId,
        stripeId: "pi_3OqVuk2eZvKYlo2C1Tt5KvP3",
        amountCents: 4_500,
        currency: "usd",
        userId: buyer.userId,
        version: 1,
      });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      await consumerHandle.stop();
    }
  }, 30_000);

  it("emits no Payment row, no outbox row, and no event when Stripe returns a non-succeeded status", async () => {
    const nc = requireValue(nats, "nats");
    const stream = requireValue(streamName, "streamName");
    const db = getPaymentsDb();

    const buyer = await signUpBuyer();
    const orderId = await seedOrder(buyer.userId, 3_300);

    const createPaymentIntent = vi
      .fn<PaymentIntentClient["createPaymentIntent"]>()
      .mockResolvedValue({
        stripeId: "pi_3OqNotSucceeded00000ABCDE",
        status: "requires_payment_method",
      });

    // Subscribe before driving the mutation so a (mis-)published event would
    // be observed — this is the proof that nothing reaches the broker.
    let observed = false;
    const group = `g-${randomUUID().replace(/-/g, "")}`;
    const consumerHandle: RunningConsumer = await runScopedConsumer(
      defaultScopedRunner,
      consumer(nc, {
        stream,
        subjectFilter: PAYMENT_CREATED_V1,
        group,
        schema: paymentCreatedV1,
        handler: ({ payload }) =>
          Effect.sync(() => {
            if (payload.orderId === orderId) observed = true;
          }),
      }),
    );

    try {
      const client = buildClient({ createPaymentIntent });
      await expect(
        client.create({
          token: buyer.token,
          orderId,
          paymentMethodId: "pm_card_visa",
        }),
      ).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT", status: 422 });

      // Wait long enough for several 50ms relay ticks to have fired so a
      // mis-enqueued event would have made it through by now.
      await new Promise((r) => setTimeout(r, 500));

      const paymentRows = await db.db
        .select()
        .from(paymentsTable)
        .where(eq(paymentsTable.orderId, orderId));
      expect(paymentRows).toHaveLength(0);

      const outboxRows = await db.db
        .select()
        .from(paymentsOutboxTable)
        .where(eq(paymentsOutboxTable.subject, PAYMENT_CREATED_V1));
      expect(outboxRows).toHaveLength(0);

      expect(observed).toBe(false);
    } finally {
      await consumerHandle.stop();
    }
  }, 30_000);
});

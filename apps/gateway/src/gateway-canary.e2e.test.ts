import { serve, type ServerType } from "@hono/node-server";
import { jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createAuthApp } from "auth/app";
import { createAuth } from "auth/instance";
import { authTables } from "auth/schema";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { createOrdersApp } from "orders/app";
import { startOrdersExpiredConsumer } from "orders/consumer";
import { startOrdersPaymentCreatedConsumer } from "orders/payment-consumer";
import { ordersOutbox, ordersTables } from "orders/schema";
import { createHttpTicketsClient } from "orders/tickets-client";
import { createPaymentsApp } from "payments/app";
import {
  startPaymentsOrderCancelledConsumer,
  startPaymentsOrderCreatedConsumer,
} from "payments/consumer";
import { paymentsOutbox, paymentsTables } from "payments/schema";
import type { PaymentIntentClient } from "payments/stripe-payment-intent";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createTicketsApp } from "tickets/app";
import { startTicketsReleasedConsumer } from "tickets/consumer";
import { ticketsOutbox, ticketsTables } from "tickets/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthRouterClient } from "@tix/contracts/auth";
import { createHttpAuthSessionClient } from "@tix/contracts/auth-client";
import type { OrdersRouterClient } from "@tix/contracts/orders";
import type { PaymentsRouterClient } from "@tix/contracts/payments";
import { RPC_PREFIX } from "@tix/contracts/rpc";
import { ORDERS_STREAM, PAYMENTS_STREAM, TICKETS_STREAM } from "@tix/contracts/subjects";
import type { TicketsRouterClient } from "@tix/contracts/tickets";
import { createDbClient } from "@tix/db-core/client";
import { startOutboxRelay, type RunningOutboxRelay } from "@tix/db-core/outbox";
import { createPublisher, type RunningConsumer } from "@tix/messaging/jetstream";
import { createLogger } from "@tix/observability/logger";
import { dockerAvailable } from "@tix/test-helpers/docker-available";
import { requireValue } from "@tix/test-helpers/require-value";
import { waitFor } from "@tix/test-helpers/wait-for";

import { createDownstreamClients } from "./downstream-clients.ts";
import { createGatewayApp } from "./gateway-app.ts";
import { createGatewayRouter } from "./gateway-router.ts";

const TEST_SECRET = "test-secret-do-not-use-in-prod-test-secret-do-not-use-in-prod";
const TEST_SERVICE_TOKEN = "canary-service-token";
const WEB_ORIGIN = "https://canary.tix.test";
const AUTH_BASE_URL_PLACEHOLDER = "http://auth.canary.test";

const authMigrations = fileURLToPath(new URL("../../auth/drizzle", import.meta.url));
const ticketsMigrations = fileURLToPath(new URL("../../tickets/drizzle", import.meta.url));
const ordersMigrations = fileURLToPath(new URL("../../orders/drizzle", import.meta.url));
const paymentsMigrations = fileURLToPath(new URL("../../payments/drizzle", import.meta.url));

type GatewayClient = {
  tickets: TicketsRouterClient;
  orders: OrdersRouterClient;
  payments: PaymentsRouterClient;
};

type Stack = {
  authClient: AuthRouterClient;
  gatewayClient: GatewayClient;
};

type StackResources = Stack & {
  shutdown: () => Promise<void>;
};

let pgContainer: StartedTestContainer | undefined;
let natsContainer: StartedTestContainer | undefined;
let stack: StackResources | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  pgContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "gateway_canary",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  natsContainer = await new GenericContainer("nats:2.10-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .start();

  const pgUrl = `postgres://postgres:postgres@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/gateway_canary`;
  const natsUrl = `nats://${natsContainer.getHost()}:${natsContainer.getMappedPort(4222)}`;

  stack = await startStack(pgUrl, natsUrl);
}, 240_000);

afterAll(async () => {
  await stack?.shutdown();
  await natsContainer?.stop();
  await pgContainer?.stop();
});

function getStack(): Stack {
  return requireValue(stack, "stack");
}

describe.skipIf(!dockerAvailable)("gateway canary: signup → ticket → order → pay", () => {
  it("completes the Buyer flow end-to-end with the Order finishing in `complete`", async () => {
    const { authClient, gatewayClient } = getStack();

    const seller = await authClient.signUp({
      email: `seller-${Date.now()}@canary.test`,
      password: "correct-horse-battery",
      name: "Canary Seller",
    });
    const buyer = await authClient.signUp({
      email: `buyer-${Date.now()}@canary.test`,
      password: "correct-horse-battery",
      name: "Canary Buyer",
    });

    const ticket = await gatewayClient.tickets.create({
      token: seller.token,
      title: "Canary Show @ The Venue",
      quantityTotal: 4,
      unitPriceCents: 4_500,
    });
    expect(ticket.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ticket.quantityAvailable).toBe(4);

    const order = await gatewayClient.orders.create({
      token: buyer.token,
      ticketId: ticket.id,
      quantity: 1,
    });
    expect(order.status).toBe("created");
    expect(order.buyerId).toBe(buyer.userId);
    expect(order.ticketId).toBe(ticket.id);

    // Payments needs its order_read_model projection (driven by order.created.v1
    // via NATS) before payments.create can find the order. Retry briefly until
    // the projection lands rather than sleeping a fixed duration.
    const payment = await waitFor(async () => {
      try {
        return await gatewayClient.payments.create({
          token: buyer.token,
          orderId: order.id,
          paymentMethodId: "pm_card_visa",
        });
      } catch (err) {
        if ((err as { code?: string }).code === "NOT_FOUND") return undefined;
        throw err;
      }
    }, 5_000);
    expect(payment.status).toBe("succeeded");
    expect(payment.id).toMatch(/^[0-9a-f-]{36}$/);

    // payment.created.v1 → orders consumer → order.status = complete, version 2.
    const completed = await waitFor(async () => {
      const fetched = await gatewayClient.orders.getById({
        token: buyer.token,
        orderId: order.id,
      });

      return fetched?.status === "complete" ? fetched : undefined;
    }, 10_000);
    expect(completed.status).toBe("complete");
    expect(completed.version).toBe(2);
  }, 90_000);
});

async function startStack(pgUrl: string, natsUrl: string): Promise<StackResources> {
  const logger = createLogger({ name: "canary", level: "silent" });

  // Each service "owns" its schema (ADR-0003) and its own drizzle migration
  // folder; run sequentially so they don't race on drizzle's
  // __drizzle_migrations metadata.
  const authDb = createDbClient("auth", pgUrl, { schema: authTables });
  await migrate(authDb.db, { migrationsFolder: authMigrations });

  const ticketsDb = createDbClient("tickets", pgUrl, { schema: ticketsTables });
  await migrate(ticketsDb.db, { migrationsFolder: ticketsMigrations });

  const ordersDb = createDbClient("orders", pgUrl, { schema: ordersTables });
  await migrate(ordersDb.db, { migrationsFolder: ordersMigrations });

  const paymentsDb = createDbClient("payments", pgUrl, { schema: paymentsTables });
  await migrate(paymentsDb.db, { migrationsFolder: paymentsMigrations });

  const nats = await connect({ servers: natsUrl });
  const manager = await jetstreamManager(nats);
  await manager.streams.add({
    name: TICKETS_STREAM,
    subjects: ["tickets.>"],
    retention: RetentionPolicy.Limits,
    storage: StorageType.Memory,
  });
  await manager.streams.add({
    name: ORDERS_STREAM,
    subjects: ["order.>"],
    retention: RetentionPolicy.Limits,
    storage: StorageType.Memory,
  });
  await manager.streams.add({
    name: PAYMENTS_STREAM,
    subjects: ["payment.>"],
    retention: RetentionPolicy.Limits,
    storage: StorageType.Memory,
  });

  const publisher = createPublisher(nats, { logger });

  const auth = createAuth({
    db: authDb.db,
    secret: TEST_SECRET,
    baseURL: AUTH_BASE_URL_PLACEHOLDER,
  });
  const { server: authServer, baseUrl: authBaseUrl } = await listen(
    createAuthApp({ auth, logger }),
  );
  const authSessionClient = createHttpAuthSessionClient(authBaseUrl);

  const ticketsAppHono = createTicketsApp({
    db: ticketsDb,
    authClient: authSessionClient,
    serviceToken: TEST_SERVICE_TOKEN,
    logger,
  });
  const { server: ticketsServer, baseUrl: ticketsBaseUrl } = await listen(ticketsAppHono);
  const ticketsOutboxRelay = startOutboxRelay(ticketsDb.db, ticketsOutbox, publisher.publish, {
    logger,
    pollIntervalMs: 25,
  });
  const ticketsReleasedConsumer = await startTicketsReleasedConsumer({
    db: ticketsDb,
    nats,
    stream: ORDERS_STREAM,
    logger,
  });

  const ticketsHttpClient = createHttpTicketsClient(ticketsBaseUrl, TEST_SERVICE_TOKEN);
  const ordersAppHono = createOrdersApp({
    db: ordersDb,
    authClient: authSessionClient,
    ticketsClient: ticketsHttpClient,
    reservationTtlMs: 15 * 60 * 1000,
    logger,
  });
  const { server: ordersServer, baseUrl: ordersBaseUrl } = await listen(ordersAppHono);
  const ordersOutboxRelay = startOutboxRelay(ordersDb.db, ordersOutbox, publisher.publish, {
    logger,
    pollIntervalMs: 25,
  });
  const ordersExpiredConsumer = await startOrdersExpiredConsumer({
    db: ordersDb,
    nats,
    stream: ORDERS_STREAM,
    logger,
  });
  const ordersPaymentConsumer = await startOrdersPaymentCreatedConsumer({
    db: ordersDb,
    nats,
    stream: PAYMENTS_STREAM,
    logger,
  });

  const stubPaymentIntentClient: PaymentIntentClient = {
    createPaymentIntent: async ({ orderId }) => ({
      stripeId: `pi_${orderId.replace(/-/g, "").slice(0, 24)}`,
      status: "succeeded",
    }),
  };
  const paymentsAppHono = createPaymentsApp({
    db: paymentsDb,
    authClient: authSessionClient,
    paymentIntentClient: stubPaymentIntentClient,
    logger,
  });
  const { server: paymentsServer, baseUrl: paymentsBaseUrl } = await listen(paymentsAppHono);
  const paymentsOutboxRelay = startOutboxRelay(paymentsDb.db, paymentsOutbox, publisher.publish, {
    logger,
    pollIntervalMs: 25,
  });
  const paymentsOrderCreatedConsumer = await startPaymentsOrderCreatedConsumer({
    db: paymentsDb,
    nats,
    stream: ORDERS_STREAM,
    logger,
  });
  const paymentsOrderCancelledConsumer = await startPaymentsOrderCancelledConsumer({
    db: paymentsDb,
    nats,
    stream: ORDERS_STREAM,
    logger,
  });

  const downstreamClients = createDownstreamClients({
    ticketsBaseUrl,
    ordersBaseUrl,
    paymentsBaseUrl,
    authBaseUrl,
  });
  const gatewayRouter = createGatewayRouter({ clients: downstreamClients });
  const gatewayAppHono = createGatewayApp({
    logger,
    webOrigin: WEB_ORIGIN,
    router: gatewayRouter,
    authBaseUrl,
  });
  const { server: gatewayServer, baseUrl: gatewayBaseUrl } = await listen(gatewayAppHono);

  const authClient: AuthRouterClient = createORPCClient(
    new RPCLink({ url: `${authBaseUrl}${RPC_PREFIX}` }),
  );
  const gatewayClient: GatewayClient = createORPCClient(
    new RPCLink({ url: `${gatewayBaseUrl}${RPC_PREFIX}` }),
  );

  const consumers: RunningConsumer[] = [
    ticketsReleasedConsumer,
    ordersExpiredConsumer,
    ordersPaymentConsumer,
    paymentsOrderCreatedConsumer,
    paymentsOrderCancelledConsumer,
  ];
  const relays: RunningOutboxRelay[] = [ticketsOutboxRelay, ordersOutboxRelay, paymentsOutboxRelay];
  const servers: ServerType[] = [
    gatewayServer,
    paymentsServer,
    ordersServer,
    ticketsServer,
    authServer,
  ];

  return {
    authClient,
    gatewayClient,
    shutdown: async () => {
      await Promise.all(consumers.map((c) => c.stop()));
      await Promise.all(relays.map((r) => r.stop()));
      for (const srv of servers) {
        // eslint-disable-next-line no-await-in-loop -- sequential close to avoid noise
        await new Promise<void>((resolve, reject) =>
          srv.close((err) => (err ? reject(err) : resolve())),
        );
      }
      await nats.close();
      await paymentsDb.close();
      await ordersDb.close();
      await ticketsDb.close();
      await authDb.close();
    },
  };
}

type Listening = { server: ServerType; baseUrl: string };

function listen(app: {
  fetch: (req: Request) => Response | Promise<Response>;
}): Promise<Listening> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not resolve bound address"));
        return;
      }
      const port = info?.port ?? address.port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

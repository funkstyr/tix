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
import { createTicketsApp } from "tickets/app";
import { startTicketsReleasedConsumer } from "tickets/consumer";
import { ticketsOutbox, ticketsTables } from "tickets/schema";

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

export type GatewayClient = {
  tickets: TicketsRouterClient;
  orders: OrdersRouterClient;
  payments: PaymentsRouterClient;
};

export type CanaryStack = {
  authClient: AuthRouterClient;
  gatewayClient: GatewayClient;
};

export type CanaryStackResources = CanaryStack & {
  shutdown: () => Promise<void>;
};

export async function startCanaryStack(
  pgUrl: string,
  natsUrl: string,
): Promise<CanaryStackResources> {
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

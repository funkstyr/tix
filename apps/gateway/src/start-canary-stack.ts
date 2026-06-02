import { serve, type ServerType } from "@hono/node-server";
import { jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createAuthApp } from "auth/app";
import { createAuth } from "auth/instance";
import { authTables } from "auth/schema";
import { createAuthTestRuntime } from "auth/test-runtime";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Effect, Fiber } from "effect";
import { fileURLToPath } from "node:url";
import { createOrdersApp } from "orders/app";
import { startOrdersExpiredConsumer } from "orders/consumer";
import { startOrdersPaymentCreatedConsumer } from "orders/payment-consumer";
import { ordersOutbox, ordersTables } from "orders/schema";
import { createOrdersTestRuntime } from "orders/test-runtime";
import { createHttpTicketsClient } from "orders/tickets-client";
import { createPaymentsApp } from "payments/app";
import {
  startPaymentsOrderCancelledConsumer,
  startPaymentsOrderCreatedConsumer,
} from "payments/consumer";
import { paymentsOutbox, paymentsTables } from "payments/schema";
import type { PaymentIntentClient } from "payments/stripe-payment-intent";
import { createPaymentsTestRuntime } from "payments/test-runtime";
import { createTicketsApp } from "tickets/app";
import { startTicketsReleasedConsumer } from "tickets/consumer";
import { ticketsOutbox, ticketsTables } from "tickets/schema";
import { createTicketsTestRuntime } from "tickets/test-runtime";

import type { AuthRouterClient } from "@tix/contracts/auth";
import { createHttpAuthSessionClient } from "@tix/contracts/auth-client";
import type { OrdersRouterClient } from "@tix/contracts/orders";
import type { PaymentsRouterClient } from "@tix/contracts/payments";
import { RPC_PREFIX } from "@tix/contracts/rpc";
import { ORDERS_STREAM, PAYMENTS_STREAM, TICKETS_STREAM } from "@tix/contracts/subjects";
import type { TicketsRouterClient } from "@tix/contracts/tickets";
import { createDbClient } from "@tix/db-core/client";
import {
  outboxRelay,
  type OutboxPublish,
  type OutboxRelayOptions,
  type OutboxTable,
} from "@tix/db-core/outbox";
import { createPublisher, type RunningConsumer } from "@tix/messaging/jetstream";

import { createDownstreamClients } from "./downstream-clients.ts";
import { createGatewayApp } from "./gateway-app.ts";
import { createGatewayTestRuntime } from "./gateway-test-runtime.ts";

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
  // The Playwright harness needs the gateway URL to bake into VITE_GATEWAY_URL
  // before spawning the web dev server. Tests that go through the in-process
  // gatewayClient can ignore it.
  gatewayBaseUrl: string;
  shutdown: () => Promise<void>;
};

export type CanaryStackOptions = {
  // The default stub PaymentIntent client returns `succeeded` synchronously,
  // which is perfect for the in-process gateway canary. Swap in a real
  // Stripe-backed client when running the browser flow against
  // `<PaymentElement>`, since the iframe tokenizes a card and the gateway
  // must confirm a real PaymentIntent for `payment.created.v1` to fire.
  paymentIntentClient?: PaymentIntentClient;
  // CORS allow-list on the gateway. Override when running against a real
  // browser whose origin is the Vite dev server, not the canary placeholder.
  webOrigin?: string;
  // Shorten the reservation TTL when tests need to assert expiry; leave at
  // 15min for happy-path flows so the Order doesn't expire mid-checkout.
  reservationTtlMs?: number;
};

export async function startCanaryStack(
  pgUrl: string,
  natsUrl: string,
  options: CanaryStackOptions = {},
): Promise<CanaryStackResources> {
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

  const publisher = createPublisher(nats);

  const auth = createAuth({
    db: authDb.db,
    secret: TEST_SECRET,
    baseURL: AUTH_BASE_URL_PLACEHOLDER,
    // When the caller passes `webOrigin`, trust it as a better-auth origin
    // too — otherwise the browser hits "Invalid origin" on every signup.
    ...(options.webOrigin === undefined ? {} : { trustedOrigins: [options.webOrigin] }),
  });
  const { server: authServer, baseUrl: authBaseUrl } = await listen(
    createAuthApp({ runtime: createAuthTestRuntime({ auth }) }),
  );
  const authSessionClient = createHttpAuthSessionClient(authBaseUrl);

  // tickets now runs on an Effect runtime (ADR-0008); build one from the canary's
  // already-constructed collaborators and share it across the app and its consumer. The
  // service token must match the one orders' tickets client sends so reserve authorizes.
  const ticketsRuntime = createTicketsTestRuntime({
    db: ticketsDb,
    authClient: authSessionClient,
    nats,
    serviceToken: TEST_SERVICE_TOKEN,
  });
  const ticketsAppHono = createTicketsApp(ticketsRuntime);
  const { server: ticketsServer, baseUrl: ticketsBaseUrl } = await listen(ticketsAppHono);
  const ticketsOutboxRelay = forkRelay(ticketsDb.db, ticketsOutbox, publisher.publish, {
    pollIntervalMs: 25,
  });
  const ticketsReleasedConsumer = await startTicketsReleasedConsumer({
    runtime: ticketsRuntime,
    nats,
    stream: ORDERS_STREAM,
  });

  const ticketsHttpClient = createHttpTicketsClient(ticketsBaseUrl, TEST_SERVICE_TOKEN);
  // orders now runs on an Effect runtime (ADR-0008); build one from the canary's
  // already-constructed collaborators and share it across the app and consumers.
  const ordersRuntime = createOrdersTestRuntime({
    db: ordersDb,
    authClient: authSessionClient,
    ticketsClient: ticketsHttpClient,
    nats,
    reservationTtlMs: options.reservationTtlMs ?? 15 * 60 * 1000,
  });
  const ordersAppHono = createOrdersApp(ordersRuntime);
  const { server: ordersServer, baseUrl: ordersBaseUrl } = await listen(ordersAppHono);
  const ordersOutboxRelay = forkRelay(ordersDb.db, ordersOutbox, publisher.publish, {
    pollIntervalMs: 25,
  });
  const ordersExpiredConsumer = await startOrdersExpiredConsumer({
    runtime: ordersRuntime,
    nats,
    stream: ORDERS_STREAM,
  });
  const ordersPaymentConsumer = await startOrdersPaymentCreatedConsumer({
    runtime: ordersRuntime,
    nats,
    stream: PAYMENTS_STREAM,
  });

  const stubPaymentIntentClient: PaymentIntentClient = {
    createPaymentIntent: async ({ orderId }) => ({
      stripeId: `pi_${orderId.replace(/-/g, "").slice(0, 24)}`,
      status: "succeeded",
    }),
  };
  // payments now runs on an Effect runtime (ADR-0008); build one from the canary's
  // already-constructed collaborators and share it across the app and its consumers.
  const paymentsRuntime = createPaymentsTestRuntime({
    db: paymentsDb,
    authClient: authSessionClient,
    paymentIntentClient: options.paymentIntentClient ?? stubPaymentIntentClient,
    nats,
  });
  const paymentsAppHono = createPaymentsApp(paymentsRuntime);
  const { server: paymentsServer, baseUrl: paymentsBaseUrl } = await listen(paymentsAppHono);
  const paymentsOutboxRelay = forkRelay(paymentsDb.db, paymentsOutbox, publisher.publish, {
    pollIntervalMs: 25,
  });
  const paymentsOrderCreatedConsumer = await startPaymentsOrderCreatedConsumer({
    runtime: paymentsRuntime,
    nats,
    stream: ORDERS_STREAM,
  });
  const paymentsOrderCancelledConsumer = await startPaymentsOrderCancelledConsumer({
    runtime: paymentsRuntime,
    nats,
    stream: ORDERS_STREAM,
  });

  const downstreamClients = createDownstreamClients({
    ticketsBaseUrl,
    ordersBaseUrl,
    paymentsBaseUrl,
    authBaseUrl,
  });
  // gateway now runs on an Effect runtime (ADR-0008); build one from the canary's
  // already-constructed downstream clients (no OTLP — pretty logger only).
  const gatewayRuntime = createGatewayTestRuntime({ clients: downstreamClients });
  const gatewayAppHono = createGatewayApp({
    runtime: gatewayRuntime,
    webOrigin: options.webOrigin ?? WEB_ORIGIN,
    authBaseUrl,
    faroCollectorUrl: "http://otel-collector:8090/",
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
  const relays: RelayHandle[] = [ticketsOutboxRelay, ordersOutboxRelay, paymentsOutboxRelay];
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
    gatewayBaseUrl,
    shutdown: async () => {
      await Promise.all(consumers.map((c) => c.stop()));
      await Promise.all(relays.map((r) => r.stop()));
      for (const srv of servers) {
        // eslint-disable-next-line no-await-in-loop -- sequential close to avoid noise
        await new Promise<void>((resolve, reject) =>
          srv.close((err) => (err ? reject(err) : resolve())),
        );
      }
      // Dispose the gateway runtime after its server is closed (LIFO spirit).
      await gatewayRuntime.dispose();
      await nats.close();
      await paymentsDb.close();
      await ordersDb.close();
      await ticketsDb.close();
      await authDb.close();
    },
  };
}

type Listening = { server: ServerType; baseUrl: string };

type RelayHandle = { stop: () => Promise<void> };

// The canary runs on no service runtime, so fork the relay program on the default runtime
// and stop it by interrupting the fiber (the poll loop ends; unsent rows wait for restart).
function forkRelay(
  db: Parameters<typeof outboxRelay>[0],
  table: OutboxTable,
  publish: OutboxPublish,
  options: OutboxRelayOptions,
): RelayHandle {
  const fiber = Effect.runFork(outboxRelay(db, table, publish, options));
  return { stop: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined) };
}

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

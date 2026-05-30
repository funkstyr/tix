import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import { IngressRoutes } from "./components/ingress-routes.ts";
import { MigrationJob } from "./components/migration-job.ts";
import { ObservabilityStack } from "./components/observability-stack.ts";
import { PostgresRoles, type PostgresRole } from "./components/postgres-roles.ts";
import { ServiceDeployment } from "./components/service-deployment.ts";
import { StatefulInfra } from "./components/stateful-infra.ts";
import { StreamBootstrap } from "./components/stream-bootstrap.ts";

const POSTGRES_PORT = 5432;
const POSTGRES_DATABASE = "tix";

const AUTH_PORT = 4001;
const TICKETS_PORT = 4002;
const ORDERS_PORT = 4003;
const PAYMENTS_PORT = 4004;
const GATEWAY_PORT = 4000;
const WEB_PORT = 80;
const GRAFANA_PORT = 3000;

const NATS_URL = "nats://nats:4222";
const REDIS_URL = "redis://redis:6379";
const AUTH_BASE_URL = `http://auth:${AUTH_PORT}`;
const TICKETS_BASE_URL = `http://tickets:${TICKETS_PORT}`;
const ORDERS_BASE_URL = `http://orders:${ORDERS_PORT}`;
const PAYMENTS_BASE_URL = `http://payments:${PAYMENTS_PORT}`;

export const stack = pulumi.getStack();

const config = new pulumi.Config();
const desiredNamespace = config.get("namespace") ?? "tix";
const postgresPassword = config.requireSecret("postgresPassword");
const authPassword = config.requireSecret("authPassword");
const ticketsPassword = config.requireSecret("ticketsPassword");
const ordersPassword = config.requireSecret("ordersPassword");
const paymentsPassword = config.requireSecret("paymentsPassword");
const expirationPassword = config.requireSecret("expirationPassword");
const betterAuthSecret = config.requireSecret("betterAuthSecret");
const ticketsServiceToken = config.requireSecret("ticketsServiceToken");
const stripeKey = config.requireSecret("stripeKey");
const garageRpcSecret = config.requireSecret("garageRpcSecret");
const garageAdminToken = config.requireSecret("garageAdminToken");
const garageS3AccessKey = config.get("garageS3AccessKey") ?? "GKa1b2c3d4e5f60718293a4b5c";
const garageS3SecretKey = config.requireSecret("garageS3SecretKey");
const webOrigin = config.get("webOrigin") ?? "http://localhost:4000";
const ingressHost = config.get("host") ?? "localhost";

const authImage = config.get("authImage") ?? "tix-auth:dev";
const ticketsImage = config.get("ticketsImage") ?? "tix-tickets:dev";
const ordersImage = config.get("ordersImage") ?? "tix-orders:dev";
const paymentsImage = config.get("paymentsImage") ?? "tix-payments:dev";
const expirationImage = config.get("expirationImage") ?? "tix-expiration:dev";
const gatewayImage = config.get("gatewayImage") ?? "tix-gateway:dev";
const webImage = config.get("webImage") ?? "tix-web:dev";
const imagePullPolicy = config.get("imagePullPolicy") ?? "Never";

const namespace = new k8s.core.v1.Namespace("tix-namespace", {
  metadata: { name: desiredNamespace },
});

const infra = new StatefulInfra(
  "tix",
  {
    namespace: namespace.metadata.name,
    postgres: {
      password: postgresPassword,
      database: POSTGRES_DATABASE,
      storage: "1Gi",
    },
    nats: { storage: "1Gi" },
  },
  { dependsOn: namespace },
);

// In-cluster OpenTelemetry stack (ADR-0009): gateway collector + discrete
// Tempo/Loki/Prometheus/Grafana on Garage (S3). Infra-only for now — no service
// emits to `otel-collector:4317` yet. Grafana serves under the `/grafana` prefix
// the ingress routes to it.
const observability = new ObservabilityStack(
  "tix",
  {
    namespace: namespace.metadata.name,
    grafanaRootUrl: `http://${ingressHost}/grafana`,
    garageRpcSecret,
    garageAdminToken,
    garageS3AccessKey,
    garageS3SecretKey,
  },
  { dependsOn: namespace },
);

// URL-encode role passwords so reserved characters (`@ : / ? # %`) don't
// corrupt the connection string and surface as opaque driver errors at
// migration time.
function buildDatabaseUrl(schema: string, password: pulumi.Output<string>): pulumi.Output<string> {
  const user = `${schema}_user`;
  return password.apply(
    (pw) =>
      `postgres://${user}:${encodeURIComponent(pw)}@postgres:${POSTGRES_PORT}/${POSTGRES_DATABASE}`,
  );
}

const authSecret = new k8s.core.v1.Secret("auth-credentials", {
  metadata: { name: "auth-credentials", namespace: namespace.metadata.name },
  stringData: {
    AUTH_PASSWORD: authPassword,
    BETTER_AUTH_SECRET: betterAuthSecret,
    DATABASE_URL: buildDatabaseUrl("auth", authPassword),
  },
});

const ticketsSecret = new k8s.core.v1.Secret("tickets-credentials", {
  metadata: { name: "tickets-credentials", namespace: namespace.metadata.name },
  stringData: {
    TICKETS_PASSWORD: ticketsPassword,
    TICKETS_SERVICE_TOKEN: ticketsServiceToken,
    DATABASE_URL: buildDatabaseUrl("tickets", ticketsPassword),
  },
});

// `orders` reads `TICKETS_SERVICE_TOKEN` from `tickets-credentials` (single
// source of truth, see ordersDeployment.secrets below). The tickets Secret
// must therefore outlive any orders Deployment that references it.
const ordersSecret = new k8s.core.v1.Secret("orders-credentials", {
  metadata: { name: "orders-credentials", namespace: namespace.metadata.name },
  stringData: {
    ORDERS_PASSWORD: ordersPassword,
    DATABASE_URL: buildDatabaseUrl("orders", ordersPassword),
  },
});

const paymentsSecret = new k8s.core.v1.Secret("payments-credentials", {
  metadata: { name: "payments-credentials", namespace: namespace.metadata.name },
  stringData: {
    PAYMENTS_PASSWORD: paymentsPassword,
    STRIPE_KEY: stripeKey,
    DATABASE_URL: buildDatabaseUrl("payments", paymentsPassword),
  },
});

const expirationSecret = new k8s.core.v1.Secret("expiration-credentials", {
  metadata: { name: "expiration-credentials", namespace: namespace.metadata.name },
  stringData: {
    EXPIRATION_PASSWORD: expirationPassword,
    DATABASE_URL: buildDatabaseUrl("expiration", expirationPassword),
  },
});

const roles: PostgresRole[] = [
  { schema: "auth", password: { name: authSecret.metadata.name, key: "AUTH_PASSWORD" } },
  { schema: "tickets", password: { name: ticketsSecret.metadata.name, key: "TICKETS_PASSWORD" } },
  { schema: "orders", password: { name: ordersSecret.metadata.name, key: "ORDERS_PASSWORD" } },
  {
    schema: "payments",
    password: { name: paymentsSecret.metadata.name, key: "PAYMENTS_PASSWORD" },
  },
  {
    schema: "expiration",
    password: { name: expirationSecret.metadata.name, key: "EXPIRATION_PASSWORD" },
  },
];

const postgresRoles = new PostgresRoles(
  "postgres-roles",
  {
    namespace: namespace.metadata.name,
    postgresHost: infra.postgres.metadata.name,
    postgresPort: POSTGRES_PORT,
    database: POSTGRES_DATABASE,
    adminUser: "postgres",
    adminPassword: { name: "postgres-credentials", key: "POSTGRES_PASSWORD" },
    roles,
  },
  { dependsOn: infra },
);

// Create the JetStream streams before any messaging service boots. Consumers
// call `consumer.info()` at startup and crash with StreamNotFoundError if the
// stream is missing, so tickets/orders/payments/expiration all depend on this.
// Subjects mirror infra/docker/nats-init.sh.
const streams = new StreamBootstrap(
  "stream-bootstrap",
  {
    namespace: namespace.metadata.name,
    natsUrl: NATS_URL,
    streams: [
      { name: "TICKETS", subjects: "tickets.>" },
      { name: "ORDERS", subjects: "order.>" },
      { name: "PAYMENTS", subjects: "payment.>" },
    ],
  },
  { dependsOn: infra },
);

const authMigration = new MigrationJob(
  "auth",
  {
    namespace: namespace.metadata.name,
    name: "auth",
    image: authImage,
    imagePullPolicy,
    databaseUrlSecret: { name: authSecret.metadata.name, key: "DATABASE_URL" },
  },
  { dependsOn: postgresRoles },
);

const authDeployment = new ServiceDeployment(
  "auth",
  {
    namespace: namespace.metadata.name,
    name: "auth",
    image: authImage,
    imagePullPolicy,
    port: AUTH_PORT,
    replicas: 1,
    env: {
      AUTH_HTTP_PORT: String(AUTH_PORT),
      AUTH_BASE_URL,
      LOG_LEVEL: "info",
    },
    secrets: {
      DATABASE_URL: { name: authSecret.metadata.name, key: "DATABASE_URL" },
      BETTER_AUTH_SECRET: { name: authSecret.metadata.name, key: "BETTER_AUTH_SECRET" },
    },
  },
  { dependsOn: authMigration },
);

const ticketsMigration = new MigrationJob(
  "tickets",
  {
    namespace: namespace.metadata.name,
    name: "tickets",
    image: ticketsImage,
    imagePullPolicy,
    databaseUrlSecret: { name: ticketsSecret.metadata.name, key: "DATABASE_URL" },
  },
  { dependsOn: postgresRoles },
);

const ticketsDeployment = new ServiceDeployment(
  "tickets",
  {
    namespace: namespace.metadata.name,
    name: "tickets",
    image: ticketsImage,
    imagePullPolicy,
    port: TICKETS_PORT,
    replicas: 1,
    env: {
      TICKETS_HTTP_PORT: String(TICKETS_PORT),
      AUTH_BASE_URL,
      NATS_URL,
      LOG_LEVEL: "info",
    },
    secrets: {
      DATABASE_URL: { name: ticketsSecret.metadata.name, key: "DATABASE_URL" },
      TICKETS_SERVICE_TOKEN: {
        name: ticketsSecret.metadata.name,
        key: "TICKETS_SERVICE_TOKEN",
      },
    },
  },
  { dependsOn: [ticketsMigration, streams] },
);

const ordersMigration = new MigrationJob(
  "orders",
  {
    namespace: namespace.metadata.name,
    name: "orders",
    image: ordersImage,
    imagePullPolicy,
    databaseUrlSecret: { name: ordersSecret.metadata.name, key: "DATABASE_URL" },
  },
  { dependsOn: postgresRoles },
);

const ordersDeployment = new ServiceDeployment(
  "orders",
  {
    namespace: namespace.metadata.name,
    name: "orders",
    image: ordersImage,
    imagePullPolicy,
    port: ORDERS_PORT,
    replicas: 1,
    env: {
      ORDERS_HTTP_PORT: String(ORDERS_PORT),
      AUTH_BASE_URL,
      TICKETS_BASE_URL,
      NATS_URL,
      LOG_LEVEL: "info",
    },
    secrets: {
      DATABASE_URL: { name: ordersSecret.metadata.name, key: "DATABASE_URL" },
      TICKETS_SERVICE_TOKEN: {
        name: ticketsSecret.metadata.name,
        key: "TICKETS_SERVICE_TOKEN",
      },
    },
  },
  { dependsOn: [ordersMigration, streams] },
);

const paymentsMigration = new MigrationJob(
  "payments",
  {
    namespace: namespace.metadata.name,
    name: "payments",
    image: paymentsImage,
    imagePullPolicy,
    databaseUrlSecret: { name: paymentsSecret.metadata.name, key: "DATABASE_URL" },
  },
  { dependsOn: postgresRoles },
);

const paymentsDeployment = new ServiceDeployment(
  "payments",
  {
    namespace: namespace.metadata.name,
    name: "payments",
    image: paymentsImage,
    imagePullPolicy,
    port: PAYMENTS_PORT,
    replicas: 1,
    env: {
      PAYMENTS_HTTP_PORT: String(PAYMENTS_PORT),
      AUTH_BASE_URL,
      NATS_URL,
      LOG_LEVEL: "info",
    },
    secrets: {
      DATABASE_URL: { name: paymentsSecret.metadata.name, key: "DATABASE_URL" },
      STRIPE_KEY: { name: paymentsSecret.metadata.name, key: "STRIPE_KEY" },
    },
  },
  { dependsOn: [paymentsMigration, streams] },
);

const expirationMigration = new MigrationJob(
  "expiration",
  {
    namespace: namespace.metadata.name,
    name: "expiration",
    image: expirationImage,
    imagePullPolicy,
    databaseUrlSecret: { name: expirationSecret.metadata.name, key: "DATABASE_URL" },
  },
  { dependsOn: postgresRoles },
);

// Expiration is a BullMQ worker with no HTTP server, so `port` is omitted —
// no Service, no probes, Ready as soon as the container starts.
const expiration = new ServiceDeployment(
  "expiration",
  {
    namespace: namespace.metadata.name,
    name: "expiration",
    image: expirationImage,
    imagePullPolicy,
    replicas: 1,
    env: {
      NATS_URL,
      REDIS_URL,
      LOG_LEVEL: "info",
    },
    secrets: {
      DATABASE_URL: { name: expirationSecret.metadata.name, key: "DATABASE_URL" },
    },
  },
  { dependsOn: [expirationMigration, streams] },
);

// Gateway reads `BETTER_AUTH_SECRET` from `auth-credentials` (single source of
// truth shared with the auth Deployment). The gateway HTTP handler doesn't
// consume it today — sessions are resolved by HTTP-calling auth — but it is
// declared so a future local-verification path doesn't require a fresh secret
// roll-out.
const gatewayDeployment = new ServiceDeployment("gateway", {
  namespace: namespace.metadata.name,
  name: "gateway",
  image: gatewayImage,
  imagePullPolicy,
  port: GATEWAY_PORT,
  replicas: 1,
  env: {
    GATEWAY_HTTP_PORT: String(GATEWAY_PORT),
    WEB_ORIGIN: webOrigin,
    AUTH_BASE_URL,
    TICKETS_BASE_URL,
    ORDERS_BASE_URL,
    PAYMENTS_BASE_URL,
    LOG_LEVEL: "info",
  },
  secrets: {
    BETTER_AUTH_SECRET: { name: authSecret.metadata.name, key: "BETTER_AUTH_SECRET" },
  },
});

// Web is the Vite SPA served by nginx out of `apps/web/dist`. No env, no
// secrets, no migration — the image is a static-asset bundle. Probe `/` so
// the probe at least fails when `index.html` is missing from the image;
// there is no real `/health` route behind the SPA fallback.
const webDeployment = new ServiceDeployment("web", {
  namespace: namespace.metadata.name,
  name: "web",
  image: webImage,
  imagePullPolicy,
  port: WEB_PORT,
  replicas: 1,
  healthPath: "/",
});

// Single Ingress fronting the cluster: gateway owns `/health`, `/api/*`, and
// `/rpc/*`; web (the SPA) catches everything else. Host comes from stack config
// so the same component targets `localhost` in dev and a real DNS name later.
const ingress = new IngressRoutes("tix", {
  namespace: namespace.metadata.name,
  host: ingressHost,
  gateway: { name: gatewayDeployment.service!.metadata.name, port: GATEWAY_PORT },
  web: { name: webDeployment.service!.metadata.name, port: WEB_PORT },
  grafana: { name: observability.grafanaService.metadata.name, port: GRAFANA_PORT },
});

export const namespaceName = namespace.metadata.name;
export const postgresService = infra.postgres.metadata.name;
export const natsService = infra.nats.metadata.name;
export const redisService = infra.redis.metadata.name;
// Every HTTP-shaped deployment below is constructed with an explicit `port`,
// so `ServiceDeployment.service` is guaranteed populated and the non-null
// assertion is safe. The headless `expiration` worker has no Service, so it
// exports its Deployment name instead.
export const authService = authDeployment.service!.metadata.name;
export const ticketsService = ticketsDeployment.service!.metadata.name;
export const ordersService = ordersDeployment.service!.metadata.name;
export const paymentsService = paymentsDeployment.service!.metadata.name;
export const gatewayService = gatewayDeployment.service!.metadata.name;
export const webService = webDeployment.service!.metadata.name;
export const expirationDeployment = expiration.deployment.metadata.name;
export const otelCollectorService = observability.collectorService.metadata.name;
export const grafanaService = observability.grafanaService.metadata.name;
export const tempoService = observability.tempo.service.metadata.name;
export const lokiService = observability.loki.service.metadata.name;
export const prometheusService = observability.prometheus.service.metadata.name;
export const garageService = observability.garage.service.metadata.name;
export const ingressName = ingress.ingress.metadata.name;
export const ingressHostName = ingressHost;

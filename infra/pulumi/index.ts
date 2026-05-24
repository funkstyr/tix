import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import { MigrationJob } from "./components/migration-job.ts";
import { PostgresRoles } from "./components/postgres-roles.ts";
import { ServiceDeployment } from "./components/service-deployment.ts";
import { StatefulInfra } from "./components/stateful-infra.ts";

const POSTGRES_PORT = 5432;
const POSTGRES_DATABASE = "tix";
const AUTH_PORT = 4001;

export const stack = pulumi.getStack();

const config = new pulumi.Config();
const desiredNamespace = config.get("namespace") ?? "tix";
const postgresPassword = config.requireSecret("postgresPassword");
const authPassword = config.requireSecret("authPassword");
const betterAuthSecret = config.requireSecret("betterAuthSecret");
const authImage = config.get("authImage") ?? "tix-auth:dev";
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

const authSecret = new k8s.core.v1.Secret("auth-credentials", {
  metadata: { name: "auth-credentials", namespace: namespace.metadata.name },
  stringData: {
    AUTH_PASSWORD: authPassword,
    BETTER_AUTH_SECRET: betterAuthSecret,
    DATABASE_URL: pulumi.interpolate`postgres://auth_user:${authPassword}@postgres:${POSTGRES_PORT}/${POSTGRES_DATABASE}`,
  },
});

const postgresRoles = new PostgresRoles(
  "postgres-roles",
  {
    namespace: namespace.metadata.name,
    postgresHost: infra.postgres.metadata.name,
    postgresPort: POSTGRES_PORT,
    database: POSTGRES_DATABASE,
    adminUser: "postgres",
    adminPassword: { name: "postgres-credentials", key: "POSTGRES_PASSWORD" },
    roles: [{ schema: "auth", password: { name: authSecret.metadata.name, key: "AUTH_PASSWORD" } }],
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
      AUTH_BASE_URL: `http://auth:${AUTH_PORT}`,
      LOG_LEVEL: "info",
    },
    secrets: {
      DATABASE_URL: { name: authSecret.metadata.name, key: "DATABASE_URL" },
      BETTER_AUTH_SECRET: { name: authSecret.metadata.name, key: "BETTER_AUTH_SECRET" },
    },
  },
  { dependsOn: authMigration },
);

export const namespaceName = namespace.metadata.name;
export const postgresService = infra.postgres.metadata.name;
export const natsService = infra.nats.metadata.name;
export const redisService = infra.redis.metadata.name;
export const authService = authDeployment.service.metadata.name;

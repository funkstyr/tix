import { createRouterClient } from "@orpc/server";
import { createAuth } from "auth/instance";
import { createAuthRouter } from "auth/router";
import { authTables } from "auth/schema";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

import type { AuthRouterClient } from "@tix/contracts/auth";
import { createInProcessAuthSessionClient } from "@tix/contracts/auth-client";
import { createDbClient, type DbClient } from "@tix/db-core/client";

import { orderReadModel, paymentsTables } from "./domain/schema.ts";

const TEST_SECRET = "test-secret-do-not-use-in-prod-test-secret-do-not-use-in-prod";
const TEST_BASE_URL = "http://localhost:4004";

const authMigrationsFolder = fileURLToPath(new URL("../../auth/drizzle", import.meta.url));
const paymentsMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export type PaymentsDbClient = DbClient<typeof paymentsTables>;
export type AuthDbClient = DbClient<typeof authTables>;
export type AuthSessionClient = ReturnType<typeof createInProcessAuthSessionClient>;

export type PaymentsTestStack = {
  pgContainer: StartedTestContainer;
  pgUrl: string;
  paymentsDb: PaymentsDbClient;
  authDb: AuthDbClient;
  authClient: AuthRouterClient;
  authSessionClient: AuthSessionClient;
};

export async function startPaymentsTestStack(dbName: string): Promise<PaymentsTestStack> {
  const pgContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: dbName,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  const pgUrl = `postgres://postgres:postgres@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/${dbName}`;

  const authDb = createDbClient("auth", pgUrl, { schema: authTables });
  await migrate(authDb.db, { migrationsFolder: authMigrationsFolder });

  const paymentsDb = createDbClient("payments", pgUrl, { schema: paymentsTables });
  await migrate(paymentsDb.db, { migrationsFolder: paymentsMigrationsFolder });

  const auth = createAuth({ db: authDb.db, secret: TEST_SECRET, baseURL: TEST_BASE_URL });
  const authRouter = createAuthRouter({ auth });
  const authClient = createRouterClient(authRouter);
  const authSessionClient = createInProcessAuthSessionClient(authClient);

  return { pgContainer, pgUrl, paymentsDb, authDb, authClient, authSessionClient };
}

export async function stopPaymentsTestStack(stack: PaymentsTestStack): Promise<void> {
  await stack.paymentsDb.close();
  await stack.authDb.close();
  await stack.pgContainer.stop();
}

export async function truncatePaymentsTestStack(stack: PaymentsTestStack): Promise<void> {
  await stack.paymentsDb
    .sql`TRUNCATE TABLE payments.payments, payments.order_read_model, payments.outbox, payments.inbox RESTART IDENTITY CASCADE`;
  await stack.authDb
    .sql`TRUNCATE TABLE auth.session, auth.account, auth.user RESTART IDENTITY CASCADE`;
}

export async function signUpBuyer(
  authClient: AuthRouterClient,
): Promise<{ userId: string; token: string }> {
  const result = await authClient.signUp({
    email: `buyer-${randomUUID()}@example.com`,
    password: "correct-horse-battery",
    name: "buyer",
  });

  return { userId: result.userId, token: result.token };
}

export async function seedOrder(
  db: PaymentsDbClient,
  buyerId: string,
  priceCents: number,
): Promise<string> {
  const orderId = randomUUID();
  await db.db
    .insert(orderReadModel)
    .values({ id: orderId, version: 1, userId: buyerId, priceCents, status: "created" });

  return orderId;
}

import { createRouterClient } from "@orpc/server";
import { createAuth } from "auth/instance";
import { createAuthRouter } from "auth/router";
import { authTables } from "auth/schema";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuthRouterClient } from "@tix/contracts/auth";
import {
  type AuthSessionClient,
  createInProcessAuthSessionClient,
} from "@tix/contracts/auth-client";
import { createDbClient, type DbClient } from "@tix/db-core/client";

import { createSessionResolver } from "./session-resolver.ts";

const TEST_SECRET = "test-secret-do-not-use-in-prod-test-secret-do-not-use-in-prod";
const TEST_BASE_URL = "http://localhost:4000";
const COOKIE_NAME = "tix.session";

const authMigrations = fileURLToPath(new URL("../../auth/drizzle", import.meta.url));

const dockerAvailable = ((): boolean => {
  if (process.env["DOCKER_HOST"]) return true;

  const home = process.env["HOME"] ?? "";
  const candidates = [
    "/var/run/docker.sock",
    `${home}/.docker/run/docker.sock`,
    `${home}/.colima/default/docker.sock`,
    `${home}/.orbstack/run/docker.sock`,
  ];

  return candidates.some((p) => existsSync(p));
})();

type AuthDbClient = DbClient<typeof authTables>;

let container: StartedTestContainer | undefined;
let authDb: AuthDbClient | undefined;
let authClient: AuthRouterClient | undefined;
let authSessionClient: AuthSessionClient | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "gateway_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = `postgres://postgres:postgres@${host}:${port}/gateway_test`;

  authDb = createDbClient("auth", url, { schema: authTables });
  await migrate(authDb.db, { migrationsFolder: authMigrations });

  const auth = createAuth({ db: authDb.db, secret: TEST_SECRET, baseURL: TEST_BASE_URL });
  const authRouter = createAuthRouter({ auth });
  authClient = createRouterClient(authRouter);
  authSessionClient = createInProcessAuthSessionClient(authClient);
}, 120_000);

afterAll(async () => {
  await authDb?.close();
  await container?.stop();
});

beforeEach(async () => {
  if (!authDb) return;

  await authDb.sql`TRUNCATE TABLE auth.session, auth.account, auth.user RESTART IDENTITY CASCADE`;
});

function getAuthClient(): AuthRouterClient {
  if (!authClient) throw new Error("authClient not initialized");

  return authClient;
}

function getAuthSessionClient(): AuthSessionClient {
  if (!authSessionClient) throw new Error("authSessionClient not initialized");

  return authSessionClient;
}

async function signUpBuyer(email: string): Promise<{ userId: string; token: string }> {
  const result = await getAuthClient().signUp({
    email,
    password: "correct-horse-battery",
    name: email.split("@")[0] ?? "buyer",
  });

  return { userId: result.userId, token: result.token };
}

function reqWith(cookie: string): Request {
  return new Request("http://gateway.test/anything", { headers: { cookie } });
}

describe.skipIf(!dockerAvailable)("session-resolver against a real auth service", () => {
  it("resolves the CurrentUser when the cookie carries a freshly-issued session token", async () => {
    const resolveSession = createSessionResolver({
      authClient: getAuthSessionClient(),
      sessionCookieName: COOKIE_NAME,
    });
    const { userId, token } = await signUpBuyer("buyer@example.com");

    const user = await resolveSession(reqWith(`${COOKIE_NAME}=${token}`));

    expect(user).toEqual({ id: userId, email: "buyer@example.com", name: "buyer" });
  });

  it("returns null when the cookie carries a token the auth service does not recognize", async () => {
    const resolveSession = createSessionResolver({
      authClient: getAuthSessionClient(),
      sessionCookieName: COOKIE_NAME,
    });

    const user = await resolveSession(reqWith(`${COOKIE_NAME}=definitely-not-a-real-token`));

    expect(user).toBeNull();
  });

  it("returns null when the request has no cookie header", async () => {
    const resolveSession = createSessionResolver({
      authClient: getAuthSessionClient(),
      sessionCookieName: COOKIE_NAME,
    });

    const user = await resolveSession(new Request("http://gateway.test/anything"));

    expect(user).toBeNull();
  });
});

import { createRouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDbClient, type DbClient } from "@tix/db-core/client";

import { createAuth } from "./auth-instance.ts";
import { authTables, user as userTable } from "./auth-schema.ts";
import { createAuthTestRuntime } from "./auth-test-runtime.ts";
import { createAuthRouter } from "./router.ts";

const TEST_SECRET = "test-secret-do-not-use-in-prod-test-secret-do-not-use-in-prod";
const TEST_BASE_URL = "http://localhost:4001";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

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
type AuthRouterClient = ReturnType<typeof buildRouterClient>;

function buildRouterClient(dbClient: AuthDbClient) {
  const auth = createAuth({ db: dbClient.db, secret: TEST_SECRET, baseURL: TEST_BASE_URL });
  const router = createAuthRouter(createAuthTestRuntime({ auth }));

  return createRouterClient(router);
}

let container: StartedTestContainer | undefined;
let dbClient: AuthDbClient | undefined;
let client: AuthRouterClient | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "auth_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = `postgres://postgres:postgres@${host}:${port}/auth_test`;

  dbClient = createDbClient("auth", url, { schema: authTables });
  await migrate(dbClient.db, { migrationsFolder });

  client = buildRouterClient(dbClient);
}, 120_000);

afterAll(async () => {
  await dbClient?.close();
  await container?.stop();
});

beforeEach(async () => {
  if (!dbClient) return;

  await dbClient.sql`TRUNCATE TABLE auth.session, auth.account, auth.user RESTART IDENTITY CASCADE`;
});

function getClient(): AuthRouterClient {
  if (!client) throw new Error("client not initialized");

  return client;
}

function getDb(): AuthDbClient {
  if (!dbClient) throw new Error("dbClient not initialized");

  return dbClient;
}

describe.skipIf(!dockerAvailable)("auth router", () => {
  it("sign-up inserts a row in auth.user and returns a session token", async () => {
    const result = await getClient().signUp({
      email: "alice@example.com",
      password: "correct-horse-battery",
      name: "Alice",
    });

    expect(result.email).toBe("alice@example.com");
    expect(result.userId).toMatch(/.+/);
    expect(result.token).toMatch(/.+/);

    const rows = await getDb().db.select().from(userTable).where(eq(userTable.id, result.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe("alice@example.com");
    expect(rows[0]?.name).toBe("Alice");
  });

  it("sign-in with correct password returns a session token, and getSession resolves the user", async () => {
    await getClient().signUp({
      email: "bob@example.com",
      password: "correct-horse-battery",
      name: "Bob",
    });

    const signedIn = await getClient().signIn({
      email: "bob@example.com",
      password: "correct-horse-battery",
    });

    expect(signedIn.token).toMatch(/.+/);

    const session = await getClient().getSession({ token: signedIn.token });
    expect(session).not.toBeNull();
    expect(session?.user.email).toBe("bob@example.com");
    expect(session?.user.name).toBe("Bob");
    expect(session?.session.id).toMatch(/.+/);
  });

  it("sign-in with wrong password fails without leaking which check failed", async () => {
    await getClient().signUp({
      email: "carol@example.com",
      password: "correct-horse-battery",
      name: "Carol",
    });

    await expect(
      getClient().signIn({ email: "carol@example.com", password: "wrong-password" }),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Invalid email or password",
    });

    await expect(
      getClient().signIn({ email: "nobody@example.com", password: "wrong-password" }),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Invalid email or password",
    });
  });

  it("sign-out invalidates the session: getSession returns null afterwards", async () => {
    const signedUp = await getClient().signUp({
      email: "dave@example.com",
      password: "correct-horse-battery",
      name: "Dave",
    });

    const before = await getClient().getSession({ token: signedUp.token });
    expect(before).not.toBeNull();

    await getClient().signOut({ token: signedUp.token });

    const after = await getClient().getSession({ token: signedUp.token });
    expect(after).toBeNull();
  });
});

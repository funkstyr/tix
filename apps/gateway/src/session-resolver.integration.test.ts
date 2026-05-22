import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type AuthFixture, createAuthFixture } from "@tix/auth-test-fixture/fixture";
import { dockerAvailable } from "@tix/test-helpers/docker-available";

import { createSessionResolver } from "./session-resolver.ts";

const COOKIE_NAME = "tix.session";
const TEST_BASE_URL = "http://localhost:4000";

let container: StartedTestContainer | undefined;
let fixture: AuthFixture | undefined;

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
  const databaseUrl = `postgres://postgres:postgres@${host}:${port}/gateway_test`;

  fixture = await createAuthFixture({ databaseUrl, baseUrl: TEST_BASE_URL });
}, 120_000);

afterAll(async () => {
  await fixture?.close();
  await container?.stop();
});

beforeEach(async () => {
  await fixture?.truncate();
});

function getFixture(): AuthFixture {
  if (!fixture) throw new Error("auth fixture not initialized");

  return fixture;
}

async function signUpBuyer(email: string): Promise<{ userId: string; token: string }> {
  const [name = "buyer"] = email.split("@");
  const result = await getFixture().authClient.signUp({
    email,
    password: "correct-horse-battery",
    name,
  });

  return { userId: result.userId, token: result.token };
}

function reqWith(cookie: string): Request {
  return new Request("http://gateway.test/anything", { headers: { cookie } });
}

describe.skipIf(!dockerAvailable)("session-resolver against a real auth service", () => {
  it("resolves the CurrentUser when the cookie carries a freshly-issued session token", async () => {
    const resolveSession = createSessionResolver({
      authClient: getFixture().authSessionClient,
      sessionCookieName: COOKIE_NAME,
    });
    const { userId, token } = await signUpBuyer("buyer@example.com");

    const user = await resolveSession(reqWith(`${COOKIE_NAME}=${token}`));

    expect(user).toEqual({ id: userId, email: "buyer@example.com", name: "buyer" });
  });

  it("returns null when the cookie carries a token the auth service does not recognize", async () => {
    const resolveSession = createSessionResolver({
      authClient: getFixture().authSessionClient,
      sessionCookieName: COOKIE_NAME,
    });

    const user = await resolveSession(reqWith(`${COOKIE_NAME}=definitely-not-a-real-token`));

    expect(user).toBeNull();
  });

  it("returns null when the request has no cookie header", async () => {
    const resolveSession = createSessionResolver({
      authClient: getFixture().authSessionClient,
      sessionCookieName: COOKIE_NAME,
    });

    const user = await resolveSession(new Request("http://gateway.test/anything"));

    expect(user).toBeNull();
  });
});

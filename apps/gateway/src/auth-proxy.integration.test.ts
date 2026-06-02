import { createAuthApp } from "auth/app";
import { user as userTable } from "auth/schema";
import { createAuthTestRuntime } from "auth/test-runtime";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type AuthFixture, createAuthFixture } from "@tix/auth-test-fixture/fixture";
import { dockerAvailable } from "@tix/test-helpers/docker-available";

import { createDownstreamClients } from "./downstream-clients.ts";
import { createGatewayApp } from "./gateway-app.ts";
import { createGatewayTestRuntime } from "./gateway-test-runtime.ts";

const WEB_ORIGIN = "https://app.tix.test";
const AUTH_BASE_URL = "http://auth.internal";

let container: StartedTestContainer | undefined;
let fixture: AuthFixture | undefined;
let authApp: Hono | undefined;

beforeAll(async () => {
  if (!dockerAvailable) return;

  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "gateway_auth_proxy_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const databaseUrl = `postgres://postgres:postgres@${host}:${port}/gateway_auth_proxy_test`;

  fixture = await createAuthFixture({ databaseUrl, baseUrl: AUTH_BASE_URL });
  authApp = createAuthApp({ runtime: createAuthTestRuntime({ auth: fixture.auth }) });
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

function getAuthApp(): Hono {
  if (!authApp) throw new Error("auth-app not initialized");

  return authApp;
}

function buildGatewayApp(): Hono {
  const upstream = getAuthApp();
  const authFetch: typeof globalThis.fetch = async (input, init) =>
    upstream.fetch(new Request(input as Request | URL | string, init));

  const clients = createDownstreamClients(
    {
      ticketsBaseUrl: "http://tickets.test",
      ordersBaseUrl: "http://orders.test",
      paymentsBaseUrl: "http://payments.test",
      authBaseUrl: AUTH_BASE_URL,
    },
    { fetch: async () => new Response(null, { status: 500 }) },
  );
  const runtime = createGatewayTestRuntime({ clients });

  return createGatewayApp({
    runtime,
    webOrigin: WEB_ORIGIN,
    authBaseUrl: AUTH_BASE_URL,
    faroCollectorUrl: "http://otel-collector:8090/",
    fetch: authFetch,
  });
}

describe.skipIf(!dockerAvailable)("auth-proxy against a real auth service", () => {
  it("POST /api/auth/sign-up/email through the gateway creates a user and returns a Set-Cookie", async () => {
    const gateway = buildGatewayApp();

    const res = await gateway.fetch(
      new Request("http://gateway.test/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "alice@example.com",
          password: "correct-horse-battery",
          name: "Alice",
        }),
      }),
    );

    expect(res.status).toBe(200);

    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.includes("session"))).toBe(true);

    const rows = await getFixture()
      .db.db.select()
      .from(userTable)
      .where(eq(userTable.email, "alice@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Alice");
  });

  it("POST /api/auth/sign-in/email through the gateway returns a fresh session Set-Cookie", async () => {
    const gateway = buildGatewayApp();

    const signUp = await gateway.fetch(
      new Request("http://gateway.test/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "bob@example.com",
          password: "correct-horse-battery",
          name: "Bob",
        }),
      }),
    );
    expect(signUp.status).toBe(200);

    const signIn = await gateway.fetch(
      new Request("http://gateway.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "bob@example.com",
          password: "correct-horse-battery",
        }),
      }),
    );

    expect(signIn.status).toBe(200);
    const setCookies = signIn.headers.getSetCookie();
    expect(setCookies.some((c) => c.includes("session"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { ORDERS_STREAM, PAYMENTS_STREAM } from "@tix/contracts/subjects";

import { parseEnv } from "./config.ts";

const REQUIRED = {
  DATABASE_URL: "postgres://payments:pw@postgres:5432/tix",
  AUTH_BASE_URL: "http://auth:4001",
  NATS_URL: "nats://nats:4222",
  STRIPE_KEY: "sk_test_dummy",
};

function withEnv<T>(extra: Record<string, string>, fn: () => T): T {
  const saved = process.env;
  process.env = { ...saved, ...REQUIRED, ...extra };
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

describe("payments parseEnv", () => {
  // Regression guard: `order.*` events live in the ORDERS stream, so the order-projection
  // consumers must read from it — binding them to payments' own PAYMENTS stream matches nothing
  // and every charge fails "order not found".
  it("reads orders from the ORDERS stream, distinct from its own PAYMENTS stream", () => {
    const env = withEnv({}, parseEnv);

    expect(env.ordersStream).toBe(ORDERS_STREAM);
    expect(env.stream).toBe(PAYMENTS_STREAM);
    expect(env.ordersStream).not.toBe(env.stream);
  });

  it("allows overriding the ORDERS stream via env", () => {
    const env = withEnv({ ORDERS_STREAM: "CUSTOM_ORDERS" }, parseEnv);

    expect(env.ordersStream).toBe("CUSTOM_ORDERS");
  });
});

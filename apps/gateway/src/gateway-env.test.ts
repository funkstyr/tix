import { describe, expect, it } from "vitest";

import { parseEnv } from "./gateway-env.ts";

const baseEnv = {
  WEB_ORIGIN: "https://app.tix.test",
  AUTH_BASE_URL: "http://auth.internal",
  TICKETS_BASE_URL: "http://tickets.internal",
  ORDERS_BASE_URL: "http://orders.internal",
  PAYMENTS_BASE_URL: "http://payments.internal",
};

describe("parseEnv", () => {
  it("throws when WEB_ORIGIN is missing", () => {
    const { WEB_ORIGIN: _omit, ...env } = baseEnv;

    expect(() => parseEnv(env)).toThrow(/WEB_ORIGIN/);
  });

  it("throws when GATEWAY_HTTP_PORT is out of range", () => {
    expect(() => parseEnv({ ...baseEnv, GATEWAY_HTTP_PORT: "99999" })).toThrow(/GATEWAY_HTTP_PORT/);
  });
});

import { describe, expect, it } from "vitest";

import { parseEnv } from "./env";

const baseEnv = {
  VITE_GATEWAY_URL: "http://localhost:4000",
  VITE_STRIPE_PK: "pk_test_abc123",
};

const base = { VITE_GATEWAY_URL: "http://localhost:4000", VITE_STRIPE_PK: "pk_test_x" };

describe("parseEnv", () => {
  it("returns the parsed env for valid input", () => {
    expect(parseEnv(baseEnv)).toEqual(baseEnv);
  });

  it("throws when VITE_GATEWAY_URL is missing", () => {
    const { VITE_GATEWAY_URL: _omit, ...env } = baseEnv;

    expect(() => parseEnv(env)).toThrow(/VITE_GATEWAY_URL/);
  });

  it("throws when VITE_GATEWAY_URL is not a URL", () => {
    expect(() => parseEnv({ ...baseEnv, VITE_GATEWAY_URL: "not-a-url" })).toThrow(
      /VITE_GATEWAY_URL/,
    );
  });

  it("throws when VITE_STRIPE_PK is missing", () => {
    const { VITE_STRIPE_PK: _omit, ...env } = baseEnv;

    expect(() => parseEnv(env)).toThrow(/VITE_STRIPE_PK/);
  });
});

describe("parseEnv RUM keys", () => {
  it("parses without any RUM env (RUM stays off)", () => {
    expect(parseEnv(base).VITE_RUM_URL).toBeUndefined();
  });

  it("accepts the RUM url + app name + sample rate", () => {
    const env = parseEnv({
      ...base,
      VITE_RUM_URL: "http://localhost:4000/otel/v1/faro",
      VITE_RUM_APP_NAME: "tix-web",
      VITE_RUM_SAMPLE_RATE: "0.5",
    });
    expect(env.VITE_RUM_URL).toBe("http://localhost:4000/otel/v1/faro");
    expect(env.VITE_RUM_APP_NAME).toBe("tix-web");
    expect(env.VITE_RUM_SAMPLE_RATE).toBe("0.5");
  });
});

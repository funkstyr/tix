import { describe, expect, it } from "vitest";

import { parseEnv } from "./env";

const baseEnv = {
  VITE_GATEWAY_URL: "http://localhost:4000",
  VITE_STRIPE_PK: "pk_test_abc123",
};

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

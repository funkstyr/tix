import { describe, expect, it } from "vitest";

import { parseEnv } from "./auth-env.ts";

const baseEnv = {
  DATABASE_URL: "postgres://auth.internal/auth",
  BETTER_AUTH_SECRET: "secret_min_32_characters_for_testing",
};

describe("parseEnv", () => {
  it("throws when BETTER_AUTH_SECRET is missing", () => {
    const { BETTER_AUTH_SECRET: _omit, ...env } = baseEnv;

    expect(() => parseEnv(env)).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("throws when AUTH_HTTP_PORT is out of range", () => {
    expect(() => parseEnv({ ...baseEnv, AUTH_HTTP_PORT: "99999" })).toThrow(/AUTH_HTTP_PORT/);
  });

  it("defaults baseURL to localhost on the resolved port", () => {
    const env = parseEnv({ ...baseEnv, AUTH_HTTP_PORT: "4001" });

    expect(env.baseURL).toBe("http://localhost:4001");
  });
});

describe("parseEnv trustedOrigins", () => {
  it("omits trustedOrigins when WEB_ORIGIN is unset", () => {
    expect(parseEnv(baseEnv).trustedOrigins).toBeUndefined();
  });

  it("wraps WEB_ORIGIN as the sole trusted origin", () => {
    const env = parseEnv({ ...baseEnv, WEB_ORIGIN: "http://localhost:5173" });

    expect(env.trustedOrigins).toEqual(["http://localhost:5173"]);
  });
});

import { type } from "arktype";
import { describe, expect, it } from "vitest";

import { parseEnvSchema, requirePort, requirePositiveInt } from "./env.ts";

const schema = type({ FOO: "string > 0", "BAR?": "string.numeric.parse" });

describe("parseEnvSchema", () => {
  it("returns the parsed env on success", () => {
    expect(parseEnvSchema(schema, { FOO: "x" })).toEqual({ FOO: "x" });
  });

  it("parses numeric strings through the schema", () => {
    expect(parseEnvSchema(schema, { FOO: "x", BAR: "42" })).toEqual({ FOO: "x", BAR: 42 });
  });

  it("throws the uniform error on failure", () => {
    expect(() => parseEnvSchema(schema, {})).toThrow(/invalid environment:/);
  });

  it("tolerates undeclared keys (services pass the whole process.env)", () => {
    // Every service calls parseEnvSchema(schema, process.env), which carries dozens
    // of unrelated vars (PATH, HOME, …). The schema must extract its declared fields
    // without rejecting on the extras.
    const parsed = parseEnvSchema(schema, { FOO: "x", PATH: "/usr/bin", HOME: "/root" });
    expect(parsed.FOO).toBe("x");
  });
});

describe("requirePort", () => {
  it("falls back when unset", () => {
    expect(requirePort(undefined, 4002, "TICKETS_HTTP_PORT")).toBe(4002);
  });

  it("accepts a valid explicit port", () => {
    expect(requirePort(8080, 4002, "TICKETS_HTTP_PORT")).toBe(8080);
  });

  it("accepts the maximum valid port (inclusive upper bound)", () => {
    expect(requirePort(65535, 4002, "TICKETS_HTTP_PORT")).toBe(65535);
  });

  it("rejects the port one past the maximum", () => {
    expect(() => requirePort(65536, 4002, "TICKETS_HTTP_PORT")).toThrow(
      "invalid TICKETS_HTTP_PORT: 65536",
    );
  });

  it("rejects out-of-range ports with the field name", () => {
    expect(() => requirePort(70000, 4002, "TICKETS_HTTP_PORT")).toThrow(
      "invalid TICKETS_HTTP_PORT: 70000",
    );
  });

  it("rejects non-integer ports", () => {
    expect(() => requirePort(80.5, 4002, "TICKETS_HTTP_PORT")).toThrow(
      "invalid TICKETS_HTTP_PORT: 80.5",
    );
  });
});

describe("requirePositiveInt", () => {
  it("accepts a valid explicit value", () => {
    expect(requirePositiveInt(1000, 5, "RESERVATION_TTL_MS")).toBe(1000);
  });

  it("falls back when unset", () => {
    expect(requirePositiveInt(undefined, 5, "RESERVATION_TTL_MS")).toBe(5);
  });

  it("rejects zero", () => {
    expect(() => requirePositiveInt(0, 5, "RESERVATION_TTL_MS")).toThrow(
      "invalid RESERVATION_TTL_MS: 0",
    );
  });

  it("rejects negatives", () => {
    expect(() => requirePositiveInt(-1, 5, "RESERVATION_TTL_MS")).toThrow(
      "invalid RESERVATION_TTL_MS: -1",
    );
  });
});

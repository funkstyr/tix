import { ConfigProvider, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { otelConfig } from "./otel-config.js";

const withEnv = (entries: ReadonlyArray<readonly [string, string]>) =>
  Effect.withConfigProvider(ConfigProvider.fromMap(new Map(entries)));

describe("otelConfig", () => {
  it("defaults baseUrl to the in-cluster collector when the endpoint env is unset", async () => {
    const config = await Effect.runPromise(
      otelConfig.pipe(withEnv([["OTEL_SERVICE_NAME", "orders"]])),
    );

    expect(config.baseUrl).toBe("http://otel-collector:4318");
    expect(config.serviceName).toBe("orders");
  });

  it("reads the endpoint override when present", async () => {
    const config = await Effect.runPromise(
      otelConfig.pipe(
        withEnv([
          ["OTEL_SERVICE_NAME", "orders"],
          ["OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318"],
        ]),
      ),
    );

    expect(config.baseUrl).toBe("http://localhost:4318");
  });

  it("fails with a ConfigError when OTEL_SERVICE_NAME is unset", async () => {
    const exit = await Effect.runPromiseExit(otelConfig.pipe(withEnv([])));

    expect(Exit.isFailure(exit)).toBe(true);
  });
});

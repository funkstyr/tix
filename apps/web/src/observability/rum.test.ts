import { describe, expect, it } from "vitest";

import { rumConfigFromEnv } from "./rum";

const gateway = "http://localhost:4000";

describe("rumConfigFromEnv", () => {
  it("returns null when VITE_RUM_URL is unset (RUM disabled)", () => {
    expect(rumConfigFromEnv({ VITE_GATEWAY_URL: gateway, VITE_STRIPE_PK: "x" })).toBeNull();
  });

  it("builds a config with the gateway origin as the only traceparent target", () => {
    const cfg = rumConfigFromEnv({
      VITE_GATEWAY_URL: gateway,
      VITE_STRIPE_PK: "x",
      VITE_RUM_URL: "http://localhost:4000/otel/v1/faro",
      VITE_RUM_APP_NAME: "tix-web",
      VITE_RUM_SAMPLE_RATE: "0.5",
    });
    expect(cfg).not.toBeNull();
    expect(cfg?.url).toBe("http://localhost:4000/otel/v1/faro");
    expect(cfg?.appName).toBe("tix-web");
    expect(cfg?.sessionSampleRate).toBe(0.5);
    expect(cfg?.propagateTraceHeaderCorsUrls).toEqual([gateway]);
  });

  it("defaults app name and sample rate", () => {
    const cfg = rumConfigFromEnv({
      VITE_GATEWAY_URL: gateway,
      VITE_STRIPE_PK: "x",
      VITE_RUM_URL: "http://localhost:4000/otel/v1/faro",
    });
    expect(cfg?.appName).toBe("tix-web");
    expect(cfg?.sessionSampleRate).toBe(1);
  });
});

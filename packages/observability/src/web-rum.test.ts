import { describe, expect, it } from "vitest";

import { buildFaroConfig } from "./web-rum.ts";

const base = {
  url: "https://app.tix.test/otel/v1/faro",
  appName: "tix-web",
  environment: "dev",
  sessionSampleRate: 1,
  propagateTraceHeaderCorsUrls: [/https:\/\/app\.tix\.test/],
};

describe("buildFaroConfig", () => {
  it("targets the gateway RUM proxy url and names the app", () => {
    const cfg = buildFaroConfig(base);
    expect(cfg.url).toBe("https://app.tix.test/otel/v1/faro");
    expect(cfg.app.name).toBe("tix-web");
    expect(cfg.app.environment).toBe("dev");
  });

  it("carries the session sampling rate", () => {
    expect(
      buildFaroConfig({ ...base, sessionSampleRate: 0.25 }).sessionTracking?.samplingRate,
    ).toBe(0.25);
  });

  it("includes at least one instrumentation (web instrumentations + tracing)", () => {
    expect(buildFaroConfig(base).instrumentations.length).toBeGreaterThan(0);
  });
});

describe("buildFaroConfig cardinality rule (ADR-0013)", () => {
  it("does not bake user identity into the base config", () => {
    // User identity must NOT be set at init (it would ride as a label); it is attached later as
    // session-user metadata (a span/log attribute) via setRumUser. So the init config has no user.
    expect(buildFaroConfig(base).user).toBeUndefined();
  });
});

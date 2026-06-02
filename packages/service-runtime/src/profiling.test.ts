import { describe, expect, it, vi } from "vitest";

import { startProfiling } from "./profiling.ts";

// startProfiling reads PROFILING_ENABLED + PYROSCOPE_SERVER_ADDRESS from a passed-in env and
// only initializes/starts when enabled. The pyroscope module is injected so the unit test
// asserts the init args (appName + tags) without loading native profiling.
describe("startProfiling", () => {
  it("does nothing when PROFILING_ENABLED is unset", () => {
    const pyro = { init: vi.fn(), start: vi.fn() };
    startProfiling({ serviceName: "orders", version: "abc", env: {}, pyroscope: pyro });
    expect(pyro.init).not.toHaveBeenCalled();
    expect(pyro.start).not.toHaveBeenCalled();
  });

  it("initializes with service + version tags and starts when enabled", () => {
    const pyro = { init: vi.fn(), start: vi.fn() };
    startProfiling({
      serviceName: "orders",
      version: "abc123",
      env: { PROFILING_ENABLED: "true", PYROSCOPE_SERVER_ADDRESS: "http://pyroscope:4040" },
      pyroscope: pyro,
    });
    expect(pyro.init).toHaveBeenCalledWith({
      appName: "orders",
      serverAddress: "http://pyroscope:4040",
      tags: { service_name: "orders", service_version: "abc123" },
    });
    expect(pyro.start).toHaveBeenCalledOnce();
  });

  it("does not start when enabled but no server address is configured", () => {
    const pyro = { init: vi.fn(), start: vi.fn() };
    startProfiling({
      serviceName: "orders",
      version: "abc",
      env: { PROFILING_ENABLED: "true" },
      pyroscope: pyro,
    });
    expect(pyro.start).not.toHaveBeenCalled();
  });
});

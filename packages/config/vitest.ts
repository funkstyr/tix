import { defineConfig, type ViteUserConfig } from "vitest/config";

type TestConfig = NonNullable<ViteUserConfig["test"]>;

export function nodePreset(overrides: TestConfig = {}): ViteUserConfig {
  return defineConfig({
    test: {
      environment: "node",
      passWithNoTests: true,
      ...overrides,
    },
  });
}

// Integration suites boot a real dependency (a testcontainers Postgres/Redis, an
// in-process auth issuer, …) and do genuinely slow work per test: password
// hashing, migrations, cross-service round-trips. Vitest's 5s test / 10s hook
// defaults are calibrated for pure-unit tests and are too tight here — the cold
// first test additionally pays connection-pool and V8-JIT warmup, which is what
// tips it over 5s under CI contention. Raise the ceilings (they're maximums, so
// fast tests still finish fast). Suites with their own per-hook timeout arg
// (e.g. a 120s container-start `beforeAll`) keep it — an inline arg wins.
export function integrationPreset(overrides: TestConfig = {}): ViteUserConfig {
  return nodePreset({ testTimeout: 30_000, hookTimeout: 30_000, ...overrides });
}

export function uiPreset(overrides: TestConfig = {}): ViteUserConfig {
  return nodePreset({ environment: "jsdom", ...overrides });
}

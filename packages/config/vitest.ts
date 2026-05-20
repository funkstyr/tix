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

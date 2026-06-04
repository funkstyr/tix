import { defineConfig, mergeConfig, type UserConfig } from "tsdown";

const base: UserConfig = {
  format: "esm",
  target: "es2022",
  dts: false,
  sourcemap: true,
  splitting: false,
  minify: false,
  clean: false,
};

export function nodePreset(overrides: UserConfig = {}): UserConfig {
  return defineConfig(
    mergeConfig(
      {
        ...base,
        platform: "neutral",
        entry: ["src/**/*.ts", "!src/**/*.test.ts"],
      },
      overrides,
    ),
  );
}

export function reactPreset(overrides: UserConfig = {}): UserConfig {
  return defineConfig(
    mergeConfig(
      {
        ...base,
        platform: "neutral",
        entry: ["src/**/*.ts", "src/**/*.tsx", "!src/**/*.test.ts", "!src/**/*.test.tsx"],
        external: ["react", "react-dom", "react/jsx-runtime", /^@base-ui\//],
      },
      overrides,
    ),
  );
}

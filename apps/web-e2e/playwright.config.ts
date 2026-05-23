import { defineConfig, devices } from "@playwright/test";

import { WEB_PORT } from "./src/ports.ts";

// Single source of truth for the e2e config. The harness in
// `global-setup.ts` boots the in-process backend stack and a Vite dev server
// on `WEB_PORT`, so workers point at that URL.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  // Stripe Elements iframe loads are inherently flaky if the CDN hiccups; one
  // retry on CI absorbs that without masking real product regressions.
  retries: process.env["CI"] ? 1 : 0,
  workers: 1,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : "list",
  globalSetup: "./src/global-setup.ts",
  globalTeardown: "./src/global-teardown.ts",
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

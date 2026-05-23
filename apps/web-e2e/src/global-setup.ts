import { type FullConfig } from "@playwright/test";

import { type Harness, startHarness } from "./harness.ts";

// Module-scoped so `global-teardown.ts` can call `shutdown()` on the same
// harness instance. Playwright runs both files in the same Node process, so
// importing this module from teardown gets the same singleton.
let active: Harness | undefined;

export default async function globalSetup(_config: FullConfig): Promise<void> {
  active = await startHarness();
  // Tests use Playwright's `request` context against the gateway to seed
  // backend state (e.g., a seller account + ticket the Buyer spec then
  // purchases). Exposing the discovered gateway URL via env makes it
  // available to spec-level fixtures without re-discovering it.
  process.env["WEB_E2E_GATEWAY_URL"] = active.gatewayBaseUrl;
}

export function getActiveHarness(): Harness | undefined {
  return active;
}

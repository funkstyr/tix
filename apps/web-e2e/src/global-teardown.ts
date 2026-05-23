import { getActiveHarness } from "./global-setup.ts";

export default async function globalTeardown(): Promise<void> {
  const harness = getActiveHarness();
  if (harness === undefined) return;

  await harness.shutdown();
}

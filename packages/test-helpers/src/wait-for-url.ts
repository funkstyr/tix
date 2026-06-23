import { setTimeout as delay } from "node:timers/promises";

// Polls a URL until it answers 2xx or the deadline passes. The single home for
// "is this service/dev-server up yet?" across the e2e harnesses.
export async function waitForUrl(
  url: string,
  opts: { timeoutMs: number; intervalMs?: number; label?: string },
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 250;
  const deadline = Date.now() + opts.timeoutMs;

  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line no-await-in-loop -- polling is inherently sequential
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    // eslint-disable-next-line no-await-in-loop -- backoff before the next poll
    await delay(intervalMs);
  }

  throw new Error(`${opts.label ?? "url"} did not become ready: ${url}`);
}

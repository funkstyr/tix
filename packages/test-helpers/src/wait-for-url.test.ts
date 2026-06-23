import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

import { waitForUrl } from "./wait-for-url.ts";

describe("waitForUrl", () => {
  it("resolves once the url responds ok", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected tcp address");

    await expect(
      waitForUrl(`http://127.0.0.1:${address.port}/`, { timeoutMs: 2_000 }),
    ).resolves.toBeUndefined();

    server.close();
  });

  it("keeps polling while the url is up but not ready (503 → 200)", async () => {
    // The real startup case the harnesses rely on: a service whose HTTP server is
    // already listening but answers non-2xx (readiness not yet true) before it
    // flips to 200. `res.ok` — not mere reachability — is the readiness signal.
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(hits < 3 ? 503 : 200);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected tcp address");

    await expect(
      waitForUrl(`http://127.0.0.1:${address.port}/`, { timeoutMs: 2_000, intervalMs: 10 }),
    ).resolves.toBeUndefined();
    expect(hits).toBeGreaterThanOrEqual(3);

    server.close();
  });

  it("throws a labelled error after the timeout when nothing is listening", async () => {
    await expect(
      waitForUrl("http://127.0.0.1:9/", { timeoutMs: 300, intervalMs: 50, label: "vite" }),
    ).rejects.toThrow(/vite did not become ready: http:\/\/127\.0\.0\.1:9\//);
  });
});

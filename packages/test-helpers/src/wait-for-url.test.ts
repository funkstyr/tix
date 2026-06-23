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

  it("throws a labelled error after the timeout when nothing is listening", async () => {
    await expect(
      waitForUrl("http://127.0.0.1:9/", { timeoutMs: 300, intervalMs: 50, label: "vite" }),
    ).rejects.toThrow(/vite did not become ready: http:\/\/127\.0\.0\.1:9\//);
  });
});

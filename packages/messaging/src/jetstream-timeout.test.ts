import { describe, expect, it } from "vitest";

import { withPublishTimeout } from "./jetstream.ts";

describe("withPublishTimeout", () => {
  it("resolves with the operation result when it completes before the timeout", async () => {
    const result = await withPublishTimeout(Promise.resolve("ack"), 5_000, "ticket.created.v1");

    expect(result).toBe("ack");
  });

  it("rejects with a timeout error when the operation exceeds the timeout", async () => {
    const neverSettles = new Promise<string>(() => {});

    await expect(withPublishTimeout(neverSettles, 10, "ticket.created.v1")).rejects.toThrow(
      /timed out/,
    );
  });
});

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { outboxLag } from "./outbox-lag.js";

describe("outboxLag", () => {
  it("counts rows where sentAt is null and returns the number", async () => {
    const rows = [{ value: 3 }];
    const where = vi.fn().mockResolvedValue(rows);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const db = { select } as never;
    const table = { sentAt: "sent_at_col" } as never;

    const result = await Effect.runPromise(outboxLag(db, table));
    expect(result).toBe(3);
    expect(select).toHaveBeenCalled();
  });

  it("returns 0 and logs when the query fails (never throws into the poller)", async () => {
    const where = vi.fn().mockRejectedValue(new Error("db down"));
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const db = { select } as never;
    const table = { sentAt: "sent_at_col" } as never;

    const result = await Effect.runPromise(outboxLag(db, table as never));
    expect(result).toBe(0);
  });
});

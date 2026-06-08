import { describe, expect, it, vi } from "vitest";

import { CATALOG, ensureCatalog, type CatalogEvent } from "./seed-catalog.ts";

const SELLER_TOKEN = "seller-tok";

function ticketRecord(title: string) {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    sellerId: "seller",
    title,
    quantityTotal: 100,
    quantityAvailable: 100,
    unitPriceCents: 5000,
    version: 1,
    createdAt: "2026-06-04T00:00:00.000Z",
  };
}

function stubTickets(existingTitles: readonly string[]) {
  const list = vi.fn<
    () => Promise<{ items: ReturnType<typeof ticketRecord>[]; nextCursor: string | null }>
  >(() => Promise.resolve({ items: existingTitles.map(ticketRecord), nextCursor: null }));
  const create = vi.fn<(input: { title: string }) => Promise<ReturnType<typeof ticketRecord>>>(
    (input) => Promise.resolve(ticketRecord(input.title)),
  );
  return { list, create };
}

const sample: CatalogEvent[] = [
  { title: "A", unitPriceCents: 100, quantityTotal: 10 },
  { title: "B", unitPriceCents: 200, quantityTotal: 20 },
];

describe("ensureCatalog", () => {
  it("creates only the missing events and skips ones already listed", async () => {
    const tickets = stubTickets(["A"]);

    const outcomes = await ensureCatalog(tickets, SELLER_TOKEN, sample);

    expect(tickets.create).toHaveBeenCalledTimes(1);
    expect(tickets.create).toHaveBeenCalledWith({
      token: SELLER_TOKEN,
      title: "B",
      quantityTotal: 20,
      unitPriceCents: 200,
    });
    expect(outcomes).toEqual([
      { title: "A", status: "exists" },
      { title: "B", status: "created" },
    ]);
  });

  it("is a no-op when every curated event already exists", async () => {
    const tickets = stubTickets(["A", "B"]);

    const outcomes = await ensureCatalog(tickets, SELLER_TOKEN, sample);

    expect(tickets.create).not.toHaveBeenCalled();
    expect(outcomes.every((o) => o.status === "exists")).toBe(true);
  });

  it("ships a curated anchor catalog of at least a dozen uniquely-titled events", () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(12);
    expect(new Set(CATALOG.map((e) => e.title)).size).toBe(CATALOG.length);
  });
});

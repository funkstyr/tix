import { ORPCError, createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

import type { DownstreamClients } from "./downstream-clients.ts";
import { createGatewayRouter, type GatewayInitialContext } from "./gateway-router.ts";

const TICKET_RECORD = {
  id: "00000000-0000-4000-8000-000000000001",
  sellerId: "seller-1",
  title: "Aphex Twin @ Warehouse",
  quantityTotal: 50,
  quantityAvailable: 50,
  unitPriceCents: 4500,
  version: 1,
  createdAt: "2026-05-22T00:00:00.000Z",
};

// Trapping proxy: any property read explodes immediately, so a test that
// accidentally reaches into an unimplemented downstream client fails loudly
// instead of NPE'ing deep inside oRPC.
function unimplementedClient<K extends keyof DownstreamClients>(name: K): DownstreamClients[K] {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `downstream client "${name}" is not implemented in this test (read: ${String(prop)})`,
        );
      },
    },
  ) as DownstreamClients[K];
}

function emptyClients(): DownstreamClients {
  return {
    tickets: unimplementedClient("tickets"),
    orders: unimplementedClient("orders"),
    payments: unimplementedClient("payments"),
    auth: unimplementedClient("auth"),
  };
}

function buildClient(clients: DownstreamClients) {
  const router = createGatewayRouter({ clients });
  const context: GatewayInitialContext = { cookieHeader: null };

  return createRouterClient(router, { context });
}

describe("createGatewayRouter", () => {
  it("delegates tickets.list to the downstream tickets client, forwarding the cookie header", async () => {
    const list = vi
      .fn<DownstreamClients["tickets"]["list"]>()
      .mockResolvedValue({ items: [TICKET_RECORD] });
    const clients = emptyClients();
    clients.tickets = { list } as unknown as DownstreamClients["tickets"];

    const router = createGatewayRouter({ clients });
    const client = createRouterClient(router, {
      context: { cookieHeader: "tix.session=abc" } satisfies GatewayInitialContext,
    });

    const result = await client.tickets.list({ limit: 10 });

    expect(result).toEqual({ items: [TICKET_RECORD] });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(
      { limit: 10 },
      { context: { cookieHeader: "tix.session=abc" } },
    );
  });

  it("forwards a null cookieHeader when the request has no cookie", async () => {
    const list = vi.fn<DownstreamClients["tickets"]["list"]>().mockResolvedValue({ items: [] });
    const clients = emptyClients();
    clients.tickets = { list } as unknown as DownstreamClients["tickets"];

    const client = buildClient(clients);
    await client.tickets.list({});

    expect(list).toHaveBeenCalledWith({}, { context: { cookieHeader: null } });
  });

  it("propagates an ORPCError thrown by the downstream client with the same code, message, and data", async () => {
    const list = vi.fn<DownstreamClients["tickets"]["list"]>().mockRejectedValue(
      new ORPCError("CONFLICT", {
        status: 409,
        message: "sold out",
        data: { reason: "sold_out" as const },
      }),
    );
    const clients = emptyClients();
    clients.tickets = { list } as unknown as DownstreamClients["tickets"];

    const client = buildClient(clients);

    await expect(client.tickets.list({})).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      message: "sold out",
      data: { reason: "sold_out" },
    });
  });

  it("rejects invalid input at the arktype boundary without reaching the downstream client", async () => {
    const list = vi.fn<DownstreamClients["tickets"]["list"]>();
    const clients = emptyClients();
    clients.tickets = { list } as unknown as DownstreamClients["tickets"];

    const client = buildClient(clients);

    await expect(client.tickets.list({ limit: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(list).not.toHaveBeenCalled();
  });
});

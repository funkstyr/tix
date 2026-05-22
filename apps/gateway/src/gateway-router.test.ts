import { ORPCError, createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

import type { CurrentUser } from "@tix/contracts/auth";

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

function emptyClients(): DownstreamClients {
  return {
    tickets: {} as DownstreamClients["tickets"],
    orders: {} as DownstreamClients["orders"],
    payments: {} as DownstreamClients["payments"],
    auth: {} as DownstreamClients["auth"],
  };
}

function buildClient(clients: DownstreamClients, getCurrentUser = async (): Promise<null> => null) {
  const router = createGatewayRouter({ clients, getCurrentUser });
  const context: GatewayInitialContext = {
    request: new Request("http://gateway.test/rpc/tickets/list"),
    cookieHeader: null,
  };

  return createRouterClient(router, { context });
}

describe("createGatewayRouter", () => {
  it("delegates tickets.list to the downstream tickets client, forwarding the cookie header", async () => {
    const list = vi
      .fn<DownstreamClients["tickets"]["list"]>()
      .mockResolvedValue({ items: [TICKET_RECORD] });
    const clients = emptyClients();
    clients.tickets = { list } as unknown as DownstreamClients["tickets"];

    const router = createGatewayRouter({ clients, getCurrentUser: async () => null });
    const client = createRouterClient(router, {
      context: {
        request: new Request("http://gateway.test/rpc/tickets/list"),
        cookieHeader: "tix.session=abc",
      } satisfies GatewayInitialContext,
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

  it("invokes getCurrentUser once per call with the request from oRPC context", async () => {
    const list = vi.fn<DownstreamClients["tickets"]["list"]>().mockResolvedValue({ items: [] });
    const clients = emptyClients();
    clients.tickets = { list } as unknown as DownstreamClients["tickets"];

    const user: CurrentUser = { id: "u-1", email: "x@y.test", name: "X" };
    const getCurrentUser = vi
      .fn<(req: Request) => Promise<CurrentUser | null>>()
      .mockResolvedValue(user);

    const router = createGatewayRouter({ clients, getCurrentUser });
    const request = new Request("http://gateway.test/rpc/tickets/list");
    const client = createRouterClient(router, {
      context: { request, cookieHeader: null } satisfies GatewayInitialContext,
    });

    await client.tickets.list({});

    expect(getCurrentUser).toHaveBeenCalledTimes(1);
    expect(getCurrentUser).toHaveBeenCalledWith(request);
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

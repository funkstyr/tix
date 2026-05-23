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

const ORDER_RECORD = {
  id: "00000000-0000-4000-8000-0000000000a1",
  buyerId: "buyer-1",
  ticketId: "00000000-0000-4000-8000-000000000001",
  quantity: 2,
  priceCents: 10_000,
  status: "created" as const,
  expiresAt: "2026-05-22T00:15:00.000Z",
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

function withDownstreamStub<K extends keyof DownstreamClients>(
  name: K,
  partial: Partial<DownstreamClients[K]>,
  context: GatewayInitialContext = { cookieHeader: null },
) {
  const clients = emptyClients();
  clients[name] = partial as unknown as DownstreamClients[K];
  const router = createGatewayRouter({ clients });

  return createRouterClient(router, { context });
}

describe("createGatewayRouter", () => {
  it("delegates tickets.list to the downstream tickets client, forwarding the cookie header", async () => {
    const list = vi
      .fn<DownstreamClients["tickets"]["list"]>()
      .mockResolvedValue({ items: [TICKET_RECORD] });
    const client = withDownstreamStub("tickets", { list }, { cookieHeader: "tix.session=abc" });

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
    const client = withDownstreamStub("tickets", { list });

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
    const client = withDownstreamStub("tickets", { list });

    await expect(client.tickets.list({})).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      message: "sold out",
      data: { reason: "sold_out" },
    });
  });

  it("rejects invalid input at the arktype boundary without reaching the downstream client", async () => {
    const list = vi.fn<DownstreamClients["tickets"]["list"]>();
    const client = withDownstreamStub("tickets", { list });

    await expect(client.tickets.list({ limit: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(list).not.toHaveBeenCalled();
  });

  it("delegates tickets.create to the downstream tickets client, forwarding input and cookie header", async () => {
    const create = vi.fn<DownstreamClients["tickets"]["create"]>().mockResolvedValue(TICKET_RECORD);
    const client = withDownstreamStub("tickets", { create }, { cookieHeader: "tix.session=abc" });

    const input = {
      token: "session-token",
      title: "Aphex Twin @ Warehouse",
      quantityTotal: 50,
      unitPriceCents: 4500,
    };
    const result = await client.tickets.create(input);

    expect(result).toEqual(TICKET_RECORD);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(input, { context: { cookieHeader: "tix.session=abc" } });
  });

  it("propagates ORPCError thrown by tickets.create", async () => {
    const create = vi.fn<DownstreamClients["tickets"]["create"]>().mockRejectedValue(
      new ORPCError("UNAUTHORIZED", {
        status: 401,
        message: "invalid or expired session",
      }),
    );
    const client = withDownstreamStub("tickets", { create });

    await expect(
      client.tickets.create({
        token: "stale",
        title: "Aphex Twin @ Warehouse",
        quantityTotal: 50,
        unitPriceCents: 4500,
      }),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
      message: "invalid or expired session",
    });
  });

  it("rejects invalid tickets.create input at the arktype boundary", async () => {
    const create = vi.fn<DownstreamClients["tickets"]["create"]>();
    const client = withDownstreamStub("tickets", { create });

    await expect(
      client.tickets.create({
        token: "session-token",
        title: "Aphex Twin @ Warehouse",
        quantityTotal: 0,
        unitPriceCents: 4500,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(create).not.toHaveBeenCalled();
  });

  it("delegates tickets.getById to the downstream tickets client, forwarding cookie header", async () => {
    const getById = vi
      .fn<DownstreamClients["tickets"]["getById"]>()
      .mockResolvedValue(TICKET_RECORD);
    const client = withDownstreamStub("tickets", { getById }, { cookieHeader: "tix.session=abc" });

    const result = await client.tickets.getById({ ticketId: TICKET_RECORD.id });

    expect(result).toEqual(TICKET_RECORD);
    expect(getById).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenCalledWith(
      { ticketId: TICKET_RECORD.id },
      { context: { cookieHeader: "tix.session=abc" } },
    );
  });

  it("returns null when tickets.getById finds no ticket", async () => {
    const getById = vi.fn<DownstreamClients["tickets"]["getById"]>().mockResolvedValue(null);
    const client = withDownstreamStub("tickets", { getById });

    const result = await client.tickets.getById({ ticketId: TICKET_RECORD.id });

    expect(result).toBeNull();
    expect(getById).toHaveBeenCalledWith(
      { ticketId: TICKET_RECORD.id },
      { context: { cookieHeader: null } },
    );
  });

  it("rejects invalid tickets.getById input at the arktype boundary", async () => {
    const getById = vi.fn<DownstreamClients["tickets"]["getById"]>();
    const client = withDownstreamStub("tickets", { getById });

    await expect(client.tickets.getById({ ticketId: "not-a-uuid" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(getById).not.toHaveBeenCalled();
  });

  it("delegates orders.create to the downstream orders client, forwarding input and cookie header", async () => {
    const create = vi.fn<DownstreamClients["orders"]["create"]>().mockResolvedValue(ORDER_RECORD);
    const client = withDownstreamStub("orders", { create }, { cookieHeader: "tix.session=abc" });

    const input = {
      token: "session-token",
      ticketId: ORDER_RECORD.ticketId,
      quantity: 2,
    };
    const result = await client.orders.create(input);

    expect(result).toEqual(ORDER_RECORD);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(input, { context: { cookieHeader: "tix.session=abc" } });
  });

  it("propagates an ORPCError thrown by orders.create with the same code, message, and data", async () => {
    const create = vi.fn<DownstreamClients["orders"]["create"]>().mockRejectedValue(
      new ORPCError("GONE", {
        status: 410,
        message: "ticket is sold out",
        data: { reason: "sold_out" as const },
      }),
    );
    const client = withDownstreamStub("orders", { create });

    await expect(
      client.orders.create({
        token: "session-token",
        ticketId: ORDER_RECORD.ticketId,
        quantity: 2,
      }),
    ).rejects.toMatchObject({
      code: "GONE",
      status: 410,
      message: "ticket is sold out",
      data: { reason: "sold_out" },
    });
  });

  it("rejects invalid orders.create input at the arktype boundary", async () => {
    const create = vi.fn<DownstreamClients["orders"]["create"]>();
    const client = withDownstreamStub("orders", { create });

    await expect(
      client.orders.create({
        token: "session-token",
        ticketId: ORDER_RECORD.ticketId,
        quantity: 0,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(create).not.toHaveBeenCalled();
  });

  it("delegates orders.getById to the downstream orders client, forwarding cookie header", async () => {
    const getById = vi.fn<DownstreamClients["orders"]["getById"]>().mockResolvedValue(ORDER_RECORD);
    const client = withDownstreamStub("orders", { getById }, { cookieHeader: "tix.session=abc" });

    const input = { token: "session-token", orderId: ORDER_RECORD.id };
    const result = await client.orders.getById(input);

    expect(result).toEqual(ORDER_RECORD);
    expect(getById).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenCalledWith(input, {
      context: { cookieHeader: "tix.session=abc" },
    });
  });

  it("returns null when orders.getById finds no order", async () => {
    const getById = vi.fn<DownstreamClients["orders"]["getById"]>().mockResolvedValue(null);
    const client = withDownstreamStub("orders", { getById });

    const input = { token: "session-token", orderId: ORDER_RECORD.id };
    const result = await client.orders.getById(input);

    expect(result).toBeNull();
    expect(getById).toHaveBeenCalledWith(input, { context: { cookieHeader: null } });
  });

  it("rejects invalid orders.getById input at the arktype boundary", async () => {
    const getById = vi.fn<DownstreamClients["orders"]["getById"]>();
    const client = withDownstreamStub("orders", { getById });

    await expect(
      client.orders.getById({ token: "session-token", orderId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(getById).not.toHaveBeenCalled();
  });

  it("rejects orders.getById with a missing token at the arktype boundary", async () => {
    const getById = vi.fn<DownstreamClients["orders"]["getById"]>();
    const client = withDownstreamStub("orders", { getById });

    await expect(
      // @ts-expect-error missing token verifies arktype boundary
      client.orders.getById({ orderId: ORDER_RECORD.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(getById).not.toHaveBeenCalled();
  });

  it("delegates orders.list to the downstream orders client, forwarding input and cookie header", async () => {
    const list = vi
      .fn<DownstreamClients["orders"]["list"]>()
      .mockResolvedValue({ items: [ORDER_RECORD] });
    const client = withDownstreamStub("orders", { list }, { cookieHeader: "tix.session=abc" });

    const input = { token: "session-token", limit: 10 };
    const result = await client.orders.list(input);

    expect(result).toEqual({ items: [ORDER_RECORD] });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(input, { context: { cookieHeader: "tix.session=abc" } });
  });

  it("rejects orders.list with a missing token at the arktype boundary", async () => {
    const list = vi.fn<DownstreamClients["orders"]["list"]>();
    const client = withDownstreamStub("orders", { list });

    await expect(
      // @ts-expect-error missing token verifies arktype boundary
      client.orders.list({}),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(list).not.toHaveBeenCalled();
  });

  it("delegates payments.create to the downstream payments client, forwarding input and cookie header", async () => {
    const create = vi
      .fn<DownstreamClients["payments"]["create"]>()
      .mockResolvedValue({ id: "00000000-0000-4000-8000-0000000000b1", status: "succeeded" });
    const client = withDownstreamStub("payments", { create }, { cookieHeader: "tix.session=abc" });

    const input = {
      token: "session-token",
      orderId: ORDER_RECORD.id,
      paymentMethodId: "pm_card_visa",
    };
    const result = await client.payments.create(input);

    expect(result).toEqual({ id: "00000000-0000-4000-8000-0000000000b1", status: "succeeded" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(input, { context: { cookieHeader: "tix.session=abc" } });
  });

  it("forwards a null cookieHeader to payments.create when the request has no cookie", async () => {
    const create = vi
      .fn<DownstreamClients["payments"]["create"]>()
      .mockResolvedValue({ id: "00000000-0000-4000-8000-0000000000b1", status: "succeeded" });
    const client = withDownstreamStub("payments", { create });

    const input = {
      token: "session-token",
      orderId: ORDER_RECORD.id,
      paymentMethodId: "pm_card_visa",
    };
    await client.payments.create(input);

    expect(create).toHaveBeenCalledWith(input, { context: { cookieHeader: null } });
  });

  it("propagates an ORPCError thrown by payments.create with the same code, message, and data", async () => {
    const create = vi.fn<DownstreamClients["payments"]["create"]>().mockRejectedValue(
      new ORPCError("CONFLICT", {
        status: 409,
        message: "order is not payable",
        data: { reason: "not_payable" as const, status: "cancelled" },
      }),
    );
    const client = withDownstreamStub("payments", { create });

    await expect(
      client.payments.create({
        token: "session-token",
        orderId: ORDER_RECORD.id,
        paymentMethodId: "pm_card_visa",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      message: "order is not payable",
      data: { reason: "not_payable", status: "cancelled" },
    });
  });

  it("rejects invalid payments.create input at the arktype boundary", async () => {
    const create = vi.fn<DownstreamClients["payments"]["create"]>();
    const client = withDownstreamStub("payments", { create });

    await expect(
      client.payments.create({
        token: "session-token",
        orderId: "not-a-uuid",
        paymentMethodId: "pm_card_visa",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects payments.create with a missing token at the arktype boundary", async () => {
    const create = vi.fn<DownstreamClients["payments"]["create"]>();
    const client = withDownstreamStub("payments", { create });

    await expect(
      // @ts-expect-error missing token verifies arktype boundary
      client.payments.create({
        orderId: ORDER_RECORD.id,
        paymentMethodId: "pm_card_visa",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(create).not.toHaveBeenCalled();
  });
});

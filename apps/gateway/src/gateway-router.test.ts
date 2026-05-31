import { ROOT_CONTEXT } from "@opentelemetry/api";
import { ORPCError, createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

import type { DownstreamClients } from "./downstream-clients.ts";
import { createGatewayRouter, type GatewayRequestContext } from "./gateway-router.ts";
import { createGatewayTestRuntime } from "./gateway-test-runtime.ts";

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
  cookieHeader: string | null = null,
) {
  const clients = emptyClients();
  clients[name] = partial as unknown as DownstreamClients[K];
  const runtime = createGatewayTestRuntime({ clients });
  const router = createGatewayRouter(runtime);

  const context: GatewayRequestContext = { cookieHeader, otelParent: ROOT_CONTEXT };

  return createRouterClient(router, { context });
}

// The router is a pure pass-through; its own behaviour is cookie injection,
// error transparency, and null passthrough. Those are pinned once below.
// Per-procedure input validation lives with the schemas in `@tix/contracts`,
// and one delegation per downstream service confirms the wiring without
// re-testing the same forwarding path for every procedure.
describe("createGatewayRouter", () => {
  it("delegates to the downstream tickets client, forwarding the cookie header", async () => {
    const list = vi
      .fn<DownstreamClients["tickets"]["list"]>()
      .mockResolvedValue({ items: [TICKET_RECORD] });
    const client = withDownstreamStub("tickets", { list }, "tix.session=abc");

    const result = await client.tickets.list({ limit: 10 });

    expect(result).toEqual({ items: [TICKET_RECORD] });
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

  it("returns null when the downstream getById finds no record", async () => {
    const getById = vi.fn<DownstreamClients["tickets"]["getById"]>().mockResolvedValue(null);
    const client = withDownstreamStub("tickets", { getById });

    const result = await client.tickets.getById({ ticketId: TICKET_RECORD.id });

    expect(result).toBeNull();
  });

  it("delegates to the downstream orders client, forwarding input and cookie header", async () => {
    const create = vi.fn<DownstreamClients["orders"]["create"]>().mockResolvedValue(ORDER_RECORD);
    const client = withDownstreamStub("orders", { create }, "tix.session=abc");

    const input = { token: "session-token", ticketId: ORDER_RECORD.ticketId, quantity: 2 };
    const result = await client.orders.create(input);

    expect(result).toEqual(ORDER_RECORD);
    expect(create).toHaveBeenCalledWith(input, { context: { cookieHeader: "tix.session=abc" } });
  });

  it("delegates to the downstream payments client, forwarding input and cookie header", async () => {
    const create = vi
      .fn<DownstreamClients["payments"]["create"]>()
      .mockResolvedValue({ id: "00000000-0000-4000-8000-0000000000b1", status: "succeeded" });
    const client = withDownstreamStub("payments", { create }, "tix.session=abc");

    const input = {
      token: "session-token",
      orderId: ORDER_RECORD.id,
      paymentMethodId: "pm_card_visa",
    };
    const result = await client.payments.create(input);

    expect(result).toEqual({ id: "00000000-0000-4000-8000-0000000000b1", status: "succeeded" });
    expect(create).toHaveBeenCalledWith(input, { context: { cookieHeader: "tix.session=abc" } });
  });
});

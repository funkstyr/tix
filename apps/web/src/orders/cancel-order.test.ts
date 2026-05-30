import { describe, expect, it, vi } from "vitest";

import type { GatewayRouterClient } from "@tix/contracts/gateway";
import type { OrderRecord } from "@tix/contracts/orders";

import { cancelOrder } from "./cancel-order";

type CancelFn = (input: unknown) => Promise<OrderRecord>;

function makeClient(impl: CancelFn): {
  client: GatewayRouterClient;
  cancel: ReturnType<typeof vi.fn<CancelFn>>;
} {
  const cancel = vi.fn<CancelFn>(impl);
  const client = { orders: { cancel } } as unknown as GatewayRouterClient;
  return { client, cancel };
}

const TOKEN = "session-token";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";

const cancelledOrder: OrderRecord = {
  id: ORDER_ID,
  buyerId: "22222222-2222-4222-8222-222222222222",
  ticketId: "33333333-3333-4333-8333-333333333333",
  quantity: 1,
  priceCents: 5000,
  status: "cancelled",
  expiresAt: "2026-05-20T12:15:00.000Z",
  version: 2,
  createdAt: "2026-05-20T12:00:00.000Z",
};

describe("cancelOrder", () => {
  it("calls orders.cancel with the token and orderId", async () => {
    const { client, cancel } = makeClient(async () => cancelledOrder);

    await cancelOrder({ client, token: TOKEN, orderId: ORDER_ID });

    expect(cancel).toHaveBeenCalledWith({ token: TOKEN, orderId: ORDER_ID });
  });

  it("returns the cancelled order so the view can transition its status", async () => {
    const { client } = makeClient(async () => cancelledOrder);

    const result = await cancelOrder({ client, token: TOKEN, orderId: ORDER_ID });

    expect(result).toEqual({ ok: true, order: cancelledOrder });
  });

  it("surfaces a friendly error when the cancel call rejects", async () => {
    const { client } = makeClient(async () => {
      throw new Error("order already shipped");
    });

    const result = await cancelOrder({ client, token: TOKEN, orderId: ORDER_ID });

    expect(result).toEqual({ ok: false, error: "order already shipped" });
  });

  it("falls back to a generic message when the cancel call rejects with a non-Error", async () => {
    const { client } = makeClient(async () => {
      throw "boom";
    });

    const result = await cancelOrder({ client, token: TOKEN, orderId: ORDER_ID });

    expect(result).toEqual({ ok: false, error: "Could not cancel order" });
  });
});

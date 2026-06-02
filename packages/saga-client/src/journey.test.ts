import { describe, expect, it, vi } from "vitest";

import type { SagaClients } from "./clients.ts";
import { runBuyerJourney } from "./journey.ts";

function stubClients(): { clients: SagaClients; calls: string[] } {
  const calls: string[] = [];
  const credential = { userId: "u", email: "e@x.com", token: "tok" };
  const ticket = {
    id: "11111111-1111-4111-8111-111111111111",
    sellerId: "u",
    title: "synthetic",
    quantityTotal: 1,
    quantityAvailable: 1,
    unitPriceCents: 5000,
    version: 1,
    createdAt: "2026-06-02T00:00:00.000Z",
  };
  const order = {
    id: "22222222-2222-4222-8222-222222222222",
    buyerId: "u",
    ticketId: ticket.id,
    quantity: 1,
    priceCents: 5000,
    status: "complete" as const,
    expiresAt: "2026-06-02T00:05:00.000Z",
    version: 2,
    createdAt: "2026-06-02T00:00:00.000Z",
  };
  const clients: SagaClients = {
    auth: {
      signIn: vi.fn<() => Promise<typeof credential>>(() => {
        calls.push("signIn");
        return Promise.resolve(credential);
      }),
      signUp: vi.fn<() => Promise<typeof credential>>(() => Promise.resolve(credential)),
      signOut: vi.fn<() => Promise<{ ok: true }>>(() => Promise.resolve({ ok: true as const })),
      getSession: vi.fn<() => Promise<null>>(() => Promise.resolve(null)),
    } as unknown as SagaClients["auth"],
    tickets: {
      create: vi.fn<() => Promise<typeof ticket>>(() => {
        calls.push("ticket.create");
        return Promise.resolve(ticket);
      }),
      update: vi.fn<() => void>(),
      reserve: vi.fn<() => void>(),
      getById: vi.fn<() => Promise<typeof ticket>>(() => Promise.resolve(ticket)),
      list: vi.fn<() => void>(),
      listMine: vi.fn<() => void>(),
    } as unknown as SagaClients["tickets"],
    orders: {
      create: vi.fn<() => Promise<typeof order>>(() => {
        calls.push("order.create");
        return Promise.resolve(order);
      }),
      getById: vi.fn<() => Promise<typeof order>>(() => Promise.resolve(order)),
      list: vi.fn<() => void>(),
      cancel: vi.fn<() => Promise<typeof order>>(() => {
        calls.push("order.cancel");
        return Promise.resolve(order);
      }),
    } as unknown as SagaClients["orders"],
    payments: {
      create: vi.fn<() => Promise<{ id: string; status: "succeeded" }>>(() => {
        calls.push("payment.create");
        return Promise.resolve({
          id: "33333333-3333-4333-8333-333333333333",
          status: "succeeded" as const,
        });
      }),
    } as unknown as SagaClients["payments"],
  };
  return { clients, calls };
}

describe("runBuyerJourney", () => {
  it("drives sign-in -> ticket -> order -> charge -> cleanup in order", async () => {
    const { clients, calls } = stubClients();

    const result = await runBuyerJourney({
      clients,
      seller: { email: "seller@x.com", password: "pw" },
      buyer: { email: "buyer@x.com", password: "pw" },
      paymentMethodId: "pm_card_visa",
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      "signIn",
      "ticket.create",
      "signIn",
      "order.create",
      "payment.create",
      "order.cancel",
    ]);
    expect(result.steps.charge).toBe("succeeded");
  });

  it("reports failure (and still attempts cleanup) when the charge does not succeed", async () => {
    const { clients } = stubClients();
    clients.payments.create = vi.fn<
      () => Promise<{ id: string; status: "requires_payment_method" }>
    >(() =>
      Promise.resolve({
        id: "33333333-3333-4333-8333-333333333333",
        status: "requires_payment_method" as const,
      }),
    ) as unknown as SagaClients["payments"]["create"];

    const result = await runBuyerJourney({
      clients,
      seller: { email: "seller@x.com", password: "pw" },
      buyer: { email: "buyer@x.com", password: "pw" },
      paymentMethodId: "pm_card_chargeDeclined",
    });

    expect(result.ok).toBe(false);
    expect(clients.orders.cancel).toHaveBeenCalledOnce();
    expect(result.steps.ticketId).toBeDefined();
    expect(result.steps.orderId).toBeDefined();
    expect(result.steps.charge).toBe("requires_payment_method");
    expect(result.error).toMatch(/charge status/);
  });
});

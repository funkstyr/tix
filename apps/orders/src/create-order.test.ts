import { it } from "@effect/vitest";
import { Effect, TestClock } from "effect";
import { expect } from "vitest";

import type { AuthSession } from "@tix/contracts/auth";
import type { AuthSessionClient } from "@tix/contracts/auth-client";
import type { ReserveTicketOutput } from "@tix/contracts/tickets-reserve";

import { createOrderProgram } from "./router.ts";
import type { OrdersDb } from "./services.ts";
import { createOrdersTestLayer } from "./test-runtime.ts";
import type { TicketsClient, TicketSnapshot } from "./tickets-client.ts";

const RESERVATION_TTL_MS = 15 * 60 * 1000;

const BUYER_ID = "buyer-1";
const SELLER_ID = "seller-1";
const TICKET_ID = "11111111-1111-4111-8111-111111111111";

function stubAuth(): AuthSessionClient {
  const session = { user: { id: BUYER_ID } } as AuthSession;

  return { getSession: () => Promise.resolve(session) };
}

function stubTickets(): TicketsClient {
  const snapshot = {
    id: TICKET_ID,
    sellerId: SELLER_ID,
    quantityAvailable: 5,
  } as TicketSnapshot;
  const reserved = { unitPriceCents: 5000 } as ReserveTicketOutput;

  return {
    getById: () => Promise.resolve(snapshot),
    reserve: () => Promise.resolve(reserved),
  };
}

// Captures the row the handler would have persisted so the test can assert the
// Clock-derived timestamps without a real database. The transaction callback runs
// against this fake tx exactly as drizzle would.
function capturingDb(captured: { createdAt?: Date; expiresAt?: Date }): OrdersDb {
  const tx = {
    insert: () => ({
      values: (row: { createdAt: Date; expiresAt: Date }) => ({
        returning: () => {
          captured.createdAt = row.createdAt;
          captured.expiresAt = row.expiresAt;

          return Promise.resolve([{ ...row, version: 1, status: "created" }]);
        },
      }),
    }),
  };

  return { db: { transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) } } as unknown as OrdersDb;
}

it.effect("sets expiresAt to the Clock's now + reservationTtlMs", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(1_700_000_000_000);

    const captured: { createdAt?: Date; expiresAt?: Date } = {};
    const layer = createOrdersTestLayer({
      db: capturingDb(captured),
      authClient: stubAuth(),
      ticketsClient: stubTickets(),
      reservationTtlMs: RESERVATION_TTL_MS,
    });

    const order = yield* createOrderProgram({
      token: "t",
      ticketId: TICKET_ID,
      quantity: 2,
    }).pipe(Effect.provide(layer));

    expect(captured.createdAt?.getTime()).toBe(1_700_000_000_000);
    expect(captured.expiresAt?.getTime()).toBe(1_700_000_000_000 + RESERVATION_TTL_MS);
    expect(Date.parse(order.expiresAt)).toBe(1_700_000_000_000 + RESERVATION_TTL_MS);
    expect(order.priceCents).toBe(10_000);
  }),
);

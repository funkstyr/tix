import { Effect, TestClock, TestContext } from "effect";
import { expect, it } from "vitest";

import type { AuthSession } from "@tix/contracts/auth";
import type { AuthSessionClient } from "@tix/contracts/auth-client";
import type { ReserveTicketOutput } from "@tix/contracts/tickets-reserve";

import type { OrdersDb } from "../runtime/services.ts";
import { createOrdersTestLayer } from "../runtime/test-runtime.ts";
import type { TicketsClient, TicketSnapshot } from "../tickets-client.ts";
import { createOrderProgram } from "./router.ts";

const RESERVATION_TTL_MS = 15 * 60 * 1000;

const BUYER_ID = "buyer-1";
const SELLER_ID = "seller-1";
const TICKET_ID = "11111111-1111-4111-8111-111111111111";

function stubAuth(): AuthSessionClient {
  const session = { user: { id: BUYER_ID } } as AuthSession;

  return { getSession: () => Promise.resolve(session) };
}

function stubTickets(): TicketsClient {
  const snapshot = { id: TICKET_ID, sellerId: SELLER_ID, quantityAvailable: 5 } as TicketSnapshot;
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
  const db = { transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) };

  return { db } as unknown as OrdersDb;
}

it("sets expiresAt to the Clock's now + reservationTtlMs", async () => {
  const captured: { createdAt?: Date; expiresAt?: Date } = {};
  const layer = createOrdersTestLayer({
    db: capturingDb(captured),
    authClient: stubAuth(),
    ticketsClient: stubTickets(),
    reservationTtlMs: RESERVATION_TTL_MS,
  });

  // TestClock pins "now" so the TTL/expiry derivation is deterministic; the
  // service layer deliberately omits Clock so this ambient TestClock is in scope.
  const program = Effect.gen(function* () {
    yield* TestClock.setTime(1_700_000_000_000);

    return yield* createOrderProgram({ token: "t", ticketId: TICKET_ID, quantity: 2 }).pipe(
      Effect.provide(layer),
    );
  }).pipe(Effect.provide(TestContext.TestContext));

  const order = await Effect.runPromise(program);

  expect(captured.createdAt?.getTime()).toBe(1_700_000_000_000);
  expect(captured.expiresAt?.getTime()).toBe(1_700_000_000_000 + RESERVATION_TTL_MS);
  expect(Date.parse(order.expiresAt)).toBe(1_700_000_000_000 + RESERVATION_TTL_MS);
  expect(order.priceCents).toBe(10_000);
});

import { expect, it } from "@effect/vitest";
import { ORPCError } from "@orpc/server";
import { Effect, TestClock } from "effect";

import type { AuthSession } from "@tix/contracts/auth";
import type { AuthSessionClient } from "@tix/contracts/auth-client";
import type { ReserveTicketOutput } from "@tix/contracts/tickets-reserve";

import { ReservationConflict, TicketNotFound } from "../domain/errors.ts";
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

// A tickets client whose `getById` succeeds (so the program reaches the reserve
// call) but whose `reserve` rejects with the given oRPC code — mirroring how the
// real oRPC client surfaces a tickets-side failure.
function stubTicketsRejectingReserve(code: "CONFLICT" | "NOT_FOUND"): TicketsClient {
  const snapshot = { id: TICKET_ID, sellerId: SELLER_ID, quantityAvailable: 5 } as TicketSnapshot;

  return {
    getById: () => Promise.resolve(snapshot),
    reserve: () => Promise.reject(new ORPCError(code)),
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

// `it.effect` provides the ambient `TestClock` (via TestContext); the service
// layer deliberately omits Clock so this TestClock stays in scope, making the
// TTL/expiry derivation deterministic.
it.effect("sets expiresAt to the Clock's now + reservationTtlMs", () =>
  Effect.gen(function* () {
    const captured: { createdAt?: Date; expiresAt?: Date } = {};
    const layer = createOrdersTestLayer({
      db: capturingDb(captured),
      authClient: stubAuth(),
      ticketsClient: stubTickets(),
      reservationTtlMs: RESERVATION_TTL_MS,
    });

    yield* TestClock.setTime(1_700_000_000_000);

    const order = yield* createOrderProgram({ token: "t", ticketId: TICKET_ID, quantity: 2 }).pipe(
      Effect.provide(layer),
    );

    expect(captured.createdAt?.getTime()).toBe(1_700_000_000_000);
    expect(captured.expiresAt?.getTime()).toBe(1_700_000_000_000 + RESERVATION_TTL_MS);
    expect(Date.parse(order.expiresAt)).toBe(1_700_000_000_000 + RESERVATION_TTL_MS);
    expect(order.priceCents).toBe(10_000);
  }),
);

// Lost the race: a CONFLICT from `reserve` maps to the domain `ReservationConflict`
// tag, not the raw oRPC error (which the boundary later renders as 409 race_lost).
it.effect("maps a reserve CONFLICT to ReservationConflict", () =>
  Effect.gen(function* () {
    const layer = createOrdersTestLayer({
      db: capturingDb({}),
      authClient: stubAuth(),
      ticketsClient: stubTicketsRejectingReserve("CONFLICT"),
    });

    const error = yield* createOrderProgram({ token: "t", ticketId: TICKET_ID, quantity: 2 }).pipe(
      Effect.provide(layer),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(ReservationConflict);
  }),
);

// The ticket vanished between `getById` and `reserve`: a NOT_FOUND maps to the
// domain `TicketNotFound` tag.
it.effect("maps a reserve NOT_FOUND to TicketNotFound", () =>
  Effect.gen(function* () {
    const layer = createOrdersTestLayer({
      db: capturingDb({}),
      authClient: stubAuth(),
      ticketsClient: stubTicketsRejectingReserve("NOT_FOUND"),
    });

    const error = yield* createOrderProgram({ token: "t", ticketId: TICKET_ID, quantity: 2 }).pipe(
      Effect.provide(layer),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(TicketNotFound);
  }),
);

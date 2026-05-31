import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { AuthSessionClient } from "@tix/contracts/auth-client";

import type { TicketsDb } from "../runtime/services.ts";
import { createTicketsTestLayer } from "../runtime/test-runtime.ts";
import { updateTicketProgram } from "./update-ticket.ts";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const SELLER_ID = "seller-1";

type ExistingRow = {
  id: string;
  sellerId: string;
  title: string;
  quantityTotal: number;
  quantityAvailable: number;
  unitPriceCents: number;
  version: number;
  createdAt: Date;
};

// A transaction stand-in: `transaction(cb)` runs the callback against a fake `tx` whose
// `select` yields the scripted existing row and whose `updateVersioned` (which calls
// `update().set().where().returning()`) yields `updateRows` affected rows. `insert` covers
// the outbox `enqueueEvent` on the success path.
function fakeUpdateDb(opts: { existing?: ExistingRow; updateRows?: number }): TicketsDb {
  const tx = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(opts.existing === undefined ? [] : [opts.existing]),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () =>
            Promise.resolve(
              Array.from({ length: opts.updateRows ?? 0 }, () => ({ id: TICKET_ID })),
            ),
        }),
      }),
    }),
    insert: () => ({ values: () => Promise.resolve([]) }),
  };

  const db = { transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(tx) };

  return { db } as unknown as TicketsDb;
}

function fakeAuthClient(userId: string): AuthSessionClient {
  return {
    getSession: () => Promise.resolve({ user: { id: userId } }),
  } as unknown as AuthSessionClient;
}

const existing = (overrides: Partial<ExistingRow> = {}): ExistingRow => ({
  id: TICKET_ID,
  sellerId: SELLER_ID,
  title: "Original",
  quantityTotal: 4,
  quantityAvailable: 4,
  unitPriceCents: 5000,
  version: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const input = {
  token: "tok",
  ticketId: TICKET_ID,
  title: "Renamed",
  unitPriceCents: 6000,
  expectedVersion: 1,
};

it.effect("fails with TicketNotFound when the ticket does not exist", () =>
  Effect.gen(function* () {
    const layer = createTicketsTestLayer({
      db: fakeUpdateDb({}),
      authClient: fakeAuthClient(SELLER_ID),
    });

    const error = yield* updateTicketProgram(input).pipe(Effect.provide(layer), Effect.flip);

    expect(error).toMatchObject({ _tag: "TicketNotFound", ticketId: TICKET_ID });
  }),
);

it.effect("fails with TicketNotFound when the caller is not the seller", () =>
  Effect.gen(function* () {
    const layer = createTicketsTestLayer({
      db: fakeUpdateDb({ existing: existing({ sellerId: "someone-else" }) }),
      authClient: fakeAuthClient(SELLER_ID),
    });

    const error = yield* updateTicketProgram(input).pipe(Effect.provide(layer), Effect.flip);

    expect(error).toMatchObject({ _tag: "TicketNotFound", ticketId: TICKET_ID });
  }),
);

it.effect("fails with TicketReserved when seats are held or sold", () =>
  Effect.gen(function* () {
    const layer = createTicketsTestLayer({
      db: fakeUpdateDb({ existing: existing({ quantityAvailable: 3 }) }),
      authClient: fakeAuthClient(SELLER_ID),
    });

    const error = yield* updateTicketProgram(input).pipe(Effect.provide(layer), Effect.flip);

    expect(error).toMatchObject({ _tag: "TicketReserved", ticketId: TICKET_ID });
  }),
);

it.effect("fails with TicketStale when the version-matched write affects no rows", () =>
  Effect.gen(function* () {
    const layer = createTicketsTestLayer({
      db: fakeUpdateDb({ existing: existing(), updateRows: 0 }),
      authClient: fakeAuthClient(SELLER_ID),
    });

    const error = yield* updateTicketProgram(input).pipe(Effect.provide(layer), Effect.flip);

    expect(error).toMatchObject({ _tag: "TicketStale", ticketId: TICKET_ID });
  }),
);

it.effect("applies the edit, bumps the version, and returns the updated record", () =>
  Effect.gen(function* () {
    const layer = createTicketsTestLayer({
      db: fakeUpdateDb({ existing: existing(), updateRows: 1 }),
      authClient: fakeAuthClient(SELLER_ID),
    });

    const result = yield* updateTicketProgram(input).pipe(Effect.provide(layer));

    expect(result).toMatchObject({
      id: TICKET_ID,
      sellerId: SELLER_ID,
      title: "Renamed",
      unitPriceCents: 6000,
      version: 2,
    });
  }),
);

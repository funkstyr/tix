import { expect, it } from "@effect/vitest";
import { Effect, Metric } from "effect";

import { reservationConflictsTotal, ticketsReservedTotal } from "../runtime/metrics.ts";
import type { TicketsDb } from "../runtime/services.ts";
import { createTicketsTestLayer } from "../runtime/test-runtime.ts";
import { reserveTicketProgram } from "./router.ts";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";

type FakeRow = {
  id: string;
  quantityAvailable: number;
  unitPriceCents: number;
  version: number;
};

// A drizzle stand-in that replays a scripted sequence of reads/updates so the serial retry
// loop in `reserveTicketProgram` can be driven deterministically without a database. Each
// `select().from().where()` yields the next scripted row; each `updateVersioned` (which calls
// `update().set().where().returning()`) yields the next scripted `rowsAffected`.
function fakeReserveDb(reads: (FakeRow | undefined)[], updates: number[]): TicketsDb {
  let readIdx = 0;
  let updateIdx = 0;

  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          const row = reads[readIdx++];

          return Promise.resolve(row === undefined ? [] : [row]);
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => {
            const affected = updates[updateIdx++] ?? 0;

            return Promise.resolve(Array.from({ length: affected }, () => ({ id: TICKET_ID })));
          },
        }),
      }),
    }),
  };

  return { db } as unknown as TicketsDb;
}

const ticket = (overrides: Partial<FakeRow> = {}): FakeRow => ({
  id: TICKET_ID,
  quantityAvailable: 4,
  unitPriceCents: 5000,
  version: 1,
  ...overrides,
});

it.effect("decrements availability, bumps version, and counts the reservation", () =>
  Effect.gen(function* () {
    const layer = createTicketsTestLayer({ db: fakeReserveDb([ticket()], [1]) });

    const before = (yield* Metric.value(ticketsReservedTotal)).count;

    const result = yield* reserveTicketProgram({ ticketId: TICKET_ID, quantity: 2 }).pipe(
      Effect.provide(layer),
    );

    const after = (yield* Metric.value(ticketsReservedTotal)).count;

    expect(result).toEqual({
      ticketId: TICKET_ID,
      quantityAvailable: 2,
      unitPriceCents: 5000,
      version: 2,
    });
    expect(after - before).toBe(1);
  }),
);

it.effect("fails with TicketNotFound when the ticket does not exist", () =>
  Effect.gen(function* () {
    const layer = createTicketsTestLayer({ db: fakeReserveDb([undefined], []) });

    const error = yield* reserveTicketProgram({ ticketId: TICKET_ID, quantity: 1 }).pipe(
      Effect.provide(layer),
      Effect.flip,
    );

    expect(error).toMatchObject({ _tag: "TicketNotFound", ticketId: TICKET_ID });
  }),
);

it.effect("fails with SoldOut when fewer seats remain than requested", () =>
  Effect.gen(function* () {
    const layer = createTicketsTestLayer({
      db: fakeReserveDb([ticket({ quantityAvailable: 1 })], []),
    });

    const error = yield* reserveTicketProgram({ ticketId: TICKET_ID, quantity: 5 }).pipe(
      Effect.provide(layer),
      Effect.flip,
    );

    expect(error).toMatchObject({ _tag: "SoldOut", ticketId: TICKET_ID });
  }),
);

it.effect("counts a conflict and fails with ReservationConflict after the retry budget", () =>
  Effect.gen(function* () {
    // Both attempts read a fresh row but lose the versioned write (rowsAffected 0).
    const layer = createTicketsTestLayer({
      db: fakeReserveDb([ticket(), ticket()], [0, 0]),
    });

    const before = (yield* Metric.value(reservationConflictsTotal)).count;

    const error = yield* reserveTicketProgram({ ticketId: TICKET_ID, quantity: 2 }).pipe(
      Effect.provide(layer),
      Effect.flip,
    );

    const after = (yield* Metric.value(reservationConflictsTotal)).count;

    expect(error).toMatchObject({ _tag: "ReservationConflict", ticketId: TICKET_ID });
    expect(after - before).toBe(1);
  }),
);

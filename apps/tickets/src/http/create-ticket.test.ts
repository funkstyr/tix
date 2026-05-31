import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { AuthSessionClient } from "@tix/contracts/auth-client";

import { tickets } from "../domain/schema.ts";
import type { TicketsDb } from "../runtime/services.ts";
import { createTicketsTestLayer } from "../runtime/test-runtime.ts";
import { createTicketProgram } from "./create-ticket.ts";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const SELLER_ID = "seller-1";

type InsertedRow = {
  id: string;
  sellerId: string;
  title: string;
  quantityTotal: number;
  quantityAvailable: number;
  unitPriceCents: number;
  version: number;
  createdAt: Date;
};

// A transaction stand-in, discriminated by table: the ticket insert chains `.returning()`
// (yielding the scripted `insertRows`), while the outbox `enqueueEvent` insert is awaited
// directly. Branching on the table keeps each path a plain value — no thenable hacks.
function fakeCreateDb(insertRows: InsertedRow[]): TicketsDb {
  const tx = {
    insert: (table: unknown) =>
      table === tickets
        ? { values: () => ({ returning: () => Promise.resolve(insertRows) }) }
        : { values: () => Promise.resolve([]) },
  };

  const db = { transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(tx) };

  return { db } as unknown as TicketsDb;
}

function fakeAuthClient(userId: string): AuthSessionClient {
  return {
    getSession: () => Promise.resolve({ user: { id: userId } }),
  } as unknown as AuthSessionClient;
}

const inserted = (overrides: Partial<InsertedRow> = {}): InsertedRow => ({
  id: TICKET_ID,
  sellerId: SELLER_ID,
  title: "Front row",
  quantityTotal: 2,
  quantityAvailable: 2,
  unitPriceCents: 8000,
  version: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const input = {
  token: "tok",
  title: "Front row",
  quantityTotal: 2,
  unitPriceCents: 8000,
};

it.effect("inserts the ticket and returns the created record", () =>
  Effect.gen(function* () {
    const layer = createTicketsTestLayer({
      db: fakeCreateDb([inserted()]),
      authClient: fakeAuthClient(SELLER_ID),
    });

    const result = yield* createTicketProgram(input).pipe(Effect.provide(layer));

    expect(result).toEqual({
      id: TICKET_ID,
      sellerId: SELLER_ID,
      title: "Front row",
      quantityTotal: 2,
      quantityAvailable: 2,
      unitPriceCents: 8000,
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  }),
);

it.effect("fails with INTERNAL_SERVER_ERROR when the insert returns no row", () =>
  Effect.gen(function* () {
    const layer = createTicketsTestLayer({
      db: fakeCreateDb([]),
      authClient: fakeAuthClient(SELLER_ID),
    });

    const error = yield* createTicketProgram(input).pipe(Effect.provide(layer), Effect.flip);

    expect(error).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  }),
);

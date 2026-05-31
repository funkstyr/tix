import type { Context as OtelContext } from "@opentelemetry/api";
import { ORPCError, os } from "@orpc/server";
import { desc, eq } from "drizzle-orm";
import { Clock, Effect, Metric } from "effect";
import { v7 as uuidv7 } from "uuid";

import { requireSession } from "@tix/contracts/auth-client";
import { TICKETS_CREATED_V1, TICKETS_UPDATED_V1 } from "@tix/contracts/subjects";
import {
  type TicketRecord,
  ticketCreateInput,
  ticketGetByIdInput,
  ticketRecordOrNullOutput,
  ticketRecordOutput,
  ticketsListInput,
  ticketsListMineInput,
  ticketsListOutput,
  ticketUpdateInput,
} from "@tix/contracts/tickets";
import { reserveTicketInput, reserveTicketOutput } from "@tix/contracts/tickets-reserve";
import { updateVersioned } from "@tix/db-core/optimistic-version";
import { enqueueEvent } from "@tix/db-core/outbox";
import { externalParent } from "@tix/observability/otel-trace";

import {
  ReservationConflict,
  SoldOut,
  TicketNotFound,
  TicketReserved,
  TicketStale,
} from "../domain/errors.ts";
import { tickets, ticketsOutbox } from "../domain/schema.ts";
import { reservationConflictsTotal, ticketsReservedTotal } from "../runtime/metrics.ts";
import type { TicketsRuntime } from "../runtime/runtime.ts";
import { AuthClient, Database, TicketsConfig } from "../runtime/services.ts";
import { makeRunHandler, tryOrpc } from "./boundary.ts";

const DEFAULT_LIST_LIMIT = 50;
const MAX_RESERVE_ATTEMPTS = 2;

type TicketRow = typeof tickets.$inferSelect;

function toTicketRecord(row: TicketRow): TicketRecord {
  return {
    id: row.id,
    sellerId: row.sellerId,
    title: row.title,
    quantityTotal: row.quantityTotal,
    quantityAvailable: row.quantityAvailable,
    unitPriceCents: row.unitPriceCents,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}

// Threaded from the Hono boundary (app.ts): the inbound request's trace context (so each
// handler's span continues the caller's trace) and the optional service token (reserve is
// service-to-service, authorized by the shared token rather than a user session).
export type TicketsRequestContext = { otelParent: OtelContext; serviceToken?: string };

type ReserveOutcome =
  | { kind: "ok"; quantityAvailable: number; unitPriceCents: number; version: number }
  | { kind: "not_found" }
  | { kind: "sold_out" }
  | { kind: "conflict" };

// Exported as a standalone program (against the service `R` channel) so tests can run it
// under an ambient `TestClock`/test Layer — the router wraps it with `run`, which executes
// it on the live runtime. The serial optimistic-version retry (ADR-0005, ADR-0007) stays
// inside a single non-Effect island; outcomes become tagged failures / metrics in Effect.
export function reserveTicketProgram(input: typeof reserveTicketInput.infer) {
  return Effect.gen(function* () {
    const db = yield* Database;

    const outcome = yield* tryOrpc(async (): Promise<ReserveOutcome> => {
      // Serial retry by design: each attempt depends on the previous attempt's version
      // having lost the race. Parallelizing the reads/updates would defeat the
      // optimistic-version check.
      for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt++) {
        // eslint-disable-next-line no-await-in-loop -- serial retry by design
        const [row] = await db.db.select().from(tickets).where(eq(tickets.id, input.ticketId));
        if (!row) return { kind: "not_found" };

        if (row.quantityAvailable < input.quantity) return { kind: "sold_out" };

        // eslint-disable-next-line no-await-in-loop -- serial retry by design
        const result = await updateVersioned(
          db.db,
          tickets,
          { id: row.id, version: row.version },
          { quantityAvailable: row.quantityAvailable - input.quantity },
        );

        if (result.rowsAffected === 1) {
          return {
            kind: "ok",
            quantityAvailable: row.quantityAvailable - input.quantity,
            unitPriceCents: row.unitPriceCents,
            version: row.version + 1,
          };
        }
      }

      return { kind: "conflict" };
    }).pipe(Effect.withSpan("tickets.db.reserve"));

    switch (outcome.kind) {
      case "not_found":
        return yield* Effect.fail(new TicketNotFound({ ticketId: input.ticketId }));

      case "sold_out":
        return yield* Effect.fail(new SoldOut({ ticketId: input.ticketId }));

      case "conflict":
        return yield* Metric.increment(reservationConflictsTotal).pipe(
          Effect.zipRight(Effect.fail(new ReservationConflict({ ticketId: input.ticketId }))),
        );

      case "ok":
        yield* Metric.increment(ticketsReservedTotal);

        return {
          ticketId: input.ticketId,
          quantityAvailable: outcome.quantityAvailable,
          unitPriceCents: outcome.unitPriceCents,
          version: outcome.version,
        };
    }
  });
}

function createTicketProgram(input: typeof ticketCreateInput.infer) {
  return Effect.gen(function* () {
    const authClient = yield* AuthClient;
    const db = yield* Database;

    const session = yield* tryOrpc(() => requireSession(authClient, input.token));

    const row = yield* tryOrpc(() =>
      db.db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(tickets)
          .values({
            sellerId: session.user.id,
            title: input.title,
            quantityTotal: input.quantityTotal,
            quantityAvailable: input.quantityTotal,
            unitPriceCents: input.unitPriceCents,
          })
          .returning();

        // drizzle types .returning() as T[]; insert of one row produces one row.
        if (!inserted) {
          throw new ORPCError("INTERNAL_SERVER_ERROR", {
            message: "ticket insert returned no row",
          });
        }

        await enqueueEvent(tx, ticketsOutbox, {
          subject: TICKETS_CREATED_V1,
          // uuidv7 is time-ordered, so the relay's `ORDER BY created_at` is a stable
          // insert-order sort.
          eventId: uuidv7(),
          payload: {
            ticketId: inserted.id,
            sellerId: inserted.sellerId,
            title: inserted.title,
            quantityTotal: inserted.quantityTotal,
            unitPriceCents: inserted.unitPriceCents,
            createdAt: inserted.createdAt.toISOString(),
          },
        });

        return inserted;
      }),
    ).pipe(Effect.withSpan("tickets.db.create_ticket"));

    return toTicketRecord(row);
  });
}

type UpdateOutcome =
  | { kind: "ok"; row: TicketRow }
  | { kind: "not_found" }
  | { kind: "reserved" }
  | { kind: "stale" };

function updateTicketProgram(input: typeof ticketUpdateInput.infer) {
  return Effect.gen(function* () {
    const authClient = yield* AuthClient;
    const db = yield* Database;

    const session = yield* tryOrpc(() => requireSession(authClient, input.token));

    const nowMs = yield* Clock.currentTimeMillis;
    const updatedAt = new Date(nowMs).toISOString();

    const outcome = yield* tryOrpc(() =>
      db.db.transaction(async (tx): Promise<UpdateOutcome> => {
        const [existing] = await tx.select().from(tickets).where(eq(tickets.id, input.ticketId));

        // Treat missing and non-owned identically so a seller can't probe another seller's
        // inventory by guessing ticket ids (matches the existence-isn't-a-side-channel rule
        // in orders.getById).
        if (!existing || existing.sellerId !== session.user.id) {
          return { kind: "not_found" };
        }

        // A ticket with seats held or sold (available < total) is locked by an order;
        // editing its price/title underneath a buyer is disallowed.
        if (existing.quantityAvailable !== existing.quantityTotal) {
          return { kind: "reserved" };
        }

        const nextVersion = existing.version + 1;
        const updated = await updateVersioned(
          tx,
          tickets,
          { id: existing.id, version: input.expectedVersion },
          { title: input.title, unitPriceCents: input.unitPriceCents },
        );
        if (updated.rowsAffected === 0) {
          // The version-matched update affected no rows: either the client's expectedVersion
          // was already stale, or a concurrent reserve/release bumped the version between our
          // read and write. Both are retryable version conflicts.
          return { kind: "stale" };
        }

        await enqueueEvent(tx, ticketsOutbox, {
          subject: TICKETS_UPDATED_V1,
          eventId: uuidv7(),
          payload: {
            ticketId: existing.id,
            sellerId: existing.sellerId,
            title: input.title,
            unitPriceCents: input.unitPriceCents,
            version: nextVersion,
            updatedAt,
          },
        });

        return {
          kind: "ok",
          row: {
            ...existing,
            title: input.title,
            unitPriceCents: input.unitPriceCents,
            version: nextVersion,
          },
        };
      }),
    ).pipe(Effect.withSpan("tickets.db.update_ticket"));

    switch (outcome.kind) {
      case "not_found":
        return yield* Effect.fail(new TicketNotFound({ ticketId: input.ticketId }));

      case "reserved":
        return yield* Effect.fail(new TicketReserved({ ticketId: input.ticketId }));

      case "stale":
        return yield* Effect.fail(new TicketStale({ ticketId: input.ticketId }));

      case "ok":
        return toTicketRecord(outcome.row);
    }
  });
}

// One span per oRPC request, parented onto the inbound trace context when present (otherwise
// a fresh root). Internal db spans hang off this one, and the active span here is what
// `enqueueEvent`/outbound clients capture for propagation.
function withRequestSpan<A, E, R>(
  op: string,
  context: TicketsRequestContext,
  program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return program.pipe(
    Effect.withSpan(`tickets.rpc.${op}`, { parent: externalParent(context.otelParent) }),
  );
}

export function createTicketsRouter(runtime: TicketsRuntime) {
  const run = makeRunHandler(runtime);

  const base = os.$context<TicketsRequestContext>();

  const create = base
    .input(ticketCreateInput)
    .output(ticketRecordOutput)
    .handler(({ input, context }) =>
      run(withRequestSpan("create", context, createTicketProgram(input))),
    );

  const update = base
    .input(ticketUpdateInput)
    .output(ticketRecordOutput)
    .handler(({ input, context }) =>
      run(withRequestSpan("update", context, updateTicketProgram(input))),
    );

  const reserve = base
    .input(reserveTicketInput)
    .output(reserveTicketOutput)
    .handler(({ input, context }) =>
      run(
        withRequestSpan(
          "reserve",
          context,
          Effect.gen(function* () {
            const env = yield* TicketsConfig;
            if (context.serviceToken !== env.serviceToken) {
              return yield* Effect.fail(
                new ORPCError("UNAUTHORIZED", { message: "missing or invalid service token" }),
              );
            }

            return yield* reserveTicketProgram(input);
          }),
        ),
      ),
    );

  const getById = base
    .input(ticketGetByIdInput)
    .output(ticketRecordOrNullOutput)
    .handler(({ input, context }) =>
      run(
        withRequestSpan(
          "get_by_id",
          context,
          Effect.gen(function* () {
            const db = yield* Database;

            const [row] = yield* tryOrpc(() =>
              db.db.select().from(tickets).where(eq(tickets.id, input.ticketId)),
            );
            if (!row) return null;

            return toTicketRecord(row);
          }),
        ),
      ),
    );

  const list = base
    .input(ticketsListInput)
    .output(ticketsListOutput)
    .handler(({ input, context }) =>
      run(
        withRequestSpan(
          "list",
          context,
          Effect.gen(function* () {
            const db = yield* Database;

            const limit = input.limit ?? DEFAULT_LIST_LIMIT;

            // Secondary `desc(id)` is the tie-break when two rows share a millisecond on
            // createdAt — uuidv7 is monotonic per source, so id-desc preserves insert order
            // without depending on clock resolution.
            const rows = yield* tryOrpc(() =>
              db.db
                .select()
                .from(tickets)
                .orderBy(desc(tickets.createdAt), desc(tickets.id))
                .limit(limit),
            );

            return { items: rows.map(toTicketRecord) };
          }),
        ),
      ),
    );

  const listMine = base
    .input(ticketsListMineInput)
    .output(ticketsListOutput)
    .handler(({ input, context }) =>
      run(
        withRequestSpan(
          "list_mine",
          context,
          Effect.gen(function* () {
            const authClient = yield* AuthClient;
            const db = yield* Database;

            const session = yield* tryOrpc(() => requireSession(authClient, input.token));

            const limit = input.limit ?? DEFAULT_LIST_LIMIT;

            const rows = yield* tryOrpc(() =>
              db.db
                .select()
                .from(tickets)
                .where(eq(tickets.sellerId, session.user.id))
                .orderBy(desc(tickets.createdAt), desc(tickets.id))
                .limit(limit),
            );

            return { items: rows.map(toTicketRecord) };
          }),
        ),
      ),
    );

  return { create, update, reserve, getById, list, listMine };
}

export type TicketsRouter = ReturnType<typeof createTicketsRouter>;

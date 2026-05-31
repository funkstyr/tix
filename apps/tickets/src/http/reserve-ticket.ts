import { eq } from "drizzle-orm";
import { Effect, Metric } from "effect";

import { reserveTicketInput } from "@tix/contracts/tickets-reserve";
import { updateVersioned } from "@tix/db-core/optimistic-version";

import { ReservationConflict, SoldOut, TicketNotFound } from "../domain/errors.ts";
import { tickets } from "../domain/schema.ts";
import { reservationConflictsTotal, ticketsReservedTotal } from "../runtime/metrics.ts";
import { Database } from "../runtime/services.ts";
import { tryOrpc } from "./boundary.ts";

const MAX_RESERVE_ATTEMPTS = 2;

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

import { eq } from "drizzle-orm";
import { Clock, Effect } from "effect";
import { v7 as uuidv7 } from "uuid";

import { requireSession } from "@tix/contracts/auth-client";
import { TICKETS_UPDATED_V1 } from "@tix/contracts/subjects";
import { ticketUpdateInput } from "@tix/contracts/tickets";
import { updateVersioned } from "@tix/db-core/optimistic-version";
import { enqueueEvent } from "@tix/db-core/outbox";

import { TicketNotFound, TicketReserved, TicketStale } from "../domain/errors.ts";
import { tickets, ticketsOutbox } from "../domain/schema.ts";
import { AuthClient, Database } from "../runtime/services.ts";
import { tryOrpc } from "./boundary.ts";
import { toTicketRecord, type TicketRow } from "./ticket-record.ts";

type UpdateOutcome =
  | { kind: "ok"; row: TicketRow }
  | { kind: "not_found" }
  | { kind: "reserved" }
  | { kind: "stale" };

export function updateTicketProgram(input: typeof ticketUpdateInput.infer) {
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

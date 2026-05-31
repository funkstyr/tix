import { ORPCError } from "@orpc/server";
import { Effect } from "effect";
import { v7 as uuidv7 } from "uuid";

import { requireSession } from "@tix/contracts/auth-client";
import { TICKETS_CREATED_V1 } from "@tix/contracts/subjects";
import { ticketCreateInput } from "@tix/contracts/tickets";
import { enqueueEvent } from "@tix/db-core/outbox";

import { tickets, ticketsOutbox } from "../domain/schema.ts";
import { AuthClient, Database } from "../runtime/services.ts";
import { tryOrpc } from "./boundary.ts";
import { toTicketRecord } from "./ticket-record.ts";

export function createTicketProgram(input: typeof ticketCreateInput.infer) {
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

import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";

import type { DbClient } from "@tix/db-core/client";
import { updateVersioned } from "@tix/db-core/optimistic-version";

import { tickets, type ticketsTables } from "./tickets-schema.ts";

const MAX_ATTEMPTS = 2;

export type ReserveTicketInput = {
  ticketId: string;
  quantity: number;
};

export type ReserveTicketResult = {
  ticketId: string;
  quantityAvailable: number;
  unitPriceCents: number;
  version: number;
};

export async function reserveTicket(
  db: DbClient<typeof ticketsTables>,
  input: ReserveTicketInput,
): Promise<ReserveTicketResult> {
  // Serial retry by design: each attempt depends on the previous attempt's version
  // having lost the race. Parallelizing the reads/updates would defeat the
  // optimistic-version check (ADR-0005, ADR-0007).
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- serial retry by design
    const [row] = await db.db.select().from(tickets).where(eq(tickets.id, input.ticketId));
    if (!row) {
      throw new ORPCError("NOT_FOUND", { message: "ticket not found" });
    }

    if (row.quantityAvailable < input.quantity) {
      throw new ORPCError("CONFLICT", {
        message: "ticket is sold out",
        data: { reason: "sold_out" as const },
      });
    }

    // eslint-disable-next-line no-await-in-loop -- serial retry by design
    const result = await updateVersioned(
      db.db,
      tickets,
      { id: row.id, version: row.version },
      { quantityAvailable: row.quantityAvailable - input.quantity },
    );

    if (result.rowsAffected === 1) {
      return {
        ticketId: row.id,
        quantityAvailable: row.quantityAvailable - input.quantity,
        unitPriceCents: row.unitPriceCents,
        version: row.version + 1,
      };
    }
  }

  // Two reads + updates both lost the version race. Surface as retryable conflict.
  throw new ORPCError("CONFLICT", {
    message: "reservation conflict after retry",
    data: { reason: "version_conflict" as const },
  });
}

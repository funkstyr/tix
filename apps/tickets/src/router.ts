import { ORPCError, os } from "@orpc/server";
import { desc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import { type AuthSessionClient, requireSession } from "@tix/contracts/auth-client";
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
import type { DbClient } from "@tix/db-core/client";
import { updateVersioned } from "@tix/db-core/optimistic-version";
import { enqueueEvent } from "@tix/db-core/outbox";

import { reserveTicket } from "./reserve-ticket.ts";
import { tickets, ticketsOutbox, type ticketsTables } from "./tickets-schema.ts";

const DEFAULT_LIST_LIMIT = 50;

function toTicketRecord(row: typeof tickets.$inferSelect): TicketRecord {
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

export type TicketsRouterContext = {
  serviceToken?: string;
};

export type TicketsRouterDeps = {
  db: DbClient<typeof ticketsTables>;
  authClient: AuthSessionClient;
  serviceToken: string;
};

export function createTicketsRouter(deps: TicketsRouterDeps) {
  const { db, authClient, serviceToken: expectedServiceToken } = deps;

  const base = os.$context<TicketsRouterContext>();

  const create = base
    .input(ticketCreateInput)
    .output(ticketRecordOutput)
    .handler(async ({ input }) => {
      const session = await requireSession(authClient, input.token);

      const row = await db.db.transaction(async (tx) => {
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
          // uuidv7 is time-ordered, so the relay's `ORDER BY created_at` is a stable insert-order sort.
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
      });

      return toTicketRecord(row);
    });

  const update = base
    .input(ticketUpdateInput)
    .output(ticketRecordOutput)
    .handler(async ({ input }) => {
      const session = await requireSession(authClient, input.token);

      const row = await db.db.transaction(async (tx) => {
        const [existing] = await tx.select().from(tickets).where(eq(tickets.id, input.ticketId));

        // Treat missing and non-owned identically so a seller can't probe
        // another seller's inventory by guessing ticket ids (matches the
        // existence-isn't-a-side-channel rule in orders.getById).
        if (!existing || existing.sellerId !== session.user.id) {
          throw new ORPCError("NOT_FOUND", { message: "ticket not found" });
        }

        // A ticket with seats held or sold (available < total) is locked by an
        // order; editing its price/title underneath a buyer is disallowed.
        if (existing.quantityAvailable !== existing.quantityTotal) {
          throw new ORPCError("CONFLICT", {
            message: "cannot edit a reserved ticket",
            data: { reason: "reserved" as const },
          });
        }

        if (existing.version !== input.expectedVersion) {
          throw new ORPCError("CONFLICT", {
            message: "ticket was modified by someone else",
            data: { reason: "version_conflict" as const },
          });
        }

        const nextVersion = existing.version + 1;
        const updated = await updateVersioned(
          tx,
          tickets,
          { id: existing.id, version: input.expectedVersion },
          { title: input.title, unitPriceCents: input.unitPriceCents },
        );
        if (updated.rowsAffected === 0) {
          // A concurrent reserve/release bumped the version between our read and
          // write — surface as a retryable conflict rather than a silent no-op.
          throw new ORPCError("CONFLICT", {
            message: "ticket was modified by someone else",
            data: { reason: "version_conflict" as const },
          });
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
            updatedAt: new Date().toISOString(),
          },
        });

        return {
          ...existing,
          title: input.title,
          unitPriceCents: input.unitPriceCents,
          version: nextVersion,
        };
      });

      return toTicketRecord(row);
    });

  const reserve = base
    .input(reserveTicketInput)
    .output(reserveTicketOutput)
    .handler(async ({ input, context }) => {
      if (context.serviceToken !== expectedServiceToken) {
        throw new ORPCError("UNAUTHORIZED", { message: "missing or invalid service token" });
      }

      return await reserveTicket(db, input);
    });

  const getById = base
    .input(ticketGetByIdInput)
    .output(ticketRecordOrNullOutput)
    .handler(async ({ input }) => {
      const [row] = await db.db.select().from(tickets).where(eq(tickets.id, input.ticketId));
      if (!row) return null;

      return toTicketRecord(row);
    });

  const list = base
    .input(ticketsListInput)
    .output(ticketsListOutput)
    .handler(async ({ input }) => {
      const limit = input.limit ?? DEFAULT_LIST_LIMIT;

      // Secondary `desc(id)` is the tie-break when two rows share a millisecond
      // on createdAt — uuidv7 is monotonic per source, so id-desc preserves
      // insert order without depending on clock resolution.
      const rows = await db.db
        .select()
        .from(tickets)
        .orderBy(desc(tickets.createdAt), desc(tickets.id))
        .limit(limit);

      return { items: rows.map(toTicketRecord) };
    });

  const listMine = base
    .input(ticketsListMineInput)
    .output(ticketsListOutput)
    .handler(async ({ input }) => {
      const session = await requireSession(authClient, input.token);

      const limit = input.limit ?? DEFAULT_LIST_LIMIT;

      const rows = await db.db
        .select()
        .from(tickets)
        .where(eq(tickets.sellerId, session.user.id))
        .orderBy(desc(tickets.createdAt), desc(tickets.id))
        .limit(limit);

      return { items: rows.map(toTicketRecord) };
    });

  return { create, update, reserve, getById, list, listMine };
}

export type TicketsRouter = ReturnType<typeof createTicketsRouter>;

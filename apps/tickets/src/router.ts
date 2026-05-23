import { ORPCError, os } from "@orpc/server";
import { desc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import { type AuthSessionClient, requireSession } from "@tix/contracts/auth-client";
import { TICKETS_CREATED_V1 } from "@tix/contracts/subjects";
import {
  ticketCreateInput,
  ticketGetByIdInput,
  ticketRecordOrNullOutput,
  ticketRecordOutput,
  ticketsListInput,
  ticketsListMineInput,
  ticketsListOutput,
} from "@tix/contracts/tickets";
import { reserveTicketInput, reserveTicketOutput } from "@tix/contracts/tickets-reserve";
import type { DbClient } from "@tix/db-core/client";
import { enqueueEvent } from "@tix/db-core/outbox";

import { reserveTicket } from "./reserve-ticket.ts";
import { tickets, ticketsOutbox, type ticketsTables } from "./tickets-schema.ts";

const DEFAULT_LIST_LIMIT = 50;

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

      return {
        items: rows.map((row) => ({
          id: row.id,
          sellerId: row.sellerId,
          title: row.title,
          quantityTotal: row.quantityTotal,
          quantityAvailable: row.quantityAvailable,
          unitPriceCents: row.unitPriceCents,
          version: row.version,
          createdAt: row.createdAt.toISOString(),
        })),
      };
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

      return {
        items: rows.map((row) => ({
          id: row.id,
          sellerId: row.sellerId,
          title: row.title,
          quantityTotal: row.quantityTotal,
          quantityAvailable: row.quantityAvailable,
          unitPriceCents: row.unitPriceCents,
          version: row.version,
          createdAt: row.createdAt.toISOString(),
        })),
      };
    });

  return { create, reserve, getById, list, listMine };
}

export type TicketsRouter = ReturnType<typeof createTicketsRouter>;

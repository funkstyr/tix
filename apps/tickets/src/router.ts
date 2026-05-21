import { ORPCError, os } from "@orpc/server";
import { type } from "arktype";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import { TICKETS_CREATED_V1 } from "@tix/contracts/subjects";
import type { DbClient } from "@tix/db-core/client";
import { enqueueEvent } from "@tix/db-core/outbox";

import type { AuthSession, AuthSessionClient } from "./auth-session-client.ts";
import { tickets, ticketsOutbox, type ticketsTables } from "./tickets-schema.ts";

const tokenInput = type({
  token: "string >= 1",
});

const createInput = tokenInput.and({
  title: "string >= 1",
  quantityTotal: "number.integer >= 1",
  unitPriceCents: "number.integer >= 0",
});

const getByIdInput = type({
  ticketId: "string.uuid",
});

const ticketOutput = type({
  id: "string.uuid",
  sellerId: "string",
  title: "string",
  quantityTotal: "number.integer",
  quantityAvailable: "number.integer",
  unitPriceCents: "number.integer",
  version: "number.integer",
  createdAt: "string.date.iso",
});

const ticketOrNullOutput = ticketOutput.or("null");

export type TicketsRouterDeps = {
  db: DbClient<typeof ticketsTables>;
  authClient: AuthSessionClient;
};

async function requireSession(authClient: AuthSessionClient, token: string): Promise<AuthSession> {
  const session = await authClient.getSession({ token });
  if (session === null) {
    throw new ORPCError("UNAUTHORIZED", { message: "invalid or expired session" });
  }

  return session;
}

export function createTicketsRouter(deps: TicketsRouterDeps) {
  const { db, authClient } = deps;

  const create = os
    .input(createInput)
    .output(ticketOutput)
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

  const getById = os
    .input(getByIdInput)
    .output(ticketOrNullOutput)
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

  return { create, getById };
}

export type TicketsRouter = ReturnType<typeof createTicketsRouter>;

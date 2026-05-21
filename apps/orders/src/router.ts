import { ORPCError, os } from "@orpc/server";
import { type } from "arktype";
import { eq } from "drizzle-orm";

import type { DbClient } from "@tix/db-core/client";

import type { AuthSession, AuthSessionClient } from "./auth-session-client.ts";
import { orders, type ordersTables } from "./orders-schema.ts";
import type { TicketsClient } from "./tickets-client.ts";

const RESERVATION_TTL_MS = 15 * 60 * 1000;

const tokenInput = type({
  token: "string >= 1",
});

const createInput = tokenInput.and({
  ticketId: "string.uuid",
  quantity: "number.integer >= 1",
});

const getByIdInput = type({
  orderId: "string.uuid",
});

const orderOutput = type({
  id: "string.uuid",
  buyerId: "string",
  ticketId: "string.uuid",
  quantity: "number.integer",
  status: "string",
  expiresAt: "string.date.iso",
  version: "number.integer",
  createdAt: "string.date.iso",
});

const orderOrNullOutput = orderOutput.or("null");

export type OrdersRouterDeps = {
  db: DbClient<typeof ordersTables>;
  authClient: AuthSessionClient;
  ticketsClient: TicketsClient;
  now?: () => Date;
};

async function requireSession(authClient: AuthSessionClient, token: string): Promise<AuthSession> {
  const session = await authClient.getSession({ token });
  if (session === null) {
    throw new ORPCError("UNAUTHORIZED", { message: "invalid or expired session" });
  }

  return session;
}

export function createOrdersRouter(deps: OrdersRouterDeps) {
  const { db, authClient, ticketsClient, now = () => new Date() } = deps;

  const base = os;

  const create = base
    .input(createInput)
    .output(orderOutput)
    .handler(async ({ input }) => {
      const session = await requireSession(authClient, input.token);

      const ticket = await ticketsClient.getById({ ticketId: input.ticketId });
      if (!ticket) {
        throw new ORPCError("NOT_FOUND", { message: "ticket not found" });
      }
      if (ticket.sellerId === session.user.id) {
        throw new ORPCError("FORBIDDEN", {
          message: "buyer cannot purchase their own ticket",
        });
      }
      if (ticket.quantityAvailable < input.quantity) {
        throw new ORPCError("GONE", {
          status: 410,
          message: "ticket is sold out",
          data: { reason: "sold_out" as const },
        });
      }

      try {
        await ticketsClient.reserve({ ticketId: input.ticketId, quantity: input.quantity });
      } catch (err: unknown) {
        if (err instanceof ORPCError && err.code === "CONFLICT") {
          // Lost the race: between getById and reserve, another buyer claimed the seats.
          throw new ORPCError("CONFLICT", {
            status: 409,
            message: "reservation conflict",
            data: { reason: "race_lost" as const },
          });
        }
        if (err instanceof ORPCError && err.code === "NOT_FOUND") {
          throw new ORPCError("NOT_FOUND", { message: "ticket not found" });
        }
        throw err;
      }

      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + RESERVATION_TTL_MS);

      const [row] = await db.db
        .insert(orders)
        .values({
          buyerId: session.user.id,
          ticketId: input.ticketId,
          quantity: input.quantity,
          status: "created",
          expiresAt,
          createdAt,
        })
        .returning();

      if (!row) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: "order insert returned no row",
        });
      }

      return {
        id: row.id,
        buyerId: row.buyerId,
        ticketId: row.ticketId,
        quantity: row.quantity,
        status: row.status,
        expiresAt: row.expiresAt.toISOString(),
        version: row.version,
        createdAt: row.createdAt.toISOString(),
      };
    });

  const getById = base
    .input(getByIdInput)
    .output(orderOrNullOutput)
    .handler(async ({ input }) => {
      const [row] = await db.db.select().from(orders).where(eq(orders.id, input.orderId));
      if (!row) return null;

      return {
        id: row.id,
        buyerId: row.buyerId,
        ticketId: row.ticketId,
        quantity: row.quantity,
        status: row.status,
        expiresAt: row.expiresAt.toISOString(),
        version: row.version,
        createdAt: row.createdAt.toISOString(),
      };
    });

  return { create, getById };
}

export type OrdersRouter = ReturnType<typeof createOrdersRouter>;

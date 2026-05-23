import { ORPCError, os } from "@orpc/server";
import { desc, eq } from "drizzle-orm";
import type { Logger } from "pino";
import { pino } from "pino";
import { v7 as uuidv7 } from "uuid";

import { type AuthSessionClient, requireSession } from "@tix/contracts/auth-client";
import {
  orderCreateInput,
  orderGetByIdInput,
  orderRecordOrNullOutput,
  orderRecordOutput,
  ordersListInput,
  ordersListOutput,
} from "@tix/contracts/orders";
import { ORDER_CREATED_V1, ORDER_RESERVATION_RELEASED_V1 } from "@tix/contracts/subjects";
import type { ReserveTicketOutput } from "@tix/contracts/tickets-reserve";
import type { DbClient } from "@tix/db-core/client";
import { enqueueEvent } from "@tix/db-core/outbox";

import { orders, ordersOutbox, type ordersTables } from "./orders-schema.ts";
import type { TicketsClient } from "./tickets-client.ts";

const fallbackLogger: Logger = pino({ level: "warn" });

const DEFAULT_LIST_LIMIT = 50;

export type OrdersRouterDeps = {
  db: DbClient<typeof ordersTables>;
  authClient: AuthSessionClient;
  ticketsClient: TicketsClient;
  reservationTtlMs: number;
  logger?: Logger;
};

export function createOrdersRouter(deps: OrdersRouterDeps) {
  const { db, authClient, ticketsClient, reservationTtlMs, logger = fallbackLogger } = deps;

  const base = os;

  const create = base
    .input(orderCreateInput)
    .output(orderRecordOutput)
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

      let reserveResult: ReserveTicketOutput;
      try {
        reserveResult = await ticketsClient.reserve({
          ticketId: input.ticketId,
          quantity: input.quantity,
        });
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

      const priceCents = reserveResult.unitPriceCents * input.quantity;

      // Reserve succeeded — from here, any failure must compensate via order.reservation_released.v1.
      const orderId = uuidv7();
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + reservationTtlMs);

      try {
        const row = await db.db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(orders)
            .values({
              id: orderId,
              buyerId: session.user.id,
              ticketId: input.ticketId,
              quantity: input.quantity,
              priceCents,
              status: "created",
              expiresAt,
              createdAt,
            })
            .returning();

          if (!inserted) {
            throw new ORPCError("INTERNAL_SERVER_ERROR", {
              message: "order insert returned no row",
            });
          }

          await enqueueEvent(tx, ordersOutbox, {
            subject: ORDER_CREATED_V1,
            eventId: uuidv7(),
            payload: {
              orderId: inserted.id,
              ticketId: inserted.ticketId,
              buyerId: inserted.buyerId,
              quantity: inserted.quantity,
              priceCents,
              expiresAt: inserted.expiresAt.toISOString(),
              createdAt: inserted.createdAt.toISOString(),
            },
          });

          return inserted;
        });

        return toOrderRecord(row);
      } catch (err: unknown) {
        await compensateReserve(db, logger, {
          orderId,
          ticketId: input.ticketId,
          quantity: input.quantity,
        });

        throw err;
      }
    });

  const getById = base
    .input(orderGetByIdInput)
    .output(orderRecordOrNullOutput)
    .handler(async ({ input }) => {
      const session = await requireSession(authClient, input.token);

      const [row] = await db.db.select().from(orders).where(eq(orders.id, input.orderId));
      if (!row) return null;

      // Treat non-ownership identically to "not found" so existence isn't a side channel.
      if (row.buyerId !== session.user.id) return null;

      return toOrderRecord(row);
    });

  const list = base
    .input(ordersListInput)
    .output(ordersListOutput)
    .handler(async ({ input }) => {
      const session = await requireSession(authClient, input.token);

      const limit = input.limit ?? DEFAULT_LIST_LIMIT;

      // desc(id) is the tie-break when two rows share a millisecond on
      // createdAt — uuidv7 is monotonic per source, so id-desc preserves
      // insert order without depending on clock resolution.
      const rows = await db.db
        .select()
        .from(orders)
        .where(eq(orders.buyerId, session.user.id))
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(limit);

      return { items: rows.map(toOrderRecord) };
    });

  return { create, getById, list };
}

type OrderRow = typeof orders.$inferSelect;

function toOrderRecord(row: OrderRow) {
  return {
    id: row.id,
    buyerId: row.buyerId,
    ticketId: row.ticketId,
    quantity: row.quantity,
    priceCents: row.priceCents,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}

export type OrdersRouter = ReturnType<typeof createOrdersRouter>;

type CompensateReserveArgs = {
  orderId: string;
  ticketId: string;
  quantity: number;
};

async function compensateReserve(
  db: DbClient<typeof ordersTables>,
  logger: Logger,
  args: CompensateReserveArgs,
): Promise<void> {
  try {
    await enqueueEvent(db.db, ordersOutbox, {
      subject: ORDER_RESERVATION_RELEASED_V1,
      eventId: uuidv7(),
      payload: {
        orderId: args.orderId,
        ticketId: args.ticketId,
        quantity: args.quantity,
        releasedAt: new Date().toISOString(),
      },
    });
  } catch (releaseErr) {
    // Inventory is now stuck reserved against an unborn Order. Operator must reconcile manually.
    logger.error(
      {
        err: releaseErr,
        ticketId: args.ticketId,
        quantity: args.quantity,
        orphanOrderId: args.orderId,
      },
      "failed to enqueue order.reservation_released.v1 after order insert failure",
    );
  }
}

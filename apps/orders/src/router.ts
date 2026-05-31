import { ORPCError, os } from "@orpc/server";
import { Clock, Effect } from "effect";
import { desc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import { requireSession } from "@tix/contracts/auth-client";
import {
  orderCancelInput,
  orderCancelOutput,
  orderCreateInput,
  orderGetByIdInput,
  orderRecordOrNullOutput,
  orderRecordOutput,
  ordersListInput,
  ordersListOutput,
} from "@tix/contracts/orders";
import {
  ORDER_CANCELLED_V1,
  ORDER_CREATED_V1,
  ORDER_RESERVATION_RELEASED_V1,
} from "@tix/contracts/subjects";
import { updateVersioned } from "@tix/db-core/optimistic-version";
import { enqueueEvent } from "@tix/db-core/outbox";

import { makeRunHandler, tryOrpc } from "./boundary.ts";
import {
  BuyerIsSeller,
  OrderNotFound,
  ReservationConflict,
  SoldOut,
  TicketNotFound,
} from "./errors.ts";
import { orders, ordersOutbox } from "./orders-schema.ts";
import type { OrdersRuntime } from "./runtime.ts";
import { AuthClient, Database, type OrdersDb, OrdersConfig, Tickets } from "./services.ts";
import { transition } from "./state-machine.ts";

const DEFAULT_LIST_LIMIT = 50;

// Exported as a standalone program (against the service `R` channel) so tests can
// run it under an ambient `TestClock` — the router just wraps it with `run`, which
// executes it on the live runtime.
export function createOrderProgram(input: typeof orderCreateInput.infer) {
  return Effect.gen(function* () {
    const authClient = yield* AuthClient;
    const ticketsClient = yield* Tickets;
    const db = yield* Database;
    const env = yield* OrdersConfig;

    const session = yield* tryOrpc(() => requireSession(authClient, input.token));

    const ticket = yield* tryOrpc(() => ticketsClient.getById({ ticketId: input.ticketId }));
    if (!ticket) {
      return yield* Effect.fail(new TicketNotFound({ ticketId: input.ticketId }));
    }

    if (ticket.sellerId === session.user.id) {
      return yield* Effect.fail(new BuyerIsSeller({ ticketId: input.ticketId }));
    }

    if (ticket.quantityAvailable < input.quantity) {
      return yield* Effect.fail(new SoldOut({ ticketId: input.ticketId }));
    }

    const reserveResult = yield* tryOrpc(() =>
      ticketsClient.reserve({ ticketId: input.ticketId, quantity: input.quantity }),
    ).pipe(
      Effect.catchAll(
        (
          error,
        ): Effect.Effect<never, ReservationConflict | TicketNotFound | ORPCError<string, unknown>> => {
          // Lost the race: between getById and reserve, another buyer claimed the seats.
          if (error.code === "CONFLICT") {
            return Effect.fail(new ReservationConflict({ ticketId: input.ticketId }));
          }

          if (error.code === "NOT_FOUND") {
            return Effect.fail(new TicketNotFound({ ticketId: input.ticketId }));
          }

          return Effect.fail(error);
        },
      ),
    );

    const priceCents = reserveResult.unitPriceCents * input.quantity;

    // Reserve succeeded — from here, any failure must compensate via
    // order.reservation_released.v1.
    const orderId = uuidv7();
    const nowMs = yield* Clock.currentTimeMillis;
    const createdAt = new Date(nowMs);
    const expiresAt = new Date(nowMs + env.reservationTtlMs);

    const row = yield* tryOrpc(() =>
      db.db.transaction(async (tx) => {
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
      }),
    ).pipe(
      // The insert (or its outbox enqueue) failed after the seats were reserved.
      // Compensate first, then re-raise the original failure.
      Effect.catchAll((err) =>
        compensateReserve(db, {
          orderId,
          ticketId: input.ticketId,
          quantity: input.quantity,
        }).pipe(Effect.zipRight(Effect.fail(err))),
      ),
    );

    return toOrderRecord(row);
  });
}

export function createOrdersRouter(runtime: OrdersRuntime) {
  const run = makeRunHandler(runtime);

  const base = os;

  const create = base
    .input(orderCreateInput)
    .output(orderRecordOutput)
    .handler(({ input }) => run(createOrderProgram(input)));

  const getById = base
    .input(orderGetByIdInput)
    .output(orderRecordOrNullOutput)
    .handler(({ input }) =>
      run(
        Effect.gen(function* () {
          const authClient = yield* AuthClient;
          const db = yield* Database;

          const session = yield* tryOrpc(() => requireSession(authClient, input.token));

          const [row] = yield* tryOrpc(() =>
            db.db.select().from(orders).where(eq(orders.id, input.orderId)),
          );
          if (!row) return null;

          // Treat non-ownership identically to "not found" so existence isn't a side channel.
          if (row.buyerId !== session.user.id) return null;

          return toOrderRecord(row);
        }),
      ),
    );

  const list = base
    .input(ordersListInput)
    .output(ordersListOutput)
    .handler(({ input }) =>
      run(
        Effect.gen(function* () {
          const authClient = yield* AuthClient;
          const db = yield* Database;

          const session = yield* tryOrpc(() => requireSession(authClient, input.token));

          const limit = input.limit ?? DEFAULT_LIST_LIMIT;

          // desc(id) is the tie-break when two rows share a millisecond on
          // createdAt. Holds because every insert goes through `create` above with
          // an explicit uuidv7 (monotonic per source) — see the note on
          // `orders.id` in orders-schema.ts.
          const rows = yield* tryOrpc(() =>
            db.db
              .select()
              .from(orders)
              .where(eq(orders.buyerId, session.user.id))
              .orderBy(desc(orders.createdAt), desc(orders.id))
              .limit(limit),
          );

          return { items: rows.map(toOrderRecord) };
        }),
      ),
    );

  const cancel = base
    .input(orderCancelInput)
    .output(orderCancelOutput)
    .handler(({ input }) =>
      run(
        Effect.gen(function* () {
          const authClient = yield* AuthClient;
          const db = yield* Database;

          const session = yield* tryOrpc(() => requireSession(authClient, input.token));

          const nowMs = yield* Clock.currentTimeMillis;
          const now = new Date(nowMs).toISOString();

          // The transaction returns a discriminated result so the not-found case
          // can be raised as a tagged failure outside the non-Effect island.
          const result = yield* tryOrpc(() =>
            db.db.transaction(async (tx): Promise<CancelResult> => {
              const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId));

              // Treat non-existent and non-owned identically to `getById`:
              // existence isn't a side channel an attacker could probe with a
              // guessed orderId.
              if (!order || order.buyerId !== session.user.id) {
                return { kind: "not_found" };
              }

              const next = transition(order.status, { kind: "buyer_cancels" });
              if (!next.ok) {
                // Already terminal (`cancelled`/`complete`/`expired`) — cancel is
                // a no-op. Return the order unchanged so the call stays idempotent.
                return { kind: "ok", row: order };
              }

              const nextVersion = order.version + 1;
              const updated = await updateVersioned(
                tx,
                orders,
                { id: order.id, version: order.version },
                { status: next.next },
              );
              if (updated.rowsAffected === 0) {
                // A concurrent transition (expiry/payment) moved the row to a
                // terminal state between our read and write. Re-read and return
                // it; that writer owns the emitted events.
                const [fresh] = await tx.select().from(orders).where(eq(orders.id, order.id));
                return { kind: "ok", row: fresh ?? order };
              }

              await enqueueEvent(tx, ordersOutbox, {
                subject: ORDER_CANCELLED_V1,
                eventId: uuidv7(),
                payload: { orderId: order.id, version: nextVersion, cancelledAt: now },
              });

              // Cancel must also free the held inventory. Tickets release off
              // order.reservation_released.v1 (not order.cancelled.v1), mirroring
              // the expiration path in orders-consumer.
              await enqueueEvent(tx, ordersOutbox, {
                subject: ORDER_RESERVATION_RELEASED_V1,
                eventId: uuidv7(),
                payload: {
                  orderId: order.id,
                  ticketId: order.ticketId,
                  quantity: order.quantity,
                  releasedAt: now,
                },
              });

              return { kind: "ok", row: { ...order, status: next.next, version: nextVersion } };
            }),
          );

          if (result.kind === "not_found") {
            return yield* Effect.fail(new OrderNotFound({ orderId: input.orderId }));
          }

          return toOrderRecord(result.row);
        }),
      ),
    );

  return { create, getById, list, cancel };
}

type OrderRow = typeof orders.$inferSelect;

type CancelResult = { kind: "not_found" } | { kind: "ok"; row: OrderRow };

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

// Best-effort release of seats reserved against an order that never persisted.
// Swallows its own failure (logging it) so it never masks the original error the
// caller is about to re-raise — matching the imperative compensate today.
function compensateReserve(db: OrdersDb, args: CompensateReserveArgs): Effect.Effect<void> {
  return Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;

    yield* Effect.tryPromise(() =>
      enqueueEvent(db.db, ordersOutbox, {
        subject: ORDER_RESERVATION_RELEASED_V1,
        eventId: uuidv7(),
        payload: {
          orderId: args.orderId,
          ticketId: args.ticketId,
          quantity: args.quantity,
          releasedAt: new Date(nowMs).toISOString(),
        },
      }),
    ).pipe(
      Effect.catchAll((releaseErr) =>
        // Inventory is now stuck reserved against an unborn Order. Operator must
        // reconcile manually.
        Effect.logError(
          "failed to enqueue order.reservation_released.v1 after order insert failure",
        ).pipe(
          Effect.annotateLogs({
            err: releaseErr,
            ticketId: args.ticketId,
            quantity: args.quantity,
            orphanOrderId: args.orderId,
          }),
        ),
      ),
    );
  });
}

import type { Context as OtelContext } from "@opentelemetry/api";
import { ORPCError, os } from "@orpc/server";
import { desc, eq } from "drizzle-orm";
import { Clock, Effect, Metric } from "effect";
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
import { externalParent } from "@tix/observability/otel-trace";
import { withResilience, withTimeout } from "@tix/observability/resilience";

import {
  BuyerIsSeller,
  OrderNotFound,
  ReservationConflict,
  SoldOut,
  TicketNotFound,
} from "../domain/errors.ts";
import { orders, ordersOutbox } from "../domain/schema.ts";
import { transition } from "../domain/state-machine.ts";
import {
  ordersCreatedTotal,
  orderValueCents,
  reservationConflictsTotal,
} from "../runtime/metrics.ts";
import type { OrdersRuntime } from "../runtime/runtime.ts";
import { AuthClient, Database, type OrdersDb, OrdersConfig, Tickets } from "../runtime/services.ts";
import { makeRunHandler, tryOrpc } from "./boundary.ts";

const DEFAULT_LIST_LIMIT = 50;

// Threaded from the Hono boundary (app.ts): the inbound request's trace context, so each
// handler's span continues the caller's trace.
export type OrdersRequestContext = { otelParent: OtelContext };

// Exported as a standalone program (against the service `R` channel) so tests can
// run it under an ambient `TestClock` — the router just wraps it with `run`, which
// executes it on the live runtime.
export function createOrderProgram(input: typeof orderCreateInput.infer) {
  return Effect.gen(function* () {
    const authClient = yield* AuthClient;
    const ticketsClient = yield* Tickets;
    const db = yield* Database;
    const env = yield* OrdersConfig;

    const session = yield* withResilience(
      "orders.auth.require_session",
      tryOrpc(() => requireSession(authClient, input.token)),
    );

    const ticket = yield* withResilience(
      "orders.tickets.get_by_id",
      tryOrpc(() => ticketsClient.getById({ ticketId: input.ticketId })),
    );
    if (!ticket) {
      return yield* Effect.fail(new TicketNotFound({ ticketId: input.ticketId }));
    }

    if (ticket.sellerId === session.user.id) {
      return yield* Effect.fail(new BuyerIsSeller({ ticketId: input.ticketId }));
    }

    if (ticket.quantityAvailable < input.quantity) {
      return yield* Effect.fail(new SoldOut({ ticketId: input.ticketId }));
    }

    const reserveResult = yield* withTimeout(
      "orders.tickets.reserve",
      tryOrpc(() => ticketsClient.reserve({ ticketId: input.ticketId, quantity: input.quantity })),
    ).pipe(
      Effect.catchAll(
        (
          error,
        ): Effect.Effect<
          never,
          ReservationConflict | TicketNotFound | ORPCError<string, unknown>
        > => {
          // Lost the race: between getById and reserve, another buyer claimed the seats.
          if (error.code === "CONFLICT") {
            return Metric.increment(reservationConflictsTotal).pipe(
              Effect.zipRight(Effect.fail(new ReservationConflict({ ticketId: input.ticketId }))),
            );
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

    const row = yield* withTimeout(
      "orders.db.create_order",
      tryOrpc(() =>
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
      ),
    ).pipe(
      // A *typed* failure here — the insert or its outbox enqueue erroring — happened after the
      // seats were reserved, so compensate (release the reservation) before re-raising.
      //
      // A *timeout* is deliberately NOT compensated: `withTimeout` surfaces it as a defect (see
      // resilience.ts), which `catchAll` does not catch, so it propagates uncompensated. The
      // reason is the in-flight commit: `Effect.tryPromise` can't abort the transaction, so a
      // timed-out insert may still land. Releasing the reservation for an order that then commits
      // would oversell the ticket; leaving seats held for an order that rolled back only
      // undersells, which an operator can reconcile. Undersell is the safer default of the two.
      Effect.catchAll((err) =>
        compensateReserve(db, {
          orderId,
          ticketId: input.ticketId,
          quantity: input.quantity,
        }).pipe(Effect.zipRight(Effect.fail(err))),
      ),
    );

    yield* Metric.increment(ordersCreatedTotal);
    yield* Metric.update(orderValueCents, priceCents);

    return toOrderRecord(row);
  });
}

// One span per oRPC request, parented onto the inbound trace context when present
// (otherwise a fresh root). Internal db/transaction spans hang off this one, and the
// active span here is what `enqueueEvent`/outbound clients capture for propagation.
function withRequestSpan<A, E, R>(
  op: string,
  context: OrdersRequestContext,
  program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return program.pipe(
    Effect.withSpan(`orders.rpc.${op}`, { parent: externalParent(context.otelParent) }),
  );
}

export function createOrdersRouter(runtime: OrdersRuntime) {
  const run = makeRunHandler(runtime);

  const base = os.$context<OrdersRequestContext>();

  const create = base
    .input(orderCreateInput)
    .output(orderRecordOutput)
    .handler(({ input, context }) =>
      run(withRequestSpan("create", context, createOrderProgram(input))),
    );

  const getById = base
    .input(orderGetByIdInput)
    .output(orderRecordOrNullOutput)
    .handler(({ input, context }) =>
      run(
        withRequestSpan(
          "get_by_id",
          context,
          Effect.gen(function* () {
            const authClient = yield* AuthClient;
            const db = yield* Database;

            const session = yield* withResilience(
              "orders.auth.require_session",
              tryOrpc(() => requireSession(authClient, input.token)),
            );

            const [row] = yield* withResilience(
              "orders.db.get_order",
              tryOrpc(() => db.db.select().from(orders).where(eq(orders.id, input.orderId))),
            );
            if (!row) return null;

            // Treat non-ownership identically to "not found" so existence isn't a side channel.
            if (row.buyerId !== session.user.id) return null;

            return toOrderRecord(row);
          }),
        ),
      ),
    );

  const list = base
    .input(ordersListInput)
    .output(ordersListOutput)
    .handler(({ input, context }) =>
      run(
        withRequestSpan(
          "list",
          context,
          Effect.gen(function* () {
            const authClient = yield* AuthClient;
            const db = yield* Database;

            const session = yield* withResilience(
              "orders.auth.require_session",
              tryOrpc(() => requireSession(authClient, input.token)),
            );

            const limit = input.limit ?? DEFAULT_LIST_LIMIT;

            // desc(id) is the tie-break when two rows share a millisecond on
            // createdAt. Holds because every insert goes through `create` above with
            // an explicit uuidv7 (monotonic per source) — see the note on
            // `orders.id` in orders-schema.ts.
            const rows = yield* withResilience(
              "orders.db.list_orders",
              tryOrpc(() =>
                db.db
                  .select()
                  .from(orders)
                  .where(eq(orders.buyerId, session.user.id))
                  .orderBy(desc(orders.createdAt), desc(orders.id))
                  .limit(limit),
              ),
            );

            return { items: rows.map(toOrderRecord) };
          }),
        ),
      ),
    );

  const cancel = base
    .input(orderCancelInput)
    .output(orderCancelOutput)
    .handler(({ input, context }) =>
      run(
        withRequestSpan(
          "cancel",
          context,
          Effect.gen(function* () {
            const authClient = yield* AuthClient;
            const db = yield* Database;

            const session = yield* withResilience(
              "orders.auth.require_session",
              tryOrpc(() => requireSession(authClient, input.token)),
            );

            const nowMs = yield* Clock.currentTimeMillis;
            const now = new Date(nowMs).toISOString();

            // The transaction returns a discriminated result so the not-found case
            // can be raised as a tagged failure outside the non-Effect island.
            const result = yield* withTimeout(
              "orders.db.cancel_order",
              tryOrpc(() =>
                db.db.transaction(async (tx): Promise<CancelResult> => {
                  const [order] = await tx
                    .select()
                    .from(orders)
                    .where(eq(orders.id, input.orderId));

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
              ),
            );

            if (result.kind === "not_found") {
              return yield* Effect.fail(new OrderNotFound({ orderId: input.orderId }));
            }

            return toOrderRecord(result.row);
          }),
        ),
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

    yield* withTimeout(
      "orders.db.release_reservation",
      Effect.tryPromise(() =>
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
      ),
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

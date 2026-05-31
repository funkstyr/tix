import type { Context as OtelContext } from "@opentelemetry/api";
import { os } from "@orpc/server";
import { Effect } from "effect";

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
import { paymentCreateInput, paymentCreateOutput } from "@tix/contracts/payments";
import {
  ticketCreateInput,
  ticketGetByIdInput,
  ticketRecordOrNullOutput,
  ticketRecordOutput,
  ticketsListInput,
  ticketsListMineInput,
  ticketsListOutput,
  ticketUpdateInput,
} from "@tix/contracts/tickets";
import { externalParent } from "@tix/observability/otel-trace";

import { makeRunHandler, tryOrpc } from "./gateway-boundary.ts";
import { instrumentEdge } from "./gateway-metrics.ts";
import type { GatewayRuntime } from "./gateway-runtime.ts";
import { Downstream } from "./gateway-services.ts";

// Threaded from the Hono boundary (gateway-app.ts): the buyer's cookie (forwarded to
// downstream services) and the inbound request's trace context, so each handler's span
// continues the caller's trace.
export type GatewayRequestContext = {
  cookieHeader: string | null;
  otelParent: OtelContext;
};

// One root ingress span per fan-out call, parented onto the inbound trace context when
// present (otherwise a fresh root), plus edge RED metrics. The active span here is what
// the downstream oRPC clients capture for `traceparent` propagation.
function withRequest<A, E, R>(
  op: string,
  context: GatewayRequestContext,
  program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return program.pipe(
    Effect.withSpan(`gateway.rpc.${op}`, { parent: externalParent(context.otelParent) }),
    instrumentEdge(op),
  );
}

export function createGatewayRouter(runtime: GatewayRuntime) {
  const run = makeRunHandler(runtime);

  const base = os.$context<GatewayRequestContext>();

  const tickets = {
    create: base
      .input(ticketCreateInput)
      .output(ticketRecordOutput)
      .handler(({ input, context }) =>
        run(
          withRequest(
            "tickets.create",
            context,
            Effect.gen(function* () {
              const clients = yield* Downstream;

              return yield* tryOrpc(() =>
                clients.tickets.create(input, {
                  context: { cookieHeader: context.cookieHeader },
                }),
              );
            }),
          ),
        ),
      ),
    update: base
      .input(ticketUpdateInput)
      .output(ticketRecordOutput)
      .handler(({ input, context }) =>
        run(
          withRequest(
            "tickets.update",
            context,
            Effect.gen(function* () {
              const clients = yield* Downstream;

              return yield* tryOrpc(() =>
                clients.tickets.update(input, {
                  context: { cookieHeader: context.cookieHeader },
                }),
              );
            }),
          ),
        ),
      ),
    getById: base
      .input(ticketGetByIdInput)
      .output(ticketRecordOrNullOutput)
      .handler(({ input, context }) =>
        run(
          withRequest(
            "tickets.getById",
            context,
            Effect.gen(function* () {
              const clients = yield* Downstream;

              return yield* tryOrpc(() =>
                clients.tickets.getById(input, {
                  context: { cookieHeader: context.cookieHeader },
                }),
              );
            }),
          ),
        ),
      ),
    list: base
      .input(ticketsListInput)
      .output(ticketsListOutput)
      .handler(({ input, context }) =>
        run(
          withRequest(
            "tickets.list",
            context,
            Effect.gen(function* () {
              const clients = yield* Downstream;

              return yield* tryOrpc(() =>
                clients.tickets.list(input, {
                  context: { cookieHeader: context.cookieHeader },
                }),
              );
            }),
          ),
        ),
      ),
    listMine: base
      .input(ticketsListMineInput)
      .output(ticketsListOutput)
      .handler(({ input, context }) =>
        run(
          withRequest(
            "tickets.listMine",
            context,
            Effect.gen(function* () {
              const clients = yield* Downstream;

              return yield* tryOrpc(() =>
                clients.tickets.listMine(input, {
                  context: { cookieHeader: context.cookieHeader },
                }),
              );
            }),
          ),
        ),
      ),
  };

  const orders = {
    create: base
      .input(orderCreateInput)
      .output(orderRecordOutput)
      .handler(({ input, context }) =>
        run(
          withRequest(
            "orders.create",
            context,
            Effect.gen(function* () {
              const clients = yield* Downstream;

              return yield* tryOrpc(() =>
                clients.orders.create(input, {
                  context: { cookieHeader: context.cookieHeader },
                }),
              );
            }),
          ),
        ),
      ),
    getById: base
      .input(orderGetByIdInput)
      .output(orderRecordOrNullOutput)
      .handler(({ input, context }) =>
        run(
          withRequest(
            "orders.getById",
            context,
            Effect.gen(function* () {
              const clients = yield* Downstream;

              return yield* tryOrpc(() =>
                clients.orders.getById(input, {
                  context: { cookieHeader: context.cookieHeader },
                }),
              );
            }),
          ),
        ),
      ),
    list: base
      .input(ordersListInput)
      .output(ordersListOutput)
      .handler(({ input, context }) =>
        run(
          withRequest(
            "orders.list",
            context,
            Effect.gen(function* () {
              const clients = yield* Downstream;

              return yield* tryOrpc(() =>
                clients.orders.list(input, {
                  context: { cookieHeader: context.cookieHeader },
                }),
              );
            }),
          ),
        ),
      ),
    cancel: base
      .input(orderCancelInput)
      .output(orderCancelOutput)
      .handler(({ input, context }) =>
        run(
          withRequest(
            "orders.cancel",
            context,
            Effect.gen(function* () {
              const clients = yield* Downstream;

              return yield* tryOrpc(() =>
                clients.orders.cancel(input, {
                  context: { cookieHeader: context.cookieHeader },
                }),
              );
            }),
          ),
        ),
      ),
  };

  const payments = {
    create: base
      .input(paymentCreateInput)
      .output(paymentCreateOutput)
      .handler(({ input, context }) =>
        run(
          withRequest(
            "payments.create",
            context,
            Effect.gen(function* () {
              const clients = yield* Downstream;

              return yield* tryOrpc(() =>
                clients.payments.create(input, {
                  context: { cookieHeader: context.cookieHeader },
                }),
              );
            }),
          ),
        ),
      ),
  };

  return { tickets, orders, payments };
}

export type GatewayRouter = ReturnType<typeof createGatewayRouter>;

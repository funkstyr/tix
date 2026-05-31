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
import { withTimeout } from "@tix/observability/resilience";

import type { CookieContext, DownstreamClients } from "./downstream-clients.ts";
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

  // Every handler is the same fan-out: open the per-request span + edge metrics, resolve
  // the downstream clients, and forward `input` with the buyer's cookie. `delegate`
  // captures that scaffold so each route is a single line where the `op` label sits next
  // to the method it names — instead of a 15-line block repeated per endpoint.
  function delegate<I, A>(
    op: string,
    pick: (
      clients: DownstreamClients,
    ) => (input: I, options: { context: CookieContext }) => Promise<A>,
  ) {
    return ({ input, context }: { input: I; context: GatewayRequestContext }): Promise<A> =>
      run(
        withRequest(
          op,
          context,
          Effect.gen(function* () {
            const clients = yield* Downstream;

            return yield* withTimeout(
              "gateway.downstream.proxy",
              tryOrpc(() =>
                pick(clients)(input, { context: { cookieHeader: context.cookieHeader } }),
              ),
            );
          }),
        ),
      );
  }

  const tickets = {
    create: base
      .input(ticketCreateInput)
      .output(ticketRecordOutput)
      .handler(delegate("tickets.create", (clients) => clients.tickets.create)),
    update: base
      .input(ticketUpdateInput)
      .output(ticketRecordOutput)
      .handler(delegate("tickets.update", (clients) => clients.tickets.update)),
    getById: base
      .input(ticketGetByIdInput)
      .output(ticketRecordOrNullOutput)
      .handler(delegate("tickets.getById", (clients) => clients.tickets.getById)),
    list: base
      .input(ticketsListInput)
      .output(ticketsListOutput)
      .handler(delegate("tickets.list", (clients) => clients.tickets.list)),
    listMine: base
      .input(ticketsListMineInput)
      .output(ticketsListOutput)
      .handler(delegate("tickets.listMine", (clients) => clients.tickets.listMine)),
  };

  const orders = {
    create: base
      .input(orderCreateInput)
      .output(orderRecordOutput)
      .handler(delegate("orders.create", (clients) => clients.orders.create)),
    getById: base
      .input(orderGetByIdInput)
      .output(orderRecordOrNullOutput)
      .handler(delegate("orders.getById", (clients) => clients.orders.getById)),
    list: base
      .input(ordersListInput)
      .output(ordersListOutput)
      .handler(delegate("orders.list", (clients) => clients.orders.list)),
    cancel: base
      .input(orderCancelInput)
      .output(orderCancelOutput)
      .handler(delegate("orders.cancel", (clients) => clients.orders.cancel)),
  };

  const payments = {
    create: base
      .input(paymentCreateInput)
      .output(paymentCreateOutput)
      .handler(delegate("payments.create", (clients) => clients.payments.create)),
  };

  return { tickets, orders, payments };
}

export type GatewayRouter = ReturnType<typeof createGatewayRouter>;

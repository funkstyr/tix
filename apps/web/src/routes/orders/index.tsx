import { type JSX, useMemo } from "react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";

import type { OrderRecord } from "@tix/contracts/orders";

import { requireAuth } from "../../auth/require-auth";
import { formatPrice } from "../../tickets/format-price";

export const Route = createFileRoute("/orders/")({
  beforeLoad: ({ context }) => {
    requireAuth(context.auth, "/orders");
  },
  loader: async ({ context }) => {
    // requireAuth in beforeLoad redirects unauthenticated callers, so a token
    // should be set by now — guard anyway because the type is `string | null`.
    const token = context.auth.sessionToken;
    if (token === null) throw redirect({ to: "/auth/signin", search: { redirect: "/orders" } });

    return await context.gateway.orders.list({ token });
  },
  component: OrdersListPage,
});

function OrdersListPage(): JSX.Element {
  const { items } = Route.useLoaderData();

  if (items.length === 0) {
    return (
      <section>
        <h1>Orders</h1>

        <p>You haven't placed any orders yet.</p>
      </section>
    );
  }

  return (
    <section>
      <h1>Orders</h1>

      <ul>
        {items.map((order) => (
          <OrderRow key={order.id} order={order} />
        ))}
      </ul>
    </section>
  );
}

function OrderRow({ order }: { order: OrderRecord }): JSX.Element {
  const params = useMemo(() => ({ orderId: order.id }), [order.id]);

  return (
    <li>
      <Link to="/orders/$orderId" params={params}>
        <span data-testid="order-status">{order.status}</span>
        <span>{formatPrice(order.priceCents)}</span>
      </Link>
    </li>
  );
}

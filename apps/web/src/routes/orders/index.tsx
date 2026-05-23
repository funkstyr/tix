import { type JSX, useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";

import type { OrderRecord } from "@tix/contracts/orders";

import { requireAuth } from "../../auth/require-auth";
import { formatPrice } from "../../money/format-price";

export const Route = createFileRoute("/orders/")({
  loader: async ({ context }) => {
    const token = requireAuth(context.auth, "/orders");

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
  // Memoized to satisfy react-perf/jsx-no-new-object-as-prop on Link params.
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

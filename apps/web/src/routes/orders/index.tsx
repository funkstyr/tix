import { type JSX, useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";

import type { OrderRecord } from "@tix/contracts/orders";
import { EmptyState } from "@tix/core-ui/empty-state";
import { PageHeader } from "@tix/core-ui/page-header";

import { requireAuth } from "../../auth/require-auth";
import { formatPrice } from "../../money/format-price";
import { OrderStatusBadge } from "../../orders/order-status-badge";

export const Route = createFileRoute("/orders/")({
  loader: async ({ context }) => {
    const token = requireAuth(context.auth, "/orders");

    return await context.gateway.orders.list({ token });
  },
  component: OrdersListPage,
});

function OrdersListPage(): JSX.Element {
  const { items } = Route.useLoaderData();

  return (
    <section>
      <PageHeader title="Orders" />

      {items.length === 0 ? (
        <EmptyState
          title="You haven't placed any orders yet"
          description="Reserve a ticket to get started."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((order) => (
            <OrderRow key={order.id} order={order} />
          ))}
        </ul>
      )}
    </section>
  );
}

function OrderRow({ order }: { order: OrderRecord }): JSX.Element {
  const params = useMemo(() => ({ orderId: order.id }), [order.id]);

  return (
    <li>
      <Link
        to="/orders/$orderId"
        params={params}
        className="hover:bg-accent flex items-center justify-between rounded-md border px-4 py-3"
      >
        <OrderStatusBadge status={order.status} />

        <span className="font-medium">{formatPrice(order.priceCents)}</span>
      </Link>
    </li>
  );
}

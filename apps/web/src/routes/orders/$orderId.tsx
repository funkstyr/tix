import { type JSX, useCallback, useMemo, useState } from "react";
import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";

import { requireAuth } from "../../auth/require-auth";
import { formatPrice } from "../../money/format-price";
import { Countdown } from "../../orders/countdown";
import { StripeCheckout } from "../../orders/stripe-checkout";

const PAYABLE_STATUSES = new Set(["created", "awaiting_payment"]);

export const Route = createFileRoute("/orders/$orderId")({
  loader: async ({ context, params }) => {
    const token = requireAuth(context.auth, `/orders/${params.orderId}`);

    const order = await context.gateway.orders.getById({ token, orderId: params.orderId });
    if (order === null) throw notFound();

    return order;
  },
  component: OrderDetailPage,
  notFoundComponent: OrderNotFound,
});

function OrderDetailPage(): JSX.Element {
  const order = Route.useLoaderData();
  const router = useRouter();

  const expiresAt = useMemo(() => new Date(order.expiresAt), [order.expiresAt]);

  const expiresAtLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        expiresAt,
      ),
    [expiresAt],
  );

  const [expired, setExpired] = useState(false);

  // Re-run the loader when the deadline passes so the displayed status
  // catches up with the backend transition (`created` → `expired`), and flip
  // the local `expired` flag so the checkout form disables before the loader
  // round-trip completes.
  const onExpire = useCallback(() => {
    setExpired(true);
    void router.invalidate();
  }, [router]);

  const payable = PAYABLE_STATUSES.has(order.status);

  return (
    <section>
      <h1>Order</h1>

      <dl>
        <dt>Status</dt>
        <dd data-testid="order-status">{order.status}</dd>

        <dt>Price</dt>
        <dd>{formatPrice(order.priceCents)}</dd>

        <dt>Expires at</dt>
        <dd>{expiresAtLabel}</dd>

        <dt>Time remaining</dt>
        <dd>
          <Countdown expiresAt={expiresAt} onExpire={onExpire} />
        </dd>
      </dl>

      {payable ? (
        <StripeCheckout orderId={order.id} priceCents={order.priceCents} expired={expired} />
      ) : null}
    </section>
  );
}

function OrderNotFound(): JSX.Element {
  return (
    <section>
      <h1>Order not found</h1>

      <p>This order may have been removed or never existed.</p>
    </section>
  );
}

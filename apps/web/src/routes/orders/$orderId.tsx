import { type JSX, useCallback, useMemo, useState } from "react";
import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";

import type { OrderRecord } from "@tix/contracts/orders";
import { Alert } from "@tix/core-ui/alert";
import { Button } from "@tix/core-ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@tix/core-ui/card";
import { EmptyState } from "@tix/core-ui/empty-state";

import { requireAuth } from "../../auth/require-auth";
import { useAuth } from "../../auth/use-auth";
import { useClient } from "../../client/use-client";
import { cancelOrder } from "../../orders/cancel-order";
import { OrderSummary } from "../../orders/order-summary";
import { StripeCheckout } from "../../orders/stripe-checkout";

const PAYABLE_STATUSES = new Set<OrderRecord["status"]>(["created", "awaiting_payment"]);
const CANCELLABLE_STATUSES = new Set<OrderRecord["status"]>(["created", "awaiting_payment"]);

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
  // the local `expired` flag so the checkout disappears before the loader
  // round-trip completes.
  const onExpire = useCallback(() => {
    setExpired(true);
    void router.invalidate();
  }, [router]);

  const payable = !expired && PAYABLE_STATUSES.has(order.status);
  const cancellable = !expired && CANCELLABLE_STATUSES.has(order.status);

  return (
    <section className="mx-auto max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>Order</CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          <OrderSummary
            status={order.status}
            priceCents={order.priceCents}
            expiresAt={expiresAt}
            expiresAtLabel={expiresAtLabel}
            onExpire={onExpire}
          />

          {payable ? <StripeCheckout orderId={order.id} priceCents={order.priceCents} /> : null}

          {cancellable ? <CancelAction orderId={order.id} /> : null}

          {expired ? (
            <p data-testid="order-expired" className="text-destructive text-sm">
              Order expired
            </p>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

function CancelAction({ orderId }: { orderId: string }): JSX.Element {
  const auth = useAuth();
  const client = useClient();
  const router = useRouter();

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const onCancel = useCallback(async () => {
    // The loader already enforced auth before rendering, so a missing token
    // here means the session lapsed mid-view — surface it rather than calling.
    if (auth.sessionToken === null) {
      setError("Your session expired. Sign in again to cancel.");
      return;
    }

    setPending(true);
    setError(null);

    const result = await cancelOrder({ client, token: auth.sessionToken, orderId });
    if (!result.ok) {
      setError(result.error);
      setPending(false);
      return;
    }

    // Re-run the loader so the displayed status catches up with the
    // `cancelled` transition.
    await router.invalidate();
  }, [auth.sessionToken, client, orderId, router]);

  return (
    <>
      {error === null ? null : <Alert className="mb-2">{error}</Alert>}

      <Button
        type="button"
        variant="destructive"
        data-testid="cancel-order"
        onClick={onCancel}
        disabled={pending}
      >
        {pending ? "Cancelling…" : "Cancel order"}
      </Button>
    </>
  );
}

function OrderNotFound(): JSX.Element {
  return (
    <section className="mx-auto max-w-md py-16">
      <EmptyState
        title="Order not found"
        description="This order may have been removed or never existed."
      />
    </section>
  );
}

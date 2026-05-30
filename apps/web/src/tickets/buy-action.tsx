import { type JSX, useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useAuth } from "../auth/use-auth";
import { useClient } from "../client/use-client";
import { extractErrorMessage } from "../errors/extract-error-message";

// Buy control for the ticket detail page, shown to everyone who isn't the
// ticket's owner. Lives in its own duck so the detail route stays a thin view.
export function BuyAction({
  ticketId,
  quantityAvailable,
}: {
  ticketId: string;
  quantityAvailable: number;
}): JSX.Element | null {
  const auth = useAuth();
  const client = useClient();
  const navigate = useNavigate();

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const onBuy = useCallback(async () => {
    // Unauthenticated visitors get bounced to signin with a redirect back to
    // this page; pressing Buy is also how they discover they need an account.
    if (auth.sessionToken === null) {
      await navigate({
        to: "/auth/signin",
        search: { redirect: `/tickets/${ticketId}` },
      });
      return;
    }

    setPending(true);
    setError(null);

    try {
      const order = await client.orders.create({
        token: auth.sessionToken,
        ticketId,
        quantity: 1,
      });

      await navigate({ to: "/orders/$orderId", params: { orderId: order.id } });
    } catch (err) {
      setError(extractErrorMessage(err, "Could not start checkout"));
      setPending(false);
    }
  }, [auth.sessionToken, client, navigate, ticketId]);

  if (quantityAvailable < 1) return <p>Sold out</p>;

  return (
    <>
      {error === null ? null : <p role="alert">{error}</p>}
      <button type="button" onClick={onBuy} disabled={pending}>
        {pending ? "Starting checkout…" : "Buy"}
      </button>
    </>
  );
}

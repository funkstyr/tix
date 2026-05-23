import { type JSX, useCallback, useState } from "react";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";

import { useAuth } from "../../auth/use-auth";
import { useClient } from "../../client/use-client";
import { extractErrorMessage } from "../../errors/extract-error-message";
import { formatPrice } from "../../money/format-price";

export const Route = createFileRoute("/tickets/$ticketId")({
  loader: async ({ context, params }) => {
    const ticket = await context.gateway.tickets.getById({ ticketId: params.ticketId });
    if (ticket === null) throw notFound();

    return ticket;
  },
  component: TicketDetailPage,
  notFoundComponent: TicketNotFound,
});

function TicketDetailPage(): JSX.Element {
  const ticket = Route.useLoaderData();

  return (
    <section>
      <h1>{ticket.title}</h1>

      <dl>
        <dt>Price</dt>
        <dd>{formatPrice(ticket.unitPriceCents)}</dd>
        <dt>Remaining</dt>
        <dd data-testid="ticket-quantity-available">{ticket.quantityAvailable}</dd>
      </dl>

      <BuyAction ticketId={ticket.id} quantityAvailable={ticket.quantityAvailable} />
    </section>
  );
}

function BuyAction({
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

function TicketNotFound(): JSX.Element {
  return (
    <section>
      <h1>Ticket not found</h1>

      <p>This ticket may have been removed or never existed.</p>
    </section>
  );
}

import { type JSX, useCallback, useMemo, useState } from "react";
import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";

import { useAuth } from "../../auth/use-auth";
import { useClient } from "../../client/use-client";
import { extractErrorMessage } from "../../errors/extract-error-message";
import { formatPrice } from "../../money/format-price";
import { isTicketOwner } from "../../tickets/is-ticket-owner";

export const Route = createFileRoute("/tickets/$ticketId/")({
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

  const auth = useAuth();

  const isOwner = isTicketOwner(auth.currentUser, ticket);

  const editParams = useMemo(() => ({ ticketId: ticket.id }), [ticket.id]);

  return (
    <section>
      <h1>{ticket.title}</h1>

      <dl>
        <dt>Price</dt>
        <dd>{formatPrice(ticket.unitPriceCents)}</dd>
        <dt>Remaining</dt>
        <dd data-testid="ticket-quantity-available">{ticket.quantityAvailable}</dd>
      </dl>

      {isOwner ? (
        <Link to="/tickets/$ticketId/edit" params={editParams}>
          Edit
        </Link>
      ) : (
        <BuyAction ticketId={ticket.id} quantityAvailable={ticket.quantityAvailable} />
      )}
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

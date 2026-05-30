import { type JSX, useMemo } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import { useAuth } from "../../auth/use-auth";
import { formatPrice } from "../../money/format-price";
import { BuyAction } from "../../tickets/buy-action";
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

function TicketNotFound(): JSX.Element {
  return (
    <section>
      <h1>Ticket not found</h1>

      <p>This ticket may have been removed or never existed.</p>
    </section>
  );
}

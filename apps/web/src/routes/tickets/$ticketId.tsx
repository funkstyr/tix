import { type JSX } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { formatPrice } from "../../tickets/format-price";

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
        <dd>{ticket.quantityAvailable}</dd>
      </dl>
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

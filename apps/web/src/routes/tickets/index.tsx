import { type JSX, useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";

import type { TicketRecord } from "@tix/contracts/tickets";

import { formatPrice } from "../../tickets/format-price";

export const Route = createFileRoute("/tickets/")({
  loader: ({ context }) => context.gateway.tickets.list({}),
  component: TicketsListPage,
});

function TicketsListPage(): JSX.Element {
  const { items } = Route.useLoaderData();

  if (items.length === 0) {
    return (
      <section>
        <h1>Tickets</h1>

        <p>No tickets available yet.</p>
      </section>
    );
  }

  return (
    <section>
      <h1>Tickets</h1>

      <ul>
        {items.map((ticket) => (
          <TicketRow key={ticket.id} ticket={ticket} />
        ))}
      </ul>
    </section>
  );
}

function TicketRow({ ticket }: { ticket: TicketRecord }): JSX.Element {
  const params = useMemo(() => ({ ticketId: ticket.id }), [ticket.id]);

  return (
    <li>
      <Link to="/tickets/$ticketId" params={params}>
        <span>{ticket.title}</span>
        <span>{formatPrice(ticket.unitPriceCents)}</span>
        <span>{ticket.quantityAvailable} available</span>
      </Link>
    </li>
  );
}

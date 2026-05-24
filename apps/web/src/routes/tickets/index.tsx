import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { TicketRow } from "../../tickets/ticket-row";

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
          <TicketRow
            key={ticket.id}
            ticket={ticket}
            quantityText={`${ticket.quantityAvailable} available`}
          />
        ))}
      </ul>
    </section>
  );
}

import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { requireAuth } from "../../auth/require-auth";
import { TicketRow } from "../../tickets/ticket-row";

export const Route = createFileRoute("/tickets/mine")({
  loader: ({ context }) => {
    const token = requireAuth(context.auth, "/tickets/mine");

    return context.gateway.tickets.listMine({ token });
  },
  component: MyTicketsPage,
});

function MyTicketsPage(): JSX.Element {
  const { items } = Route.useLoaderData();

  if (items.length === 0) {
    return (
      <section>
        <h1>My tickets</h1>

        <p>You haven't listed any tickets yet.</p>
      </section>
    );
  }

  return (
    <section>
      <h1>My tickets</h1>

      <ul>
        {items.map((ticket) => (
          <TicketRow
            key={ticket.id}
            ticket={ticket}
            quantityText={`${ticket.quantityAvailable} of ${ticket.quantityTotal} remaining`}
            quantityTestId="my-ticket-quantity"
          />
        ))}
      </ul>
    </section>
  );
}

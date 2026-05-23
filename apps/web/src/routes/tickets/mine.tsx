import { type JSX, useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";

import type { TicketRecord } from "@tix/contracts/tickets";

import { requireAuth } from "../../auth/require-auth";
import { formatPrice } from "../../money/format-price";

export const Route = createFileRoute("/tickets/mine")({
  loader: async ({ context }) => {
    const token = requireAuth(context.auth, "/tickets/mine");

    return await context.gateway.tickets.listMine({ token });
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
          <MyTicketRow key={ticket.id} ticket={ticket} />
        ))}
      </ul>
    </section>
  );
}

function MyTicketRow({ ticket }: { ticket: TicketRecord }): JSX.Element {
  const params = useMemo(() => ({ ticketId: ticket.id }), [ticket.id]);

  return (
    <li>
      <Link to="/tickets/$ticketId" params={params}>
        <span>{ticket.title}</span>
        <span>{formatPrice(ticket.unitPriceCents)}</span>
        <span data-testid="my-ticket-quantity">
          {ticket.quantityAvailable} of {ticket.quantityTotal} remaining
        </span>
      </Link>
    </li>
  );
}

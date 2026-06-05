import type { JSX } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";

import { TicketCard } from "../tickets/ticket-card";

export const Route = createFileRoute("/")({
  loader: ({ context }) => context.gateway.tickets.list({}),
  component: Home,
});

const FEATURED_LIMIT = 3;

function Home(): JSX.Element {
  const { items } = Route.useLoaderData();
  const featured = items.slice(0, FEATURED_LIMIT);

  return (
    <div className="flex flex-col gap-12">
      <section className="flex flex-col items-center gap-4 py-12 text-center">
        <h1 className="text-4xl font-bold tracking-tight">Tickets, resold fairly</h1>

        <p className="max-w-md text-muted-foreground">
          Buy and sell tickets peer-to-peer. Reserve in one click; pay within 15 minutes.
        </p>

        <div className="flex gap-3">
          <Link
            to="/tickets"
            className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Browse tickets
          </Link>

          <Link
            to="/tickets/new"
            className="rounded-md border px-5 py-2.5 text-sm font-medium hover:bg-accent"
          >
            List a ticket
          </Link>
        </div>
      </section>

      {featured.length === 0 ? null : (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Recent listings</h2>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {featured.map((ticket) => (
              <TicketCard key={ticket.id} ticket={ticket} quantityText={`${ticket.quantityAvailable} available`} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { EmptyState } from "@tix/core-ui/empty-state";
import { PageHeader } from "@tix/core-ui/page-header";

import { TicketCard } from "../../tickets/ticket-card";

export const Route = createFileRoute("/tickets/")({
  loader: ({ context }) => context.gateway.tickets.list({}),
  component: TicketsListPage,
});

function TicketsListPage(): JSX.Element {
  const { items } = Route.useLoaderData();

  return (
    <section>
      <PageHeader title="Tickets" description="Browse every listing" />

      {items.length === 0 ? (
        <EmptyState title="No tickets available yet" description="Check back soon." />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((ticket) => (
            <TicketCard key={ticket.id} ticket={ticket} quantityText={`${ticket.quantityAvailable} available`} />
          ))}
        </div>
      )}
    </section>
  );
}

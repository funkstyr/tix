import { type JSX, useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";

import { EmptyState } from "@tix/core-ui/empty-state";
import { PageHeader } from "@tix/core-ui/page-header";

import { requireAuth } from "../../auth/require-auth";
import { TicketCard } from "../../tickets/ticket-card";

export const Route = createFileRoute("/tickets/mine")({
  loader: ({ context }) => {
    const token = requireAuth(context.auth, "/tickets/mine");

    return context.gateway.tickets.listMine({ token });
  },
  component: MyTicketsPage,
});

function MyTicketsPage(): JSX.Element {
  const { items } = Route.useLoaderData();

  const headerAction = useMemo(
    () => (
      <Link
        to="/tickets/new"
        className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2 text-sm font-medium"
      >
        List a ticket
      </Link>
    ),
    [],
  );

  const emptyAction = useMemo(
    () => (
      <Link to="/tickets/new" className="underline">
        List a ticket
      </Link>
    ),
    [],
  );

  return (
    <section>
      <PageHeader title="My tickets" action={headerAction} />

      {items.length === 0 ? (
        <EmptyState
          title="You haven't listed any tickets yet"
          description="List one to start selling."
          action={emptyAction}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((ticket) => (
            <TicketCard
              key={ticket.id}
              ticket={ticket}
              quantityText={`${ticket.quantityAvailable} of ${ticket.quantityTotal} remaining`}
              quantityTestId="my-ticket-quantity"
            />
          ))}
        </div>
      )}
    </section>
  );
}

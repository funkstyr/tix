import { type JSX, useMemo } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@tix/core-ui/card";
import { EmptyState } from "@tix/core-ui/empty-state";

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
    <section className="mx-auto max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">{ticket.title}</CardTitle>
        </CardHeader>

        <CardContent className="flex items-center justify-between">
          <span className="text-2xl font-semibold">{formatPrice(ticket.unitPriceCents)}</span>

          <span className="text-muted-foreground text-sm">
            <span data-testid="ticket-quantity-available">{ticket.quantityAvailable}</span>{" "}
            available
          </span>
        </CardContent>

        <CardFooter>
          {isOwner ? (
            <Link
              to="/tickets/$ticketId/edit"
              params={editParams}
              className="hover:bg-accent rounded-md border px-4 py-2 text-sm font-medium"
            >
              Edit
            </Link>
          ) : (
            <BuyAction ticketId={ticket.id} quantityAvailable={ticket.quantityAvailable} />
          )}
        </CardFooter>
      </Card>
    </section>
  );
}

function TicketNotFound(): JSX.Element {
  return (
    <EmptyState
      title="Ticket not found"
      description="This ticket may have been removed or never existed."
    />
  );
}

import { type ChangeEvent, type FormEvent, type JSX, useCallback, useState } from "react";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";

import { Alert } from "@tix/core-ui/alert";
import { Button } from "@tix/core-ui/button";
import { EmptyState } from "@tix/core-ui/empty-state";
import { FormField } from "@tix/core-ui/form-field";
import { PageHeader } from "@tix/core-ui/page-header";

import { requireAuth } from "../../auth/require-auth";
import { useAuth } from "../../auth/use-auth";
import { useClient } from "../../client/use-client";
import { dollarsToCents } from "../../tickets/dollars-to-cents";
import { isTicketOwner } from "../../tickets/is-ticket-owner";
import { updateTicket } from "../../tickets/update-ticket";

export const Route = createFileRoute("/tickets/$ticketId/edit")({
  beforeLoad: ({ context, params }) => {
    requireAuth(context.auth, `/tickets/${params.ticketId}/edit`);
  },
  loader: async ({ context, params }) => {
    const ticket = await context.gateway.tickets.getById({ ticketId: params.ticketId });
    if (ticket === null) throw notFound();

    return ticket;
  },
  component: EditTicketPage,
});

function EditTicketPage(): JSX.Element {
  const ticket = Route.useLoaderData();

  const auth = useAuth();

  const client = useClient();

  const navigate = useNavigate();

  const [title, setTitle] = useState(ticket.title);

  const [priceDollars, setPriceDollars] = useState((ticket.unitPriceCents / 100).toFixed(2));

  const [error, setError] = useState<string | null>(null);

  const [pending, setPending] = useState(false);

  const onTitle = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTitle(event.target.value);
  }, []);

  const onPrice = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setPriceDollars(event.target.value);
  }, []);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setPending(true);
      setError(null);

      // beforeLoad's requireAuth already redirects unauthenticated visitors, so
      // sessionToken should be set here. Guard anyway because the type is
      // `string | null`.
      if (auth.sessionToken === null) {
        setError("Not signed in");
        setPending(false);
        return;
      }

      const parsedPriceCents = dollarsToCents(priceDollars);
      if (!Number.isFinite(parsedPriceCents) || parsedPriceCents < 0) {
        setError("Enter a valid price");
        setPending(false);
        return;
      }

      const result = await updateTicket({
        client,
        token: auth.sessionToken,
        ticketId: ticket.id,
        title,
        unitPriceCents: parsedPriceCents,
        expectedVersion: ticket.version,
      });
      if (!result.ok) {
        setError(result.error);
        setPending(false);
        return;
      }

      await navigate({ to: "/tickets/$ticketId", params: { ticketId: ticket.id } });
    },
    [auth.sessionToken, client, navigate, priceDollars, title, ticket.id, ticket.version],
  );

  // The tickets service rejects edits from non-owners too; this is just so a
  // seller who follows a stale link gets a clear message instead of a failed
  // submit.
  if (!isTicketOwner(auth.currentUser, ticket)) {
    return (
      <EmptyState title="Not your ticket" description="You can only edit tickets you listed." />
    );
  }

  return (
    <section className="mx-auto max-w-md">
      <PageHeader title="Edit ticket" />

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <FormField label="Title" type="text" required value={title} onChange={onTitle} />

        <FormField
          label="Price"
          hint="USD"
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          required
          value={priceDollars}
          onChange={onPrice}
        />

        {error === null ? null : <Alert>{error}</Alert>}

        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </form>
    </section>
  );
}

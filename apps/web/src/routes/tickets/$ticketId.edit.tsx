import { type FormEvent, type JSX, useCallback } from "react";
import { useForm } from "@tanstack/react-form";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { type } from "arktype";

import { Alert } from "@tix/core-ui/alert";
import { Button } from "@tix/core-ui/button";
import { EmptyState } from "@tix/core-ui/empty-state";
import { PageHeader } from "@tix/core-ui/page-header";

import { requireAuth } from "../../auth/require-auth";
import { useAuth } from "../../auth/use-auth";
import { useClient } from "../../client/use-client";
import { FormTextField } from "../../forms/form-text-field";
import { useSubmitState } from "../../forms/use-submit-state";
import { dollarsToCents } from "../../tickets/dollars-to-cents";
import { isTicketOwner } from "../../tickets/is-ticket-owner";
import { updateTicket } from "../../tickets/update-ticket";

const editTicketSchema = type({
  title: "string >= 1",
  priceDollars: type("string.numeric.parse").to("number >= 0"),
});

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

  const form = useForm({
    defaultValues: {
      title: ticket.title,
      priceDollars: (ticket.unitPriceCents / 100).toFixed(2),
    },
    validators: {
      onChange: editTicketSchema,
      onSubmitAsync: async ({ value }) => {
        // beforeLoad's requireAuth already redirects unauthenticated visitors,
        // so sessionToken should be set here. Guard anyway because the type is
        // `string | null`.
        if (auth.sessionToken === null) return "Not signed in";

        const result = await updateTicket({
          client,
          token: auth.sessionToken,
          ticketId: ticket.id,
          title: value.title,
          unitPriceCents: dollarsToCents(value.priceDollars),
          expectedVersion: ticket.version,
        });
        if (!result.ok) return result.error;

        await navigate({ to: "/tickets/$ticketId", params: { ticketId: ticket.id } });
        return undefined;
      },
    },
  });

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void form.handleSubmit();
    },
    [form],
  );

  const { canSubmit, isSubmitting, submitError } = useSubmitState(form);

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

      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <form.Field name="title">
          {(field) => <FormTextField field={field} label="Title" type="text" />}
        </form.Field>

        <form.Field name="priceDollars">
          {(field) => (
            <FormTextField
              field={field}
              label="Price"
              hint="USD"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
            />
          )}
        </form.Field>

        {submitError == null ? null : <Alert>{submitError}</Alert>}

        <Button type="submit" disabled={!canSubmit || isSubmitting}>
          {isSubmitting ? "Saving…" : "Save changes"}
        </Button>
      </form>
    </section>
  );
}

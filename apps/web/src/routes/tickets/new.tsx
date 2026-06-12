import { type FormEvent, type JSX, useCallback } from "react";
import { useForm } from "@tanstack/react-form";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type } from "arktype";

import { Alert } from "@tix/core-ui/alert";
import { Button } from "@tix/core-ui/button";
import { PageHeader } from "@tix/core-ui/page-header";

import { requireAuth } from "../../auth/require-auth";
import { useAuth } from "../../auth/use-auth";
import { useClient } from "../../client/use-client";
import { extractErrorMessage } from "../../errors/extract-error-message";
import { FormTextField } from "../../forms/form-text-field";
import { useSubmitState } from "../../forms/use-submit-state";
import { dollarsToCents } from "../../tickets/dollars-to-cents";

const newTicketSchema = type({
  title: "string >= 1",
  priceDollars: type("string.numeric.parse").to("number >= 0"),
  quantity: type("string.integer.parse").to("number >= 1"),
});

export const Route = createFileRoute("/tickets/new")({
  beforeLoad: ({ context }) => {
    requireAuth(context.auth, "/tickets/new");
  },
  component: NewTicketPage,
});

function NewTicketPage(): JSX.Element {
  const auth = useAuth();

  const client = useClient();

  const navigate = useNavigate();

  const form = useForm({
    defaultValues: { title: "", priceDollars: "", quantity: "1" },
    validators: {
      onChange: newTicketSchema,
      onSubmitAsync: async ({ value }) => {
        // requireAuth in beforeLoad already redirects unauthenticated visitors,
        // so sessionToken should be set by the time this runs. Guard anyway
        // because the type is `string | null`.
        if (auth.sessionToken === null) return "Not signed in";

        try {
          const ticket = await client.tickets.create({
            token: auth.sessionToken,
            title: value.title,
            quantityTotal: Number.parseInt(value.quantity, 10),
            unitPriceCents: dollarsToCents(value.priceDollars),
          });

          await navigate({ to: "/tickets/$ticketId", params: { ticketId: ticket.id } });
          return undefined;
        } catch (err) {
          return extractErrorMessage(err, "Failed to create ticket");
        }
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

  return (
    <section className="mx-auto max-w-md">
      <PageHeader title="List a ticket" />

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

        <form.Field name="quantity">
          {(field) => (
            <FormTextField
              field={field}
              label="Quantity"
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
            />
          )}
        </form.Field>

        {submitError == null ? null : <Alert>{submitError}</Alert>}

        <Button type="submit" disabled={!canSubmit || isSubmitting}>
          {isSubmitting ? "Creating…" : "List ticket"}
        </Button>
      </form>
    </section>
  );
}

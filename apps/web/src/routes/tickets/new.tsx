import { type ChangeEvent, type FormEvent, type JSX, useCallback, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { requireAuth } from "../../auth/require-auth";
import { useAuth } from "../../auth/use-auth";
import { useClient } from "../../client/use-client";
import { dollarsToCents } from "../../tickets/dollars-to-cents";

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

  const [title, setTitle] = useState("");

  const [priceDollars, setPriceDollars] = useState("");

  const [quantity, setQuantity] = useState("1");

  const [error, setError] = useState<string | null>(null);

  const [pending, setPending] = useState(false);

  const onTitle = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTitle(event.target.value);
  }, []);

  const onPrice = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setPriceDollars(event.target.value);
  }, []);

  const onQuantity = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setQuantity(event.target.value);
  }, []);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setPending(true);
      setError(null);

      // requireAuth in beforeLoad already redirects unauthenticated visitors,
      // so sessionToken should be set by the time this handler runs. Guard
      // anyway because the type is `string | null`.
      if (auth.sessionToken === null) {
        setError("Not signed in");
        setPending(false);
        return;
      }

      try {
        const ticket = await client.tickets.create({
          token: auth.sessionToken,
          title,
          quantityTotal: Number.parseInt(quantity, 10),
          unitPriceCents: dollarsToCents(priceDollars),
        });

        await navigate({ to: "/tickets/$ticketId", params: { ticketId: ticket.id } });
      } catch (err) {
        setError(extractErrorMessage(err));
        setPending(false);
      }
    },
    [auth.sessionToken, client, navigate, priceDollars, quantity, title],
  );

  return (
    <section>
      <h1>List a ticket</h1>

      <form onSubmit={onSubmit}>
        <label htmlFor="new-ticket-title">Title</label>
        <input
          id="new-ticket-title"
          type="text"
          aria-label="Title"
          required
          value={title}
          onChange={onTitle}
        />

        <label htmlFor="new-ticket-price">Price (USD)</label>
        <input
          id="new-ticket-price"
          type="number"
          aria-label="Price"
          inputMode="decimal"
          min="0"
          step="0.01"
          required
          value={priceDollars}
          onChange={onPrice}
        />

        <label htmlFor="new-ticket-quantity">Quantity</label>
        <input
          id="new-ticket-quantity"
          type="number"
          aria-label="Quantity"
          inputMode="numeric"
          min="1"
          step="1"
          required
          value={quantity}
          onChange={onQuantity}
        />

        {error === null ? null : <p role="alert">{error}</p>}

        <button type="submit" disabled={pending}>
          {pending ? "Creating…" : "List ticket"}
        </button>
      </form>
    </section>
  );
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.length > 0) return err.message;

  return "Failed to create ticket";
}

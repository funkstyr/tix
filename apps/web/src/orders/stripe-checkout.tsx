import { type FormEvent, type JSX, useCallback, useMemo, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import type { StripeElementsOptions } from "@stripe/stripe-js";
import { useNavigate } from "@tanstack/react-router";

import { useAuth } from "../auth/use-auth";
import { useClient } from "../client/use-client";
import { stripePromise } from "./stripe-client";
import { submitPayment } from "./submit-payment";

export type StripeCheckoutProps = {
  orderId: string;
  priceCents: number;
  expired: boolean;
};

export function StripeCheckout({ orderId, priceCents, expired }: StripeCheckoutProps): JSX.Element {
  // Memoized so the <Elements> instance isn't re-created on every render —
  // Stripe warns and remounts the iframe if the options object identity changes.
  const options = useMemo<StripeElementsOptions>(
    () => ({
      mode: "payment",
      amount: priceCents,
      currency: "usd",
      // Deferred intent: we tokenize the card here, then the gateway creates
      // and confirms the PaymentIntent server-side. No raw card data hits the
      // gateway — Elements posts directly to Stripe.
      paymentMethodCreation: "manual",
    }),
    [priceCents],
  );

  if (expired) {
    return <p data-testid="order-expired">Order expired</p>;
  }

  return (
    <Elements stripe={stripePromise} options={options}>
      <CheckoutForm orderId={orderId} />
    </Elements>
  );
}

function CheckoutForm({ orderId }: { orderId: string }): JSX.Element {
  const stripe = useStripe();
  const elements = useElements();
  const auth = useAuth();
  const client = useClient();
  const navigate = useNavigate();

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      if (stripe === null || elements === null) return;
      // Order detail route is auth-gated, so token is set; guard the type.
      if (auth.sessionToken === null) {
        setError("Not signed in");
        return;
      }

      setPending(true);
      setError(null);

      const result = await submitPayment({
        stripe,
        elements,
        client,
        token: auth.sessionToken,
        orderId,
      });

      if (result.kind === "ok") {
        await navigate({ to: "/orders" });
        return;
      }

      setError(result.message);
      setPending(false);
    },
    [auth.sessionToken, client, elements, navigate, orderId, stripe],
  );

  const disabled = pending || stripe === null || elements === null;

  return (
    <form onSubmit={onSubmit}>
      <PaymentElement />

      {error === null ? null : <p role="alert">{error}</p>}

      <button type="submit" disabled={disabled}>
        {pending ? "Paying…" : "Pay"}
      </button>
    </form>
  );
}

import type { SagaClients } from "./clients.ts";

export type Credentials = { email: string; password: string };

export type BuyerJourneyOptions = {
  clients: SagaClients;
  // Standing accounts. In api-e2e these are freshly signed-up; the synthetic signs IN to
  // pre-provisioned accounts. The flow only needs sign-in, so both paths share it.
  seller: Credentials;
  buyer: Credentials;
  // Stripe test PaymentMethod id (e.g. "pm_card_visa"). Test mode only — never a live key.
  paymentMethodId: string;
};

export type BuyerJourneyResult = {
  ok: boolean;
  steps: {
    ticketId?: string;
    orderId?: string;
    charge?: string;
  };
  error?: string;
};

// One full buyer journey: seller lists a 1-seat ticket, buyer reserves+orders it, charges with a
// Stripe test card, asserts the order completed, then cancels to net inventory back to zero. Pure
// orchestration over injected clients — no process/DB/infra — so api-e2e and the live synthetic
// both call it. Always attempts cleanup, even on a failed charge, so a probe run leaves no residue.
export async function runBuyerJourney(opts: BuyerJourneyOptions): Promise<BuyerJourneyResult> {
  const { clients } = opts;
  const steps: BuyerJourneyResult["steps"] = {};
  let orderId: string | undefined;
  let buyerToken: string | undefined;

  try {
    const seller = await clients.auth.signIn(opts.seller);
    const ticket = await clients.tickets.create({
      token: seller.token,
      title: "synthetic probe",
      quantityTotal: 1,
      unitPriceCents: 5000,
    });
    steps.ticketId = ticket.id;

    const buyer = await clients.auth.signIn(opts.buyer);
    buyerToken = buyer.token;
    const order = await clients.orders.create({
      token: buyer.token,
      ticketId: ticket.id,
      quantity: 1,
    });
    orderId = order.id;
    steps.orderId = order.id;

    const payment = await clients.payments.create({
      token: buyer.token,
      orderId: order.id,
      paymentMethodId: opts.paymentMethodId,
    });
    steps.charge = payment.status;

    if (payment.status !== "succeeded") {
      return { ok: false, steps, error: `charge status ${payment.status}` };
    }

    return { ok: true, steps };
  } catch (error) {
    return { ok: false, steps, error: error instanceof Error ? error.message : String(error) };
  } finally {
    // Cleanup is best-effort: cancel the order so the seat returns and no synthetic order lingers.
    if (orderId && buyerToken) {
      try {
        await clients.orders.cancel({ token: buyerToken, orderId });
      } catch {
        // swallow — a failed cleanup must not mask the journey result
      }
    }
  }
}

import { setTimeout as delay } from "node:timers/promises";

import type { PaymentIntentStatus } from "@tix/contracts/payments";

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
    charge?: PaymentIntentStatus;
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
    // NOTE: If the journey throws AFTER this point but BEFORE order creation (e.g. buyer
    // sign-in fails), the synthetic ticket created here will remain listed. The tickets
    // contract exposes no delete or cancel operation, so there is no clean way to remove
    // it. This is accepted: the ticket is clearly named "synthetic probe", has 1 seat, and
    // real buyers cannot complete a purchase against the synthetic seller account. The
    // finally block below only cancels the order because that is the only cleanup path
    // available via the contracts API.
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

    const payment = await chargeWithRetry(clients, {
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

// payments builds its order view by consuming `order.created.v1` from NATS, so a charge fired
// immediately after `orders.create` can race that projection and fail with "order not found".
// Retry the charge a few times with a short backoff; any other failure propagates at once.
const CHARGE_MAX_ATTEMPTS = 5;
const CHARGE_RETRY_DELAY_MS = 400;

function isOrderNotProjectedYet(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("order not found");
}

async function chargeWithRetry(
  clients: SagaClients,
  input: Parameters<SagaClients["payments"]["create"]>[0],
): Promise<Awaited<ReturnType<SagaClients["payments"]["create"]>>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CHARGE_MAX_ATTEMPTS; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop -- serial retry by design
      return await clients.payments.create(input);
    } catch (error) {
      if (!isOrderNotProjectedYet(error)) throw error;

      lastError = error;
      // eslint-disable-next-line no-await-in-loop -- backoff before the next attempt
      await delay(CHARGE_RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

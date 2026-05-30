import type { GatewayRouterClient } from "@tix/contracts/gateway";
import type { OrderRecord } from "@tix/contracts/orders";

import { extractErrorMessage } from "../errors/extract-error-message";

export type CancelOrderArgs = {
  client: GatewayRouterClient;
  token: string;
  orderId: string;
};

export type CancelOrderResult = { ok: true; order: OrderRecord } | { ok: false; error: string };

export function cancelOrder(args: CancelOrderArgs): Promise<CancelOrderResult> {
  return cancel(args);
}

async function cancel(args: CancelOrderArgs): Promise<CancelOrderResult> {
  const { client, token, orderId } = args;

  try {
    const order = await client.orders.cancel({ token, orderId });

    return { ok: true, order };
  } catch (err) {
    return { ok: false, error: extractErrorMessage(err, "Could not cancel order") };
  }
}

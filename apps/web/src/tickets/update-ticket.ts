import type { GatewayRouterClient } from "@tix/contracts/gateway";
import type { TicketRecord } from "@tix/contracts/tickets";

import { extractErrorMessage } from "../errors/extract-error-message";

export type UpdateTicketArgs = {
  client: GatewayRouterClient;
  token: string;
  ticketId: string;
  title: string;
  unitPriceCents: number;
  expectedVersion: number;
};

export type UpdateTicketResult = { ok: true; ticket: TicketRecord } | { ok: false; error: string };

export async function updateTicket(args: UpdateTicketArgs): Promise<UpdateTicketResult> {
  const { client, token, ticketId, title, unitPriceCents, expectedVersion } = args;

  try {
    const ticket = await client.tickets.update({
      token,
      ticketId,
      title,
      unitPriceCents,
      expectedVersion,
    });

    return { ok: true, ticket };
  } catch (err) {
    return { ok: false, error: extractErrorMessage(err, "Could not update ticket") };
  }
}

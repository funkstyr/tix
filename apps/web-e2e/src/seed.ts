import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { randomUUID } from "node:crypto";

import type { GatewayRouterClient } from "@tix/contracts/gateway";
import { RPC_PREFIX } from "@tix/contracts/rpc";
import type { TicketRecord } from "@tix/contracts/tickets";

export type SeededSeller = {
  token: string;
  email: string;
};

export type SeededTicket = {
  ticket: TicketRecord;
  seller: SeededSeller;
};

type SignUpResponse = {
  token: string;
};

// One-stop seed helper: spins up a seller account through the gateway's
// better-auth proxy, then uses that token to list a ticket via the gateway's
// oRPC tickets.create route. Buyer specs call this so they don't have to
// drive the seller's UI before getting to the part they actually want to
// test.
export async function seedTicket(
  gatewayBaseUrl: string,
  args: {
    title: string;
    quantityTotal: number;
    unitPriceCents: number;
  },
): Promise<SeededTicket> {
  const seller = await signUp(gatewayBaseUrl, `seller-${randomSuffix()}@e2e.test`);

  const link = new RPCLink({ url: joinRpc(gatewayBaseUrl) });
  const client: GatewayRouterClient = createORPCClient(link);

  const ticket = await client.tickets.create({
    token: seller.token,
    title: args.title,
    quantityTotal: args.quantityTotal,
    unitPriceCents: args.unitPriceCents,
  });

  return { ticket, seller };
}

export async function signUp(gatewayBaseUrl: string, email: string): Promise<SeededSeller> {
  const res = await fetch(`${trim(gatewayBaseUrl)}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password: "correct-horse-battery",
      name: email.split("@")[0],
    }),
  });
  if (!res.ok) {
    throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as SignUpResponse;
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error(`sign-up response missing token: ${JSON.stringify(body)}`);
  }
  return { token: body.token, email };
}

export function randomSuffix(): string {
  return randomUUID().slice(0, 8);
}

function trim(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function joinRpc(base: string): string {
  return `${trim(base)}${RPC_PREFIX}`;
}

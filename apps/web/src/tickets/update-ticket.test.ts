import { describe, expect, it, vi } from "vitest";

import type { GatewayRouterClient } from "@tix/contracts/gateway";
import type { TicketRecord } from "@tix/contracts/tickets";

import { updateTicket } from "./update-ticket";

type UpdateFn = (input: unknown) => Promise<TicketRecord>;

function makeClient(impl: UpdateFn): {
  client: GatewayRouterClient;
  update: ReturnType<typeof vi.fn<UpdateFn>>;
} {
  const update = vi.fn<UpdateFn>(impl);
  const client = { tickets: { update } } as unknown as GatewayRouterClient;
  return { client, update };
}

const TOKEN = "session-token";
const TICKET_ID = "11111111-1111-4111-8111-111111111111";

const editedTicket: TicketRecord = {
  id: TICKET_ID,
  sellerId: "22222222-2222-4222-8222-222222222222",
  title: "New title",
  quantityTotal: 2,
  quantityAvailable: 2,
  unitPriceCents: 5000,
  version: 2,
  createdAt: "2026-05-20T12:00:00.000Z",
};

describe("updateTicket", () => {
  it("calls tickets.update with the token, edits, and expected version", async () => {
    const { client, update } = makeClient(async () => editedTicket);

    await updateTicket({
      client,
      token: TOKEN,
      ticketId: TICKET_ID,
      title: "New title",
      unitPriceCents: 5000,
      expectedVersion: 1,
    });

    expect(update).toHaveBeenCalledWith({
      token: TOKEN,
      ticketId: TICKET_ID,
      title: "New title",
      unitPriceCents: 5000,
      expectedVersion: 1,
    });
  });

  it("returns the updated ticket so the view can render the new price", async () => {
    const { client } = makeClient(async () => editedTicket);

    const result = await updateTicket({
      client,
      token: TOKEN,
      ticketId: TICKET_ID,
      title: "New title",
      unitPriceCents: 5000,
      expectedVersion: 1,
    });

    expect(result).toEqual({ ok: true, ticket: editedTicket });
  });

  it("surfaces a friendly error when the update is rejected", async () => {
    const { client } = makeClient(async () => {
      throw new Error("cannot edit a reserved ticket");
    });

    const result = await updateTicket({
      client,
      token: TOKEN,
      ticketId: TICKET_ID,
      title: "New title",
      unitPriceCents: 5000,
      expectedVersion: 1,
    });

    expect(result).toEqual({ ok: false, error: "cannot edit a reserved ticket" });
  });

  it("falls back to a generic message when the update rejects with a non-Error", async () => {
    const { client } = makeClient(async () => {
      throw "boom";
    });

    const result = await updateTicket({
      client,
      token: TOKEN,
      ticketId: TICKET_ID,
      title: "New title",
      unitPriceCents: 5000,
      expectedVersion: 1,
    });

    expect(result).toEqual({ ok: false, error: "Could not update ticket" });
  });
});

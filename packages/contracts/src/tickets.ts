import { type } from "arktype";

export const ticketCreatedV1 = type({
  "+": "reject",
  ticketId: "string.uuid",
  sellerId: "string.uuid",
  title: "string",
  quantityTotal: "number.integer >= 1",
  unitPriceCents: "number.integer >= 0",
  createdAt: "string.date.iso",
});

export type TicketCreatedV1 = typeof ticketCreatedV1.infer;

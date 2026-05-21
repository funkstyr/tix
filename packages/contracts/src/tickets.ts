import { type } from "arktype";

export const ticketCreatedV1 = type({
  "+": "reject",
  ticketId: "string.uuid",
  sellerId: "string >= 1",
  title: "string",
  quantityTotal: "number.integer >= 1",
  unitPriceCents: "number.integer >= 0",
  createdAt: "string.date.iso",
});

export type TicketCreatedV1 = typeof ticketCreatedV1.infer;

export const ticketSnapshotOutput = type({
  id: "string.uuid",
  sellerId: "string",
  quantityAvailable: "number.integer",
  version: "number.integer",
});

export type TicketSnapshot = typeof ticketSnapshotOutput.infer;

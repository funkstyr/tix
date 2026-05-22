import { type } from "arktype";

export const reserveTicketInput = type({
  ticketId: "string.uuid",
  quantity: "number.integer >= 1",
});

export type ReserveTicketInput = typeof reserveTicketInput.infer;

export const reserveTicketOutput = type({
  ticketId: "string.uuid",
  quantityAvailable: "number.integer",
  unitPriceCents: "number.integer >= 0",
  version: "number.integer",
});

export type ReserveTicketOutput = typeof reserveTicketOutput.infer;

import { type } from "arktype";

import type { ReserveTicketInput, ReserveTicketOutput } from "./tickets-reserve.ts";

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

export const ticketRecordOutput = type({
  id: "string.uuid",
  sellerId: "string",
  title: "string",
  quantityTotal: "number.integer",
  quantityAvailable: "number.integer",
  unitPriceCents: "number.integer",
  version: "number.integer",
  createdAt: "string.date.iso",
});

export const ticketRecordOrNullOutput = ticketRecordOutput.or("null");

export type TicketRecord = typeof ticketRecordOutput.infer;

export const ticketCreateInput = type({
  token: "string >= 1",
  title: "string >= 1",
  quantityTotal: "number.integer >= 1",
  unitPriceCents: "number.integer >= 0",
});

export type TicketCreateInput = typeof ticketCreateInput.infer;

export const ticketGetByIdInput = type({
  ticketId: "string.uuid",
});

export type TicketGetByIdInput = typeof ticketGetByIdInput.infer;

export const ticketsListInput = type({
  "limit?": "1 <= number.integer <= 200",
});

export type TicketsListInput = typeof ticketsListInput.infer;

// Separate from `ticketsListInput` so the public list can't be coerced into
// leaking a different seller's inventory: `listMine` requires a session token
// and filters server-side by the resolved user id.
export const ticketsListMineInput = type({
  token: "string >= 1",
  "limit?": "1 <= number.integer <= 200",
});

export type TicketsListMineInput = typeof ticketsListMineInput.infer;

export const ticketsListOutput = type({
  items: ticketRecordOutput.array(),
});

export type TicketsListOutput = typeof ticketsListOutput.infer;

export type TicketsRouterClient = {
  create: (input: TicketCreateInput) => Promise<TicketRecord>;
  reserve: (input: ReserveTicketInput) => Promise<ReserveTicketOutput>;
  getById: (input: TicketGetByIdInput) => Promise<TicketRecord | null>;
  list: (input: TicketsListInput) => Promise<TicketsListOutput>;
  listMine: (input: TicketsListMineInput) => Promise<TicketsListOutput>;
};

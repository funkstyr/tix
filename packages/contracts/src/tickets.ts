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

export type TicketCreateInput = {
  token: string;
  title: string;
  quantityTotal: number;
  unitPriceCents: number;
};

export type TicketRecord = {
  id: string;
  sellerId: string;
  title: string;
  quantityTotal: number;
  quantityAvailable: number;
  unitPriceCents: number;
  version: number;
  createdAt: string;
};

export const ticketsListInput = type({
  "limit?": "1 <= number.integer <= 200",
});

export type TicketsListInput = typeof ticketsListInput.infer;

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

export const ticketsListOutput = type({
  items: ticketRecordOutput.array(),
});

export type TicketsListOutput = typeof ticketsListOutput.infer;

export type TicketsRouterClient = {
  create: (input: TicketCreateInput) => Promise<TicketRecord>;
  reserve: (input: ReserveTicketInput) => Promise<ReserveTicketOutput>;
  getById: (input: { ticketId: string }) => Promise<TicketRecord | null>;
  list: (input: TicketsListInput) => Promise<TicketsListOutput>;
};

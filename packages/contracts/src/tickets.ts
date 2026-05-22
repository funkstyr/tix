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

export type TicketsRouterClient = {
  create: (input: TicketCreateInput) => Promise<TicketRecord>;
  reserve: (input: ReserveTicketInput) => Promise<ReserveTicketOutput>;
  getById: (input: { ticketId: string }) => Promise<TicketRecord | null>;
};

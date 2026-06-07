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

export const ticketUpdatedV1 = type({
  "+": "reject",
  ticketId: "string.uuid",
  sellerId: "string >= 1",
  title: "string",
  unitPriceCents: "number.integer >= 0",
  // post-edit version of the ticket row — replicas apply the edit only when
  // their stored version is behind, dropping stale redeliveries.
  version: "number.integer >= 1",
  updatedAt: "string.date.iso",
});

export type TicketUpdatedV1 = typeof ticketUpdatedV1.infer;

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

export const ticketUpdateInput = type({
  token: "string >= 1",
  ticketId: "string.uuid",
  title: "string >= 1",
  unitPriceCents: "number.integer >= 0",
  // Expected current version; the edit is rejected if the row moved on under
  // us so a stale form can't clobber a newer edit (optimistic concurrency).
  expectedVersion: "number.integer >= 1",
});

export type TicketUpdateInput = typeof ticketUpdateInput.infer;

export const ticketUpdateOutput = ticketRecordOutput;

export type TicketUpdateOutput = typeof ticketUpdateOutput.infer;

export const ticketGetByIdInput = type({
  ticketId: "string.uuid",
});

export type TicketGetByIdInput = typeof ticketGetByIdInput.infer;

// Keep this union in sync with the inline literal in `ticketsListInput` /
// `ticketsListMineInput` below. The schema rejects anything outside it.
export const ticketSortValues = ["newest", "price_asc", "price_desc"] as const;

export type TicketSort = (typeof ticketSortValues)[number];

export const ticketsListInput = type({
  "+": "reject",
  "limit?": "1 <= number.integer <= 200",
  // title contains-search; empty/whitespace is treated as absent server-side
  "q?": "string <= 100",
  "sort?": "'newest' | 'price_asc' | 'price_desc'",
  "availableOnly?": "boolean",
  // opaque keyset cursor from a prior response's nextCursor
  "cursor?": "string >= 1",
});

export type TicketsListInput = typeof ticketsListInput.infer;

// Separate from `ticketsListInput` so the public list can't be coerced into
// leaking a different seller's inventory: `listMine` requires a session token
// and filters server-side by the resolved user id.
export const ticketsListMineInput = type({
  "+": "reject",
  token: "string >= 1",
  "limit?": "1 <= number.integer <= 200",
  "sort?": "'newest' | 'price_asc' | 'price_desc'",
  "cursor?": "string >= 1",
});

export type TicketsListMineInput = typeof ticketsListMineInput.infer;

export const ticketsListOutput = type({
  items: ticketRecordOutput.array(),
  // null on the last page; otherwise feed back as `cursor` for the next page
  nextCursor: "string | null",
});

export type TicketsListOutput = typeof ticketsListOutput.infer;

export type TicketsRouterClient = {
  create: (input: TicketCreateInput) => Promise<TicketRecord>;
  update: (input: TicketUpdateInput) => Promise<TicketRecord>;
  reserve: (input: ReserveTicketInput) => Promise<ReserveTicketOutput>;
  getById: (input: TicketGetByIdInput) => Promise<TicketRecord | null>;
  list: (input: TicketsListInput) => Promise<TicketsListOutput>;
  listMine: (input: TicketsListMineInput) => Promise<TicketsListOutput>;
};

import { Data } from "effect";

// Domain failures for the tickets service, modeled as tagged errors (ADR-0008). The
// single oRPC seam translator in http/boundary.ts maps each tag to the exact ORPCError
// the endpoints return today, so the wire behavior is unchanged.

export class TicketNotFound extends Data.TaggedError("TicketNotFound")<{
  readonly ticketId: string;
}> {}

// reserve: the re-read shows fewer seats available than requested (not retryable).
export class SoldOut extends Data.TaggedError("SoldOut")<{
  readonly ticketId: string;
}> {}

// reserve: every optimistic-version attempt lost the race (ADR-0005). Retryable.
export class ReservationConflict extends Data.TaggedError("ReservationConflict")<{
  readonly ticketId: string;
}> {}

// update: seats are held or sold (available !== total), so the ticket is locked by an order.
export class TicketReserved extends Data.TaggedError("TicketReserved")<{
  readonly ticketId: string;
}> {}

// update: the version-matched write affected no rows — a stale expectedVersion or a
// concurrent reserve/release bumped the version. Retryable.
export class TicketStale extends Data.TaggedError("TicketStale")<{
  readonly ticketId: string;
}> {}

export type TicketError =
  | TicketNotFound
  | SoldOut
  | ReservationConflict
  | TicketReserved
  | TicketStale;

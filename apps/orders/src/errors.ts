import { Data } from "effect";

// Domain failures for the orders service, carried in the typed `E` channel of the
// Effect programs (ADR-0008). The single boundary translator in `boundary.ts` maps
// each tag to the oRPC error the wire already returns today; internal logic never
// references `ORPCError`.

export class SoldOut extends Data.TaggedError("SoldOut")<{
  readonly ticketId: string;
}> {}

export class ReservationConflict extends Data.TaggedError("ReservationConflict")<{
  readonly ticketId: string;
}> {}

export class BuyerIsSeller extends Data.TaggedError("BuyerIsSeller")<{
  readonly ticketId: string;
}> {}

export class TicketNotFound extends Data.TaggedError("TicketNotFound")<{
  readonly ticketId: string;
}> {}

export class OrderNotFound extends Data.TaggedError("OrderNotFound")<{
  readonly orderId: string;
}> {}

export type OrderError =
  | SoldOut
  | ReservationConflict
  | BuyerIsSeller
  | TicketNotFound
  | OrderNotFound;
